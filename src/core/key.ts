import { randomUUID } from "node:crypto";

/**
 * Group "invite keys" — like a Telegram group link. A key encodes everything a
 * peer needs to join the same real-time group: the backend kind, the group id,
 * and (for hosted backends) the connection URL + token. Possession of the key
 * grants access, so treat it as a secret.
 */

export type ConnectionKind = "local" | "upstash";

export interface Connection {
  kind: ConnectionKind;
  group: string;
  /** Hosted backends only. */
  url?: string;
  token?: string;
}

const PREFIX = "coflow1_";

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

export function encodeKey(conn: Connection): string {
  const payload: Record<string, unknown> = { v: 1, k: conn.kind, g: conn.group };
  if (conn.url) payload.u = conn.url;
  if (conn.token) payload.t = conn.token;
  return PREFIX + b64urlEncode(JSON.stringify(payload));
}

export function decodeKey(key: string): Connection {
  const s = (key ?? "").trim();
  if (!s.startsWith(PREFIX)) {
    throw new Error("invalid coflow key (missing coflow1_ prefix)");
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(b64urlDecode(s.slice(PREFIX.length)));
  } catch {
    throw new Error("invalid coflow key (corrupt payload)");
  }
  const kind = obj.k;
  const group = obj.g;
  if ((kind !== "local" && kind !== "upstash") || typeof group !== "string" || !group) {
    throw new Error("invalid coflow key (missing or bad fields)");
  }
  const conn: Connection = { kind, group };
  if (typeof obj.u === "string") conn.url = obj.u;
  if (typeof obj.t === "string") conn.token = obj.t;
  if (conn.kind === "upstash" && (!conn.url || !conn.token)) {
    throw new Error("invalid coflow key (upstash needs url + token)");
  }
  return conn;
}

/** A fresh, short, unguessable group id. */
export function newGroupId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
