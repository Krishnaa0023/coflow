import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactDeep } from "../src/core/redact.js";

// ---------------------------------------------------------------------------
// redact()
// ---------------------------------------------------------------------------

test("redact masks an AWS access key id", () => {
  const input = "Access key is AKIAIOSFODNN7EXAMPLE and should be hidden";
  const r = redact(input);
  assert.equal(r.redacted, true);
  assert.ok(r.hits.includes("aws-akid"), `hits=${JSON.stringify(r.hits)}`);
  assert.ok(!r.text.includes("AKIAIOSFODNN7EXAMPLE"), "key not removed from text");
  assert.ok(r.text.includes("«redacted:aws-akid»"), "placeholder present");
});

test("redact masks a GitHub personal access token (ghp_)", () => {
  // 36 alphanumerics after the prefix
  const token = "ghp_" + "A".repeat(20) + "b".repeat(16);
  const input = `Export GH_TOKEN=${token} here`;
  const r = redact(input);
  assert.equal(r.redacted, true);
  assert.ok(r.hits.includes("github-token"), `hits=${JSON.stringify(r.hits)}`);
  assert.ok(!r.text.includes(token), "token not removed");
});

test("redact masks a password = assignment", () => {
  const input = `password = "supersecret123"`;
  const r = redact(input);
  assert.equal(r.redacted, true);
  // The assignment pattern fires; the hit key starts with "assignment:"
  const assignHit = r.hits.find((h) => h.startsWith("assignment:"));
  assert.ok(assignHit, `Expected assignment hit, got: ${JSON.stringify(r.hits)}`);
  assert.ok(!r.text.includes("supersecret123"), "secret not removed from text");
});

test("redact returns redacted:false for a clean string", () => {
  const input = "This is a perfectly clean log message with no secrets.";
  const r = redact(input);
  assert.equal(r.redacted, false);
  assert.deepEqual(r.hits, []);
  assert.equal(r.text, input);
});

test("redact returns redacted:false for empty string", () => {
  const r = redact("");
  assert.equal(r.redacted, false);
  assert.deepEqual(r.hits, []);
});

test("redact masks multiple patterns in one string", () => {
  const awsKey = "AKIAIOSFODNN7EXAMPLE";
  const ghToken = "ghp_" + "X".repeat(20);
  const input = `aws=${awsKey} gh=${ghToken}`;
  const r = redact(input);
  assert.equal(r.redacted, true);
  assert.ok(r.hits.includes("aws-akid"));
  assert.ok(r.hits.includes("github-token"));
});

// ---------------------------------------------------------------------------
// redactDeep()
// ---------------------------------------------------------------------------

test("redactDeep walks a flat object and masks string leaves", () => {
  const obj = {
    name: "alice",
    token: "AKIAIOSFODNN7EXAMPLE",
  };
  const { value, hits } = redactDeep(obj);
  assert.equal((value as typeof obj).name, "alice");
  assert.ok(!(value as typeof obj).token.includes("AKIA"), "aws key masked");
  assert.ok(hits.length > 0, "hits collected");
});

test("redactDeep walks nested objects recursively", () => {
  const obj = {
    outer: {
      inner: {
        secret: "ghp_" + "Z".repeat(20),
      },
    },
    clean: "hello",
  };
  const { value, hits } = redactDeep(obj);
  const inner = (value as typeof obj).outer.inner;
  assert.ok(!inner.secret.startsWith("ghp_"), "nested token masked");
  assert.ok(hits.includes("github-token"));
  assert.equal((value as typeof obj).clean, "hello");
});

test("redactDeep walks arrays", () => {
  const arr = ["clean string", "AKIAIOSFODNN7EXAMPLE", "also clean"];
  const { value, hits } = redactDeep(arr);
  assert.equal((value as string[])[0], "clean string");
  assert.ok(!(value as string[])[1].includes("AKIA"), "aws key in array masked");
  assert.equal((value as string[])[2], "also clean");
  assert.ok(hits.includes("aws-akid"));
});

test("redactDeep passes non-string primitives through unchanged", () => {
  const obj = { count: 42, active: true, nothing: null };
  const { value, hits } = redactDeep(obj);
  assert.deepEqual(value, obj);
  assert.deepEqual(hits, []);
});

test("redactDeep returns empty hits for a clean nested object", () => {
  const obj = { a: { b: { c: "no secrets here" } } };
  const { hits } = redactDeep(obj);
  assert.deepEqual(hits, []);
});
