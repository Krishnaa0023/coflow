import { Store } from "./store.js";
import { Git } from "./git.js";
import {
  applyDelta,
  newFeature,
  type Delta,
  type DeltaKind,
  type Feature,
  type FeatureStatus,
} from "./schema.js";
import { featureId } from "./paths.js";
import { redact } from "./redact.js";
import {
  committedOverlap,
  liveOverlap,
  mergeHits,
  type OverlapResult,
} from "./overlap.js";
import { resolveChannel, type ChatMessage, type LiveChannel } from "./live.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonSafe, writeJson } from "./jsonfile.js";

/** Min gap between inbox network reads on the hot path (protects Upstash budget). */
const INBOX_THROTTLE_MS = 4000;

/**
 * The service layer. Every MCP tool and every hook routes through here, so the
 * read/write/merge/sync logic lives in exactly one place.
 *
 * Two coordination planes:
 *   - team / cross-machine : per-feature Markdown files synced via git at checkpoints
 *   - same-machine siblings: the shared activity log + live pending queues, read
 *     straight off disk with no git round-trip
 */
export class Context {
  readonly store: Store;
  /** Code repo ops: branch, user, and worktree management. */
  readonly git: Git;
  /** Context-store ops: pull/commit/push. Same as `git` inline; the worktree in worktree mode. */
  readonly gitStore: Git;
  /** Real-time group-chat channel (no-op unless a group is connected). */
  readonly live: LiveChannel;
  private ensured = false;

  constructor(start?: string) {
    this.store = new Store(start);
    this.git = new Git(this.store.p.repoRoot);
    this.gitStore = new Git(this.store.p.root);
    this.live = resolveChannel(this.store.p);
  }

  /** Publish to the group chat, best-effort. Never throws into the caller. */
  private async broadcast(m: {
    feature: string;
    owner: string;
    kind: ChatMessage["kind"];
    text: string;
  }): Promise<void> {
    if (!this.live.enabled) return;
    try {
      await this.live.publish({
        at: this.now(),
        group: this.live.group ?? "",
        feature: m.feature,
        owner: m.owner,
        kind: m.kind,
        text: redact(m.text).text,
      });
    } catch {
      /* offline — the local log / git still captured it */
    }
  }

  /** Announce presence in the group (used by `chat` / `watch`). */
  async presence(text = "joined"): Promise<void> {
    await this.ready();
    const owner = await this.resolveOwner();
    const id = await this.currentFeatureId();
    await this.broadcast({ feature: id, owner, kind: "presence", text });
  }

  /** Register/refresh this session in the group's presence list (best-effort). */
  async announcePresence(id: string): Promise<void> {
    if (!this.live.enabled) return;
    await this.ready();
    try {
      const owner = await this.resolveOwner();
      const feature = await this.currentFeatureId();
      await this.live.announce({ id, feature, owner, at: this.now() });
    } catch {
      /* offline */
    }
  }

  /** Remove this session from presence on a clean close (best-effort). */
  async dropPresence(id: string): Promise<void> {
    if (!this.live.enabled) return;
    try {
      await this.live.removePresence(id);
    } catch {
      /* offline */
    }
  }

  /** Live channel reachability, for `coflow doctor`. */
  async liveHealth(): Promise<{ ok: boolean; detail: string }> {
    return this.live.health();
  }

  // --- inbox: auto-deliver peer messages mid-session --------------------------

  private seenPath(sessionId: string): string {
    const safe = (sessionId || "anon").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
    const group = this.live.group ?? "nogroup";
    return join(homedir(), ".coflow", "seen", `${group}__${safe}.json`);
  }

  /** Mark all current group messages as already seen (call at session start). */
  async markInboxSeen(sessionId: string): Promise<void> {
    if (!this.live.enabled) return;
    try {
      const history = await this.live.history(50);
      const at = history.reduce((m, x) => (x.at > m ? x.at : m), "");
      writeJson(this.seenPath(sessionId), { at, drainedAt: 0 });
    } catch {
      /* offline */
    }
  }

  /**
   * New messages from OTHER sessions since this one last looked. Advances the
   * per-session cursor so nothing repeats. Throttled to protect the hot path.
   */
  async drainInbox(sessionId: string): Promise<ChatMessage[]> {
    if (!this.live.enabled) return [];
    try {
      const cursorFile = this.seenPath(sessionId);
      const cursor = readJsonSafe<{ at?: string; drainedAt?: number }>(cursorFile) ?? {};
      const now = Date.now();
      if (cursor.drainedAt && now - cursor.drainedAt < INBOX_THROTTLE_MS) return [];
      const self = await this.currentFeatureId();
      const history = await this.live.history(50);
      const last = cursor.at ?? "";
      const fresh = history.filter((m) => m.feature !== self && m.at > last);
      const maxAt = history.reduce((m, x) => (x.at > m ? x.at : m), last);
      writeJson(cursorFile, { at: maxAt, drainedAt: now });
      return fresh;
    } catch {
      return [];
    }
  }

