import assert from "node:assert/strict";
import test from "node:test";
import { normalize, weeklyCarryAdjustment, weeklyGoal } from "../app/lib/budget-engine";

test("haftalık hedef bütçe miladından önceki sabit kart ödemesini düşmez", () => {
  const data = normalize({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    odemeler: [{
      id: "erken-kart",
      aktif: true,
      gun: 10,
      tutar: 3_817,
      odeme_kaynagi: "kredi_karti",
      kart_tavanina_dahil: true,
    }],
  });
  const goal = weeklyGoal(
    data,
    new Date("2026-08-17T00:00:00Z"),
    new Date("2026-08-23T00:00:00Z"),
  );
  assert.equal(goal.goal.kart, 7_200);
});

test("banka fotoğrafı tarihi haftalık kullanılabilir kart hedefini değiştirmez", () => {
  const base = {
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    odemeler: [{
      id: "sabit-kart",
      aktif: true,
      gun: 22,
      tutar: 3_817,
      odeme_kaynagi: "kredi_karti",
      kart_tavanina_dahil: true,
    }],
  };
  const beforePhoto = normalize({
    ...base,
    guncel_durum: { tarih: "2026-08-17" },
  });
  const afterPhoto = normalize({
    ...base,
    guncel_durum: { tarih: "2026-08-21" },
  });
  const start = new Date("2026-08-17T00:00:00Z");
  const end = new Date("2026-08-23T00:00:00Z");

  const first = weeklyGoal(beforePhoto, start, end).goal.kart;
  const second = weeklyGoal(afterPhoto, start, end).goal.kart;

  assert.equal(Math.round(first * 100) / 100, 5_418.73);
  assert.equal(Math.round(second * 100) / 100, 5_418.73);
});

test("haftalık taşıma bütçe miladından önceki kapanışları yok sayar", () => {
  const data = normalize({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    haftalik_kapanislar: {
      "2026-08-10": {
        baslangic: "2026-08-10",
        bitis: "2026-08-16",
        kart: 2_601.62,
        nakit: 0,
      },
    },
  });

  assert.deepEqual(
    weeklyCarryAdjustment(data, new Date("2026-08-21T00:00:00Z")),
    { kart: 0, nakit: 0, total: 0, source: "net-defter" },
  );
});

test("milattan sonraki kapanmış haftanın aşımı sonraki haftaya taşınır", () => {
  const data = normalize({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    haftalik_kapanislar: {
      "2026-08-17": {
        baslangic: "2026-08-17",
        bitis: "2026-08-23",
        kart: 8_000,
        nakit: 4_000,
      },
    },
  });

  const result = weeklyCarryAdjustment(
    data,
    new Date("2026-08-31T00:00:00Z"),
  );
  assert.equal(Math.round(result.total * 100) / 100, 800);
  assert.equal(Math.round(result.kart * 100) / 100, 800);
  assert.equal(result.nakit, 0);
});
