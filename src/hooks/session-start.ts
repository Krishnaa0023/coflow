import { Context } from "../core/context.js";
import { readHookInput, emit } from "./io.js";

/**
 * SessionStart: pull the latest context and inject a summary of what every other
 * active feature is doing. This is the upward "pull + inject" arrow.
 *
 * Resilience: any failure exits 0 with no output. A flaky network or missing
 * remote must never stop a session from starting.
 */
export async function run(): Promise<void> {
  try {
    const input = await readHookInput();
    const ctx = new Context(input.cwd);

    await ctx.pull();
    // Roll any chat that aged past the window into daily summaries, so this
    // session starts from summaries + fresh chat — never a raw stale dump.
    await ctx.summarizeChat();
    // Auto-join the group: register this Claude instance so siblings see it,
    // and mark current chat as seen so later hooks only deliver NEW messages.
    if (ctx.live.enabled) {
      const sid = input.session_id ?? `pid-${process.pid}`;
      await ctx.announcePresence(sid);
      await ctx.markInboxSeen(sid);
    }
    const summary = await ctx.summary();

    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "## Shared team context (coflow)\n" +
          summary +
          "\nTalk to other sessions with the `say` tool, check for replies with `inbox`, and `checkpoint` at task boundaries. Overlap warnings arrive automatically.",
      },
    });
  } catch {
    // Swallow — never block session start.
  }
  process.exit(0);
}