  /** Recent messages from other sessions — for the on-demand inbox tool. */
  async inbox(limit = 20): Promise<ChatMessage[]> {
    if (!this.live.enabled) return [];
    try {
      const self = await this.currentFeatureId();
      return (await this.live.history(limit)).filter((m) => m.feature !== self);
    } catch {
      return [];
    }
  }

  /**
   * Ensure the dedicated-branch worktree is checked out (worktree mode only).
   * Fast no-op once ready / in inline mode. Never pushes — the first push is a
   * deliberate checkpoint.
   */
  async ready(): Promise<void> {
    if (this.store.p.mode !== "worktree" || this.ensured) return;
    await this.git.ensureContextWorktree(this.store.p.branch, this.store.p.root);
    this.ensured = true;
  }

  private now(): string {
    return new Date().toISOString();
  }

  /**
   * The feature this session is working on. Resolution order:
   *   1. an explicit id passed in,
   *   2. COFLOW_FEATURE — lets several terminals in the SAME directory
   *      each claim a distinct feature (you can't check out two branches at once),
   *   3. the current git branch,
   *   4. "main".
   */
  async currentFeatureId(explicit?: string): Promise<string> {
    if (explicit) return featureId(explicit);
    if (process.env.COFLOW_FEATURE) {
      return featureId(process.env.COFLOW_FEATURE);
    }
    const branch = await this.git.currentBranch();
    return featureId(branch ?? "main");
  }

  private async resolveOwner(): Promise<string> {
    return (
      (await this.git.userName()) ??
      process.env.COFLOW_OWNER ??
      process.env.USER ??
      "unknown"
    );
  }

  // --- context.pull ----------------------------------------------------------

  /** Fetch remote, then regenerate the local board from the feature files. */
  async pull(): Promise<{ git: { ok: boolean; message: string } }> {
    await this.ready();
    const git = await this.gitStore.pull();
    this.refreshBoard();
    return { git };
  }

  // --- context.summary -------------------------------------------------------

  /**
   * What every other active feature is doing, plus recent cross-session
   * activity — for SessionStart injection. Claude reads this Markdown directly,
   * so it can reason about conceptual overlap without any embeddings.
   */
  async summary(selfId?: string): Promise<string> {
    await this.ready();
    const self = selfId ? featureId(selfId) : await this.currentFeatureId();
    const { active } = this.store.registry();
    const others = active.filter((f) => f.feature !== self);
    const activity = this.store.readActivity(10);

    const parts: string[] = [];
    if (others.length === 0) {
      parts.push("No other active features in the shared context right now.");
    } else {
      parts.push(
        `${others.length} active feature${others.length === 1 ? "" : "s"}:`,
        ...others
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map((f) => renderFeatureLine(f)),
      );
    }
    if (activity.length > 0) {
      parts.push("", "Recent activity (this machine):", ...activity.map((l) => `  ${l}`));
    }

    if (this.live.enabled) {
      try {
        const members = (await this.live.members()).filter((m) => m.feature !== self);
        parts.push(
          "",
          `Group chat "${this.live.group}" is active — other Claude sessions in this project share it. Use the \`say\` tool to message them; they see it, and you'll see their replies here.`,
        );
        if (members.length) {
          parts.push(
            `Other live sessions: ${members.map((m) => `${m.feature} (${m.owner})`).join(", ")}.`,
          );
        }
        const chat = await this.live.history(6);
        if (chat.length) {
          parts.push("Recent group chat:");
          for (const h of chat) {
            parts.push(`  ${h.at.slice(11, 16)} ${h.feature}·${h.owner}: ${h.text}`);
          }
        }
      } catch {
        /* offline — git/local still works */
      }
    }
    return parts.join("\n");
  }

  // --- context.check_overlap -------------------------------------------------

  async checkOverlap(files: string[], selfId?: string): Promise<OverlapResult> {
    await this.ready();
    const self = selfId ? featureId(selfId) : await this.currentFeatureId();
    const features = this.store.listFeatures();
    const root = this.store.p.repoRoot;

    const committed = committedOverlap(root, features, files, self);
    const live = liveOverlap(
      root,
      this.store.livePendingFiles(),
      features,
      files,
      self,
    );
    return { hits: mergeHits(committed, live) };
  }

  // --- context.record --------------------------------------------------------

  /** Queue a delta locally AND post it to the shared activity log. Fast. */
  async record(input: {
    feature?: string;
    kind: DeltaKind;
    summary: string;
    files?: string[];
  }): Promise<{ queued: true; feature: string }> {
    await this.ready();
    const feature = featureId(input.feature ?? (await this.currentFeatureId()));
    const delta: Delta = {
      at: this.now(),
      kind: input.kind,
      summary: input.summary,
      files: input.files ?? [],
    };
    this.store.queueDelta(feature, delta);
    const owner = await this.resolveOwner();
    this.store.appendActivity(this.activityLine(feature, owner, input.summary));
    return { queued: true, feature };
  }

  /** Resolve the feature from the current branch, then record. */
  async recordCurrent(input: {
    kind: DeltaKind;
    summary: string;
    files?: string[];
  }): Promise<{ queued: true; feature: string }> {
    return this.record(input);
  }

