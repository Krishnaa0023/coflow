import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortMessages,
  partitionByWindow,
  groupByDay,
  buildDailySummary,
  summaryDigest,
} from "../src/core/summary.js";
import type { ChatMessage } from "../src/core/live.js";

const HOUR = 3_600_000;
const mk = (
  at: string,
  text: string,
  feature = "payments",
  owner = "dana",
  kind: ChatMessage["kind"] = "say",
): ChatMessage => ({ at, group: "g", feature, owner, kind, text });

test("partitionByWindow boundaries: 23h59m fresh, 24h & 24h01m old", () => {
  const now = Date.parse("2026-06-18T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const msgs = [
    mk(ago(23 * HOUR + 59 * 60_000), "23h59m"),
    mk(ago(24 * HOUR), "exactly24"),
    mk(ago(24 * HOUR + 60_000), "24h01m"),
  ];
  const { fresh, old } = partitionByWindow(msgs, now, 24);
  assert.deepEqual(
    fresh.map((m) => m.text),
    ["23h59m"],
    "younger than 24h stays fresh",
  );
  assert.deepEqual(
    old.map((m) => m.text).sort(),
    ["24h01m", "exactly24"],
    "exactly-24h and older are summarized",
  );
});

test("partitionByWindow drops malformed timestamps without throwing", () => {
  const now = Date.parse("2026-06-18T12:00:00.000Z");
  const msgs = [mk("nope", "bad"), mk(new Date(now).toISOString(), "good")];
  const { fresh, old } = partitionByWindow(msgs, now, 24);
  assert.deepEqual([...fresh, ...old].map((m) => m.text), ["good"]);
});

test("sortMessages is chronological with a stable tiebreak", () => {
  const a = mk("2026-06-18T03:00:00.000Z", "a");
  const b = mk("2026-06-18T01:00:00.000Z", "b");
  const c = mk("2026-06-18T01:00:00.000Z", "c"); // same time as b → tiebreak
  assert.deepEqual(sortMessages([a, b, c]).map((m) => m.text), ["b", "c", "a"]);
});

test("groupByDay groups and orders days ascending (UTC)", () => {
  const msgs = [
    mk("2026-06-18T01:00:00.000Z", "today"),
    mk("2026-06-16T01:00:00.000Z", "2dago"),
    mk("2026-06-17T01:00:00.000Z", "yest"),
  ];
  assert.deepEqual(
    groupByDay(msgs, "utc").map((d) => d.day),
    ["2026-06-16", "2026-06-17", "2026-06-18"],
  );
});

const sampleDay = (): ChatMessage[] => [
  mk("2026-06-17T02:00:00.000Z", "CLAIM src/auth.ts hashPassword"),
  mk("2026-06-17T03:00:00.000Z", "FREE src/auth.ts"),
  mk("2026-06-17T04:00:00.000Z", "DONE src/auth.ts hashPassword"),
  mk("2026-06-17T05:00:00.000Z", "WAIT agent-2 revokeSession"),
  mk("2026-06-17T06:00:00.000Z", "ASK agent-1 Should we use worktree mode?", "onboarding", "eli"),
  mk("2026-06-17T07:00:00.000Z", "FYI switched default to deterministic summaries"),
  mk("2026-06-17T08:00:00.000Z", "checkpoint: added chat summary store", "onboarding", "eli", "activity"),
  mk("2026-06-17T09:00:00.000Z", "ordinary prose touching src/server/index.ts", "onboarding", "eli"),
];

test("buildDailySummary includes every required field and section", () => {
  const md = buildDailySummary({
    day: "2026-06-17",
    group: "g",
    messages: sampleDay(),
    generatedAt: "2026-06-18T00:00:00.000Z",
    tz: "utc",
  });
  for (const s of [
    "date: 2026-06-17",
    "generated_at:",
    "group: g",
    "message_count: 8",
    "participants: [",
    "files: [",
    "## Decisions",
    "## Completed work",
    "## Claims",
    "## Handoffs / waits",
    "## Open questions",
    "## Files mentioned",
    "## Notable messages",
  ]) {
    assert.ok(md.includes(s), `summary missing: ${s}`);
  }
  // Protocol routing
  assert.match(md, /Completed work[\s\S]*DONE src\/auth\.ts/);
  assert.match(md, /Claims[\s\S]*CLAIM src\/auth\.ts/);
  assert.match(md, /Claims[\s\S]*FREE src\/auth\.ts[\s\S]*released/);
  assert.match(md, /Handoffs \/ waits[\s\S]*WAIT agent-2/);
  assert.match(md, /Open questions[\s\S]*ASK agent-1/);
  assert.match(md, /Decisions[\s\S]*FYI switched default/);
  assert.match(md, /Completed work[\s\S]*checkpoint: added chat summary/);
  assert.match(md, /Notable messages[\s\S]*ordinary prose/);
});

test("files and participants are deduped and sorted", () => {
  const md = buildDailySummary({
    day: "2026-06-17",
    group: "g",
    messages: sampleDay(),
    generatedAt: "x",
    tz: "utc",
  });
  const files = /files: \[(.*)\]/.exec(md)![1];
  assert.equal(files, "src/auth.ts, src/server/index.ts"); // auth.ts seen 3× → once, sorted
  const parts = /participants: \[(.*)\]/.exec(md)![1];
  assert.equal(parts, "onboarding·eli, payments·dana"); // sorted, deduped
});

test("buildDailySummary is deterministic regardless of input order", () => {
  const base = {
    day: "2026-06-17",
    group: "g",
    generatedAt: "2026-06-18T00:00:00.000Z",
    tz: "utc",
  };
  const a = buildDailySummary({ ...base, messages: sampleDay() });
  const b = buildDailySummary({ ...base, messages: [...sampleDay()].reverse() });
  assert.equal(a, b);
});

test("buildDailySummary redacts secrets defensively", () => {
  const md = buildDailySummary({
    day: "2026-06-17",
    group: "g",
    messages: [mk("2026-06-17T02:00:00.000Z", "FYI rotated key AKIAIOSFODNN7EXAMPLE")],
    generatedAt: "x",
    tz: "utc",
  });
  assert.ok(!md.includes("AKIAIOSFODNN7EXAMPLE"), "raw secret must not appear");
  assert.ok(md.includes("«redacted:aws-akid»"));
});

test("malformed messages do not crash buildDailySummary", () => {
  const msgs = [
    { at: "2026-06-17T02:00:00.000Z", group: "g", feature: "x", owner: "y", kind: "say" },
    null,
    {},
    "junk",
  ] as unknown as ChatMessage[];
  assert.doesNotThrow(() =>
    buildDailySummary({ day: "2026-06-17", group: "g", messages: msgs, generatedAt: "x", tz: "utc" }),
  );
});

test("summaryDigest produces a compact one-liner", () => {
  const md = buildDailySummary({
    day: "2026-06-17",
    group: "g",
    messages: sampleDay(),
    generatedAt: "x",
    tz: "utc",
  });
  const d = summaryDigest(md);
  assert.match(d, /8 msg\(s\)/);
  assert.match(d, /src\/auth\.ts/);
});
