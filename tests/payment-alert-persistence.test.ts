import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("yaklaşan ve geciken ödeme uyarıları ödendi olana kadar kapatılamaz", () => {
  assert.match(source, /if \(overduePayments\.length > 0\)/);
  assert.match(source, /if \(upcomingPayments\.length > 0\)/);
  assert.match(source, /a\.key !== "upcoming" && a\.key !== "overdue"/);
  assert.match(source, /type: "warn"/);
  assert.match(source, /" paymentAlert"/);
  assert.doesNotMatch(source, /overduePayments\.length > 0 && !dismissedAlerts/);
  assert.doesNotMatch(source, /upcomingPayments\.length > 0 && !dismissedAlerts/);
});
