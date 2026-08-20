/* eslint-disable @typescript-eslint/no-explicit-any, prefer-const */
export type AnyMap = Record<string, any>;
export type BudgetData = AnyMap & {
  ayarlar: AnyMap;
  odemeler: AnyMap[];
  ek_gelirler: AnyMap[];
  aylik_tutar_override: AnyMap;
  odendi_kayitlari: AnyMap;
  odeme_notlari: AnyMap;
  guncel_durum: AnyMap;
  butce_plani: AnyMap;
  haftalik_hedefler: AnyMap;
  haftalik_harcamalar: AnyMap[];
  haftalik_kapanislar: AnyMap;
  gerceklesen_odemeler: AnyMap;
  aylik_ankorlar: AnyMap;
  kart_hesap_ozeti_gecmisi: AnyMap[];
};
export const START_YEAR = 2026,
  START_MONTH = 8;
const n = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const key = (y: number, m: number, id: any) =>
  `${y}-${String(m).padStart(2, "0")}-${id}`;
const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const parseMonth = (s: string) => s.split("-").map(Number) as [number, number];
const cmp = (a: [number, number], b: [number, number]) =>
  a[0] - b[0] || a[1] - b[1];
export const nextMonth = (y: number, m: number): [number, number] =>
  m === 12 ? [y + 1, 1] : [y, m + 1];
const daysInMonth = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoDate = (s: any) => {
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
  return isNaN(+d) ? null : d;
};
const dateIso = (d: Date) => d.toISOString().slice(0, 10);
const dateParts = (d: Date): [number, number] => [
  d.getUTCFullYear(),
  d.getUTCMonth() + 1,
];
const addDays = (d: Date, x: number) => new Date(+d + x * 86400000);

export function normalize(raw: any): BudgetData {
  const d = structuredClone(raw || {}),
    obj = (k: string) =>
      d[k] && typeof d[k] === "object" && !Array.isArray(d[k])
        ? d[k]
        : (d[k] = {});
  const arr = (k: string) => (Array.isArray(d[k]) ? d[k] : (d[k] = []));
  obj("ayarlar");
  arr("odemeler");
  arr("ek_gelirler");
  obj("aylik_tutar_override");
  obj("odendi_kayitlari");
  obj("odeme_notlari");
  obj("guncel_durum");
  obj("butce_plani");
  obj("haftalik_hedefler");
  arr("haftalik_harcamalar");
  obj("haftalik_kapanislar");
  obj("gerceklesen_odemeler");
  obj("aylik_ankorlar");
  arr("kart_hesap_ozeti_gecmisi");
  arr("kart_iadesi_gecmisi");
  arr("kart_kademeli_odemeler");
  const closeLegacyRefund = (state: AnyMap) => {
    const amount = Math.max(0, n(state.yk_beklenen_iade));
    if (amount > 0) {
      const receivedAt = String(
          state.yk_beklenen_iade_alinma_tarihi || state.tarih || "",
        ).slice(0, 10),
        id = `yk-iade-${receivedAt || "gecmis"}-${amount}`;
      if (!d.kart_iadesi_gecmisi.some((x: AnyMap) => x.id === id))
        d.kart_iadesi_gecmisi.push({
          id,
          tutar: amount,
          aciklama: state.yk_beklenen_iade_aciklama || "Kart iadesi",
          gerceklesme_tarihi: receivedAt || null,
          durum: "gerceklesti",
          finansal_etki: false,
        });
    }
    // Eski alanlar geriye dönük uyumluluk için korunur; aktif finansal değer taşımaz.
    state.yk_beklenen_iade = 0;
    state.yk_beklenen_iade_alindi = true;
    state.yk_beklenen_iade_durumu = "kapandi";
  };
  closeLegacyRefund(d.guncel_durum);
  for (const state of Object.values(d.aylik_ankorlar))
    if (state && typeof state === "object" && !Array.isArray(state))
      closeLegacyRefund(state as AnyMap);
  d.ayarlar.faiz_orani ??= 0.06448;
  d.ayarlar.kart_akdi_faiz_orani ??= 0.0375;
  d.ayarlar.kart_faiz_vergi_orani ??= 0.3;
  d.butce_plani.haftalik_ay_carpani ??= 52 / 12;
  d.butce_plani.beklenmedik_tampon ??= 0;
  d.haftalik_hedefler.kart ??= 6300;
  d.haftalik_hedefler.nakit ??= 2800;
  return d as BudgetData;
}
export function activeInMonth(p: AnyMap, y: number, m: number) {
  if (p.aktif === false) return false;
  const t: [number, number] = [y, m];
  if (p.baslangic_ay && cmp(t, parseMonth(p.baslangic_ay)) < 0) return false;
  if (p.bitis_ay && cmp(t, parseMonth(p.bitis_ay)) > 0) return false;
  return true;
}
export function paymentAmount(d: BudgetData, p: AnyMap, y: number, m: number) {
  const exact = key(y, m, p.id),
    o = d.aylik_tutar_override || {};
  if (exact in o) return n(o[exact]);
  let amount = n(p.tutar),
    best: [number, number] | null = null;
  for (const [k, v] of Object.entries(o)) {
    if (!k.endsWith(`-${p.id}`)) continue;
    const q = k.split("-");
    const km: [number, number] = [n(q[0]), n(q[1])];
    if (cmp(km, [y, m]) <= 0 && (!best || cmp(km, best) > 0)) {
      best = km;
      amount = n(v);
    }
  }
  return amount;
}
export function salary(d: BudgetData, y: number, m: number) {
  let out = 100000;
  for (const r of [...(d.ayarlar.maas_takvimi || [])].sort((a, b) =>
    String(a.baslangic_ay).localeCompare(String(b.baslangic_ay)),
  ))
    if (cmp([y, m], parseMonth(r.baslangic_ay)) >= 0) out = n(r.tutar);
  return out;
}
export function extraIncome(d: BudgetData, y: number, m: number) {
  return (d.ek_gelirler || [])
    .filter(
      (x) => x.aktif !== false && !x.bankaya_dahil && x.ay === monthKey(y, m),
    )
    .reduce((a, x) => a + n(x.tutar_tl), 0);
}

