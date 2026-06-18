import type { ChatMessage } from "./live.js";

/**
 * A de-duplicating message feed for live views.
 *
 * `coflow chat` draws live updates from two overlapping sources — a push
 * subscription (sub-second when the backend delivers) and a history() poll (the
 * reliable fallback that also powers the hooks) — so the same message can arrive
 * twice. Seed the feed with the initial history, then funnel everything from
 * both sources through `next()`; each message renders exactly once.
 */
export function dedupeFeed() {
  const seen = new Set<string>();
  // No message ids exist on the wire, so key on the full tuple. Two genuinely
  // identical messages in the same second collapse — an acceptable trade.
  const key = (m: ChatMessage) => `${m.at}|${m.feature}|${m.owner}|${m.kind}|${m.text}`;
  return {
    /** Mark messages as already-shown without emitting them. */
    seed(msgs: ChatMessage[]): void {
      for (const m of msgs) seen.add(key(m));
    },
    /** Return (and remember) only the messages not seen before. */
    next(msgs: ChatMessage[]): ChatMessage[] {
      const fresh: ChatMessage[] = [];
      for (const m of msgs) {
        const k = key(m);
        if (!seen.has(k)) {
          seen.add(k);
          fresh.push(m);
        }
      }
      return fresh;
    },
  };
}
