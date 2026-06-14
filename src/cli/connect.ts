import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  intro,
  outro,
  select,
  text,
  note,
  cancel,
  isCancel,
} from "@clack/prompts";
import pc from "picocolors";
import { banner } from "./brand.js";
import { paths } from "../core/paths.js";
import { encodeKey, decodeKey, newGroupId, type Connection } from "../core/key.js";
import { saveConnection, resolveConnection } from "../core/live.js";

/**
 * `coflow connect` — the group-chat onboarding. Either CREATE a new group (and
 * get a shareable `coflow1_…` key) or JOIN an existing one by pasting a key.
 * Everyone with the same key is in the same real-time group.
 */

export interface ConnectOptions {
  key?: string;
  create?: boolean;
  upstash?: boolean;
  url?: string;
  token?: string;
}

function ensureLocalGitignore(repoRoot: string): void {
  const gi = join(repoRoot, ".gitignore");
  const entry = ".coflow.local.json";
  let content = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (content.includes(entry)) return;
  if (content && !content.endsWith("\n")) content += "\n";
  content += `${entry}\n`;
  writeFileSync(gi, content, "utf8");
}

function makeNew(opts: ConnectOptions): Connection {
  if (opts.upstash) {
    const url = opts.url ?? process.env.COFLOW_REDIS_URL;
    const token = opts.token ?? process.env.COFLOW_REDIS_TOKEN;
    if (!url || !token) {
      throw new Error(
        "upstash group needs --url and --token (or COFLOW_REDIS_URL / COFLOW_REDIS_TOKEN)",
      );
    }
    return { kind: "upstash", group: newGroupId(), url, token };
  }
  return { kind: "local", group: newGroupId() };
}

export async function connect(opts: ConnectOptions = {}): Promise<void> {
  const p = paths();
  ensureLocalGitignore(p.repoRoot);

  // Non-interactive: join with a key.
  if (opts.key) {
    const conn = decodeKey(opts.key);
    saveConnection(p, conn);
    console.log(`joined group "${conn.group}" (${conn.kind}). Run: coflow chat`);
    return;
  }

  // Non-interactive: create.
  if (opts.create) {
    const conn = makeNew(opts);
    saveConnection(p, conn);
    console.log(`created ${conn.kind} group "${conn.group}".`);
    console.log(`share this key:\n  ${encodeKey(conn)}`);
    return;
  }

  // Interactive.
  console.log(banner("connect a group"));
  intro(pc.bgCyan(pc.black(" coflow connect ")));
  const existing = resolveConnection(p);

  let action: string;
  if (existing) {
    // Already in a group → default to showing the key, not re-running setup.
    const a = await select({
      message: `You're in the ${existing.kind} group "${existing.group}". What now?`,
      initialValue: "show",
      options: [
        { value: "show", label: "Show my group key", hint: "stay in this group; copy the key to invite others" },
        { value: "create", label: "Create a NEW group", hint: "leaves the current one" },
        { value: "join", label: "Join a DIFFERENT group", hint: "paste another key" },
      ],
    });
    if (isCancel(a)) return cancel("Cancelled.");
    action = String(a);
    if (action === "show") {
      note(
        `${pc.bold("Your group key")} — share it to invite others:\n\n  ${pc.cyan(encodeKey(existing))}`,
        "Invite",
      );
      outro(`Still in group "${existing.group}". Run ${pc.cyan("coflow chat")}.`);
      return;
    }
  } else {
    const a = await select({
      message: "Group chat:",
      options: [
        { value: "create", label: "Create a new group", hint: "you get a key to share" },
        { value: "join", label: "Join an existing group", hint: "paste a teammate's key" },
      ],
    });
    if (isCancel(a)) return cancel("Cancelled.");
    action = String(a);
  }

  if (action === "join") {
    const key = await text({
      message: "Paste the group key (coflow1_…)",
      validate: (v) => {
        if (!v) return "Required.";
        try {
          decodeKey(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (isCancel(key)) return cancel("Cancelled.");
    const conn = decodeKey(String(key));
    saveConnection(p, conn);
    outro(`${pc.green("Joined")} group "${conn.group}". Restart open Claude sessions here to join it, then ${pc.cyan("coflow chat")}.`);
    return;
  }

  const backend = await select<"local" | "upstash">({
    message: "Where should the group run?",
    initialValue: "local",
    options: [
      { value: "local", label: "This machine only", hint: "zero setup — same-machine terminals" },
      { value: "upstash", label: "Cross-machine (Upstash Redis)", hint: "free serverless pub/sub" },
    ],
  });
  if (isCancel(backend)) return cancel("Cancelled.");

  let conn: Connection;
  if (backend === "local") {
    conn = { kind: "local", group: newGroupId() };
  } else {
    note(
      `Create a free DB at ${pc.cyan("https://upstash.com")} → copy the REST URL + token.`,
      "Upstash",
    );
    const url = await text({
      message: "Upstash REST URL",
      initialValue: process.env.COFLOW_REDIS_URL ?? "",
      validate: (v) => (v && v.startsWith("http") ? undefined : "Enter the https REST URL."),
    });
    if (isCancel(url)) return cancel("Cancelled.");
    const token = await text({
      message: "Upstash REST token",
      initialValue: process.env.COFLOW_REDIS_TOKEN ?? "",
      validate: (v) => (v ? undefined : "Required."),
    });
    if (isCancel(token)) return cancel("Cancelled.");
    conn = {
      kind: "upstash",
      group: newGroupId(),
      url: String(url).trim(),
      token: String(token).trim(),
    };
  }

  saveConnection(p, conn);
  note(
    `${pc.bold("Share this key")} so others join the same group${conn.kind === "local" ? pc.dim(" (this machine only)") : ""}:\n\n  ${pc.cyan(encodeKey(conn))}`,
    "Group key",
  );
  outro(`${pc.green("Group created.")} Restart open Claude sessions here to join, then ${pc.cyan("coflow chat")} to watch.`);
}
