import { Context } from "../core/context.js";
import { readHookInput, emit, filesFromToolInput } from "./io.js";

/**
 * PreToolUse on Edit|Write: check the files about to be touched against other
 * features and ask for confirmation on a collision.
 *
 * This is the hot path — it MUST stay fast, so it runs the structural check
 * only (a set intersection, no network, no embeddings). On any error it allows
 * the edit: the awareness layer should never hard-block real work.
 */
export async function run(): Promise<void> {
  try {
    const input = await readHookInput();
    const files = filesFromToolInput(input.tool_input);
    if (files.length === 0) {
      allow();
      return;
    }

    const ctx = new Context(input.cwd);
    const { hits } = await ctx.checkOverlap(files);

    if (hits.length === 0) {
      allow();
      return;
    }

    const reason =
      "⚠️ coflow overlap — these files are also being worked on:\n" +
      hits
        .map((h) => {
          const tag = h.inProgress ? "[in progress now]" : "[committed]";
          return `  • ${h.owner}'s "${h.feature}" (${h.status}) ${tag} → ${h.shared.join(", ")}`;
        })
        .join("\n") +
      "\nConsider a quick `say` to coordinate before you edit.";

    // Non-blocking: allow the edit (no permission prompt) but inject the heads-up
    // so Claude is aware and can self-coordinate. Friction-free by design.
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: reason,
      },
    });
  } catch {
    allow();
  }
  process.exit(0);
}

function allow(): void {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  });
}
