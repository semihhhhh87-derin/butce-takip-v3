import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_RETENTION_MS,
  activityFromOtherDevice,
  normalize,
  pruneActivityLog,
  recentActivityLog,
} from "../app/lib/budget-engine";

const now = Date.parse("2026-08-22T12:00:00.000Z");
const event = (id: string, hoursAgo: number, device = "other") => ({
  id,
  tur: "harcama_eklendi",
  harcama_id: id,
  kaynak_cihaz_id: device,
  olusturma_zamani: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
});

test("hareket günlüğü yalnız son 48 saati tutar", () => {
  const data = normalize({ hareket_gunlugu: [
    event("new", 1),
    event("edge", 48),
    event("old", 48.01),
  ] });

  assert.equal(ACTIVITY_RETENTION_MS, 48 * 60 * 60 * 1000);
  assert.deepEqual(recentActivityLog(data, now).map((item) => item.id), ["new", "edge"]);
  assert.equal(pruneActivityLog(data, now), true);
  assert.deepEqual(data.hareket_gunlugu.map((item) => item.id), ["new", "edge"]);
});

test("aynı cihazın harcaması bildirim üretmez ve bilinen kayıt tekrarlanmaz", () => {
  const data = normalize({ hareket_gunlugu: [
    event("own", 1, "this-device"),
    event("shown", 2, "other-device"),
    event("fresh", 3, "other-device"),
  ] });

  const result = activityFromOtherDevice(data, "this-device", ["shown"], now);
  assert.deepEqual(result.map((item) => item.id), ["fresh"]);
});

test("eski hareketler finansal harcamaları silmeden temizlenir", () => {
  const data = normalize({
    haftalik_harcamalar: [{ id: 10, tur: "kart", tutar: 250, tarih: "2026-08-19" }],
    hareket_gunlugu: [event("old", 72)],
  });

  pruneActivityLog(data, now);
  assert.equal(data.hareket_gunlugu.length, 0);
  assert.equal(data.haftalik_harcamalar.length, 1);
  assert.equal(data.haftalik_harcamalar[0].tutar, 250);
});
