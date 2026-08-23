import assert from "node:assert/strict";
import test from "node:test";
import { mergeChanged } from "../app/lib/merge-changed";

test("iki cihazın farklı kimlikli cüzdan hareketleri kaybolmadan birleşir", () => {
  const base = { cuzdan_hareketleri: [] },
    deviceA = { cuzdan_hareketleri: [{ id: "a", tur: "nakit_cekimi", tutar: 4_000 }] },
    serverWithB = { cuzdan_hareketleri: [{ id: "b", tur: "bakiye_duzeltme", bakiye: 0 }] },
    merged = mergeChanged(base, deviceA, serverWithB);
  assert.deepEqual(new Set(merged.cuzdan_hareketleri.map((x: { id: string }) => x.id)), new Set(["a", "b"]));
});

test("çevrimdışı kayıt yeniden gönderilince aynı kimlik iki kez oluşmaz", () => {
  const base = { cuzdan_hareketleri: [] },
    pending = { cuzdan_hareketleri: [{ id: "offline", tur: "nakit_cekimi", tutar: 4_000 }] },
    alreadySaved = { cuzdan_hareketleri: [{ id: "offline", tur: "nakit_cekimi", tutar: 4_000 }] },
    merged = mergeChanged(base, pending, alreadySaved);
  assert.equal(merged.cuzdan_hareketleri.length, 1);
  assert.equal(merged.cuzdan_hareketleri[0].tutar, 4_000);
});
