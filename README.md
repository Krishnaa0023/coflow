# coflow

**A Telegram for AI coding agents.** coflow is a real-time group chat and shared project context that lets multiple Claude Code instances — your own parallel terminals, your teammates, and agents running on remote servers — stay aware of each other and talk to each other.

It rests on two coordination layers that work independently and compose:

**Layer 1 — Durable context (git).** One human-readable Markdown file per feature, committed to git. Either stored inline in `.context/` inside your repo, or on a dedicated branch via a git worktree so your code branches stay clean. No database, no embeddings — Claude reads the Markdown directly, so Claude itself is the semantic layer.

**Layer 2 — Real-time group chat (pluggable live channel).** Sessions on the same machine coordinate instantly through a shared local file — no network needed. Sessions on different machines or servers join the same "group" by sharing a key backed by [Upstash Redis](https://upstash.com/) (serverless HTTP pub/sub). If neither is configured, everything falls back silently to no-op — nothing breaks.

```
         Your machine (terminal A)        Your machine (terminal B)
         ┌──────────────────────────┐     ┌──────────────────────────┐
         │ Claude Code              │     │ Claude Code              │
         │   hooks ▶ MCP server     │     │   hooks ▶ MCP server     │
         │   .context/payments.md   │     │   .context/onboarding.md │
         └────────────┬─────────────┘     └────────────┬─────────────┘
                      │ same-machine: shared activity.md (instant)
                      │
         pull ▲       │ ▼ push (checkpoints only)
         ┌────────────▼─────────────────────────────┐
         │  Git remote — source of truth             │
         │  .context/features/*.md (one per feature) │
         └────────────────────┬─────────────────────┘
                              │ sync
         ┌────────────────────▼─────────────────────┐
         │  Teammates' machines  /  remote agents    │
         └───────────────────────────────────────────┘

         Cross-machine real-time:
         All sessions sharing the same KEY ──▶ Upstash Redis pub/sub
         (coflow1_... key — like a Telegram group invite link)
```

---

## Quickstart

```bash
# 1. Install
npm i -g @krish0023/coflow   # command is still `coflow`

# 2. Set up your project
cd your-project
coflow init          # wizard: detects git remote, writes config + store

# 3. Create a group or join one
coflow connect
# → CREATE A NEW GROUP: coflow generates and prints your coflow1_... key
# → JOIN AN EXISTING GROUP: paste your teammate's key when prompted

# 4. Share the key with teammates (treat it like a secret — it carries the backend token)
# They run: coflow connect  →  paste your key  →  joined

# 5. Restart Claude Code in the project
# Live group chat:
coflow chat          # terminal group-chat view

# Live dashboard:
coflow watch         # auto-refreshing status panel
```

`init` writes three committed files so teammates inherit the setup automatically:

| File | Purpose |
|---|---|
| `.mcp.json` | Registers the MCP server with Claude Code |
| `.claude/settings.json` | Installs the four lifecycle hooks |
| `CLAUDE.md` | Teaches Claude the coflow workflow |

Plus the `.context/` store (or a dedicated git branch in worktree mode).

---

## The invite / key model

When you run `coflow connect` you do one of two things:

- **Create a new group.** coflow generates a shareable key — a string starting with `coflow1_...`. This key encodes the real-time backend config. Share it with anyone who should be in the same group.
- **Join an existing group.** Paste the key someone gave you. You're now in the same group chat.

Everyone holding the same key sees the same real-time activity stream and can broadcast messages with `coflow say`. The key is like a Telegram group invite link — treat it as a secret.

---

## CLI reference

### Setup

```bash
coflow init [--yes] [--npx] [--worktree] [--branch <name>]
```

Interactive wizard. `--yes` accepts all defaults; `--npx` registers the MCP server via `npx` (no global install required); `--worktree` stores context on a dedicated git branch checked out as a git worktree so your code branches stay clean; `--branch <name>` sets the branch name (default: `coflow-context`).

### Connection and group chat

```bash
coflow connect           # create a new group (prints key) or join with a key
coflow chat              # live group-chat view — see messages as they arrive
coflow compact           # squash commits on the context branch (worktree mode) to fight commit bloat
```

### Awareness and dashboards

```bash
coflow watch [--once]    # live terminal dashboard; --once for a single static frame (CI-friendly)
coflow status            # current feature + pending delta count + summary
coflow summary           # all active features + recent cross-session activity
coflow activity          # recent activity log lines (last 20)
coflow board             # regenerate .context/BOARD.md from feature files
```

### Working

```bash
coflow say "<msg>"       # broadcast a note to the group (real-time + activity log)
coflow search <query>    # substring search across all feature files
coflow checkpoint [--summary "<state>"] [--status <status>] [--goal "<goal>"]
                         # fold queued deltas → write Markdown → commit → push
coflow pull              # manual fetch + regenerate board
```

### Plumbing

```bash
coflow mcp               # start the MCP server on stdio (used by .mcp.json)
coflow hook <name>       # run a hook handler (used by .claude/settings.json)
                         # names: session-start | pre-tool-use | post-tool-use | stop
```

---

## Multiple terminals on one machine

You cannot check out two git branches in the same directory, so give each terminal its own feature identity via environment variables:

```bash
# terminal 1
COFLOW_FEATURE=payments COFLOW_OWNER=dana claude

# terminal 2
COFLOW_FEATURE=onboarding COFLOW_OWNER=dana claude
```

| Env var | Purpose |
|---|---|
| `COFLOW_FEATURE` | Override the feature id (defaults to current git branch) |
| `COFLOW_OWNER` | Override the owner name (defaults to `git config user.name`, then `$USER`) |

Both terminals show up as distinct features and coordinate through `.context/` instantly — no git round-trip needed for same-machine coordination.

---

## Lifecycle hooks

Claude Code fires hooks automatically. coflow installs four:

| Hook | What coflow does |
|---|---|
| **SessionStart** | Pulls from remote, regenerates board, registers this instance's presence, and injects a summary of other active features/sessions + how to talk to them into Claude's context |
| **PreToolUse** (on file edits) | Checks for overlap with committed work AND in-progress edits from sibling sessions. Warns Claude before it touches a contested file. Hot path: no network, no embeddings. |
| **PostToolUse** (on file edits) | Records a structured delta locally AND auto-delivers any NEW group messages from other sessions into Claude's context (throttled). No commit or push. |
| **Stop** (task boundary) | Folds queued deltas into the feature Markdown file, commits, and pushes. The only operation that writes to the remote. |

---

## MCP tools

Claude calls only **three** tools directly — the surface is kept minimal because
tool definitions ride in the model's context on every turn:

| Tool | Purpose |
|---|---|
| `say` | Broadcast a message to the other sessions (group chat) |
| `inbox` | Read recent messages from other sessions |
| `checkpoint` | Write the feature file + commit/push, at task boundaries |

Everything else — pulling context, recording deltas, overlap checks, board and
activity — runs **automatically inside the hooks and CLI**, so it never needs to
sit in the per-turn tool list. (Those are still available as `coflow <cmd>` CLI
commands for humans/scripts.)

---

## Storage layout

```
.context/
├── features/<feature>.md     committed — one file per feature (durable record)
├── BOARD.md                  generated digest of all features      (gitignored)
├── activity.md               shared append-only activity log       (gitignored)
└── .pending/<feature>.jsonl  queued deltas awaiting checkpoint     (gitignored)
```

One file per feature keeps merges conflict-free: each session only ever writes its own file. `BOARD.md` and `activity.md` are local, regenerable views that are never committed.

In **worktree mode** (`coflow init --worktree`), the `.context/` directory lives in a separate git worktree on its own branch, so your feature branches never see context commits. Use `coflow compact` periodically to squash that branch's history.

### Per-feature file format

```markdown
---
feature: onboarding
owner: dana
status: active            # active | paused | blocked | done
goal: "Ship email + OAuth signup flow"
current_state: "OAuth callback done; email validation in progress"
files_touched: [src/auth/signup.ts, src/auth/oauth.ts]
decisions:
  - { at: "2025-06-01T14:00:00Z", text: "Use Auth.js over custom JWT" }
open_questions:
  - "Rate-limit strategy for the verification email endpoint?"
recent_deltas:
  - { at: "2025-06-01T15:00:00Z", kind: edit, summary: "Added OAuth callback", files: [src/auth/oauth.ts] }
updated_at: "2025-06-01T15:30:00Z"
v: 1
---

# onboarding · dana · active

**Goal:** Ship email + OAuth signup flow
**Current state:** OAuth callback done; email validation in progress

## Decisions
- Use Auth.js over custom JWT
```

Structured YAML frontmatter keeps overlap detection and merging mechanical. The Markdown body is a generated, human-readable rendering — it is never parsed back.

---

## Dashboard preview

```
╭─ active features (2) ───────────────────────────────────────╮
│ ● payments   dana   active                                   │
│   Stripe subscription billing                                │
│   files: src/billing/stripe.ts, src/shared/util.ts          │
│                                                              │
│ ● onboarding dana   active                                   │
│   Email + OAuth signup flow                                  │
│   files: src/auth/signup.ts, src/shared/util.ts             │
╰─────────────────────────────────────────────────────────────╯
╭─ file hotspots ─────────────────────────────────────────────╮
│ ⚠ src/shared/util.ts → payments, onboarding                 │
╰─────────────────────────────────────────────────────────────╯
╭─ recent activity ───────────────────────────────────────────╮
│ 2025-06-01 15:30 payments (dana): added webhook handler     │
│ 2025-06-01 15:00 onboarding (dana): OAuth callback done     │
╰─────────────────────────────────────────────────────────────╯
```

File hotspots — paths claimed by more than one feature, including in-progress edits from sibling terminals before anyone commits — appear as warnings.

---

## The four rules

Skipping any of these breaks the safety model:

1. **Push only at checkpoints.** `PostToolUse` writes locally; only `checkpoint` / `Stop` push. Doing otherwise turns the feature files into a commit firehose.
2. **One file per feature.** Each session writes only its own `features/<name>.md`. This is what keeps git merges conflict-free.
3. **Redact secrets before any commit or broadcast.** Every write path — file contents, commit messages, and activity lines — runs through `redact()`. Do not bypass it.
4. **No hard Docker or native dependencies.** coflow ships pure-JS only (`@modelcontextprotocol/sdk`, `zod`, `yaml`, `@clack/prompts`). Nothing to compile, nothing to containerize.

---

## Development

```bash
npm install
npm run build          # compiles TypeScript → dist/
npm run typecheck      # type-check without emitting
npm run dev -- status  # run the CLI from source via tsx
```

---

## License

MIT
