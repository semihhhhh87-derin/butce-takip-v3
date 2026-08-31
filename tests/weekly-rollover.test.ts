import assert from "node:assert/strict";
import test from "node:test";
import { activeWeeklySummary, normalize, weeklyGoal } from "../app/lib/budget-engine";

function scenario() {
  return normalize({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 8_200, nakit: 4_000 },
    odemeler: [{
      id: "fixed-card", ad: "Eylül taksidi", aktif: true, tur: "taksit",
      tutar: 6_200, odeme_gunu: 18, baslangic_ay: "2026-09", bitis_ay: "2026-09",
      odeme_kaynagi: "kredi_karti", kart_tavanina_dahil: true,
    }],
    haftalik_harcamalar: [
      { id: "aug", tarih: "2026-08-31", butce_haftasi: "2026-08-31", tur: "kart", tutar: 8_000 },
      { id: "sep-card", tarih: "2026-09-01", butce_haftasi: "2026-08-31", tur: "kart", tutar: 100 },
      { id: "sep-cash", tarih: "2026-09-02", butce_haftasi: "2026-08-31", tur: "nakit", tutar: 200 },
    ],
  });
}

test("31 Ağustos haftasının tüm işlemleri yalnız kendi haftalık limitini azaltır", () => {
  const week = activeWeeklySummary(scenario(), new Date("2026-09-02T00:00:00Z"));
  assert.deepEqual(week.spent, { kart: 8_100, nakit: 200 });
  assert.equal(week.remaining.kart, week.goal.kart - 8_100);
  assert.equal(week.remaining.nakit, week.goal.nakit - 200);
});

test("hafta kapanıp ayrıntılar silinince 7 Eylül haftalık limiti temiz başlar", () => {
  const d = scenario();
  d.haftalik_kapanislar["2026-08-31"] = {
    baslangic: "2026-08-31", bitis: "2026-09-06", kart: 8_100, nakit: 200,
    gunluk_toplamlar: {
      "2026-08-31": { kart: 8_000, nakit: 0 },
      "2026-09-01": { kart: 100, nakit: 0 },
      "2026-09-02": { kart: 0, nakit: 200 },
    },
  };
  d.haftalik_harcamalar = [];
  const target = new Date("2026-09-07T00:00:00Z"),
    week = activeWeeklySummary(d, target),
    expectedGoal = weeklyGoal(d, target, new Date("2026-09-13T00:00:00Z")).goal;
  assert.deepEqual(week.spent, { kart: 0, nakit: 0 });
  assert.deepEqual(week.goal, expectedGoal);
  assert.deepEqual(week.remaining, expectedGoal);
});
