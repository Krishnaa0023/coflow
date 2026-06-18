import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Resolve symlinks so the same repo always yields the same string (e.g. macOS
 * /tmp vs /private/tmp). The worktree path is keyed off this, so it must be
 * stable across `init` and every hook invocation. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve the project (code) repo root: the nearest ancestor of `start` that
 * contains a `.git` or a `.context/`. Claude Code runs hooks and the MCP server
 * with the project as cwd, so `start` defaults to cwd. Returns a canonical path.
 */
export function resolveRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, ".context")) ||
      existsSync(join(dir, ".coflow.json"))
    ) {
      return canonical(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return canonical(resolve(start));
}

export type StoreMode = "inline" | "worktree";
const DEFAULT_BRANCH = "coflow-context";
const DEFAULT_WINDOW_HOURS = 24;

export interface CoflowConfig {
  /** "inline" = .context/ in the code repo; "worktree" = a dedicated branch. */
  store: StoreMode;
  /** The dedicated branch name in worktree mode. */
  branch: string;
  /** Roll chat older than the window into per-day summaries. Default on. */
  dailySummaries: boolean;
  /** How long chat stays "fresh" (raw, in-context) before being summarized. */
  windowHours: number;
  /** Day-bucketing / display zone: "local" (default), "utc", or an IANA name. */
  timezone: string;
  /** Commit summary files automatically. Default: on in worktree, off inline. */
  autoCommitSummaries: boolean;
}

/** Read .coflow.json from the code repo root. Absent/invalid → safe defaults. */
export function readCoflowConfig(repoRoot: string): CoflowConfig {
  const f = join(repoRoot, ".coflow.json");
  let j: Record<string, unknown> = {};
  if (existsSync(f)) {
    try {
      j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    } catch {
      j = {}; // malformed config fails soft to defaults
    }
  }
  const store: StoreMode = j.store === "worktree" ? "worktree" : "inline";
  const windowHours =
    typeof j.windowHours === "number" && Number.isFinite(j.windowHours) && j.windowHours > 0
      ? j.windowHours
      : DEFAULT_WINDOW_HOURS;
  return {
    store,
    branch: typeof j.branch === "string" && j.branch ? j.branch : DEFAULT_BRANCH,
    dailySummaries: j.dailySummaries === false ? false : true,
    windowHours,
    timezone: typeof j.timezone === "string" && j.timezone ? j.timezone : "local",
    // Worktree has its own isolated branch, so auto-commit is safe & expected
    // there; inline lands on the user's code branch, so default to NOT committing.
    autoCommitSummaries:
      typeof j.autoCommitSummaries === "boolean"
        ? j.autoCommitSummaries
        : store === "worktree",
  };
}

// Tiny stable non-crypto hash, for naming the per-clone worktree directory.
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/**
 * Where the dedicated-branch worktree is checked out — OUTSIDE the code repo, so
 * the code working tree is never touched. Keyed by the repo path so every
 * terminal on the same clone shares one worktree (and thus one local activity
 * log + pending queue).
 */
export function worktreePath(repoRoot: string, branch: string): string {
  return join(homedir(), ".coflow", "worktrees", `${shortHash(repoRoot)}-${branch}`);
}

export interface ContextPaths {
  /** The code repo (where the user's files + committed config live). */
  repoRoot: string;
  /** The context store root: == repoRoot inline, == worktree dir in worktree mode. */
  root: string;
  mode: StoreMode;
  branch: string;
  contextDir: string;
  featuresDir: string;
  pendingDir: string;
  chatSummariesDir: string; // .context/chat-summaries (committed — durable)
  locksDir: string; // .context/.locks (local-only)
  boardFile: string; // .context/BOARD.md
  activityFile: string; // .context/activity.md
  configFile: string; // .mcp.json        (at repoRoot)
  settingsFile: string; // .claude/settings.json (at repoRoot)
  claudeMd: string; // CLAUDE.md         (at repoRoot)
  coflowConfig: string; // .coflow.json   (at repoRoot)
  // Resolved chat-memory config (see CoflowConfig).
  dailySummaries: boolean;
  windowHours: number;
  timezone: string;
  autoCommitSummaries: boolean;
}

export function paths(start?: string): ContextPaths {
  const repoRoot = resolveRoot(start);
  const cfg = readCoflowConfig(repoRoot);
  const root = cfg.store === "worktree" ? worktreePath(repoRoot, cfg.branch) : repoRoot;
  const contextDir = join(root, ".context");
  return {
    repoRoot,
    root,
    mode: cfg.store,
    branch: cfg.branch,
    contextDir,
    featuresDir: join(contextDir, "features"),
    pendingDir: join(contextDir, ".pending"),
    chatSummariesDir: join(contextDir, "chat-summaries"),
    locksDir: join(contextDir, ".locks"),
    boardFile: join(contextDir, "BOARD.md"),
    activityFile: join(contextDir, "activity.md"),
    configFile: join(repoRoot, ".mcp.json"),
    settingsFile: join(repoRoot, ".claude", "settings.json"),
    claudeMd: join(repoRoot, "CLAUDE.md"),
    coflowConfig: join(repoRoot, ".coflow.json"),
    dailySummaries: cfg.dailySummaries,
    windowHours: cfg.windowHours,
    timezone: cfg.timezone,
    autoCommitSummaries: cfg.autoCommitSummaries,
  };
}

/**
 * Convert a filesystem path to forward slashes. Node accepts these on every OS,
 * and unlike backslashes they survive being embedded in JSON config and shell
 * command strings — a Windows path like `C:\Users\me\app.js` otherwise has its
 * `\U`, `\m`, … eaten as escape sequences and collapses to a broken relative path.
 */
export function portablePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Candidate executable filenames for a bare command on `platform`. On Windows a
 * global npm bin is `coflow.cmd` (plus `.ps1`/`.exe`), never bare `coflow`, so
 * PATH lookups must try each PATHEXT extension. POSIX uses the bare name.
 */
export function executableNames(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  pathext: string = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
): string[] {
  if (platform !== "win32") return [cmd];
  const exts = pathext
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => (e.startsWith(".") ? e : `.${e}`));
  return [cmd, ...exts.map((e) => cmd + e)];
}

/** Sanitise an arbitrary feature/branch name into a safe, stable file stem. */
export function featureId(nameOrBranch: string): string {
  return (
    nameOrBranch
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 80) || "unnamed"
  );
}
