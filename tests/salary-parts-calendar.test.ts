import test from "node:test";
import assert from "node:assert/strict";
import { incomeStatus, normalize, salaryParts, scheduledIncomeRemaining } from "../app/lib/budget-engine";

function data() {
  return normalize({
    ayarlar: {
      maas_takvimi: [
        { baslangic_ay: "2026-09", tutar: 100_500, gelir_parcalari: [
          { gun: 5, tutar: 28_000, kaynak: "Eş" },
          { gun: 10, tutar: 48_333.33, kaynak: "Kullanıcı 2/3" },
          { gun: 20, tutar: 24_166.67, kaynak: "Kullanıcı 1/3" },
        ] },
        { baslangic_ay: "2026-10", tutar: 111_530.48, gelir_parcalari: [
          { gun: 5, tutar: 39_030.48, kaynak: "Eş" },
          { gun: 10, tutar: 48_333.33, kaynak: "Kullanıcı 2/3" },
          { gun: 20, tutar: 24_166.67, kaynak: "Kullanıcı 1/3" },
        ] },
        { baslangic_ay: "2026-11", tutar: 100_500, gelir_parcalari: [
          { gun: 5, tutar: 28_000, kaynak: "Eş" },
          { gun: 10, tutar: 48_333.33, kaynak: "Kullanıcı 2/3" },
          { gun: 20, tutar: 24_166.67, kaynak: "Kullanıcı 1/3" },
        ] },
        { baslangic_ay: "2027-02", tutar: 120_600, gelir_parcalari: [
          { gun: 5, tutar: 33_600, kaynak: "Eş" },
          { gun: 10, tutar: 58_000, kaynak: "Kullanıcı 2/3" },
          { gun: 20, tutar: 29_000, kaynak: "Kullanıcı 1/3" },
        ] },
      ],
    },
    guncel_durum: {
      tarih: "2026-09-04",
      ay_kalan_gelir: 72_500,
      gelir_parcalari: [
        { gun: 5, tutar: 28_000, kaynak: "Eş" },
        { gun: 10, tutar: 48_333.33, kaynak: "Kullanıcı 2/3" },
        { gun: 20, tutar: 24_166.67, kaynak: "Kullanıcı 1/3" },
      ],
    },
  });
}

test("aylık maaş parçaları kayıtlı dönem dağılımını aynen kullanır", () => {
  const d = data();
  assert.deepEqual(salaryParts(d, d.guncel_durum, 2026, 10).map((x) => x.tutar), [39_030.48, 48_333.33, 24_166.67]);
  assert.deepEqual(salaryParts(d, d.guncel_durum, 2027, 2).map((x) => x.tutar), [33_600, 58_000, 29_000]);
});

test("4 Eylül fotoğrafından sonra kalan iki Eylül maaşı gününde eklenir", () => {
  const d = data();
  assert.deepEqual(incomeStatus(d, d.guncel_durum, new Date("2026-09-10T00:00:00Z")), { received: 48_333.33, remaining: 24_166.67 });
  assert.deepEqual(incomeStatus(d, d.guncel_durum, new Date("2026-09-18T00:00:00Z")), { received: 72_500, remaining: 0 });
});

test("yeni ay fotoğrafında yalnız henüz yatmamış dönem parçaları kalır", () => {
  const d = data();
  assert.equal(scheduledIncomeRemaining(d, d.guncel_durum, new Date("2026-10-05T00:00:00Z")), 72_500);
  assert.equal(scheduledIncomeRemaining(d, d.guncel_durum, new Date("2027-02-04T00:00:00Z")), 120_600);
});
