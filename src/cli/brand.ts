import pc from "picocolors";
import { accent, glyph, mute, plainOutput } from "./fx.js";

/**
 * Shared coflow branding for the CLI surfaces (setup wizard, group chat,
 * connect). Hardcoded ASCII so there's no runtime font dependency.
 */

export const LOGO_LINES = [
  "  c o f l o w",
  "  context  x  chat  x  agents",
];

export const LOGO_LINES_ASCII = [
  "  coflow",
  "  context + chat + agents",
];

export const TAGLINE = "shared memory and live coordination for coding agents";

/** Inline brand glyph (waves = flow). */
export const MARK = glyph("◆", "*");

/** The full logo block, cyan, with an optional subtitle line. */
export function banner(subtitle: string = TAGLINE): string {
  if (plainOutput()) {
    return `\ncoflow\n${subtitle}\n`;
  }
  const chain = glyph("⟡─⟡─⟡", "*-*-*");
  const art = [
    `  ${accent(chain)}  ${pc.bold(accent("coflow"))}`,
    `  ${mute("shared memory  /  live chat  /  agent coordination")}`,
  ].join("\n");
  return `\n${art}\n  ${mute(subtitle)}\n`;
}

/** A compact one-line header for scrolling views like chat. */
export function headerLine(label: string, meta: string): string {
  return `${accent(MARK)} ${pc.cyan(pc.bold(`coflow ${label}`))}  ${mute(meta)}`;
}
