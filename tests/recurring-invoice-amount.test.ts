import assert from "node:assert/strict";
import test from "node:test";
import { normalize, paymentAmount } from "../app/lib/budget-engine";

test("faturanın son girilen tutarı yeni bir değişikliğe kadar ileri taşınır", () => {
  const invoiceId = 77;
  const data = normalize({
    odemeler: [
      {
        id: invoiceId,
        ad: "Elektrik",
        tur: "fatura",
        tutar: 1_500,
        aktif: true,
        baslangic_ay: "2026-08",
      },
    ],
    aylik_tutar_override: {
      [`2026-08-${invoiceId}`]: 1_631,
      [`2026-09-${invoiceId}`]: 1_500,
      [`2026-12-${invoiceId}`]: 1_700,
    },
  });
  const invoice = data.odemeler[0];

  assert.equal(paymentAmount(data, invoice, 2026, 8), 1_631);
  assert.equal(paymentAmount(data, invoice, 2026, 9), 1_500);
  assert.equal(paymentAmount(data, invoice, 2026, 10), 1_500);
  assert.equal(paymentAmount(data, invoice, 2026, 11), 1_500);
  assert.equal(paymentAmount(data, invoice, 2026, 12), 1_700);
  assert.equal(paymentAmount(data, invoice, 2027, 1), 1_700);
});
