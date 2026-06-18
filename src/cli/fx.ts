import pc from "picocolors";

/**
 * coflow terminal motion-graphics toolkit.
 *
 * Pure ANSI + picocolors — zero extra dependencies, so `npm i -g` pulls
 * everything and there is nothing else to download or build. Every effect is
 * TTY-gated and degrades to clean static output when piped, in CI, on a dumb
 * terminal, or on a too-narrow window, so animations can never corrupt output or
 * hang a non-interactive run.
 *
 * Theme: a neon "synthwave" gradient (cyan → blue → violet → magenta).
 */

export type RGB = [number, number, number];

/** Neon gradient stops used across the brand surfaces. */
export const NEON: RGB[] = [
  [34, 211, 238], // cyan
  [59, 130, 246], // blue
  [168, 85, 247], // violet
  [236, 72, 153], // magenta
];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when stdout should be boring, parseable text. */
export function plainOutput(): boolean {
  return (
    !process.stdout.isTTY ||
    process.env.TERM === "dumb" ||
    Boolean(process.env.CI) ||
    Boolean(process.env.NO_COLOR)
  );
}

/** True only when it's safe AND useful to animate. */
export function canAnimate(): boolean {
  return (
    Boolean(process.stdout.isTTY) &&
    process.env.TERM !== "dumb" &&
    !process.env.CI &&
    !process.env.NO_COLOR &&
    (process.stdout.columns ?? 80) >= 24
  );
}

/** Box-drawing and emoji-adjacent glyphs are great until they are not. */
export function canUseUnicode(): boolean {
  if (process.env.COFLOW_ASCII === "1") return false;
  if (process.platform !== "win32") return true;
  // Windows Terminal and modern VS Code terminals handle this well; older
  // conhosts can still be rough, so keep an escape hatch with COFLOW_ASCII=1.
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM === "vscode");
}

export function glyph(unicode: string, ascii: string): string {
  return canUseUnicode() ? unicode : ascii;
}

/** 24-bit colour is needed for smooth gradients; otherwise we fall back. */
function hasTrueColor(): boolean {
  return /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
}

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

function colorAt(t: number, stops: RGB[]): RGB {
  if (t <= 0) return stops[0]!;
  if (t >= 1) return stops[stops.length - 1]!;
  const seg = t * (stops.length - 1);
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const local = seg - i;
  const [r1, g1, b1] = stops[i]!;
  const [r2, g2, b2] = stops[i + 1]!;
  return [lerp(r1, r2, local), lerp(g1, g2, local), lerp(b1, b2, local)];
}

