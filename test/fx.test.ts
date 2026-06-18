import { test } from "node:test";
import assert from "node:assert/strict";
import { gradient } from "../src/cli/fx.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("gradient preserves the visible text exactly — only colour codes are added", () => {
  const t = "┏━╸┏━┓┏━╸  COFLOW online";
  assert.equal(strip(gradient(t)), t);
});

test("gradient handles empty and single-character strings", () => {
  assert.equal(strip(gradient("")), "");
  assert.equal(strip(gradient("x")), "x");
});

test("gradient respects NO_COLOR (returns the raw string)", () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    assert.equal(gradient("hello world"), "hello world");
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

test("gradient with a highlight band still preserves the text", () => {
  const t = "shimmer test 123";
  assert.equal(strip(gradient(t, undefined, 0.5)), t);
});
