import { existsSync, readFileSync } from "node:fs";
import pc from "picocolors";
import { Context } from "../core/context.js";
import { readJsonSafe } from "../core/jsonfile.js";
import { banner } from "./brand.js";

/**
 * `coflow doctor` — a health/observability report. Because the hooks swallow
 * errors to stay resilient, this is the one place that surfaces what's actually
 * working: git, store, the live channel reachability, config, and presence.
 */

type Status = "ok" | "warn" | "fail";

export async function runDoctor(): Promise<void> {
  const ctx = new Context();
  await ctx.ready();
  const p = ctx.store.p;

  const checks: Array<{ s: Status; label: string; detail: string }> = [];
  const add = (s: Status, label: string, detail: string) => checks.push({ s, label, detail });

  // Git
  const isRepo = await ctx.git.isRepo();
  const remote = isRepo ? await ctx.git.remoteUrl() : null;
  add(isRepo ? "ok" : "warn", "git", isRepo ? p.repoRoot : "not a git repo (sync limited)");
  add(remote ? "ok" : "warn", "remote", remote ?? "none — local-only; checkpoints won't push");

  // Store
  add("ok", "store", p.mode === "worktree" ? `worktree · branch '${p.branch}'` : "inline (.context/)");
  add("ok", "features", `${ctx.store.listFeatureIds().length} feature file(s)`);
  const feature = await ctx.currentFeatureId();
  add("ok", "this session", `feature '${feature}' · ${ctx.store.readPending(feature).length} pending delta(s)`);

  // Live channel
  if (ctx.live.enabled) {
    const h = await ctx.liveHealth();
    add(h.ok ? "ok" : "fail", "group chat", `${ctx.live.kind} · group ${ctx.live.group}`);
    add(h.ok ? "ok" : "fail", "reachable", h.detail);
    const members = await ctx.live.members().catch(() => []);
    add("ok", "live sessions", members.length ? members.map((m) => `${m.feature}(${m.owner})`).join(", ") : "none active right now");
  } else {
    add("warn", "group chat", "not connected — run `coflow connect` to enable real-time chat");
  }

  // Chat memory (daily summaries)
  if (p.dailySummaries) {
    const days = ctx.chatSummaries.list();
    add(
      "ok",
      "chat memory",
      `daily summaries on · window ${p.windowHours}h · tz ${p.timezone} · ` +
        `${days.length} day(s) stored${p.autoCommitSummaries ? " · auto-commit" : ""}`,
    );
  } else {
    add("warn", "chat memory", "daily summaries disabled (.coflow.json)");
  }

  // Config
  const mcp = readJsonSafe<{ mcpServers?: Record<string, unknown> }>(p.configFile);
  const hasMcp = Boolean(mcp?.mcpServers && (mcp.mcpServers as Record<string, unknown>).coflow);
  add(hasMcp ? "ok" : "fail", "mcp server", hasMcp ? ".mcp.json registers coflow" : "missing — run `coflow init`");

  const settings = readJsonSafe<{ hooks?: Record<string, unknown[]>; permissions?: { allow?: string[] } }>(p.settingsFile);
  const hookCount = settings?.hooks ? Object.keys(settings.hooks).length : 0;
  add(hookCount >= 4 ? "ok" : "warn", "hooks", `${hookCount} hook event(s) installed`);
  const permCount = (settings?.permissions?.allow ?? []).filter((a) => a.startsWith("mcp__coflow__")).length;
  add(permCount >= 3 ? "ok" : "warn", "permissions", `${permCount} coflow tool(s) pre-approved (no prompts)`);

  const claudeOk = existsSync(p.claudeMd) && readFileSync(p.claudeMd, "utf8").includes("<!-- coflow -->");
  add(claudeOk ? "ok" : "warn", "CLAUDE.md", claudeOk ? "coflow guidance present" : "missing — run `coflow init`");

  // Render
  console.log(banner("doctor"));
  const mark = (s: Status) => (s === "ok" ? pc.green("✓") : s === "warn" ? pc.yellow("!") : pc.red("✗"));
  for (const c of checks) console.log(`  ${mark(c.s)} ${c.label.padEnd(14)} ${pc.dim(c.detail)}`);

  const fails = checks.filter((c) => c.s === "fail").length;
  const warns = checks.filter((c) => c.s === "warn").length;
  console.log("");
  console.log(
    fails
      ? pc.red(`  ${fails} problem(s) · ${warns} warning(s)`)
      : warns
        ? pc.yellow(`  healthy · ${warns} note(s)`)
        : pc.green("  all healthy ✓"),
  );
  console.log("");
  if (fails) process.exitCode = 1;
}
