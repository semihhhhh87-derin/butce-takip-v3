/* eslint-disable @typescript-eslint/no-explicit-any, prefer-const, react-hooks/exhaustive-deps */
"use client";
import { createClient, Session } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import {
  activeInMonth,
  activeWeeklySummary,
  cardStatementInterest,
  freshWeeklySummary,
  BudgetData,
  dateToIso,
  effectiveDay,
  exitDates,
  incomeStatus,
  liveFinancial,
  monthlySpendingSummary,
  normalize,
  nextMonth,
  paymentAmount,
  paymentKey,
  scheduledIncomeRemaining,
  trMoney,
  trMonth,
  todayUtc,
  weeklyCarryAdjustment,
  weeklySavings,
  weeklyCardSavings,
  weekRange,
  weeklySummary,
} from "./lib/budget-engine";

const TR_MONTHS_SHORT = ["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"];
const MOVABLE_TR_HOLIDAYS: Record<number, string[]> = {
  2026: ["03-19", "03-20", "03-21", "03-22", "05-26", "05-27", "05-28", "05-29", "05-30"],
  2027: ["03-08", "03-09", "03-10", "03-11", "05-15", "05-16", "05-17", "05-18", "05-19"],
  2028: ["02-25", "02-26", "02-27", "02-28", "05-04", "05-05", "05-06", "05-07", "05-08"],
  2029: ["02-13", "02-14", "02-15", "02-16", "04-23", "04-24", "04-25", "04-26", "04-27"],
  2030: ["02-03", "02-04", "02-05", "02-06", "04-12", "04-13", "04-14", "04-15", "04-16"],
  2031: ["01-23", "01-24", "01-25", "01-26", "04-01", "04-02", "04-03", "04-04", "04-05"],
};
const FIXED_TR_HOLIDAYS = new Set(["01-01", "04-23", "05-01", "05-19", "07-15", "08-30", "10-28", "10-29"]);
function fmtShortDate(d: Date): string {
  return `${d.getUTCDate()} ${TR_MONTHS_SHORT[d.getUTCMonth()]}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isTurkishPublicHoliday(d: Date): boolean {
  const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return FIXED_TR_HOLIDAYS.has(md) || (MOVABLE_TR_HOLIDAYS[d.getUTCFullYear()] || []).includes(md);
}

/** Bugünden vade tarihine kadar kalan iş gününü sayar; cumartesi ve pazar sayılmaz. */
function businessDaysUntil(from: Date, due: Date): number {
  const cursor = startOfUtcDay(from), end = startOfUtcDay(due);
  let count = 0;
  while (+cursor < +end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6 && !isTurkishPublicHoliday(cursor)) count += 1;
  }
  return count;
}

function isWithinBusinessDays(from: Date, due: Date, limit = 3): boolean {
  return +startOfUtcDay(due) >= +startOfUtcDay(from) && businessDaysUntil(from, due) <= limit;
}

function businessDueLabel(from: Date, due: Date): string {
  const calendarDays = Math.round((+startOfUtcDay(due) - +startOfUtcDay(from)) / 86400000);
  if (calendarDays === 0) return "bugün";
  if (calendarDays === 1) return "yarın";
  const workDays = businessDaysUntil(from, due);
  if (isTurkishPublicHoliday(due)) return `${workDays} iş günü sonra · resmî tatil`;
  if (due.getUTCDay() === 0 || due.getUTCDay() === 6)
    return `${workDays} iş günü sonra · hafta sonu`;
  return `${workDays} iş günü içinde`;
}

const authStorage = {
  async db() {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open("butce-takip-v2", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("auth");
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  },
  async getItem(k: string) {
    try {
      const local = localStorage.getItem(k);
      if (local) return local;
      const db = await this.db();
      return await new Promise<string | null>((resolve, reject) => {
        const q = db.transaction("auth").objectStore("auth").get(k);
        q.onsuccess = () => resolve(q.result ?? null);
        q.onerror = () => reject(q.error);
      });
    } catch {
      return null;
    }
  },
  async setItem(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* IndexedDB yedeği kullanılacak. */
    }
    try {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const q = db
          .transaction("auth", "readwrite")
          .objectStore("auth")
          .put(v, k);
        q.onsuccess = () => resolve();
        q.onerror = () => reject(q.error);
      });
    } catch {
      /* Yerel depolama çalışmaya devam eder. */
    }
  },
  async removeItem(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* IndexedDB kaydı yine silinir. */
    }
    try {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const q = db
          .transaction("auth", "readwrite")
          .objectStore("auth")
          .delete(k);
        q.onsuccess = () => resolve();
        q.onerror = () => reject(q.error);
      });
    } catch {
      /* Oturum sunucuda da sonlandırılır. */
    }
  },
};
const supabase = createClient(
  "https://pixdaficmkqufmynpbio.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpeGRhZmljbWtxdWZteW5wYmlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MjYxNDksImV4cCI6MjEwMjMwMjE0OX0.BgLN1HMgKUc1cyQNg8aDxAH-ASKKSxLial4mkMu90qk",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: "sb-pixdaficmkqufmynpbio-auth-token",
      storage: authStorage,
    },
  },
);
const num = (v: any) => Number(v) || 0,
  newId = () => Date.now() + Math.floor(Math.random() * 1000);
type Save = (d: BudgetData, m?: string) => void;

function parseTrMoney(value: string): number | null {
  const clean = value.replace(/\s/g, "").replace(/TL|₺/gi, "");
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function mergeChanged(base: any, next: any, latest: any): any {
  if (JSON.stringify(base) === JSON.stringify(next))
    return structuredClone(latest);
  if (Array.isArray(next)) {
    if (
      next.every((x) => x && typeof x === "object" && "id" in x) &&
      (base || []).every((x: any) => x && typeof x === "object" && "id" in x)
    ) {
      const baseMap = new Map((base || []).map((x: any) => [String(x.id), x])),
        nextMap = new Map(next.map((x: any) => [String(x.id), x])),
        out = new Map((latest || []).map((x: any) => [String(x.id), x]));
      for (const id of baseMap.keys() as IterableIterator<string>) if (!nextMap.has(id)) out.delete(id);
      for (const [id, value] of nextMap)
        if (
          !baseMap.has(id) ||
          JSON.stringify(baseMap.get(id)) !== JSON.stringify(value)
        )
          out.set(id, structuredClone(value));
      return [...out.values()];
    }
    return structuredClone(next);
  }
  if (next && typeof next === "object") {
    const out = structuredClone(
      latest && typeof latest === "object" ? latest : {},
    );
    for (const k of new Set([
      ...Object.keys(base || {}),
      ...Object.keys(next),
    ])) {
      if (!(k in next)) delete out[k];
      else out[k] = mergeChanged(base?.[k], next[k], latest?.[k]);
    }
    return out;
  }
  return structuredClone(next);
}

function Monthly({ month }: { month: any }) {
  const r = month.totalRemaining,
    end = new Date(Date.UTC(month.y, month.m, 0)),
    endLabel = new Intl.DateTimeFormat("tr-TR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(end);
  return (
    <section className="panel single monthlyPage">
      <div className="panelTitle">
        <div>
          <h2>Aylık yaşam bütçesi</h2>
          <p>
            {dateToIso(month.effective)} – {endLabel} · {month.days} günlük
            hedef
          </p>
        </div>
      </div>
      <Meter l="Kart" v={month.spent.kart} max={month.goal.kart} />
      <Meter l="Nakit / KMH" v={month.spent.nakit} max={month.goal.nakit} />
      <div className={r >= 0 ? "weekTotal good" : "weekTotal bad"}>
        <span>{r >= 0 ? "Aylık hedef korunuyor" : "Aylık hedef aşıldı"}</span>
        <b>{trMoney(r)} kalan</b>
      </div>
      <div className="monthlyBreakdown">
        <span>
          Toplam kullanılan <b>{trMoney(month.totalSpent)}</b>
        </span>
        {month.fixedCard > 0 && (
          <span>
            Kart hedefinden ayrılan taksit <b>{trMoney(month.fixedCard)}</b>
          </span>
        )}
      </div>
      <p className="monthlyHelp">
        Bu bölüm yalnız yaşam harcamalarını gösterir. Krediler, kart borcu
        ödemesi, faturalar ve diğer sabit ödemeler bu hedefe dahil değildir.
      </p>
    </section>
  );
}

export default function Home() {
  const [s, setS] = useState<Session | null | undefined>();
  useEffect(() => {
    let active = true;
    supabase.auth.startAutoRefresh();
    void (async () => {
      const first = await supabase.auth.getSession();
      if (!active) return;
      if (first.data.session) {
        setS(first.data.session);
        return;
      }
      const refreshed = await supabase.auth.refreshSession();
      if (active) setS(refreshed.data.session);
    })();
    const { data } = supabase.auth.onAuthStateChange((_e, v) => {
      if (active) setS(v);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
      supabase.auth.stopAutoRefresh();
    };
  }, []);
  if (s === undefined)
    return <Center text="Bu cihazdaki oturum geri yükleniyor…" />;
  return s ? <Dashboard session={s} /> : <Auth />;
}
function Center({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <div className="auth">
      <div className="authCard">
        <span className="mark">₺</span>
        <h1>Bütçe Takip</h1>
        {loading && <div className="loadingSpinner" aria-label="Yükleniyor" />}
        <p>{text}</p>
      </div>
    </div>
  );
}
function Auth() {
  const [e, setE] = useState(""),
    [p, setP] = useState(""),
    [mode, setMode] = useState("login"),
    [msg, setMsg] = useState("");
  async function go() {
    setMsg("Lütfen bekleyin…");
    const r =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email: e, password: p })
        : await supabase.auth.signUp({ email: e, password: p });
    setMsg(
      r.error
        ? r.error.message
        : mode === "login"
          ? "Giriş başarılı."
          : "E-postanızdaki onay bağlantısına basın.",
    );
  }
  return (
    <div className="auth">
      <div className="authCard">
        <span className="mark">₺</span>
        <h1>Bütçe Takip</h1>
        <p>Telefon ve bilgisayarda aynı aile bütçesi.</p>
        <label>
          E-posta
          <input
            type="email"
            value={e}
            onChange={(x) => setE(x.target.value)}
          />
        </label>
        <label>
          Şifre
          <input
            type="password"
            value={p}
            onChange={(x) => setP(x.target.value)}
            onKeyDown={(x) => x.key === "Enter" && go()}
          />
        </label>
        <button className="primary wide" onClick={go}>
          {mode === "login" ? "Giriş yap" : "Hesap oluştur"}
        </button>
        <button
          className="linkButton"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setMsg("");
          }}
        >
          {mode === "login" ? "Yeni hesap oluştur" : "Zaten hesabım var"}
        </button>
        {msg && <div className="authMessage">{msg}</div>}
      </div>
    </div>
  );
}

function Dashboard({ session }: { session: Session }) {
  const [tab, setTab] = useState("ozet"),
    [data, setData] = useState<BudgetData | null>(null),
    [family, setFamily] = useState(""),
    [sync, setSync] = useState("Bağlanıyor"),
    [clock, setClock] = useState(new Date()),
    [notice, setNotice] = useState(""),
    [now, setNow] = useState(todayUtc()),
    [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(() => {
      try {
        if (typeof window === "undefined") return new Set();
        return new Set(JSON.parse(localStorage.getItem(`budget-alerts-${dateToIso(todayUtc())}`) || "[]"));
      } catch { return new Set(); }
    });
  function dismissAlert(key: string) {
    setDismissedAlerts((current) => {
      const next = new Set([...current, key]);
      if (typeof window !== "undefined")
        localStorage.setItem(`budget-alerts-${dateToIso(todayUtc())}`, JSON.stringify([...next]));
      return next;
    });
  }
  const versionRef = useRef(0),
    dataRef = useRef<BudgetData | null>(null);
  async function load() {
    setSync("Bağlanıyor");
    let m = await supabase
        .from("family_members")
        .select("family_id")
        .limit(1)
        .maybeSingle(),
      fid = m.data?.family_id;
    if (!fid) {
      const f = await supabase
        .from("families")
        .insert({ name: "Aile Bütçesi", owner_id: session.user.id })
        .select("id")
        .single();
      if (f.error) {
        setSync("Bağlantı hatası");
        return;
      }
      fid = f.data.id;
      await supabase
        .from("family_members")
        .insert({ family_id: fid, user_id: session.user.id, role: "owner" });
      await supabase.from("budget_state").insert({
        family_id: fid,
        payload: {},
        version: 1,
        updated_by: session.user.id,
      });
    }
    setFamily(fid);
    const r = await supabase
      .from("budget_state")
      .select("payload,version")
      .eq("family_id", fid)
      .single();
    if (r.error) {
      setSync("Bağlantı hatası");
      return;
    }
    const loaded = normalize(r.data.payload);
    // Geçmiş haftalara ait kapanış kaydı yoksa otomatik oluştur
    const now_ = todayUtc();
    const [thisWeekStart] = weekRange(now_);
    let autoSaved = false;
    const withAuto = normalize(loaded);
    let cursor = new Date(Date.UTC(2024, 0, 1)); // eski bir başlangıç noktası
    // bütçe başlangıç tarihinden itibaren kap
    const planStart = loaded.butce_plani?.butce_baslangic_tarihi;
    if (planStart) {
      const d = new Date(planStart + "T00:00:00Z");
      if (!isNaN(+d)) cursor = d;
    }
    for (let i = 0; i < 260; i++) { // max 5 yıl = 260 hafta
      const [start, end] = weekRange(cursor);
      const key = dateToIso(start);
      if (+start >= +thisWeekStart) break; // bu hafta veya sonrasına dokunma
      if (!withAuto.haftalik_kapanislar[key]) {
        const ws = weeklySummary(withAuto, cursor);
        withAuto.haftalik_kapanislar[key] = {
          baslangic: key,
          bitis: dateToIso(end),
          kart: ws.spent.kart,
          nakit: ws.spent.nakit,
          kapanma_zamani: new Date().toISOString(),
          kapanis_tarihi: key,
          otomatik: true,
        };
        autoSaved = true;
      }
      // Kapalı haftanın bireysel harcama kayıtlarını temizle.
      // Kapanış toplamları haftalik_kapanislar'da saklandığından bu kayıtlar artık gereksiz.
      // Test ile doğrulandı: weeklySavings, weeklyCardSavings, liveFinancial etkilenmiyor.
      const weekEndIso = dateToIso(end);
      withAuto.haftalik_harcamalar = withAuto.haftalik_harcamalar.filter((r: any) => {
        const t = String(r.tarih || "");
        const hw = String(r.butce_haftasi || "");
        if (hw === key) return false;           // bu haftaya atanmış → sil
        if (!hw && t >= key && t <= weekEndIso) return false; // tarih bu haftada → sil
        return true;
      });
      cursor = new Date(+end + 86400000); // sonraki haftanın başı
    }
    let finalData = autoSaved ? withAuto : loaded;
    // Bozuk Türkçe karakter düzeltme — tüm string alanlarda genel fix
    const TR_FIX: Record<string, string> = {
      "Kullan?c? maa?? 2/3": "Kullanıcı maaşı 2/3",
      "Kullan?c? maa?? 1/3": "Kullanıcı maaşı 1/3",
      "E? maa?? (asgari ?cret)": "Eş maaşı (asgari ücret)",
      "?nce KMH, KMH s?f?rlan?nca kredi kart?": "Önce KMH, KMH sıfırlanınca kredi kartı",
      "Ana kredi kart? kullan?c?da kal?r; e?e haftal?k ula??m ve ki?isel gider pay? banka transferi/nakit verilir. Ortak kart harcamas? ?nceden haber verilerek yap?l?r.":
        "Ana kredi kartı kullanıcıda kalır; eşe haftalık ulaşım ve kişisel gider payı banka transferi/nakit verilir. Ortak kart harcaması önceden haber verilerek yapılır.",
      "?ade edilen ayakkab?": "İade edilen ayakkabı",
    };
    function fixStrings(obj: any): { fixed: any; changed: boolean } {
      if (typeof obj === "string") {
        const v = TR_FIX[obj];
        return v ? { fixed: v, changed: true } : { fixed: obj, changed: false };
      }
      if (Array.isArray(obj)) {
        let changed = false;
        const fixed = obj.map((item: any) => { const r = fixStrings(item); if (r.changed) changed = true; return r.fixed; });
        return { fixed, changed };
      }
      if (obj !== null && typeof obj === "object") {
        let changed = false;
        const fixed: any = {};
        for (const k of Object.keys(obj)) { const r = fixStrings(obj[k]); if (r.changed) changed = true; fixed[k] = r.fixed; }
        return { fixed, changed };
      }
      return { fixed: obj, changed: false };
    }
    // TR_FIX: yalnızca bozuk karakter tespit edilirse çalıştır (her yüklemede gereksiz parse önlenir)
    const needsFix = Object.keys(TR_FIX).some((k) => JSON.stringify(finalData).includes(k));
    const hasBozuk = needsFix ? (() => { const r2 = fixStrings(finalData); if (r2.changed) { finalData = r2.fixed; return true; } return false; })() : false;
    dataRef.current = finalData;
    versionRef.current = r.data.version;
    (window as any).__bd__ = finalData;
    setData(finalData);
    setSync("Güncel");
    // Otomatik kapanış veya encoding düzeltme olduysa sessizce kaydet
    if ((autoSaved || hasBozuk) && fid) {
      await supabase
        .from("budget_state")
        .update({
          payload: finalData,
          version: r.data.version + 1,
          updated_at: new Date().toISOString(),
          updated_by: session.user.id,
        })
        .eq("family_id", fid)
        .eq("version", r.data.version);
      versionRef.current = r.data.version + 1;
    }
  }
  useEffect(() => {
    // Initial load synchronizes the component with the authenticated remote store.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = window.setInterval(() => { setNow(todayUtc()); setClock(new Date()); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  async function save(next: BudgetData, message = "Kaydedildi") {
    const base = dataRef.current || next,
      expectedVersion = versionRef.current;
    dataRef.current = next;
    setData(next);
    setSync("Kaydediliyor");
    let finalMessage = message,
      r = await supabase
        .from("budget_state")
        .update({
          payload: next,
          version: expectedVersion + 1,
          updated_at: new Date().toISOString(),
          updated_by: session.user.id,
        })
        .eq("family_id", family)
        .eq("version", expectedVersion)
        .select("version")
        .maybeSingle();
    if (!r.data || r.error) {
      const fresh = await supabase
        .from("budget_state")
        .select("payload,version")
        .eq("family_id", family)
        .single();
      if (fresh.error) {
        setSync("Bağlantı hatası");
        const isAuthErr = fresh.error.code === "PGRST301" || String(fresh.error.message).toLowerCase().includes("jwt") || String(fresh.error.message).toLowerCase().includes("auth");
        setNotice(isAuthErr
          ? "Oturumunuzun süresi doldu. Lütfen sayfayı yenileyin ve tekrar giriş yapın."
          : "Kayıt gönderilemedi; ekrandaki giriş korunuyor.");
        return;
      }
      const merged = normalize(
        mergeChanged(base, next, normalize(fresh.data.payload)),
      );
      r = await supabase
        .from("budget_state")
        .update({
          payload: merged,
          version: fresh.data.version + 1,
          updated_at: new Date().toISOString(),
          updated_by: session.user.id,
        })
        .eq("family_id", family)
        .eq("version", fresh.data.version)
        .select("version")
        .maybeSingle();
      if (!r.data || r.error) {
        await load();
        setNotice(
          "Aynı anda başka kayıt yapıldı; lütfen işlemi yeniden girin.",
        );
        return;
      }
      dataRef.current = merged;
      setData(merged);
      finalMessage = `${message} · Diğer cihazdaki değişikliklerle birleştirildi.`;
    }
    versionRef.current = r.data.version;
    setSync("Güncel");
    setNotice(finalMessage);
  }
  if (!data) return <Center text="Aile bütçeniz yükleniyor…" loading />;
  const y = now.getUTCFullYear(),
    m = now.getUTCMonth() + 1,
    live = liveFinancial(data, data.guncel_durum, now),
    income = incomeStatus(data, data.guncel_durum, now),
    plan = exitDates(data, now),
    current =
      plan.rows.find((x: any) => x.yil === y && x.ay === m) || plan.rows.at(-1),
    week = activeWeeklySummary(data, now),
    // Özet ekranı: Pazar ise yarını baz al, harcamalar sıfır, kalan günlere göre hedef
    weekDisplayDate = now.getUTCDay() === 0 ? new Date(+now + 86400000) : now,
    freshWeek = freshWeeklySummary(data, weekDisplayDate),
    carry = weeklyCarryAdjustment(data, week.start),
    month = monthlySpendingSummary(data, now),
    savings = weeklySavings(data),
    cardSavings = weeklyCardSavings(data),
    anchorMonth = String(data.guncel_durum.tarih || "").slice(0, 7),
    currentMonthKey = dateToIso(now).slice(0, 7),
    needsMonthSync = !!anchorMonth && anchorMonth !== currentMonthKey,
    visibleRows = plan.rows.filter(
      (r: any) => r.yil > y || (r.yil === y && r.ay >= m),
    ),
    payments = data.odemeler
      .filter((p) => activeInMonth(p, y, m))
      .sort((a, b) => num(a.odeme_gunu) - num(b.odeme_gunu)),
    todayDay = now.getUTCDate();

  /** Bir ödemenin belirtilen ay/yıl için ödenip ödenmediğini kontrol eder.
   *  odendi_kayitlari VE kart_kademeli_odemeler toplamını dikkate alır. */
  function checkPaid(p: any, d: BudgetData, ty: number, tm: number): boolean {
    if (!!d.odendi_kayitlari[paymentKey(ty, tm, p.id)]) return true;
    if (p.kart_borc_odeme) {
      const staged = (d.kart_kademeli_odemeler || [])
        .filter((s: any) => Number(s.odeme_id) === Number(p.id) && Number(s.yil) === ty && Number(s.ay) === tm)
        .reduce((sum: number, s: any) => sum + num(s.tutar), 0);
      const planned = paymentAmount(d, p, ty, tm);
      if (Math.max(0, planned - staged) <= 0.01) return true;
    }
    return false;
  }

  const urgentCount = payments.filter((p) => {
    if (checkPaid(p, data, y, m)) return false;
    const due = effectiveDay(y, m, num(p.odeme_gunu));
    return isWithinBusinessDays(now, due, 3);
  }).length;
  async function toggle(p: any, ty = y, tm = m) {
    const d = normalize(data),
      k = paymentKey(ty, tm, p.id),
      historicalStaged = p.kart_borc_odeme
        ? (d.kart_kademeli_odemeler || [])
            .filter((x: any) => Number(x.odeme_id) === Number(p.id) && Number(x.yil) === ty && Number(x.ay) === tm)
            .reduce((sum: number, x: any) => sum + num(x.tutar), 0)
        : 0;
    if (d.odendi_kayitlari[k]) {
      delete d.odendi_kayitlari[k];
      delete d.gerceklesen_odemeler[k];
      return save(d, "Ödeme bekleyenlere alındı");
    }
    d.odendi_kayitlari[k] = true;
    d.gerceklesen_odemeler[k] = {
      yil: ty,
      ay: tm,
      odeme_id: p.id,
      // Eski kademeli kayıt varsa yalnız sabit tutarın kalanını tamamla;
      // yeni aylarda historicalStaged=0 olduğundan sabit tutarın tamamı işlenir.
      tutar: Math.max(0, paymentAmount(d, p, ty, tm) - historicalStaged),
      odeme_kaynagi: p.odeme_kaynagi || "banka",
      kart_borc_odeme: !!p.kart_borc_odeme,
      olusturma_zamani: new Date().toISOString(),
      banka_fotografina_dahil: false,
    };
    save(d, "Ödeme gerçekleşti olarak işlendi");
  }
  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="mark">₺</span>
          <b>BÜTÇE TAKİP</b>
        </div>
        <nav ref={(el) => {
          if (el) {
            const active = el.querySelector<HTMLButtonElement>(".active");
            if (active) active.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
          }
        }}>
          {[
            ["ozet", "Özet"],
            ["odemeler", "Ödemeler"],
            ["harcama", "Haftalık"],
            ["aylik", "Aylık"],
            ["ayarlar", "Güncelle"],
          ].map((x) => (
            <button
              key={x[0]}
              className={tab === x[0] ? "active" : ""}
              onClick={() => setTab(x[0])}
            >
              {x[1]}
              {x[0] === "odemeler" && urgentCount > 0 && (
                <span className="navBadge">{urgentCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sync" role="status">
          <i className={sync === "Kaydediliyor" ? "syncing" : sync === "Bağlantı hatası" ? "syncErr" : ""} />
          {sync === "Güncel"
            ? `Son senkronizasyon: ${new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }).format(clock)}`
            : sync}
          <button onClick={() => supabase.auth.signOut()}>Çıkış</button>
        </div>
      </header>
      {tab === "ozet" ? <section className="hero">
        <div className="heroTarget">
          <span>KMH&apos;DEN ÇIKIŞ HEDEFİ</span>
          <h1>{trMonth(plan.kmh)}</h1>
          {plan.kmh && (() => {
            const startDate = new Date(Date.UTC(2026, 7, 1)); // Ağustos 2026 başlangıç
            const targetDate = new Date(Date.UTC(plan.kmh[0], plan.kmh[1] - 1, 1));
            const total = Math.max(1, +targetDate - +startDate);
            const elapsed = Math.min(+now - +startDate, total);
            const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
            return (
              <div className="kmhProgress">
                <div className="kmhProgressBar">
                  <div className="kmhProgressFill" style={{ width: `${pct}%` }} />
                </div>
                <small>{pct.toFixed(0)}% tamamlandı</small>
              </div>
            );
          })()}
        </div>
        <div className="heroStats">
          <article className="heroStatPair">
            <div>
              <small>{savings >= 0 ? "Nakit hedefinden kalan" : "Nakit hedefi aşımı"}</small>
              <strong className={savings >= 0 ? "good" : "bad"}>{trMoney(Math.abs(savings))}</strong>
            </div>
            <div>
              <small>{cardSavings >= 0 ? "Kart hedefinden kalan" : "Kart hedefi aşımı"}</small>
              <strong className={cardSavings >= 0 ? "good" : "bad"}>{trMoney(Math.abs(cardSavings))}</strong>
            </div>
          </article>
          <article>
            <small>Takvim ve girişlere göre KMH</small>
            <strong className={live.garanti_bakiye < 0 ? "bad" : "good"}>{live.garanti_bakiye < 0 && <span className="meaningIcon" aria-label="Eksi bakiye">!</span>}{trMoney(live.garanti_bakiye)}</strong>
          </article>
          <article>
            <small>Toplam kart borcu</small>
            <strong className={live.yk_toplam_borc > 0 ? "bad" : "good"}>{trMoney(live.yk_toplam_borc)}</strong>
          </article>
        </div>
      </section> : <section className="compactSummary" aria-label="Bütçe özeti">
        <span>KMH hedefi <b>{trMonth(plan.kmh)}</b></span>
        <span className={live.garanti_bakiye < 0 ? "bad" : "good"}>{live.garanti_bakiye < 0 && <span className="meaningIcon" aria-hidden="true">!</span>} KMH {trMoney(live.garanti_bakiye)}</span>
        <span>Kart borcu <b>{trMoney(live.yk_toplam_borc)}</b></span>
      </section>}
      {needsMonthSync && (
        <button className="monthWarning" onClick={() => setTab("ayarlar")}>
          Yeni ay başladı! Bankadan gerçek KMH bakiyesini girin — Güncelle sekmesine tıklayın.
        </button>
      )}
      {sync === "Bağlantı hatası" && (
        <div className="alertBanner danger" style={{ justifyContent: "center" }}>
          <span>Bağlantı kesildi. Girdiğiniz veriler bu ekranda korunuyor; bağlantı düzelince yeniden kaydedebilirsiniz.</span>
        </div>
      )}
      {(() => {
        const alerts: { key: string; msg: string; type: "info" | "warn" | "danger"; action?: boolean }[] = [];
        const weekOver = week.spent.kart + week.spent.nakit > (freshWeek.goal.kart + freshWeek.goal.nakit);
        if (weekOver && !dismissedAlerts.has("week-over"))
          alerts.push({ key: "week-over", msg: "Bu haftanın harcama hedefi aşıldı.", type: "danger" });
        const monthOver = month.totalSpent > (month.goal.kart + month.goal.nakit);
        if (monthOver && !dismissedAlerts.has("month-over"))
          alerts.push({ key: "month-over", msg: "Bu ayın harcama hedefi aşıldı.", type: "danger" });
        // Maaş günü fotoğraf uyarısı
        const todayD = now.getUTCDate();
        const maasGunleri = (data.guncel_durum.gelir_parcalari || []).map((g: any) => num(g.gun));
        const bugunMaasGunu = maasGunleri.includes(todayD);
        const fotografGunu = String(data.guncel_durum.tarih || "").slice(8, 10);
        const fotografBugün = String(data.guncel_durum.tarih || "").slice(0, 10) === dateToIso(now);
        if (bugunMaasGunu && !fotografBugün && !dismissedAlerts.has("maas-fotograf"))
          alerts.push({ key: "maas-fotograf", msg: `Bugün maaş günü (${todayD}. gün)! Bankadan KMH bakiyenizi güncelleyin — Güncelle sekmesi.`, type: "warn" });
        // checkPaid: dışarıda tanımlı, tüm ödeme kontrolleri burayı kullanır
        const overduePayments = payments.filter((p: any) => {
          if (checkPaid(p, data, y, m)) return false;
          const due = effectiveDay(y, m, num(p.odeme_gunu));
          return +startOfUtcDay(due) < +startOfUtcDay(now);
        });
        const upcomingPayments = payments.filter((p: any) => {
          if (checkPaid(p, data, y, m)) return false;
          return isWithinBusinessDays(now, effectiveDay(y, m, num(p.odeme_gunu)), 3);
        });
        if (overduePayments.length > 0 && !dismissedAlerts.has("overdue"))
          alerts.push({ key: "overdue", msg: `${overduePayments.length} ödemeniz gecikmiş: ${overduePayments.map((p: any) => p.ad).join(", ")}`, type: "danger" });
        if (upcomingPayments.length > 0 && !dismissedAlerts.has("upcoming")) {
          const minWorkDays = Math.min(...upcomingPayments.map((p: any) => businessDaysUntil(now, effectiveDay(y, m, num(p.odeme_gunu)))));
          const upcomingTotal = upcomingPayments.reduce((sum: number, p: any) => {
            const planned = paymentAmount(data, p, y, m);
            const staged = p.kart_borc_odeme ? (data.kart_kademeli_odemeler || [])
              .filter((x: any) => Number(x.odeme_id) === Number(p.id) && Number(x.yil) === y && Number(x.ay) === m)
              .reduce((s: number, x: any) => s + num(x.tutar), 0) : 0;
            return sum + Math.max(0, planned - staged);
          }, 0);
          const upcomingMsg = upcomingPayments.map((p: any) => {
            const due = effectiveDay(y, m, num(p.odeme_gunu));
            const label = businessDueLabel(now, due);
            return `${p.ad} (${label})`;
          }).join(", ");
          alerts.push({
            key: "upcoming",
            msg: `${upcomingPayments.length} yaklaşan ödeme · Toplam ${trMoney(upcomingTotal)}: ${upcomingMsg}`,
            type: minWorkDays === 0 ? "danger" : minWorkDays === 1 ? "warn" : "info",
            action: true,
          });
        }
        return alerts.map((a) => (
          <div key={a.key} className={`alertBanner ${a.type}`}>
            <span>{a.msg}</span>
            <span className="alertActions">
              {a.action && <button className="alertPrimary" onClick={() => setTab("odemeler")}>Ödemelere git</button>}
              <button onClick={() => dismissAlert(a.key)}>Bugün tekrar gösterme</button>
            </span>
          </div>
        ));
      })()}
      {notice && (
        <button className="toast" onClick={() => setNotice("")}>
          {notice} ×
        </button>
      )}
      {tab === "ozet" && (
        <>
          <WeekBox week={week} carry={{ kart: 0, nakit: 0, total: 0, source: "net-defter" }} data={data} now={now} save={save} />
          <div className="layout">
          <Payments
            data={data}
            rows={payments.slice(0, 8)}
            y={y}
            m={m}
            toggle={toggle}
            save={save}
            footerAction={payments.length > 8 ? { label: `Tümünü gör (${payments.length})`, onClick: () => setTab("odemeler") } : undefined}
          />
          <aside>
            <section className="panel snapshot">
              <h2>Bu ayın temkinli tahmini</h2>
              <Row l="Ay sonu KMH" v={trMoney(current?.ek_avans)} />
              <Row l="KMH tahmini faizi" v={trMoney(current?.faiz)} />
              <Row l="Kart tahmini faizi" v={trMoney(current?.kart_faiz)} />
              <Row
                l="Ay sonu kart borcu"
                v={trMoney(current?.kart_kapanis_borcu)}
              />
              <Row
                l="Kullanılabilir kart limiti"
                v={trMoney(live.yk_kullanilabilir)}
              />
            </section>
          </aside>
        </div>
        </>
      )}
      {tab === "odemeler" && (
        <div className="single">
          <Payments
            data={data}
            rows={payments}
            y={y}
            m={m}
            toggle={toggle}
            save={save}
            edit
            planRows={visibleRows}
            live={live}
            now={now}
          />
        </div>
      )}
      {tab === "harcama" && (
        <Weekly
          data={data}
          week={week}
          freshWeek={freshWeek}
          carry={carry}
          savings={savings}
          now={now}
          save={save}
        />
      )}{" "}
      {tab === "aylik" && (
        <Monthly month={month} />
      )}{" "}
      {tab === "ayarlar" && <Update data={data} now={now} save={save} notice={notice} />}
    </main>
  );
}

function Payments({
  data,
  rows,
  y,
  m,
  toggle,
  save,
  edit = false,
  footerAction,
  planRows,
  live,
  now,
}: {
  data: BudgetData;
  rows: any[];
  y: number;
  m: number;
  toggle: (p: any, ty?: number, tm?: number) => void;
  save: Save;
  edit?: boolean;
  footerAction?: { label: string; onClick: () => void };
  planRows?: any[];
  live?: any;
  now?: Date;
}) {
  const [form, setForm] = useState<any>(),
    [showPaid, setShowPaid] = useState(false),
    [navYear, setNavYear] = useState(y),
    [navMonth, setNavMonth] = useState(m);

  // seçili aya göre ödemeleri filtrele
  const activeRows = edit
    ? data.odemeler.filter((p: any) =>
        activeInMonth(p, navYear, navMonth)
      )
    : rows;

  // seçili aya ait projeksiyon satırı
  const projRow = planRows?.find(
    (r: any) => r.yil === navYear && r.ay === navMonth
  );

  // U5: Ay navigasyonu sınırı — 3 ay geri, 12 ay ileri
  const [minY, minM] = (() => {
    let my = y, mm = m - 3;
    while (mm < 1) { mm += 12; my -= 1; }
    return [my, mm];
  })();
  const [maxY, maxM] = (() => {
    let my = y, mm = m + 12;
    while (mm > 12) { mm -= 12; my += 1; }
    return [my, mm];
  })();
  function goPrevMonth() {
    if (navYear < minY || (navYear === minY && navMonth <= minM)) return;
    if (navMonth === 1) { setNavYear(navYear - 1); setNavMonth(12); }
    else setNavMonth(navMonth - 1);
  }
  function goNextMonth() {
    if (navYear > maxY || (navYear === maxY && navMonth >= maxM)) return;
    if (navMonth === 12) { setNavYear(navYear + 1); setNavMonth(1); }
    else setNavMonth(navMonth + 1);
  }
  const [confirmDel, setConfirmDel] = useState<any>(null);
  function del(p: any) {
    setConfirmDel(p);
  }
  function doDelete() {
    if (!confirmDel) return;
    const d = normalize(data);
    d.odemeler = d.odemeler.filter((x) => x.id !== confirmDel.id);
    save(d, "Ödeme silindi");
    setConfirmDel(null);
  }
  const displayY = edit ? navYear : y;
  const displayM = edit ? navMonth : m;
  const displayRows = edit ? activeRows : rows;
  const rowIsPaid = (p: any) => {
    const recorded = !!data.odendi_kayitlari[paymentKey(displayY, displayM, p.id)];
    const staged = p.kart_borc_odeme ? data.kart_kademeli_odemeler
      .filter((x: any) => Number(x.yil) === displayY && Number(x.ay) === displayM && Number(x.odeme_id) === Number(p.id))
      .reduce((sum: number, x: any) => sum + num(x.tutar), 0) : 0;
    return recorded || (p.kart_borc_odeme && paymentAmount(data, p, displayY, displayM) - staged <= 0.01);
  };
  const paidCount = displayRows.filter(rowIsPaid).length;
  const visiblePaymentRows = showPaid ? displayRows : displayRows.filter((p: any) => !rowIsPaid(p));

  return (
    <section className="panel payments">
      <div className="panelTitle">
        <div>
          <h2>{edit ? "Ödemeler" : "Yaklaşan ödemeler"}</h2>
          <p>Gerçekten bankadan çıkınca Ödendi işaretleyin.</p>
        </div>
        {edit && (
          <button
            className="primary"
            onClick={() =>
              setForm({
                id: newId(),
                ad: "",
                tutar: 0,
                bu_ay_tutar: 0,
                odeme_gunu: 1,
                tur: "diger",
                odeme_kaynagi: "banka",
                aktif: true,
              })
            }
          >
            + Ekle
          </button>
        )}
      </div>
      {edit && (
        <div className="monthNavigator">
          <button className="secondary" onClick={goPrevMonth}>◀ Önceki ay</button>
          <strong>{trMonth([displayY, displayM])}</strong>
          <button className="secondary" onClick={goNextMonth}>Sonraki ay ▶</button>
        </div>
      )}
      {edit && (() => {
        const navDate = new Date(Date.UTC(displayY, displayM - 1, 15));
        const mSummary = monthlySpendingSummary(data, navDate);
        const toplamOdeme = activeRows.reduce((s: number, p: any) => s + paymentAmount(data, p, displayY, displayM), 0);
        const kartKalan = mSummary.goal.kart - mSummary.spent.kart;
        const nakitKalan = mSummary.goal.nakit - mSummary.spent.nakit;
        return (
          <div className="selectedMonthSummary">
            <span>
              Kart&nbsp;
              <b>{trMoney(mSummary.goal.kart)}</b>
              <small> limit · </small>
              <b className={kartKalan < 0 ? "bad" : "good"}>{trMoney(kartKalan)}</b>
              <small> kalan</small>
            </span>
            <span>
              Nakit / KMH&nbsp;
              <b>{trMoney(mSummary.goal.nakit)}</b>
              <small> limit · </small>
              <b className={nakitKalan < 0 ? "bad" : "good"}>{trMoney(nakitKalan)}</b>
              <small> kalan</small>
            </span>
            <span>Ödemeler <b>{trMoney(toplamOdeme)}</b></span>
          </div>
        );
      })()}
      {paidCount > 0 && <button className="paidToggle" onClick={() => setShowPaid((v) => !v)} aria-expanded={showPaid}>
        <span className="uiIcon" aria-hidden="true">✓</span> Ödenenler ({paidCount}) <span>{showPaid ? "Gizle" : "Göster"}</span>
      </button>}
      {visiblePaymentRows.map((p) => {
        const recordedPaid = !!data.odendi_kayitlari[paymentKey(displayY, displayM, p.id)],
          staged = p.kart_borc_odeme
            ? data.kart_kademeli_odemeler
                .filter(
                  (x: any) =>
                    Number(x.yil) === displayY &&
                    Number(x.ay) === displayM &&
                    Number(x.odeme_id) === Number(p.id),
                )
                .reduce((sum: number, x: any) => sum + Number(x.tutar || 0), 0)
            : 0,
          plannedAmount = paymentAmount(data, p, displayY, displayM),
          remainingAmount = Math.max(0, plannedAmount - staged),
          paid = recordedPaid || (p.kart_borc_odeme && remainingAmount <= 0.01);
        // Satır rengi: sadece bu ay için hesapla (geçmiş/gelecek ay → renksiz)
        const isCurrentMonth = now != null && displayY === now.getUTCFullYear() && displayM === now.getUTCMonth() + 1;
        const payDate = isCurrentMonth ? effectiveDay(displayY, displayM, num(p.odeme_gunu)) : null;
        const overdue = payDate && now ? +startOfUtcDay(payDate) < +startOfUtcDay(now) : false;
        const upcoming = payDate && now ? isWithinBusinessDays(now, payDate, 3) : false;
        const rowClass = paid
          ? "payment paid"
          : payDate !== null && now !== null
            ? overdue
              ? "payment overdue"
              : upcoming
                ? "payment upcoming"
                : "payment"
            : "payment";
        return (
          <article className={rowClass} key={p.id}>
            <button
              className="check"
              onClick={() => toggle(p, displayY, displayM)}
              disabled={p.kart_borc_odeme && !recordedPaid && paid}
              aria-label={`${p.ad} ödemesini ${paid ? "bekleyenlere al" : "ödendi işaretle"}`}
            >
              {paid ? "✓" : "○"}
            </button>
            <div>
              <b>
                <span className="uiIcon" aria-hidden="true">₺</span>
                {p.ad}
              </b>
              <span>
                {new Intl.DateTimeFormat("tr-TR", {
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                }).format(effectiveDay(displayY, displayM, num(p.odeme_gunu)))}{" "}
                · {p.tur || "Ödeme"}
              </span>
            </div>
            <strong>{trMoney(remainingAmount)}</strong>
            {staged > 0 && (
              <div className="stagedList">
                <small className="stagedPaymentNote">{trMoney(staged)} kademeli ödendi</small>
                {data.kart_kademeli_odemeler
                  .filter((x: any) => Number(x.odeme_id) === Number(p.id) && Number(x.yil) === displayY && Number(x.ay) === displayM)
                  .map((x: any) => (
                    <span key={x.id} className="stagedItem">
                      {x.tarih} · {trMoney(x.tutar)} · geçmiş kayıt
                    </span>
                  ))
                }
              </div>
            )}
            {edit && (
              <span className="payActions">
                <button
                  className="ghost"
                  onClick={() =>
                    setForm({
                      ...p,
                      bu_ay_tutar: paymentAmount(data, p, y, m),
                    })
                  }
                >
                  Düzenle
                </button>
                <button className="danger" onClick={() => del(p)}>
                  Sil
                </button>
              </span>
            )}
          </article>
        );
      })}
      {!displayRows.length && <div className="empty">Bu ay için ödeme yok.</div>}
      {footerAction && (
        <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
          <button className="linkButton" onClick={footerAction.onClick}>{footerAction.label} →</button>
        </div>
      )}
      {form && (
        <PaymentForm
          p={form}
          set={setForm}
          cancel={() => setForm(null)}
          done={() => {
            const d = normalize(data),
              i = d.odemeler.findIndex((x) => x.id === form.id);
            const currentAmount = num(form.bu_ay_tutar),
              clean = { ...form };
            delete clean.bu_ay_tutar;
            if (i < 0) {
              clean.tutar = num(clean.tutar || currentAmount);
              d.odemeler.push(clean);
              if (currentAmount !== num(clean.tutar))
                d.aylik_tutar_override[paymentKey(y, m, clean.id)] =
                  currentAmount;
            } else {
              d.odemeler[i] = clean;
              d.aylik_tutar_override[paymentKey(y, m, clean.id)] =
                currentAmount;
              const [ny, nm] = nextMonth(y, m),
                nextKey = paymentKey(ny, nm, clean.id);
              if (!(nextKey in d.aylik_tutar_override))
                d.aylik_tutar_override[nextKey] = num(clean.tutar);
            }
            save(d, "Ödeme kaydedildi");
            setForm(null);
          }}
        />
      )}
      {confirmDel && (
        <div className="modalOverlay" onClick={() => setConfirmDel(null)}>
          <div className="modalBox" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h3>Ödemeyi sil</h3>
              <button className="ghost" onClick={() => setConfirmDel(null)}>✕</button>
            </div>
            <p style={{ margin: "0 0 20px", color: "var(--muted)" }}>
              <b style={{ color: "var(--ink)" }}>{confirmDel.ad}</b> kalıcı olarak silinecek. Emin misiniz?
            </p>
            <div className="actions">
              <button className="danger" onClick={doDelete}>Evet, sil</button>
              <button className="ghost" onClick={() => setConfirmDel(null)}>Vazgeç</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
function PaymentForm({
  p,
  set,
  cancel,
  done,
}: {
  p: any;
  set: (v: any) => void;
  cancel: () => void;
  done: () => void;
}) {
  // Raw string states for decimal inputs
  const [rawBuAy, setRawBuAy] = useState(String(p.bu_ay_tutar ?? p.tutar ?? 0));
  const [rawTutar, setRawTutar] = useState(String(p.tutar ?? 0));
  const [rawGun, setRawGun] = useState(String(p.odeme_gunu ?? ""));
  const [rawTaksit, setRawTaksit] = useState(String(p.taksit_sayisi ?? ""));

  // Sync raw states when p changes externally
  const prevP = useRef(p);
  if (prevP.current !== p) {
    prevP.current = p;
    setRawBuAy(String(p.bu_ay_tutar ?? p.tutar ?? 0));
    setRawTutar(String(p.tutar ?? 0));
    setRawGun(String(p.odeme_gunu ?? ""));
    setRawTaksit(String(p.taksit_sayisi ?? ""));
  }

  function parseNum(s: string) {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }

  // taksit sayısından bitis_ay hesapla
  function setTaksitSayisi(sayi: number) {
    if (!p.baslangic_ay || sayi <= 0) {
      set({ ...p, taksit_sayisi: sayi });
      return;
    }
    const [y, m] = p.baslangic_ay.split("-").map(Number);
    const bitisDate = new Date(y, m - 1 + sayi - 1);
    const bitisAy =
      bitisDate.getFullYear() +
      "-" +
      String(bitisDate.getMonth() + 1).padStart(2, "0");
    set({ ...p, taksit_sayisi: sayi, bitis_ay: bitisAy });
  }
  function setBaslangic(val: string) {
    const sayi = p.taksit_sayisi;
    if (!sayi || sayi <= 0) {
      set({ ...p, baslangic_ay: val });
      return;
    }
    const [y, m] = val.split("-").map(Number);
    const bitisDate = new Date(y, m - 1 + sayi - 1);
    const bitisAy =
      bitisDate.getFullYear() +
      "-" +
      String(bitisDate.getMonth() + 1).padStart(2, "0");
    set({ ...p, baslangic_ay: val, bitis_ay: bitisAy });
  }
  return (
    <div className="editor">
      <h3>Ödeme bilgisi</h3>
      <div className="formGrid">
        <label>
          Ad
          <input
            value={p.ad}
            onChange={(e) => set({ ...p, ad: e.target.value })}
          />
        </label>
        <label>
          Tür
          <select
            value={p.tur}
            onChange={(e) => set({ ...p, tur: e.target.value })}
          >
            <option value="kredi">Kredi</option>
            <option value="kart">Kart</option>
            <option value="fatura">Fatura</option>
            <option value="taksit">Taksit</option>
            <option value="diger">Diğer</option>
          </select>
        </label>
        <label>
          {p.tur === "taksit" ? "Taksit tutarı" : "Bu ayın tutarı"}
          <input
            type="text"
            inputMode="decimal"
            value={rawBuAy}
            onChange={(e) => setRawBuAy(e.target.value)}
            onBlur={() => {
              const v = parseNum(rawBuAy);
              setRawBuAy(String(v));
              set(p.tur === "taksit"
                ? { ...p, tutar: v, bu_ay_tutar: v }
                : { ...p, bu_ay_tutar: v });
            }}
            onFocus={(e) => e.target.select()}
          />
        </label>
        {p.tur !== "taksit" && (
          <label>
            Sonraki ayların normal tutarı
            <input
              type="text"
              inputMode="decimal"
              value={rawTutar}
              onChange={(e) => setRawTutar(e.target.value)}
              onBlur={() => {
                const v = parseNum(rawTutar);
                setRawTutar(String(v));
                set({ ...p, tutar: v });
              }}
              onFocus={(e) => e.target.select()}
            />
          </label>
        )}
        <label>
          Ödeme günü
          <input
            type="text"
            inputMode="numeric"
            value={rawGun}
            onChange={(e) => setRawGun(e.target.value)}
            onBlur={() => {
              const v = parseNum(rawGun);
              setRawGun(String(v));
              set({ ...p, odeme_gunu: v });
            }}
            onFocus={(e) => e.target.select()}
          />
        </label>
        <label>
          Kaynak
          <select
            value={p.odeme_kaynagi || "banka"}
            onChange={(e) => set({ ...p, odeme_kaynagi: e.target.value })}
          >
            <option value="banka">Banka / KMH</option>
            <option value="kredi_karti">Kredi kartı</option>
          </select>
        </label>
        <label>
          Başlangıç
          <input
            type="month"
            value={p.baslangic_ay || ""}
            onChange={(e) => setBaslangic(e.target.value)}
          />
        </label>
        <label>
          Taksit sayısı
          <input
            type="text"
            inputMode="numeric"
            placeholder="Boş = süresiz"
            value={rawTaksit}
            onChange={(e) => setRawTaksit(e.target.value)}
            onBlur={() => {
              if (!rawTaksit) { setTaksitSayisi(0); return; }
              const v = parseNum(rawTaksit);
              setRawTaksit(v > 0 ? String(v) : "");
              setTaksitSayisi(v);
            }}
            onFocus={(e) => e.target.select()}
          />
        </label>
        {p.bitis_ay && (
          <label>
            Bitiş (otomatik)
            <input type="month" value={p.bitis_ay} readOnly style={{ opacity: 0.6 }} />
          </label>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!p.kart_tavanina_dahil}
            onChange={(e) =>
              set({ ...p, kart_tavanina_dahil: e.target.checked })
            }
          />{" "}
          Kart tavanının içinde
        </label>
      </div>
      <div className="actions">
        <button className="primary" onClick={done}>
          Kaydet
        </button>
        <button className="ghost" onClick={cancel}>
          Vazgeç
        </button>
      </div>
    </div>
  );
}

function adjustedGoals(week: any, carry: any) {
  return {
    kart: Math.max(0, week.goal.kart - carry.kart),
    nakit: Math.max(0, week.goal.nakit - carry.nakit),
  };
}
function WeekBox({
  week,
  carry,
  data,
  now,
  save,
}: {
  week: any;
  carry: any;
  data: BudgetData;
  now: Date;
  save: Save;
}) {
  const [type, setType] = useState<"kart" | "nakit">("kart"),
    [amount, setAmount] = useState(""),
    [desc, setDesc] = useState("");
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => { amountRef.current?.focus(); }, []);

  const g = adjustedGoals(week, carry),
    r = g.kart + g.nakit - week.spent.kart - week.spent.nakit;

  const wk = dateToIso(week.start),
    advanced = +week.start > +now;

  function selectType(t: "kart" | "nakit") {
    setType(t);
    setTimeout(() => amountRef.current?.focus(), 0);
  }

  function add() {
    const v = num(amount);
    if (v <= 0 || v > 100_000) return;
    const d = normalize(data);
    d.haftalik_harcamalar.push({
      id: newId(),
      tarih: dateToIso(now),
      butce_haftasi: wk,
      tur: type,
      tutar: v,
      aciklama: desc,
      olusturma_zamani: new Date().toISOString(),
    });
    save(d, advanced ? "Harcama yeni takip haftasına eklendi" : "Harcama eklendi");
    setAmount("");
    setDesc("");
  }

  return (
    <section className="panel">
      <div className="inlineExpenseForm">
        <p className="inlineExpenseLabel">HARCAMA GİR</p>
        <div className="expenseTypeButtons">
          <button
            className={type === "kart" ? "expenseTypeSelected" : "expenseTypeIdle"}
            onClick={() => selectType("kart")}
          >
            <span className="uiIcon" aria-hidden="true">K</span> Kart
          </button>
          <button
            className={type === "nakit" ? "expenseTypeSelected" : "expenseTypeIdle"}
            onClick={() => selectType("nakit")}
          >
            <span className="uiIcon" aria-hidden="true">N</span> Nakit
          </button>
        </div>
        <input
          ref={amountRef}
          type="text"
          inputMode="decimal"
          className="expenseInput"
          placeholder="Tutar (₺)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <input
          type="text"
          className="expenseInput"
          placeholder="Açıklama (opsiyonel)"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button
          className="expenseAddBtn"
          onClick={add}
          disabled={num(amount) <= 0}
        >
          Ekle
        </button>
      </div>
      <div className="panelTitle" style={{ marginTop: 16 }}>
        <div>
          <h2>Bu haftaki limitiniz</h2>
          <p>
            {fmtShortDate(week.effective)} – {fmtShortDate(week.end)}
          </p>
        </div>
      </div>
      <Meter l="Kredi kartı" v={week.spent.kart} max={g.kart} color="purple" />
      <Meter l="Nakit / KMH" v={week.spent.nakit} max={g.nakit} color="green" />
      <div className={r >= 0 ? "weekTotal good" : "weekTotal bad"}>
        <span>
          {r >= 0 ? "Kullanılabilir bütçe" : "Kullanılabilir bütçe aşıldı"}
        </span>
        <b>{trMoney(r)} kalan</b>
      </div>
    </section>
  );
}
function Weekly({
  data,
  week,
  freshWeek,
  carry,
  savings,
  now,
  save,
}: {
  data: BudgetData;
  week: any;
  freshWeek: any;
  carry: any;
  savings: number;
  now: Date;
  save: Save;
}) {
  const [editingId, setEditingId] = useState<number | null>(null),
    [editDraft, setEditDraft] = useState<{ tutar: string; aciklama: string }>({ tutar: "", aciklama: "" });
  const wk = dateToIso(week.start),
    goals = adjustedGoals(week, carry),
    groupedRecords = Object.entries(
      week.records.reduce((groups: Record<string, any[]>, record: any) => {
        (groups[record.tarih] ||= []).push(record);
        return groups;
      }, {}),
    ).sort(([a], [b]) => b.localeCompare(a)),
    closedToday = Object.values(data.haftalik_kapanislar || {}).some(
      (x: any) =>
        String(x.kapanis_tarihi || x.kapanma_zamani || "").slice(0, 10) ===
        dateToIso(now),
    );
  function remove(r: any) {
    const d = normalize(data);
    d.haftalik_harcamalar = d.haftalik_harcamalar.filter((x) => x.id !== r.id);
    save(d, "Harcama silindi");
  }
  function startEdit(r: any) {
    setEditingId(r.id);
    setEditDraft({ tutar: String(r.tutar), aciklama: r.aciklama || "" });
  }
  function commitEdit(r: any) {
    const v = num(editDraft.tutar);
    if (v > 0 && v <= 100_000) {
      const d = normalize(data),
        x = d.haftalik_harcamalar.find((q) => q.id === r.id);
      if (x) { x.tutar = v; x.aciklama = editDraft.aciklama; }
      save(d, "Harcama düzeltildi");
    }
    setEditingId(null);
    setEditDraft({ tutar: "", aciklama: "" });
  }
  function cancelEdit() {
    setEditingId(null);
    setEditDraft({ tutar: "", aciklama: "" });
  }
  function close() {
    if (closedToday) {
      alert(
        "Bugün zaten bir takip haftası kapattınız. Yeni takip haftasını yarın kapatabilirsiniz.",
      );
      return;
    }
    const d = normalize(data);
    d.haftalik_kapanislar[wk] = {
      baslangic: wk,
      bitis: dateToIso(week.end),
      kart: week.spent.kart,
      nakit: week.spent.nakit,
      kapanma_zamani: new Date().toISOString(),
      kapanis_tarihi: dateToIso(now),
    };
    save(d, "Hafta kapatıldı; yeni takip haftası açıldı");
  }
  return (
    <div className="weeklyPage single">
      <section className="panel weekly">
        <div className="panelTitle noPad">
          <div>
            <h2>Bu haftanın harcama detayı</h2>
            <p>{dateToIso(week.start)} – {dateToIso(week.end)}</p>
          </div>
          <span className="badge amber">Açık</span>
        </div>
        <div className="weekSummaryBar">
          <span>Kart <b>{trMoney(week.spent.kart)}</b> / {trMoney(freshWeek.goal.kart)}</span>
          <span>Nakit <b>{trMoney(week.spent.nakit)}</b> / {trMoney(freshWeek.goal.nakit)}</span>
          <span className={savings >= 0 ? "good" : "bad"}>
            {savings >= 0 ? "Nakit hedefinden kalan" : "Nakit hedefi aşımı"} <b>{trMoney(Math.abs(savings))}</b>
          </span>
        </div>
        <div className="recordList">
          {groupedRecords.map(([date, records]) => <section className="recordDay" key={date}>
            <h3>
              <span>{new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))}</span>
              <strong>{trMoney((records as any[]).reduce((sum, r) => sum + num(r.tutar), 0))}</strong>
            </h3>
            {(records as any[]).map((r: any) => (
            <article key={r.id}>
              <span>
                <b>{r.tur === "kart" ? "Kart" : "Nakit"}</b> ·{" "}
                {r.aciklama || "Açıklama yok"}
              </span>
              {editingId === r.id ? (
                <div className="inlineEditRow">
                  <input
                    className="inlineEdit"
                    type="text"
                    inputMode="numeric"
                    placeholder="Tutar"
                    value={editDraft.tutar}
                    onChange={(e) => setEditDraft({ ...editDraft, tutar: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(r);
                      if (e.key === "Escape") cancelEdit();
                    }}
                    autoFocus
                  />
                  <input
                    className="inlineEdit"
                    type="text"
                    placeholder="Açıklama"
                    value={editDraft.aciklama}
                    onChange={(e) => setEditDraft({ ...editDraft, aciklama: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(r);
                      if (e.key === "Escape") cancelEdit();
                    }}
                  />
                  <button className="primary" onClick={() => commitEdit(r)}>Kaydet</button>
                  <button className="ghost" onClick={cancelEdit}>İptal</button>
                </div>
              ) : (
                <>
                  <strong>{trMoney(r.tutar)}</strong>
                  <button className="ghost" onClick={() => startEdit(r)}>Düzenle</button>
                  <button className="danger" onClick={() => remove(r)}>Sil</button>
                </>
              )}
            </article>
            ))}
          </section>)}
          {!week.records.length && (
            <div className="empty">Bu hafta henüz harcama yok.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function Update({
  data,
  now,
  save,
  notice,
}: {
  data: BudgetData;
  now: Date;
  save: Save;
  notice: string;
}) {
  const [g, setG] = useState({ ...data.guncel_durum });
  const [kart, setKart] = useState({
    yk_toplam_borc: num(data.guncel_durum.yk_toplam_borc),
    yk_kullanilabilir: num(data.guncel_durum.yk_kullanilabilir),
    yk_limit: num(data.guncel_durum.yk_limit),
  });
  const [ekstre, setEkstre] = useState({
    hesap_kesim_tarihi: "",
    son_odeme_tarihi: "",
    sonraki_hesap_kesim_tarihi: "",
    odeme_tarihi: "",
    donem_borcu: 0,
    asgari_tutar: 0,
    odenen_tutar: 0,
    kalan_donem_borcu: 0,
    donem_faizi: 0,
    yillik_kart_ucreti: 0,
    ...data.guncel_durum.yk_hesap_ozeti,
  });
  const [kartHedef, setKartHedef] = useState(num(data.haftalik_hedefler.kart));
  const [nakitHedef, setNakitHedef] = useState(num(data.haftalik_hedefler.nakit));
  const [maasForm, setMaasForm] = useState<any>(null);

  function sync() {
    const d = normalize(data);
    const oldDate = String(d.guncel_durum.tarih || "").slice(0, 7);
    const sameMonth = oldDate === dateToIso(now).slice(0, 7);
    const remainingIncome = sameMonth
      ? incomeStatus(d, { ...d.guncel_durum, ...g }, now).remaining
      : scheduledIncomeRemaining(d, g, now);
    if (oldDate && oldDate !== dateToIso(now).slice(0, 7))
      d.aylik_ankorlar[oldDate] = structuredClone(d.guncel_durum);
    d.guncel_durum = {
      ...d.guncel_durum,
      ...g,
      ay_kalan_gelir: remainingIncome,
      tarih: dateToIso(now),
      takip_baslangic_zamani: new Date().toISOString(),
    };
    save(d, "Banka fotoğrafı güncellendi");
  }

  function saveMilat(tarih: string) {
    const d = normalize(data);
    d.butce_plani.butce_baslangic_tarihi = tarih;
    save(d, "Bütçe başlangıç tarihi güncellendi");
  }
  function syncKart() {
    const d = normalize(data);
    const previous = d.guncel_durum.yk_hesap_ozeti;
    if (
      previous?.hesap_kesim_tarihi &&
      previous.hesap_kesim_tarihi !== ekstre.hesap_kesim_tarihi &&
      !(d.kart_hesap_ozeti_gecmisi || []).some(
        (x: any) => x.hesap_kesim_tarihi === previous.hesap_kesim_tarihi,
      )
    ) d.kart_hesap_ozeti_gecmisi.push(structuredClone(previous));
    const faiz = cardStatementInterest(ekstre, d.ayarlar);
    d.guncel_durum = {
      ...d.guncel_durum,
      yk_toplam_borc: kart.yk_toplam_borc,
      yk_kullanilabilir: kart.yk_kullanilabilir,
      yk_limit: kart.yk_limit,
      yk_beklenen_ekstre: faiz.reportedRemaining,
      yk_guncel_ekstre: faiz.reportedRemaining,
      yk_hesap_ozeti: {
        ...ekstre,
        odenen_tutar: Math.max(num(ekstre.asgari_tutar), num(ekstre.odenen_tutar)),
        akdi_faiz_orani: faiz.contractualRate,
        vergi_orani: faiz.taxRate,
      },
    };
    save(d, "YK kart ve hesap özeti güncellendi");
  }
  function saveHedefler() {
    const d = normalize(data);
    d.haftalik_hedefler.kart = kartHedef;
    d.haftalik_hedefler.nakit = nakitHedef;
    save(d, "Haftalık hedefler güncellendi");
  }

  function saveMaas(form: any) {
    const d = normalize(data);
    const takvim: any[] = [...(d.ayarlar.maas_takvimi || [])];
    const i = takvim.findIndex((q: any) => q.baslangic_ay === form.baslangic_ay_orig);
    const clean = { tutar: num(form.tutar), baslangic_ay: form.baslangic_ay };
    if (i >= 0) takvim[i] = clean;
    else takvim.push(clean);
    takvim.sort((a, b) => String(a.baslangic_ay).localeCompare(String(b.baslangic_ay)));
    d.ayarlar.maas_takvimi = takvim;
    save(d, "Maaş takvimi güncellendi");
    setMaasForm(null);
  }

  function delMaas(ay: string) {
    const d = normalize(data);
    d.ayarlar.maas_takvimi = (d.ayarlar.maas_takvimi || []).filter((q: any) => q.baslangic_ay !== ay);
    save(d, "Maaş takvimi satırı silindi");
  }

  const ekstreFaiz = cardStatementInterest(ekstre, data.ayarlar);
  return (
    <div className="single updateGrid">
      <details className="panel updatePanel" open>
        <summary><span className="uiIcon" aria-hidden="true">₺</span><span><b>Garanti / KMH bakiyesi</b><small>Yeni bakiye: {trMoney(g.garanti_bakiye)}</small></span></summary>
        <div className="updatePanelBody">
        <div className="formGrid">
          <Field
            l="Garanti / KMH bakiye"
            v={g.garanti_bakiye}
            set={(v) => setG({ ...g, garanti_bakiye: v })}
          />
        </div>
        <button className="primary" style={{ marginTop: 12 }} onClick={sync}>
          Güncelle
        </button>
        {notice && <span className="saveFeedback" role="status">✓ {notice}</span>}
        <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <label htmlFor="milatInput" style={{ fontSize: "0.8rem", color: "var(--muted)", display: "block", marginBottom: 6 }}>
            Nakit birikim milat tarihi
          </label>
          <input
            type="date"
            defaultValue={String(data.butce_plani.butce_baslangic_tarihi || "").slice(0, 10)}
            style={{ padding: "8px 12px", border: "1.5px solid var(--line)", borderRadius: 8, fontSize: "1rem", marginRight: 10 }}
            id="milatInput"
          />
          <button
            className="secondary"
            onClick={() => {
              const v = (document.getElementById("milatInput") as HTMLInputElement)?.value;
              if (v) saveMilat(v);
            }}
          >
            Kaydet
          </button>
        </div>
        </div>
      </details>

      <details className="panel updatePanel">
        <summary><span className="uiIcon" aria-hidden="true">K</span><span><b>Yapı Kredi kart durumu</b><small>{trMoney(kart.yk_toplam_borc)} borç</small></span></summary>
        <div className="updatePanelBody">
        <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: "0 0 12px" }}>
          Kart limiti projeksiyon hesabını, toplam borç canlı kart faizini etkiler.
        </p>
        <div className="formGrid">
          <Field l="Toplam kart borcu" v={kart.yk_toplam_borc} set={(v) => setKart({ ...kart, yk_toplam_borc: v })} />
          <Field l="Kullanılabilir limit" v={kart.yk_kullanilabilir} set={(v) => setKart({ ...kart, yk_kullanilabilir: v })} />
          <Field l="Kart limiti (toplam)" v={kart.yk_limit} set={(v) => setKart({ ...kart, yk_limit: v })} />
        </div>
        <div className="statementEditor">
          <h3>Son hesap özeti</h3>
          <p className="helperText">
            Her ay ekstrede yazan değerleri girin. Ödeme tarihi boşsa asgarinin son ödeme tarihinden bir gün önce ödendiği varsayılır.
          </p>
          <div className="formGrid">
            <DateField l="Hesap kesim tarihi" v={ekstre.hesap_kesim_tarihi} set={(v) => setEkstre({ ...ekstre, hesap_kesim_tarihi: v })} />
            <DateField l="Son ödeme tarihi" v={ekstre.son_odeme_tarihi} set={(v) => setEkstre({ ...ekstre, son_odeme_tarihi: v })} />
            <DateField l="Sonraki hesap kesim tarihi" v={ekstre.sonraki_hesap_kesim_tarihi} set={(v) => setEkstre({ ...ekstre, sonraki_hesap_kesim_tarihi: v })} />
            <DateField l="Ödemenin karta yansıdığı tarih" v={ekstre.odeme_tarihi} set={(v) => setEkstre({ ...ekstre, odeme_tarihi: v })} />
            <Field l="Dönem borcu" v={ekstre.donem_borcu} set={(v) => setEkstre({ ...ekstre, donem_borcu: v })} />
            <Field l="Asgari ödeme tutarı" v={ekstre.asgari_tutar} set={(v) => setEkstre({ ...ekstre, asgari_tutar: v })} />
            <Field l="Gerçek ödenen tutar (en az asgari)" v={ekstre.odenen_tutar} set={(v) => setEkstre({ ...ekstre, odenen_tutar: v })} />
            <Field l="Bankada görünen kalan ekstre" v={ekstre.kalan_donem_borcu} set={(v) => setEkstre({ ...ekstre, kalan_donem_borcu: v })} />
            <Field l="Ekstredeki dönem faizi" v={ekstre.donem_faizi} set={(v) => setEkstre({ ...ekstre, donem_faizi: v })} />
            <Field l="Yıllık kart ücreti" v={ekstre.yillik_kart_ucreti} set={(v) => setEkstre({ ...ekstre, yillik_kart_ucreti: v })} />
          </div>
          {ekstreFaiz.valid && (
            <div className="statementResult" role="status">
              <div className={ekstreFaiz.minimumMet && ekstreFaiz.paymentOnTime ? "good" : "bad"}>
                <b>{ekstreFaiz.minimumMet && ekstreFaiz.paymentOnTime ? "Asgari ödeme zamanında tamamlandı" : "Asgari ödeme eksik veya geç"}</b>
              </div>
              <span>Hesaba alınan gerçek ödeme <b>{trMoney(Math.max(num(ekstre.asgari_tutar), num(ekstre.odenen_tutar)))}</b></span>
              <span>Kalan dönem borcu <b>{trMoney(ekstreFaiz.reportedRemaining)}</b></span>
              <span>Tahmini akdi faiz <b>{trMoney(ekstreFaiz.contractualInterest)}</b></span>
              <span>KKDF + BSMV tahmini <b>{trMoney(ekstreFaiz.tax)}</b></span>
              <strong>Tahmini toplam faiz {trMoney(ekstreFaiz.total)}</strong>
              {ekstreFaiz.assumedPaymentDate && <small>Ödeme tarihi varsayımı: son ödeme tarihinden 1 gün önce</small>}
            </div>
          )}
        </div>
        <button className="primary" style={{ marginTop: 12 }} onClick={syncKart}>
          Kart ve hesap özetini güncelle
        </button>
        {notice && <span className="saveFeedback" role="status">✓ {notice}</span>}
        </div>
      </details>

      <details className="panel updatePanel">
        <summary><span className="uiIcon" aria-hidden="true">H</span><span><b>Haftalık harcama hedefleri</b><small>{trMoney(kartHedef + nakitHedef)} toplam</small></span></summary>
        <div className="updatePanelBody">
        <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: "0 0 12px" }}>
          KMH çıkış tarihi ve nakit birikim hesabını etkiler.
        </p>
        <div className="formGrid">
          <Field l="Haftalık kart tavanı" v={kartHedef} set={setKartHedef} />
          <Field l="Haftalık nakit / KMH" v={nakitHedef} set={setNakitHedef} />
        </div>
        <button className="primary" style={{ marginTop: 12 }} onClick={saveHedefler}>
          Hedefleri kaydet
        </button>
        {notice && <span className="saveFeedback" role="status">✓ {notice}</span>}
        </div>
      </details>

      <details className="panel updatePanel">
        <summary><span className="uiIcon" aria-hidden="true">T</span><span><b>Maaş takvimi</b><small>{(data.ayarlar.maas_takvimi || []).length} dönem</small></span></summary>
        <div className="updatePanelBody">
        <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: "0 0 12px" }}>
          Hangi aydan itibaren maaş değişiyor? KMH çıkış tarihi hesabını doğrudan etkiler.
        </p>
        <div className="gelirList">
          {(data.ayarlar.maas_takvimi || []).map((x: any) => (
            <div key={x.baslangic_ay} className="gelirRow">
              <span><b>{x.baslangic_ay}</b> · <span>{trMoney(x.tutar)}</span></span>
              <span className="payActions">
                <button className="ghost" onClick={() => setMaasForm({ ...x, baslangic_ay_orig: x.baslangic_ay })}>Düzenle</button>
                <button className="danger" onClick={() => delMaas(x.baslangic_ay)}>Sil</button>
              </span>
            </div>
          ))}
          {!(data.ayarlar.maas_takvimi || []).length && <div className="empty">Takvim boş — 100.000 TL varsayılan kullanılıyor.</div>}
        </div>
        <button className="primary" style={{ marginTop: 8 }} onClick={() => setMaasForm({ baslangic_ay: "", baslangic_ay_orig: "", tutar: 0 })}>
          + Ay ekle
        </button>
        {maasForm && (
          <div className="editor" style={{ marginTop: 12 }}>
            <div className="formGrid">
              <label>Başlangıç ayı<input type="month" value={maasForm.baslangic_ay} onChange={(e) => setMaasForm({ ...maasForm, baslangic_ay: e.target.value })} /></label>
              <Field l="Aylık toplam gelir" v={maasForm.tutar} set={(v) => setMaasForm({ ...maasForm, tutar: v })} />
            </div>
            <div className="actions">
              <button className="primary" onClick={() => saveMaas(maasForm)}>Kaydet</button>
              <button className="ghost" onClick={() => setMaasForm(null)}>Vazgeç</button>
            </div>
          </div>
        )}
        {notice && <span className="saveFeedback" role="status">✓ {notice}</span>}
        </div>
      </details>
    </div>
  );
}
function Field({ l, v, set }: { l: string; v: any; set: (n: number) => void }) {
  const [raw, setRaw] = useState(trMoney(v));
  useEffect(() => setRaw(trMoney(v)), [v]);
  function handleChange(str: string) {
    // Türkçe virgülü noktaya çevir ama yazarken raw'ı koru
    setRaw(str);
  }
  function handleBlur() {
    // Blur'da sayıya çevir: virgül → nokta
    const n = parseTrMoney(raw);
    if (n !== null) {
      set(n);
      setRaw(trMoney(n));
    } else {
      setRaw(trMoney(v));
    }
  }
  return (
    <label>
      {l}
      <input
        type="text"
        inputMode="decimal"
        value={raw}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        onFocus={(e) => e.target.select()}
      />
    </label>
  );
}
function DateField({ l, v, set }: { l: string; v: any; set: (s: string) => void }) {
  return (
    <label>
      {l}
      <input type="date" value={String(v || "").slice(0, 10)} onChange={(e) => set(e.target.value)} />
    </label>
  );
}
function Meter({ l, v, max, color }: { l: string; v: number; max: number; color?: "purple" | "green" }) {
  const p = max ? Math.min(100, Math.max(0, (v / max) * 100)) : 0;
  const kalan = max - v;
  const barClass = v > max ? "over" : p >= 80 ? "warn" : "";
  // warn/over durumda CSS class rengi kullanılır; normal durumda prop rengi
  const barColor = (v > max || p >= 80) ? undefined : color === "green" ? "#0ca55b" : color === "purple" ? "#625df5" : undefined;
  // warn durumunda doluluk oranına göre sarı→kırmızı dinamik gradyan
  const warnGradient = barClass === "warn" ? (() => {
    const t = Math.min(1, Math.max(0, (p - 80) / 20)); // 80%→0, 100%→1
    const r = Math.round(245 + t * (220 - 245));
    const g = Math.round(158 + t * (53 - 158));
    const b = Math.round(11 + t * (69 - 11));
    return `rgb(${r},${g},${b})`;
  })() : undefined;
  return (
    <div className="meter">
      <div>
        <b>{l}</b>
        <span className="meterStats">
          <span>{trMoney(v)} harcandı</span>
          <span className="meterDot">·</span>
          <span>{trMoney(max)} limit</span>
          <span className="meterDot">·</span>
          <b className={kalan < 0 ? "bad" : ""}>{trMoney(kalan)} kalan</b>
        </span>
      </div>
      <em>
        <i className={barClass} style={{ width: `${p}%`, ...(barColor ? { background: barColor } : {}), ...(warnGradient ? { background: warnGradient } : {}) }} />
      </em>
    </div>
  );
}
function Row({ l, v }: { l: string; v: string }) {
  return (
    <div className="row">
      <span>{l}</span>
      <b>{v}</b>
    </div>
  );
}
