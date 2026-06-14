import { isAbsolute, relative } from "node:path";
import type { Feature } from "./schema.js";

/**
 * Overlap detection is now purely structural: a set intersection on file paths.
 * "You and Dana are both editing src/auth.ts." Deterministic, instant, no
 * embeddings. Conceptual/semantic relatedness is left to Claude, which reads the
 * other features' Markdown directly in the session-start summary.
 *
 * Two sources are checked:
 *   - committed `files_touched` from each feature file (the team-wide picture)
 *   - live, uncommitted files from each local pending queue (so same-machine
 *     sibling terminals collide-detect BEFORE anyone checkpoints)
 */

/** Normalise a path to repo-root-relative posix form for comparison. */
export function normalizePath(root: string, p: string): string {
  let rel = isAbsolute(p) ? relative(root, p) : p;
  rel = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return rel;
}

export interface StructuralHit {
  feature: string;
  owner: string;
  status: string;
  shared: string[];
  /** True when the collision is with an in-progress, not-yet-committed edit. */
  inProgress: boolean;
}

export interface OverlapResult {
  hits: StructuralHit[];
}

/** Overlap against committed `files_touched`. */
export function committedOverlap(
  root: string,
  features: Feature[],
  files: string[],
  selfId?: string,
): StructuralHit[] {
  const want = new Set(files.map((f) => normalizePath(root, f)));
  const hits: StructuralHit[] = [];
  for (const f of features) {
    if (selfId && f.feature === selfId) continue;
    if (f.status === "done") continue;
    const shared = uniqueShared(f.files_touched, want, root);
    if (shared.length > 0) {
      hits.push({
        feature: f.feature,
        owner: f.owner,
        status: f.status,
        shared,
        inProgress: false,
      });
    }
  }
  return hits;
}

/** Overlap against live, uncommitted files from local pending queues. */
export function liveOverlap(
  root: string,
  live: Map<string, Set<string>>,
  features: Feature[],
  files: string[],
  selfId?: string,
): StructuralHit[] {
  const want = new Set(files.map((f) => normalizePath(root, f)));
  const byId = new Map(features.map((f) => [f.feature, f]));
  const hits: StructuralHit[] = [];
  for (const [id, touched] of live) {
    if (selfId && id === selfId) continue;
    const shared = uniqueShared([...touched], want, root);
    if (shared.length > 0) {
      const meta = byId.get(id);
      hits.push({
        feature: id,
        owner: meta?.owner ?? "another session",
        status: meta?.status ?? "in progress",
        shared,
        inProgress: true,
      });
    }
  }
  return hits;
}

/** Merge committed + live hits, preferring committed when a feature appears in both. */
export function mergeHits(
  committed: StructuralHit[],
  live: StructuralHit[],
): StructuralHit[] {
  const seen = new Set(committed.map((h) => h.feature));
  return [...committed, ...live.filter((h) => !seen.has(h.feature))];
}

function uniqueShared(
  touched: string[],
  want: Set<string>,
  root: string,
): string[] {
  return Array.from(
    new Set(
      touched.map((t) => normalizePath(root, t)).filter((t) => want.has(t)),
    ),
  ).sort();
}
