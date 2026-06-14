/**
 * Tests for src/core/key.ts — which may not yet exist at write-time.
 * The import is guarded so a missing module causes a skip rather than a hard crash.
 *
 * Expected API (as specified):
 *   encodeKey(conn: Connection): string   — starts with "coflow1_"
 *   decodeKey(key: string): Connection    — throws on malformed input
 *   Connection: { kind: "local"|"upstash", group: string, url?: string, token?: string }
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Dynamically import so that a missing file only skips these tests, not the suite.
type Connection = {
  kind: "local" | "upstash";
  group: string;
  url?: string;
  token?: string;
};

type KeyModule = {
  encodeKey: (conn: Connection) => string;
  decodeKey: (key: string) => Connection;
};

let keyMod: KeyModule | null = null;

try {
  // Use a dynamic import wrapped in a synchronous-compatible pattern:
  // node:test allows top-level await when run under tsx / ESM.
  // We assign inside an IIFE but tests are registered after the import attempt.
  // If the module doesn't exist the catch sets keyMod = null and tests skip.
  keyMod = await import("../src/core/key.js") as KeyModule;
} catch {
  // Module not yet written — tests will be skipped below.
}

function skipIfMissing(): KeyModule {
  if (!keyMod) {
    // Use the node:test skip mechanism: throw a SkipError-shaped object.
    // The node:test runner recognises `todo` and `skip` options on test(),
    // but from inside a test body we call the context's skip() method.
    // Since we don't have context here, we throw — the test will fail with
    // a descriptive message instead of crashing the process.
    throw new Error("SKIP: src/core/key.ts does not exist yet");
  }
  return keyMod;
}

// ---------------------------------------------------------------------------
// Encode / decode round-trips
// ---------------------------------------------------------------------------

test("encodeKey produces a string starting with 'coflow1_'", () => {
  const { encodeKey } = skipIfMissing();
  const conn: Connection = { kind: "local", group: "abc" };
  const key = encodeKey(conn);
  assert.ok(
    key.startsWith("coflow1_"),
    `Expected key to start with 'coflow1_', got: ${key}`,
  );
});

test("encodeKey + decodeKey round-trips a local connection", () => {
  const { encodeKey, decodeKey } = skipIfMissing();
  const conn: Connection = { kind: "local", group: "abc" };
  const key = encodeKey(conn);
  const decoded = decodeKey(key);
  assert.equal(decoded.kind, "local");
  assert.equal(decoded.group, "abc");
  assert.equal(decoded.url, undefined);
  assert.equal(decoded.token, undefined);
});

test("encodeKey + decodeKey round-trips an upstash connection with url and token", () => {
  const { encodeKey, decodeKey } = skipIfMissing();
  const conn: Connection = {
    kind: "upstash",
    group: "my-team",
    url: "https://example.upstash.io",
    token: "secret-token-xyz",
  };
  const key = encodeKey(conn);
  const decoded = decodeKey(key);
  assert.equal(decoded.kind, "upstash");
  assert.equal(decoded.group, "my-team");
  assert.equal(decoded.url, "https://example.upstash.io");
  assert.equal(decoded.token, "secret-token-xyz");
});

test("encodeKey + decodeKey round-trips a local connection with special chars in group", () => {
  const { encodeKey, decodeKey } = skipIfMissing();
  const conn: Connection = { kind: "local", group: "team-alpha_2024" };
  const key = encodeKey(conn);
  const decoded = decodeKey(key);
  assert.equal(decoded.group, "team-alpha_2024");
});

// ---------------------------------------------------------------------------
// decodeKey error handling
// ---------------------------------------------------------------------------

test("decodeKey throws on a completely unrelated string", () => {
  const { decodeKey } = skipIfMissing();
  assert.throws(
    () => decodeKey("not-a-key"),
    /./,
    "Expected decodeKey to throw for 'not-a-key'",
  );
});

test("decodeKey throws on a 'coflow1_' prefix followed by invalid base64 or garbage", () => {
  const { decodeKey } = skipIfMissing();
  assert.throws(
    () => decodeKey("coflow1_!!!"),
    /./,
    "Expected decodeKey to throw for 'coflow1_!!!'",
  );
});

test("decodeKey throws on an empty string", () => {
  const { decodeKey } = skipIfMissing();
  assert.throws(
    () => decodeKey(""),
    /./,
    "Expected decodeKey to throw for empty string",
  );
});

test("decodeKey throws on a truncated key", () => {
  const { decodeKey } = skipIfMissing();
  assert.throws(
    () => decodeKey("coflow1_"),
    /./,
    "Expected decodeKey to throw for bare prefix with no payload",
  );
});
