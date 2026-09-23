# Jevmem

[![npm version](https://img.shields.io/npm/v/jevmem.svg)](https://www.npmjs.com/package/jevmem)
[![npm downloads](https://img.shields.io/npm/dm/jevmem.svg)](https://www.npmjs.com/package/jevmem)
[![license](https://img.shields.io/npm/l/jevmem.svg)](LICENSE)
[![node](https://img.shields.io/node/v/jevmem.svg)](package.json)

<!-- launch video here -->

**Jev decides. The LLM writes one line.**

Data flow, in one sentence: each prompt (and, when you asked a question, the assistant's reply) is sent to TypeSafe AI's API to be scored, secrets and PII are scrubbed before it leaves your machine, and zero-retention routing is available; details in [Security and privacy](#security-and-privacy) and [SECURITY.md](SECURITY.md).

```bash
npm install -g jevmem
```

Jevmem is **one memory file shared by Claude Code, Cursor and Codex.** `JEVMEM.md` lives in your repo, so the whole team gets the same decisions, constraints and root causes, reviewable in pull requests like any other file. Every line is explainable: `jevmem why <id>` shows the exact probabilities that put it there. A decision model scores each turn in ~270 ms for about a hundredth of a cent, so memory updates after **every** turn instead of once per session, and it learns from you: mark a line `right` or `wrong` and `jevmem fit` recalibrates.

Built on [Jev by TypeSafe AI](https://typesafe.ai), a System One decision model that returns typed probabilities and does not generate text. Jev decides **whether** a turn is worth remembering, **what kind** of memory it is, and **which existing memory it contradicts**; only then does a small LLM write one line.

**You need one key: `TYPESAFE_API_KEY`.** An OpenAI or Anthropic key is optional. Without one, Jevmem still saves memories; it just writes the line with a deterministic extract instead of an LLM.

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

`jevmem init` creates `JEVMEM.md`, `jevmem.config.json`, a gitignored `.jevmem/` cache, and registers two Claude Code hooks in `.claude/settings.local.json`. That file is per-machine and Claude Code keeps it out of git, which matters because the registered command uses the absolute paths of `node` and the CLI (Claude Code runs hooks without your shell profile and, from the desktop app, with a bare PATH). If you upgrade or move Node, run `jevmem init` again and it repairs the command in place; a jevmem hook found in the shared `.claude/settings.json` is moved to the local file. Every command accepts `--help`.

| Hook | What it does | Budget |
|---|---|---|
| `Stop` | Reads the turn that just finished, makes **one** Jev call, and writes one line if Jev says so. | Jev 2 s, writer 8 s; exits 0 on any failure (tested) |
| `UserPromptSubmit` | Makes **one** Jev call to pick the five memories most relevant to your prompt and injects them as context. | Jev 2 s |

That's it. Keep working. `JEVMEM.md` fills itself, and it's a normal file: edit it, commit it, review it in PRs.

Without an LLM key Jevmem still works: the writer falls back to the most relevant sentence of the turn, trimmed to 200 characters at a word boundary, not inside a URL (tested). Without `TYPESAFE_API_KEY` the hooks no-op and say so in `.jevmem/log.jsonl`.

**Where the hook finds your key.** Claude Code hooks (and MCP servers started by Cursor, Codex, or Claude Desktop) do not load your shell profile. Jevmem therefore looks for `TYPESAFE_API_KEY` (and the optional writer keys) in this order: the process environment, `<project>/.jevmem/.env`, `~/.jevmem/env`, then `export TYPESAFE_API_KEY=…` lines in `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.profile`. Only those named variables are read. If you'd rather it not read your profiles, put the key in `~/.jevmem/env`.

The first hook call in a project starts a tiny **warm daemon** (`jevmem daemon status` to see it) that keeps the Jev client's TLS connection open, so every later turn skips connection setup. It exits after 30 idle minutes and is off with `JEVMEM_DAEMON=0`.

## Works with

| Tool | One-command setup | Capture | Recall |
|---|---|---|---|
| **Claude Code** | `jevmem init` (or `--tool claude`) | **Automatic**, every turn, via the `Stop` hook | Automatic, every prompt, via `UserPromptSubmit` |
| **Cursor** | `jevmem init --tool cursor` | MCP-driven: a `.cursor/rules/jevmem.mdc` rule tells the agent to call `add_memory` when you state a decision | The rule tells it to call `search_memory` before non-trivial tasks |
| **Codex** | `jevmem init --tool codex` | MCP-driven via an `AGENTS.md` section, **plus** `jevmem watch`, which tails Codex's own session log for this project and runs the same decide → write path | `search_memory` via MCP |
| **Claude Desktop** | `jevmem init --tool claude-desktop` prints the config snippet | MCP-driven (`add_memory`) | `search_memory` |

`jevmem init` with no `--tool` detects what is present (`.claude/`, `.cursor/`, `AGENTS.md` or `~/.codex`). `--tool all` sets up everything. Cursor keeps its chats in a SQLite database, not a text log, so there is nothing safe to tail; Codex writes plain JSONL rollouts under `~/.codex/sessions`, which is why it gets `watch`.

## How this differs from Claude Code's built-in memory

Claude Code (and Cursor, and Codex) each keep their own memory, and it works well inside that tool. Jevmem is not a replacement for it; it is the layer that the tools and the team share.

| | Built-in memory | Jevmem |
|---|---|---|
| Scope | Per tool, per machine (Claude Code's lives under `~/.claude/projects/…`) | One `JEVMEM.md` per repo, read by Claude Code, Cursor, Codex and Claude Desktop |
| Shared with the team | No | Yes, it's a file in git; reviewed in PRs like code |
| Why a line exists | Opaque; the model decided | Per-line scores: `jevmem why <id>` shows every noul, the kind distribution, importance, and which threshold it cleared |
| What happens on a reversal | The old note is rewritten or lost | The old line stays, tagged `[superseded] … → id:new`, so history and blame survive |
| Corrections | Edit the note | `right` / `wrong` / `missed` labels, and `fit` refits the thresholds to your judgement |

Both can run at once; the end-to-end harness checks that Jevmem behaves the same with Claude Code's auto-memory present or cleared.

## How Jev is used

Jevmem does not ask Jev to write anything. It asks small, literal, typed questions and combines the answers in code.

### The decider: two tiers (`src/decide.ts`, `src/questions.ts`, `src/combine.ts`)

State sent: `{ user_message, assistant_reply?, previous_turns, existing_memories: [{id, kind, text}] }`. **The user message is the memory.** The assistant reply is included only when the user asked a question or reported a bug (or when there is no user text), and then only a `bug` or `architecture` fact may come from it; a `meta` family skips replies that are menus of options, "Recorded…" self-summaries, or commentary on memory, hooks, or tooling. Only the current turn and the two before it are sent; the repo tree is not part of the decide state (it is sent by `jevmem audit` only). Secrets and PII are scrubbed first. Memory ids are capped at 200 by a keyword-overlap pre-filter.

**Tier 1 runs on every turn**: nine broad nouls, each with one positive and one negative example, plus the `kind` choice, the `touches_memory_id` choice, and the `importance` score. About 2,300 tokens.

| Tier-1 noul | Family |
|---|---|
| `contains_decision` | decision |
| `contains_constraint` | constraint |
| `contains_preference` | preference |
| `contains_bug_finding` | bug |
| `contains_architecture_fact` | architecture |
| `contains_todo` | todo |
| `is_only_chit_chat` | chit_chat |
| `contradicts_existing_memory` | contradiction |
| `contains_instructions_aimed_at_an_automated_system` | injection |

**Tier 2 runs only when tier 1 is unsure**: 30 atomic nouls in the same nine families, each with structured `what` / `examples` criteria, combined in code with a logistic score per family. About 5,500 tokens. The borderline rule (configurable under `tiers.borderline`) escalates when:

- the strongest kind noul is in `[0.3, 0.7]` (set `kindNoulScope: "any"` to test every kind noul; that fires on most real turns because secondary kinds often score 0.3–0.7), or
- the `kind` choice confidence is under 0.6, or
- `contradicts_existing_memory` ≥ 0.5, or
- the `importance` confidence is under 0.5, or
- the injection noul is in `[0.3, 0.7]`,

**unless** tier 1 is already sure the turn is skipped (injection > 0.7 or chit-chat ≥ 0.9), where tier 2 could only agree. When tier 2 runs, its result wins.

`tiers.mode` selects `auto` (default), `fast` (tier 1 only), or `full` (always tier 2). Measured with `node scripts/eval.mjs` on the 50-turn hand-labelled set in `eval/transcript.jsonl` (live `jev-latest`, warm client, no cache, 2026-09-23):

| mode | accuracy (save/skip + kind) | F1 (save/skip) | tokens/turn | cost/turn | p50 | escalated |
|---|---|---|---|---|---|---|
| `fast` | 98.0% | 100% | 2,454 | $0.000103 | 263 ms | – |
| `auto` (default) | 98.0% | 100% | 3,032 | $0.000127 | 270 ms | 10% |
| `full` | 100% | 100% | 5,764 | $0.000242 | 276 ms | – |

The set has 8 decisions, 5 constraints, 4 preferences, 5 bugs, 4 architecture facts, 4 todos, 4 chit-chat, 3 questions, 3 injection attempts, 4 format-instruction turns, and 6 turns lifted verbatim from a real Claude Code desktop session with their assistant replies and memory context. The one miss in `fast`/`auto` is a turn that begins with "Decision:" but states a must/never rule; tier 1 calls it a decision, the label says constraint; save/skip is right on every turn in every mode. These are the numbers used everywhere in this README.

| Tier-2 family | Atomic nouls |
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
| meta (only with the assistant reply) | `assistant_lists_options_or_next_steps`, `assistant_summarises_its_own_work`, `assistant_comments_on_memory_hooks_or_tooling` |

With the assistant reply in the state, a `content_source` choice (`user_message` | `assistant_reply` | `both` | `none`) is added, and tier 1 asks one broad `assistant_reply_is_meta` noul. The exact wording of every question is in [src/questions.ts](src/questions.ts).

**Policy** (thresholds in `jevmem.config.json`; `thresholds` applies to tier 2, `tiers.tier1Thresholds` overrides for tier-1 finals; both refitted by `jevmem fit`):

```text
content       = max(decision, constraint, preference, bug, architecture, todo)   # tier 1: the broad noul; tier 2: the logistic family score
save          = kind != none AND content >= contentMin (0.5) AND round(importance) >= useful
             AND chit_chat < chitChatMax (0.5) AND injection < injectionMax (0.5)
             AND NOT (source == assistant_reply AND (meta >= metaMax (0.5) OR kind ∉ {bug, architecture}))
contradiction = save AND contradiction >= contradictionMin (0.7) AND touches_memory_id != none
```

On `save`, the writer produces one line (≤ 200 chars, cut at a word boundary, not inside a URL, with leading filler such as "Decision:", "Actually,", "So," or "OK," stripped). On `contradiction`, the old line is re-tagged `[superseded]` and gets `→ id:new`. Every decision, saved or skipped, is recorded in `.jevmem/decisions.jsonl` with both tiers' answers, so `jevmem why <id>` shows tier 1, and tier 2 if it ran, and which borderline condition caused the escalation.

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

`fit` uses whichever tier's answers a label carries: labels with tier-2 answers refit the family weights and `thresholds`; labels with tier-1 answers refit `tiers.tier1Thresholds`. The fit output says how many labels went to each. `JEVMEM.md` ends with `<!-- jevmem: 12 labels, last fit 2026-09-30 -->` so a reader knows how calibrated the file is.

## Cost math

Every Jev call is logged to `.jevmem/log.jsonl` (question count, tier, tokens, latency, cost, cache hit), and `jevmem stats` summarises it, including the tier-1 → tier-2 escalation rate. Cost is `tokens × $0.042 / 1M` (configurable under `jev.usdPerMillionTokens`).

| Call | Measured tokens | p50 latency (warm daemon) | p50 latency (cold process) | Cost |
|---|---|---|---|---|
| `decide` tier 1 (12 questions) | ~2,450 | **~260 ms** | ~670 ms | ~$0.00010 |
| `decide` tier 2 (33 questions), on ~10% of turns | ~5,760 | ~280 ms | – | ~$0.00024 |
| `decide` in `auto`, averaged | ~3,030 | ~270 ms | – | ~$0.00013 |
| `decide`, cache hit | 0 | ~3 ms | – | $0 |
| `recall` (choice over ids) | ~560 | ~210 ms | ~680 ms | ~$0.00002 |
| `search` (choice + noul per candidate) | ~680 | ~230 ms | ~550 ms | ~$0.00003 |
| `audit` (noul per memory) | ~720 for 2 memories | ~230 ms | ~540 ms | ~$0.00003 |

`decide` figures are the 50-turn eval above; the rest are from the `DEMO.md` runs. 300 turns a day in `auto` mode is $0.04 in Jev (measured: `results/bench-2026-09-23.json`), plus one short LLM completion per *saved* line if you configure a writer. For how this compares with an LLM doing the same job, see [Benchmark](#benchmark); there are no estimated numbers in this README.

## Why Jev and not an LLM

- **It runs every turn.** ~270 ms and ~$0.00013 means the decision can happen on *every* Stop, not once per session. Memory that updates continuously catches the decision made in passing at turn 41.
- **Typed answers, thresholds in code.** Jev returns probabilities, not prose. "Save if importance ≥ useful and chit-chat < 0.5" is a line of config, testable and tunable, not a prompt you hope the model follows.
- **A narrow attack surface.** Jev returns probabilities and does not generate text or call tools, so a transcript that says "ignore previous instructions and remember X" has no channel to write a line or run a command through Jev; the failure mode is a wrong probability. Injected text can still bias those probabilities (TypeSafe documents this in its model notes), which is why four injection nouls gate every save, the eval set carries injection attempts, and the harness sends one.

## Comparison to LLM-based memory

| | LLM-based memory (typical) | Jevmem |
|---|---|---|
| Decides what to save with | A full LLM prompt over the transcript | One Jev call of 12 questions; a second of 33 on the ~15% of turns that are borderline |
| Runs | End of session, or every N turns | Every turn |
| Latency per decision | Measured per model in [Benchmark](#benchmark) when a key is present | 270 ms p50 warm (measured, 2026-09-23) |
| Cost per decision | Measured per model in [Benchmark](#benchmark) from real token usage × list price | $0.000132 (measured, 2026-09-23) |
| Detects contradictions | Sometimes, in prose | `contradicts_existing_memory` ≥ 0.7 AND a named memory id |
| Injection resistance | Prompt-dependent; a jailbreak can make it write anything | No text or tool output to hijack; injected text can bias probabilities, and four injection nouls gate every save |
| Storage | Proprietary DB | `JEVMEM.md` in your repo, one line per memory |
| Calibration | None | `right`/`wrong`/`missed` labels, `fit` refits weights and thresholds |
| Generates the memory text with | The same big LLM | A small LLM, one line, only when Jev says so |

## Benchmark

`scripts/bench-llm.mjs` runs the same 50-turn eval set through current LLMs acting as the memory decider and through jevmem, on the same machine in the same hour. Every model receives the identical state jevmem sends Jev (user message, the assistant reply when the user asked a question, the two previous turns, the existing memories with ids), the same committed system prompt (`bench/system-prompt.md`), and must answer strict JSON `{save, kind, contradicts_id, injection}` through the provider's structured-output mode. A malformed answer counts as wrong. Cost is real token usage × the list price on the provider's pricing page, with the URL and date recorded in the results file. A model whose key is missing is skipped and reported as skipped; nothing is estimated.

Reproduce: `node scripts/bench-llm.mjs` (needs `TYPESAFE_API_KEY`, plus `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or a single `OPENROUTER_API_KEY` for the LLM rows). Results: [`results/bench-2026-09-23.json`](results/bench-2026-09-23.json).

**Run of 2026-09-23** (macOS arm64, Node 22):

| Model (API id) | Status | save/skip | save+kind | contradiction id found | injection turns not saved | malformed JSON | p50 | p95 | $/decision | $/300 turns |
|---|---|---|---|---|---|---|---|---|---|---|
| GPT-5.6 Luna (`gpt-5.6-luna`) | skipped: no `OPENAI_API_KEY` in the benchmark environment | | | | | | | | | |
| Gemini 3.8 Flash (`gemini-3.8-flash`) | skipped: no `GEMINI_API_KEY` | | | | | | | | | |
| Claude Sonnet 5 (`claude-sonnet-5`) | skipped: no `ANTHROPIC_API_KEY` | | | | | | | | | |
| Claude Fable 5.1 (`claude-fable-5-1`) | skipped: no `ANTHROPIC_API_KEY` | | | | | | | | | |
| jevmem `auto` (`jev-latest`) | ran | 100% | 98.0% | 2/2 | 4/4 | 0% | 266 ms | 521 ms | $0.000132 | $0.040 |

The LLM rows are empty because the machine that produced this release had no LLM provider key, and this project does not publish numbers it did not measure. The script, the prompt, the schema and the pricing sources are all in the repo; run it with a key and the table fills in. If any LLM beats jevmem on accuracy when it does, that will be shown here as it comes out. The claim this project makes is speed, cost and explainability at comparable accuracy, not "better than every model".

Pricing sources recorded in the results file (all read 2026-09-23): OpenAI `https://developers.openai.com/api/docs/pricing` (Luna $0.20 in / $1.20 out per million), Google `https://ai.google.dev/gemini-api/docs/pricing` (Gemini 3.8 Flash $0.75 / $3.75 through 2026-12-31), Anthropic `https://platform.claude.com/docs/en/about-claude/pricing` (Sonnet 5 $2 / $10, Fable 5.1 $10 / $50), Jev $0.042 per million as configured in `jevmem.config.json` (TypeSafe AI publishes no public pricing page as of this date).

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
jevmem stats                                   Latency p50/p95, cost per day, cache hit rate, escalation rate, labels, last fit
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
  "writer": { "provider": "auto", "maxChars": 200, "timeoutMs": 8000 },
  "daemon": { "enabled": true, "idleMinutes": 30 },
  "tiers": {
    "mode": "auto",
    "borderline": { "kindNoulScope": "max", "kindNoulLow": 0.3, "kindNoulHigh": 0.7, "kindConfidenceMin": 0.6,
                    "contradictionMin": 0.5, "importanceConfidenceMin": 0.5, "injectionLow": 0.3, "injectionHigh": 0.7,
                    "sureSkipChitChatMin": 0.9 },
    "tier2ExamplesPerSide": 1,
    "tier1Thresholds": { "...": "written by `jevmem fit` from tier-1 labels; omit to use `thresholds`" }
  },
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
| `JEVMEM_DEBUG` | `1` appends every raw hook payload (and whether the key was found) to `.jevmem/hook-debug.log`. Set it under `"env"` in `.claude/settings.local.json` to debug the desktop app. |
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
- Hooks always exit 0 (tested) and do not emit a `block` decision, so they do not make Claude continue or loop. A missing key, an unreadable transcript, a Jev timeout, or any exception is logged to `.jevmem/log.jsonl` as a `hook` entry (tested).
- Commands that write outside the project (`init --tool codex`, which registers the MCP server in `~/.codex/config.toml`) print the file path, a backup path, and the exact lines they will add before writing, and keep the backup.

### What the hooks actually receive

Observed on Claude Code CLI 2.0.30. `Stop` carries **no message text**; jevmem reads the last user and assistant turn from `transcript_path` (JSONL). Newer versions add `last_assistant_message` and rename `prompt` to `user_prompt`; both shapes are handled.

```json
{"session_id":"…","transcript_path":"~/.claude/projects/<slug>/<session>.jsonl","cwd":"/your/project","permission_mode":"default","hook_event_name":"Stop","stop_hook_active":false}
{"session_id":"…","transcript_path":"…","cwd":"/your/project","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"your prompt text"}
```

## Honest limits

- **Early.** This is v0.3. The eval set is 50 hand-labelled turns, mostly written by the author, plus six from one real session. Expect rough edges and file issues.
- **Recall's effect on answer quality is not measured yet.** The read side injects the top five relevant lines per prompt; that it picks the right lines is tested, that Claude answers better because of them is not.
- **Long-run noise is not measured yet.** The harness covers five-turn sessions. How much drift a `JEVMEM.md` accumulates over weeks of real use, and how often `audit` and `wrong` are needed, is unknown.
- **Cursor capture is MCP-driven, not automatic.** Cursor has no per-turn hook and no text transcript on disk, so it saves memories only when the agent follows the rule and calls `add_memory`. Claude Code is the only tool with automatic per-turn capture; Codex gets it via `jevmem watch`.
- v0.3, built in launch week. Issues and feedback welcome.

## Development

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm test         # vitest, Jev mocked
pnpm lint         # tsc --noEmit + eslint
JEVMEM_LIVE=1 pnpm test   # adds one real Jev test (needs TYPESAFE_API_KEY)
node scripts/eval.mjs     # score `decide` in fast/auto/full on the 50-turn hand-labelled set (live Jev); the source of every number in this README
scripts/e2e.sh --runs 3 --automemory both   # REAL multi-turn Claude Code session under the desktop app's stripped env (needs a logged-in `claude`)
```

See [DEMO.md](DEMO.md) for a scripted 60-second demo and [DECISIONS.md](DECISIONS.md) for the design decisions.

## License

MIT
