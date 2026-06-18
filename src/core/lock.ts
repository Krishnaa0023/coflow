import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A tiny cross-process advisory lock built on the one filesystem primitive that
 * is atomic everywhere: `mkdir`. Creating a directory either succeeds (you hold
 * the lock) or fails because it exists (someone else does). No deps, no daemon.
 *
 * Used to serialize daily-summary writes so two sessions starting at the same
 * moment can't both write the same file and corrupt it. A lock older than
 * `staleMs` is assumed orphaned (the holder crashed) and stolen, so a dead
 * process can never wedge the feature permanently.
 */

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRIES = 60;
const RETRY_BASE_MS = 15;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function lockAgeMs(dir: string): number | null {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return null; // vanished between checks — treat as free
  }
}

/**
 * Run `fn` while holding the lock at `lockDir`, then release it (even if `fn`
 * throws). Blocks (polling) until the lock is acquired, a stale lock is stolen,
 * or retries are exhausted — in which case it steals as a last resort so work is
 * never deadlocked by a leaked lock.
 */
export async function withLock<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  opts: { staleMs?: number; retries?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let held = false;

  // The lock is the atomic creation of the LEAF dir; its parent must already
  // exist or `mkdir` would fail with ENOENT (not EEXIST) and look like contention.
  try {
    mkdirSync(dirname(lockDir), { recursive: true });
  } catch {
    /* ignore — leaf mkdir below will surface any real problem */
  }

  for (let i = 0; i < retries && !held; i++) {
    try {
      mkdirSync(lockDir); // atomic create — throws if it already exists
      held = true;
      break;
    } catch {
      const age = lockAgeMs(lockDir);
      if (age !== null && age > staleMs) {
        try {
          rmdirSync(lockDir); // steal an orphaned lock, then retry immediately
        } catch {
          /* someone else stole it first — fine */
        }
        continue;
      }
      await sleep(RETRY_BASE_MS + i * 2);
    }
  }

  if (!held) {
    // Last resort: break a stuck lock rather than fail the operation outright.
    try {
      rmdirSync(lockDir);
    } catch {
      /* ignore */
    }
    try {
      mkdirSync(lockDir);
      held = true;
    } catch {
      /* ignore — proceed best-effort */
    }
  }

  try {
    return await fn();
  } finally {
    if (held) {
      try {
        rmdirSync(lockDir);
      } catch {
        /* already released/stolen */
      }
    }
  }
}