export function effectiveDay(y: number, m: number, day: number) {
  let result = new Date(Date.UTC(y, m - 1, Math.min(day, daysInMonth(y, m))));
  if (result.getUTCDay() === 6) result = addDays(result, 2);
  else if (result.getUTCDay() === 0) result = addDays(result, 1);
  return result;
}

export function incomeStatus(d: BudgetData, s: AnyMap, calcDate: Date) {
  const photo = isoDate(s.tarih);
  if (!photo || cmp(dateParts(photo), dateParts(calcDate)) !== 0)
    return { received: 0, remaining: 0 };
  const [y, m] = dateParts(photo),
    cap = Math.max(0, n(s.ay_kalan_gelir, s.agustos_kalan_gelir)),
    parts = (s.gelir_parcalari || []).filter(
      (x: AnyMap) => +effectiveDay(y, m, n(x.gun, 1)) > +photo,
    ),
    received = Math.min(
      cap,
      parts
        .filter((x: AnyMap) => +effectiveDay(y, m, n(x.gun, 1)) <= +calcDate)
        .reduce((a: number, x: AnyMap) => a + Math.max(0, n(x.tutar)), 0),
    );
  return { received, remaining: Math.max(0, cap - received) };
}
export function scheduledIncomeRemaining(
  d: BudgetData,
  s: AnyMap,
  calcDate: Date,
) {
  const [y, m] = dateParts(calcDate),
    parts = s.gelir_parcalari || [],
    rawTotal = parts.reduce(
      (sum: number, x: AnyMap) => sum + Math.max(0, n(x.tutar)),
      0,
    ),
    scale = rawTotal > 0 ? salary(d, y, m) / rawTotal : 0;
  if (!parts.length) return salary(d, y, m);
  return parts
    .filter((x: AnyMap) => +effectiveDay(y, m, n(x.gun, 1)) > +calcDate)
    .reduce(
      (sum: number, x: AnyMap) => sum + Math.max(0, n(x.tutar)) * scale,
      0,
    );
}
export function monthlyLife(d: BudgetData) {
  const f = n(d.butce_plani.haftalik_ay_carpani, 52 / 12),
    card = n(d.haftalik_hedefler.kart, 6300) * f,
    cash = n(d.haftalik_hedefler.nakit, 2800) * f;
  return { kart: card, nakit: cash, toplam: card + cash };
}
export function cardIncludedPayments(
  d: BudgetData,
  y: number,
  m: number,
  onlyPending = false,
) {
  return d.odemeler
    .filter(
      (p) =>
        activeInMonth(p, y, m) &&
        p.odeme_kaynagi === "kredi_karti" &&
        p.kart_tavanina_dahil &&
        (!onlyPending || !d.odendi_kayitlari[key(y, m, p.id)]),
    )
    .reduce((a, p) => a + paymentAmount(d, p, y, m), 0);
}
export function weekRange(target: Date) {
  const day = (target.getUTCDay() + 6) % 7,
    start = addDays(target, -day);
  return [start, addDays(start, 6)] as [Date, Date];
}
export function weeklyGoal(d: BudgetData, start: Date, end: Date) {
  let effective = start;
  const plan = isoDate(d.butce_plani.butce_baslangic_tarihi);
  if (plan && +plan >= +start && +plan <= +end) effective = plan;
  else if (plan && +plan > +end) effective = addDays(end, 1);
  const count = Math.max(0, Math.round((+end - +effective) / 86400000) + 1),
    ratio = count / Math.max(1, Math.round((+end - +start) / 86400000) + 1);
  let card = 0;
  if (count) {
    const factor = n(d.butce_plani.haftalik_ay_carpani, 52 / 12),
      base = n(d.haftalik_hedefler.kart, 6300),
      anchor = isoDate(d.guncel_durum.tarih);
    for (let i = 0; i < count; i++) {
      const day = addDays(effective, i),
        [y, m] = dateParts(day),
        fixed = cardIncludedPayments(d, y, m),
        monthlyBase = base * factor;
      let other = Math.max(0, base - fixed / Math.max(factor, 0.01));
      // Banka fotoğrafı (anchor) bu ayla örtüşüyorsa:
      // Aylık kreş tutarını fotoğraf tarihinden itibaren kalan TAM hafta sayısına böl.
      // Örnek: 17 Ağustos fotoğrafı → 15 gün kaldı → round(15/7)=2 hafta → 8.736/2=4.368 TL
      const anchorDate = isoDate(d.guncel_durum.tarih);
      const monthRef =
        anchorDate && cmp(dateParts(anchorDate), [y, m]) === 0
          ? anchorDate
          : plan && cmp(dateParts(plan), [y, m]) === 0
          ? plan
          : null;
      if (monthRef) {
        const remainingDays = Math.max(
          1,
          daysInMonth(y, m) - monthRef.getUTCDate() + 1,
        );
        if (remainingDays < daysInMonth(y, m)) {
          const weeksLeft = Math.max(1, Math.round(remainingDays / 7));
          const weeklyFixed = fixed / weeksLeft;
          other = Math.max(0, base - weeklyFixed);
        }
      }
      card += other / 7;
    }
  }
  return {
    goal: { kart: card, nakit: n(d.haftalik_hedefler.nakit, 2800) * ratio },
    effective,
  };
}
export function weeklySummary(d: BudgetData, target: Date) {
  const [start, end] = weekRange(target),
    { goal, effective } = weeklyGoal(d, start, end),
    spent = { kart: 0, nakit: 0 },
    records: AnyMap[] = [];
  for (const r of d.haftalik_harcamalar) {
    const rd = isoDate(r.tarih),
      assigned = String(r.butce_haftasi || "");
    if (
      (assigned === dateIso(start) ||
        (!assigned && rd && +rd >= +effective && +rd <= +end)) &&
      (r.tur === "kart" || r.tur === "nakit")
    ) {
      (spent as Record<string, number>)[r.tur as string] += n(r.tutar);
      records.push(r);
    }
  }
  return {
    start,
    end,
    effective,
    goal,
    spent,
    remaining: {
      kart: goal.kart - spent.kart,
      nakit: goal.nakit - spent.nakit,
    },
    records: records.sort(
      (a, b) =>
        String(b.tarih).localeCompare(String(a.tarih)) ||
        String(b.olusturma_zamani || "").localeCompare(String(a.olusturma_zamani || "")) ||
        n(b.id) - n(a.id),
    ),
  };
}
export function activeWeeklySummary(d: BudgetData, target: Date) {
  let week = weeklySummary(d, target);
  for (let i = 0; i < 52 && d.haftalik_kapanislar?.[dateIso(week.start)]; i++)
    week = weeklySummary(d, addDays(week.end, 1));
  return week;
}

