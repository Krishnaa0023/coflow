import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ChatSummaryStore } from "../src/core/chatstore.js";

function mk(): ChatSummaryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coflow-cs-"));
  return new ChatSummaryStore(path.join(dir, "chat-summaries"), path.join(dir, ".locks"));
}

const doc = (gen: string, body: string) => `---\ngenerated_at: ${gen}\n---\n${body}\n`;

test("write creates a summary file and read returns it", async () => {
  const s = mk();
  const r = await s.write("2026-06-17", doc("A", "body"));
  assert.equal(r.written, true);
  assert.ok(fs.existsSync(r.path));
  assert.match(s.read("2026-06-17") ?? "", /body/);
});

test("re-writing identical content (only generated_at differs) is idempotent", async () => {
  const s = mk();
  await s.write("2026-06-17", doc("A", "body"));
  const before = s.read("2026-06-17");
  const r2 = await s.write("2026-06-17", doc("B", "body"));
  assert.equal(r2.written, false, "no churn when only generated_at changes");
  assert.equal(s.read("2026-06-17"), before, "file content unchanged");
});

test("changed content triggers a rewrite", async () => {
  const s = mk();
  await s.write("2026-06-17", doc("A", "body1"));
  const r = await s.write("2026-06-17", doc("A", "body2"));
  assert.equal(r.written, true);
  assert.match(s.read("2026-06-17") ?? "", /body2/);
});

test("--force rewrites even when content is identical", async () => {
  const s = mk();
  await s.write("2026-06-17", doc("A", "body"));
  const r = await s.write("2026-06-17", doc("B", "body"), true);
  assert.equal(r.written, true);
  assert.match(s.read("2026-06-17") ?? "", /generated_at: B/);
});

test("list and readRecent return days chronologically", async () => {
  const s = mk();
  await s.write("2026-06-16", doc("A", "a"));
  await s.write("2026-06-18", doc("A", "c"));
  await s.write("2026-06-17", doc("A", "b"));
  assert.deepEqual(s.list(), ["2026-06-16", "2026-06-17", "2026-06-18"]);
  assert.deepEqual(s.readRecent(2).map((x) => x.day), ["2026-06-17", "2026-06-18"]);
});

test("concurrent writes to the same day produce exactly one valid file", async () => {
  const s = mk();
  await Promise.all(
    Array.from({ length: 6 }, (_, i) => s.write("2026-06-17", doc(`g${i}`, "body"))),
  );
  const content = s.read("2026-06-17") ?? "";
  // Exactly one well-formed doc — no concatenation/duplication from a race.
  assert.equal(content.match(/generated_at:/g)?.length, 1, "single summary, no duplication");
  assert.match(content, /body/);
});
