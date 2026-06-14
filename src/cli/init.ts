import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  intro,
  outro,
  text,
  select,
  multiselect,
  confirm,
  spinner,
  note,
  cancel,
  isCancel,
  log,
} from "@clack/prompts";
import pc from "picocolors";
import {
  paths,
  readCoflowConfig,
  type ContextPaths,
  type StoreMode,
} from "../core/paths.js";
import { Git } from "../core/git.js";
import { banner } from "./brand.js";

/**
 * `coflow init` — the onboarding entry point.
 *
 * Interactive (in a TTY): a visual, step-by-step wizard. Non-interactive
 * (--yes, or piped/CI): accepts sensible defaults and writes silently.
 *
 * Either way it writes the three committed config files (.mcp.json,
 * .claude/settings.json, CLAUDE.md) plus the .context/ store. A teammate who
 * clones the repo already has the committed config, so their init just detects
 * the existing store and connects.
 *
 * It deliberately never creates a remote repo or pushes — those act on other
 * people's repos and are gated behind explicit, separate steps.
 */

type Mode = "bin" | "self" | "npx" | "dev";
type HookName = "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop" | "SessionEnd";

interface Answers {
  owner: string;
  mode: Mode;
  hooks: HookName[];
  store: StoreMode;
  branch: string;
}

const HOOK_SPECS: Record<HookName, { hook: string; matcher?: string; hint: string }> = {
  SessionStart: { hook: "session-start", hint: "pull + inject summary at start" },
  PreToolUse: {
    hook: "pre-tool-use",
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    hint: "overlap check before edits",
  },
  PostToolUse: {
    hook: "post-tool-use",
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    hint: "record deltas locally",
  },
  Stop: { hook: "stop", hint: "checkpoint + push at task end" },
  SessionEnd: { hook: "session-end", hint: "remove you from the live list on close" },
};
const ALL_HOOKS = Object.keys(HOOK_SPECS) as HookName[];

// --- file helpers ----------------------------------------------------------

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function rel(root: string, file: string): string {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

// --- invocation mode -------------------------------------------------------

/** Absolute path to this running CLI script (dist/cli/main.js), symlinks resolved. */
function resolveSelfScript(): string {
  const argv1 = process.argv[1] ?? "";
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

/** Is `cmd` resolvable on the current PATH? */
function onPath(cmd: string): boolean {
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (d && existsSync(join(d, cmd))) return true;
  }
  return false;
}

function detectMode(root: string): Mode {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name === "coflow") return "dev";
    } catch {
      /* ignore */
    }
  }
  // Prefer the clean global bin if it exists; otherwise fall back to an
  // absolute-path "self" invocation so init works with zero global install.
  return onPath("coflow") ? "bin" : "self";
}

function command(
  mode: Mode,
  root: string,
  selfScript: string,
): { bin: string; prefixArgs: string[] } {
  switch (mode) {
    case "dev":
      return { bin: "node", prefixArgs: [join(root, "dist", "cli", "main.js")] };
    case "self":
      return { bin: "node", prefixArgs: [selfScript] };
    case "npx":
      return { bin: "npx", prefixArgs: ["-y", "coflow"] };
    case "bin":
    default:
      return { bin: "coflow", prefixArgs: [] };
  }
}

function hookCommand(mode: Mode, root: string, name: string, selfScript: string): string {
  const { bin, prefixArgs } = command(mode, root, selfScript);
  return [bin, ...prefixArgs, "hook", name].join(" ");
}

function mergeHook(
  settings: Record<string, unknown>,
  event: string,
  matcher: string | undefined,
  cmd: string,
): void {
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const list = (hooks[event] ??= []) as Array<Record<string, unknown>>;
  const already = list.some((group) =>
    ((group.hooks as Array<Record<string, unknown>>) ?? []).some(
      (h) => h.command === cmd,
    ),
  );
  if (already) return;
  const entry: Record<string, unknown> = { hooks: [{ type: "command", command: cmd }] };
  if (matcher) entry.matcher = matcher;
  list.push(entry);
}

