import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeFeed } from "../src/core/feed.js";
import type { ChatMessage } from "../src/core/live.js";

const m = (at: string, text: string, feature = "x", owner = "a"): ChatMessage => ({
  at,
  group: "g",
  feature,
  owner,
  kind: "say",
  text,
});

test("seeded history is not re-emitted", () => {
  const f = dedupeFeed();
  const hist = [m("2026-06-18T10:00:00.000Z", "old1"), m("2026-06-18T10:01:00.000Z", "old2")];
  f.seed(hist);
  assert.deepEqual(f.next(hist), [], "already-seen history yields nothing");
});

test("only genuinely new messages are emitted (poll + subscribe overlap)", () => {
  const f = dedupeFeed();
  f.seed([m("2026-06-18T10:00:00.000Z", "old")]);
  // A poll returns the old message plus a new one — only the new one shows.
  const batch = [m("2026-06-18T10:00:00.000Z", "old"), m("2026-06-18T10:05:00.000Z", "new")];
  assert.deepEqual(f.next(batch).map((x) => x.text), ["new"]);
  // The push path then delivers the same "new" message — must not double-show.
  assert.deepEqual(f.next([m("2026-06-18T10:05:00.000Z", "new")]), []);
});

test("distinct messages at the same timestamp both emit", () => {
  const f = dedupeFeed();
  const out = f.next([
    m("2026-06-18T10:00:00.000Z", "CLAIM a.ts", "p1"),
    m("2026-06-18T10:00:00.000Z", "ACK", "p2"),
  ]);
  assert.equal(out.length, 2);
});
