import assert from "node:assert/strict";
import test from "node:test";
import { monthlySpendingSummary, normalize } from "../app/lib/budget-engine";

function data() {
  return normalize({
    butce_plani: {
      butce_baslangic_tarihi: "2026-08-17",
      haftalik_ay_carpani: 52 / 12,
    },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    odemeler: [
      {
        id: "once",
        aktif: true,
        gun: 10,
        tutar: 1_000,
        odeme_kaynagi: "kredi_karti",
        kart_tavanina_dahil: true,
      },
      {
        id: "donemde",
        aktif: true,
        gun: 20,
        tutar: 3_817,
        odeme_kaynagi: "kredi_karti",
        kart_tavanina_dahil: true,
      },
    ],
    haftalik_harcamalar: [
      { tarih: "2026-08-16", tur: "kart", tutar: 900 },
      { tarih: "2026-08-18", tur: "kart", tutar: 500 },
      { tarih: "2026-08-19", tur: "nakit", tutar: 250 },
    ],
  });
}

test("kısmi ay yalnız dönem içindeki sabit kart ödemesini hedefe dahil eder", () => {
  const result = monthlySpendingSummary(data(), new Date("2026-08-21T00:00:00Z"));
  assert.equal(result.days, 15);
  assert.equal(result.fixedCard, 3_817);
  assert.deepEqual(result.spent, { kart: 500, nakit: 250 });
  assert.equal(Math.round(result.goal.kart * 100) / 100, 11_611.57);
});

test("tam ayda ay içindeki bütün uygun sabit kart ödemeleri ayrılır", () => {
  const d = data();
  d.butce_plani.butce_baslangic_tarihi = "2026-07-01";
  const result = monthlySpendingSummary(d, new Date("2026-08-21T00:00:00Z"));
  assert.equal(result.days, 31);
  assert.equal(result.fixedCard, 4_817);
});

test("kapanmış haftanın silinen ayrıntıları aylık toplamda korunur", () => {
  const d = data();
  d.haftalik_kapanislar["2026-08-17"] = {
    baslangic: "2026-08-17",
    bitis: "2026-08-23",
    kart: 3_500,
    nakit: 1_400,
  };
  d.haftalik_harcamalar = [];
  const result = monthlySpendingSummary(d, new Date("2026-08-24T00:00:00Z"));
  assert.deepEqual(result.spent, { kart: 3_500, nakit: 1_400 });
});

test("kapanışla birlikte kalan eski ayrıntı iki kez sayılmaz", () => {
  const d = data();
  d.haftalik_kapanislar["2026-08-17"] = {
    baslangic: "2026-08-17",
    bitis: "2026-08-23",
    kart: 3_500,
    nakit: 1_400,
  };
  const result = monthlySpendingSummary(d, new Date("2026-08-24T00:00:00Z"));
  assert.deepEqual(result.spent, { kart: 3_500, nakit: 1_400 });
});
