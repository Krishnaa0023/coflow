import { existsSync } from "node:fs";
import pc from "picocolors";
import { confirm, isCancel } from "@clack/prompts";
import { LOGO_LINES, TAGLINE } from "./brand.js";
import { paths } from "../core/paths.js";
import { revealLogo, typeLine, gradient, loadingBar, canAnimate } from "./fx.js";

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
  console.log();

  if (!process.stdin.isTTY) {
    signpost(ready);
    return;
  }

  if (!ready) {
    if (canAnimate()) await loadingBar("scanning project", 650);
    const go = await confirm({
      message: "Set up coflow in this folder now?",
      initialValue: true,
    });
    if (!isCancel(go) && go) {
      const { init } = await import("./init.js");
      await init({});
      return;
    }
    signpost(false);
    return;
  }

  console.log(`  ${pc.bold("Ready to flow.")} ${pc.dim("Pick one:")}`);
  for (const [cmd, desc] of [
    ["coflow chat", "live group chat, grouped by day"],
    ["coflow watch", "live dashboard"],
    ["coflow connect", "create or join a group"],
    ["coflow doctor", "health check"],
  ] as const) {
    console.log(`    ${gradient("▸")} ${pc.cyan(cmd.padEnd(16))} ${pc.dim(desc)}`);
  }
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