  /** Post a free-form note to the shared activity log (no delta queued). */
  async say(message: string, feature?: string): Promise<{ feature: string }> {
    await this.ready();
    const id = featureId(feature ?? (await this.currentFeatureId()));
    const owner = await this.resolveOwner();
    this.store.appendActivity(this.activityLine(id, owner, message));
    await this.broadcast({ feature: id, owner, kind: "say", text: message });
    return { feature: id };
  }

  recentActivity(limit = 12): string[] {
    return this.store.readActivity(limit);
  }

  private activityLine(feature: string, owner: string, message: string): string {
    const stamp = this.now().slice(0, 16).replace("T", " ");
    return `- ${stamp} **${feature}** (${owner}): ${message}`;
  }

  // --- context.checkpoint ----------------------------------------------------

  /**
   * Fold queued deltas into the feature file, write it, commit, and push.
   * The ONLY operation that writes to the remote.
   */
  async checkpoint(input: {
    feature?: string;
    summary?: string;
    goal?: string;
    status?: FeatureStatus;
    openQuestions?: string[];
  }): Promise<{
    feature: string;
    committed: boolean;
    pushed: boolean;
    message: string;
    redactionHits: string[];
    deltasFolded: number;
  }> {
    await this.ready();
    const id = input.feature
      ? featureId(input.feature)
      : await this.currentFeatureId();

    let feature: Feature =
      this.store.readFeature(id) ??
      newFeature({
        feature: id,
        owner: await this.resolveOwner(),
        branch: (await this.git.currentBranch()) ?? undefined,
        goal: input.goal ?? "",
        now: this.now(),
      });

    const pending = this.store.readPending(id);
    for (const d of pending) feature = applyDelta(feature, d);

    if (input.goal !== undefined) feature.goal = input.goal;
    if (input.summary !== undefined) feature.current_state = input.summary;
    if (input.openQuestions !== undefined) feature.open_questions = input.openQuestions;
    if (input.status !== undefined) feature.status = input.status;
    feature.updated_at = this.now();

    const { hits } = this.store.writeFeature(feature);
    this.store.clearPending(id);
    this.refreshBoard();

    const rel = `.context/features/${id}.md`;
    const msg = redact(input.summary ?? "checkpoint").text.slice(0, 60);
    const result = await this.gitStore.commitAndPush([rel], `context(${id}): ${msg}`);

    await this.broadcast({
      feature: id,
      owner: feature.owner,
      kind: "activity",
      text: `checkpoint: ${input.summary ?? feature.current_state ?? "updated"}`,
    });

    return {
      feature: id,
      committed: result.committed,
      pushed: result.pushed,
      message: result.message,
      redactionHits: hits,
      deltasFolded: pending.length,
    };
  }

  // --- context.search --------------------------------------------------------

  /** Substring search across feature text. */
  search(query: string, topK = 5): Array<{ feature: Feature }> {
    const q = query.toLowerCase();
    return this.store
      .listFeatures()
      .filter((f) =>
        [f.feature, f.goal, f.current_state, ...f.decisions.map((d) => d.text)]
          .join("\n")
          .toLowerCase()
          .includes(q),
      )
      .slice(0, topK)
      .map((f) => ({ feature: f }));
  }

  // --- board -----------------------------------------------------------------

  refreshBoard(): void {
    this.store.writeBoard(this.renderBoard());
  }

  renderBoard(): string {
    const { active, all } = this.store.registry();
    const out: string[] = [
      "# coflow board",
      "",
      "_Generated from .context/features/*.md — do not edit by hand._",
      "",
      `## Active features (${active.length})`,
      "",
    ];
    if (active.length === 0) {
      out.push("_None._", "");
    } else {
      for (const f of active.sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
        out.push(renderFeatureLine(f), "");
      }
    }
    const done = all.filter((f) => f.status === "done");
    if (done.length) {
      out.push(`## Done (${done.length})`, "", ...done.map((f) => `- ${f.feature} (${f.owner})`), "");
    }
    const activity = this.store.readActivity(15);
    if (activity.length) {
      out.push("## Recent activity", "", ...activity, "");
    }
    return out.join("\n").trim() + "\n";
  }
}

/** One compact block per feature for summaries and the board. */
export function renderFeatureLine(f: Feature): string {
  const parts = [`- **${f.feature}** (${f.owner}, ${f.status})`];
  if (f.goal) parts.push(`— ${truncate(f.goal, 100)}`);
  const extra: string[] = [];
  if (f.current_state) extra.push(`state: ${truncate(f.current_state, 100)}`);
  if (f.files_touched.length) {
    extra.push(
      `files: ${f.files_touched.slice(0, 5).join(", ")}${f.files_touched.length > 5 ? "…" : ""}`,
    );
  }
  if (f.open_questions.length) extra.push(`open Qs: ${f.open_questions.length}`);
  let line = parts.join(" ");
  if (extra.length) line += `\n    ${extra.join(" · ")}`;
  return line;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
