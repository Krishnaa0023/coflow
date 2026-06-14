import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newFeature,
  applyDelta,
  parseFeature,
  MAX_RECENT_DELTAS,
} from "../src/core/schema.js";
import type { Delta } from "../src/core/schema.js";

const NOW = "2024-01-15T10:00:00.000Z";
const LATER = "2024-01-15T11:00:00.000Z";

function makeFeature() {
  return newFeature({
    feature: "auth-flow",
    owner: "alice",
    branch: "feature/auth-flow",
    goal: "Implement OAuth2",
    now: NOW,
  });
}

function makeDelta(overrides: Partial<Delta> = {}): Delta {
  return {
    at: LATER,
    kind: "edit",
    summary: "Updated auth module",
    files: ["src/auth.ts"],
    ...overrides,
  };
}

test("newFeature produces correct defaults", () => {
  const f = makeFeature();
  assert.equal(f.feature, "auth-flow");
  assert.equal(f.owner, "alice");
  assert.equal(f.branch, "feature/auth-flow");
  assert.equal(f.goal, "Implement OAuth2");
  assert.equal(f.status, "active");
  assert.equal(f.current_state, "");
  assert.equal(f.updated_at, NOW);
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.files_touched, []);
  assert.deepEqual(f.recent_deltas, []);
  assert.deepEqual(f.open_questions, []);
  assert.equal(f.v, 1);
});

test("newFeature uses empty string defaults for optional goal", () => {
  const f = newFeature({ feature: "x", owner: "bob", now: NOW });
  assert.equal(f.goal, "");
  assert.equal(f.branch, undefined);
});

test("applyDelta merges files_touched with deduplication", () => {
  const f = newFeature({ feature: "feat", owner: "alice", now: NOW });
  const f1 = applyDelta(f, makeDelta({ files: ["src/a.ts", "src/b.ts"] }));
  const f2 = applyDelta(
    f1,
    makeDelta({ files: ["src/b.ts", "src/c.ts"] }),
  );
  // src/b.ts should appear only once, and list should be sorted
  assert.deepEqual(f2.files_touched, ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("applyDelta files_touched is sorted", () => {
  const f = newFeature({ feature: "feat", owner: "alice", now: NOW });
  const f1 = applyDelta(
    f,
    makeDelta({ files: ["src/z.ts", "src/a.ts", "src/m.ts"] }),
  );
  assert.deepEqual(f1.files_touched, ["src/a.ts", "src/m.ts", "src/z.ts"]);
});

test("applyDelta caps recent_deltas at MAX_RECENT_DELTAS (push 25, keep 20)", () => {
  let f = newFeature({ feature: "feat", owner: "alice", now: NOW });
  for (let i = 0; i < 25; i++) {
    f = applyDelta(
      f,
      makeDelta({
        at: `2024-01-15T${String(i).padStart(2, "0")}:00:00.000Z`,
        summary: `delta ${i}`,
        files: [],
      }),
    );
  }
  assert.equal(f.recent_deltas.length, MAX_RECENT_DELTAS);
  // Should keep the most recent 20 (deltas 5..24)
  assert.equal(f.recent_deltas[0].summary, "delta 5");
  assert.equal(f.recent_deltas[19].summary, "delta 24");
});

test("applyDelta with kind=decision appends to decisions[]", () => {
  const f = newFeature({ feature: "feat", owner: "alice", now: NOW });
  const f1 = applyDelta(
    f,
    makeDelta({
      kind: "decision",
      summary: "Use JWT for sessions",
      at: LATER,
    }),
  );
  assert.equal(f1.decisions.length, 1);
  assert.equal(f1.decisions[0].text, "Use JWT for sessions");
  assert.equal(f1.decisions[0].at, LATER);
});

test("applyDelta with kind=note does not append to decisions[]", () => {
  const f = newFeature({ feature: "feat", owner: "alice", now: NOW });
  const f1 = applyDelta(f, makeDelta({ kind: "note", summary: "Just a note" }));
  assert.equal(f1.decisions.length, 0);
});

test("applyDelta updates updated_at to delta.at", () => {
  const f = newFeature({ feature: "feat", owner: "alice", now: NOW });
  const f1 = applyDelta(f, makeDelta({ at: LATER }));
  assert.equal(f1.updated_at, LATER);
});

test("parseFeature round-trips a valid feature object", () => {
  const f = makeFeature();
  const parsed = parseFeature(f);
  assert.deepEqual(parsed, f);
});

test("parseFeature throws on invalid input", () => {
  assert.throws(() => parseFeature({ not: "a feature" }));
});