/**
 * Özet ekranı için: sanki bugün haftanın başıymış gibi davran.
 * Bu haftaki harcamalar sayılmaz (spent = 0), hedef bugünden haftanın
 * sonuna kalan gün sayısına göre orantılanır.
 * Pazar günü geçilirse yarını (yeni haftanın Pazartesisi) baz alır.
 */
export function freshWeeklySummary(d: BudgetData, target = todayUtc()) {
  const [, end] = weekRange(target);
  const { goal } = weeklyGoal(d, target, end);
  return {
    start: target,
    end,
    effective: target,
    goal,
    spent: { kart: 0, nakit: 0 },
    remaining: { kart: goal.kart, nakit: goal.nakit },
    records: [] as AnyMap[],
  };
}
export function weeklyCarryAdjustment(d: BudgetData, target: Date) {
  const [start] = weekRange(target);
  let kartNet = 0,
    nakitNet = 0;
  for (const c of Object.values(d.haftalik_kapanislar || {}) as AnyMap[]) {
    const s = isoDate(c.baslangic),
      e = isoDate(c.bitis);
    if (!s || !e || +s >= +start) continue;
    const { goal } = weeklyGoal(d, s, e);
    kartNet += goal.kart - n(c.kart);
    nakitNet += goal.nakit - n(c.nakit);
  }
  const totalNet = kartNet + nakitNet;
  if (totalNet >= -0.01)
    return { kart: 0, nakit: 0, total: 0, source: "net-defter" };
  const total = -totalNet,
    kartAcik = Math.max(0, -kartNet),
    nakitAcik = Math.max(0, -nakitNet),
    acikToplam = kartAcik + nakitAcik;
  return {
    kart: acikToplam ? (total * kartAcik) / acikToplam : total / 2,
    nakit: acikToplam ? (total * nakitAcik) / acikToplam : total / 2,
    total,
    source: "net-defter",
  };
}
export function monthlySpendingSummary(d: BudgetData, target: Date) {
  const [y, m] = dateParts(target),
    spent = { kart: 0, nakit: 0 },
    base = monthlyLife(d),
    plan = isoDate(d.butce_plani.butce_baslangic_tarihi),
    monthStart = new Date(Date.UTC(y, m - 1, 1)),
    monthEnd = new Date(Date.UTC(y, m - 1, daysInMonth(y, m))),
    effective =
      plan && +plan > +monthStart && +plan <= +monthEnd ? plan : monthStart;
  for (const r of d.haftalik_harcamalar) {
    const rd = isoDate(r.tarih);
    if (
      rd &&
      +rd >= +effective &&
      cmp(dateParts(rd), [y, m]) === 0 &&
      (r.tur === "kart" || r.tur === "nakit")
    )
      (spent as Record<string, number>)[r.tur as string] += Math.max(0, n(r.tutar));
  }
  const days = Math.max(0, Math.round((+monthEnd - +effective) / 86400000) + 1),
    ratio = days / daysInMonth(y, m),
    fixedCard = cardIncludedPayments(d, y, m),
    goal = {
      kart: Math.max(0, base.kart * ratio - fixedCard),
      nakit: base.nakit * ratio,
    },
    remaining = {
      kart: goal.kart - spent.kart,
      nakit: goal.nakit - spent.nakit,
    };
  return {
    y,
    m,
    effective,
    days,
    spent,
    goal,
    remaining,
    totalSpent: spent.kart + spent.nakit,
    totalGoal: goal.kart + goal.nakit,
    totalRemaining: remaining.kart + remaining.nakit,
    fixedCard,
  };
}
export function weeklyCardSavings(d: BudgetData, today = todayUtc()) {
  const activeWeek = activeWeeklySummary(d, today);
  const milatDate = isoDate(d.butce_plani.butce_baslangic_tarihi);
  const milatWeekStart = milatDate ? weekRange(milatDate)[0] : null;
  let net = 0;

  for (const c of Object.values(d.haftalik_kapanislar || {}) as AnyMap[]) {
    const s = isoDate(c.baslangic), e = isoDate(c.bitis);
    if (!s || !e) continue;
    if (milatWeekStart && +s < +milatWeekStart) continue;
    if (+s >= +activeWeek.start) continue;
    const { goal } = weeklyGoal(d, s, e);
    net += goal.kart - n(c.kart);
  }

  const { goal: activeGoal } = weeklyGoal(d, activeWeek.start, activeWeek.end);
  const countFrom = milatWeekStart && +activeWeek.start <= +milatWeekStart && milatDate
    ? milatDate
    : activeWeek.start;
  const weekEnd = activeWeek.end;
  const completedDays = Math.max(0, Math.round((+today - +countFrom) / 86400000) + 1);
  const totalDays = Math.max(1, Math.round((+weekEnd - +countFrom) / 86400000) + 1);
  const elapsedRatio = Math.min(1, completedDays / totalDays);
  net += activeGoal.kart * elapsedRatio - activeWeek.spent.kart;

  return net;
}
export function weeklySavings(d: BudgetData, today = todayUtc()) {
  const activeWeek = activeWeeklySummary(d, today);
  const milatDate = isoDate(d.butce_plani.butce_baslangic_tarihi);
  const milatWeekStart = milatDate ? weekRange(milatDate)[0] : null;
  let net = 0;

  for (const c of Object.values(d.haftalik_kapanislar || {}) as AnyMap[]) {
    const s = isoDate(c.baslangic),
      e = isoDate(c.bitis);
    if (!s || !e) continue;
    if (milatWeekStart && +s < +milatWeekStart) continue;
    if (+s >= +activeWeek.start) continue;
    const { goal } = weeklyGoal(d, s, e);
    net += goal.nakit - n(c.nakit);
  }

  const { goal: activeGoal } = weeklyGoal(d, activeWeek.start, activeWeek.end);
  const countFrom = milatWeekStart && +activeWeek.start <= +milatWeekStart && milatDate
    ? milatDate
    : activeWeek.start;
  const weekEnd = activeWeek.end;
  const completedDays = Math.max(0, Math.round((+today - +countFrom) / 86400000) + 1);
  const totalDays = Math.max(1, Math.round((+weekEnd - +countFrom) / 86400000) + 1);
  const elapsedRatio = Math.min(1, completedDays / totalDays);
  net += activeGoal.nakit * elapsedRatio - activeWeek.spent.nakit;

  return net;
}
function closedWeekDelta(d: BudgetData, y: number, m: number) {
  const out = { kart: 0, nakit: 0 };
  for (const c of Object.values(d.haftalik_kapanislar || {}) as AnyMap[]) {
    const s = isoDate(c.baslangic),
      e = isoDate(c.bitis);
    if (!s || !e) continue;
    const { goal, effective } = weeklyGoal(d, s, e),
      days = [] as Date[];
    for (let x = effective; +x <= +e; x = addDays(x, 1)) days.push(x);
    const inMonth = days.filter((x) => cmp(dateParts(x), [y, m]) === 0).length;
    if (!inMonth) continue;
    const ratio = inMonth / Math.max(1, days.length);
    out.kart += (n(c.kart) - goal.kart) * ratio;
    out.nakit += (n(c.nakit) - goal.nakit) * ratio;
  }
  return out;
}
function monthlyCardSpend(d: BudgetData, y: number, m: number) {
  let total = monthlyLife(d).kart + closedWeekDelta(d, y, m).kart;
  for (const p of d.odemeler)
    if (
      activeInMonth(p, y, m) &&
      p.odeme_kaynagi === "kredi_karti" &&
      !p.kart_tavanina_dahil &&
      !p.hesaplamadan_haric
    )
      total += paymentAmount(d, p, y, m);
  return total;
}
function cardPaymentInfos(d: BudgetData, y: number, m: number) {
  return d.odemeler
    .filter((p) => p.kart_borc_odeme && activeInMonth(p, y, m))
    .map((p) => ({ p, amount: paymentAmount(d, p, y, m) }));
}
export function partialCardPaymentTotal(
  d: BudgetData,
  y: number,
  m: number,
  paymentId: number | string,
) {
  return (d.kart_kademeli_odemeler as AnyMap[]).reduce(
    (sum, e) =>
      n(e.yil) === y &&
      n(e.ay) === m &&
      String(e.odeme_id) === String(paymentId)
        ? sum + Math.max(0, n(e.tutar))
        : sum,
    0,
  );
}
function cardDebtLimit(d: BudgetData) {
  return Math.max(
    0,
    n(d.guncel_durum.yk_limit) -
      Math.max(0, n(d.guncel_durum.yk_limit_kullanimi_farki)),
  );
}
function installment(d: BudgetData, y: number, m: number) {
  return Math.max(0, n(d.guncel_durum.yk_taksit_takvimi?.[monthKey(y, m)]));
}

