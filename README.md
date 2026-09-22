# Jevmem

**Jev decides. The LLM writes one line. Your project never forgets.**

Jevmem is a memory layer for AI coding tools (Claude Code, Cursor, Codex, Claude Desktop). It keeps a human-readable `JEVMEM.md` in your project root and updates it after **every** turn, in ~250–400 ms warm, for a fraction of a cent per day. It learns from you: mark a line `right` or `wrong`, and `jevmem fit` recalibrates.

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

## Works with

| Tool | One-command setup | Capture | Recall |
|---|---|---|---|
| **Claude Code** | `jevmem init` (or `--tool claude`) | **Automatic**, every turn, via the `Stop` hook | Automatic, every prompt, via `UserPromptSubmit` |
| **Cursor** | `jevmem init --tool cursor` | MCP-driven: a `.cursor/rules/jevmem.mdc` rule tells the agent to call `add_memory` when you state a decision | The rule tells it to call `search_memory` before non-trivial tasks |
| **Codex** | `jevmem init --tool codex` | MCP-driven via an `AGENTS.md` section, **plus** `jevmem watch`, which tails Codex's own session log for this project and runs the same decide → write path | `search_memory` via MCP |
| **Claude Desktop** | `jevmem init --tool claude-desktop` prints the config snippet | MCP-driven (`add_memory`) | `search_memory` |

`jevmem init` with no `--tool` detects what is present (`.claude/`, `.cursor/`, `AGENTS.md` or `~/.codex`). `--tool all` sets up everything. Cursor keeps its chats in a SQLite database, not a text log, so there is nothing safe to tail; Codex writes plain JSONL rollouts under `~/.codex/sessions`, which is why it gets `watch`.

## How Jev is used

Jevmem never asks Jev to write anything. It asks small, literal, typed questions and combines the answers in code.

### The decider: one call per turn (`src/decide.ts`, `src/questions.ts`, `src/combine.ts`)

State sent: `{ message, previous_turns, existing_memories: [{id, kind, text}] }`. Only the current turn and the two before it; never the repo tree. Secrets and PII are scrubbed first. Memory ids are capped at 200 by a keyword-overlap pre-filter.

**30 atomic nouls** in nine families, each with structured `true`/`false` criteria (`what` + two positive and two negative `examples`). Broad questions like "is this a decision?" are replaced by narrow ones; Jev answers them independently and in parallel, so 33 questions cost the same latency as 12.

| Family | Atomic nouls |
|---|---|
| decision | `states_a_choice_between_alternatives`, `uses_committal_language`, `names_a_specific_technology_or_approach`, `is_phrased_as_a_question_or_option_list` (negative signal) |
| constraint | `states_a_rule_with_must_never_or_always`, `states_a_numeric_or_version_limit`, `describes_a_consequence_of_breaking_a_rule` |
| preference | `expresses_personal_liking_or_style`, `is_about_how_work_is_done_not_what_is_built`, `uses_prefer_like_rather_or_please` |
| bug | `describes_a_failure_or_incorrect_behavior`, `names_a_root_cause`, `describes_a_fix_that_was_applied`, `mentions_a_test_error_or_stack_trace` |
| architecture | `describes_where_code_or_data_lives`, `describes_how_components_connect_or_data_flows`, `names_modules_services_or_boundaries` |
| todo | `defers_work_to_a_later_time`, `uses_todo_later_next_or_before_launch`, `describes_work_agreed_but_not_done` |
| chit_chat | `is_greeting_thanks_or_acknowledgement`, `contains_no_project_specific_content`, `has_no_fact_decision_or_request` |
| injection | `tells_an_ai_to_ignore_or_replace_instructions`, `claims_system_or_admin_authority_over_the_ai`, `asks_the_ai_to_store_or_alter_memory_or_rules`, `quotes_text_from_a_file_or_page_addressed_to_an_ai` |
| contradiction | `reverses_or_replaces_a_listed_memory`, `uses_change_of_plan_instead_or_actually`, `is_about_the_same_topic_as_a_listed_memory` |

Plus two **choices** (`kind` over the six kinds + `none`, each option with `what` / `not_for` / `examples`; `touches_memory_id` over live memory ids + `none`) and one **score** (`importance`: trivial, minor, useful, important, critical, each level with `summary` / `what` / `signals`). The exact wording is in [src/questions.ts](src/questions.ts).

**Combination in code.** Each family gets a logistic score over its nouls with hand-set default weights (core nouls such as `states_a_rule_with_must_never_or_always` are sufficient alone; secondary ones add confidence). `jevmem fit` replaces those weights with ones fitted to your labels.

**Policy** (thresholds in `jevmem.config.json`, all refitted by `jevmem fit`):