function upsertClaudeMd(file: string): void {
  const marker = "<!-- coflow -->";
  const body = `## Team & multi-agent coordination (coflow)

This project runs **coflow** — a live group chat + shared context used by every
Claude instance here (your other terminals, teammates, and agents on other
servers). The coflow tools (\`say\`, \`inbox\`, \`checkpoint\`) are PRE-APPROVED —
use them freely and proactively, you do not need to ask before calling them.

**Treat it like a team chat. On your own initiative, without being asked:**
- At the start you'll be told who else is active — announce what you're picking up with \`say\`.
- BEFORE editing a file another active session is touching, \`say\` to coordinate (claim it, or defer).
- When you make a decision or finish a unit affecting shared files, \`say\` a one-liner.
- When you receive a 📨 message or a question aimed at you, reply with \`say\`.
- If you're waiting on a peer (e.g. a file hand-off), call \`inbox\` to check for their reply.
- New messages from other sessions are auto-injected after your edits — react like a teammate.
- Talk in this compact protocol (optimised for token cost, not human readability). Exact forms:
  \`CLAIM <path> <sym,sym>\` · \`FREE <path>\` · \`DONE <path> <sym>\` · \`WAIT <peer> <topic>\` · \`ASK <peer> <q>\` · \`ACK\` · \`FYI <text>\`.
  No greetings, articles, or labels; one fact per message; ASCII English keywords only — never emoji, other languages, or invented single-letter codes (they tokenize WORSE and risk misparse). Drop to a short prose sentence only when the protocol genuinely can't carry the nuance.
- At a task boundary, \`checkpoint\` with a one-line summary (writes your feature file + pushes). Don't checkpoint per edit.

Running several terminals here? Give each its own identity:
\`export COFLOW_FEATURE=payments\` before launching Claude.`;

  const block = `${marker}\n${body}\n${marker}`;
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`${marker}[\\s\\S]*?${marker}`);
  if (re.test(content)) {
    content = content.replace(re, block); // refresh existing block on re-init
  } else {
    if (content && !content.endsWith("\n")) content += "\n";
    content += (content ? "\n" : "") + block + "\n";
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

const COFLOW_TOOL_PERMS = [
  "mcp__coflow__say",
  "mcp__coflow__inbox",
  "mcp__coflow__checkpoint",
];

/** Reconcile coflow's MCP tools in the settings allow-list (drop stale coflow
 * entries, keep the user's other allows) so they never prompt. */
function ensureAllow(settings: Record<string, unknown>, perms: string[]): void {
  const permissions = (settings.permissions ??= {}) as Record<string, unknown>;
  const existing = (permissions.allow ?? []) as string[];
  const allow = existing.filter(
    (a) => !a.startsWith("mcp__coflow__") || perms.includes(a),
  );
  for (const perm of perms) if (!allow.includes(perm)) allow.push(perm);
  permissions.allow = allow;
}

// --- the actual writes (shared by wizard + --yes) --------------------------

/** Write the code-repo config files (.mcp.json, settings.json, CLAUDE.md). */
function applyConfig(p: ContextPaths, answers: Answers, selfScript: string): string[] {
  const written: string[] = [];

  // .mcp.json
  const mcp = readJson(p.configFile);
  const servers = (mcp.mcpServers ??= {}) as Record<string, unknown>;
  const { bin, prefixArgs } = command(answers.mode, p.repoRoot, selfScript);
  servers["coflow"] = {
    command: bin,
    args: [...prefixArgs, "mcp"],
    env: answers.owner ? { COFLOW_OWNER: answers.owner } : {},
  };
  writeJson(p.configFile, mcp);
  written.push(rel(p.repoRoot, p.configFile));

  // .claude/settings.json — only the selected hooks.
  const settings = readJson(p.settingsFile);
  for (const h of answers.hooks) {
    const spec = HOOK_SPECS[h];
    mergeHook(settings, h, spec.matcher, hookCommand(answers.mode, p.repoRoot, spec.hook, selfScript));
  }
  // Pre-approve coflow's own MCP tools so agents chat/coordinate without prompts.
  ensureAllow(settings, COFLOW_TOOL_PERMS);
  writeJson(p.settingsFile, settings);
  written.push(rel(p.repoRoot, p.settingsFile));

  // CLAUDE.md
  upsertClaudeMd(p.claudeMd);
  written.push(rel(p.repoRoot, p.claudeMd));

  return written;
}

/** Create the store dir + its local-views gitignore (inside the store root). */
function ensureStore(p: ContextPaths): void {
  mkdirSync(p.featuresDir, { recursive: true });
  const storeIgnore = join(p.contextDir, ".gitignore");
  if (!existsSync(storeIgnore)) {
    // Local-only, per-machine views — never committed.
    writeFileSync(storeIgnore, ".pending/\nBOARD.md\nactivity.md\n", "utf8");
  }
}

// --- the visual wizard -----------------------------------------------------

function bail(): never {
  cancel("Setup cancelled — nothing was written.");
  process.exit(0);
}

async function wizard(
  p: ContextPaths,
  git: Git,
  detectedMode: Mode,
  defaultOwner: string,
  selfScript: string,
  defaultStore: StoreMode,
  defaultBranch: string,
): Promise<Answers> {
  console.log(banner());
  intro(pc.bgCyan(pc.black(" coflow setup ")));
  note(
    [
      "coflow lets every Claude Code session in this project — your other",
      "terminals, teammates, and agents on other servers — see each other and",
      "talk in a shared group chat, on top of a git-backed shared context.",
      "",
      `${pc.bold("This wizard will:")}`,
      `  ${pc.green("1.")} write the project config (.mcp.json, hooks, CLAUDE.md)`,
      `  ${pc.green("2.")} create the context store`,
      `  ${pc.green("3.")} optionally connect you to a real-time group`,
      "",
      pc.dim("Nothing is pushed or sent anywhere without your confirmation."),
    ].join("\n"),
    "What is coflow?",
  );

  // Environment readout.
  const isRepo = await git.isRepo();
  const remote = isRepo ? await git.remoteUrl() : null;
  note(
    [
      `${pc.dim("root  ")} ${p.repoRoot}`,
      `${pc.dim("git   ")} ${isRepo ? pc.green("repository found") : pc.yellow("not a git repo")}`,
      `${pc.dim("remote")} ${remote ?? pc.dim("(none)")}`,
      `${pc.dim("invoke")} ${[command(detectedMode, p.repoRoot, selfScript).bin, ...command(detectedMode, p.repoRoot, selfScript).prefixArgs].join(" ")} ${pc.dim(`(${detectedMode} mode)`)}`,
    ].join("\n"),
    "Detected",
  );

  // Offer to initialise git if missing — directly addresses the common snag.
  if (!isRepo) {
    const doInit = await confirm({
      message: "This folder isn't a git repository. Initialise one now?",
      initialValue: true,
    });
    if (isCancel(doInit)) bail();
    if (doInit) {
      const s = spinner();
      s.start("git init");
      await git.init();
      s.stop("Initialised an empty git repository");
    } else {
      log.warn("No git repo → the store will be local-only until you add one.");
    }
  }

  const owner = await text({
    message: "Your name or handle for the shared context",
    placeholder: defaultOwner,
    initialValue: defaultOwner,
    validate: (v) => (v && v.trim() ? undefined : "Please enter a name."),
  });
  if (isCancel(owner)) bail();

  note(
    [
      `${pc.bold("Inline")}     context lives in .context/ in this repo. Simplest;`,
      `           its commits land on your normal branches.`,
      `${pc.bold("Dedicated")}  context lives on a separate branch (git worktree),`,
      `           so your code branches & PRs stay clean. Best for team repos.`,
    ].join("\n"),
    "Where context is stored",
  );
  const store = await select<StoreMode>({
    message: "Where should the shared context live?",
    initialValue: defaultStore,
    options: [
      { value: "inline", label: "Inline — .context/ in this repo", hint: "simplest; commits land in your branches" },
      { value: "worktree", label: "Dedicated branch (worktree)", hint: "isolated from code branches — best for shared/team repos" },
    ],
  });
  if (isCancel(store)) bail();

  const mode = await select<Mode>({
    message: "How should Claude Code invoke this tool?",
    initialValue: detectedMode,
    options: [
      { value: "bin", label: "Global / linked bin", hint: "coflow — needs it on PATH" },
      { value: "self", label: "Local build (absolute path)", hint: "works now, no install — personal use" },
      { value: "npx", label: "npx (zero install)", hint: "slower: resolves the package per hook" },
      { value: "dev", label: "Dev (this repo's dist/)", hint: "node dist/cli/main.js" },
    ],
  });
  if (isCancel(mode)) bail();

  note(
    [
      "Hooks run automatically so coflow needs no babysitting:",
      `  ${pc.cyan("SessionStart")}  pull context + tell you who else is active`,
      `  ${pc.cyan("PreToolUse")}    warn before you edit a file someone else is in`,
      `  ${pc.cyan("PostToolUse")}   record progress + deliver new messages to you`,
      `  ${pc.cyan("Stop")}          checkpoint your work at the end`,
      `  ${pc.cyan("SessionEnd")}    remove you from the live list on close`,
      pc.dim("Keep them all unless you have a specific reason not to."),
    ].join("\n"),
    "What the hooks do",
  );
  const hooks = await multiselect<HookName>({
    message: "Which hooks should fire? (space to toggle, enter to confirm)",
    required: true,
    initialValues: ALL_HOOKS,
    options: ALL_HOOKS.map((h) => ({ value: h, label: h, hint: HOOK_SPECS[h].hint })),
  });
  if (isCancel(hooks)) bail();

  const proceed = await confirm({
    message: `Write configuration into ${pc.bold(basename(p.repoRoot))}/ ?`,
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) bail();

  return {
    owner: String(owner).trim(),
    mode: mode as Mode,
    hooks: hooks as HookName[],
    store: store as StoreMode,
    branch: defaultBranch,
  };
}

// --- entry point -----------------------------------------------------------

export interface InitOptions {
  mode?: Mode;
  yes?: boolean;
  store?: StoreMode;
  branch?: string;
}

export async function init(opts: InitOptions = {}): Promise<void> {
  let p = paths();
  const repoRoot = p.repoRoot;
  const git = new Git(repoRoot);
  const selfScript = resolveSelfScript();
  const detectedMode = opts.mode ?? detectMode(repoRoot);
  const defaultOwner =
    (await git.userName()) ?? process.env.USER ?? process.env.USERNAME ?? "unknown";

  // Respect a committed .coflow.json (e.g. a teammate cloned a worktree repo).
  const existing = readCoflowConfig(repoRoot);

  const interactive = !opts.yes && Boolean(process.stdin.isTTY);

  let answers: Answers;
  if (interactive) {
    answers = await wizard(
      p,
      git,
      detectedMode,
      defaultOwner,
      selfScript,
      existing.store,
      existing.branch,
    );
  } else {
    answers = {
      owner: defaultOwner,
      mode: detectedMode,
      hooks: ALL_HOOKS,
      store: opts.store ?? existing.store,
      branch: opts.branch ?? existing.branch,
    };
  }
  if (opts.store) answers.store = opts.store;
  if (opts.branch) answers.branch = opts.branch;

  // Persist the storage choice so teammates inherit it, then recompute paths so
  // the store resolves to the worktree.
  if (answers.store === "worktree") {
    writeJson(p.coflowConfig, { store: "worktree", branch: answers.branch });
    p = paths();
  }

  const s = interactive ? spinner() : null;
  s?.start(
    answers.store === "worktree"
      ? "Setting up the dedicated context branch"
      : "Writing configuration",
  );

  // Bootstrap the worktree (local only; the first push happens at a checkpoint).
  let storeReady = true;
  let warn = "";
  if (answers.store === "worktree") {
    if (await git.isRepo()) {
      try {
        await git.ensureContextWorktree(answers.branch, p.root);
      } catch (err) {
        storeReady = false;
        warn = `worktree setup failed: ${(err as Error).message}`;
      }
    } else {
      storeReady = false;
      warn = "not a git repo yet — the worktree will be created on first use";
    }
  }
  if (storeReady) ensureStore(p);

  const written = applyConfig(p, answers, selfScript);
  if (answers.store === "worktree") written.unshift(rel(repoRoot, p.coflowConfig));
  if (storeReady) {
    written.push(
      answers.store === "worktree"
        ? `${p.root}  (worktree · branch '${answers.branch}')`
        : `${rel(repoRoot, p.featuresDir)}/  (store)`,
    );
  }
  s?.stop(
    storeReady && answers.store === "worktree"
      ? "Dedicated context branch ready"
      : "Configuration written",
  );
  if (warn) {
    if (interactive) log.warn(warn);
    else console.error(warn);
  }

  // Closing guidance.
  const remote = (await git.isRepo()) ? await git.remoteUrl() : null;
  const cc = command(answers.mode, repoRoot, selfScript);
  const base = [cc.bin, ...cc.prefixArgs].join(" ");
  const next: string[] = [];
  next.push(`Open each Claude session with  ${pc.cyan(base + " claude")}  — it auto-assigns a distinct identity (no env vars to set).`);
  next.push(`Watch the live group chat with  ${pc.cyan(base + " chat")}  ${pc.dim("(or the dashboard: " + base + " watch)")}`);
  if (answers.mode === "bin") next.push("Make sure `coflow` is on your PATH (npm i -g, or a dev dependency).");
  if (answers.mode === "self") next.push("Config calls your local build by absolute path — great for testing; publish + use bin mode to share.");
  if (answers.store === "worktree") {
    next.push(`Context lives on the '${answers.branch}' branch — your code branches stay clean.`);
    next.push(remote ? "It's pushed to origin on your first checkpoint." : "Add a remote to share it: git remote add origin <url>.");
  } else if (!remote) {
    next.push("Add a remote to share with teammates: git remote add origin <url>.");
  }
  next.push("Already have Claude Code open here? Restart it so the new config loads.");

  if (interactive) {
    note(written.map((w) => `${pc.green("+")} ${w}`).join("\n"), "Wrote");
    outro(
      `${pc.green("Done.")}\n` +
        next.map((n, i) => `  ${pc.dim(`${i + 1}.`)} ${n}`).join("\n"),
    );
    const wantChat = await confirm({
      message: "Set up the real-time group chat now? (recommended)",
      initialValue: true,
    });
    if (!isCancel(wantChat) && wantChat) {
      const { connect } = await import("./connect.js");
      await connect({});
    }
  } else {
    console.log("coflow: wrote");
    for (const w of written) console.log(`  + ${w}`);
    console.log("next:");
    next.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
  }
}
