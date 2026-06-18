/**
 * Timezone-aware date/time helpers for the chat layer.
 *
 * Chat messages cross day boundaries, so a bare `HH:mm` (the old
 * `at.slice(11, 16)`) is ambiguous: a message from yesterday looks identical to
 * one from today. Everything that renders a timestamp for a human or for the
 * model goes through here so the date is shown whenever it isn't "today", and so
 * day-bucketing (for dividers and daily summaries) is computed in ONE place.
 *
 * The timezone is configurable (`.coflow.json` → `timezone`):
 *   - "local" (default) : the machine's zone — what a human at the terminal expects
 *   - "utc"             : stable across machines (best for shared/team repos)
 *   - an IANA name      : e.g. "Europe/Malta"
 * An unparseable zone falls back to local rather than throwing.
 */

export type Timezone = string; // "local" | "utc" | IANA name

function resolveZone(tz: Timezone): string | undefined {
  if (!tz || tz === "local") return undefined; // undefined → host local zone
  if (tz.toLowerCase() === "utc") return "UTC";
  return tz;
}

interface Parts {
  day: string; // YYYY-MM-DD
  time: string; // HH:mm (24h)
}

/** Break an ISO timestamp into local-day + local-time strings. null if unparseable. */
function localParts(iso: string, tz: Timezone): Parts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const timeZone = resolveZone(tz);
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", timeZone ? { ...opts, timeZone } : opts);
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", opts); // bad IANA name → local
  }
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) map[p.type] = p.value;
  // `hour12:false` can emit "24" for midnight on some engines — normalise to "00".
  const hour = map.hour === "24" ? "00" : map.hour;
  return {
    day: `${map.year}-${map.month}-${map.day}`,
    time: `${hour}:${map.minute}`,
  };
}

/** The calendar day (YYYY-MM-DD) an instant falls on, in the configured zone. */
export function dayKey(iso: string, tz: Timezone = "local"): string {
  return localParts(iso, tz)?.day ?? "unknown";
}

/** Just the wall-clock time (HH:mm) — for use under a date divider. */
export function timeOfDay(iso: string, tz: Timezone = "local"): string {
  return localParts(iso, tz)?.time ?? "??:??";
}

/**
 * A timestamp with date context: `HH:mm` when `iso` is the same calendar day as
 * `nowIso`, otherwise `YYYY-MM-DD HH:mm`. This is the function every flat
 * (divider-less) render path — context injection, the inbox tool, post-tool-use
 * delivery — must use instead of slicing the ISO string.
 */
export function formatStamp(iso: string, nowIso: string, tz: Timezone = "local"): string {
  const p = localParts(iso, tz);
  if (!p) return "????-??-?? ??:??";
  return p.day === dayKey(nowIso, tz) ? p.time : `${p.day} ${p.time}`;
}

/** A friendly divider label for a day: "Today" / "Yesterday" / the bare date. */
export function dayLabel(day: string, nowIso: string, tz: Timezone = "local"): string {
  const today = dayKey(nowIso, tz);
  if (day === today) return `Today · ${day}`;
  const ms = Date.parse(nowIso);
  if (!Number.isNaN(ms) && dayKey(new Date(ms - 86_400_000).toISOString(), tz) === day) {
    return `Yesterday · ${day}`;
  }
  return day;
}
