import assert from "node:assert/strict";
import test from "node:test";
import {
  monthlyCardTargetReview,
  monthlySpendingSummary,
  normalize,
  weeklyGoal,
} from "../app/lib/budget-engine";

function septemberData() {
  return normalize({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    haftalik_kapanislar: {
      "2026-08-17": {
        baslangic: "2026-08-17",
        bitis: "2026-08-23",
        kart: 6_300,
        nakit: 900,
      },
    },
    haftalik_harcamalar: [
      { tarih: "2026-08-10", butce_haftasi: "2026-08-10", tur: "kart", tutar: 99_000 },
      // Kapanışla örtüştüğü için ikinci kez sayılmamalı.
      { tarih: "2026-08-20", butce_haftasi: "2026-08-17", tur: "kart", tutar: 6_300 },
      { tarih: "2026-08-25", butce_haftasi: "2026-08-24", tur: "kart", tutar: 7_200 },
      { tarih: "2026-08-26", butce_haftasi: "2026-08-24", tur: "nakit", tutar: 5_000 },
    ],
    odemeler: [
      {
        id: "kres",
        ad: "Kreş",
        aktif: true,
        odeme_gunu: 18,
        tutar: 7_272,
        odeme_kaynagi: "kredi_karti",
        kart_tavanina_dahil: true,
      },
      {
        id: "cep",
        ad: "Cep Telefonu",
        aktif: true,
        odeme_gunu: 18,
        tutar: 880,
        odeme_kaynagi: "kredi_karti",
        kart_tavanina_dahil: true,
      },
    ],
  });
}

test("Eylül ay başı kart hedefi gerçek gün oranıyla hesaplanır", () => {
  const result = monthlyCardTargetReview(
    septemberData(),
    new Date("2026-09-01T00:00:00Z"),
  );

  assert.equal(result.elapsedDays, 15);
  assert.equal(result.freeCardTotal, 13_500);
  assert.equal(result.freeWeeklyTrend, 6_300);
  assert.equal(result.fixedMonthly, 8_152);
  assert.equal(Math.round(result.fixedWeekly * 100) / 100, 1_902.13);
  assert.equal(Math.round(result.usableWeeklyLimit * 100) / 100, 5_297.87);
  assert.equal(Math.round(Number(result.suggestedGrossTarget) * 100) / 100, 8_202.13);
});

test("kart kaydı yoksa sabit yük gösterilir ama eğilim uydurulmaz", () => {
  const data = septemberData();
  data.haftalik_kapanislar = {};
  data.haftalik_harcamalar = [{ tarih: "2026-08-25", tur: "nakit", tutar: 500 }];
  const result = monthlyCardTargetReview(data, new Date("2026-09-02T00:00:00Z"));

  assert.equal(result.hasTrend, false);
  assert.equal(result.freeWeeklyTrend, null);
  assert.equal(result.suggestedGrossTarget, null);
  assert.equal(result.fixedMonthly, 8_152);
});

test("banner, Haftalık ve Aylık aynı gerçek gün kart limitini üretir", () => {
  const data = septemberData();
  const review = monthlyCardTargetReview(data, new Date("2026-09-01T00:00:00Z"));
  const week = weeklyGoal(
    data,
    new Date("2026-09-07T00:00:00Z"),
    new Date("2026-09-13T00:00:00Z"),
  );
  const month = monthlySpendingSummary(data, new Date("2026-09-01T00:00:00Z"));
  const monthlyAsWeekly = month.goal.kart / month.days * 7;

  assert.equal(Math.round(review.usableWeeklyLimit * 100) / 100, 5_297.87);
  assert.equal(Math.round(week.goal.kart * 100) / 100, 5_297.87);
  assert.equal(Math.round(monthlyAsWeekly * 100) / 100, 5_297.87);
});
