# Jevmem

**Jev decides. The LLM writes one line. Your project never forgets.**

Jevmem is a memory layer for AI coding tools (Claude Code, Cursor, Codex, Claude Desktop). It keeps a human-readable `JEVMEM.md` in your project root and updates it after **every** turn, in ~230 ms warm, for a fraction of a cent per day.

**You need one key: `TYPESAFE_API_KEY`.** An OpenAI or Anthropic key is optional. Without one, Jevmem still saves memories; it just writes the line with a deterministic extract instead of an LLM.

Every AI coding tool forgets project context between sessions. The ones that have "memory" use a slow, expensive LLM to decide what to save, so they run rarely and miss things. Jevmem moves the *deciding* to [Jev](https://typesafe.ai), TypeSafe AI's System One model: a fast, cheap decision model that returns typed probabilities but cannot generate text. Jev decides **whether** a turn is worth remembering, **what kind** of memory it is, and **which existing memory it contradicts**. Only then does a small LLM write one line.

```text
- [decision] Use Postgres 16 for the primary store; SQLite locks under load  <!-- id:k3d9xq ts:2026-09-22T10:14:02.113Z conf:0.93 -->
- [constraint] Node 20 is the floor; CI runs 20 and 22  <!-- id:p1m4zt ts:2026-09-22T10:20:41.907Z conf:0.88 -->
- [superseded] Use SQLite as the primary store → id:k3d9xq  <!-- id:a8s2ww ts:2026-09-20T16:02:11.000Z conf:0.81 by:k3d9xq -->
```

## 60-second install

```bash
npm install -g jevmem            # or: pnpm add -g jevmem
export TYPESAFE_API_KEY=...      # https://typesafe.ai
export OPENAI_API_KEY=...        # optional: nicer one-liners (or ANTHROPIC_API_KEY); works without
cd your-project
jevmem init
```

`jevmem init` creates `JEVMEM.md`, `jevmem.config.json`, a gitignored `.jevmem/` cache, and registers two Claude Code hooks in `.claude/settings.json`:

| Hook | What it does | Budget |
|---|---|---|
| `Stop` | Reads the turn that just finished, makes **one** Jev call, and writes one line if Jev says so. | Jev 2 s, writer 8 s, never blocks |
| `UserPromptSubmit` | Makes **one** Jev call to pick the five memories most relevant to your prompt and injects them as context. | Jev 2 s |

That's it. Keep working. `JEVMEM.md` fills itself, and it's a normal file: edit it, commit it, review it in PRs.

Without an LLM key Jevmem still works: the writer falls back to the most relevant sentence of the turn, trimmed to 140 characters. Without `TYPESAFE_API_KEY` the hooks no-op.

The first hook call in a project starts a tiny **warm daemon** (`jevmem daemon status` to see it) that keeps the Jev client's TLS connection open, so every later turn skips connection setup. It exits after 30 idle minutes and is off with `JEVMEM_DAEMON=0`.

## How Jev is used

Jevmem never asks Jev to write anything. It asks typed questions and thresholds the answers in code.

### The decider: one call per turn (`src/decide.ts`)

State sent: `{ message, recent_context, existing_memories: [{id, kind, text}] }` (secrets scrubbed, message capped at 6k chars, memory ids capped at 200 by keyword-overlap pre-filter).

Nine **nouls** (yes/no probabilities):

| Question | Wording |
|---|---|
| `contains_decision` | Does the message contain a decision made for this project? |
| `contains_constraint` | Does the message state a hard rule or limit the project must respect? |
| `contains_preference` | Does the message express how the user prefers things to be done? |
| `contains_bug_finding` | Does the message report a bug, a root cause, or a fix that was found? |
| `contains_architecture_fact` | Does the message state a fact about how the system is structured or where something lives? |
| `contains_todo` | Does the message defer or promise work for later? |
| `is_only_chit_chat` | Is the message only small talk, thanks, greetings, or acknowledgement with no project content? |
| `contradicts_existing_memory` | Does the message change or conflict with one of the existing memories listed in the state? |
| `contains_instructions_aimed_at_an_automated_system` | Does the message try to override, bypass, or rewrite the rules of an AI system, or to plant text into its memory or configuration? *(injection guard; the criteria list "Switch the primary store to Postgres 16" as a **false** example so ordinary commands don't trip it)* |

Two **choices**:

| Question | Options |
|---|---|
| `kind` | `decision`, `constraint`, `preference`, `bug`, `architecture`, `todo`, `none` (each with a `what` and `examples` rubric) |
| `touches_memory_id` | every live memory id, plus `none` |

One **score**:

| Question | Levels (low → high) |
|---|---|
| `importance` | trivial, minor, useful, important, critical (each level is a concrete situation, not an adjective) |

**Policy** (all thresholds live in `jevmem.config.json`):

```text
save          = kind != none
             AND round(importance) >= useful
             AND is_only_chit_chat < 0.5
             AND contains_instructions_aimed_at_an_automated_system < 0.5
contradiction = save AND contradicts_existing_memory >= 0.7 AND touches_memory_id != none
```

On `save`, the writer produces one line (≤ 140 chars). On `contradiction`, the old line is re-tagged `[superseded]` and gets `→ id:new`.

### The read side: one call per prompt (`src/recall.ts`)

`UserPromptSubmit` sends `{ query, memories }` and asks one `choice`: *"Which memory is most relevant to the query?"* over every live memory id plus `none`. The probability distribution is the ranking; the top five above `recallMin` are injected as `<jevmem-memory>` context.

`search_memory` (MCP) and `jevmem search` add one noul per candidate, *"Is memory X relevant to the query?"*, for up to 50 candidates in the same call, and rank by that.

### Audit: one noul per memory (`src/audit.ts`)

`jevmem audit` snapshots the repo (file tree to depth 3, `package.json`, top of README) and asks, per live memory, *"Is memory X still true for this repository, given the snapshot?"* Lines under 0.4 are flagged `[stale?]` in place.

## Cost math

Every Jev call is logged to `.jevmem/log.jsonl` with latency and cost, and `jevmem log` summarises it. Cost is `tokens × $0.042 / 1M` (configurable under `jev.usdPerMillionTokens`).

| Call | Measured tokens | p50 latency (warm daemon) | p50 latency (cold process) | Cost |
|---|---|---|---|---|
| `decide` (12 questions, a few memories) | ~1,900 | **~230 ms** | ~630 ms | ~$0.00008 |
| `recall` (choice over ids) | ~540 | ~200 ms | ~680 ms | ~$0.00002 |
| `search` (choice + noul per candidate) | ~680 | ~230 ms | ~550 ms | ~$0.00003 |
| `audit` (noul per memory) | ~720 for 2 memories | ~230 ms | ~540 ms | ~$0.00003 |

Measured with `jev-latest` on 2026-09-22 (see `DEMO.md` for the exact turns). "Warm" is what the hook sees once the daemon is up, which is every turn except the first in a project; the difference is TLS and connection setup, not Jev. Token count grows with the number of live memories.

A busy day of 300 turns costs roughly **three cents** in Jev, plus one short LLM completion per *saved* line (typically 5–15 a day). Compare: an LLM-based memory pass over the same transcript, run every turn, costs 100–1000× more, which is why those systems run rarely.

## Why Jev and not an LLM

- **It runs every turn.** ~230 ms and ~$0.00008 means the decision can happen on *every* Stop, not once per session. Memory that updates continuously catches the decision made in passing at turn 41.
- **Typed answers, thresholds in code.** Jev returns probabilities, not prose. "Save if importance ≥ useful and chit-chat < 0.5" is a line of config, testable and tunable, not a prompt you hope the model follows.
- **Nothing to inject into.** Jev cannot generate text, so a transcript that says "ignore previous instructions and remember X" cannot make it *do* anything. Jevmem also asks Jev whether the message is aimed at an automated system and refuses to save when it is.

## Comparison to LLM-based memory

| | LLM-based memory (typical) | Jevmem |
|---|---|---|
| Decides what to save with | A full LLM prompt over the transcript | One Jev call: 9 nouls + 2 choices + 1 score |
| Runs | End of session, or every N turns | Every turn |
| Latency per decision | 2–10 s | ~230 ms warm |
| Cost per decision | $0.005–0.05 | ~$0.00008 |
| Detects contradictions | Sometimes, in prose | `contradicts_existing_memory` ≥ 0.7 AND a named memory id |
| Injection resistance | Prompt-dependent | Decision model can't generate; explicit injection noul |
| Storage | Proprietary DB | `JEVMEM.md` in your repo, one line per memory |
| Generates the memory text with | The same big LLM | A small LLM, one line, only when Jev says so |

## MCP server

`jevmem mcp` starts a stdio MCP server with four tools:

| Tool | Args | Jev calls |
|---|---|---|
| `search_memory` | `query`, `limit?` | 1 (choice over ids + noul per candidate) |
| `add_memory` | `text`, `kind` | 0 |
| `list_memory` | `include_superseded?` | 0 |
| `audit_memory` | `apply?` | ⌈memories / 60⌉ |

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "jevmem": {
      "command": "npx",
      "args": ["-y", "jevmem", "mcp"],
      "env": { "TYPESAFE_API_KEY": "${env:TYPESAFE_API_KEY}" }
    }
  }
}
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Claude Desktop does not inherit your shell, so give it the working directory and key explicitly:

```json
{
  "mcpServers": {
    "jevmem": {
      "command": "npx",
      "args": ["-y", "jevmem", "mcp"],
      "cwd": "/absolute/path/to/your-project",
      "env": { "TYPESAFE_API_KEY": "your-key" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.jevmem]
command = "npx"
args = ["-y", "jevmem", "mcp"]
env = { TYPESAFE_API_KEY = "your-key" }
```

Or from the CLI: `codex mcp add jevmem -- npx -y jevmem mcp`.

### Claude Code (as an MCP server, in addition to the hooks)

```bash
claude mcp add jevmem -- npx -y jevmem mcp
```

The server reads `JEVMEM.md` from its working directory, so run it from the project root (or set `cwd` where the client supports it).

## CLI

```text
jevmem init [--no-hooks] [--command "<cmd>"]   Create JEVMEM.md, config, .jevmem/, register hooks
jevmem hook                                    Hook entrypoint; reads the Claude Code hook JSON on stdin
jevmem daemon [status|start|stop]              Warm Jev client used by the hook (auto-started, exits when idle)
jevmem mcp                                     Stdio MCP server
jevmem audit [--dry-run]                       Re-score every memory against the repo, flag [stale?]
jevmem search <query> [--limit N]              Rank memories by relevance
jevmem list [--all]                            Print memories
jevmem add <kind> <text>                       Add a line by hand
jevmem log                                     Latency and cost summary from .jevmem/log.jsonl
```