```text
content       = max(decision, constraint, preference, bug, architecture, todo)
save          = kind != none AND content >= contentMin (0.5) AND round(importance) >= useful
             AND chit_chat < chitChatMax (0.5) AND injection < injectionMax (0.5)
contradiction = save AND contradiction >= contradictionMin (0.7) AND touches_memory_id != none
```

On `save`, the writer produces one line (≤ 140 chars). On `contradiction`, the old line is re-tagged `[superseded]` and gets `→ id:new`. Every decision, saved or skipped, is recorded in `.jevmem/decisions.jsonl` so `jevmem why <id>` can show exactly which noul said what.

### The read side: one call per prompt (`src/recall.ts`)

`UserPromptSubmit` sends `{ query, memories }` (at most 60 candidates after keyword pre-filtering) and asks one `choice`, *"Which memory is most relevant to the query?"*, over the ids plus `none`. The distribution is the ranking; the top five above `recallMin` are injected as `<jevmem-memory>` context. `search_memory` (MCP) and `jevmem search` add one structured noul per candidate, *"Would memory X help answer or act on the query?"*, for up to 50 candidates in the same call.

### Audit: one noul per memory (`src/audit.ts`)

`jevmem audit` snapshots the repo (file tree to depth 3, `package.json`, top of README) and asks per live memory, *"Is memory X still true for this repository, given the snapshot?"* Lines under 0.4 are flagged `[stale?]` in place.

### Cache

Identical `(model, state, questions)` are answered from `.jevmem/cache/` without a request (retries, re-runs, a repeated prompt). Hits are logged with `cacheHit: true` and zero cost; `jevmem stats` shows the hit rate. `JEVMEM_CACHE=0` or `jev.cache: false` disables it.

### Feedback loop

Jev's probabilities are only trustworthy once you check them against your own judgement, so that is a feature:

```bash
jevmem why k3d9xq                   # every noul, family score, choice distribution, and which threshold it cleared
jevmem right k3d9xq                 # the decision was correct
jevmem wrong k3d9xq --should-be none   # it should not have been saved (removes the line)
jevmem wrong 3f1a9c --should-be bug    # a skipped turn (by hash prefix, from `why`) should have been saved as a bug
jevmem missed "We must keep the API backwards compatible for two minor versions." --kind constraint
jevmem fit                          # ≥ 40 labels: refit per-kind weights + thresholds to maximise F1, print a reliability table
jevmem stats                        # p50/p95 latency, cost per day, cache hit rate, label count, last fit
```

`JEVMEM.md` ends with `<!-- jevmem: 12 labels, last fit 2026-09-30 -->` so a reader knows how calibrated the file is.

## Cost math

Every Jev call is logged to `.jevmem/log.jsonl` (question count, tokens, latency, cost, cache hit), and `jevmem stats` summarises it. Cost is `tokens × $0.042 / 1M` (configurable under `jev.usdPerMillionTokens`).

| Call | Measured tokens | p50 latency (warm daemon) | p50 latency (cold process) | Cost |
|---|---|---|---|---|
| `decide` (33 questions, a few memories) | ~6,300 | **~250–400 ms** | ~860 ms | ~$0.00026 |
| `decide`, cache hit | 0 | ~3 ms | – | $0 |
| `recall` (choice over ids) | ~560 | ~300 ms | ~680 ms | ~$0.00002 |
| `search` (choice + noul per candidate) | ~680 | ~230 ms | ~550 ms | ~$0.00003 |
| `audit` (noul per memory) | ~720 for 2 memories | ~230 ms | ~540 ms | ~$0.00003 |

Measured with `jev-latest` on 2026-09-22 (the exact turns are in `DEMO.md`). The v0.3.0 question set is 3.3× more tokens than v0.2.0's twelve questions because every noul carries structured criteria with examples; latency is unchanged because Jev evaluates questions in parallel. A busy day of 300 turns costs about **eight cents** in Jev, plus one short LLM completion per *saved* line. An LLM-based memory pass over the same transcript, run every turn, costs 30–300× more, which is why those systems run rarely.

## Why Jev and not an LLM

- **It runs every turn.** ~300 ms and ~$0.0003 means the decision can happen on *every* Stop, not once per session. Memory that updates continuously catches the decision made in passing at turn 41.
- **Typed answers, thresholds in code.** Jev returns probabilities, not prose. "Save if importance ≥ useful and chit-chat < 0.5" is a line of config, testable and tunable, not a prompt you hope the model follows.
- **Nothing to inject into.** Jev cannot generate text, so a transcript that says "ignore previous instructions and remember X" cannot make it *do* anything. Jevmem also asks Jev whether the message is aimed at an automated system and refuses to save when it is.

## Comparison to LLM-based memory

