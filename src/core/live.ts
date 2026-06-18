import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContextPaths } from "./paths.js";
import type { Connection } from "./key.js";
import { readJsonSafe, writeJson } from "./jsonfile.js";

/**
 * The real-time group-chat layer — coflow's "Telegram for agents".
 *
 * Pluggable, with graceful no-op fallback (never a hard dependency):
 *   - NoopChannel       : nothing configured → silent no-op, everything still works
 *   - LocalFileChannel  : zero-setup, same-machine — a shared append-only file
 *   - UpstashChannel    : cross-machine / cross-server via Upstash Redis (HTTP pub/sub)
 *
 * Messages are ephemeral (a capped history, not git commits), so this never adds
 * to the commit log. Secrets are redacted by the caller before publishing.
 */

export interface ChatMessage {
  at: string; // ISO
  group: string;
  feature: string;
  owner: string;
  kind: "say" | "activity" | "presence";
  text: string;
}

/** A live coflow session in the group (one per Claude instance). */
export interface Presence {
  id: string; // stable per session (Claude's session_id)
  feature: string;
  owner: string;
  at: string; // ISO of last heartbeat
}

// Heartbeat refreshes presence on every edit, so the window only needs to cover
// idle-but-open sessions + crash cleanup. SessionEnd removes presence on a clean close.
const PRESENCE_WINDOW_MS = 15 * 60 * 1000;

/** Max chat messages retained in the ephemeral Upstash history list. */
const HISTORY_CAP = 1000;

export interface LiveChannel {
  readonly enabled: boolean;
  readonly kind: string;
  readonly group: string | null;
  publish(msg: ChatMessage): Promise<void>;
  history(limit?: number): Promise<ChatMessage[]>;
  /** Resolves when the signal aborts. Calls onMessage for each incoming message. */
  subscribe(onMessage: (m: ChatMessage) => void, signal: AbortSignal): Promise<void>;
  /** Register/refresh this session in the group's presence list. */
  announce(p: Presence): Promise<void>;
  /** Remove this session from presence (clean close). */
  removePresence(id: string): Promise<void>;
  /** Sessions seen within the freshness window. */
  members(withinMs?: number): Promise<Presence[]>;
  /** Liveness/reachability probe for `coflow doctor`. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

function parseMsg(s: string): ChatMessage | null {
  try {
    const o = JSON.parse(s) as ChatMessage;
    if (o && typeof o.text === "string" && typeof o.feature === "string") return o;
  } catch {
    /* ignore */
  }
  return null;
}

// --- no-op -----------------------------------------------------------------

export class NoopChannel implements LiveChannel {
  readonly enabled = false;
  readonly kind = "noop";
  readonly group = null;
  async publish(): Promise<void> {}
  async history(): Promise<ChatMessage[]> {
    return [];
  }
  async subscribe(_on: (m: ChatMessage) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  async announce(): Promise<void> {}
  async removePresence(): Promise<void> {}
  async members(): Promise<Presence[]> {
    return [];
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "no group connected" };
  }
}

// --- local file (same machine, zero setup) ---------------------------------

