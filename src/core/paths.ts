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

export interface CoflowConfig {
  /** "inline" = .context/ in the code repo; "worktree" = a dedicated branch. */
  store: StoreMode;
  /** The dedicated branch name in worktree mode. */
  branch: string;
}

/** Read .coflow.json from the code repo root. Absent → inline mode. */
export function readCoflowConfig(repoRoot: string): CoflowConfig {
  const f = join(repoRoot, ".coflow.json");
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as Partial<CoflowConfig>;
      return {
        store: j.store === "worktree" ? "worktree" : "inline",
        branch: j.branch && typeof j.branch === "string" ? j.branch : DEFAULT_BRANCH,
      };
    } catch {
      /* fall through */
    }
  }
  return { store: "inline", branch: DEFAULT_BRANCH };
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
  boardFile: string; // .context/BOARD.md
  activityFile: string; // .context/activity.md
  configFile: string; // .mcp.json        (at repoRoot)
  settingsFile: string; // .claude/settings.json (at repoRoot)
  claudeMd: string; // CLAUDE.md         (at repoRoot)
  coflowConfig: string; // .coflow.json   (at repoRoot)
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
    boardFile: join(contextDir, "BOARD.md"),
    activityFile: join(contextDir, "activity.md"),
    configFile: join(repoRoot, ".mcp.json"),
    settingsFile: join(repoRoot, ".claude", "settings.json"),
    claudeMd: join(repoRoot, "CLAUDE.md"),
    coflowConfig: join(repoRoot, ".coflow.json"),
  };
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
