import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import pc from "picocolors";
import { Context } from "../core/context.js";
import type { Feature } from "../core/schema.js";

/**
 * `coflow watch` — a live terminal dashboard for the shared context.
 *
 * Full-screen, auto-refreshing (timer + filesystem watch), dependency-free
 * (just picocolors). `--once` renders a single static frame instead — handy for
 * piping, CI, or a quick glance.
 */

const ESC = "\x1b";
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const HOME = `${ESC}[H`;
const CLEAR_BELOW = `${ESC}[0J`;
const CLEAR_EOL = `${ESC}[K`;

// --- ANSI-aware width helpers ----------------------------------------------

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
function vlen(s: string): number {
  return stripAnsi(s).length;
}
function padEnd(s: string, w: number): string {
  const pad = w - vlen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}
function truncate(s: string, max: number): string {
  if (vlen(s) <= max) return s;
  let out = "";
  let count = 0;
  let i = 0;
  while (i < s.length && count < max - 1) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    count++;
    i++;
  }
  return out + pc.dim("…") + `${ESC}[0m`;
}

// --- box drawing ------------------------------------------------------------

const b = (s: string) => pc.dim(s); // border color

function box(title: string, lines: string[], width: number): string[] {
  const inner = width - 4; // "│ " + content + " │"
  const out: string[] = [];
  const head = title ? `─ ${pc.bold(pc.cyan(title))} ` : "─";
  const fill = "─".repeat(Math.max(0, width - 2 - vlen(head)));
  out.push(b("╭") + b(head) + b(fill) + b("╮"));
  if (lines.length === 0) lines = [pc.dim("—")];
  for (const line of lines) {
    out.push(b("│ ") + padEnd(truncate(line, inner), inner) + b(" │"));
  }
  out.push(b("╰") + b("─".repeat(width - 2)) + b("╯"));
  return out;
}

// --- data snapshot ----------------------------------------------------------

interface Snapshot {
  project: string;
  you: string;
  feature: string;
  branch: string | null;
  active: Feature[];
  doneCount: number;
  activity: string[];
  collisions: Array<{ file: string; features: string[] }>;
  pending: number;
  group: string | null;
  stamp: string;
}

async function snapshot(ctx: Context): Promise<Snapshot> {
  await ctx.ready();
  const reg = ctx.store.registry();
  const feature = await ctx.currentFeatureId();
  const live = ctx.store.livePendingFiles();

  // File hotspots: any path claimed by more than one feature.
  const owners = new Map<string, Set<string>>();
  const add = (file: string, id: string) => {
    if (!owners.has(file)) owners.set(file, new Set());
    owners.get(file)!.add(id);
  };
  for (const f of reg.active) for (const file of f.files_touched) add(file, f.feature);
  for (const [id, files] of live) for (const file of files) add(file, id);
  const collisions = [...owners.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([file, set]) => ({ file, features: [...set].sort() }))
    .slice(0, 6);

  return {
    project: basename(ctx.store.p.repoRoot),
    you: (await ctx.git.userName()) ?? process.env.COFLOW_OWNER ?? "you",
    feature,
    branch: await ctx.git.currentBranch(),
    active: reg.active,
    doneCount: reg.all.filter((f) => f.status === "done").length,
    activity: ctx.recentActivity(8),
    collisions,
    pending: ctx.store.readPending(feature).length,
    group: ctx.live.enabled ? ctx.live.group : null,
    stamp: new Date().toISOString().slice(11, 19),
  };
}

// --- rendering --------------------------------------------------------------

const STATUS_COLOR: Record<string, (s: string) => string> = {
  active: pc.green,
  blocked: pc.red,
  paused: pc.yellow,
  done: pc.dim,
};

function statusDot(status: string): string {
  return (STATUS_COLOR[status] ?? pc.white)("●");
}

function featureLines(f: Feature, self: string): string[] {
  const c = STATUS_COLOR[f.status] ?? pc.white;
  const me = f.feature === self ? pc.cyan(" ‹you›") : "";
  const lines = [
    `${statusDot(f.status)} ${pc.bold(f.feature)}${me}  ${pc.magenta(f.owner)}  ${c(f.status)}`,
  ];
  if (f.goal) lines.push(`  ${pc.dim(f.goal)}`);
  if (f.files_touched.length) {
    lines.push(`  ${pc.dim("files:")} ${pc.dim(f.files_touched.slice(0, 4).join(", "))}${f.files_touched.length > 4 ? pc.dim(" …") : ""}`);
  }
  return lines;
}

