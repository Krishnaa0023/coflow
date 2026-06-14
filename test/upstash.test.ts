import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { UpstashChannel } from "../src/core/live.js";

/**
 * Integration test for the Upstash (cross-machine) channel against a faithful
 * in-memory mock of the Upstash Redis REST API — the same protocol shapes a real
 * Upstash instance speaks (command-array POSTs + an SSE /subscribe endpoint).
 * This exercises the adapter's publish/history/presence/subscribe paths end to
 * end without needing real credentials.
 */

function startMock() {
  const lists = new Map();
  const hashes = new Map();
  const subs = new Map(); // channel -> Set<res>

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url && req.url.startsWith("/subscribe/")) {
      const ch = decodeURIComponent(req.url.slice("/subscribe/".length));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (!subs.has(ch)) subs.set(ch, new Set());
      subs.get(ch).add(res);
      req.on("close", () => subs.get(ch)?.delete(res));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let cmd;
        try {
          cmd = JSON.parse(body);
        } catch {
          res.writeHead(400).end();
          return;
        }
        const [op, ...args] = cmd;
        let result = "OK";
        switch (op) {
          case "PING":
            result = "PONG";
            break;
          case "PUBLISH": {
            const [ch, msg] = args;
            const set = subs.get(ch);
            if (set) for (const r of set) r.write(`data: message,${ch},${msg}\n\n`);
            result = set ? set.size : 0;
            break;
          }
          case "LPUSH": {
            const [k, ...vs] = args;
            const l = lists.get(k) ?? [];
            for (const v of vs) l.unshift(v);
            lists.set(k, l);
            result = l.length;
            break;
          }
          case "LTRIM": {
            const [k, s, e] = args;
            const l = lists.get(k) ?? [];
            lists.set(k, l.slice(Number(s), e === "-1" ? undefined : Number(e) + 1));
            break;
          }
          case "LRANGE": {
            const [k, s, e] = args;
            const l = lists.get(k) ?? [];
            const end = Number(e);
            result = l.slice(Number(s), end < 0 ? undefined : end + 1);
            break;
          }
          case "HSET": {
            const [k, f, v] = args;
            const h = hashes.get(k) ?? new Map();
            h.set(f, v);
            hashes.set(k, h);
            result = 1;
            break;
          }
          case "HGETALL": {
            const [k] = args;
            const h = hashes.get(k) ?? new Map();
            result = [...h.entries()].flat();
            break;
          }
          case "HDEL": {
            const [k, ...fs] = args;
            const h = hashes.get(k);
            let n = 0;
            if (h) for (const f of fs) if (h.delete(f)) n++;
            result = n;
            break;
          }
          default:
            result = null;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => {
          for (const set of subs.values()) for (const r of set) r.end();
          server.close();
        },
      });
    });
  });
}

const msg = (text, feature = "x", owner = "a") => ({
  at: new Date().toISOString(),
  group: "g",
  feature,
  owner,
  kind: "say",
  text,
});

test("upstash: publish + history round-trips chronologically", async () => {
  const m = await startMock();
  try {
    const ch = new UpstashChannel(m.url, "tok", "g1");
    await ch.publish(msg("CLAIM auth.ts", "login"));
    await ch.publish(msg("ACK", "api"));
    const h = await ch.history(10);
    assert.equal(h.length, 2);
    assert.equal(h[0].text, "CLAIM auth.ts");
    assert.equal(h[1].text, "ACK");
  } finally {
    m.close();
  }
});

test("upstash: presence announce / members / removePresence", async () => {
  const m = await startMock();
  try {
    const ch = new UpstashChannel(m.url, "tok", "g2");
    await ch.announce({ id: "s1", feature: "login", owner: "a", at: new Date().toISOString() });
    await ch.announce({ id: "s2", feature: "api", owner: "b", at: new Date().toISOString() });
    assert.equal((await ch.members()).length, 2);
    await ch.removePresence("s1");
    const left = await ch.members();
    assert.equal(left.length, 1);
    assert.equal(left[0].feature, "api");
  } finally {
    m.close();
  }
});

test("upstash: health PING returns ok", async () => {
  const m = await startMock();
  try {
    const ch = new UpstashChannel(m.url, "tok", "g3");
    const h = await ch.health();
    assert.equal(h.ok, true);
  } finally {
    m.close();
  }
});

test("upstash: subscribe receives a published message", async () => {
  const m = await startMock();
  try {
    const ch = new UpstashChannel(m.url, "tok", "g4");
    const got = [];
    const ac = new AbortController();
    const subP = ch.subscribe((m2) => {
      got.push(m2.text);
      ac.abort();
    }, ac.signal);
    await new Promise((r) => setTimeout(r, 150)); // let the SSE connection register
    await ch.publish(msg("hello-sub"));
    await subP;
    assert.deepEqual(got, ["hello-sub"]);
  } finally {
    m.close();
  }
});