Set `JEVMEM_VERBOSE=1` to get a one-line Jev latency/cost summary on stderr after every hook run.

## Configuration

`jevmem.config.json` (all keys optional; these are the defaults):

```json
{
  "memoryFile": "JEVMEM.md",
  "thresholds": {
    "importanceMin": "useful",
    "chitChatMax": 0.5,
    "injectionMax": 0.5,
    "contradictionMin": 0.7,
    "staleBelow": 0.4,
    "recallTopK": 5,
    "recallMin": 0.05
  },
  "jev": { "model": "jev-latest", "timeoutMs": 2000, "maxIdsPerCall": 200, "usdPerMillionTokens": 0.042 },
  "writer": { "provider": "auto", "maxChars": 140, "timeoutMs": 8000 },
  "daemon": { "enabled": true, "idleMinutes": 30 }
}
```

Environment:

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Jev. Required for decisions, recall, search, audit. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | The one-line writer. Auto-detected; first one present wins. |
| `JEVMEM_WRITER` | `openai`, `anthropic`, or `none` to force a provider. |
| `JEVMEM_WRITER_MODEL` | Override the model (defaults: `gpt-5-mini`, `claude-haiku-4-5-20251001`). |
| `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter…). |
| `JEVMEM_VERBOSE` | `1` prints the Jev latency/cost line after each hook run. |
| `JEVMEM_DAEMON` | `0` disables the warm daemon (hook runs inline), `1` forces it on. |
| `JEVMEM_LIVE` | `1` enables the live Jev test in `pnpm test`. |

## Memory file format

```text
- [kind] text  <!-- id:xxxxxx ts:ISO-8601 conf:0.91 -->
```

`kind` ∈ `decision | constraint | preference | bug | architecture | todo | superseded`. Superseded lines carry `→ id:new` in the text and `by:new` in the comment. Audit adds `[stale?]` before the text and `stale:0.31` in the comment. Anything that is not a memory line (headings, prose) is preserved verbatim.

## Security

- Anything that looks like a credential (API keys, tokens, `password=…`, connection-string passwords, private key blocks, JWTs, long opaque blobs) is redacted **twice**: inside `decide`, `recall`, and `audit` when the state is built ([src/scrub.ts](src/scrub.ts)), and again in the Jev client right before the HTTP request. The writer LLM gets the scrubbed text too. A unit test pastes an OpenAI key, a GitHub token, a `password=`, and a connection-string password into a turn and asserts none of them reach the Jev caller.
- The warm daemon listens on a Unix socket inside `.jevmem/` with mode 0600 (a named pipe on Windows). It only ever runs the same hook code path, for the project it was started in.
- The injection guard noul refuses to save turns that contain instructions aimed at an automated system.
- Hooks always exit 0. A Jev timeout or error is logged to `.jevmem/log.jsonl` and the turn is skipped.

## Development

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm test         # vitest, Jev mocked
pnpm lint         # tsc --noEmit + eslint
JEVMEM_LIVE=1 pnpm test   # adds one real Jev test (needs TYPESAFE_API_KEY)
```

See [DEMO.md](DEMO.md) for a scripted 60-second demo and [DECISIONS.md](DECISIONS.md) for the design decisions.

## License

MIT
