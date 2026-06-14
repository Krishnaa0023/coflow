import { Context } from "../core/context.js";
import { readHookInput } from "./io.js";

/**
 * Stop: the debounced flush at a task boundary. Folds any queued deltas into the
 * feature file, commits, and pushes — the downward "sync" arrow.
 *
 * Only acts when there is something pending (no empty commits). Set
 * COFLOW_AUTOPUSH=0 to disable and rely on explicit checkpoint
 * calls instead.
 */
export async function run(): Promise<void> {
  try {
    if (process.env.COFLOW_AUTOPUSH === "0") {
      process.exit(0);
    }
    const input = await readHookInput();
    const ctx = new Context(input.cwd);
    const id = await ctx.currentFeatureId();
    const pending = ctx.store.readPending(id);

    if (pending.length === 0) {
      process.exit(0);
    }

    const r = await ctx.checkpoint({ feature: id });
    process.stderr.write(
      `[coflow] checkpoint ${r.feature}: ${r.message} (${r.deltasFolded} delta(s))\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[coflow] stop-hook checkpoint failed: ${(err as Error).message}\n`,
    );
  }
  process.exit(0);
}