export function cardRateTier(periodDebt: any) {
  const debt = Math.max(0, n(periodDebt));
  if (debt < 30_000) return { contractual: 0.0325 };
  if (debt <= 180_000) return { contractual: 0.0375 };
  return { contractual: 0.0425 };
}

const dateDiff = (from: Date, to: Date) =>
  Math.max(0, Math.round((+to - +from) / 86400000));

export function cardStatementInterest(statement: AnyMap, settings: AnyMap = {}) {
  const periodDebt = Math.max(0, n(statement.donem_borcu)),
    minimum = Math.max(0, n(statement.asgari_tutar)),
    paid = statement.asgari_otomatik_odeme === false
      ? Math.max(0, n(statement.odenen_tutar))
      : minimum,
    excluded = Math.max(
      0,
      n(statement.donem_faizi) + n(statement.yillik_kart_ucreti),
    ),
    eligibleOpening = Math.max(0, periodDebt - excluded),
    eligibleAfterPayment = Math.max(0, eligibleOpening - paid),
    reportedRemaining = Math.max(
      0,
      n(statement.kalan_donem_borcu, Math.max(0, periodDebt - paid)),
    ),
    tier = cardRateTier(periodDebt),
    contractualRate = Math.max(
      0,
      n(statement.akdi_faiz_orani, tier.contractual),
    ),
    taxRate = Math.max(0, n(statement.vergi_orani, n(settings.kart_faiz_vergi_orani, 0.3))),
    cut = isoDate(statement.hesap_kesim_tarihi),
    due = isoDate(statement.son_odeme_tarihi),
    nextCut = isoDate(statement.sonraki_hesap_kesim_tarihi),
    paymentDate = isoDate(statement.odeme_tarihi) || (due ? addDays(due, -1) : null);
  if (!cut || !due || !nextCut || +nextCut <= +cut)
    return {
      valid: false,
      contractualInterest: 0,
      lateInterest: 0,
      tax: 0,
      total: 0,
      reportedRemaining,
      minimumMet: paid >= minimum,
      paymentOnTime: false,
      contractualRate,
      taxRate,
    };

  const payAt = new Date(Math.min(+nextCut, Math.max(+cut, +paymentDate!))),
    dueAt = new Date(Math.min(+nextCut, Math.max(+cut, +due))),
    beforePaymentDays = dateDiff(cut, payAt),
    paymentOnTime = +payAt <= +dueAt,
    minimumMet = paid >= minimum,
    dailyContractual = contractualRate / 30,
    afterPaymentDays = dateDiff(payAt, nextCut),
    contractualInterest =
      eligibleOpening * dailyContractual * beforePaymentDays +
      eligibleAfterPayment * dailyContractual * afterPaymentDays,
    lateInterest = 0,
    interestBeforeTax = contractualInterest,
    tax = interestBeforeTax * taxRate;
  return {
    valid: true,
    contractualInterest,
    lateInterest,
    tax,
    total: interestBeforeTax + tax,
    reportedRemaining,
    eligibleOpening,
    eligibleAfterPayment,
    minimumMet,
    paymentOnTime,
    contractualRate,
    taxRate,
    assumedPaymentDate: !statement.odeme_tarihi,
  };
}
function cardMonth(
  d: BudgetData,
  y: number,
  m: number,
  opening: number,
  opt: AnyMap = {},
) {
  const infos = cardPaymentInfos(d, y, m),
    base = infos.reduce((sum, info) => sum + Math.max(0, info.amount), 0),
    target = infos.reduce((sum, info) => {
      const k = key(y, m, info.p.id),
        planned = Math.max(0, info.amount);
      if (d.odendi_kayitlari[k])
        return sum + (opt.realizedPaymentInLive
          ? 0
          : Math.max(0, n(d.gerceklesen_odemeler[k]?.tutar, planned)));
      if (!opt.realizedPaymentInLive) return sum + planned;
      return sum + Math.max(0, planned - partialCardPaymentTotal(d, y, m, info.p.id));
    }, 0);
  const tier = cardRateTier(opt.currentStatement ?? opening),
    baseRate = d.ayarlar.kart_akdi_faiz_orani_manuel == null
      ? tier.contractual
      : n(d.ayarlar.kart_akdi_faiz_orani_manuel, tier.contractual),
    rate = baseRate * (1 + n(d.ayarlar.kart_faiz_vergi_orani, 0.3)),
    planned =
      opt.newSpendAmount == null
        ? monthlyCardSpend(d, y, m) * n(opt.newSpendRatio, 1)
        : Math.max(0, n(opt.newSpendAmount)),
    limit = n(opt.cardLimit);
  opening = Math.max(0, n(opening));
  // dinamik_kart_odeme devre dışı bırakıldı.
  // Kart ödemesi her zaman sabit p.tutar (aylik_tutar_override veya p.tutar) olarak kalır.
  // KMH pozitife geçince fazla para KMH'de birikir, karta aktarılmaz.
  const paid = Math.min(target, opening),
    carry = Math.max(0, opening - paid),
    basis =
      opt.currentStatement == null
        ? carry
        : Math.max(0, n(opt.currentStatement) - paid),
    interest = opt.interestOverride == null
      ? basis * rate
      : Math.max(0, n(opt.interestOverride)),
    after = carry + interest,
    available = limit > 0 ? Math.max(0, limit - after) : Infinity,
    newSpend = Math.min(planned, available),
    overflow = Math.max(0, planned - newSpend),
    closing = after + newSpend,
    nextStatement = Math.min(
      closing,
      basis + interest + newSpend + Math.max(0, n(opt.nextInstallment)),
    );
  return {
    kart_acilis_borcu: opening,
    kart_odeme: paid,
    kart_taban_odeme: base,
    kart_dinamik_ek_odeme: Math.max(0, paid - base),
    kart_yeni_harcama: newSpend,
    kart_planlanan_yeni_harcama: planned,
    kart_limit_asimi: overflow,
    kart_limiti: limit,
    kart_faiz: interest,
    kart_faiz_orani: rate,
    kart_kapanis_borcu: closing,
    kart_devreden_borc: basis,
    kart_sonraki_ekstre: nextStatement,
  };
}
export function liveFinancial(
  d: BudgetData,
  s = d.guncel_durum,
  calcDate = todayUtc(),
) {
  const start = new Date(s.takip_baslangic_zamani || 0),
    photo = isoDate(s.tarih),
    pm = photo ? dateParts(photo) : null;
  // Fotoğraf geçmiş bir aya aitse, calcDate'in ayındaki işlemleri de dahil et.
  // Geçen ayın harcama/ödemeleri zaten fotoğraf bakiyesine dahil olduğundan
  // sadece fotoğraftan SONRA oluşturulmuş (olusturma_zamani > start) kayıtlar
  // sayılır — bu zaten `created >= start` koşuluyla sağlanıyor.
  // useMonth: fotoğraf ayı veya calcDate ayındaki kayıtları kabul et.
  const calcMonth = dateParts(calcDate),
    useMonth = (em: [number, number]) => {
      if (!pm) return true;
      if (cmp(em, pm) === 0) return true;          // foto ayı
      if (cmp(pm, calcMonth) < 0)                  // foto geçmiş ay ise
        return cmp(em, calcMonth) === 0;            // bu ayı da dahil et
      return false;
    };
  let bank = n(s.garanti_bakiye),
    card = n(s.yk_toplam_borc, n(s.yk_limit) - n(s.yk_kullanilabilir)),
    limit = n(s.yk_limit),
    available = n(s.yk_kullanilabilir, Math.max(0, limit - card));
  const sums = {
    kart_harcama: 0,
    nakit_harcama: 0,
    banka_odeme: 0,
    kart_odeme: 0,
    karta_yansiyan: 0,
    otomatik_gelir: 0,
  };
  const scheduled = incomeStatus(d, s, calcDate);
  bank += scheduled.received;
  sums.otomatik_gelir = scheduled.received;
  for (const r of d.haftalik_harcamalar) {
    const created = new Date(r.olusturma_zamani || 0),
      rd = isoDate(r.tarih);
    if (!rd || +created < +start || !useMonth(dateParts(rd)))
      continue;
    const amount = Math.max(0, n(r.tutar));
    if (r.tur === "kart") {
      card += amount;
      available -= amount;
      sums.kart_harcama += amount;
    } else if (r.tur === "nakit") {
      bank -= amount;
      sums.nakit_harcama += amount;
    }
  }
  for (const [k, e] of Object.entries(d.gerceklesen_odemeler) as [
    string,
    AnyMap,
  ][]) {
    if (e.banka_fotografina_dahil) continue;
    const created = new Date(e.olusturma_zamani || 0),
      parts = k.split("-");
    const em: [number, number] = [n(e.yil, Number(parts[0])), n(e.ay, Number(parts[1]))];
    if (+created < +start || !useMonth(em)) continue;
    const amount = Math.max(0, n(e.tutar));
    if (e.kart_borc_odeme) {
      bank -= amount;
      card -= amount;
      available += amount;
      sums.kart_odeme += amount;
    } else if (e.odeme_kaynagi === "kredi_karti") {
      card += amount;
      available -= amount;
      sums.karta_yansiyan += amount;
    } else {
      bank -= amount;
      sums.banka_odeme += amount;
    }
  }
  for (const e of d.kart_kademeli_odemeler as AnyMap[]) {
    const created = new Date(e.olusturma_zamani || e.tarih || 0),
      em = [n(e.yil), n(e.ay)] as [number, number],
      amount = Math.max(0, n(e.tutar));
    if (!amount || +created < +start || !useMonth(em)) continue;
    bank -= amount;
    card -= amount;
    available += amount;
    sums.kart_odeme += amount;
  }
  return {
    garanti_bakiye: bank,
    yk_toplam_borc: Math.max(0, card),
    yk_kullanilabilir: Math.min(limit, Math.max(0, available)),
    ...sums,
  };
}
function anchor(d: BudgetData, y: number, m: number): [Date, AnyMap] | null {
  for (const a of [d.guncel_durum, d.aylik_ankorlar[monthKey(y, m)] || {}]) {
    const dt = isoDate(a.tarih);
    if (dt && cmp(dateParts(dt), [y, m]) === 0 && "garanti_bakiye" in a)
      return [dt, a];
  }
  return null;
}
function remainingRatio(y: number, m: number, photo: Date, calc: Date) {
  const end = new Date(Date.UTC(y, m - 1, daysInMonth(y, m))),
    effective = +calc < +photo ? photo : +calc > +end ? end : calc;
  return (
    Math.max(0, Math.round((+end - +effective) / 86400000)) / end.getUTCDate()
  );
}

