import readline from "node:readline";
import pc from "picocolors";
import { Context } from "../core/context.js";
import { banner } from "./brand.js";
import type { ChatMessage } from "../core/live.js";

/**
 * `coflow chat` — the live group-chat view. Prints recent history, streams new
 * messages in real time, and (in a TTY) lets you type lines to broadcast. It's
 * the human/agent window into the same channel coflow's hooks publish to.
 */

function fmt(m: ChatMessage, self: string): string {
  const time = pc.dim(m.at.slice(11, 16));
  if (m.kind === "presence") return `${time} ${pc.dim(`— ${m.owner} ${m.text} —`)}`;
  const who =
    m.feature === self ? pc.green("you") : `${pc.cyan(m.feature)}${pc.dim("·" + m.owner)}`;
  const body = m.kind === "activity" ? pc.yellow(m.text) : m.text;
  return `${time} ${who}: ${body}`;
}

export async function runChat(): Promise<void> {
  const ctx = new Context();
  await ctx.ready();

  if (!ctx.live.enabled) {
    console.error("No group connected. Run `coflow connect` first (create or join).");
    process.exit(2);
  }

  const self = await ctx.currentFeatureId();
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
  console.log(pc.dim("  ─────────────────────────────────────────────"));
  for (const m of await ctx.live.history(40)) console.log(fmt(m, self));

  // Stream incoming messages above the prompt.
  ctx.live
    .subscribe((m) => {
      process.stdout.write("\r\x1b[K" + fmt(m, self) + "\n");
      rl.prompt(true);
    }, ac.signal)
    .catch((e) => {
      if ((e as { name?: string })?.name !== "AbortError") {
        process.stdout.write(pc.dim("  (live stream disconnected — messages may be delayed)\n"));
      }
    });

  try {
    await ctx.presence("joined the chat");
  } catch {
    /* offline */
  }
  rl.prompt();
}