const ACT_RE = /^- \d{4}-\d\d-\d\d (\d\d:\d\d) \*\*(.+?)\*\* \((.+?)\): (.*)$/;
function activityLine(raw: string): string {
  const m = ACT_RE.exec(raw);
  if (!m) return pc.dim(raw.replace(/^- /, ""));
  const [, time, feat, owner, msg] = m;
  return `${pc.dim(time)} ${pc.cyan(feat!)} ${pc.dim(`(${owner})`)} ${msg}`;
}

function renderFrame(s: Snapshot, width: number): string[] {
  const lines: string[] = [];

  // Header
  const meta =
    `${pc.cyan(pc.bold("◆ coflow"))}   ` +
    `${pc.dim("project")} ${pc.white(s.project)}   ` +
    `${pc.dim("you")} ${pc.magenta(s.you)}   ` +
    `${pc.dim("feature")} ${pc.bold(s.feature)}` +
    (s.branch ? pc.dim(`  ⎇ ${s.branch}`) : "") +
    (s.group ? `   ${pc.dim("✦ group")} ${pc.green(s.group)}` : "");
  lines.push(...box("", [meta], width));
  lines.push("");

  // Active features
  const feat: string[] = [];
  if (s.active.length === 0) feat.push(pc.dim("No active features yet."));
  for (const f of s.active.sort((a, b2) => b2.updated_at.localeCompare(a.updated_at))) {
    feat.push(...featureLines(f, s.feature));
    feat.push("");
  }
  if (feat[feat.length - 1] === "") feat.pop();
  lines.push(...box(`active features (${s.active.length})`, feat, width));
  lines.push("");

  // Collisions / hotspots
  if (s.collisions.length) {
    const col = s.collisions.map(
      (c) => `${pc.yellow("⚠")} ${pc.yellow(c.file)} ${pc.dim("→")} ${c.features.join(pc.dim(", "))}`,
    );
    lines.push(...box("file hotspots", col, width));
    lines.push("");
  }

  // Activity feed
  const act = s.activity.length
    ? s.activity.map(activityLine)
    : [pc.dim("No activity yet — try `coflow say \"…\"`.")];
  lines.push(...box("activity", act, width));
  lines.push("");

  // Footer
  const footer =
    `${pc.dim("pending")} ${s.pending}   ` +
    `${pc.dim("done")} ${s.doneCount}   ` +
    pc.dim("·") +
    `   ${pc.bold("q")}${pc.dim(" quit")}  ${pc.bold("r")}${pc.dim(" refresh")}   ` +
    pc.dim(`updated ${s.stamp}`);
  lines.push("  " + footer);

  return lines;
}

// --- run --------------------------------------------------------------------

function termWidth(): number {
  return Math.min(Math.max(process.stdout.columns ?? 84, 64), 100);
}

export async function runDashboard(opts: { once?: boolean } = {}): Promise<void> {
  const ctx = new Context();

  const draw = async (live: boolean) => {
    const frame = renderFrame(await snapshot(ctx), termWidth());
    if (live) {
      process.stdout.write(HOME + frame.join(CLEAR_EOL + "\n") + CLEAR_EOL + CLEAR_BELOW);
    } else {
      process.stdout.write(frame.join("\n") + "\n");
    }
  };

  if (opts.once || !process.stdout.isTTY) {
    await draw(false);
    return;
  }

  // Live mode.
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  const refresh = () => void draw(true);

  const cleanup = () => {
    if (debounce) clearTimeout(debounce);
    clearInterval(timer);
    watcher?.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(CURSOR_SHOW + ALT_OFF);
  };

  process.stdout.write(ALT_ON + CURSOR_HIDE);
  await draw(true);

  const timer = setInterval(refresh, 1000);
  try {
    watcher = watch(ctx.store.p.contextDir, { recursive: true }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(refresh, 120);
    });
  } catch {
    /* fs.watch unsupported — the 1s timer still refreshes */
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (d) => {
    const k = d.toString();
    if (k === "q" || k === "\x03" || k === "\x1b") {
      cleanup();
      process.exit(0);
    } else if (k === "r") {
      refresh();
    }
  });
  process.stdout.on("resize", refresh);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}
