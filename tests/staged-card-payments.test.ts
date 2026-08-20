import assert from "node:assert/strict";
import test from "node:test";
import { calculateMonth, normalize, partialCardPaymentTotal } from "../app/lib/budget-engine";

test("kademeli kart ödemeleri yalnız ilgili ödeme kaydına yazılır", () => {
  const data = normalize({
    kart_kademeli_odemeler: [
      { id: 11, odeme_id: 101, yil: 2026, ay: 8, tutar: 1_000 },
      { id: 12, odeme_id: 202, yil: 2026, ay: 8, tutar: 2_500 },
      { id: 13, odeme_id: 101, yil: 2026, ay: 8, tutar: 750 },
      { id: 14, odeme_id: 101, yil: 2026, ay: 9, tutar: 9_000 },
    ],
  });

  assert.equal(partialCardPaymentTotal(data, 2026, 8, 101), 1_750);
  assert.equal(partialCardPaymentTotal(data, 2026, 8, 202), 2_500);
  assert.equal(partialCardPaymentTotal(data, 2026, 9, 101), 9_000);
  assert.equal(partialCardPaymentTotal(data, 2026, 8, 999), 0);
});

test("iki kart ödeme planının yalnız kendi kademeli tutarı düşülür", () => {
  const data = normalize({
    guncel_durum: {
      tarih: "2026-08-01",
      takip_baslangic_zamani: "2026-08-01T00:00:00.000Z",
      garanti_bakiye: -10_000,
      yk_toplam_borc: 100_000,
      yk_kullanilabilir: 20_000,
      yk_limit: 120_000,
      ay_kalan_gelir: 0,
    },
    odemeler: [
      { id: 101, ad: "Kart A", tutar: 10_000, odeme_gunu: 10, aktif: true, odeme_kaynagi: "banka", kart_borc_odeme: true },
      { id: 202, ad: "Kart B", tutar: 20_000, odeme_gunu: 15, aktif: true, odeme_kaynagi: "banka", kart_borc_odeme: true },
    ],
    kart_kademeli_odemeler: [
      { id: 11, odeme_id: 101, yil: 2026, ay: 8, tutar: 1_000, olusturma_zamani: "2026-08-02T00:00:00.000Z" },
      { id: 12, odeme_id: 202, yil: 2026, ay: 8, tutar: 2_500, olusturma_zamani: "2026-08-03T00:00:00.000Z" },
    ],
  });

  const month = calculateMonth(data, 2026, 8, {}, new Date("2026-08-10T00:00:00.000Z"));
  assert.equal(month.kart_taban_odeme, 30_000);
  assert.equal(month.kart_odeme, 26_500);
  assert.equal(month.kalan_sabit_odemeler, 26_500);
});
