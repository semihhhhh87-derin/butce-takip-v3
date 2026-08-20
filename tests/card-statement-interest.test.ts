import assert from "node:assert/strict";
import test from "node:test";
import { cardRateTier, cardReductionAdvice, cardStatementInterest } from "../app/lib/budget-engine";

test("TCMB kart faiz kademesi dönem borcuna göre seçilir", () => {
  assert.deepEqual(cardRateTier(29_999.99), { contractual: 0.0325 });
  assert.deepEqual(cardRateTier(75_009.78), { contractual: 0.0375 });
  assert.deepEqual(cardRateTier(180_000.01), { contractual: 0.0425 });
});

test("asgari ödeme zamanında yapıldığında yalnız günlük akdi faiz hesaplanır", () => {
  const result = cardStatementInterest({
    hesap_kesim_tarihi: "2026-08-09",
    son_odeme_tarihi: "2026-08-19",
    sonraki_hesap_kesim_tarihi: "2026-09-08",
    odeme_tarihi: "2026-08-18",
    donem_borcu: 75_009.78,
    asgari_tutar: 30_003.91,
    odenen_tutar: 30_003.91,
    kalan_donem_borcu: 44_881.79,
    donem_faizi: 1_404.49,
    yillik_kart_ucreti: 1_257.99,
  });
  const eligibleOpening = 75_009.78 - 1_404.49 - 1_257.99;
  const eligibleRemaining = eligibleOpening - 30_003.91;
  const expectedContractual =
    eligibleOpening * (0.0375 / 30) * 9 +
    eligibleRemaining * (0.0375 / 30) * 21;
  assert.equal(result.valid, true);
  assert.equal(result.minimumMet, true);
  assert.equal(result.paymentOnTime, true);
  assert.equal(result.lateInterest, 0);
  assert.ok(Math.abs(result.contractualInterest - expectedContractual) < 0.001);
  assert.ok(Math.abs(result.total - expectedContractual * 1.3) < 0.001);
});

test("asgari üzerindeki gerçek ödeme faiz matrahını daha fazla azaltır", () => {
  const base = {
    hesap_kesim_tarihi: "2026-08-09",
    son_odeme_tarihi: "2026-08-19",
    sonraki_hesap_kesim_tarihi: "2026-09-08",
    odeme_tarihi: "2026-08-18",
    donem_borcu: 75_000,
    asgari_tutar: 30_000,
  };
  const minimum = cardStatementInterest({ ...base, odenen_tutar: 30_000 });
  const extra = cardStatementInterest({ ...base, odenen_tutar: 40_000 });
  assert.ok(extra.total < minimum.total);
  assert.equal(extra.minimumMet, true);
});

test("yalnız dört ana alanla tarihler ve kalan borç otomatik tamamlanır", () => {
  const result = cardStatementInterest({
    hesap_kesim_tarihi: "2026-09-08",
    donem_borcu: 60_000,
    asgari_tutar: 24_000,
    odenen_tutar: 30_000,
    kalan_donem_borcu: "",
  });
  assert.equal(result.valid, true);
  assert.equal(result.dueDate, "2026-09-18");
  assert.equal(result.nextCutDate, "2026-10-08");
  assert.equal(result.reportedRemaining, 30_000);
  assert.equal(result.assumedDueDate, true);
  assert.equal(result.assumedNextCutDate, true);
  assert.equal(result.assumedPaymentDate, true);
});

test("kart azaltma eşiği yeni harcama ve faizin bir kuruş üzeridir", () => {
  const result = cardReductionAdvice(
    { kart_yeni_harcama: 12_000, kart_faiz: 2_500 },
    { asgari_tutar: 30_000, odenen_tutar: 35_000 },
  );
  assert.equal(result.paymentNow, 14_500.01);
  assert.equal(result.totalCardPayment, 49_500.01);
  assert.equal(result.aboveMinimum, 19_500.01);
  assert.equal(result.kmhIncrease, 14_500.01);
  assert.equal(result.combinedDebtChangeAtPayment, 0);
});
