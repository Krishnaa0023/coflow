/**
 * Secret redaction. Run over EVERY string before it is persisted to a feature
 * file or commit. This is one of the four things that bite if you skip it: the
 * tool acts on other people's repos, so a leaked token is a leaked token for the
 * whole team.
 *
 * This is a best-effort net, not a guarantee. It catches the common shapes
 * (provider keys, bearer tokens, private keys, `KEY=secret` assignments). Keep
 * adding patterns as you find leaks; never loosen them.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Private key blocks
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  // AWS access key id
  { name: "aws-akid", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (classic + fine-grained + oauth)
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{20,}\b/g },
  // Slack tokens
  { name: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  // Google API key
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  // Stripe
  { name: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  // OpenAI / Anthropic-style keys
  { name: "ai-key", re: /\b(?:sk-ant-[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z]{20,})\b/g },
  // JWT
  { name: "jwt", re: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/g },
  // Bearer header
  { name: "bearer", re: /\bBearer\s+[0-9A-Za-z._\-+/=]{16,}/g },
];

// KEY=value / "key": "value" assignments where the key name smells secret.
const ASSIGNMENT_RE =
  /\b([A-Za-z0-9_]*(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*)\b(\s*[:=]\s*["']?)([^\s"',}]{6,})/gi;

export interface RedactionResult {
  text: string;
  redacted: boolean;
  hits: string[];
}

export function redact(input: string): RedactionResult {
  if (!input) return { text: input, redacted: false, hits: [] };
  let text = input;
  const hits: string[] = [];

  for (const { name, re } of PATTERNS) {
    text = text.replace(re, () => {
      hits.push(name);
      return "«redacted:" + name + "»";
    });
  }

  text = text.replace(ASSIGNMENT_RE, (_m, key: string, sep: string) => {
    hits.push("assignment:" + key.toLowerCase());
    return `${key}${sep}«redacted»`;
  });

  return { text, redacted: hits.length > 0, hits };
}

/** Deep-redact every string in a JSON-ish value. Returns a new value. */
export function redactDeep<T>(value: T): { value: T; hits: string[] } {
  const hits: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v);
      if (r.redacted) hits.push(...r.hits);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, hits };
}
