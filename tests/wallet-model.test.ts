import assert from "node:assert/strict";
import test from "node:test";
import { liveFinancial, normalize, shouldRetainExpenseDetails, walletState, weeklySummary } from "../app/lib/budget-engine";

const calcDate = new Date("2026-08-24T12:00:00.000Z");
function fixture(extra: Record<string, unknown> = {}) {
  return normalize({
    guncel_durum: {
      tarih: "2026-08-24",
      takip_baslangic_zamani: "2026-08-24T08:00:00.000Z",
      garanti_bakiye: -10_000,
      yk_toplam_borc: 20_000,
      yk_kullanilabilir: 80_000,
      yk_limit: 100_000,
      gelir_parcalari: [],
    },
    haftalik_harcamalar: [],
    cuzdan_ayarlari: { aktif: true },
    cuzdan_hareketleri: [],
    ...extra,
  });
}

test("cüzdan kapalıyken mevcut nakit ve KMH sonucu birebir korunur", () => {
  const legacy = fixture({
    cuzdan_ayarlari: { aktif: false },
    cuzdan_hareketleri: [{ id: "ignored", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" }],
    haftalik_harcamalar: [{ id: "cash", tur: "nakit", tutar: 600, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" }],
  });
  const live = liveFinancial(legacy, legacy.guncel_durum, calcDate);
  assert.equal(walletState(legacy).aktif, false);
  assert.equal(live.garanti_bakiye, -10_600);
  assert.equal(live.nakit_harcama, 600);
});

test("4.000 TL çekim KMH'yi bir kez azaltır, harcama cüzdanı tüketir", () => {
  const data = fixture({
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" }],
    haftalik_harcamalar: [{ id: "cash", tur: "nakit", tutar: 600, cuzdan_takibine_dahil: true, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" }],
  });
  const state = walletState(data), live = liveFinancial(data, data.guncel_durum, calcDate);
  assert.deepEqual(state.allocations.get("cash"), { cuzdan: 600, kmh: 0 });
  assert.equal(state.bakiye, 3_400);
  assert.equal(live.garanti_bakiye, -14_000);
  assert.equal(live.nakit_harcama, 600);
});

test("cüzdan yetersizse kalan tutar otomatik KMH'ye ayrılır", () => {
  const data = fixture({
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 200, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" }],
    haftalik_harcamalar: [{ id: "cash", tur: "nakit", tutar: 500, cuzdan_takibine_dahil: true, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" }],
  });
  const state = walletState(data), live = liveFinancial(data, data.guncel_durum, calcDate);
  assert.deepEqual(state.allocations.get("cash"), { cuzdan: 200, kmh: 300 });
  assert.equal(state.bakiye, 0);
  assert.equal(live.garanti_bakiye, -10_500);
  assert.equal(live.nakit_harcama, 500);
});

test("harcama düzenleme ve silme cüzdan/KMH dağılımını yeniden üretir", () => {
  const data = fixture({
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" }],
    haftalik_harcamalar: [{ id: "cash", tur: "nakit", tutar: 4_500, cuzdan_takibine_dahil: true, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" }],
  });
  assert.equal(liveFinancial(data, data.guncel_durum, calcDate).garanti_bakiye, -14_500);
  data.haftalik_harcamalar[0].tutar = 3_000;
  assert.equal(walletState(data).bakiye, 1_000);
  assert.equal(liveFinancial(data, data.guncel_durum, calcDate).garanti_bakiye, -14_000);
  data.haftalik_harcamalar = [];
  assert.equal(walletState(data).bakiye, 4_000);
  assert.equal(liveFinancial(data, data.guncel_durum, calcDate).garanti_bakiye, -14_000);
});

test("banka fotoğrafı çekimi içeriyorsa çekim ikinci kez sayılmaz", () => {
  const data = fixture({
    guncel_durum: {
      tarih: "2026-08-24",
      takip_baslangic_zamani: "2026-08-24T10:00:00.000Z",
      garanti_bakiye: -14_000,
      yk_toplam_borc: 20_000,
      yk_kullanilabilir: 80_000,
      yk_limit: 100_000,
      gelir_parcalari: [],
    },
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" }],
    haftalik_harcamalar: [{ id: "cash", tur: "nakit", tutar: 600, cuzdan_takibine_dahil: true, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T11:00:00.000Z" }],
  });
  assert.equal(walletState(data).bakiye, 3_400);
  assert.equal(liveFinancial(data, data.guncel_durum, calcDate).garanti_bakiye, -14_000);
});

test("bakiye düzeltmesi KMH'de yapay hareket üretmez", () => {
  const data = fixture({
    cuzdan_hareketleri: [
      { id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" },
      { id: "fix", tur: "bakiye_duzeltme", bakiye: 3_850, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" },
    ],
  });
  assert.equal(walletState(data).bakiye, 3_850);
  assert.equal(liveFinancial(data, data.guncel_durum, calcDate).garanti_bakiye, -14_000);
});

test("iki cihazın eşzamanlı harcamaları birleşince toplam kaynak doğru kalır", () => {
  const data = fixture({
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 500, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" }],
    haftalik_harcamalar: [
      { id: "device-a", tur: "nakit", tutar: 400, cuzdan_takibine_dahil: true, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" },
      { id: "device-b", tur: "nakit", tutar: 400, cuzdan_takibine_dahil: true, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" },
    ],
  });
  const allocations = [...walletState(data).allocations.values()],
    walletTotal = allocations.reduce((sum, item) => sum + item.cuzdan, 0),
    kmhTotal = allocations.reduce((sum, item) => sum + item.kmh, 0);
  assert.equal(walletTotal, 500);
  assert.equal(kmhTotal, 300);
  assert.equal(liveFinancial(data, data.guncel_durum, calcDate).garanti_bakiye, -10_800);
});

test("hafta kapanırken cüzdanı tüketen ayrıntı korunur", () => {
  const walletExpense = { id: "cash", tur: "nakit", tutar: 600, cuzdan_takibine_dahil: true },
    legacyExpense = { id: "legacy", tur: "nakit", tutar: 600 };
  assert.equal(shouldRetainExpenseDetails(walletExpense), true);
  assert.equal(shouldRetainExpenseDetails(legacyExpense), false);
});

test("cüzdan harcaması KMH'yi tekrarlamaz ama haftalık nakit limitini azaltır", () => {
  const data = fixture({
    guncel_durum: {
      tarih: "2026-08-24",
      takip_baslangic_zamani: "2026-08-24T08:00:00.000Z",
      garanti_bakiye: -45_162.83,
      yk_toplam_borc: 89_081.51,
      yk_kullanilabilir: 15_126.10,
      yk_limit: 106_400,
      gelir_parcalari: [],
    },
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-24", olusturma_zamani: "2026-08-24T09:00:00.000Z" }],
    haftalik_harcamalar: [{ id: "cash-600", tur: "nakit", tutar: 600, cuzdan_takibine_dahil: true, tarih: "2026-08-24", butce_haftasi: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" }],
  });
  let live = liveFinancial(data, data.guncel_durum, calcDate),
    week = weeklySummary(data, calcDate);
  assert.equal(live.garanti_bakiye, -49_162.83);
  assert.equal(walletState(data).bakiye, 3_400);
  assert.equal(week.spent.nakit, 600);
  assert.equal(week.remaining.nakit, 3_400);

  data.haftalik_harcamalar.push({ id: "cash-3400", tur: "nakit", tutar: 3_400, cuzdan_takibine_dahil: true, tarih: "2026-08-24", butce_haftasi: "2026-08-24", olusturma_zamani: "2026-08-24T11:00:00.000Z" });
  live = liveFinancial(data, data.guncel_durum, calcDate);
  week = weeklySummary(data, calcDate);
  assert.equal(live.garanti_bakiye, -49_162.83);
  assert.equal(walletState(data).bakiye, 0);
  assert.equal(week.spent.nakit, 4_000);
  assert.equal(week.remaining.nakit, 0);

  data.haftalik_harcamalar.push({ id: "cash-500", tur: "nakit", tutar: 500, cuzdan_takibine_dahil: true, tarih: "2026-08-24", butce_haftasi: "2026-08-24", olusturma_zamani: "2026-08-24T12:00:00.000Z" });
  live = liveFinancial(data, data.guncel_durum, calcDate);
  week = weeklySummary(data, calcDate);
  assert.equal(live.garanti_bakiye, -49_662.83);
  assert.equal(week.spent.nakit, 4_500);
  assert.equal(week.remaining.nakit, -500);
});

test("hafta değişince cüzdan devreder, haftalık harcama sıfırdan başlar", () => {
  const data = fixture({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-23", olusturma_zamani: "2026-08-23T09:00:00.000Z" }],
    haftalik_harcamalar: [{ id: "old-week", tur: "nakit", tutar: 3_000, cuzdan_takibine_dahil: true, tarih: "2026-08-23", butce_haftasi: "2026-08-17", olusturma_zamani: "2026-08-23T10:00:00.000Z" }],
  });
  const monday = new Date("2026-08-24T12:00:00.000Z");
  let week = weeklySummary(data, monday);
  assert.equal(walletState(data).bakiye, 1_000);
  assert.equal(week.spent.nakit, 0);
  assert.equal(week.remaining.nakit, 4_000);

  data.haftalik_harcamalar.push({ id: "new-week", tur: "nakit", tutar: 1_500, cuzdan_takibine_dahil: true, tarih: "2026-08-24", butce_haftasi: "2026-08-24", olusturma_zamani: "2026-08-24T10:00:00.000Z" });
  week = weeklySummary(data, monday);
  assert.deepEqual(walletState(data).allocations.get("new-week"), { cuzdan: 1_000, kmh: 500 });
  assert.equal(walletState(data).bakiye, 0);
  assert.equal(week.spent.nakit, 1_500);
  assert.equal(week.remaining.nakit, 2_500);
});

test("ay değişince önceki aydan kalan cüzdan yeni ayda kullanılmaya devam eder", () => {
  const data = fixture({
    guncel_durum: {
      tarih: "2026-08-31",
      takip_baslangic_zamani: "2026-08-31T08:00:00.000Z",
      garanti_bakiye: -45_162.83,
      yk_toplam_borc: 89_081.51,
      yk_kullanilabilir: 15_126.10,
      yk_limit: 106_400,
      gelir_parcalari: [],
    },
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-31", olusturma_zamani: "2026-08-31T09:00:00.000Z" }],
    haftalik_harcamalar: [
      { id: "august", tur: "nakit", tutar: 3_300, cuzdan_takibine_dahil: true, tarih: "2026-08-31", butce_haftasi: "2026-08-31", olusturma_zamani: "2026-08-31T10:00:00.000Z" },
      { id: "september", tur: "nakit", tutar: 1_000, cuzdan_takibine_dahil: true, tarih: "2026-09-01", butce_haftasi: "2026-08-31", olusturma_zamani: "2026-09-01T10:00:00.000Z" },
    ],
  });
  const state = walletState(data);
  assert.deepEqual(state.allocations.get("september"), { cuzdan: 700, kmh: 300 });
  assert.equal(state.bakiye, 0);
  const septemberLive = liveFinancial(data, data.guncel_durum, new Date("2026-09-01T12:00:00.000Z"));
  assert.equal(septemberLive.garanti_bakiye, -49_462.83);
});

test("yeni banka fotoğrafı eski ay çekimini tekrar saymadan cüzdanı korur", () => {
  const data = fixture({
    guncel_durum: {
      tarih: "2026-09-01",
      takip_baslangic_zamani: "2026-09-01T08:00:00.000Z",
      garanti_bakiye: -49_162.83,
      yk_toplam_borc: 89_081.51,
      yk_kullanilabilir: 15_126.10,
      yk_limit: 106_400,
      gelir_parcalari: [],
    },
    cuzdan_hareketleri: [{ id: "withdraw", tur: "nakit_cekimi", tutar: 4_000, tarih: "2026-08-31", olusturma_zamani: "2026-08-31T09:00:00.000Z" }],
    haftalik_harcamalar: [
      { id: "august", tur: "nakit", tutar: 3_300, cuzdan_takibine_dahil: true, tarih: "2026-08-31", butce_haftasi: "2026-08-31", olusturma_zamani: "2026-08-31T10:00:00.000Z" },
      { id: "september", tur: "nakit", tutar: 600, cuzdan_takibine_dahil: true, tarih: "2026-09-01", butce_haftasi: "2026-08-31", olusturma_zamani: "2026-09-01T10:00:00.000Z" },
    ],
  });
  assert.equal(walletState(data).bakiye, 100);
  assert.deepEqual(walletState(data).allocations.get("september"), { cuzdan: 600, kmh: 0 });
  assert.equal(liveFinancial(data, data.guncel_durum, new Date("2026-09-01T12:00:00.000Z")).garanti_bakiye, -49_162.83);
});
