#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Context } from "../core/context.js";
import { FeatureStatus } from "../core/schema.js";

/** The installed package version, read from package.json at the package root. */
function coflowVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Single entry point for the package's bin. Routes:
 *   coflow init [--yes] [--npx]   set up config + store
 *   coflow mcp                     start the MCP server (stdio)
 *   coflow hook <name>             run a hook handler (used by settings.json)
 *   coflow pull                    manual pull + reindex
 *   coflow status                  show active features + pending deltas
 *   coflow summary                 print the injection summary
 *   coflow search <query>          search features
 *   coflow checkpoint [--summary s] [--status st]   flush + push
 */

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1] ?? "";
}
function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

const COMMANDS = [
  "init", "connect", "claude", "go", "chat", "doctor", "watch", "say", "activity",
  "status", "summary", "summarize-chat", "board", "search", "checkpoint", "compact",
  "pull", "mcp", "hook", "help", "version",
];

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function didYouMean(cmd: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of COMMANDS) {
    const d = levenshtein(cmd, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= 2 ? best : null;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "init": {
      const { init } = await import("./init.js");
      await init({
        yes: has(rest, "yes"),
        mode: has(rest, "npx") ? "npx" : undefined,
        store: has(rest, "worktree") ? "worktree" : undefined,
        branch: flag(rest, "branch") || undefined,
      });
      return;
    }

    case "mcp": {
      const { main: runServer } = await import("../mcp.js");
      await runServer();
      return;
    }

    case "hook": {
      const name = rest[0];
      const handlers: Record<string, () => Promise<{ run: () => Promise<void> }>> = {
        "session-start": () => import("../hooks/session-start.js"),
        "pre-tool-use": () => import("../hooks/pre-tool-use.js"),
        "post-tool-use": () => import("../hooks/post-tool-use.js"),
        "session-end": () => import("../hooks/session-end.js"),
        stop: () => import("../hooks/stop.js"),
      };
      const load = name ? handlers[name] : undefined;
      if (!load) {
        process.stderr.write(`unknown hook: ${name ?? "(none)"}\n`);
        process.exit(2);
      }
      const mod = await load();
      await mod.run();
      return;
    }

    case "pull": {
      const ctx = new Context();
      const r = await ctx.pull();
      console.log(`git: ${r.git.message}`);
      console.log("board: regenerated");
      return;
    }

    case "board": {
      const ctx = new Context();
      await ctx.ready();
      ctx.refreshBoard();
      console.log(`board written: ${ctx.store.p.boardFile}`);
      return;
    }

    case "say": {
      const msg = rest.join(" ").trim();
      if (!msg) {
        process.stderr.write("usage: coflow say <message>\n");
        process.exit(2);
      }
      const ctx = new Context();
      const r = await ctx.say(msg);
      console.log(`posted to activity log as "${r.feature}"`);
      return;
    }

    case "activity": {
      const ctx = new Context();
      await ctx.ready();
      const lines = ctx.recentActivity(20);
      console.log(lines.length ? lines.join("\n") : "(no activity yet)");
      return;
    }

    case "watch":
    case "dashboard":
    case "ui": {
      const { runDashboard } = await import("./dashboard.js");
      await runDashboard({ once: has(rest, "once") });
      return;
    }

    case "connect": {
      const { connect } = await import("./connect.js");
      const positional = rest.find((a) => !a.startsWith("-"));
      await connect({
        key: flag(rest, "key") || (positional?.startsWith("coflow1_") ? positional : undefined),
        create: has(rest, "new") || has(rest, "create"),
        upstash: has(rest, "upstash"),
        url: flag(rest, "url"),
        token: flag(rest, "token"),
      });
      return;
    }

    case "chat": {
      const { runChat } = await import("./chat.js");
      await runChat({ raw: has(rest, "raw") });
      return;
    }

    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor();
      return;
    }

    case "compact": {
      const ctx = new Context();
      await ctx.ready();
      if (ctx.store.p.mode !== "worktree") {
        process.stderr.write(
          "compact only applies in worktree mode (the dedicated context branch).\n",
        );
        process.exit(2);
      }
      const r = await ctx.gitStore.compactCurrentBranch("coflow: compacted context");
      console.log(`squashed ${r.before} → ${r.after} commit(s) on '${ctx.store.p.branch}'`);
      const pushed = await ctx.gitStore.forcePush();
      console.log(pushed.ok ? pushed.message : `not pushed: ${pushed.message}`);
      return;
    }

    case "claude":
    case "go": {
      const { launchClaude } = await import("./launch.js");
      await launchClaude(rest);
      return;
    }

    case "status": {
      const ctx = new Context();
      await ctx.ready();
      const id = await ctx.currentFeatureId();
      const pending = ctx.store.readPending(id);
      console.log(`current feature: ${id}`);
      console.log(`pending deltas : ${pending.length}`);
      console.log("");
      console.log(await ctx.summary(id));
      return;
    }

    case "summary": {
      const ctx = new Context();
      console.log(await ctx.summary());
      return;
    }

    // Recovery/debug only — summarization runs automatically (SessionStart,
    // `coflow chat`, and after edits). You should rarely need this by hand.
    case "summarize-chat": {
      const ctx = new Context();
      await ctx.ready();
      if (!ctx.store.p.dailySummaries) {
        console.log("daily summaries are disabled (.coflow.json: \"dailySummaries\": false)");
        return;
      }
      if (!ctx.live.enabled) {
        console.log("no group connected — nothing to summarize (run `coflow connect`)");
        return;
      }
      const r = await ctx.summarizeChat({ force: has(rest, "force") });
      console.log(
        r.written.length
          ? `summaries written: ${r.written.join(", ")}`
          : "summaries up to date (nothing to write)",
      );
      if (r.skipped.length) console.log(`unchanged: ${r.skipped.join(", ")}`);
      return;
    }

    case "search": {
      const q = rest.join(" ").trim();
      if (!q) {
        process.stderr.write("usage: coflow search <query>\n");
        process.exit(2);
      }
      const ctx = new Context();
      await ctx.ready();
      const results = ctx.search(q);
      if (results.length === 0) {
        console.log("no matches");
        return;
      }
      for (const m of results) {
        console.log(`${m.feature.feature} — ${m.feature.owner}: ${m.feature.goal}`);
      }
      return;
    }

    case "checkpoint": {
      const ctx = new Context();
      const statusArg = flag(rest, "status");
      const status = statusArg ? FeatureStatus.parse(statusArg) : undefined;
      const r = await ctx.checkpoint({
        summary: flag(rest, "summary"),
        goal: flag(rest, "goal"),
        status,
      });
      console.log(`checkpoint ${r.feature}: ${r.message}`);
      console.log(`folded ${r.deltasFolded} delta(s)`);
      if (r.redactionHits.length) {
        console.log(`redacted: ${r.redactionHits.join(", ")}`);
      }
      return;
    }

    case undefined: {
      // Bare `coflow`: animated front door in a terminal; plain help when piped.
      if (process.stdout.isTTY) {
        const { landing } = await import("./landing.js");
        await landing();
        return;
      }
      printHelp();
      return;
    }

    case "version":
    case "--version":
    case "-v": {
      console.log(`coflow ${coflowVersion()}`);
      return;
    }

    case "help":
    case "--help":
    case "-h": {
      printHelp();
      return;
    }

    default: {
      const guess = cmd ? didYouMean(cmd) : null;
      process.stderr.write(
        `unknown command: ${cmd}${guess ? ` — did you mean \`coflow ${guess}\`?` : ""}\n\n`,
      );
      printHelp();
      process.exit(2);
    }
  }
}

function printHelp(): void {
  console.log(`coflow - shared project context for Claude Code

usage:
  coflow init [--yes] [--npx] [--worktree] [--branch <name>]
                                          set up .mcp.json, hooks, CLAUDE.md, store
  coflow connect [<key>] [--new] [--upstash --url U --token T]
                                          create a group (get a key) or join one
  coflow claude [--as <name>] [...]       launch Claude Code with an auto-assigned identity
  coflow chat [--raw]            live group chat, grouped by day (--raw: expand summarized days)
  coflow doctor                  health check: git, channel, config, presence
  coflow watch [--once]          live terminal dashboard
  coflow say <message>           broadcast a note to the group
  coflow activity                show recent cross-session activity
  coflow status                  current feature + pending + summary
  coflow summary                 active features + recent activity
  coflow summarize-chat [--force]  roll stale chat into daily summaries (runs automatically; this is recovery)
  coflow board                   regenerate .context/BOARD.md
  coflow search <query>          substring search across features
  coflow checkpoint [--summary s] [--status st] [--goal g]
  coflow compact                 squash the context branch (worktree mode)
  coflow pull                    fetch + regenerate board
  coflow mcp                     start the MCP server (stdio)
  coflow hook <name>             run a hook (settings.json uses this)
  coflow version                 print the installed version (also --version, -v)

hook names: session-start | pre-tool-use | post-tool-use | stop | session-end`);
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
});
