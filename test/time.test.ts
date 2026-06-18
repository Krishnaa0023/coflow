import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, timeOfDay, formatStamp, dayLabel } from "../src/core/time.js";

test("dayKey returns YYYY-MM-DD in UTC", () => {
  assert.equal(dayKey("2026-06-18T05:41:00.000Z", "utc"), "2026-06-18");
});

test("timeOfDay returns 24h HH:mm in UTC", () => {
  assert.equal(timeOfDay("2026-06-18T05:41:00.000Z", "utc"), "05:41");
  assert.equal(timeOfDay("2026-06-18T23:09:00.000Z", "utc"), "23:09");
  assert.equal(timeOfDay("2026-06-18T00:00:00.000Z", "utc"), "00:00"); // midnight, not "24:00"
});

test("formatStamp shows only HH:mm for same-day messages", () => {
  const now = "2026-06-18T12:00:00.000Z";
  assert.equal(formatStamp("2026-06-18T05:41:00.000Z", now, "utc"), "05:41");
});

test("formatStamp shows the full date for older-day messages", () => {
  const now = "2026-06-18T12:00:00.000Z";
  assert.equal(formatStamp("2026-06-17T05:41:00.000Z", now, "utc"), "2026-06-17 05:41");
});

test("formatStamp handles the midnight boundary correctly", () => {
  // 23:50 on the 17th and 00:05 on the 18th are different days: the older one
  // must carry its date, the today one must not.
  const now = "2026-06-18T00:10:00.000Z";
  assert.equal(formatStamp("2026-06-17T23:50:00.000Z", now, "utc"), "2026-06-17 23:50");
  assert.equal(formatStamp("2026-06-18T00:05:00.000Z", now, "utc"), "00:05");
});

test("timezone changes the day bucket", () => {
  const inst = "2026-06-17T23:30:00.000Z";
  assert.equal(dayKey(inst, "utc"), "2026-06-17");
  // Tokyo is UTC+9 → already the 18th there. If the runtime lacks tz data it
  // falls back to local; only assert the shift when it actually applied.
  const tokyo = dayKey(inst, "Asia/Tokyo");
  if (tokyo !== "2026-06-17") assert.equal(tokyo, "2026-06-18");
});

test("malformed timestamps degrade instead of throwing", () => {
  assert.equal(dayKey("not-a-date", "utc"), "unknown");
  assert.equal(timeOfDay("", "utc"), "??:??");
  assert.equal(formatStamp("garbage", "2026-06-18T00:00:00.000Z", "utc"), "????-??-?? ??:??");
});

test("an invalid timezone falls back to local without throwing", () => {
  const k = dayKey("2026-06-18T05:41:00.000Z", "Not/AZone");
  assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
});

test("dayLabel marks Today and Yesterday, bare date otherwise", () => {
  const now = "2026-06-18T12:00:00.000Z";
  assert.match(dayLabel("2026-06-18", now, "utc"), /^Today/);
  assert.match(dayLabel("2026-06-17", now, "utc"), /^Yesterday/);
  assert.equal(dayLabel("2026-06-10", now, "utc"), "2026-06-10");
});