function remainingFlexibleLife(
  d: BudgetData,
  y: number,
  m: number,
  calcDate: Date,
) {
  const month = monthlySpendingSummary(d, calcDate),
    saved = { kart: 0, nakit: 0 };
  for (const c of Object.values(d.haftalik_kapanislar || {}) as AnyMap[]) {
    const start = isoDate(c.baslangic),
      end = isoDate(c.bitis);
    if (!start || !end) continue;
    const { goal, effective } = weeklyGoal(d, start, end),
      effectiveDays: Date[] = [];
    for (let x = effective; +x <= +end; x = addDays(x, 1))
      if (cmp(dateParts(x), [y, m]) === 0) effectiveDays.push(x);
    if (!effectiveDays.length) continue;
    const totalDays = Math.max(
        1,
        Math.round((+end - +effective) / 86400000) + 1,
      ),
      share = effectiveDays.length / totalDays;
    saved.kart += Math.max(0, (goal.kart - n(c.kart)) * share);
    saved.nakit += Math.max(0, (goal.nakit - n(c.nakit)) * share);
  }
  return {
    kart: Math.max(0, month.remaining.kart - saved.kart),
    nakit: Math.max(0, month.remaining.nakit - saved.nakit),
  };
}
function lastClosed(
  d: BudgetData,
  y: number,
  m: number,
  photo: Date,
  today: Date,
) {
  let out = photo;
  for (const c of Object.values(d.haftalik_kapanislar) as AnyMap[]) {
    const e = isoDate(c.bitis);
    if (
      e &&
      cmp(dateParts(e), [y, m]) === 0 &&
      +e > +photo &&
      +e <= +today &&
      +e > +out
    )
      out = e;
  }
  return out;
}
function bankExpense(d: BudgetData, y: number, m: number, cardPay?: number) {
  let total = 0;
  for (const p of d.odemeler)
    if (
      activeInMonth(p, y, m) &&
      (p.odeme_kaynagi || "banka") === "banka" &&
      !p.hesaplamadan_haric
    ) {
      const k = key(y, m, p.id),
        real = d.gerceklesen_odemeler[k];
      if (d.odendi_kayitlari[k] && real) total += Math.max(0, n(real.tutar));
      else if (p.kart_borc_odeme && cardPay != null) total += cardPay;
      else total += paymentAmount(d, p, y, m);
    }
  total += monthlyLife(d).nakit;
  if (!d.butce_plani.tampon_haftalik_hedefe_dahil)
    total += n(d.butce_plani.beklenmedik_tampon);
  return total;
}
function currentMonth(
  d: BudgetData,
  y: number,
  m: number,
  photo: Date,
  calc: Date,
  s: AnyMap,
) {
  const rate = n(d.ayarlar.faiz_orani, 0.06448),
    planDate = calc || lastClosed(d, y, m, photo, new Date()),
    ratio = remainingRatio(y, m, photo, planDate),
    live = liveFinancial(d, s, planDate),
    flexible = remainingFlexibleLife(d, y, m, planDate),
    includedCard = cardIncludedPayments(d, y, m, true),
    cardLife = flexible.kart + includedCard;
  let bills = 0;
  for (const p of d.odemeler)
    if (
      activeInMonth(p, y, m) &&
      p.odeme_kaynagi === "kredi_karti" &&
      !p.kart_tavanina_dahil &&
      !p.hesaplamadan_haric &&
      !d.odendi_kayitlari[key(y, m, p.id)]
    )
      bills += paymentAmount(d, p, y, m);
  const statement = s.yk_hesap_ozeti || {},
    statementMonth = String(statement.hesap_kesim_tarihi || "").slice(0, 7),
    statementInterest = statementMonth === monthKey(y, m)
      ? cardStatementInterest(statement, d.ayarlar)
      : null,
    card = cardMonth(d, y, m, live.yk_toplam_borc, {
    currentStatement: Math.max(0, n(s.yk_beklenen_ekstre) - live.kart_odeme),
    newSpendAmount: cardLife + bills,
    realizedPaymentInLive: true,
    cardLimit: cardDebtLimit(d),
    interestOverride: statementInterest?.valid ? statementInterest.total : null,
  });
  const remainingStatement = Math.max(
      0,
      n(s.yk_guncel_ekstre, s.yk_beklenen_ekstre) - card.kart_odeme,
    ),
    currentNew = Math.max(
      0,
      n(s.yk_guncel_borc) - n(s.yk_guncel_ekstre, s.yk_beklenen_ekstre),
    );
  card.kart_sonraki_ekstre = Math.min(
    card.kart_kapanis_borcu,
    remainingStatement +
      card.kart_faiz +
      currentNew +
      card.kart_yeni_harcama,
  );
  let payments = 0;
  for (const p of d.odemeler)
    if (
      activeInMonth(p, y, m) &&
      (p.odeme_kaynagi || "banka") === "banka" &&
      !p.hesaplamadan_haric &&
      !d.odendi_kayitlari[key(y, m, p.id)]
    ) {
      if (p.kart_borc_odeme) {
        // Kademeli ödenenler düşülmüş gerçek kalan tutarı kullan
        const plannedAmt = paymentAmount(d, p, y, m);
        const alreadyPaid = partialCardPaymentTotal(d, y, m, p.id);
        payments += Math.max(0, plannedAmt - alreadyPaid);
      } else {
        payments += paymentAmount(d, p, y, m);
      }
    }
  // Kalan nakit yaşam: kalan günlere orantılı hesapla (günlük hedef × kalan gün)
  const monthEndDate = new Date(Date.UTC(y, m - 1, daysInMonth(y, m))),
    remainingDays = Math.max(
      0,
      Math.round((+monthEndDate - +planDate) / 86400000) + 1,
    ),
    totalDays = daysInMonth(y, m),
    dailyNakit = (n(d.haftalik_hedefler.nakit, 2800) / 7),
    // Gerçek nakit harcamaları (liveFinancial'dan)
    spentNakit = live.nakit_harcama,
    // Kalan nakit: kalan günler × günlük hedef, sıfırın altına inmesin
    cash = Math.max(0, dailyNakit * remainingDays - Math.max(0, spentNakit - dailyNakit * (totalDays - remainingDays)));
  const buffer = d.butce_plani.tampon_haftalik_hedefe_dahil
      ? 0
      : n(d.butce_plani.beklenmedik_tampon) * ratio,
    raw = payments + cash + buffer + card.kart_limit_asimi,
    income = incomeStatus(d, s, planDate).remaining + extraIncome(d, y, m),
    before = live.garanti_bakiye + income - raw,
    interest = before < 0 ? -before * rate : 0;
  // Fazla para KMH'de kalır — kart borcu zaten aylık sabit ödemeyle
  // kendi temposunda azalır. extraCard aktarımı kaldırıldı.
  const overdraft = before - interest;
  return {
    yil: y,
    ay: m,
    maas: income,
    ham_gider: raw,
    toplam: raw + interest,
    ek_avans: overdraft,
    faiz: interest,
    guncel_ankor: true,
    baslangic_bakiye: live.garanti_bakiye,
    kalan_gelir: income,
    ek_gelir: extraIncome(d, y, m),
    toplam_gelir: income,
    kalan_sabit_odemeler: payments,
    kalan_yasam_nakit: cash,
    canli_durum: live,
    kalan_kart_yasam: cardLife,
    kalan_kart_faturalari: bills,
    kart_faiz_detayi: statementInterest,
    karttan_kmhye_aktarılan: card.kart_limit_asimi,
    ek_kart_odeme: 0,
    ...card,
  };
}
export function calculateMonth(
  d: BudgetData,
  y: number,
  m: number,
  prev: AnyMap = {},
  calcDate = todayUtc(),
) {
  const a = anchor(d, y, m);
  if (a) return currentMonth(d, y, m, a[0], calcDate, a[1]);
  const income = salary(d, y, m),
    extra = extraIncome(d, y, m),
    card = cardMonth(d, y, m, n(prev.card), {
      currentStatement: prev.statement,
      cardLimit: cardDebtLimit(d),
      nextInstallment: installment(d, ...nextMonth(y, m)),
    });
  const raw =
      bankExpense(d, y, m, card.kart_odeme) +
      card.kart_limit_asimi +
      closedWeekDelta(d, y, m).nakit,
    before = n(prev.overdraft) + income + extra - raw,
    interest = before < 0 ? -before * n(d.ayarlar.faiz_orani, 0.06448) : 0;
  // Fazla para KMH'de kalır — kart borcu zaten aylık sabit ödemeyle azalır.
  const overdraft = before - interest;
  return {
    yil: y,
    ay: m,
    maas: income,
    ek_gelir: extra,
    toplam_gelir: income + extra,
    ham_gider: raw,
    toplam: raw + interest,
    ek_avans: overdraft,
    faiz: interest,
    baslangic_bakiye: n(prev.overdraft),
    guncel_ankor: false,
    ek_kart_odeme: 0,
    karttan_kmhye_aktarılan: card.kart_limit_asimi,
    ...card,
  };
}
export function projection(
  d: BudgetData,
  endYear = 2031,
  endMonth = 8,
  calcDate = todayUtc(),
) {
  const out: AnyMap[] = [];
  let y = START_YEAR,
    m = START_MONTH,
    prev: AnyMap = {};
  while (cmp([y, m], [endYear, endMonth]) <= 0) {
    const r = calculateMonth(d, y, m, prev, calcDate);
    out.push(r);
    prev = {
      overdraft: r.ek_avans,
      card: r.kart_kapanis_borcu,
      statement: r.kart_sonraki_ekstre,
    };
    [y, m] = nextMonth(y, m);
  }
  return out;
}
export function exitDates(d: BudgetData, calcDate = todayUtc()) {
  const rows = projection(d, 2031, 8, calcDate),
    current: [number, number] = dateParts(calcDate),
    relevant = rows.filter((r) => cmp([r.yil, r.ay], current) >= 0),
    kmh = relevant.find((r) => r.ek_avans >= 0),
    card = relevant.find((r) => r.kart_devreden_borc <= 0.01);
  return {
    kmh: kmh ? [kmh.yil, kmh.ay] : null,
    card: card ? [card.yil, card.ay] : null,
    rows,
  };
}
export const trMoney = (v: any) => {
  const num = n(v);
  if (!Number.isFinite(num)) return "— TL";
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num).replace("TRY", "TL");
};
export const trMonth = (x: any) =>
  x
    ? new Intl.DateTimeFormat("tr-TR", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(x[0], x[1] - 1, 1)))
    : "5 yıl içinde görünmüyor";
export const todayUtc = () =>
  new Date(
    Date.UTC(
      new Date().getFullYear(),
      new Date().getMonth(),
      new Date().getDate(),
    ),
  );
export const paymentKey = key;
export const monthLabel = monthKey;
export const dateToIso = dateIso;
