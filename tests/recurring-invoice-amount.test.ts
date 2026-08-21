import assert from "node:assert/strict";
import test from "node:test";
import {
  carriesForwardPaymentAmount,
  clearFuturePaymentOverrides,
  fillMissingPaymentTypes,
  normalize,
  paymentAmount,
} from "../app/lib/budget-engine";

test("eski boş ödeme türleri adlarına göre güvenle tamamlanır", () => {
  const payments = [
    { ad: "Yapı Kredi Kartı", tur: "" },
    { ad: "Aidat" },
    { ad: "Garanti Kredisi", tur: "kredi" },
    { ad: "Bilinmeyen ödeme" },
  ];

  assert.equal(fillMissingPaymentTypes(payments), true);
  assert.equal(payments[0].tur, "kart");
  assert.equal(payments[1].tur, "fatura");
  assert.equal(payments[2].tur, "kredi");
  assert.equal(payments[3].tur, undefined);
  assert.equal(fillMissingPaymentTypes(payments), false);
});

test("faturalar ve aidat ileri taşınan ödeme türleridir", () => {
  assert.equal(carriesForwardPaymentAmount({ ad: "Elektrik", tur: "fatura" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "Aidat", tur: "diger" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "AİDAT", tur: "diger" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "Doğalgaz", tur: "kredi" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "Elektrik", tur: "kredi" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "Su", tur: "kredi" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "Cep Telefonu", tur: "kredi" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "İnternet", tur: "kredi" }), true);
  assert.equal(carriesForwardPaymentAmount({ ad: "Garanti Kredisi", tur: "kredi" }), false);
  assert.equal(carriesForwardPaymentAmount({ ad: "Kreş", tur: "taksit" }), false);
});

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

test("güncel fatura kaydedilince eski gelecek ay tahminleri temizlenir", () => {
  const invoiceId = 77;
  const data = normalize({
    aylik_tutar_override: {
      [`2026-07-${invoiceId}`]: 1_400,
      [`2026-08-${invoiceId}`]: 1_500,
      [`2026-09-${invoiceId}`]: 1_332,
      [`2026-10-${invoiceId}`]: 1_600,
      "2026-09-88": 900,
    },
  });

  clearFuturePaymentOverrides(data, invoiceId, 2026, 8);

  assert.deepEqual(data.aylik_tutar_override, {
    [`2026-07-${invoiceId}`]: 1_400,
    [`2026-08-${invoiceId}`]: 1_500,
    "2026-09-88": 900,
  });
});