export class LocalFileChannel implements LiveChannel {
  readonly enabled = true;
  readonly kind = "local";
  private readonly file: string;
  private readonly presenceFile: string;
  constructor(readonly group: string) {
    this.file = join(homedir(), ".coflow", "groups", `${group}.jsonl`);
    this.presenceFile = join(homedir(), ".coflow", "groups", `${group}.presence.json`);
  }
  private lines(): string[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim());
  }
  async publish(msg: ChatMessage): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(msg) + "\n", "utf8");
  }
  async history(limit = 50): Promise<ChatMessage[]> {
    return this.lines()
      .slice(-limit)
      .map(parseMsg)
      .filter((m): m is ChatMessage => m !== null);
  }
  async subscribe(onMessage: (m: ChatMessage) => void, signal: AbortSignal): Promise<void> {
    let seen = this.lines().length;
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const all = this.lines();
        for (let i = seen; i < all.length; i++) {
          const m = parseMsg(all[i] ?? "");
          if (m) onMessage(m);
        }
        seen = all.length;
      }, 400);
      const stop = () => {
        clearInterval(timer);
        resolve();
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  }
  async announce(p: Presence): Promise<void> {
    mkdirSync(dirname(this.presenceFile), { recursive: true });
    const map = readJsonSafe<Record<string, Presence>>(this.presenceFile) ?? {};
    map[p.id] = p;
    writeJson(this.presenceFile, map);
  }
  async removePresence(id: string): Promise<void> {
    const map = readJsonSafe<Record<string, Presence>>(this.presenceFile) ?? {};
    if (map[id]) {
      delete map[id];
      writeJson(this.presenceFile, map);
    }
  }
  async members(withinMs = PRESENCE_WINDOW_MS): Promise<Presence[]> {
    const map = readJsonSafe<Record<string, Presence>>(this.presenceFile) ?? {};
    const cutoff = Date.now() - withinMs;
    return Object.values(map).filter((m) => Date.parse(m.at) >= cutoff);
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      return { ok: true, detail: `local channel · ${this.file}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

// --- Upstash Redis (cross-machine / cross-server) --------------------------

export class UpstashChannel implements LiveChannel {
  readonly enabled = true;
  readonly kind = "upstash";
  private readonly channel: string;
  private readonly histKey: string;
  private readonly presenceKey: string;
  constructor(
    private readonly url: string,
    private readonly token: string,
    readonly group: string,
  ) {
    this.channel = `coflow:${group}`;
    this.histKey = `coflow:${group}:history`;
    this.presenceKey = `coflow:${group}:presence`;
  }
  private async cmd(args: string[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`upstash ${args[0]} failed: ${res.status}`);
    const j = (await res.json()) as { result?: unknown };
    return j.result;
  }
  async publish(msg: ChatMessage): Promise<void> {
    const payload = JSON.stringify(msg);
    await this.cmd(["PUBLISH", this.channel, payload]);
    await this.cmd(["LPUSH", this.histKey, payload]);
    // Keep a generous tail so a full day of chat survives until it's summarized;
    // history is ephemeral, but trimming too hard would drop messages before the
    // daily rollover can capture them. ~1k messages is plenty and cheap.
    await this.cmd(["LTRIM", this.histKey, "0", String(HISTORY_CAP - 1)]);
  }
  async history(limit = 50): Promise<ChatMessage[]> {
    const res = await this.cmd(["LRANGE", this.histKey, "0", String(limit - 1)]);
    const arr = Array.isArray(res) ? (res as string[]) : [];
    return arr
      .map(parseMsg)
      .filter((m): m is ChatMessage => m !== null)
      .reverse(); // LPUSH stores newest-first; show chronological
  }
  async subscribe(onMessage: (m: ChatMessage) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(`${this.url}/subscribe/${encodeURIComponent(this.channel)}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`upstash subscribe failed: ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          // Upstash SSE: "message,<channel>,<payload>"
          const c1 = data.indexOf(",");
          const c2 = data.indexOf(",", c1 + 1);
          if (c1 < 0 || c2 < 0 || data.slice(0, c1) !== "message") continue;
          const m = parseMsg(data.slice(c2 + 1));
          if (m) onMessage(m);
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") throw err;
    }
  }
  async announce(p: Presence): Promise<void> {
    await this.cmd(["HSET", this.presenceKey, p.id, JSON.stringify(p)]);
  }
  async members(withinMs = PRESENCE_WINDOW_MS): Promise<Presence[]> {
    const res = await this.cmd(["HGETALL", this.presenceKey]);
    const arr = Array.isArray(res) ? (res as string[]) : [];
    const out: Presence[] = [];
    const stale: string[] = [];
    const cutoff = Date.now() - withinMs;
    for (let i = 0; i + 1 < arr.length; i += 2) {
      const id = arr[i];
      const val = arr[i + 1];
      if (id === undefined || val === undefined) continue;
      try {
        const pr = JSON.parse(val) as Presence;
        if (Date.parse(pr.at) >= cutoff) out.push(pr);
        else stale.push(id);
      } catch {
        stale.push(id);
      }
    }
    if (stale.length) {
      try {
        await this.cmd(["HDEL", this.presenceKey, ...stale]);
      } catch {
        /* ignore */
      }
    }
    return out;
  }
  async removePresence(id: string): Promise<void> {
    try {
      await this.cmd(["HDEL", this.presenceKey, id]);
    } catch {
      /* best-effort */
    }
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.cmd(["PING"]);
      return r === "PONG"
        ? { ok: true, detail: `Upstash reachable · group ${this.group}` }
        : { ok: false, detail: `unexpected PING reply: ${JSON.stringify(r)}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

// --- resolution ------------------------------------------------------------

interface RealtimeConfig {
  kind?: string;
  group?: string;
  url?: string;
}

/** Resolve the active connection from committed config + local secrets + env. */
export function resolveConnection(p: ContextPaths): Connection | null {
  const cfg = readJsonSafe<{ realtime?: RealtimeConfig }>(p.coflowConfig);
  const rt = cfg?.realtime;
  if (!rt?.group) return null;
  if (rt.kind === "local") return { kind: "local", group: rt.group };
  if (rt.kind === "upstash") {
    const local = readJsonSafe<{ url?: string; token?: string }>(
      join(p.repoRoot, ".coflow.local.json"),
    );
    const url = process.env.COFLOW_REDIS_URL ?? local?.url ?? rt.url;
    const token = process.env.COFLOW_REDIS_TOKEN ?? local?.token;
    if (!url || !token) return null; // configured but missing secret → no-op
    return { kind: "upstash", group: rt.group, url, token };
  }
  return null;
}

export function resolveChannel(p: ContextPaths): LiveChannel {
  const conn = resolveConnection(p);
  if (!conn) return new NoopChannel();
  if (conn.kind === "local") return new LocalFileChannel(conn.group);
  return new UpstashChannel(conn.url!, conn.token!, conn.group);
}

/** Persist a connection: group/kind committed (shared), secrets local (gitignored). */
export function saveConnection(p: ContextPaths, conn: Connection): void {
  const cfg = readJsonSafe<Record<string, unknown>>(p.coflowConfig) ?? {};
  cfg.realtime = { kind: conn.kind, group: conn.group };
  writeJson(p.coflowConfig, cfg);
  if (conn.kind === "upstash" && conn.url && conn.token) {
    writeJson(join(p.repoRoot, ".coflow.local.json"), {
      url: conn.url,
      token: conn.token,
    });
  }
}
