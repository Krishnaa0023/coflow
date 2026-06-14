import { spawn } from "node:child_process";
import { Context } from "../core/context.js";
import { featureId } from "../core/paths.js";
import { readJsonSafe } from "../core/jsonfile.js";

/**
 * `coflow claude [--as <name>] [...claude args]` — launch Claude Code with an
 * auto-assigned, distinct identity so you never set COFLOW_FEATURE by hand.
 *
 * Identity selection:
 *   --as <name>     → use that name
 *   otherwise       → first free name from the group's pool (the first instance
 *                     takes pool[0], the next takes pool[1], …). The pool is
 *                     `.coflow.json` "identities" if set, else agent-1, agent-2…
 */

const DEFAULT_POOL = ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5", "agent-6"];

async function pickIdentity(ctx: Context): Promise<string> {
  const cfg = readJsonSafe<{ identities?: string[] }>(ctx.store.p.coflowConfig);
  const pool = (cfg?.identities?.length ? cfg.identities : DEFAULT_POOL).map(featureId);

  let taken = new Set<string>();
  try {
    taken = new Set((await ctx.live.members()).map((m) => m.feature));
  } catch {
    /* no group / offline → can't see peers; first free wins */
  }

  for (const name of pool) if (!taken.has(name)) return name;
  let n = pool.length + 1;
  while (taken.has(`agent-${n}`)) n++;
  return `agent-${n}`;
}

export async function launchClaude(rawArgs: string[]): Promise<void> {
  const args = [...rawArgs];

  // Explicit override: --as <name>
  let explicit: string | undefined;
  const asIdx = args.indexOf("--as");
  if (asIdx !== -1) {
    explicit = args[asIdx + 1];
    args.splice(asIdx, explicit !== undefined ? 2 : 1);
  }

  const ctx = new Context();
  await ctx.ready();
  const identity = explicit ? featureId(explicit) : await pickIdentity(ctx);

  // Reserve the identity immediately so a near-simultaneous launch picks a
  // different one (the real session re-announces under its own id at start).
  if (ctx.live.enabled) {
    try {
      const owner =
        (await ctx.git.userName()) ?? process.env.COFLOW_OWNER ?? process.env.USER ?? "you";
      await ctx.live.announce({
        id: `launch-${identity}`,
        feature: identity,
        owner,
        at: new Date().toISOString(),
      });
    } catch {
      /* best-effort */
    }
  }

  if (process.env.COFLOW_LAUNCH_DRYRUN) {
    console.log(`would launch: claude ${args.join(" ")}  (COFLOW_FEATURE=${identity})`);
    return;
  }

  process.stderr.write(`coflow: launching Claude as "${identity}"\n`);
  const child = spawn("claude", args, {
    stdio: "inherit",
    env: { ...process.env, COFLOW_FEATURE: identity },
  });
  child.on("error", (err) => {
    process.stderr.write(
      `coflow: could not launch claude — ${(err as Error).message}. Is Claude Code installed and on PATH?\n`,
    );
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
