import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/core/store.js";
import { newFeature } from "../src/core/schema.js";
import type { Delta } from "../src/core/schema.js";

const NOW = "2024-03-01T12:00:00.000Z";
const LATER = "2024-03-01T13:00:00.000Z";

/** Create an isolated temp directory with a .context subdir so resolveRoot stops there. */
function makeTmpStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coflow-"));
  // The .context subdir is what resolveRoot looks for as the root anchor
  fs.mkdirSync(path.join(dir, ".context"), { recursive: true });
  const store = new Store(dir);
  return { store, dir };
}

function sampleFeature(overrides: object = {}) {
  return newFeature({
    feature: "auth-feature",
    owner: "alice",
    branch: "feature/auth",
    goal: "Add OAuth2 login",
    now: NOW,
    ...overrides,
  });
}

function sampleDelta(overrides: Partial<Delta> = {}): Delta {
  return {
    at: LATER,
    kind: "edit",
    summary: "Updated handler",
    files: ["src/auth.ts"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// writeFeature / readFeature round-trip
// ---------------------------------------------------------------------------

test("writeFeature then readFeature round-trips a feature correctly", () => {
  const { store, dir } = makeTmpStore();
  try {
    const feature = sampleFeature();
    store.writeFeature(feature);

    const read = store.readFeature("auth-feature");
    assert.ok(read !== null, "readFeature returned null");
    assert.equal(read.feature, feature.feature);
    assert.equal(read.owner, feature.owner);
    assert.equal(read.goal, feature.goal);
    assert.equal(read.status, feature.status);
    assert.equal(read.branch, feature.branch);
    assert.equal(read.updated_at, feature.updated_at);
    assert.deepEqual(read.files_touched, feature.files_touched);
    assert.deepEqual(read.decisions, feature.decisions);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeature returns null for non-existent feature", () => {
  const { store, dir } = makeTmpStore();
  try {
    const result = store.readFeature("nonexistent");
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listFeatures returns all written features", () => {
  const { store, dir } = makeTmpStore();
  try {
    const f1 = sampleFeature({ feature: "feature-one", owner: "alice" });
    const f2 = sampleFeature({ feature: "feature-two", owner: "bob" });
    store.writeFeature(f1);
    store.writeFeature(f2);

    const list = store.listFeatures();
    assert.equal(list.length, 2);
    const ids = list.map((f) => f.feature).sort();
    assert.deepEqual(ids, ["feature-one", "feature-two"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFeature preserves files_touched after round-trip", () => {
  const { store, dir } = makeTmpStore();
  try {
    const feature = {
      ...sampleFeature(),
      files_touched: ["src/a.ts", "src/b.ts", "src/c.ts"],
    };
    store.writeFeature(feature);
    const read = store.readFeature("auth-feature");
    assert.ok(read !== null);
    assert.deepEqual(read.files_touched, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pending deltas queue
// ---------------------------------------------------------------------------

test("queueDelta then readPending returns queued deltas", () => {
  const { store, dir } = makeTmpStore();
  try {
    const feature = sampleFeature();
    store.writeFeature(feature);

    const d1 = sampleDelta({ summary: "First edit", files: ["src/auth.ts"] });
    const d2 = sampleDelta({
      at: "2024-03-01T14:00:00.000Z",
      summary: "Second edit",
      files: ["src/utils.ts"],
    });
    store.queueDelta("auth-feature", d1);
    store.queueDelta("auth-feature", d2);

    const pending = store.readPending("auth-feature");
    assert.equal(pending.length, 2);
    assert.equal(pending[0].summary, "First edit");
    assert.equal(pending[1].summary, "Second edit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearPending empties the pending queue", () => {
  const { store, dir } = makeTmpStore();
  try {
    const feature = sampleFeature();
    store.writeFeature(feature);
    store.queueDelta("auth-feature", sampleDelta());
    store.queueDelta("auth-feature", sampleDelta({ summary: "another" }));

    store.clearPending("auth-feature");

    const pending = store.readPending("auth-feature");
    assert.equal(pending.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readPending returns empty array when no deltas queued", () => {
  const { store, dir } = makeTmpStore();
  try {
    const pending = store.readPending("nonexistent");
    assert.deepEqual(pending, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// livePendingFiles
// ---------------------------------------------------------------------------

test("livePendingFiles maps feature id to its pending files", () => {
  const { store, dir } = makeTmpStore();
  try {
    const feature = sampleFeature();
    store.writeFeature(feature);
    store.queueDelta(
      "auth-feature",
      sampleDelta({ files: ["src/auth.ts", "src/token.ts"] }),
    );

    const liveMap = store.livePendingFiles();
    assert.ok(liveMap.has("auth-feature"), "auth-feature key present");
    const files = liveMap.get("auth-feature")!;
    assert.ok(files.has("src/auth.ts"), "src/auth.ts in pending files");
    assert.ok(files.has("src/token.ts"), "src/token.ts in pending files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("livePendingFiles returns empty map when pending dir empty", () => {
  const { store, dir } = makeTmpStore();
  try {
    const liveMap = store.livePendingFiles();
    assert.equal(liveMap.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

test("appendActivity then readActivity returns the appended line", () => {
  const { store, dir } = makeTmpStore();
  try {
    store.appendActivity("Session started for auth-feature");
    const lines = store.readActivity();
    assert.ok(
      lines.some((l) => l.includes("Session started for auth-feature")),
      `Expected line not found; got: ${JSON.stringify(lines)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActivity respects the limit", () => {
  const { store, dir } = makeTmpStore();
  try {
    for (let i = 0; i < 20; i++) {
      store.appendActivity(`Line ${i}`);
    }
    const lines = store.readActivity(5);
    assert.equal(lines.length, 5);
    // Newest last: should end with Line 19
    assert.ok(lines[4].includes("Line 19"), `last line is: ${lines[4]}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActivity returns empty array when no activity logged", () => {
  const { store, dir } = makeTmpStore();
  try {
    const lines = store.readActivity();
    assert.deepEqual(lines, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Secret redaction in writeFeature
// ---------------------------------------------------------------------------

test("writeFeature redacts a secret in current_state; hits non-empty and file text contains 'redacted'", () => {
  const { store, dir } = makeTmpStore();
  try {
    const feature = {
      ...sampleFeature(),
      current_state: "Debugging with token AKIAIOSFODNN7EXAMPLE embedded here",
    };
    const { hits } = store.writeFeature(feature);
    assert.ok(hits.length > 0, "expected redaction hits");

    // Read back the raw file to verify the token was redacted on disk
    // featureId("auth-feature") == "auth-feature" (already safe)
    const featureFilePath = path.join(
      dir,
      ".context",
      "features",
      "auth-feature.md",
    );
    const rawText = fs.readFileSync(featureFilePath, "utf8");
    assert.ok(
      !rawText.includes("AKIAIOSFODNN7EXAMPLE"),
      "raw key must not appear in the persisted file",
    );
    assert.ok(
      rawText.includes("redacted"),
      "the word 'redacted' must appear in the persisted file",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
