import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activeWeeklySummary, normalize } from "../app/lib/budget-engine";

const pageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const weeklySource = pageSource.slice(pageSource.indexOf("function Weekly("));
const dashboardSource = pageSource.slice(0, pageSource.indexOf("function Weekly("));

test("Haftalık ekran birikimli geçmiş farkını yeniden göstermez", () => {
  assert.doesNotMatch(weeklySource, /Birikimli nakit hedefi/);
  assert.match(weeklySource, /Kart <b>\{trMoney\(week\.spent\.kart\)\}/);
  assert.match(weeklySource, /Nakit <b>\{trMoney\(week\.spent\.nakit\)\}/);
});

test("Özet ekranındaki gösterge yalnız güncel ayı adlandırır", () => {
  assert.match(dashboardSource, /currentMonthName.*nakit hedefi/);
  assert.match(dashboardSource, /currentMonthName.*kart hedefi/);
  assert.doesNotMatch(dashboardSource, /Birikimli nakit hedefi/);
});

test("geçmiş haftanın nakit aşımı aktif haftanın rakamlarına taşınmaz", () => {
  const data = normalize({
    butce_plani: { butce_baslangic_tarihi: "2026-08-17" },
    haftalik_hedefler: { kart: 7_200, nakit: 4_000 },
    haftalik_kapanislar: {
      "2026-08-17": {
        baslangic: "2026-08-17",
        bitis: "2026-08-23",
        kart: 8_000,
        nakit: 5_000,
      },
    },
  });

  const week = activeWeeklySummary(data, new Date("2026-08-24T00:00:00Z"));
  assert.equal(week.spent.nakit, 0);
  assert.equal(week.goal.nakit, 4_000);
  assert.equal(week.remaining.nakit, 4_000);
});

test("eksik ve hatalı eski veri haftalık ekran hesabını çökertmez", () => {
  const data = normalize({
    haftalik_hedefler: null,
    haftalik_harcamalar: "hatalı",
    haftalik_kapanislar: [],
    bilinmeyen_eklenti_alani: { korunacak: true },
  });

  const week = activeWeeklySummary(data, new Date("2026-08-24T00:00:00Z"));
  assert.equal(week.spent.kart, 0);
  assert.equal(week.spent.nakit, 0);
  assert.equal(week.goal.kart, 6_300);
  assert.equal(week.goal.nakit, 2_800);
  assert.deepEqual(data.bilinmeyen_eklenti_alani, { korunacak: true });
});
