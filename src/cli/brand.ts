import pc from "picocolors";

/**
 * Shared coflow branding for the CLI surfaces (setup wizard, group chat,
 * connect). Hardcoded ASCII so there's no runtime font dependency.
 */

export const LOGO_LINES = [
  "┏━╸┏━┓┏━╸╻  ┏━┓╻ ╻",
  "┃  ┃ ┃┣╸ ┃  ┃ ┃┃╻┃",
  "┗━╸┗━┛╹  ┗━╸┗━┛┗┻┛",
];

export const TAGLINE = "shared context + live group chat for AI agents";

/** Inline brand glyph (waves = flow). */
export const MARK = "≋";

/** The full logo block, cyan, with an optional subtitle line. */
export function banner(subtitle: string = TAGLINE): string {
  const art = LOGO_LINES.map((l) => "  " + pc.cyan(pc.bold(l))).join("\n");
  return `\n${art}\n  ${pc.dim(subtitle)}\n`;
}

/** A compact one-line header for scrolling views like chat. */
export function headerLine(label: string, meta: string): string {
  return `${pc.cyan(pc.bold(`${MARK} coflow ${label}`))}  ${pc.dim(meta)}`;
}
