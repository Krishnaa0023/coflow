import { Context } from "../core/context.js";
import { readHookInput, filesFromToolInput, emit } from "./io.js";

/**
 * PostToolUse on Edit|Write: record a structured delta locally (no push), then
 * auto-deliver any NEW messages from other sessions in the group — so peers'
 * replies reach this instance mid-session without anyone asking it to check.
 *
 * Fast: recording is local; the inbox read is throttled (and a no-op without a
 * connected group).
 */
export async function run(): Promise<void> {
  try {
    const input = await readHookInput();
    const ctx = new Context(input.cwd);

    const files = filesFromToolInput(input.tool_input);
    if (files.length > 0) {
      await ctx.recordCurrent({
        kind: "edit",
        summary: `${input.tool_name ?? "edit"} ${files.join(", ")}`,
        files,
      });
    }

    // Deliver fresh peer messages into this session's context.
    if (ctx.live.enabled) {
      const sid = input.session_id ?? `pid-${process.pid}`;
      await ctx.announcePresence(sid); // heartbeat — keeps this session "live" while active
      const fresh = await ctx.drainInbox(sid);
      if (fresh.length > 0) {
        const lines = fresh.map(
          (m) => `  ${m.at.slice(11, 16)} ${m.feature}·${m.owner}: ${m.text}`,
        );
        emit({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext:
              "📨 New messages from other coflow sessions in this project:\n" +
              lines.join("\n") +
              "\n(Reply with the `say` tool if warranted.)",
          },
        });
      }
    }
  } catch {
    // Swallow — recording/delivery is best-effort and must never disrupt work.
  }
  process.exit(0);
}
