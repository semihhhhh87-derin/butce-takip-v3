import test from "node:test";
import assert from "node:assert/strict";
import { installmentMonthlyAmount, installmentTotalAmount } from "../app/lib/budget-engine";

test("eski Superstep aylık kaydı toplam tutara çevrilip geri açıldığında değişmez", () => {
  const legacy = { tutar: 602.3, taksit_sayisi: 4 };
  const total = installmentTotalAmount(legacy);
  assert.equal(total, 2409.2);
  assert.equal(installmentMonthlyAmount(total, legacy.taksit_sayisi), 602.3);
});

test("eski Bilsoy kreş satırları tek taksit olduğu için tutarlarını aynen korur", () => {
  for (const amount of [2937, 7272, 11607, 13005, 8670, 4335]) {
    const legacy = { tutar: amount, taksit_sayisi: 1 };
    assert.equal(installmentTotalAmount(legacy), amount);
    assert.equal(installmentMonthlyAmount(amount, 1), amount);
  }
});

test("2.099 TL toplam üç taksite aylık eşit dağıtılır", () => {
  const monthly = installmentMonthlyAmount(2099, 3);
  assert.equal(monthly, 2099 / 3);
  assert.equal(monthly * 3, 2099);
});
