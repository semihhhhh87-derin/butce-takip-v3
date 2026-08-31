import assert from "node:assert/strict";
import test from "node:test";
import { effectiveDay, isTurkishPublicHoliday } from "../app/lib/budget-engine";

test("sabit resmî tatil önceki iş gününe taşınır", () => {
  assert.equal(effectiveDay(2026, 10, 29).toISOString().slice(0, 10), "2026-10-27");
});

test("resmî tatilden önce hafta sonu varsa önceki iş gününe taşınır", () => {
  assert.equal(effectiveDay(2026, 5, 29).toISOString().slice(0, 10), "2026-05-25");
});

test("hareketli resmî tatil takvimi tanınır", () => {
  assert.equal(isTurkishPublicHoliday(new Date("2027-03-09T00:00:00Z")), true);
  assert.equal(effectiveDay(2027, 3, 9).toISOString().slice(0, 10), "2027-03-05");
});

test("normal iş günü değişmeden kalır", () => {
  assert.equal(effectiveDay(2026, 8, 21).toISOString().slice(0, 10), "2026-08-21");
});
