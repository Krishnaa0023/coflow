import { test } from "node:test";
import assert from "node:assert/strict";
import {
  committedOverlap,
  liveOverlap,
  mergeHits,
  normalizePath,
} from "../src/core/overlap.js";
import { newFeature } from "../src/core/schema.js";
import type { Feature } from "../src/core/schema.js";

const ROOT = "/repo";
const NOW = "2024-04-01T09:00:00.000Z";

function makeFeature(
  id: string,
  files: string[],
  overrides: Partial<Feature> = {},
): Feature {
  return {
    ...newFeature({ feature: id, owner: "alice", now: NOW }),
    files_touched: files,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

test("normalizePath converts an absolute path under root to repo-relative posix", () => {
  const result = normalizePath("/repo", "/repo/src/auth.ts");
  assert.equal(result, "src/auth.ts");
});

test("normalizePath leaves a relative path unchanged (modulo leading ./)", () => {
  assert.equal(normalizePath("/repo", "src/auth.ts"), "src/auth.ts");
});

test("normalizePath strips leading ./", () => {
  assert.equal(normalizePath("/repo", "./src/auth.ts"), "src/auth.ts");
});

test("normalizePath converts backslashes to forward slashes", () => {
  // Simulate a Windows-style path (even on posix the replace still fires)
  const result = normalizePath("/repo", "src\\foo\\bar.ts");
  assert.equal(result, "src/foo/bar.ts");
});

// ---------------------------------------------------------------------------
// committedOverlap
// ---------------------------------------------------------------------------

test("committedOverlap: two features sharing a file produce a hit with that file in shared[]", () => {
  const features: Feature[] = [
    makeFeature("dana-feature", ["src/auth.ts", "src/models.ts"]),
  ];
  const hits = committedOverlap(ROOT, features, ["src/auth.ts"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].feature, "dana-feature");
  assert.deepEqual(hits[0].shared, ["src/auth.ts"]);
  assert.equal(hits[0].inProgress, false);
});

test("committedOverlap: selfId excludes own feature from hits", () => {
  const features: Feature[] = [
    makeFeature("my-feature", ["src/auth.ts"]),
    makeFeature("other-feature", ["src/auth.ts"]),
  ];
  const hits = committedOverlap(ROOT, features, ["src/auth.ts"], "my-feature");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].feature, "other-feature");
});

test("committedOverlap: a done feature is ignored", () => {
  const features: Feature[] = [
    makeFeature("done-feature", ["src/auth.ts"], { status: "done" }),
    makeFeature("active-feature", ["src/auth.ts"]),
  ];
  const hits = committedOverlap(ROOT, features, ["src/auth.ts"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].feature, "active-feature");
});

test("committedOverlap: no overlap when files do not intersect", () => {
  const features: Feature[] = [
    makeFeature("other-feature", ["src/users.ts"]),
  ];
  const hits = committedOverlap(ROOT, features, ["src/auth.ts"]);
  assert.equal(hits.length, 0);
});

test("committedOverlap: no features produces empty hits", () => {
  const hits = committedOverlap(ROOT, [], ["src/auth.ts"]);
  assert.equal(hits.length, 0);
});

test("committedOverlap: paused feature is still included (only done is excluded)", () => {
  const features: Feature[] = [
    makeFeature("paused-feature", ["src/auth.ts"], { status: "paused" }),
  ];
  const hits = committedOverlap(ROOT, features, ["src/auth.ts"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].status, "paused");
});

// ---------------------------------------------------------------------------
// liveOverlap
// ---------------------------------------------------------------------------

test("liveOverlap flags a pending feature as inProgress:true", () => {
  const liveMap = new Map<string, Set<string>>([
    ["in-progress-feature", new Set(["src/auth.ts", "src/utils.ts"])],
  ]);
  const features: Feature[] = [
    makeFeature("in-progress-feature", []),
  ];
  const hits = liveOverlap(ROOT, liveMap, features, ["src/auth.ts"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].feature, "in-progress-feature");
  assert.equal(hits[0].inProgress, true);
  assert.ok(hits[0].shared.includes("src/auth.ts"));
});

test("liveOverlap selfId excludes own feature", () => {
  const liveMap = new Map<string, Set<string>>([
    ["my-feature", new Set(["src/auth.ts"])],
    ["other-feature", new Set(["src/auth.ts"])],
  ]);
  const features: Feature[] = [
    makeFeature("my-feature", []),
    makeFeature("other-feature", []),
  ];
  const hits = liveOverlap(ROOT, liveMap, features, ["src/auth.ts"], "my-feature");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].feature, "other-feature");
});

test("liveOverlap uses owner from features map when available", () => {
  const liveMap = new Map<string, Set<string>>([
    ["known-feature", new Set(["src/auth.ts"])],
  ]);
  const features: Feature[] = [
    makeFeature("known-feature", [], { owner: "bob" }),
  ];
  const hits = liveOverlap(ROOT, liveMap, features, ["src/auth.ts"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].owner, "bob");
});

test("liveOverlap falls back to 'another session' owner when feature not in list", () => {
  const liveMap = new Map<string, Set<string>>([
    ["unknown-feature", new Set(["src/auth.ts"])],
  ]);
  const hits = liveOverlap(ROOT, liveMap, [], ["src/auth.ts"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].owner, "another session");
});

// ---------------------------------------------------------------------------
// mergeHits
// ---------------------------------------------------------------------------

test("mergeHits combines committed and live hits", () => {
  const committed = [
    { feature: "feat-a", owner: "alice", status: "active", shared: ["src/a.ts"], inProgress: false },
  ];
  const live = [
    { feature: "feat-b", owner: "bob", status: "in progress", shared: ["src/b.ts"], inProgress: true },
  ];
  const merged = mergeHits(committed, live);
  assert.equal(merged.length, 2);
});

test("mergeHits prefers committed when the same feature id appears in both", () => {
  const committed = [
    { feature: "shared-feat", owner: "alice", status: "active", shared: ["src/a.ts"], inProgress: false },
  ];
  const live = [
    { feature: "shared-feat", owner: "alice", status: "in progress", shared: ["src/a.ts"], inProgress: true },
  ];
  const merged = mergeHits(committed, live);
  // Only one entry — committed wins
  assert.equal(merged.length, 1);
  assert.equal(merged[0].inProgress, false);
});

test("mergeHits with empty live returns committed unchanged", () => {
  const committed = [
    { feature: "feat-a", owner: "alice", status: "active", shared: ["x.ts"], inProgress: false },
  ];
  const merged = mergeHits(committed, []);
  assert.deepEqual(merged, committed);
});

test("mergeHits with empty committed returns live unchanged", () => {
  const live = [
    { feature: "feat-b", owner: "bob", status: "in progress", shared: ["y.ts"], inProgress: true },
  ];
  const merged = mergeHits([], live);
  assert.deepEqual(merged, live);
});
