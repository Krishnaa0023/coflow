import { Context } from "../core/context.js";
import { readHookInput } from "./io.js";

/**
 * SessionEnd: deregister this session from the group's presence list so closed
 * sessions don't linger as "live". Best-effort and silent — a missed dropout is
 * cleaned up by the presence freshness window anyway.
 */
export async function run(): Promise<void> {
  try {
    const input = await readHookInput();
    const ctx = new Context(input.cwd);
    if (ctx.live.enabled) {
      await ctx.dropPresence(input.session_id ?? `pid-${process.pid}`);
    }
  } catch {
    // Swallow — never disrupt shutdown.
  }
  process.exit(0);
}
