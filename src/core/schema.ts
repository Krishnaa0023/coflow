import { z } from "zod";

/**
 * Per-feature file schema. One file per feature is what keeps merges
 * conflict-free: each developer only ever writes their own file. Everything is
 * structured (not prose) so merging and overlap detection are mechanical rather
 * than fuzzy.
 */

export const FeatureStatus = z.enum(["active", "paused", "blocked", "done"]);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

export const Decision = z.object({
  at: z.string().datetime(),
  text: z.string().min(1),
});
export type Decision = z.infer<typeof Decision>;

export const DeltaKind = z.enum([
  "edit", // touched files
  "decision", // made a call worth recording
  "note", // free-form progress note
  "status", // status change
]);
export type DeltaKind = z.infer<typeof DeltaKind>;

export const Delta = z.object({
  at: z.string().datetime(),
  kind: DeltaKind,
  summary: z.string().min(1),
  files: z.array(z.string()).default([]),
});
export type Delta = z.infer<typeof Delta>;

/** How many recent deltas to keep inline before they roll off. */
export const MAX_RECENT_DELTAS = 20;

export const Feature = z.object({
  /** Stable id (sanitised). Usually mirrors the branch. */
  feature: z.string().min(1),
  branch: z.string().optional(),
  owner: z.string().min(1),
  status: FeatureStatus.default("active"),
  goal: z.string().default(""),
  current_state: z.string().default(""),
  decisions: z.array(Decision).default([]),
  open_questions: z.array(z.string()).default([]),
  files_touched: z.array(z.string()).default([]),
  updated_at: z.string().datetime(),
  /** Capped rolling window. Older deltas are summarised into current_state. */
  recent_deltas: z.array(Delta).default([]),
  /** Schema version, so future migrations are mechanical. */
  v: z.literal(1).default(1),
});
export type Feature = z.infer<typeof Feature>;

export interface NewFeatureInput {
  feature: string;
  owner: string;
  branch?: string;
  goal?: string;
  now: string; // ISO timestamp — injected, never read from the clock here
}

export function newFeature(input: NewFeatureInput): Feature {
  return Feature.parse({
    feature: input.feature,
    branch: input.branch,
    owner: input.owner,
    status: "active",
    goal: input.goal ?? "",
    current_state: "",
    decisions: [],
    open_questions: [],
    files_touched: [],
    updated_at: input.now,
    recent_deltas: [],
    v: 1,
  });
}

/** Append a delta and keep derived fields (files_touched, recent window) tidy. */
export function applyDelta(feature: Feature, delta: Delta): Feature {
  const files_touched = Array.from(
    new Set([...feature.files_touched, ...delta.files]),
  ).sort();

  const recent_deltas = [...feature.recent_deltas, delta].slice(
    -MAX_RECENT_DELTAS,
  );

  const decisions =
    delta.kind === "decision"
      ? [...feature.decisions, { at: delta.at, text: delta.summary }]
      : feature.decisions;

  return {
    ...feature,
    files_touched,
    recent_deltas,
    decisions,
    updated_at: delta.at,
  };
}

export function parseFeature(raw: unknown): Feature {
  return Feature.parse(raw);
}

export function safeParseFeature(raw: unknown) {
  return Feature.safeParse(raw);
}
