import test from "node:test";
import assert from "node:assert/strict";
import { currentMonthTargetBalance, normalize } from "../app/lib/budget-engine.ts";

function data() {
  return normalize({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_000, nakit: 4_000 },
    haftalik_kapanislar: {
      "2026-08-24": { baslangic: "2026-08-24", bitis: "2026-08-30", kart: 9_000, nakit: 5_000 },
    },
    haftalik_harcamalar: [
      { id: "aug-card", tarih: "2026-08-31", butce_haftasi: "2026-08-31", tur: "kart", tutar: 2_000 },
      { id: "sep-card", tarih: "2026-09-01", butce_haftasi: "2026-08-31", tur: "kart", tutar: 100 },
      { id: "sep-cash", tarih: "2026-09-01", butce_haftasi: "2026-08-31", tur: "nakit", tutar: 200 },
    ],
    odemeler: [{
      id: 1, ad: "Taksit", tur: "taksit", tutar: 600, odeme_gunu: 18,
      baslangic_ay: "2026-09", bitis_ay: "2026-12", odeme_kaynagi: "kredi_karti",
      kart_tavanina_dahil: true, aktif: true,
    }],
  });
}

test("ay başında geçmiş ay ve haftanın Ağustos günü yeni aya taşınmaz", () => {
  const result = currentMonthTargetBalance(data(), new Date("2026-09-01T00:00:00Z"));
  assert.equal(result.elapsedDays, 1);
  assert.deepEqual(result.spent, { kart: 100, nakit: 200 });
  assert.equal(Math.round(result.card * 100) / 100, 880);
  assert.equal(Math.round(result.cash * 100) / 100, 371.43);
});

test("günlük katkı ay içinde gün sayısıyla birikir", () => {
  const d = data();
  d.haftalik_harcamalar = [];
  const result = currentMonthTargetBalance(d, new Date("2026-09-10T00:00:00Z"));
  assert.equal(result.elapsedDays, 10);
  assert.equal(Math.round(result.card * 100) / 100, 9_800);
  assert.equal(Math.round(result.cash * 100) / 100, 5_714.29);
});

test("yeni ay önceki ayın farkını sıfırlar", () => {
  const d = data();
  d.haftalik_harcamalar = [];
  const result = currentMonthTargetBalance(d, new Date("2026-10-01T00:00:00Z"));
  assert.equal(result.elapsedDays, 1);
  assert.equal(Math.round(result.card * 100) / 100, 980.65);
  assert.equal(Math.round(result.cash * 100) / 100, 571.43);
});
