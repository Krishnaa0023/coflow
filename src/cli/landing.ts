import { existsSync } from "node:fs";
import pc from "picocolors";
import { confirm, isCancel } from "@clack/prompts";
import { LOGO_LINES, TAGLINE } from "./brand.js";
import { paths } from "../core/paths.js";
import { revealLogo, typeLine, gradient, runner, canAnimate, card, stage } from "./fx.js";

/**
 * `coflow` with no arguments — the front door. In a TTY it plays the animated
 * splash and, if this folder isn't set up yet, offers to do it right there (one
 * command, zero friction). Non-interactive callers just get a static signpost.
 */
export async function landing(): Promise<void> {
  const p = paths();
  const ready =
    existsSync(p.configFile) || existsSync(p.coflowConfig) || existsSync(p.claudeMd);

  await revealLogo(LOGO_LINES);
  await typeLine(TAGLINE, { delay: 14 });

  const interactive =
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY) &&
    process.env.TERM !== "dumb";

  if (!interactive) {
    signpost(ready);
    return;
  }

  if (!ready) {
    stage(1, 3, "Project handshake", "teach this folder how agents coordinate");
    if (canAnimate()) await runner("scouting repo terrain", 760);
    const go = await confirm({
      message: "Turn this folder into a coflow project?",
      initialValue: true,
    });
    if (!isCancel(go) && go) {
      const { init } = await import("./init.js");
      await init({ embedded: true });
      return;
    }
    signpost(false);
    return;
  }

  card("Ready to flow", [
    `${pc.cyan("coflow chat")}     live group chat, grouped by day`,
    `${pc.cyan("coflow watch")}    live dashboard`,
    `${pc.cyan("coflow connect")}  create or join a group`,
    `${pc.cyan("coflow doctor")}   health check`,
  ]);
  console.log();
}

function signpost(ready: boolean): void {
  if (ready) {
    console.log(`  ${pc.bold("Try:")}  ${pc.cyan("coflow chat")}  ${pc.dim("·")}  ${pc.cyan("coflow watch")}  ${pc.dim("·")}  ${pc.cyan("coflow doctor")}`);
  } else {
    console.log(`  ${pc.bold("Get started:")}  ${pc.cyan("coflow init")}  ${pc.dim("— set up this folder (or just rerun `coflow`)")}`);
  }
  console.log();
}