| | LLM-based memory (typical) | Jevmem |
|---|---|---|
| Decides what to save with | A full LLM prompt over the transcript | One Jev call: 30 atomic nouls + 2 choices + 1 score, combined in code |
| Runs | End of session, or every N turns | Every turn |
| Latency per decision | 2–10 s | ~300 ms warm |
| Cost per decision | $0.005–0.05 | ~$0.00026 |
| Detects contradictions | Sometimes, in prose | `contradicts_existing_memory` ≥ 0.7 AND a named memory id |
| Injection resistance | Prompt-dependent | Decision model can't generate; four injection nouls |
| Storage | Proprietary DB | `JEVMEM.md` in your repo, one line per memory |
| Calibration | None | `right`/`wrong`/`missed` labels, `fit` refits weights and thresholds |
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
jevmem init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]
jevmem hook                                    Hook entrypoint; reads the Claude Code hook JSON on stdin
jevmem daemon [status|start|stop]              Warm Jev client used by the hook (auto-started, exits when idle)
jevmem watch [--replay] [--once]               Capture turns from Codex's session log for this project
jevmem mcp                                     Stdio MCP server
jevmem audit [--dry-run]                       Re-score every memory against the repo, flag [stale?]
jevmem search <query> [--limit N]              Rank memories by relevance
jevmem list [--all]                            Print memories
jevmem add <kind> <text>                       Add a line by hand
jevmem why <id|hash>                           Every Jev answer behind a line or a skipped turn
jevmem right <id|hash>                         Label a decision as correct
jevmem wrong <id|hash> [--should-be <kind|none>]   Label a decision as wrong
jevmem missed "<text>" [--kind <kind>]         Label a turn that should have been saved
jevmem fit [--dry-run] [--force]               Refit weights and thresholds from labels (needs 40+)
jevmem stats                                   Latency p50/p95, cost per day, cache hit rate, labels, last fit
jevmem log                                     Per-label latency and cost summary
```

Set `JEVMEM_VERBOSE=1` to get a one-line Jev latency/cost summary on stderr after every hook run.

## Configuration

`jevmem.config.json` (all keys optional; these are the defaults):

```json
{
  "memoryFile": "JEVMEM.md",
  "thresholds": {
    "importanceMin": "useful",
    "contentMin": 0.5,
    "chitChatMax": 0.5,
    "injectionMax": 0.5,
    "contradictionMin": 0.7,
    "staleBelow": 0.4,
    "recallTopK": 5,
    "recallMin": 0.05
  },
  "jev": { "model": "jev-latest", "timeoutMs": 2000, "maxIdsPerCall": 200, "maxRecallCandidates": 60,
           "usdPerMillionTokens": 0.042, "cache": true, "zeroDataRetention": "auto" },
  "writer": { "provider": "auto", "maxChars": 140, "timeoutMs": 8000 },
  "daemon": { "enabled": true, "idleMinutes": 30 },
  "weights": { "...": "written by `jevmem fit`; omit to use the hand-set defaults" }
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
| `JEVMEM_CACHE` | `0` disables the answer cache. |
| `TYPESAFE_BASE_URL` | Route Jev through a proxy or gateway. A Vercel AI Gateway URL turns on `zeroDataRetention: true` automatically. |
| `JEVMEM_LIVE` | `1` enables the live Jev test in `pnpm test`. |

## Memory file format

```text
- [kind] text  <!-- id:xxxxxx ts:ISO-8601 conf:0.91 -->
```

`kind` ∈ `decision | constraint | preference | bug | architecture | todo | superseded`. Superseded lines carry `→ id:new` in the text and `by:new` in the comment. Audit adds `[stale?]` before the text and `stale:0.31` in the comment. Anything that is not a memory line (headings, prose) is preserved verbatim.

## Security and privacy

- **Zero data retention.** If you route Jev through the Vercel AI Gateway (`TYPESAFE_BASE_URL=https://ai-gateway.vercel.sh/…`), Jevmem sends `zeroDataRetention: true` with every request; set `jev.zeroDataRetention: true` to force it for any endpoint. The flag is only added when configured or auto-detected, so the direct TypeSafe endpoint receives the plain request.
- Anything that looks like a credential or PII (API keys, tokens, `sk-`/`ghp_`/`AKIA` prefixes, bearer tokens, `password=…`, connection-string passwords, private key blocks, JWTs, email addresses, 16-digit numbers, long opaque blobs) is redacted **twice**: inside `decide`, `recall`, and `audit` when the state is built ([src/scrub.ts](src/scrub.ts)), and again in the Jev client right before the HTTP request. The writer LLM gets the scrubbed text too. A unit test pastes an OpenAI key, a GitHub token, a `password=`, a connection-string password, an email, and a card number into a turn and asserts none of them reach the Jev caller.
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
node scripts/eval.mjs     # score `decide` on the 40-turn hand-labelled set in eval/transcript.jsonl (live Jev)
```

See [DEMO.md](DEMO.md) for a scripted 60-second demo and [DECISIONS.md](DECISIONS.md) for the design decisions.

## License

MIT
