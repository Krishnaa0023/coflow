import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withLock } from "./lock.js";

/**
 * Durable store for daily chat summaries: one Markdown file per day at
 * `.context/chat-summaries/YYYY-MM-DD.md`.
 *
 * Writes are:
 *   - locked   — serialized per-day so concurrent sessions can't clobber a file
 *   - atomic   — written to a temp file then renamed, so a reader never sees a
 *                half-written summary
 *   - idempotent — a re-run whose content matches (ignoring the volatile
 *                `generated_at` line) is a no-op, so summaries never churn or
 *                duplicate. `force` overrides this for recovery/debugging.
 */
export class ChatSummaryStore {
  constructor(
    private readonly dir: string,
    private readonly locksDir: string,
  ) {}

  pathFor(day: string): string {
    return join(this.dir, `${day}.md`);
  }

  /** All summary days present, ascending (YYYY-MM-DD sorts chronologically). */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, -".md".length))
      .sort();
  }

  read(day: string): string | null {
    const f = this.pathFor(day);
    if (!existsSync(f)) return null;
    try {
      return readFileSync(f, "utf8");
    } catch {
      return null;
    }
  }

  /** The most recent `n` summaries, oldest-first. For context injection. */
  readRecent(n: number): Array<{ day: string; content: string }> {
    return this.list()
      .slice(-n)
      .map((day) => ({ day, content: this.read(day) ?? "" }))
      .filter((s) => s.content);
  }

  /**
   * Write `content` for `day` unless an identical summary already exists.
   * Returns whether a write actually happened (false = already up to date).
   */
  async write(
    day: string,
    content: string,
    force = false,
  ): Promise<{ written: boolean; path: string }> {
    const path = this.pathFor(day);
    const lockDir = join(this.locksDir, `chat-summary-${day}.lock`);
    return withLock(lockDir, () => {
      if (!force && existsSync(path)) {
        try {
          if (stripVolatile(readFileSync(path, "utf8")) === stripVolatile(content)) {
            return { written: false, path };
          }
        } catch {
          /* unreadable — fall through and overwrite */
        }
      }
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, path); // atomic on POSIX
      return { written: true, path };
    });
  }
}

/** Drop the one non-deterministic line so equal summaries compare equal. */
function stripVolatile(s: string): string {
  return s.replace(/^generated_at:.*$/m, "generated_at:");
}
