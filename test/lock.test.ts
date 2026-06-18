import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withLock } from "../src/core/lock.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coflow-lock-"));

test("withLock runs fn and releases the lock", async () => {
  const lock = path.join(tmp(), "x.lock");
  const r = await withLock(lock, () => 42);
  assert.equal(r, 42);
  assert.equal(fs.existsSync(lock), false, "lock dir removed afterwards");
});

test("withLock serializes concurrent callers (mutual exclusion)", async () => {
  const lock = path.join(tmp(), "x.lock");
  let active = 0;
  let maxActive = 0;
  let ran = 0;
  const job = () =>
    withLock(lock, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      ran++;
    });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(ran, 5, "all jobs completed");
  assert.equal(maxActive, 1, "never two holders at once");
  assert.equal(fs.existsSync(lock), false);
});

test("withLock steals a stale lock", async () => {
  const lock = path.join(tmp(), "x.lock");
  fs.mkdirSync(lock); // simulate a crashed holder leaving the lock behind
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  let ran = false;
  await withLock(lock, () => { ran = true; }, { staleMs: 1000, retries: 5 });
  assert.equal(ran, true, "stale lock stolen, fn ran");
});

test("withLock releases the lock even if fn throws", async () => {
  const lock = path.join(tmp(), "x.lock");
  await assert.rejects(withLock(lock, () => {
    throw new Error("boom");
  }));
  assert.equal(fs.existsSync(lock), false, "lock released after a throw");
});
