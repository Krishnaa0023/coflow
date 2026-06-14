import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { paths, featureId, type ContextPaths } from "./paths.js";
import { Feature, Delta, safeParseFeature } from "./schema.js";
import { redact, redactDeep } from "./redact.js";

/**
 * The context store: one human-readable Markdown file per feature, committed to
 * git. Structured fields live in YAML frontmatter (so merges and overlap stay
 * mechanical); the body below is a generated, readable rendering of the same
 * data — and is never parsed back, so there's no fragile round-trip.
 *
 * Plus two local-only, gitignored views for same-machine coordination:
 *   - activity.md : a shared append-only log every terminal writes to and reads
 *   - BOARD.md    : a generated digest of all active features
 *
 * This module is the only thing that touches those files. Writes are atomic
 * and always run through secret redaction first.
 */

export class Store {
  readonly p: ContextPaths;

  constructor(start?: string) {
    this.p = paths(start);
  }

  ensureDirs(): void {
    mkdirSync(this.p.featuresDir, { recursive: true });
    mkdirSync(this.p.pendingDir, { recursive: true });
  }

  private featurePath(id: string): string {
    return join(this.p.featuresDir, `${featureId(id)}.md`);
  }

  listFeatureIds(): string[] {
    if (!existsSync(this.p.featuresDir)) return [];
    return readdirSync(this.p.featuresDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length))
      .sort();
  }

  readFeature(id: string): Feature | null {
    const file = this.featurePath(id);
    if (!existsSync(file)) return null;
    try {
      const { data } = splitFrontmatter(readFileSync(file, "utf8"));
      const parsed = safeParseFeature(data);
      if (!parsed.success) {
        process.stderr.write(
          `[coflow] skipping malformed feature ${id}: ${parsed.error.message}\n`,
        );
        return null;
      }
      return parsed.data;
    } catch (err) {
      process.stderr.write(
        `[coflow] failed to read feature ${id}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  listFeatures(): Feature[] {
    return this.listFeatureIds()
      .map((id) => this.readFeature(id))
      .filter((f): f is Feature => f !== null);
  }

  /** Redacts, validates, then writes Markdown atomically. Returns redaction hits. */
  writeFeature(feature: Feature): { hits: string[] } {
    this.ensureDirs();
    const { value: clean, hits } = redactDeep(feature);
    const validated = Feature.parse(clean);
    const file = this.featurePath(validated.feature);
    const out =
      `---\n${stringifyYaml(validated)}---\n\n${renderBody(validated)}\n`;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, out, "utf8");
    renameSync(tmp, file); // atomic on POSIX
    return { hits };
  }

  // --- Pending deltas (local-only, gitignored, flushed at checkpoints) -------

  private pendingPath(id: string): string {
    return join(this.p.pendingDir, `${featureId(id)}.jsonl`);
  }

  /** Append a delta to the local queue. Fast path — no git, no network. */
  queueDelta(id: string, delta: Delta): void {
    this.ensureDirs();
    const { value: clean } = redactDeep(delta);
    appendFileSync(this.pendingPath(id), JSON.stringify(clean) + "\n", "utf8");
  }

  readPending(id: string): Delta[] {
    return readJsonl(this.pendingPath(id));
  }

  clearPending(id: string): void {
    const file = this.pendingPath(id);
    if (existsSync(file)) rmSync(file);
  }

  /**
   * Files currently in-progress per feature, read from every local pending
   * queue. This is what lets same-machine sibling terminals see each other's
   * uncommitted edits — no git round-trip needed.
   */
  livePendingFiles(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (!existsSync(this.p.pendingDir)) return out;
    for (const f of readdirSync(this.p.pendingDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -".jsonl".length);
      const files = new Set<string>();
      for (const d of readJsonl(join(this.p.pendingDir, f))) {
        for (const file of d.files) files.add(file);
      }
      if (files.size) out.set(id, files);
    }
    return out;
  }

  // --- Shared activity log (local-only, append-only, multi-terminal chatter) -

  /** Append one line to the shared log every local terminal reads. */
  appendActivity(line: string): void {
    this.ensureDirs();
    const clean = redact(line).text.replace(/\n/g, " ").trim();
    appendFileSync(this.p.activityFile, clean + "\n", "utf8");
  }

  /** The most recent activity lines (newest last). */
  readActivity(limit = 12): string[] {
    if (!existsSync(this.p.activityFile)) return [];
    return readFileSync(this.p.activityFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-limit);
  }

  // --- Generated board -------------------------------------------------------

  writeBoard(content: string): void {
    this.ensureDirs();
    writeFileSync(this.p.boardFile, content, "utf8");
  }

  /**
   * Derive the global picture from the per-feature files. Never persisted —
   * always regenerated, so it can't drift or cause merge conflicts.
   */
  registry(): { active: Feature[]; all: Feature[] } {
    const all = this.listFeatures();
    return {
      all,
      active: all.filter((f) => f.status === "active" || f.status === "blocked"),
    };
  }
}

// --- helpers ----------------------------------------------------------------

/** Split a Markdown file into its YAML frontmatter object and body text. */
export function splitFrontmatter(text: string): { data: unknown; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = m[1] ? parseYaml(m[1]) : {};
  return { data, body: m[2] ?? "" };
}

function readJsonl(file: string): Delta[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return Delta.parse(JSON.parse(l));
      } catch {
        return null;
      }
    })
    .filter((d): d is Delta => d !== null);
}

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** The human-readable body — a rendering of the structured record. */
export function renderBody(f: Feature): string {
  const out: string[] = [`# ${f.feature}  ·  ${f.owner}  ·  ${f.status}`, ""];
  if (f.goal) out.push(`**Goal:** ${f.goal}`, "");
  if (f.current_state) out.push(`**Current state:** ${f.current_state}`, "");
  if (f.files_touched.length) {
    out.push(`**Files:** ${f.files_touched.map((x) => `\`${x}\``).join(", ")}`, "");
  }
  if (f.decisions.length) {
    out.push("## Decisions");
    for (const d of f.decisions) out.push(`- ${shortDate(d.at)} — ${d.text}`);
    out.push("");
  }
  if (f.open_questions.length) {
    out.push("## Open questions");
    for (const q of f.open_questions) out.push(`- ${q}`);
    out.push("");
  }
  if (f.recent_deltas.length) {
    out.push("## Recent activity");
    for (const d of f.recent_deltas) {
      out.push(`- ${shortDate(d.at)} — ${d.kind} — ${d.summary}`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}
