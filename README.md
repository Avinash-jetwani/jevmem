# jevmem

One memory file for Claude Code, Cursor and Codex, kept in your git repo.

After each message, jevmem asks TypeSafe's Jev whether it's worth remembering.
If yes, it writes one line to JEVMEM.md. You can read, edit and review every line.

Data flow, in one sentence: each prompt (and, for questions and anything that looks like a bug report, the assistant's reply) is sent to TypeSafe AI's API to be scored; common credential shapes, email addresses and 16-digit numbers are redacted before it leaves your machine (best effort; [SECURITY.md](SECURITY.md) lists exactly what is and is not caught), and an opt-in zero-retention request flag is available (see [SECURITY.md](SECURITY.md#zero-data-retention) for what it does and does not guarantee).

[![npm version](https://img.shields.io/npm/v/jevmem.svg)](https://www.npmjs.com/package/jevmem)
[![npm downloads](https://img.shields.io/npm/dm/jevmem.svg)](https://www.npmjs.com/package/jevmem)
[![license](https://img.shields.io/npm/l/jevmem.svg)](LICENSE)
[![node](https://img.shields.io/node/v/jevmem.svg)](package.json)

<!-- launch video here -->

```bash
npm install -g jevmem
```

Claude Code captures automatically on every turn; Cursor and Codex capture through MCP when the agent follows the installed rule, and Codex can also be tailed with `jevmem watch`. Because `JEVMEM.md` is in git, the whole team reviews the same decisions, constraints and root causes in pull requests. Every line saved by the hook on your machine is explainable: `jevmem why <id>` shows the probabilities that put it there (decisions are kept locally in `.jevmem/`, not in git). Jev's median decision took 341 ms in our held-out benchmark, for $0.000143 per message; through a real `Stop` hook process handing the turn to the warm daemon it is 786 ms end to end. That is fast and cheap enough to run on **every** message. It is not the most accurate option: on our held-out set every LLM we measured scored higher on save+kind ([Benchmark](#benchmark)). Mark a line `right` or `wrong` and, after 40 labels, `jevmem fit` retunes the weights and thresholds.

Built on [Jev by TypeSafe AI](https://typesafe.ai), a System One decision model that, per TypeSafe, returns typed probabilities rather than free text ([launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). Jev decides **whether** a turn is worth remembering, **what kind** of memory it is, and **which existing memory it contradicts**; only then does a small LLM write one line.

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
jevmem init --tool claude
```

`jevmem init` creates `JEVMEM.md`, `jevmem.config.json`, a gitignored `.jevmem/` folder, and registers two Claude Code hooks in `.claude/settings.local.json` (per-machine; `jevmem init` adds it to `.gitignore`, and creates a `.gitignore` in a git repository that has none). The file is per-machine because the registered command uses the absolute paths of `node` and the CLI (Claude Code runs hooks without your shell profile and, from the desktop app, with a bare PATH). If you upgrade or move Node, run `jevmem init` again and it repairs the command in place; a jevmem hook found in the shared `.claude/settings.json` is moved to the local file. Every command accepts `--help`.

With no `--tool`, `init` sets up whatever it finds **in the project** (`.claude/`, `.cursor/`, `AGENTS.md`), and Claude Code when it finds nothing. It never looks at your home directory, and it edits `~/.codex/config.toml` only when you pass `--tool codex` or `--tool all`.

| Hook | What it does | Budget |
|---|---|---|
| `Stop` | Reads the turn that just finished, makes one Jev call (two on borderline turns: 14–24% of turns in our evals), and writes one line if Jev says so. | Jev 2 s per call, writer 8 s; exits 0 on any failure (tested by spawning the built CLI) |
| `UserPromptSubmit` | Makes one Jev call to pick the five memories most relevant to your prompt and injects them as context. | Jev 2 s |

That's it. Keep working. `JEVMEM.md` fills itself, and it's a normal file: edit it, commit it, review it in PRs.

Without an LLM key Jevmem still works: the writer falls back to the most relevant sentence of the turn, trimmed to 200 characters at a word boundary, not inside a URL (tested). Without `TYPESAFE_API_KEY` the hooks no-op and say so in `.jevmem/log.jsonl`.

**Where the hook finds your key.** Claude Code hooks (and MCP servers started by Cursor, Codex, or Claude Desktop) do not load your shell profile. Jevmem therefore looks for `TYPESAFE_API_KEY` (and the optional writer keys) in this order: the process environment, `<project>/.jevmem/.env`, `~/.jevmem/env`, then `export TYPESAFE_API_KEY=…` lines in `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.profile`. Only those named variables are read. If you'd rather it not read your profiles, put the key in `~/.jevmem/env`.

The first hook call in a project starts a small **warm daemon** (`jevmem daemon status` to see it) that keeps the Jev client's connection open. It exits after 30 idle minutes and is off with `JEVMEM_DAEMON=0`. Measured end to end, including Node start-up for the hook process, it saves a little per turn (`Stop` 786 ms against 937 ms cold; `UserPromptSubmit` 427 ms against 495 ms; [Cost math](#cost-math)).

## Works with

What is automatic and what depends on the agent:

| Tool | Setup | Capture | Recall |
|---|---|---|---|
| **Claude Code** | `jevmem init --tool claude` | **Automatic**, every turn, via the `Stop` hook | **Automatic**, every prompt, via `UserPromptSubmit` |
| **Codex** | `jevmem init --tool codex` | **Automatic while `jevmem watch` runs** (it tails Codex's session log for this project and runs the same decide → write path); otherwise agent-initiated via MCP `add_memory`, prompted by an `AGENTS.md` section | Agent-initiated: `search_memory` via MCP, prompted by `AGENTS.md` |
| **Cursor** | `jevmem init --tool cursor` | Agent-initiated: a `.cursor/rules/jevmem.mdc` rule tells the agent to call MCP `add_memory` when you state a decision. Nothing is captured if it doesn't | Agent-initiated: the rule tells it to call `search_memory` before non-trivial tasks |
| **Claude Desktop** | `jevmem init --tool claude-desktop` prints a config snippet to paste (one project per config, named with `--root`) | Manual: ask it to call `add_memory` (no hook, no rule file) | On request: `search_memory` |

MCP `add_memory` goes through the same gate as the hook: the line is scrubbed, Jev scores it, and it is refused with a reason if it reads as instructions aimed at an AI, is small talk, or duplicates a live line. `--tool all` sets up everything. Cursor keeps its chats in a SQLite database, not a text log, so there is nothing safe to tail; Codex writes plain JSONL rollouts under `~/.codex/sessions`, which is why it gets `watch`.

## How this differs from the tools' own memory

Each tool has two kinds of built-in memory, and Jevmem is not a replacement for either; it is the layer that the tools and the team share.

| | Built-in auto-memory (e.g. Claude Code's under `~/.claude/projects/…`) | Project instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`) | Jevmem |
|---|---|---|---|
| Scope | Per tool, per machine | Per tool, per repo | One `JEVMEM.md` per repo, read by Claude Code, Cursor, Codex and Claude Desktop |
| Shared with the team | No | Yes, committed files reviewed in PRs | Yes, a committed file reviewed in PRs |
| Who keeps it current | The tool, when it decides to | You, by hand | Jevmem, after every Claude Code turn (and Codex turns under `watch`, and agent `add_memory` calls) |
| Why a line exists | The model decided | You wrote it | Per-line scores on the machine that saved it: `jevmem why <id>` shows every noul, the kind distribution, importance, and which threshold it cleared |
| What happens on a reversal | The old note is overwritten | You edit it (history if the file is in git) | The old line stays, tagged `[superseded] … → id:new`, so history and blame survive |
| Corrections | Edit the note | Edit the file | `right` / `wrong` / `missed` labels, and `fit` retunes the thresholds to your judgement |

The instruction files are shareable today; Jevmem's difference is that it **maintains** its file automatically and **scores** each line. Both can run at once; the end-to-end harness checks that Jevmem behaves the same with Claude Code's auto-memory present or cleared.

## How Jev is used

Jev decides, a model writes one line. Jevmem does not ask Jev to write anything; it asks small, literal, typed questions and combines the answers in code, and only when the answer is "save" does a small LLM (or a deterministic extract) write the line.

### The decider: two tiers (`src/decide.ts`, `src/questions.ts`, `src/combine.ts`)

State sent: `{ user_message, assistant_reply?, previous_turns, existing_memories: [{id, kind, text}] }`. **The user message is the memory.** The assistant reply is included only when a keyword heuristic (`looksLikeQuestion`) sees a question or investigation request (a `?`, or an opening word such as why/how/what/do/is/will/can/explain/debug), or bug-report vocabulary (error, fails, broken, crash, flaky, stale, wrong, slow, timeout, bug, regression, leak, a `…Error` name, or an HTTP-context 4xx/5xx such as "returns 500"), or when there is no user text. The heuristic is deliberately broad ("Use Sentry for error reporting." counts) and it also misses bug reports worded without that vocabulary ("sift panics on files with a UTF-8 BOM"). When the reply is included, only a `bug` or `architecture` fact may come from it; a `meta` family skips replies that are menus of options, "Recorded…" self-summaries, or commentary on memory, hooks, or tooling. Only the current turn and the two before it are sent; the repo tree is not part of the decide state (it is sent by `jevmem audit` only). Secrets are scrubbed first. Memory ids are capped at 200 by a keyword-overlap pre-filter.

**Tier 1 runs on every turn**: nine broad nouls, each with one positive and one negative example, plus the `kind` choice, the `touches_memory_id` choice, and the `importance` score. 2,143–2,259 input tokens per call in our evals.

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

**Tier 2 runs only when tier 1 is unsure**: 30 atomic nouls in the same nine families, each with structured `what` / `examples` criteria, combined in code with a logistic score per family. 4,892–5,017 input tokens per call in our evals. The borderline rule (configurable under `tiers.borderline`) escalates when:

- the strongest kind noul is in `[0.3, 0.7]` (set `kindNoulScope: "any"` to test every kind noul; that fires on most real turns because secondary kinds often score 0.3–0.7), or
- the `kind` choice confidence is under 0.6, or
- `contradicts_existing_memory` ≥ 0.5, or
- the `importance` confidence is under 0.5, or
- the injection family is in `[0.3, 0.7]`,

**unless** tier 1 is already sure the turn is skipped (injection > 0.7 or chit-chat ≥ 0.9), where tier 2 could only agree. When tier 2 runs, its result wins.

`tiers.mode` selects `auto` (default), `fast` (tier 1 only), or `full` (always tier 2). Measured with `node scripts/eval.mjs` (live `jev-latest`, warm in-process client, no cache, v0.4.1, 2026-09-23). Save/skip, kind, contradictions and injection are all scored; cost is input tokens × $0.042 per million (Jev output tokens are free).

**Held-out set** ([`eval/heldout.jsonl`](eval/heldout.jsonl), 66 turns written for v0.4.0 and committed before any model was run on them; a test fails if any turn shares text with `src/questions.ts` or the regression set). Results: [`results/eval-heldout-2026-09-23-v041.json`](results/eval-heldout-2026-09-23-v041.json).

| mode | save/skip | save/skip + kind | F1 (save/skip) | input tokens/turn | cost/turn | p50 | p95 | escalated | contradictions | injection not saved |
|---|---|---|---|---|---|---|---|---|---|---|
| `fast` | 98.5% | 95.5% | 98.9% | 2,259 | $0.000095 | 288 ms | 634 ms | – | 5/5 | 6/6 |
| `auto` (default) | 95.5% | 92.4% | 96.8% | 3,475 | $0.000146 | 306 ms | 600 ms | 24.2% | 3/5 | 6/6 |
| `full` | 89.4% | 87.9% | 92.1% | 5,017 | $0.000211 | 293 ms | 425 ms | – | 3/5 | 6/6 |

On the held-out set tier 2 makes things worse: `full` is below `fast`, and `auto` loses both reversal-of-a-constraint turns that `fast` catches. We have not retuned against these turns (that would make the set no longer held out).

**Regression set** ([`eval/transcript.jsonl`](eval/transcript.jsonl), the original 50 turns). Results: [`results/eval-regression-2026-09-23-v041.json`](results/eval-regression-2026-09-23-v041.json).

| mode | save/skip | save/skip + kind | F1 (save/skip) | input tokens/turn | cost/turn | p50 | p95 | escalated | contradictions | injection not saved |
|---|---|---|---|---|---|---|---|---|---|---|
| `fast` | 100.0% | 98.0% | 100.0% | 2,143 | $0.000090 | 302 ms | 425 ms | – | 2/2 | 4/4 |
| `auto` (default) | 100.0% | 100.0% | 100.0% | 2,825 | $0.000119 | 293 ms | 647 ms | 14.0% | 2/2 | 4/4 |
| `full` | 100.0% | 100.0% | 100.0% | 4,892 | $0.000205 | 335 ms | 409 ms | – | 2/2 | 4/4 |

This 50-turn set was written alongside jevmem, and 33 of its 50 turns share text with the examples inside jevmem's own Jev questions (`src/questions.ts`; the count is pinned by `test/heldout.test.ts`), while the LLMs in the Benchmark get a zero-shot prompt. Treat it as a regression test, not a benchmark. It has 8 decisions, 5 constraints, 4 preferences, 5 bugs, 4 architecture facts, 4 todos, 4 chit-chat, 3 questions, 3 injection attempts, 4 format-instruction turns, and 6 turns lifted verbatim from a real Claude Code desktop session (one of which is a fourth injection turn). The one miss in `fast` is a turn that begins with "Decision:" but states a must/never rule. Differences of one or two turns are within run-to-run noise: the same `auto` mode scored 100.0% save+kind on the regression set in the eval run and 98.0% in the benchmark run.

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

On `save`, the writer produces one line (≤ 200 chars, cut at a word boundary, not inside a URL, with leading filler such as "Decision:", "Actually,", "So," or "OK," stripped). On `contradiction`, the old line is re-tagged `[superseded]` and gets `→ id:new`. Every decision, saved or skipped, is recorded in `.jevmem/decisions.jsonl` with both tiers' answers and which writer produced the line, so `jevmem why <id>` shows tier 1, and tier 2 if it ran, and which borderline condition caused the escalation.

### The read side: one call per prompt (`src/recall.ts`)

`UserPromptSubmit` sends `{ query, memories }` (at most 60 candidates after keyword pre-filtering) and asks one `choice`, *"Which memory is most relevant to the query?"*, over the ids plus `none`. The distribution is the ranking; the top five above `recallMin` are injected as `<jevmem-memory>` context. `search_memory` (MCP) and `jevmem search` add one structured noul per candidate, *"Would memory X help answer or act on the query?"*, for up to 50 candidates in the same call.

### Audit: one noul per memory (`src/audit.ts`)

`jevmem audit` snapshots the repo (file tree to depth 3, `package.json`, top of README) and asks per live memory, *"Is memory X still true for this repository, given the snapshot?"* Lines under 0.4 are flagged `[stale?]` in place.

### Cache

Identical `(model, tier, state, questions)` are answered from `.jevmem/cache/` without a request (retries, re-runs, a repeated prompt). Hits are logged with `cacheHit: true` and zero cost; `jevmem stats` shows the hit rate. `JEVMEM_CACHE=0` or `jev.cache: false` disables it.

### Feedback loop

Jev's probabilities are only worth trusting once you check them against your own judgement, so that is a feature:

```bash
jevmem why k3d9xq                   # every noul, family score, choice distribution, and which threshold it cleared
jevmem right k3d9xq                 # the decision was correct
jevmem wrong k3d9xq --should-be none   # it should not have been saved (removes the line)
jevmem wrong 3f1a9c --should-be bug    # a skipped turn (by hash prefix, from `why`) should have been saved as a bug
jevmem missed "We must keep the API backwards compatible for two minor versions." --kind constraint
jevmem fit                          # ≥ 40 labels: refit per-kind weights + thresholds to maximise F1, print a reliability table
jevmem stats                        # p50/p95 latency, cost per day, cache hit rate, escalation rate, label count, last fit
```

`fit` retunes; it does not calibrate Jev's probabilities. It uses whichever tier's answers a label carries: labels with tier-2 answers refit the family weights and `thresholds`; labels with tier-1 answers refit `tiers.tier1Thresholds`. The fit output says how many labels went to each. `JEVMEM.md` ends with a footer such as `<!-- jevmem: 52 labels, last fit 2026-09-22 -->` so a reader knows how much the thresholds have been tuned. `why` works on the machine that saved the line: the decision log is local (`.jevmem/`, not in git) and keeps the most recent 500–1,000 decisions, and lines added with `jevmem add` have no decision behind them.

## Cost math

Every Jev call is logged to `.jevmem/log.jsonl` (question count, tier, tokens, latency, cost, cache hit), and `jevmem stats` summarises it, including the tier-1 → tier-2 escalation rate. Cost is **input tokens × $0.042 / 1M**; output tokens are free per TypeSafe's launch post (configurable under `jev.usdPerMillionTokens`). The same method is used by `jevmem stats`, `scripts/eval.mjs` and `scripts/bench-llm.mjs`.

| Call | Input tokens | p50 in-process, warm | p50 as a real process (hook or CLI) | Cost per call |
|---|---|---|---|---|
| `decide` tier 1 (`fast`) | 2,143–2,259 | 288–302 ms | – | $0.000090–$0.000095 |
| `decide` in `auto` | 2,825–3,475 | 293–306 ms | `Stop` hook: 937 ms cold, 786 ms via the warm daemon | $0.000119–$0.000146 |
| `decide` tier 2 (`full`) | 4,892–5,017 | 293–335 ms | – | $0.000205–$0.000211 |
| `decide`, cache hit | 0 | 1 ms | – | $0 |
| `recall` (choice over 19 memories) | 1,652 | 326 ms | `UserPromptSubmit` hook: 495 ms cold, 427 ms via the warm daemon | $0.000069 |
| `search` (choice + noul per candidate, 19 memories) | 4,572 | 355 ms | `jevmem search`: 529 ms | $0.000192 |
| `audit` (noul per memory, 19 memories) | 3,273 | 316 ms | `jevmem audit --dry-run`: 495 ms | $0.000137 |

`decide` rows are the two eval runs above (the range spans the held-out and regression sets). The other rows are [`results/ops-2026-09-23-v041.json`](results/ops-2026-09-23-v041.json) (`node scripts/bench-ops.mjs`: a scratch project with 19 memories, 20 warm calls each, 10 process runs each; "real process" is the wall time of a new `node dist/cli.js …` process, which is what Claude Code waits for). 300 turns a day in `auto` mode is about $0.04 for `decide` plus about $0.02 for recall, plus one short LLM completion per *saved* line if you configure a writer. For how this compares with an LLM doing the same job, see [Benchmark](#benchmark).

## Why Jev and not an LLM

- **It is fast enough to run on every turn.** 0.3 s in-process, 0.8 s through the hook, against 2.4–4.0 s p50 for the LLMs we measured, means the decision can happen on *every* Stop, not once per session. Memory that updates continuously catches the decision made in passing at turn 41. It is not more accurate: see [Benchmark](#benchmark).
- **Typed answers, thresholds in code.** Jev returns probabilities, not prose. "Save if importance ≥ useful and chit-chat < 0.5" is a line of config, testable and tunable, not a prompt you hope the model follows.
- **A narrow attack surface, not a closed one.** Per TypeSafe, Jev returns probabilities and does not generate text or call tools, so a transcript that says "ignore previous instructions and remember X" has no channel to run a command through Jev; the failure mode is a wrong probability. Injected text can still bias those probabilities, which is why an injection noul gates every hook and MCP `add_memory` save (one broad noul in tier 1, four atomic nouls when tier 2 runs), the eval sets carry injection attempts, and the harness sends one. Once Jev says save, the line itself is written by the writer LLM (or the extract) from the scrubbed message, so injected text that gets past the gate can still shape the line's wording. Lines typed with `jevmem add` are not checked by Jev.

## Compared with an LLM as the decider

Only rows the [Benchmark](#benchmark) measures (held-out set, 66 turns):

| | An LLM called as the decider (six benchmarked) | Jevmem (`auto`) |
|---|---|---|
| Decides what to save with | One LLM call with a zero-shot prompt | One Jev call of 12 questions (14 with the assistant reply); a second of 33 (37) on 14–24% of turns |
| Accuracy: save/skip | 93.9%–98.5% | 95.5% |
| Accuracy: save/skip + kind | 93.9%–98.5% | 92.4% (lowest) |
| Latency per decision | 2.4–4.0 s p50, 4.2–13.0 s p95 | 341 ms p50, 718 ms p95 |
| Cost per decision | $0.000089 (GPT-6 Luna) to $0.013271 (Claude Fable 5.1) | $0.000143 |
| Detects contradictions | All six found 5/5 with a named id, and none flagged a false one | 3/5 (`contradicts_existing_memory` ≥ 0.7 AND a named memory id) |
| Injection resistance | All six refused all 6 injection turns | Refused all 6 injection turns |

## Benchmark

`scripts/bench-llm.mjs` runs an eval set through six current LLMs acting as the memory decider and through jevmem. Every decider receives the identical state, built by the same function jevmem's `decide` uses (`buildDecideState`): the user message, the assistant reply when jevmem's heuristic would include it, the previous turns when the turn has them, and the existing memories with ids. The LLMs get the committed zero-shot system prompt ([`bench/system-prompt.md`](bench/system-prompt.md)) and must answer strict JSON `{save, kind, contradicts_id, injection}` through the provider's structured-output mode; the text from the first `{` to the last `}` is validated against the schema, and a malformed answer counts as wrong. jevmem gets its own Jev questions, which contain few-shot examples. Cost is real token usage × the list price on the provider's pricing page (URLs and dates in the results file); jevmem's is input tokens × $0.042/M.

**How it was run.** 2026-09-23, macOS arm64, Node 22. The six LLMs were called through OpenRouter's chat-completions endpoint with one key, at each provider's default reasoning setting (a lower-reasoning or non-reasoning configuration was not tested and would likely narrow the latency gap), with a 4,000-token output cap. jevmem was called directly to TypeSafe's API. Every decider made one unscored warm-up call first, and all seven ran concurrently, so they share one time window: held-out 14:35–14:42 UTC, regression 14:42–14:48 UTC (v0.4.1, commit `bd6951b`). Retries (429/5xx, up to 6 with backoff, included in latency) are counted per row, and the OpenRouter upstream host is recorded per model. Reproduce with `node scripts/bench-llm.mjs --set heldout` (needs `TYPESAFE_API_KEY` plus `OPENROUTER_API_KEY`, or the providers' own keys).

### Held-out set (66 turns, written for v0.4.0, no shared text with jevmem's prompts)

Results: [`results/bench-heldout-2026-09-23-v041.json`](results/bench-heldout-2026-09-23-v041.json).

| Model (API id) | save/skip | save/skip + kind | contradiction id found | false contradictions | injection turns not saved | malformed | p50 | p95 | $/decision | $/300 turns | retries |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GPT-6 Astra (`gpt-6-astra`) | 98.5% (65/66) | 98.5% (65/66) | 5/5 | 0 | 6/6 | 0 | 2,922 ms | 4,236 ms | $0.007489 | $2.247 | 0 |
| GPT-6 Luna (`gpt-6-luna`) | 93.9% (62/66) | 93.9% (62/66) | 5/5 | 0 | 6/6 | 0 | 2,448 ms | 6,293 ms | $0.000089 | $0.027 | 0 |
| Claude Fable 5.1 (`claude-fable-5-1`) | 97.0% (64/66) | 97.0% (64/66) | 5/5 | 0 | 6/6 | 0 | 4,005 ms | 9,248 ms | $0.013271 | $3.981 | 0 |
| Claude Opus 5.5 (`claude-opus-5-5`) | 97.0% (64/66) | 97.0% (64/66) | 5/5 | 0 | 6/6 | 0 | 2,861 ms | 6,767 ms | $0.005187 | $1.556 | 0 |
| Gemini 3.8 Flash (`gemini-3.8-flash`) | 93.9% (62/66) | 93.9% (62/66) | 5/5 | 0 | 6/6 | 0 | 3,274 ms | 12,973 ms | $0.001304 | $0.391 | 0 |
| Grok 4.7 (`grok-4.7`) | 95.5% (63/66) | 95.5% (63/66) | 5/5 | 0 | 6/6 | 0 | 2,935 ms | 9,624 ms | $0.004854 | $1.456 | 0 |
| **jevmem `auto`** (`jev-latest`) | 95.5% (63/66) | **92.4% (61/66)** | **3/5** | 0 | 6/6 | 0 | **341 ms** | **718 ms** | $0.000143 | $0.043 | 0 |

#### How it compares

On 66 held-out turns, jevmem's median decision took 0.34 s, against 2.4–4.0 s for six current LLMs.
It was less accurate on save+kind: 92.4%, against 93.9–98.5% for the LLMs. On save/skip it scored 95.5% (LLMs 93.9–98.5%). It found 3/5 contradictions; every LLM found 5/5.
GPT-6 Luna was both cheaper and more accurate on save+kind (lower on save/skip), but about 7× slower.
If accuracy matters most, an LLM decider is better. jevmem is for when you want a fast, cheap decision on every message.

On the held-out set `--mode fast` scored higher than `auto`. We'll confirm on a fresh set before changing the default.

- **Where the misses are.** Six of the seven got a turn I labelled a preference wrong ("Write doc comments on every public function…": five LLMs skipped it, jevmem filed it as a todo), which suggests the label is debatable; it was not changed after the run. GPT-6 Luna, Claude Fable 5.1, Gemini 3.8 Flash and Grok 4.7 each skipped one to three bug reports whose wording the state heuristic does not recognise ("…panics on…", "…are empty after…", "…grows without bound…"), so no decider saw the assistant's diagnosis; jevmem saved all three from the user message. That is a limit of jevmem's state design, which every model inherits here. "no, leave it as is" (declining a proposal) was saved as a decision by jevmem, GPT-6 Astra, GPT-6 Luna and Claude Opus 5.5. jevmem's other misses: one decision filed as architecture and the two constraint reversals, which `auto` skips and `fast` saves.

### Regression set (the original 50 turns; contaminated, see above)

Results: [`results/bench-regression-2026-09-23-v041.json`](results/bench-regression-2026-09-23-v041.json).

| Model (API id) | save/skip | save/skip + kind | contradiction id found | false contradictions | injection turns not saved | malformed | p50 | p95 | $/decision | $/300 turns | retries |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GPT-6 Astra (`gpt-6-astra`) | 98.0% (49/50) | 96.0% (48/50) | 2/2 | 1 | 4/4 | 0 | 2,855 ms | 5,711 ms | $0.007371 | $2.211 | 0 |
| GPT-6 Luna (`gpt-6-luna`) | 98.0% (49/50) | 96.0% (48/50) | 2/2 | 2 | 4/4 | 0 | 2,766 ms | 4,685 ms | $0.000084 | $0.025 | 0 |
| Claude Fable 5.1 (`claude-fable-5-1`) | 96.0% (48/50) | 94.0% (47/50) | 2/2 | 0 | 3/4 | 1 | 4,066 ms | 11,179 ms | $0.011846 | $3.554 | 0 |
| Claude Opus 5.5 (`claude-opus-5-5`) | 98.0% (49/50) | 96.0% (48/50) | 2/2 | 0 | 4/4 | 0 | 2,812 ms | 5,501 ms | $0.004846 | $1.454 | 0 |
| Gemini 3.8 Flash (`gemini-3.8-flash`) | 98.0% (49/50) | 96.0% (48/50) | 2/2 | 0 | 4/4 | 1 | 2,852 ms | 13,204 ms | $0.000958 | $0.288 | 0 |
| Grok 4.7 (`grok-4.7`) | 100.0% (50/50) | 98.0% (49/50) | 2/2 | 1 | 4/4 | 0 | 3,365 ms | 21,286 ms | $0.005046 | $1.514 | 0 |
| jevmem `auto` (`jev-latest`) | 100.0% (50/50) | 98.0% (49/50) | 2/2 | 0 | 4/4 | 0 | 334 ms | 721 ms | $0.000115 | $0.034 | 0 |

On this set jevmem and Grok 4.7 score highest (50/50 and 49/50); every other LLM is one or two turns behind; GPT-6 Luna is cheaper ($0.000084 against $0.000115). Because 33 of these 50 turns share text with jevmem's own few-shot examples and the LLMs see none, this table says jevmem still passes its regression tests, not that it beats the LLMs. The "false contradictions" column counts contradiction ids named on turns that contradict nothing; the "contradiction id found" column counts only true positives. The two malformed answers are Claude Fable 5.1 returning invalid JSON on an injection turn and Gemini 3.8 Flash returning zero output tokens on a question turn.

Pricing sources recorded in the results files (all read 2026-09-23): OpenAI `https://developers.openai.com/api/docs/pricing` (Astra $10 in / $50 out per million, Luna $0.1 / $0.5, standard tier), Anthropic `https://platform.claude.com/docs/en/about-claude/pricing` (Fable 5.1 $10 / $50, Opus 5.5 $4 / $20), Google `https://ai.google.dev/gemini-api/docs/pricing` (Gemini 3.8 Flash $0.75 / $3.75 through 2026-12-31), xAI `https://docs.x.ai/docs/models` (Grok 4.7 $2 / $6; OpenRouter listed $1.6 / $4.8 that day and the higher list price is used), Jev $0.042 per million input tokens, output free, from TypeSafe's launch post `https://typesafe.ai/blog/introducing-system-one-models-and-jev`.

## MCP server

`jevmem mcp` starts a stdio MCP server with four tools:

| Tool | Args | Jev calls |
|---|---|---|
| `search_memory` | `query`, `limit?` | 1 (choice over ids + noul per candidate) |
| `add_memory` | `text`, `kind` | 1, or 2 on a borderline line (the hook's decide: scrub, then refuse injection / small talk / duplicates; Jev may correct the kind; a contradiction supersedes the old line) |
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

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Claude Desktop does not inherit your shell and has no project directory, so name the project with `--root` and give the key explicitly. One config entry serves one project:

```json
{
  "mcpServers": {
    "jevmem": {
      "command": "npx",
      "args": ["-y", "jevmem", "mcp", "--root", "/absolute/path/to/your-project"],
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

`jevmem init --tool codex` writes this section without the `env` line; the server then reads the key from `~/.jevmem/env` or your shell profile. Or from the CLI: `codex mcp add jevmem -- npx -y jevmem mcp`.

### Claude Code (as an MCP server, in addition to the hooks)

```bash
claude mcp add jevmem -- npx -y jevmem mcp
```

The server reads `JEVMEM.md` from its working directory, or from `--root <dir>` / `JEVMEM_ROOT` when given.

## CLI

```text
jevmem init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]
jevmem hook                                    Hook entrypoint; reads the Claude Code hook JSON on stdin
jevmem daemon [status|start|stop]              Warm Jev client used by the hook (auto-started, exits when idle)
jevmem watch [--replay] [--once]               Capture turns from Codex's session log for this project
jevmem mcp [--root <dir>]                      Stdio MCP server
jevmem audit [--dry-run]                       Re-score every memory against the repo, flag [stale?]
jevmem search <query> [--limit N]              Rank memories by relevance
jevmem list [--all]                            Print memories
jevmem add <kind> <text>                       Add a line by hand (secrets scrubbed; no Jev check)
jevmem why <id|hash>                           Every Jev answer behind a line or a skipped turn
jevmem right <id|hash>                         Label a decision as correct
jevmem wrong <id|hash> [--should-be <kind|none>]   Label a decision as wrong
jevmem missed "<text>" [--kind <kind>]         Label a turn that should have been saved
jevmem fit [--dry-run] [--force]               Refit weights and thresholds from labels (needs 40+)
jevmem stats                                   Latency p50/p95, cost per day, cache hit rate, escalation rate, labels, last fit
jevmem log                                     Per-label latency, token and cost summary of .jevmem/log.jsonl
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
    "metaMax": 0.5,
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

`usdPerMillionTokens` is applied to input tokens only.

Environment:

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Jev. Required for decisions, recall, search, audit and MCP `add_memory`. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | The one-line writer. Auto-detected; first one present wins. |
| `JEVMEM_WRITER` | `openai`, `anthropic`, or `none` to force a provider. |
| `JEVMEM_WRITER_MODEL` | Override the model (defaults: `gpt-5-mini` with minimal reasoning, `claude-haiku-4-5-20251001`). |
| `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter…). |
| `JEVMEM_VERBOSE` | `1` prints the Jev latency/cost line after each hook run. |
| `JEVMEM_DEBUG` | `1` appends every raw hook payload (and whether the key was found) to `.jevmem/hook-debug.log`. Set it under `"env"` in `.claude/settings.local.json` to debug the desktop app. |
| `JEVMEM_DAEMON` | `0` disables the warm daemon (hook runs inline), `1` forces it on. |
| `JEVMEM_CACHE` | `0` disables the answer cache. |
| `JEVMEM_ROOT` | Project root for `jevmem mcp` when the client has no working directory (same as `--root`). |
| `TYPESAFE_BASE_URL` | Route Jev through a proxy or gateway. A Vercel AI Gateway URL adds the `zeroDataRetention: true` request field automatically. |
| `JEVMEM_LIVE` | `1` enables the live Jev test in `pnpm test`. |

## Memory file format

```text
- [kind] text  <!-- id:xxxxxx ts:ISO-8601 conf:0.91 -->
```

`kind` ∈ `decision | constraint | preference | bug | architecture | todo | superseded`. Superseded lines carry `→ id:new` in the text and `by:new` in the comment. Audit adds `[stale?]` before the text and `stale:0.31` in the comment. Anything that is not a memory line (headings, prose) is preserved verbatim.

## Security and privacy

- **Retention.** Jevmem can add a `zeroDataRetention: true` field to each Jev request (automatic for Vercel AI Gateway base URLs, or forced with `jev.zeroDataRetention: true`). Whether any retention guarantee applies depends on the gateway and on TypeSafe AI's own terms; Jevmem does not verify it, and the direct TypeSafe endpoint's retention is governed by TypeSafe's policy.
- **Redaction.** Common credential shapes and some PII are redacted before text reaches Jev or the writer: `sk-`/`ghp_`/`github_pat_`/`xox*`/`AKIA`/`AIza`/`npm_`/`hf_`/`glpat-`/Stripe keys, JWTs, bearer tokens, env-style `*_PASSWORD=` / `*_SECRET=` / `*_TOKEN=` / `*_KEY=` of any length, `password=` / `pwd=` / `pass:` of any length, connection-string passwords, private key blocks, email addresses, 16-digit numbers, and 48+ character opaque blobs. It happens twice: inside `decide`, `recall`, `audit` and MCP `add_memory` when the state is built ([src/scrub.ts](src/scrub.ts)), and again in the Jev client right before the HTTP request. Names, phone numbers, addresses and other formats are **not** caught; [SECURITY.md](SECURITY.md#what-is-scrubbed) has the full list and [test/scrub.test.ts](test/scrub.test.ts) the cases. `jevmem add` and `jevmem missed` scrub too; text you edit into `JEVMEM.md` by hand is written as typed.
- **Injection gate.** An injection noul gates every hook save and every MCP `add_memory` line: one broad noul in tier 1, and four atomic injection nouls in tier 2 when it runs. Lines typed with `jevmem add` are not checked by Jev.
- **The warm daemon** listens on a Unix socket with mode 0600 (in `.jevmem/`, or the system temp dir for very long paths; a named pipe on Windows) and only runs the hook code path.
- **Hooks always exit 0** and do not emit a `block` decision, so they do not make Claude continue or loop. A test spawns the built CLI with invalid JSON, no key, a broken transcript, a missing transcript and an unreachable Jev, and asserts exit code 0. A missing key, an unreadable transcript, a Jev timeout, or any exception is logged to `.jevmem/log.jsonl` as a `hook` entry (the missing-key and unreachable-Jev cases are asserted).
- **Files outside the project.** Only `init --tool codex` / `--tool all` write outside the project (the MCP section in `~/.codex/config.toml`); they print the file path, a backup path, and the exact lines before writing, and keep the backup. Plain `init` never touches your home directory.

### What the hooks actually receive

Observed on Claude Code CLI 2.0.30. `Stop` carries **no message text**; jevmem reads the last user and assistant turn from `transcript_path` (JSONL). Some newer versions document `last_assistant_message` and `user_prompt`; both shapes are handled.

```json
{"session_id":"…","transcript_path":"~/.claude/projects/<slug>/<session>.jsonl","cwd":"/your/project","permission_mode":"default","hook_event_name":"Stop","stop_hook_active":false}
{"session_id":"…","transcript_path":"…","cwd":"/your/project","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"your prompt text"}
```

## Honest limits

- **Early.** This is v0.4.1. The held-out set is 66 turns hand-labelled by one person (the author), across three invented projects; the regression set is 50 turns, 33 of which overlap jevmem's own prompt examples. Neither is an independent benchmark. Expect rough edges and file issues.
- **Not the most accurate decider.** On the held-out set every LLM we measured scored higher on save+kind, and GPT-6 Luna is also cheaper; jevmem's advantage is latency.
- **Recall's effect on answer quality is not measured.** The read side injects the top five relevant lines per prompt; that the plumbing injects Jev's top picks is tested with a mock, and one opt-in live test checks a two-memory ranking. Selection quality on real memory files, and whether Claude answers better because of it, are not measured.
- **Long-run noise is not measured.** The harness covers five-turn sessions. How much drift a `JEVMEM.md` accumulates over weeks of real use, and how often `audit` and `wrong` are needed, is unknown.
- **Only Claude Code (and Codex under `watch`) capture automatically.** Cursor and Claude Desktop save memories only when the agent calls `add_memory`.

## Development

```bash
pnpm install
pnpm build        # tsup → dist/
pnpm test         # vitest, Jev mocked (includes spawning dist/cli.js for the exit-code tests)
pnpm lint         # tsc --noEmit + eslint
JEVMEM_LIVE=1 pnpm test   # adds one real Jev test (needs TYPESAFE_API_KEY)
node scripts/eval.mjs --set heldout --out results/eval-heldout-$(date +%F).json   # score `decide` in fast/auto/full (live Jev); also --set regression
node scripts/bench-llm.mjs --set heldout   # the Benchmark tables (needs TYPESAFE_API_KEY + OPENROUTER_API_KEY)
node scripts/bench-ops.mjs                 # the non-decide rows of the Cost math table
node scripts/check-claims.mjs              # fails if a number in the docs is not in a results file listed in results/CURRENT.json (runs in CI)
scripts/e2e.sh --runs 3 --automemory both   # REAL multi-turn Claude Code session under the desktop app's stripped env (needs a logged-in `claude`)
```

See [DEMO.md](DEMO.md) for a scripted 60-second demo, [DECISIONS.md](DECISIONS.md) for the design decisions, and [results/README.md](results/README.md) for what each results file is.

## License

MIT
