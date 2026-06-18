import readline from "node:readline";
import pc from "picocolors";
import { Context } from "../core/context.js";
import { banner } from "./brand.js";
import { redact } from "../core/redact.js";
import { groupByDay, sortMessages } from "../core/summary.js";
import { dedupeFeed } from "../core/feed.js";
import { dayLabel, timeOfDay } from "../core/time.js";
import type { ChatMessage } from "../core/live.js";

/**
 * `coflow chat` — the live group-chat view. Prints recent history grouped by day
 * with date dividers, streams new messages in real time, and (in a TTY) lets you
 * type lines to broadcast. Days old enough to have been summarized collapse to a
 * one-line pointer by default; `--raw` expands them to the original messages.
 */

/** How often the chat view polls history() as a liveness safety net (ms). This
 * is a foreground, human-watched command, so a steady poll is fine — it's not
 * the throttled hot path the hooks run on. */
const LIVE_POLL_MS = 2500;

function divider(label: string): string {
  return pc.dim(`  ──────────── ${label} ────────────`);
}

function fmt(m: ChatMessage, self: string, tz: string): string {
  const time = pc.dim(timeOfDay(m.at, tz));
  const text = redact(m.text).text; // defensive: never render an unredacted leak
  if (m.kind === "presence") return `${time} ${pc.dim(`— ${m.owner} ${text} —`)}`;
  const who =
    m.feature === self ? pc.green("you") : `${pc.cyan(m.feature)}${pc.dim("·" + m.owner)}`;
  const body = m.kind === "activity" ? pc.yellow(text) : text;
  return `${time} ${who}: ${body}`;
}

export async function runChat(opts: { raw?: boolean } = {}): Promise<void> {
  const ctx = new Context();
  await ctx.ready();

  if (!ctx.live.enabled) {
    console.error("No group connected. Run `coflow connect` first (create or join).");
    process.exit(2);
  }

  // Roll any now-stale chat into summaries before rendering — no manual step needed.
  try {
    await ctx.summarizeChat();
  } catch {
    /* best-effort */
  }

  const self = await ctx.currentFeatureId();
  const tz = ctx.store.p.timezone;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: pc.dim("› "),
  });
  const ac = new AbortController();
  const quit = () => {
    ac.abort();
    rl.close();
  };

  // Attach listeners BEFORE any await, so a quickly-typed line is never dropped.
  rl.on("line", async (line) => {
    const t = line.trim();
    if (t === "/q" || t === "/quit") return quit();
    if (t) {
      rl.pause(); // serialize: don't process the next line until this send flushes
      try {
        await ctx.say(t);
      } catch {
        process.stdout.write(pc.red("  ⚠ not sent (offline?)\n"));
      }
      rl.resume();
    }
    rl.prompt();
  });
  rl.on("close", () => {
    ac.abort();
    process.exit(0);
  });
  process.on("SIGINT", quit);
  process.stdout.on("resize", () => rl.prompt(true)); // keep the input line intact on resize

  const online = (await ctx.live.members().catch(() => [])).length;
  console.log(banner("group chat"));
  console.log(
    pc.dim(
      `  group ${ctx.live.group} (${ctx.live.kind})  ·  ${online} online  ·  type to send  ·  /q to quit`,
    ),
  );

  // History, grouped by day. Fully-summarized days collapse unless --raw.
  const now = new Date().toISOString();
  const cutoff = Date.parse(now) - ctx.store.p.windowHours * 3_600_000;
  const all = sortMessages(await ctx.live.history(1000));
  const collapse = !opts.raw && ctx.store.p.dailySummaries;
  for (const { day, messages } of groupByDay(all, tz)) {
    console.log(divider(dayLabel(day, now, tz)));
    const allOld = messages.every((m) => Date.parse(m.at) <= cutoff);
    if (collapse && allOld) {
      console.log(
        pc.dim(
          `  ⤷ ${messages.length} message(s) summarized → .context/chat-summaries/${day}.md` +
            `  (coflow chat --raw to expand)`,
        ),
      );
    } else {
      for (const m of messages) console.log(fmt(m, self, tz));
    }
  }

  // Live updates via TWO de-duplicated mechanisms:
  //   1. subscribe() — sub-second when the backend pushes (local file watch; or
  //      Upstash SSE when it actually streams).
  //   2. a history() poll — the SAME transport the hooks/inbox use (Upstash
  //      LRANGE over REST), which is what reliably delivers cross-machine.
  // Upstash's REST SSE can buffer or stall behind proxies, leaving the TUI
  // frozen even while messages sit in Redis; the poll guarantees the view stays
  // live regardless. Local already self-polls its file, so it skips the extra reads.
  const feed = dedupeFeed();
  feed.seed(all); // don't reprint what we just rendered

  const render = (m: ChatMessage) => {
    process.stdout.write("\r\x1b[K" + fmt(m, self, tz) + "\n");
    rl.prompt(true);
  };

  ctx.live
    .subscribe((m) => {
      for (const x of feed.next([m])) render(x);
    }, ac.signal)
    .catch((e) => {
      if ((e as { name?: string })?.name !== "AbortError") {
        process.stdout.write(pc.dim("  (push stream unavailable — using polling)\n"));
      }
    });

  if (ctx.live.kind !== "local") {
    void (async () => {
      while (!ac.signal.aborted) {
        await new Promise((r) => setTimeout(r, LIVE_POLL_MS));
        if (ac.signal.aborted) break;
        try {
          for (const m of feed.next(sortMessages(await ctx.live.history(50)))) render(m);
        } catch {
          /* offline — retry next tick */
        }
      }
    })();
  }

  try {
    await ctx.presence("joined the chat");
  } catch {
    /* offline */
  }
  rl.prompt();
}
