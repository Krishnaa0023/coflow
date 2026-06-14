import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Git helpers. We shell out to the user's `git` rather than linking a native
 * libgit2 binding — it inherits their credentials and config for free, and
 * keeps the npx one-liner dependency-light (no native build step).
 *
 * Push happens ONLY at checkpoints, never per-edit: a network call in the
 * PostToolUse hot loop turns every session to molasses, and per-edit writes
 * create contention.
 */

export class Git {
  constructor(private readonly cwd: string) {}

  private async run(
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await exec("git", args, {
        cwd: this.cwd,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const detail = e.stderr ? e.stderr.toString() : e.message ?? String(err);
      throw new Error(`git ${args.join(" ")} failed: ${detail.trim()}`);
    }
  }

  /** Initialise a new repository in cwd. */
  async init(): Promise<void> {
    await this.run(["init"]);
  }

  async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.run(["rev-parse", "--is-inside-work-tree"]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async hasRemote(): Promise<boolean> {
    try {
      const { stdout } = await this.run(["remote"]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async remoteUrl(name = "origin"): Promise<string | null> {
    try {
      const { stdout } = await this.run(["remote", "get-url", name]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async currentBranch(): Promise<string | null> {
    try {
      // `--show-current` resolves even on an unborn branch (no commits yet),
      // unlike `rev-parse HEAD` which errors before the first commit. Returns
      // empty on detached HEAD.
      const { stdout } = await this.run(["branch", "--show-current"]);
      const b = stdout.trim();
      return b || null;
    } catch {
      return null;
    }
  }

  async userName(): Promise<string | null> {
    try {
      const { stdout } = await this.run(["config", "user.name"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // --- worktree / dedicated-branch support -----------------------------------

  async localBranchExists(branch: string): Promise<boolean> {
    try {
      await this.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async remoteBranchExists(branch: string, remote = "origin"): Promise<boolean> {
    if (!(await this.hasRemote())) return false;
    try {
      const { stdout } = await this.run(["ls-remote", "--heads", remote, branch]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async tryFetch(branch?: string, remote = "origin"): Promise<void> {
    if (!(await this.hasRemote())) return;
    try {
      await this.run(branch ? ["fetch", remote, branch] : ["fetch", remote]);
    } catch {
      /* offline / no such branch — fine */
    }
  }

  /**
   * Ensure a worktree for `branch` is checked out at `worktreeDir`. Attaches to
   * an existing local/remote branch if present; otherwise creates a true ORPHAN
   * root (empty tree) via plumbing — without ever touching the code working tree.
   * Does NOT push (the first push happens at a checkpoint, deliberately).
   */
  async ensureContextWorktree(branch: string, worktreeDir: string): Promise<void> {
    if (existsSync(join(worktreeDir, ".git"))) return; // already linked
    mkdirSync(dirname(worktreeDir), { recursive: true });
    try {
      await this.run(["worktree", "prune"]);
    } catch {
      /* ignore */
    }
    await this.tryFetch(branch);

    if (await this.localBranchExists(branch)) {
      await this.run(["worktree", "add", worktreeDir, branch]);
    } else if (await this.remoteBranchExists(branch)) {
      await this.run([
        "worktree",
        "add",
        "-b",
        branch,
        worktreeDir,
        `origin/${branch}`,
      ]);
    } else {
      // Orphan root commit with an empty tree — no parent, no code, no HEAD move.
      const empty = (
        await this.run(["hash-object", "-t", "tree", "/dev/null"])
      ).stdout.trim();
      const commit = (
        await this.run(["commit-tree", empty, "-m", "coflow: context root"])
      ).stdout.trim();
      await this.run(["branch", branch, commit]);
      await this.run(["worktree", "add", worktreeDir, branch]);
    }
  }

  /** Pull latest. Fast-forward only — context files are one-per-author, so a
   * non-ff divergence means something is off and we'd rather fail loudly. */
  async pull(): Promise<{ ok: boolean; message: string }> {
    if (!(await this.hasRemote())) {
      return { ok: false, message: "no remote configured" };
    }
    try {
      const { stdout } = await this.run(["pull", "--ff-only", "--no-edit"]);
      return { ok: true, message: stdout.trim() || "up to date" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Stage the given paths, commit, and push. The ONE place that writes remote. */
  async commitAndPush(
    paths: string[],
    message: string,
  ): Promise<{ committed: boolean; pushed: boolean; message: string }> {
    await this.run(["add", "--", ...paths]);

    // Nothing staged? Then there is nothing to do.
    const status = await this.run(["status", "--porcelain", "--", ...paths]);
    if (!status.stdout.trim()) {
      return { committed: false, pushed: false, message: "no changes to commit" };
    }

    await this.run(["commit", "-m", message]);

    if (!(await this.hasRemote())) {
      return {
        committed: true,
        pushed: false,
        message: "committed locally (no remote to push to)",
      };
    }
    try {
      await this.run(["push"]);
      return { committed: true, pushed: true, message: "committed and pushed" };
    } catch {
      // Brand-new branch with no upstream (e.g. first push of the dedicated
      // context branch) — set it and retry.
      try {
        await this.run(["push", "-u", "origin", "HEAD"]);
        return { committed: true, pushed: true, message: "committed and pushed (upstream set)" };
      } catch (err) {
        return {
          committed: true,
          pushed: false,
          message: `committed but push failed: ${(err as Error).message}`,
        };
      }
    }
  }

  /**
   * Squash the current branch to a single root commit holding the current tree.
   * Used by `coflow compact` on the dedicated context branch to fight commit
   * bloat — safe there because nobody branches off it. Run in the worktree.
   */
  async compactCurrentBranch(
    message: string,
  ): Promise<{ before: number; after: number }> {
    const before = parseInt(
      (await this.run(["rev-list", "--count", "HEAD"])).stdout.trim() || "0",
      10,
    );
    const tree = (await this.run(["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const commit = (await this.run(["commit-tree", tree, "-m", message])).stdout.trim();
    await this.run(["reset", "--hard", commit]);
    return { before, after: 1 };
  }

  /** Force-push the current branch (with lease). For post-compact sync. */
  async forcePush(): Promise<{ ok: boolean; message: string }> {
    if (!(await this.hasRemote())) return { ok: false, message: "no remote configured" };
    try {
      await this.run(["push", "--force-with-lease", "-u", "origin", "HEAD"]);
      return { ok: true, message: "force-pushed (with lease)" };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
