/* eslint-disable @typescript-eslint/no-explicit-any, prefer-const, react-hooks/exhaustive-deps */
"use client";
import { createClient, Session } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import {
  ACTIVITY_RETENTION_MS,
  activeInMonth,
  activeWeeklySummary,
  activityFromOtherDevice,
  cardReductionAdvice,
  cardStatementInterest,
  carriesForwardPaymentAmount,
  fillMissingPaymentTypes,
  clearFuturePaymentOverrides,
  BudgetData,
  dateToIso,
  effectiveDay,
  enableWallet,
  exitDates,
  incomeStatus,
  isTurkishPublicHoliday,
  liveFinancial,
  monthlySpendingSummary,
  monthlyCardTargetReview,
  normalize,
  nextMonth,
  paymentAmount,
  paymentKey,
  pruneActivityLog,
  recordWalletCorrection,
  recordWalletWithdrawal,
  recentActivityLog,
  scheduledIncomeRemaining,
  shouldRetainExpenseDetails,
  trMoney,
  trMonth,
  todayUtc,
  weeklySavings,
  weeklyCardSavings,
  walletState,
  weekRange,
  weeklySummary,
} from "./lib/budget-engine";
import { mergeChanged } from "./lib/merge-changed";

const TR_MONTHS_SHORT = ["Oca","Şub","Mar","Nis","May","Haz","Tem","Ağu","Eyl","Eki","Kas","Ara"];
function fmtShortDate(d: Date): string {
  return `${d.getUTCDate()} ${TR_MONTHS_SHORT[d.getUTCMonth()]}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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
      const q = indexedDB.open("butce-takip-v2", 2);
      q.onupgradeneeded = () => {
        if (!q.result.objectStoreNames.contains("auth")) q.result.createObjectStore("auth");
        if (!q.result.objectStoreNames.contains("outbox")) q.result.createObjectStore("outbox");
      };
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
type PendingBudgetSave = {
  family: string;
  base: BudgetData;
  next: BudgetData;
  message: string;
  createdAt: string;
};
const OUTBOX_KEY = "pending-budget-save";
const DEVICE_ID_KEY = "budget-anonymous-device-id";
const ACTIVITY_NOTIFIED_KEY = "budget-activity-notified-ids";
const ACTIVITY_SEEN_KEY = "budget-activity-seen-ids";
function getAnonymousDeviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch { return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}
function readLocalIdSet(key: string) {
  try { return new Set<string>(JSON.parse(localStorage.getItem(key) || "[]")); }
  catch { return new Set<string>(); }
}
function hasLocalValue(key: string) {
  try { return localStorage.getItem(key) !== null; } catch { return false; }
}
function writeLocalIdSet(key: string, values: Iterable<string>) {
  try { localStorage.setItem(key, JSON.stringify([...values])); } catch { /* Oturum boyunca state kullanılmaya devam eder. */ }
}
async function readPendingBudgetSave(): Promise<PendingBudgetSave | null> {
  try {
    const db = await authStorage.db();
    return await new Promise<PendingBudgetSave | null>((resolve, reject) => {
      const q = db.transaction("outbox").objectStore("outbox").get(OUTBOX_KEY);
      q.onsuccess = () => resolve(q.result ?? null);
      q.onerror = () => reject(q.error);
    });
  } catch { return null; }
}
async function writePendingBudgetSave(value: PendingBudgetSave) {
  try {
    const db = await authStorage.db();
    await new Promise<void>((resolve, reject) => {
      const q = db.transaction("outbox", "readwrite").objectStore("outbox").put(value, OUTBOX_KEY);
      q.onsuccess = () => resolve();
      q.onerror = () => reject(q.error);
    });
  } catch { /* Ekrandaki iyimser kayıt yine korunur. */ }
}
async function clearPendingBudgetSave() {
  try {
    const db = await authStorage.db();
    await new Promise<void>((resolve, reject) => {
      const q = db.transaction("outbox", "readwrite").objectStore("outbox").delete(OUTBOX_KEY);
      q.onsuccess = () => resolve();
      q.onerror = () => reject(q.error);
    });
  } catch { /* Sonraki başarılı kayıtta tekrar temizlenir. */ }
}
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
const shiftIsoDate = (value: string, days: number) => {
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (isNaN(+d)) return "";
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
type Save = (d: BudgetData, m?: string) => Promise<void>;

function parseTrMoney(value: string): number | null {
  const clean = value.replace(/\s/g, "").replace(/TL|₺/gi, "");
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function Monthly({ data, now }: { data: BudgetData; now: Date }) {
  const [selected, setSelected] = useState(() => ({
      y: now.getUTCFullYear(),
      m: now.getUTCMonth() + 1,
    })),
    month = monthlySpendingSummary(
      data,
      new Date(Date.UTC(selected.y, selected.m - 1, 15)),
    ),
    planStart = new Date(`${String(data.butce_plani.butce_baslangic_tarihi).slice(0, 10)}T00:00:00Z`),
    minMonth = isNaN(+planStart)
      ? { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 }
      : { y: planStart.getUTCFullYear(), m: planStart.getUTCMonth() + 1 },
    currentMonth = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 },
    maxMonthDate = new Date(Date.UTC(currentMonth.y, currentMonth.m - 1 + 12, 1)),
    maxMonth = { y: maxMonthDate.getUTCFullYear(), m: maxMonthDate.getUTCMonth() + 1 },
    atMin = selected.y === minMonth.y && selected.m === minMonth.m,
    atMax = selected.y === maxMonth.y && selected.m === maxMonth.m,
    isFuture = selected.y > currentMonth.y || (selected.y === currentMonth.y && selected.m > currentMonth.m);
  function moveMonth(delta: number) {
    const d = new Date(Date.UTC(selected.y, selected.m - 1 + delta, 1));
    setSelected({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }
  const r = month.totalRemaining,
    end = new Date(Date.UTC(month.y, month.m, 0)),
    periodFormatter = new Intl.DateTimeFormat("tr-TR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
    startLabel = periodFormatter.format(month.effective),
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
          <h2>Aylık harcama hedefi {isFuture && <span className="badge amber">Tahmini plan</span>}</h2>
          <p>
            {startLabel} – {endLabel} · {month.days} günlük
            hedef
          </p>
        </div>
      </div>
      <div className="monthNavigator monthlyNavigator">
        <button className="secondary" onClick={() => moveMonth(-1)} disabled={atMin}>◀ Önceki ay</button>
        <strong>{trMonth([selected.y, selected.m])}</strong>
        <button className="secondary" onClick={() => moveMonth(1)} disabled={atMax}>Sonraki ay ▶</button>
      </div>
      <Meter l="Kart" v={month.spent.kart} max={month.goal.kart} planned={isFuture} />
      <Meter l="Nakit harcama" v={month.spent.nakit} max={month.goal.nakit} planned={isFuture} />
      <div className={isFuture || r >= 0 ? "weekTotal good" : "weekTotal bad"}>
        <span>{isFuture ? "Toplam planlanan kullanılabilir hedef" : r >= 0 ? "Yaşam harcaması hedefi korunuyor" : "Yaşam harcaması hedefi aşıldı"}</span>
        <b>{isFuture ? trMoney(month.totalGoal) : r >= 0 ? `${trMoney(r)} kalan` : `${trMoney(Math.abs(r))} aşım`}</b>
      </div>
      {month.fixedCard > 0 && (
        <div className="monthlyBreakdown">
          <span>
            Bu dönemde kart hedefinden ayrılan sabit ödeme <b>{trMoney(month.fixedCard)}</b>
          </span>
        </div>
      )}
      <p className="monthlyHelp">
        {isFuture
          ? "Bu ekran gerçekleşen harcamayı değil, seçili ay için mevcut hedef ve ödeme planına göre hesaplanan tahmini kullanılabilir bütçeyi gösterir."
          : "Bu tutar hesap bakiyesi değildir; yalnız yaşam harcaması hedefinden kalan payı gösterir. Krediler, kart borcu ödemesi ve kart hedefinden ayrılmayan diğer sabit ödemeler bu hedefe dahil değildir."}
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
    [lastSyncAt, setLastSyncAt] = useState<Date | null>(null),
    [notice, setNotice] = useState(""),
    [now, setNow] = useState(todayUtc()),
    [closedCardReviewDate, setClosedCardReviewDate] = useState(() => {
      try {
        const today = dateToIso(todayUtc());
        return localStorage.getItem("card-target-review-dismissed-date") === today ? today : "";
      } catch { return ""; }
    }),
    [suggestedCardTarget, setSuggestedCardTarget] = useState<number | null>(null),
    [hasPendingSave, setHasPendingSave] = useState(false),
    [retryingSave, setRetryingSave] = useState(false),
    [deviceId] = useState(getAnonymousDeviceId),
    [activityNoticeCount, setActivityNoticeCount] = useState(0),
    [unseenActivityCount, setUnseenActivityCount] = useState(0),
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
    dataRef = useRef<BudgetData | null>(null),
    retryingSaveRef = useRef(false),
    pendingSaveRef = useRef(false),
    activityInitializedFamilyRef = useRef("");
  useEffect(() => { pendingSaveRef.current = hasPendingSave; }, [hasPendingSave]);
  async function load() {
    setSync("Bağlanıyor");
    let m = await supabase
        .from("family_members")
        .select("family_id")
        .eq("user_id", session.user.id)
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
    if (pruneActivityLog(withAuto)) autoSaved = true;
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
      const ws = weeklySummary(withAuto, cursor);
      if (!withAuto.haftalik_kapanislar[key]) {
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
      } else {
        const closure = withAuto.haftalik_kapanislar[key];
        // Ayrıntı hâlâ mevcutsa kapanış toplamını onunla doğrula. Eski veya
        // eksik kapanış kaydı ayrıntıların kaybolmasına neden olmasın.
        const hasDetails = withAuto.haftalik_harcamalar.some((record: any) => {
          const t = String(record.tarih || "");
          const hw = String(record.butce_haftasi || "");
          return hw === key || (!hw && t >= key && t <= dateToIso(end));
        });
        if (
          hasDetails &&
          (Math.abs(num(closure.kart) - ws.spent.kart) > 0.01 ||
            Math.abs(num(closure.nakit) - ws.spent.nakit) > 0.01)
        ) {
          closure.kart = ws.spent.kart;
          closure.nakit = ws.spent.nakit;
          closure.duzeltme_zamani = new Date().toISOString();
          autoSaved = true;
        }
      }
      // Kapalı haftanın bireysel harcama kayıtlarını temizle.
      // Kapanış toplamları haftalik_kapanislar'da saklandığından bu kayıtlar artık gereksiz.
      // Test ile doğrulandı: weeklySavings, weeklyCardSavings, liveFinancial etkilenmiyor.
      const weekEndIso = dateToIso(end);
      withAuto.haftalik_harcamalar = withAuto.haftalik_harcamalar.filter((r: any) => {
        // Cüzdan bakiyesi bu kayıtlardan yeniden üretildiği için ayrıntı korunur.
        // Aylık toplam, kapanış kaydı bulunan ayrıntıyı zaten ikinci kez saymaz.
        if (shouldRetainExpenseDetails(r)) return true;
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
    const paymentTypesFixed = fillMissingPaymentTypes(finalData.odemeler);
    // Otomatik kapanış, encoding veya eski ödeme türü düzeltmesi olduysa sessizce kaydet
    let savedVersion = r.data.version;
    if ((autoSaved || hasBozuk || paymentTypesFixed) && fid) {
      const persisted = await supabase
        .from("budget_state")
        .update({
          payload: finalData,
          version: r.data.version + 1,
          updated_at: new Date().toISOString(),
          updated_by: session.user.id,
        })
        .eq("family_id", fid)
        .eq("version", r.data.version)
        .select("version")
        .maybeSingle();
      if (persisted.error || !persisted.data) {
        // Uzak kayıt doğrulanmadıysa ayrıntıları temizlenmiş yerel kopyayı
        // kullanma. Sunucudan okunan özgün veri ekranda korunur.
        dataRef.current = loaded;
        versionRef.current = r.data.version;
        (window as any).__bd__ = loaded;
        setData(loaded);
        setSync("Bağlantı hatası");
        setLastSyncAt(new Date());
        return;
      }
      savedVersion = Number(persisted.data.version) || r.data.version + 1;
    }
    const pending = await readPendingBudgetSave(),
      displayedData = pending?.family === fid ? normalize(pending.next) : finalData;
    dataRef.current = displayedData;
    versionRef.current = savedVersion;
    (window as any).__bd__ = displayedData;
    setFamily(fid);
    setData(displayedData);
    setHasPendingSave(pending?.family === fid);
    setSync(pending?.family === fid ? "Bağlantı bekleniyor" : "Güncel");
    setLastSyncAt(new Date());
  }
  useEffect(() => {
    // Initial load synchronizes the component with the authenticated remote store.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    let midnightTimer = 0;
    const refreshDay = () => {
      const current = todayUtc();
      setNow((previous) => dateToIso(previous) === dateToIso(current) ? previous : current);
    };
    const scheduleMidnight = () => {
      window.clearTimeout(midnightTimer);
      const localNow = new Date(),
        nextMidnight = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate() + 1, 0, 0, 1);
      midnightTimer = window.setTimeout(() => {
        refreshDay();
        scheduleMidnight();
      }, Math.max(1_000, +nextMidnight - +localNow));
    };
    const handleVisibility = () => { if (!document.hidden) refreshDay(); };
    scheduleMidnight();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", refreshDay);
    return () => {
      window.clearTimeout(midnightTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", refreshDay);
    };
  }, []);
  useEffect(() => {
    if (!family) return;
    const retryWhenOnline = () => { if (navigator.onLine) void retryPendingSave(); };
    void readPendingBudgetSave().then((pending) => {
      const belongsHere = !!pending && pending.family === family;
      setHasPendingSave(belongsHere);
      if (belongsHere && navigator.onLine) void retryPendingSave();
    });
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [family]);
  useEffect(() => {
    if (!data || !family) return;
    const recent = recentActivityLog(data),
      recentIds = new Set(recent.map((item: any) => String(item.id))),
      otherDevice = activityFromOtherDevice(data, deviceId),
      notifiedKey = `${ACTIVITY_NOTIFIED_KEY}-${family}`,
      seenKey = `${ACTIVITY_SEEN_KEY}-${family}`;
    if (activityInitializedFamilyRef.current !== family) {
      activityInitializedFamilyRef.current = family;
      if (!hasLocalValue(notifiedKey))
        writeLocalIdSet(notifiedKey, recentIds);
      if (!hasLocalValue(seenKey))
        writeLocalIdSet(seenKey, recentIds);
    }
    const notified = readLocalIdSet(notifiedKey),
      seen = readLocalIdSet(seenKey),
      newItems = activityFromOtherDevice(data, deviceId, notified);
    if (newItems.length) {
      for (const item of newItems) notified.add(String(item.id));
      // Yeni uzak kayıtları tek seferlik uygulama içi bildirime dönüştür.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActivityNoticeCount((current) => current + newItems.length);
    }
    writeLocalIdSet(notifiedKey, [...notified].filter((id) => recentIds.has(id)));
    writeLocalIdSet(seenKey, [...seen].filter((id) => recentIds.has(id)));
    setUnseenActivityCount(otherDevice.filter((item: any) => !seen.has(String(item.id))).length);
  }, [data, deviceId, family]);
  useEffect(() => {
    if (!activityNoticeCount) return;
    const timer = window.setTimeout(() => setActivityNoticeCount(0), 7_000);
    return () => window.clearTimeout(timer);
  }, [activityNoticeCount]);
  useEffect(() => {
    if (!data || !family || !(data.hareket_gunlugu || []).length) return;
    const expiries = data.hareket_gunlugu
      .map((item: any) => +new Date(item.olusturma_zamani || 0) + ACTIVITY_RETENTION_MS)
      .filter((value: number) => Number.isFinite(value));
    if (!expiries.length) return;
    const nextExpiry = Math.min(...expiries),
      delay = Math.max(1_000, nextExpiry - Date.now() + 250);
    const timer = window.setTimeout(() => {
      const current = dataRef.current ? normalize(dataRef.current) : null;
      if (current && pruneActivityLog(current)) void save(current, "");
    }, delay);
    return () => window.clearTimeout(timer);
  }, [data, family]);
  useEffect(() => {
    if (!family) return;
    let active = true;
    const acceptRemote = (payload: any, version: number) => {
      if (!active || pendingSaveRef.current || version <= versionRef.current) return;
      const remote = normalize(payload);
      versionRef.current = version;
      dataRef.current = remote;
      (window as any).__bd__ = remote;
      setData(remote);
      setSync("Güncel");
      setLastSyncAt(new Date());
    };
    const refreshRemote = async () => {
      if (document.hidden || pendingSaveRef.current || retryingSaveRef.current) return;
      const fresh = await supabase
        .from("budget_state")
        .select("payload,version")
        .eq("family_id", family)
        .single();
      if (!fresh.error && fresh.data)
        acceptRemote(fresh.data.payload, Number(fresh.data.version) || 0);
    };
    const channel = supabase
      .channel(`budget-state-${family}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "budget_state", filter: `family_id=eq.${family}` },
        (event) => acceptRemote(event.new?.payload, Number(event.new?.version) || 0),
      )
      .subscribe();
    const handleVisibility = () => { if (!document.hidden) void refreshRemote(); };
    window.addEventListener("focus", refreshRemote);
    document.addEventListener("visibilitychange", handleVisibility);
    const poll = window.setInterval(() => { if (!document.hidden) void refreshRemote(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshRemote);
      document.removeEventListener("visibilitychange", handleVisibility);
      void supabase.removeChannel(channel);
    };
  }, [family]);
  async function retryPendingSave() {
    if (retryingSaveRef.current) return;
    const pending = await readPendingBudgetSave();
    if (!pending || pending.family !== family) {
      setHasPendingSave(false);
      return;
    }
    retryingSaveRef.current = true;
    setRetryingSave(true);
    try {
      await save(pending.next, pending.message, pending.base);
    } finally {
      retryingSaveRef.current = false;
      setRetryingSave(false);
    }
  }
  async function save(next: BudgetData, message = "Kaydedildi", baseOverride?: BudgetData) {
    const existingPending = await readPendingBudgetSave(),
      base = existingPending?.family === family
        ? existingPending.base
        : baseOverride || dataRef.current || next,
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
        await writePendingBudgetSave({ family, base, next, message, createdAt: new Date().toISOString() });
        setHasPendingSave(true);
        setSync("Bağlantı bekleniyor");
        const isAuthErr = fresh.error.code === "PGRST301" || String(fresh.error.message).toLowerCase().includes("jwt") || String(fresh.error.message).toLowerCase().includes("auth");
        setNotice(isAuthErr
          ? "Oturumunuzun süresi doldu. Lütfen sayfayı yenileyin ve tekrar giriş yapın."
          : "Kaydedilmedi — bağlantı bekleniyor. Girişiniz bu cihazda güvenle saklandı.");
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
        await writePendingBudgetSave({ family, base, next, message, createdAt: new Date().toISOString() });
        setHasPendingSave(true);
        setSync("Kayıt çakışması");
        setNotice("Çakışma çözülemedi. Yerel kaydınız silinmedi; Tekrar dene ile yeniden gönderebilirsiniz.");
        return;
      }
      dataRef.current = merged;
      setData(merged);
      finalMessage = `${message} · Diğer cihazdaki değişikliklerle birleştirildi.`;
    }
    versionRef.current = r.data.version;
    await clearPendingBudgetSave();
    setHasPendingSave(false);
    setSync("Güncel");
    setLastSyncAt(new Date());
    setNotice(finalMessage);
  }
  if (!data) return <Center text="Aile bütçeniz yükleniyor…" loading />;
  const y = now.getUTCFullYear(),
    m = now.getUTCMonth() + 1,
    live = liveFinancial(data, data.guncel_durum, now),
    plan = exitDates(data, now),
    current =
      plan.rows.find((x: any) => x.yil === y && x.ay === m) || plan.rows.at(-1),
    cardAdvice = cardReductionAdvice(
      current,
      data.guncel_durum.yk_hesap_ozeti,
      data.haftalik_hedefler.kart,
    ),
    week = activeWeeklySummary(data, now),
    month = monthlySpendingSummary(data, now),
    savings = weeklySavings(data, now),
    cardSavings = weeklyCardSavings(data, now),
    anchorMonth = String(data.guncel_durum.tarih || "").slice(0, 7),
    currentMonthKey = dateToIso(now).slice(0, 7),
    needsMonthSync = !!anchorMonth && anchorMonth !== currentMonthKey,
    cardTargetReview = monthlyCardTargetReview(data, now),
    cardTargetApproved = !!data.kart_hedef_onaylari?.[currentMonthKey],
    todayKey = dateToIso(now),
    showCardTargetReview = (now.getUTCDate() <= 3 || now.getUTCDate() >= new Date(Date.UTC(y, m, 0)).getUTCDate() - 2) &&
      !cardTargetApproved && closedCardReviewDate !== todayKey,
    currentMonthName = new Intl.DateTimeFormat("tr-TR", {
      month: "long",
      timeZone: "UTC",
    }).format(now),
    payments = data.odemeler
      .filter((p) => activeInMonth(p, y, m))
      .sort((a, b) => num(a.odeme_gunu) - num(b.odeme_gunu));

  /** Bir ödemenin belirtilen ay/yıl için ödenip ödenmediğini kontrol eder.
   *  odendi_kayitlari VE kart_kademeli_odemeler toplamını dikkate alır. */
  function checkPaid(p: any, d: BudgetData, ty: number, tm: number): boolean {
    if (d.odendi_kayitlari[paymentKey(ty, tm, p.id)]) return true;
    if (p.kart_borc_odeme) {
      const staged = (d.kart_kademeli_odemeler || [])
        .filter((s: any) => Number(s.odeme_id) === Number(p.id) && Number(s.yil) === ty && Number(s.ay) === tm)
        .reduce((sum: number, s: any) => sum + num(s.tutar), 0);
      const planned = paymentAmount(d, p, ty, tm);
      if (Math.max(0, planned - staged) <= 0.01) return true;
    }
    return false;
  }

  const [nextY, nextM] = nextMonth(y, m),
    urgentOccurrences = [
      ...payments.map((p) => ({ p, y, m })),
      ...data.odemeler
        .filter((p) => activeInMonth(p, nextY, nextM))
        .map((p) => ({ p, y: nextY, m: nextM })),
    ],
    urgentCount = urgentOccurrences.filter(({ p, y: dueY, m: dueM }) => {
      if (checkPaid(p, data, dueY, dueM)) return false;
      const due = effectiveDay(dueY, dueM, num(p.odeme_gunu));
      const overdueThisMonth = dueY === y && dueM === m && +startOfUtcDay(due) < +startOfUtcDay(now);
      return overdueThisMonth || isWithinBusinessDays(now, due, 3);
    }).length,
    syncTime = lastSyncAt
      ? new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }).format(lastSyncAt)
      : "",
    syncLabel = sync === "Güncel" ? (syncTime ? `Son senkronizasyon: ${syncTime}` : "Güncel") : sync,
    syncMobileLabel = sync === "Güncel" ? (syncTime ? `Güncel ${syncTime}` : "Güncel") : sync;
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
  function keepCurrentCardTarget() {
    if (!window.confirm(
      `Bu ay mevcut brüt kart hedefi olan ${trMoney(cardTargetReview.currentGrossTarget)} korunacak. Onaylıyor musunuz?`,
    )) return;
    const d = normalize(data);
    d.kart_hedef_onaylari[currentMonthKey] = {
      karar: "korundu",
      hedef: cardTargetReview.currentGrossTarget,
      onay_zamani: new Date().toISOString(),
    };
    void save(d, `${currentMonthName} kart hedefi korundu`);
  }
  function openWeekly() {
    const seenKey = `${ACTIVITY_SEEN_KEY}-${family}`,
      seen = readLocalIdSet(seenKey);
    for (const item of recentActivityLog(data)) seen.add(String(item.id));
    writeLocalIdSet(seenKey, seen);
    setUnseenActivityCount(0);
    setActivityNoticeCount(0);
    setTab("harcama");
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
              onClick={() => x[0] === "harcama" ? openWeekly() : setTab(x[0])}
            >
              {x[1]}
              {x[0] === "odemeler" && urgentCount > 0 && (
                <span className="navBadge">{urgentCount}</span>
              )}
              {x[0] === "harcama" && unseenActivityCount > 0 && (
                <span className="navBadge activityBadge">{unseenActivityCount} yeni</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sync" role="status">
          <i className={sync === "Kaydediliyor" ? "syncing" : sync === "Bağlantı hatası" ? "syncErr" : ""} />
          <span className="syncText">{syncLabel}</span>
          <span className="syncTextMobile">{syncMobileLabel}</span>
          <button onClick={() => supabase.auth.signOut()}>Çıkış</button>
        </div>
      </header>
      {tab === "ozet" ? <section className="hero">
        <div className="heroTarget">
          <span>KMH&apos;DEN ÇIKIŞ HEDEFİ</span>
          <h1>{trMonth(plan.kmh)}</h1>
          {plan.kmh && (() => {
            const configuredStart = new Date(`${String(data.butce_plani.butce_baslangic_tarihi).slice(0, 10)}T00:00:00Z`);
            const startDate = isNaN(+configuredStart) ? new Date(Date.UTC(2026, 7, 17)) : configuredStart;
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
              <small>{currentMonthName} nakit hedefi {savings >= 0 ? "farkı" : "aşımı"}</small>
              <strong className={savings >= 0 ? "good" : "bad"}>{trMoney(Math.abs(savings))}</strong>
            </div>
            <div>
              <small>{currentMonthName} kart hedefi {cardSavings >= 0 ? "farkı" : "aşımı"}</small>
              <strong className={cardSavings >= 0 ? "good" : "bad"}>{trMoney(Math.abs(cardSavings))}</strong>
            </div>
          </article>
          <article>
            <small>Kayıtlar sonrası hesaplanan KMH</small>
            <strong className={live.garanti_bakiye < 0 ? "bad" : "good"}>{live.garanti_bakiye < 0 && <span className="meaningIcon" aria-label="Eksi bakiye">!</span>}{trMoney(live.garanti_bakiye)}</strong>
          </article>
          <article>
            <small>Kayıtlar sonrası hesaplanan kart borcu</small>
            <strong className={live.yk_toplam_borc > 0 ? "bad" : "good"}>{trMoney(live.yk_toplam_borc)}</strong>
          </article>
        </div>
      </section> : <section className="compactSummary" aria-label="Bütçe özeti">
        <span>KMH hedefi <b>{trMonth(plan.kmh)}</b></span>
        <span className={live.garanti_bakiye < 0 ? "bad" : "good"}>{live.garanti_bakiye < 0 && <span className="meaningIcon" aria-hidden="true">!</span>} Hesaplanan KMH {trMoney(live.garanti_bakiye)}</span>
        <span>Hesaplanan kart borcu <b>{trMoney(live.yk_toplam_borc)}</b></span>
      </section>}
      {needsMonthSync && (
        <button className="monthWarning" onClick={() => setTab("ayarlar")}>
          Yeni ay başladı! Bankadan gerçek KMH bakiyesini girin — Güncelle sekmesine tıklayın.
        </button>
      )}
      {showCardTargetReview && (
        <div className="alertBanner warn cardTargetReview" role="region" aria-labelledby="card-target-review-title">
          <div className="cardTargetReviewCopy">
            <strong id="card-target-review-title">⚠️ {currentMonthName} kart hedefini kontrol edin</strong>
            <span>
              Mevcut brüt kart hedefiniz <b>{trMoney(cardTargetReview.currentGrossTarget)}/hafta</b>;
              {" "}kullanılabilir haftalık kart limitiniz <b>{trMoney(cardTargetReview.usableWeeklyLimit)}</b>.
            </span>
            {cardTargetReview.hasTrend ? (
              <>
                <span>Gerçek kart harcama eğiliminiz <b>{trMoney(cardTargetReview.freeWeeklyTrend)}/hafta</b>.</span>
                <span>Bu eğilim devam ederse gereken brüt kart hedefi <b>{trMoney(cardTargetReview.suggestedGrossTarget)}/hafta</b>.</span>
              </>
            ) : (
              <span>Gerçek kart harcama eğilimini hesaplamak için yeterli kayıt bulunmuyor.</span>
            )}
          </div>
          <span className="alertActions">
            {cardTargetReview.hasTrend && cardTargetReview.suggestedGrossTarget !== null && (
              <button
                className="alertPrimary"
                onClick={() => {
                  setSuggestedCardTarget(cardTargetReview.suggestedGrossTarget);
                  setTab("ayarlar");
                }}
              >
                Güncelle →
              </button>
            )}
            <button onClick={keepCurrentCardTarget}>Mevcut hedefi koru</button>
            <button
              className="alertClose"
              aria-label="Kart hedefi uyarısını şimdilik kapat"
              onClick={() => {
                setClosedCardReviewDate(todayKey);
                try { localStorage.setItem("card-target-review-dismissed-date", todayKey); } catch { /* Oturum içi kapatma sürer. */ }
              }}
            >
              ×
            </button>
          </span>
        </div>
      )}
      {(sync === "Bağlantı hatası" || hasPendingSave) && (
        <div className="alertBanner danger" style={{ justifyContent: "center" }}>
          <span>{sync === "Kayıt çakışması"
            ? "Kayıt çakışması çözülemedi. Yerel değişikliğiniz bu cihazda bekliyor."
            : "Kaydedilmedi — bağlantı bekleniyor. Girdiğiniz veri bu cihazda güvenle saklandı."}</span>
          {hasPendingSave && <button className="alertPrimary" onClick={() => void retryPendingSave()} disabled={retryingSave}>
            {retryingSave ? "Gönderiliyor…" : "Tekrar dene"}
          </button>}
        </div>
      )}
      {activityNoticeCount > 0 && (
        <div className="alertBanner info activityNotice" role="status">
          <span>
            <b>{activityNoticeCount === 1 ? "Yeni harcama girişi yapıldı" : `${activityNoticeCount} yeni harcama girişi yapıldı`}</b>
            {" · "}Haftalık kayıtlar güncellendi.
          </span>
          <span className="alertActions">
            <button className="alertPrimary" onClick={openWeekly}>Haftalığa git</button>
          </span>
        </div>
      )}
      {(() => {
        const alerts: { key: string; msg: string; type: "info" | "warn" | "danger"; action?: boolean }[] = [];
        const usableWeekGoal = week.goal;
        const weekOver = week.spent.kart + week.spent.nakit > (usableWeekGoal.kart + usableWeekGoal.nakit);
        if (weekOver && !dismissedAlerts.has("week-over"))
          alerts.push({ key: "week-over", msg: "Bu haftanın harcama hedefi aşıldı.", type: "danger" });
        const monthOver = month.totalSpent > (month.goal.kart + month.goal.nakit);
        if (monthOver && !dismissedAlerts.has("month-over"))
          alerts.push({ key: "month-over", msg: "Bu ayın harcama hedefi aşıldı.", type: "danger" });
        // Maaş günü fotoğraf uyarısı
        const todayD = now.getUTCDate();
        const maasGunleri = (data.guncel_durum.gelir_parcalari || []).map((g: any) => num(g.gun));
        const bugunMaasGunu = maasGunleri.includes(todayD);
        const fotografBugün = String(data.guncel_durum.tarih || "").slice(0, 10) === dateToIso(now);
        if (bugunMaasGunu && !fotografBugün && !dismissedAlerts.has("maas-fotograf"))
          alerts.push({ key: "maas-fotograf", msg: `Bugün maaş günü (${todayD}. gün)! Bankadan KMH bakiyenizi güncelleyin — Güncelle sekmesi.`, type: "warn" });
        // checkPaid: dışarıda tanımlı, tüm ödeme kontrolleri burayı kullanır
        const overduePayments = urgentOccurrences.filter(({ p, y: dueY, m: dueM }) => {
          if (checkPaid(p, data, dueY, dueM)) return false;
          const due = effectiveDay(dueY, dueM, num(p.odeme_gunu));
          return +startOfUtcDay(due) < +startOfUtcDay(now);
        });
        const upcomingPayments = urgentOccurrences.filter(({ p, y: dueY, m: dueM }) => {
          if (checkPaid(p, data, dueY, dueM)) return false;
          return isWithinBusinessDays(now, effectiveDay(dueY, dueM, num(p.odeme_gunu)), 3);
        });
        if (overduePayments.length > 0 && !dismissedAlerts.has("overdue"))
          alerts.push({ key: "overdue", msg: `${overduePayments.length} ödemeniz gecikmiş: ${overduePayments.map(({ p }) => p.ad).join(", ")}`, type: "danger" });
        if (upcomingPayments.length > 0 && !dismissedAlerts.has("upcoming")) {
          const minWorkDays = Math.min(...upcomingPayments.map(({ p, y: dueY, m: dueM }) => businessDaysUntil(now, effectiveDay(dueY, dueM, num(p.odeme_gunu)))));
          const upcomingTotal = upcomingPayments.reduce((sum: number, { p, y: dueY, m: dueM }) => {
            const planned = paymentAmount(data, p, dueY, dueM);
            const staged = p.kart_borc_odeme ? (data.kart_kademeli_odemeler || [])
              .filter((x: any) => Number(x.odeme_id) === Number(p.id) && Number(x.yil) === dueY && Number(x.ay) === dueM)
              .reduce((s: number, x: any) => s + num(x.tutar), 0) : 0;
            return sum + Math.max(0, planned - staged);
          }, 0);
          const upcomingMsg = upcomingPayments.map(({ p, y: dueY, m: dueM }) => {
            const due = effectiveDay(dueY, dueM, num(p.odeme_gunu));
            const label = businessDueLabel(now, due);
            return `${p.ad} (${fmtShortDate(due)} · ${label})`;
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
          <WeekBox week={week} data={data} now={now} save={save} deviceId={deviceId} />
          <div className="layout">
          <Payments
            data={data}
            rows={payments}
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
              <Row
                l="Hedefe göre kartı azaltacak tahmini ek ödeme"
                v={trMoney(cardAdvice.paymentNow)}
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
            now={now}
          />
        </div>
      )}
      {tab === "harcama" && (
        <Weekly
          data={data}
          week={week}
          savings={savings}
          save={save}
        />
      )}{" "}
      {tab === "aylik" && (
        <Monthly data={data} now={now} />
      )}{" "}
      {tab === "ayarlar" && (
        <Update
          key={versionRef.current}
          data={data}
          now={now}
          save={save}
          notice={notice}
          suggestedCardTarget={suggestedCardTarget}
        />
      )}
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
  function removePaymentDependencies(d: BudgetData, paymentId: any) {
    const suffix = `-${paymentId}`;
    for (const key of Object.keys(d.aylik_tutar_override || {}))
      if (key.endsWith(suffix)) delete d.aylik_tutar_override[key];
    for (const key of Object.keys(d.odendi_kayitlari || {}))
      if (key.endsWith(suffix)) delete d.odendi_kayitlari[key];
    for (const key of Object.keys(d.gerceklesen_odemeler || {}))
      if (key.endsWith(suffix)) delete d.gerceklesen_odemeler[key];
    d.kart_kademeli_odemeler = (d.kart_kademeli_odemeler || [])
      .filter((item: any) => String(item.odeme_id) !== String(paymentId));
  }
  function doDelete(preserveRealized: boolean) {
    if (!confirmDel) return;
    const d = normalize(data);
    d.odemeler = d.odemeler.filter((x) => x.id !== confirmDel.id);
    for (const key of Object.keys(d.aylik_tutar_override || {}))
      if (key.endsWith(`-${confirmDel.id}`)) delete d.aylik_tutar_override[key];
    if (!preserveRealized) removePaymentDependencies(d, confirmDel.id);
    save(d, preserveRealized
      ? "Ödeme planı kaldırıldı; gerçekleşmiş para hareketleri korundu"
      : "Ödeme ve bağlı kayıtları silindi");
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
                baslangic_ay: `${displayY}-${String(displayM).padStart(2, "0")}`,
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
        const paymentTotals = activeRows.reduce((totals: { paid: number; pending: number }, p: any) => {
          const planned = paymentAmount(data, p, displayY, displayM),
            paymentKeyForRow = paymentKey(displayY, displayM, p.id),
            recorded = !!data.odendi_kayitlari[paymentKeyForRow],
            realized = data.gerceklesen_odemeler[paymentKeyForRow],
            staged = p.kart_borc_odeme
              ? data.kart_kademeli_odemeler
                  .filter((x: any) => Number(x.yil) === displayY && Number(x.ay) === displayM && Number(x.odeme_id) === Number(p.id))
                  .reduce((sum: number, x: any) => sum + num(x.tutar), 0)
              : 0;
          if (recorded) totals.paid += Math.max(0, realized?.tutar == null ? planned : num(realized.tutar));
          else {
            totals.paid += Math.min(planned, staged);
            totals.pending += Math.max(0, planned - staged);
          }
          return totals;
        }, { paid: 0, pending: 0 });
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
            <span>Ödenen <b className="good">{trMoney(paymentTotals.paid)}</b></span>
            <span>Bekleyen <b className={paymentTotals.pending > 0 ? "bad" : "good"}>{trMoney(paymentTotals.pending)}</b></span>
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
              <details className="rowMenu">
                <summary aria-label={`${p.ad} ödeme işlemleri`}>•••</summary>
                <span className="payActions">
                <button
                  className="ghost"
                  onClick={() =>
                    setForm({
                      ...p,
                      bu_ay_tutar: paymentAmount(data, p, displayY, displayM),
                    })
                  }
                >
                  Düzenle
                </button>
                <button className="danger" onClick={() => del(p)}>
                  Sil
                </button>
                </span>
              </details>
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
          key={form.id}
          p={form}
          set={setForm}
          cancel={() => setForm(null)}
          done={(submitted) => {
            const d = normalize(data),
              i = d.odemeler.findIndex((x) => x.id === submitted.id);
            const currentAmount = num(submitted.bu_ay_tutar),
              clean = { ...submitted };
            delete clean.bu_ay_tutar;
            // Faturalar son bilinen tutarla projekte edilir: bu ay girilen değer,
            // daha sonraki bir ayda yeni değer girilene kadar geçerli kalır.
            if (carriesForwardPaymentAmount(clean)) {
              clean.tutar = currentAmount;
              clearFuturePaymentOverrides(d, clean.id, displayY, displayM);
            }
            if (i < 0) {
              clean.tutar = num(clean.tutar || currentAmount);
              d.odemeler.push(clean);
              if (currentAmount !== num(clean.tutar))
                d.aylik_tutar_override[paymentKey(displayY, displayM, clean.id)] =
                  currentAmount;
            } else {
              d.odemeler[i] = clean;
              d.aylik_tutar_override[paymentKey(displayY, displayM, clean.id)] =
                currentAmount;
              if (!carriesForwardPaymentAmount(clean)) {
                const [ny, nm] = nextMonth(displayY, displayM),
                  nextKey = paymentKey(ny, nm, clean.id);
                if (!(nextKey in d.aylik_tutar_override))
                  d.aylik_tutar_override[nextKey] = num(clean.tutar);
              }
            }
            save(d, "Ödeme kaydedildi");
            setForm(null);
          }}
        />
      )}
      {confirmDel && (
        <div className="modalOverlay">
          <div className="modalBox" role="dialog" aria-modal="true" aria-labelledby="deletePaymentTitle">
            <div className="modalHeader">
              <h3 id="deletePaymentTitle">Ödemeyi sil</h3>
              <button className="ghost" onClick={() => setConfirmDel(null)}>✕</button>
            </div>
            <p style={{ margin: "0 0 20px", color: "var(--muted)" }}>
              <b style={{ color: "var(--ink)" }}>{confirmDel.ad}</b> için gelecek planı kaldırabilirsiniz. Gerçekleşmiş kayıtları da silmek canlı KMH/kart hesabını değiştirebilir.
            </p>
            <div className="actions">
              <button className="ghost" onClick={() => doDelete(true)}>Planı kaldır, geçmişi koru</button>
              <button className="danger" onClick={() => doDelete(false)}>Her şeyi sil</button>
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
  done: (value: any) => void;
}) {
  // Raw string states for decimal inputs
  const [rawBuAy, setRawBuAy] = useState(String(p.bu_ay_tutar ?? p.tutar ?? 0));
  const [rawTutar, setRawTutar] = useState(String(p.tutar ?? 0));
  const [rawGun, setRawGun] = useState(String(p.odeme_gunu ?? ""));
  const [rawTaksit, setRawTaksit] = useState(String(p.taksit_sayisi ?? "")),
    [errors, setErrors] = useState<Record<string, string>>({});
  const mobileHistoryRef = useRef(false);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 820px)").matches) return;
    const body = document.body,
      previousOverflow = body.style.overflow,
      handleBack = () => {
        mobileHistoryRef.current = false;
        cancel();
      };
    window.history.pushState({ ...(window.history.state || {}), butceOdemeFormu: true }, "");
    mobileHistoryRef.current = true;
    body.style.overflow = "hidden";
    window.addEventListener("popstate", handleBack);
    return () => {
      window.removeEventListener("popstate", handleBack);
      body.style.overflow = previousOverflow;
    };
  }, []);

  function closeMobileHistory() {
    if (!mobileHistoryRef.current) return;
    mobileHistoryRef.current = false;
    window.history.back();
  }
  function cancelForm() {
    closeMobileHistory();
    cancel();
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
  function submit() {
    const nextErrors: Record<string, string> = {},
      name = String(p.ad || "").trim(),
      currentAmount = parseTrMoney(rawBuAy),
      normalAmount = parseTrMoney(rawTutar),
      day = Number(rawGun),
      installmentCount = rawTaksit.trim() === "" ? 0 : Number(rawTaksit);
    if (!name) nextErrors.ad = "Ödeme adı zorunludur.";
    if (currentAmount === null || currentAmount < 0)
      nextErrors.buAy = "Tutar sıfır veya daha büyük olmalıdır.";
    if (p.tur !== "taksit" && !carriesForwardPaymentAmount(p) && (normalAmount === null || normalAmount < 0))
      nextErrors.tutar = "Sonraki ayların tutarı sıfır veya daha büyük olmalıdır.";
    if (!Number.isInteger(day) || day < 1 || day > 31)
      nextErrors.gun = "Ödeme günü 1 ile 31 arasında olmalıdır.";
    if (!Number.isInteger(installmentCount) || installmentCount < 0)
      nextErrors.taksit = "Taksit sayısı pozitif bir tam sayı olmalıdır.";
    if (installmentCount > 0 && !p.baslangic_ay)
      nextErrors.baslangic = "Taksitli ödeme için başlangıç ayı seçilmelidir.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const clean = {
      ...p,
      ad: name,
      bu_ay_tutar: currentAmount,
      odeme_gunu: day,
      taksit_sayisi: installmentCount,
    };
    if (p.tur === "taksit" || carriesForwardPaymentAmount(p)) clean.tutar = currentAmount;
    else clean.tutar = normalAmount;
    if (installmentCount > 0 && clean.baslangic_ay) {
      const [y, m] = clean.baslangic_ay.split("-").map(Number),
        end = new Date(y, m - 1 + installmentCount - 1);
      clean.bitis_ay = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}`;
    } else delete clean.bitis_ay;
    closeMobileHistory();
    done(clean);
  }
  return (
    <div className="editor paymentEditor" role="dialog" aria-labelledby="paymentEditorTitle">
      <div className="paymentEditorMobileHeader">
        <button className="ghost" onClick={cancelForm}>← Vazgeç</button>
        <h3 id="paymentEditorTitle">Ödeme bilgisi</h3>
        <span aria-hidden="true" />
      </div>
      <h3 className="paymentEditorDesktopTitle">Ödeme bilgisi</h3>
      <div className="formGrid">
        <label>
          Ad
          <input
            value={p.ad || ""}
            onChange={(e) => set({ ...p, ad: e.target.value })}
            aria-invalid={!!errors.ad}
            aria-describedby={errors.ad ? "payment-name-error" : undefined}
          />
          {errors.ad && <small className="fieldError" id="payment-name-error">{errors.ad}</small>}
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
          {p.tur === "taksit"
            ? "Taksit tutarı"
            : carriesForwardPaymentAmount(p)
              ? "Bu aydan itibaren tutar"
              : "Bu ayın tutarı"}
          <input
            type="text"
            inputMode="decimal"
            value={rawBuAy}
            onChange={(e) => setRawBuAy(e.target.value)}
            onBlur={() => {
              const parsed = parseTrMoney(rawBuAy);
              if (parsed === null) return;
              const v = parsed;
              setRawBuAy(String(v));
              set(p.tur === "taksit" || carriesForwardPaymentAmount(p)
                ? { ...p, tutar: v, bu_ay_tutar: v }
                : { ...p, bu_ay_tutar: v });
            }}
            onFocus={(e) => e.target.select()}
            aria-invalid={!!errors.buAy}
            aria-describedby={errors.buAy ? "payment-current-amount-error" : undefined}
          />
          {errors.buAy && <small className="fieldError" id="payment-current-amount-error">{errors.buAy}</small>}
        </label>
        {p.tur !== "taksit" && !carriesForwardPaymentAmount(p) && (
          <label>
            Sonraki ayların normal tutarı
            <input
              type="text"
              inputMode="decimal"
              value={rawTutar}
              onChange={(e) => setRawTutar(e.target.value)}
              onBlur={() => {
                const parsed = parseTrMoney(rawTutar);
                if (parsed === null) return;
                const v = parsed;
                setRawTutar(String(v));
                set({ ...p, tutar: v });
              }}
              onFocus={(e) => e.target.select()}
              aria-invalid={!!errors.tutar}
              aria-describedby={errors.tutar ? "payment-normal-amount-error" : undefined}
            />
            {errors.tutar && <small className="fieldError" id="payment-normal-amount-error">{errors.tutar}</small>}
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
              const parsed = parseTrMoney(rawGun);
              if (parsed === null) return;
              const v = parsed;
              setRawGun(String(v));
              set({ ...p, odeme_gunu: v });
            }}
            onFocus={(e) => e.target.select()}
            aria-invalid={!!errors.gun}
            aria-describedby={errors.gun ? "payment-day-error" : undefined}
          />
          {errors.gun && <small className="fieldError" id="payment-day-error">{errors.gun}</small>}
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
            aria-invalid={!!errors.baslangic}
            aria-describedby={errors.baslangic ? "payment-start-error" : undefined}
          />
          {errors.baslangic && <small className="fieldError" id="payment-start-error">{errors.baslangic}</small>}
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
              const parsed = parseTrMoney(rawTaksit);
              if (parsed === null) return;
              const v = parsed;
              setRawTaksit(v > 0 ? String(v) : "");
              setTaksitSayisi(v);
            }}
            onFocus={(e) => e.target.select()}
            aria-invalid={!!errors.taksit}
            aria-describedby={errors.taksit ? "payment-installment-error" : undefined}
          />
          {errors.taksit && <small className="fieldError" id="payment-installment-error">{errors.taksit}</small>}
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
        <button className="primary" onClick={submit}>
          Kaydet
        </button>
        <button className="ghost" onClick={cancelForm}>
          Vazgeç
        </button>
      </div>
    </div>
  );
}

function WeekBox({
  week,
  data,
  now,
  save,
  deviceId,
}: {
  week: any;
  data: BudgetData;
  now: Date;
  save: Save;
  deviceId: string;
}) {
  const [type, setType] = useState<"kart" | "nakit">("kart"),
    [amount, setAmount] = useState(""),
    [desc, setDesc] = useState(""),
    [mobileEntryOpen, setMobileEntryOpen] = useState(false),
    [savingExpense, setSavingExpense] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null),
    mobileAmountRef = useRef<HTMLInputElement>(null),
    mobileDescRef = useRef<HTMLInputElement>(null),
    scrollPositionRef = useRef(0),
    mobileHistoryEntryRef = useRef(false);

  useEffect(() => {
    if (!mobileEntryOpen) return;
    scrollPositionRef.current = window.scrollY;
    const body = document.body,
      previous = {
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
        overflow: body.style.overflow,
      },
      viewport = window.visualViewport,
      handleBrowserBack = () => {
        mobileHistoryEntryRef.current = false;
        setAmount("");
        setDesc("");
        setMobileEntryOpen(false);
      },
      updateViewport = () => {
        document.documentElement.style.setProperty(
          "--expense-viewport-height",
          `${viewport?.height || window.innerHeight}px`,
        );
        document.documentElement.style.setProperty(
          "--expense-viewport-top",
          `${viewport?.offsetTop || 0}px`,
        );
      };
    updateViewport();
    body.style.position = "fixed";
    body.style.top = `-${scrollPositionRef.current}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("popstate", handleBrowserBack);
    const focusTimer = window.setTimeout(() => mobileAmountRef.current?.focus(), 120);
    return () => {
      window.clearTimeout(focusTimer);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("popstate", handleBrowserBack);
      document.documentElement.style.removeProperty("--expense-viewport-height");
      document.documentElement.style.removeProperty("--expense-viewport-top");
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      window.scrollTo(0, scrollPositionRef.current);
    };
  }, [mobileEntryOpen]);

  const g = week.goal,
    r = g.kart + g.nakit - week.spent.kart - week.spent.nakit,
    baseCardGoal = num(data.haftalik_hedefler.kart),
    fixedCardReserved = Math.max(0, baseCardGoal - week.goal.kart),
    wallet = walletState(data);

  const wk = dateToIso(week.start),
    advanced = +week.start > +now;

  function selectType(t: "kart" | "nakit") {
    setType(t);
    window.localStorage.setItem("butce-son-harcama-turu", t);
  }

  function openMobileEntry() {
    if (mobileEntryOpen) return;
    const remembered = window.localStorage.getItem("butce-son-harcama-turu");
    if (remembered === "kart" || remembered === "nakit") setType(remembered);
    window.history.pushState(
      { ...(window.history.state || {}), butceHarcamaGir: true },
      "",
    );
    mobileHistoryEntryRef.current = true;
    setMobileEntryOpen(true);
  }

  function closeMobileEntry() {
    setAmount("");
    setDesc("");
    setMobileEntryOpen(false);
    if (mobileHistoryEntryRef.current) {
      mobileHistoryEntryRef.current = false;
      window.history.back();
    }
  }

  async function add(closeMobile = false) {
    const v = parseTrMoney(amount) ?? 0;
    if (v <= 0 || v > 100_000 || savingExpense) return;
    setSavingExpense(true);
    const d = normalize(data),
      expenseId = newId(),
      createdAt = new Date().toISOString();
    pruneActivityLog(d);
    d.haftalik_harcamalar.push({
      id: expenseId,
      tarih: dateToIso(now),
      butce_haftasi: wk,
      tur: type,
      tutar: v,
      aciklama: desc,
      olusturma_zamani: createdAt,
      ...(type === "nakit" && wallet.aktif ? { cuzdan_takibine_dahil: true } : {}),
    });
    d.hareket_gunlugu.push({
      id: `harcama-${expenseId}`,
      tur: "harcama_eklendi",
      harcama_id: expenseId,
      kaynak_cihaz_id: deviceId,
      olusturma_zamani: createdAt,
    });
    let message = advanced
      ? `${trMoney(v)} ${type === "kart" ? "kart" : "nakit"} harcaması yeni takip haftasına eklendi`
      : `${trMoney(v)} ${type === "kart" ? "kart" : "nakit"} harcaması eklendi`;
    if (type === "nakit" && wallet.aktif) {
      const nextWallet = walletState(d),
        allocation = nextWallet.allocations.get(String(expenseId));
      if (allocation && allocation.cuzdan > 0 && allocation.kmh > 0)
        message = `${trMoney(v)} kaydedildi: ${trMoney(allocation.cuzdan)} cüzdandan, ${trMoney(allocation.kmh)} KMH’den karşılandı`;
      else if (allocation && allocation.cuzdan > 0)
        message = `${trMoney(v)} cüzdandan karşılandı; cüzdanda ${trMoney(nextWallet.bakiye)} kaldı`;
      else if (allocation)
        message = `${trMoney(v)} KMH’den karşılandı; cüzdan bakiyesi sıfır`;
    }
    await save(d, message);
    setAmount("");
    setDesc("");
    setSavingExpense(false);
    if (closeMobile) closeMobileEntry();
  }

  return (
    <section className="panel">
      <button className="mobileExpenseLauncher" onClick={openMobileEntry}>
        <span aria-hidden="true">＋</span> Harcama gir
      </button>
      <div className="inlineExpenseForm desktopExpenseForm">
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
        {type === "nakit" && wallet.aktif && (
          <p className="walletHint">Cüzdanda {trMoney(wallet.bakiye)} var; yetmeyen kısım otomatik KMH’ye geçer.</p>
        )}
        <input
          ref={amountRef}
          type="text"
          inputMode="decimal"
          className="expenseInput"
          placeholder="Tutar (₺)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <input
          type="text"
          className="expenseInput"
          placeholder="Açıklama (opsiyonel)"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button
          className="expenseAddBtn"
          onClick={() => void add()}
          disabled={(parseTrMoney(amount) ?? 0) <= 0 || savingExpense}
        >
          {savingExpense ? "Kaydediliyor…" : "Ekle"}
        </button>
      </div>
      {mobileEntryOpen && (
        <div
          className="mobileExpenseOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobileExpenseTitle"
        >
          <header className="mobileExpenseHeader">
            <button onClick={closeMobileEntry} disabled={savingExpense}>
              ← Vazgeç
            </button>
            <h2 id="mobileExpenseTitle">Harcama gir</h2>
            <span aria-hidden="true" />
          </header>
          <div className="mobileExpenseBody">
            <div className="expenseTypeButtons" aria-label="Harcama türü">
              <button
                className={type === "kart" ? "expenseTypeSelected" : "expenseTypeIdle"}
                onClick={() => selectType("kart")}
                aria-pressed={type === "kart"}
              >
                <span className="uiIcon" aria-hidden="true">K</span> Kart
              </button>
              <button
                className={type === "nakit" ? "expenseTypeSelected" : "expenseTypeIdle"}
                onClick={() => selectType("nakit")}
                aria-pressed={type === "nakit"}
              >
                <span className="uiIcon" aria-hidden="true">N</span> Nakit
              </button>
            </div>
            {type === "nakit" && wallet.aktif && (
              <p className="walletHint">Cüzdanda {trMoney(wallet.bakiye)} var; yetmeyen kısım otomatik KMH’ye geçer.</p>
            )}
            <label className="mobileExpenseField">
              <span>Tutar</span>
              <input
                ref={mobileAmountRef}
                type="text"
                inputMode="decimal"
                enterKeyHint="next"
                placeholder="0,00 TL"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    mobileDescRef.current?.focus();
                  }
                }}
              />
            </label>
            <label className="mobileExpenseField">
              <span>Açıklama <small>(isteğe bağlı)</small></span>
              <input
                ref={mobileDescRef}
                type="text"
                enterKeyHint="done"
                placeholder="Örn. Market"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void add(true);
                  }
                }}
              />
            </label>
          </div>
          <footer className="mobileExpenseFooter">
            <button
              className="expenseAddBtn"
              onClick={() => void add(true)}
              disabled={(parseTrMoney(amount) ?? 0) <= 0 || savingExpense}
            >
              {savingExpense ? "Kaydediliyor…" : "Harcamayı kaydet"}
            </button>
          </footer>
        </div>
      )}
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
      {fixedCardReserved > 0.01 && (
        <p className="goalExplanation">
          Ana kart hedefi {trMoney(baseCardGoal)}
          {fixedCardReserved > 0.01 && <> · sabit kart ödemelerine ayrılan {trMoney(fixedCardReserved)}</>}
          {" · "}bu hafta kullanılabilir {trMoney(g.kart)}
        </p>
      )}
      <div className={r >= 0 ? "weekTotal good" : "weekTotal bad"}>
        <span>
          {r >= 0 ? "Kullanılabilir bütçe" : "Kullanılabilir bütçe aşıldı"}
        </span>
        <b>{r >= 0 ? `${trMoney(r)} kalan` : `${trMoney(Math.abs(r))} aşım`}</b>
      </div>
    </section>
  );
}
function Weekly({
  data,
  week,
  savings,
  save,
}: {
  data: BudgetData;
  week: any;
  savings: number;
  save: Save;
}) {
  const [editingId, setEditingId] = useState<number | null>(null),
    [editDraft, setEditDraft] = useState<{ tutar: string; aciklama: string }>({ tutar: "", aciklama: "" }),
    [confirmDelete, setConfirmDelete] = useState<any>(null);
  const goals = week.goal,
    baseCardGoal = num(data.haftalik_hedefler.kart),
    fixedCardReserved = Math.max(0, baseCardGoal - week.goal.kart),
    groupedRecords = Object.entries(
      week.records.reduce((groups: Record<string, any[]>, record: any) => {
        (groups[record.tarih] ||= []).push(record);
        return groups;
      }, {}),
    ).sort(([a], [b]) => b.localeCompare(a));
  function removeConfirmed() {
    if (!confirmDelete) return;
    const d = normalize(data);
    d.haftalik_harcamalar = d.haftalik_harcamalar.filter((x) => x.id !== confirmDelete.id);
    save(d, "Harcama silindi");
    setConfirmDelete(null);
  }
  function startEdit(r: any) {
    setEditingId(r.id);
    setEditDraft({ tutar: String(r.tutar), aciklama: r.aciklama || "" });
  }
  function commitEdit(r: any) {
    const v = parseTrMoney(editDraft.tutar) ?? 0;
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
  return (
    <div className="weeklyPage single">
      <section className="panel weekly">
        <div className="panelTitle noPad">
          <div>
            <h2>Bu haftanın harcama detayı</h2>
            <p>{fmtShortDate(week.start)} – {fmtShortDate(week.end)}</p>
          </div>
          <span className="badge amber">Açık</span>
        </div>
        <div className="weekSummaryBar">
          <span>Kart <b>{trMoney(week.spent.kart)}</b> / {trMoney(goals.kart)}</span>
          <span>Nakit <b>{trMoney(week.spent.nakit)}</b> / {trMoney(goals.nakit)}</span>
          <span className={savings >= 0 ? "good" : "bad"}>
            {savings >= 0 ? "Birikimli nakit hedefi farkı" : "Birikimli nakit hedefi aşımı"} <b>{trMoney(Math.abs(savings))}</b>
          </span>
        </div>
        {fixedCardReserved > 0.01 && (
          <p className="goalExplanation">
            Ana kart hedefi {trMoney(baseCardGoal)}
            {fixedCardReserved > 0.01 && <> · sabit kart ödemelerine ayrılan {trMoney(fixedCardReserved)}</>}
            {" · "}bu hafta kullanılabilir {trMoney(goals.kart)}
          </p>
        )}
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
                    inputMode="decimal"
                    placeholder="Tutar"
                    value={editDraft.tutar}
                    onChange={(e) => setEditDraft({ ...editDraft, tutar: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(r);
                      if (e.key === "Escape") cancelEdit();
                    }}
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
                  <details className="rowMenu">
                    <summary aria-label={`${r.aciklama || "Harcama"} işlemleri`}>•••</summary>
                    <span className="payActions">
                      <button className="ghost" onClick={() => startEdit(r)}>Düzenle</button>
                      <button className="danger" onClick={() => setConfirmDelete(r)}>Sil</button>
                    </span>
                  </details>
                </>
              )}
            </article>
            ))}
          </section>)}
          {!week.records.length && (
            <div className="empty">Bu hafta henüz harcama yok.</div>
          )}
        </div>
        {confirmDelete && (
          <div className="modalOverlay">
            <div className="modalBox" role="dialog" aria-modal="true" aria-labelledby="deleteExpenseTitle">
              <div className="modalHeader">
                <h3 id="deleteExpenseTitle">Harcamayı sil</h3>
                <button className="ghost" onClick={() => setConfirmDelete(null)}>✕</button>
              </div>
              <p style={{ margin: "0 0 20px", color: "var(--muted)" }}>
                <b style={{ color: "var(--ink)" }}>{confirmDelete.aciklama || "Açıklama yok"} · {trMoney(confirmDelete.tutar)}</b> kalıcı olarak silinecek. Emin misiniz?
              </p>
              <div className="actions">
                <button className="danger" onClick={removeConfirmed}>Evet, sil</button>
                <button className="ghost" onClick={() => setConfirmDelete(null)}>Vazgeç</button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Update({
  data,
  now,
  save,
  notice,
  suggestedCardTarget,
}: {
  data: BudgetData;
  now: Date;
  save: Save;
  notice: string;
  suggestedCardTarget: number | null;
}) {
  const [g, setG] = useState({ ...data.guncel_durum });
  const [kart, setKart] = useState({
    yk_toplam_borc: num(data.guncel_durum.yk_toplam_borc),
    yk_kullanilabilir: num(data.guncel_durum.yk_kullanilabilir),
    yk_limit: num(data.guncel_durum.yk_limit),
  });
  const [ekstre, setEkstre] = useState<any>({
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
  const [maasForm, setMaasForm] = useState<any>(null),
    [walletForm, setWalletForm] = useState<null | { type: "withdraw" | "adjust"; amount: number }>(null),
    [savingWallet, setSavingWallet] = useState(false),
    [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});
  const milatSource = String(data.butce_plani.butce_baslangic_tarihi || "").slice(0, 10);
  const [milatDraft, setMilatDraft] = useState({ source: milatSource, value: milatSource });
  const milatTarihi = milatDraft.source === milatSource ? milatDraft.value : milatSource;
  const wallet = walletState(data);

  async function activateWallet() {
    if (savingWallet || wallet.aktif) return;
    setSavingWallet(true);
    const d = normalize(data);
    enableWallet(d);
    await save(d, "Cüzdan takibi açıldı; henüz nakit hareketi eklenmedi");
    setSavingWallet(false);
  }

  async function saveWalletMovement() {
    if (!walletForm || savingWallet) return;
    const amount = num(walletForm.amount);
    if (amount < 0 || (walletForm.type === "withdraw" && amount <= 0)) {
      setUpdateErrors({ wallet: walletForm.type === "withdraw"
        ? "Çekilen nakit sıfırdan büyük olmalıdır."
        : "Cüzdan bakiyesi negatif olamaz." });
      return;
    }
    setUpdateErrors({});
    setSavingWallet(true);
    const d = normalize(data),
      createdAt = new Date().toISOString(),
      common = { id: newId(), tarih: dateToIso(now), olusturma_zamani: createdAt };
    const saved = walletForm.type === "withdraw"
      ? recordWalletWithdrawal(d, { ...common, tutar: amount })
      : recordWalletCorrection(d, { ...common, bakiye: amount });
    if (saved) await save(d, walletForm.type === "withdraw"
      ? `${trMoney(amount)} cüzdana eklendi ve KMH hesabına yansıtıldı`
      : `Cüzdan bakiyesi ${trMoney(amount)} olarak düzeltildi`);
    setWalletForm(null);
    setSavingWallet(false);
  }

  function sync() {
    if (!Number.isFinite(Number(g.garanti_bakiye))) {
      setUpdateErrors({ garanti: "KMH bakiyesi geçerli bir tutar olmalıdır." });
      return;
    }
    setUpdateErrors({});
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tarih)) {
      setUpdateErrors({ milat: "Geçerli bir başlangıç tarihi seçin." });
      return;
    }
    setUpdateErrors({});
    const d = normalize(data);
    d.butce_plani.butce_baslangic_tarihi = tarih;
    save(d, "Bütçe başlangıç tarihi güncellendi");
  }
  function syncKart() {
    const debt = num(kart.yk_toplam_borc), available = num(kart.yk_kullanilabilir), limit = num(kart.yk_limit),
      periodDebt = num(ekstre.donem_borcu), minimum = num(ekstre.asgari_tutar), paid = num(ekstre.odenen_tutar);
    if (debt < 0 || available < 0 || limit <= 0) {
      setUpdateErrors({ kart: "Kart borcu ve kullanılabilir limit negatif olamaz; toplam limit sıfırdan büyük olmalıdır." });
      return;
    }
    if (debt + available > limit + 0.01) {
      setUpdateErrors({ kart: "Kart borcu ile kullanılabilir limit toplamı, kart limitini aşamaz." });
      return;
    }
    if (!ekstre.hesap_kesim_tarihi || periodDebt < 0 || minimum < 0 || paid < 0) {
      setUpdateErrors({ kart: "Hesap kesim tarihi zorunludur; ekstre tutarları negatif olamaz." });
      return;
    }
    if (minimum > periodDebt) {
      setUpdateErrors({ kart: "Asgari ödeme dönem borcundan büyük olamaz." });
      return;
    }
    if (paid + 0.005 < minimum) {
      setUpdateErrors({ kart: "Gerçek ödenen tutar asgari ödeme tutarından az olamaz." });
      return;
    }
    setUpdateErrors({});
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
        odenen_tutar: paid,
        akdi_faiz_orani: faiz.contractualRate,
        vergi_orani: faiz.taxRate,
      },
    };
    save(d, "YK kart ve hesap özeti güncellendi");
  }
  function setEkstreKesimTarihi(value: string) {
    setEkstre({
      ...ekstre,
      hesap_kesim_tarihi: value,
      son_odeme_tarihi: shiftIsoDate(value, 10),
      sonraki_hesap_kesim_tarihi: shiftIsoDate(value, 30),
      odeme_tarihi: "",
      kalan_donem_borcu: "",
      donem_faizi: 0,
      yillik_kart_ucreti: 0,
    });
  }
  function saveHedefler() {
    if (!Number.isFinite(kartHedef) || !Number.isFinite(nakitHedef) || kartHedef <= 0 || nakitHedef <= 0) {
      setUpdateErrors({ hedef: "Haftalık kart ve nakit hedefleri sıfırdan büyük olmalıdır." });
      return;
    }
    setUpdateErrors({});
    const d = normalize(data);
    const kartHedefiDegisti = Math.abs(num(data.haftalik_hedefler.kart) - kartHedef) > 0.005;
    d.haftalik_hedefler.kart = kartHedef;
    d.haftalik_hedefler.nakit = nakitHedef;
    if (kartHedefiDegisti) {
      const currentMonthKey = dateToIso(now).slice(0, 7);
      d.kart_hedef_onaylari[currentMonthKey] = {
        karar: "guncellendi",
        hedef: kartHedef,
        onay_zamani: new Date().toISOString(),
      };
    }
    save(d, "Haftalık hedefler güncellendi");
  }

  function saveMaas(form: any) {
    if (!/^\d{4}-\d{2}$/.test(String(form.baslangic_ay || "")) || num(form.tutar) <= 0) {
      setUpdateErrors({ maas: "Başlangıç ayını seçin ve sıfırdan büyük bir gelir girin." });
      return;
    }
    setUpdateErrors({});
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
    if (!window.confirm(`${ay} başlangıçlı maaş dönemini silmek istediğinize emin misiniz? KMH tahmini değişebilir.`)) return;
    const d = normalize(data);
    d.ayarlar.maas_takvimi = (d.ayarlar.maas_takvimi || []).filter((q: any) => q.baslangic_ay !== ay);
    save(d, "Maaş takvimi satırı silindi");
  }

  const ekstreFaiz = cardStatementInterest(ekstre, data.ayarlar);
  return (
    <div className="single updateGrid">
      <details className="panel updatePanel" open>
        <summary><span className="uiIcon" aria-hidden="true">₺</span><span><b>Garanti / KMH bakiyesi</b><small>Bankadan girilen bakiye: {trMoney(g.garanti_bakiye)}</small></span></summary>
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
        {updateErrors.garanti && <small className="fieldError formError">{updateErrors.garanti}</small>}
        {notice && <span className="saveFeedback" role="status">✓ {notice}</span>}
        <section className="walletManager" aria-labelledby="walletManagerTitle">
          <div className="walletManagerHeader">
            <div>
              <h3 id="walletManagerTitle">Cüzdandaki nakit</h3>
              <p>Bankadan çekilmiş fakat henüz harcanmamış para.</p>
            </div>
            <strong>{trMoney(wallet.bakiye)}</strong>
          </div>
          {!wallet.aktif ? (
            <>
              <p className="helperText">
                Takibi açmak bakiyeleri değiştirmez. Açtıktan sonra “Nakit çektim” ile çekilen tutarı kaydedebilirsiniz.
              </p>
              <button className="secondary" disabled={savingWallet} onClick={activateWallet}>
                {savingWallet ? "Açılıyor…" : "Cüzdan takibini aç"}
              </button>
            </>
          ) : (
            <>
              <div className="walletActions">
                <button className="secondary" onClick={() => setWalletForm({ type: "withdraw", amount: 0 })}>
                  Nakit çektim
                </button>
                <button className="ghost" onClick={() => setWalletForm({ type: "adjust", amount: wallet.bakiye })}>
                  Bakiyeyi düzelt
                </button>
              </div>
              {walletForm && (
                <div className="walletEditor">
                  <div className="formGrid">
                    <Field
                      l={walletForm.type === "withdraw" ? "Çekilen nakit" : "Gerçek cüzdan bakiyesi"}
                      v={walletForm.amount}
                      set={(amount) => setWalletForm({ ...walletForm, amount })}
                    />
                  </div>
                  <p className="helperText">
                    {walletForm.type === "withdraw"
                      ? "Bu tutar cüzdana eklenir ve hesaplanan KMH’yi aynı tutarda azaltır."
                      : "Yalnız cüzdan sayımı düzeltilir; KMH bakiyesi değişmez."}
                  </p>
                  <div className="actions">
                    <button className="primary" disabled={savingWallet} onClick={saveWalletMovement}>
                      {savingWallet ? "Kaydediliyor…" : "Kaydet"}
                    </button>
                    <button className="ghost" disabled={savingWallet} onClick={() => setWalletForm(null)}>Vazgeç</button>
                  </div>
                </div>
              )}
              {updateErrors.wallet && <small className="fieldError formError">{updateErrors.wallet}</small>}
            </>
          )}
        </section>
        <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <label htmlFor="milatInput" style={{ fontSize: "0.8rem", color: "var(--muted)", display: "block", marginBottom: 6 }}>
            Nakit birikim milat tarihi
          </label>
          <input
            type="date"
            value={milatTarihi}
            onChange={(event) => setMilatDraft({ source: milatSource, value: event.target.value })}
            style={{ padding: "8px 12px", border: "1.5px solid var(--line)", borderRadius: 8, fontSize: "1rem", marginRight: 10 }}
            id="milatInput"
          />
          <button
            className="secondary"
            onClick={() => {
              if (milatTarihi) saveMilat(milatTarihi);
            }}
          >
            Kaydet
          </button>
          {updateErrors.milat && <small className="fieldError formError">{updateErrors.milat}</small>}
        </div>
        </div>
      </details>

      <details className="panel updatePanel">
        <summary><span className="uiIcon" aria-hidden="true">K</span><span><b>Yapı Kredi kart durumu</b><small>Bankadan girilen borç: {trMoney(kart.yk_toplam_borc)}</small></span></summary>
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
            Her ay yalnız bu dört alanı girin. Diğer tarihler ve kalan borç otomatik hesaplanır.
          </p>
          <div className="formGrid">
            <DateField l="Hesap kesim tarihi" v={ekstre.hesap_kesim_tarihi} set={setEkstreKesimTarihi} />
            <Field l="Dönem borcu" v={ekstre.donem_borcu} set={(v) => setEkstre({ ...ekstre, donem_borcu: v })} />
            <Field l="Asgari ödeme tutarı" v={ekstre.asgari_tutar} set={(v) => setEkstre({ ...ekstre, asgari_tutar: v })} />
            <Field l="Gerçek ödenen tutar (en az asgari)" v={ekstre.odenen_tutar} set={(v) => setEkstre({ ...ekstre, odenen_tutar: v })} />
          </div>
          <details className="advancedStatement">
            <summary>Ek bilgiler (isteğe bağlı)</summary>
            <p className="helperText">Yalnız bankadaki tarih veya kalan borç otomatik değerden farklıysa değiştirin.</p>
            <div className="formGrid">
              <DateField l="Son ödeme tarihi" v={ekstre.son_odeme_tarihi} set={(v) => setEkstre({ ...ekstre, son_odeme_tarihi: v })} />
              <DateField l="Sonraki hesap kesim tarihi" v={ekstre.sonraki_hesap_kesim_tarihi} set={(v) => setEkstre({ ...ekstre, sonraki_hesap_kesim_tarihi: v })} />
              <DateField l="Ödemenin karta yansıdığı tarih" v={ekstre.odeme_tarihi} set={(v) => setEkstre({ ...ekstre, odeme_tarihi: v })} />
              <Field l="Bankada görünen kalan ekstre" v={ekstre.kalan_donem_borcu} set={(v) => setEkstre({ ...ekstre, kalan_donem_borcu: v })} />
              <Field l="Ekstredeki dönem faizi" v={ekstre.donem_faizi} set={(v) => setEkstre({ ...ekstre, donem_faizi: v })} />
              <Field l="Yıllık kart ücreti" v={ekstre.yillik_kart_ucreti} set={(v) => setEkstre({ ...ekstre, yillik_kart_ucreti: v })} />
            </div>
          </details>
          {ekstreFaiz.valid && (
            <div className="statementResult" role="status">
              <div className={ekstreFaiz.minimumMet && ekstreFaiz.paymentOnTime ? "good" : "bad"}>
                <b>{ekstreFaiz.minimumMet && ekstreFaiz.paymentOnTime ? "Asgari ödeme zamanında tamamlandı" : "Asgari ödeme eksik veya geç"}</b>
              </div>
              <span>Hesaba alınan gerçek ödeme <b>{trMoney(num(ekstre.odenen_tutar))}</b></span>
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
        {updateErrors.kart && <small className="fieldError formError">{updateErrors.kart}</small>}
        {notice && <span className="saveFeedback" role="status">✓ {notice}</span>}
        </div>
      </details>

      <details className="panel updatePanel">
        <summary><span className="uiIcon" aria-hidden="true">H</span><span><b>Haftalık harcama hedefleri</b><small>{trMoney(kartHedef + nakitHedef)} toplam</small></span></summary>
        <div className="updatePanelBody">
        <p style={{ fontSize: "0.8rem", color: "var(--muted)", margin: "0 0 12px" }}>
          KMH çıkış tarihi ve nakit birikim hesabını etkiler.
        </p>
        {suggestedCardTarget !== null && (
          <div className="targetSuggestion">
            <span>
              Mevcut hedef <b>{trMoney(data.haftalik_hedefler.kart)}</b> · davranışa göre hesaplanan hedef{" "}
              <b>{trMoney(suggestedCardTarget)}</b>
            </span>
            <button className="secondary" onClick={() => setKartHedef(suggestedCardTarget)}>
              Önerilen değeri al
            </button>
          </div>
        )}
        <div className="formGrid">
          <Field l="Haftalık kart tavanı" v={kartHedef} set={setKartHedef} />
          <Field l="Haftalık nakit / KMH" v={nakitHedef} set={setNakitHedef} />
        </div>
        <button className="primary" style={{ marginTop: 12 }} onClick={saveHedefler}>
          Hedefleri kaydet
        </button>
        {updateErrors.hedef && <small className="fieldError formError">{updateErrors.hedef}</small>}
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
            {updateErrors.maas && <small className="fieldError formError">{updateErrors.maas}</small>}
          </div>
        )}
        {notice && <span className="saveFeedback" role="status">✓ {notice}</span>}
        </div>
      </details>
    </div>
  );
}
function Field({ l, v, set }: { l: string; v: any; set: (n: number) => void }) {
  function handleBlur(input: HTMLInputElement) {
    const parsed = parseTrMoney(input.value);
    if (parsed !== null) set(parsed);
    input.value = trMoney(parsed ?? v);
  }
  return (
    <label>
      {l}
      <input
        key={`${l}-${v}`}
        type="text"
        inputMode="decimal"
        defaultValue={trMoney(v)}
        onBlur={(e) => handleBlur(e.target)}
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
function Meter({ l, v, max, color, planned = false }: { l: string; v: number; max: number; color?: "purple" | "green"; planned?: boolean }) {
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
          {planned ? (
            <><span>Henüz harcama yok</span><span className="meterDot">·</span><b>Planlanan kullanılabilir hedef {trMoney(max)}</b></>
          ) : (
            <><span>{trMoney(v)} harcandı</span><span className="meterDot">·</span><span>{trMoney(max)} limit</span><span className="meterDot">·</span><b className={kalan < 0 ? "bad" : ""}>{kalan < 0 ? `${trMoney(Math.abs(kalan))} aşım` : `${trMoney(kalan)} kalan`}</b></>
          )}
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