function paint([r, g, b]: RGB, s: string): string {
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

/**
 * Apply a horizontal gradient to a string. `highlight` (0..1) adds a moving
 * bright band for shimmer animations. Falls back to flat cyan without truecolor,
 * and to the raw string with NO_COLOR. The VISIBLE characters are always
 * preserved exactly — only colour codes are added.
 */
export function gradient(text: string, stops: RGB[] = NEON, highlight?: number): string {
  if (process.env.NO_COLOR) return text;
  if (!process.stdout.isTTY) return text; // piped / CI → clean text, never colour codes
  if (!hasTrueColor()) return pc.cyan(text);
  const chars = [...text];
  const n = chars.length;
  const HALF = 0.16;
  return chars
    .map((ch, i) => {
      if (ch === " ") return " ";
      const t = n <= 1 ? 0 : i / (n - 1);
      let rgb = colorAt(t, stops);
      if (highlight !== undefined) {
        const d = Math.abs(t - highlight);
        if (d < HALF) {
          const k = 1 - d / HALF;
          rgb = [lerp(rgb[0], 255, k), lerp(rgb[1], 255, k), lerp(rgb[2], 255, k)];
        }
      }
      return paint(rgb, ch);
    })
    .join("");
}

export function accent(text: string): string {
  return plainOutput() ? text : gradient(text);
}

export function mute(text: string): string {
  return plainOutput() ? text : pc.dim(text);
}

export function success(text: string): string {
  return plainOutput() ? text : pc.green(text);
}

export function warn(text: string): string {
  return plainOutput() ? text : pc.yellow(text);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

function padVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

// --- cursor / cleanup -------------------------------------------------------

let guarded = false;
export function showCursor(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
}
function hideCursor(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25l");
  if (!guarded) {
    guarded = true;
    process.once("exit", showCursor);
    process.once("SIGINT", () => {
      showCursor();
      process.exit(130);
    });
  }
}

const w = (s: string) => process.stdout.write(s);

// --- effects ----------------------------------------------------------------

/**
 * Animated logo reveal: a left-to-right gradient "wipe-in", then a shimmer band
 * sweeps across. Static fallback prints the coloured logo immediately.
 */
export async function revealLogo(lines: string[], stops: RGB[] = NEON): Promise<void> {
  const indent = "  ";
  if (!canAnimate()) {
    for (const l of lines) console.log(indent + gradient(l, stops));
    return;
  }
  hideCursor();
  const width = Math.max(...lines.map((l) => [...l].length));
  w(lines.map(() => "").join("\n") + "\n"); // reserve the rows

  const wipe = 16;
  for (let f = 0; f <= wipe; f++) {
    const reveal = Math.ceil((f / wipe) * width);
    w(`\x1b[${lines.length}A`);
    for (const l of lines) {
      const shown = [...l].slice(0, reveal).join("");
      w(`\x1b[2K${indent}${gradient(shown, stops)}\n`);
    }
    await sleep(26);
  }
  const sweep = 22;
  for (let s = 0; s <= sweep; s++) {
    const h = -0.2 + (s / sweep) * 1.4;
    w(`\x1b[${lines.length}A`);
    for (const l of lines) w(`\x1b[2K${indent}${gradient(l, stops, h)}\n`);
    await sleep(20);
  }
  showCursor();
}

/** Type a line out character-by-character (flows naturally, wrap-safe). */
export async function typeLine(
  text: string,
  opts: { delay?: number; color?: (s: string) => string } = {},
): Promise<void> {
  const color = opts.color ?? ((s: string) => pc.dim(s));
  if (!canAnimate()) {
    console.log(color(text));
    return;
  }
  hideCursor();
  for (const ch of text) {
    w(color(ch));
    await sleep(opts.delay ?? 16);
  }
  w("\n");
  showCursor();
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Step {
  label: string;
  /** Optional real work to run while the spinner shows. */
  run?: () => void | Promise<void>;
}

function dinoFrame(frame: number): string {
  if (!canUseUnicode()) return frame % 2 ? "dino>" : "DINO>";
  return frame % 2 ? "ᕙ(•̀ᴗ•́)ᕗ" : "ᕕ(•̀ᴗ•́)ᕗ";
}

function fireFrame(frame: number): string {
  if (!canUseUnicode()) return frame % 2 ? "^^" : "**";
  return frame % 2 ? "♨" : "✹";
}

function track(width: number, pos: number, frame: number): string {
  const safeWidth = Math.max(18, width);
  const cells = Array.from({ length: safeWidth }, () => "─");
  const sparks = [Math.floor(safeWidth * 0.28), Math.floor(safeWidth * 0.58), Math.floor(safeWidth * 0.84)];
  for (const s of sparks) if (s !== pos && s >= 0 && s < cells.length) cells[s] = fireFrame(frame);
  const runner = dinoFrame(frame);
  const slot = Math.min(Math.max(0, pos), safeWidth - 1);
  cells[slot] = runner;
  return cells.join("");
}

/** A tiny "coflow runner" scene: mascot advances while work warms up. */
export async function runner(label: string, ms = 850): Promise<void> {
  if (!canAnimate()) {
    console.log(`  ${label}`);
    return;
  }
  hideCursor();
  const width = Math.min(Math.max((process.stdout.columns ?? 80) - 18, 24), 54);
  const frames = Math.max(10, Math.round(ms / 55));
  for (let f = 0; f <= frames; f++) {
    const pos = Math.round((f / frames) * (width - 1));
    const pct = Math.round((f / frames) * 100);
    w(
      `\r\x1b[2K  ${gradient(track(width, pos, f))} ` +
        `${pc.bold(String(pct).padStart(3))}% ${pc.dim(label)}`,
    );
    await sleep(ms / frames);
  }
  w("\n");
  showCursor();
}

/** Game-like setup quest log. Each step gets a short runner animation. */
export async function questSequence(steps: Step[], perStepMs = 420): Promise<void> {
  if (!canAnimate()) {
    for (const s of steps) {
      await s.run?.();
      console.log(`  ${pc.green("OK")} ${s.label}`);
    }
    return;
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const work = Promise.resolve(s.run?.());
    await runner(`quest ${i + 1}/${steps.length}: ${s.label}`, perStepMs);
    await work;
    console.log(`  ${pc.green(glyph("✓", "OK"))} ${pc.bold(s.label)} ${pc.dim("+1 sync shard")}`);
  }
}

/**
 * A "boot sequence" checklist: each step spins for a beat (while its work runs),
 * then resolves to a green ✓. Static fallback just prints the checks.
 */
export async function bootSequence(steps: Step[], perStepMs = 260): Promise<void> {
  if (!canAnimate()) {
    for (const s of steps) {
      await s.run?.();
      console.log(`  ${pc.green("✓")} ${s.label}`);
    }
    return;
  }
  hideCursor();
  for (const s of steps) {
    const start = Date.now();
    const work = Promise.resolve(s.run?.());
    let i = 0;
    while (Date.now() - start < perStepMs) {
      w(`\r\x1b[2K  ${gradient(SPIN[i++ % SPIN.length]!)} ${pc.dim(s.label)}`);
      await sleep(70);
    }
    await work;
    w(`\r\x1b[2K  ${pc.green("✓")} ${s.label}\n`);
  }
  showCursor();
}

/** A single neon progress bar that fills over `ms`. */
export async function loadingBar(label: string, ms = 900, width = 26): Promise<void> {
  if (!canAnimate()) {
    console.log(`  ${label}`);
    return;
  }
  hideCursor();
  const frames = Math.max(8, Math.round(ms / 45));
  for (let f = 0; f <= frames; f++) {
    const filled = Math.round((f / frames) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const pct = Math.round((f / frames) * 100);
    w(`\r\x1b[2K  ${gradient(bar)} ${pc.bold(String(pct).padStart(3))}%  ${pc.dim(label)}`);
    await sleep(ms / frames);
  }
  w("\n");
  showCursor();
}

export function stage(index: number, total: number, title: string, detail?: string): void {
  if (plainOutput()) {
    console.log(`[${index}/${total}] ${title}${detail ? ` - ${detail}` : ""}`);
    return;
  }
  const marker = accent(glyph("◆", "*"));
  const count = pc.dim(`${index}/${total}`);
  console.log(`\n  ${marker} ${count} ${pc.bold(title)}${detail ? ` ${pc.dim(detail)}` : ""}`);
}

export function card(title: string, lines: string[]): void {
  if (plainOutput()) {
    console.log(title);
    for (const line of lines) console.log(`  ${line}`);
    return;
  }
  const width = Math.min(
    Math.max(title.length + 6, ...lines.map((l) => l.length + 4), 34),
    Math.max(34, (process.stdout.columns ?? 80) - 6),
  );
  const top = glyph("╭", "+") + glyph("─", "-").repeat(width - 2) + glyph("╮", "+");
  const bot = glyph("╰", "+") + glyph("─", "-").repeat(width - 2) + glyph("╯", "+");
  console.log("  " + accent(top));
  console.log(
    "  " +
      accent(glyph("│", "|")) +
      " " +
      padVisible(pc.bold(title), width - 3) +
      accent(glyph("│", "|")),
  );
  for (const line of lines) {
    console.log(
      "  " +
        accent(glyph("│", "|")) +
        " " +
        padVisible(pc.dim(line), width - 3) +
        accent(glyph("│", "|")),
    );
  }
  console.log("  " + accent(bot));
}

/**
 * A celebratory finish — the text pulses through a few shimmer frames inside a
 * neon frame. Static fallback prints it once.
 */
export async function celebrate(title: string, subtitle?: string): Promise<void> {
  const pad = 2;
  const inner = title.length + pad * 2;
  const top = "╭" + "─".repeat(inner) + "╮";
  const mid = "│" + " ".repeat(pad) + title + " ".repeat(pad) + "│";
  const bot = "╰" + "─".repeat(inner) + "╯";
  if (!canAnimate()) {
    console.log("  " + gradient(top));
    console.log("  " + gradient(mid));
    console.log("  " + gradient(bot));
    if (subtitle) console.log("  " + pc.dim(subtitle));
    return;
  }
  hideCursor();
  w("\n\n\n");
  const sweep = 24;
  for (let s = 0; s <= sweep; s++) {
    const h = -0.2 + (s / sweep) * 1.4;
    w(`\x1b[3A`);
    w(`\x1b[2K  ${gradient(top, NEON, h)}\n`);
    w(`\x1b[2K  ${gradient(mid, NEON, h)}\n`);
    w(`\x1b[2K  ${gradient(bot, NEON, h)}\n`);
    await sleep(28);
  }
  if (subtitle) console.log("  " + pc.dim(subtitle));
  showCursor();
}
