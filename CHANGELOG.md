# Changelog

All notable changes to Jevmem are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.7] - 2026-09-23

### Changed
- Benchmark run for real: all four LLMs (GPT-5.6 Luna, Gemini 3.8 Flash, Claude Sonnet 5, Claude Fable 5.1, via OpenRouter) plus jevmem, same hour, same machine. Gemini 3.8 Flash and Claude Sonnet 5 tie jevmem on accuracy (100% save/skip, 98% save+kind); jevmem is 282 ms p50 vs 1.6–4.0 s and $0.000115 per decision vs $0.000166–$0.0118. README Benchmark table filled from `results/bench-2026-09-23.json`.
- Benchmark harness fixes found by the first run: 429/5xx retried with backoff (a new OpenRouter account's RPM limit had produced 52 failures), requests paced at 1/s, output cap raised from 200 to 4,000 tokens (reasoning models were being truncated to empty replies), and the first JSON object in a reply is extracted before schema validation. The first, contaminated run was not published.
- Jev's price is cited from TypeSafe's launch post (https://typesafe.ai/blog/introducing-system-one-models-and-jev, read 2026-09-23: $0.042 per million input tokens, output free) in the script, the results file and the README.
- Tagline is "Shared project memory for Claude Code, Cursor and Codex." everywhere (README, package description, CLI help, DEMO, GitHub About); "Jev decides, a model writes one line" lives in How Jev is used only.
- Under the eval table: the 50-turn set was written alongside jevmem and includes turns from bugs we fixed; treat it as a regression test, not an independent benchmark; the LLM comparison uses the same set for every model.

## [0.3.6] - 2026-09-23

### Added
- `scripts/bench-llm.mjs` + `bench/system-prompt.md`: the 50-turn eval set run through GPT-5.6 Luna, Gemini 3.8 Flash, Claude Sonnet 5 and Claude Fable 5.1 as the memory decider (identical state, same system prompt, strict JSON via structured output) and through jevmem `auto`, measuring save/skip and save+kind accuracy, contradiction id found, injection turns not saved, malformed-JSON rate, p50/p95 latency, and cost from real token usage × list price with the pricing URL and date recorded. Models without a key are skipped and reported, not estimated. Results in `results/bench-2026-09-23.json`; on that run only jevmem could be measured (100% save/skip, 98.0% save+kind, 2/2 contradictions, 4/4 injections blocked, 0% malformed, p50 266 ms, $0.000132 per decision) because no LLM key was present.
- `SECURITY.md`: what is sent to which API, what is stored locally, what is scrubbed, zero-retention routing, files written outside the project, and private vulnerability reporting. Shipped in the npm package.
- The eval set carries `contradicts` labels for its two contradiction turns.

### Changed
- README: data-flow disclosure under the tagline; a Benchmark section that replaces the Claude Haiku 4.5 estimate; every estimated number and the "40–400×" / "$0.005–0.05" / "2–10 s" style figures are gone; the injection claim says Jev has no text or tool output to hijack and that injected text can still bias probabilities; absolute wording ("never", "can't", "always") rewritten except where literally true and tested; "v0.3, built in launch week. Issues and feedback welcome." in Honest limits.
- Tagline is "Jev decides. The LLM writes one line." everywhere (README, package description, CLI help, DEMO).
- `init --tool codex` prints the file path, a backup path and the exact lines before appending to `~/.codex/config.toml`, and keeps the backup (tested).
- `package.json` ships `dist`, `README.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`; it has no install or postinstall scripts.

### Verified (2026-09-23)
- `scripts/e2e.sh --runs 3`: 3/3. `node scripts/eval.mjs`: fast 98.0%, auto 98.0% (10% escalation), full 100%, F1 100%; README and DEMO cite this run.

## [0.3.5] - 2026-09-23

### Changed (docs only)
- README: new opening (one memory file shared by Claude Code, Cursor and Codex; in git; every line explainable), "Built on Jev by TypeSafe AI", a launch-video placeholder, a "How this differs from Claude Code's built-in memory" section, an "Honest limits" section, one set of eval numbers everywhere (50-turn set: fast 98.0%, auto 98.0% at 12% escalation, full 100%, F1 100%), the LLM comparison restated as a labelled estimate (Claude Haiku 4.5 list price, same input, ~150 output tokens ≈ $0.004 and 1–3 s, ~30× Jevmem), and the injection claim reworded (Jev can't be made to write or run anything, but injected text can bias its probabilities, which the four injection nouls gate).
- DEMO: the "for real" section now shows the v0.3.4 harness run of the five demo prompts.

## [0.3.4] - 2026-09-23

### Fixed
- `jevmem <command> --help` / `-h` prints that command's help and exits 0 with no side effects; previously `jevmem init --help` ran init. Every subcommand has a help text and a test.
- `jevmem init --tool claude` registers the hooks in `.claude/settings.local.json` (per-machine, kept out of git by Claude Code) instead of `.claude/settings.json`, because the command carries absolute machine paths. A jevmem hook found in `settings.json` is moved to the local file and removed from the shared one; other hooks and settings there are untouched.
- The writer strips leading conversational filler ("Decision:", "Decided:", "Actually,", "So,", "OK,", "Also,", "Note:", …) from saved lines and keeps the rest verbatim, for both the LLM and the fallback path. Eval turns now carry `expectLine` checks for the fallback writer.

### Verified (2026-09-23)
- `scripts/e2e.sh --runs 3`: 3/3 passes with the hooks registered in `.claude/settings.local.json`; saved lines read "The extension ships as a sideload zip only…" and "We're submitting to the Chrome Web Store this week…" (filler gone), the sideload line is `[superseded] → id:new`, turns 4 and 5 leave the file unchanged.
- Eval (50 turns): full 100%, fast 96% (one run-to-run preference/constraint flip plus the known `Decision:`-prefixed constraint), fallback writer `expectLine` 5/5.

## [0.3.3] - 2026-09-22

### Fixed
- **The Stop hook saved the assistant's prose as memories.** In a real desktop session, lines like "Options I can pick up right away…", "Recorded. The distribution decision is back to…", and "One note from the hook output: Jev has now captured my last reply…" were written to `JEVMEM.md`, because `decide` and the writer both saw one merged "USER … ASSISTANT …" blob. Now the **user message is the state**. The assistant reply is sent to Jev only when the user asked a question (or when there is no user text at all), under its own `assistant_reply` key, and:
  - a new **meta** family (tier 1: `assistant_reply_is_meta`; tier 2: `assistant_lists_options_or_next_steps`, `assistant_summarises_its_own_work`, `assistant_comments_on_memory_hooks_or_tooling`) skips the turn when the reply is a menu, a self-summary, or commentary on memory/hooks/tooling (`thresholds.metaMax`, 0.5);
  - a `content_source` choice (`user_message` | `assistant_reply` | `both` | `none`) tells the policy where the content came from, and **only `bug` and `architecture` may come from the assistant**;
  - the writer condenses the source text (the user message, or the assistant reply only when `content_source` is `assistant_reply`), never the merged blob.
  - Every question now says "the user message" (or "the user message or the assistant reply" for bug/architecture) instead of "the message".
- Six real turns from that session are in the eval set with their exact assistant replies and the memory context they had (`existing` per turn): greeting, constraint, decision, reversal, "thanks, looks good" + hook commentary, and the injection attempt + memory commentary. 48 turns total.

### Added
- `scripts/e2e.sh`: a real multi-turn Claude Code session (`claude -p` / `--continue`) in a scratch project under the desktop app's stripped environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, no shell variables), sending the five demo prompts and asserting `JEVMEM.md` after each turn: +1 line, +1 decision, +1 decision with the previous one `[superseded]`, no change, no change. Fails loudly with the file and the relevant log entries. `--runs N`, `--automemory present|cleared|both` (seeds or clears Claude Code's own auto-memory for the scratch project under `~/.claude/projects/<slug>/memory/`), `CLAUDE_BIN` to pick the binary.
- `why` shows whether the assistant reply was in the state and the content source.

### Verified (real Claude Code 2.1.275 sessions, stripped environment, 2026-09-22)
- `scripts/e2e.sh --runs 3`: 3/3 passes. `--automemory both`: pass with Claude Code auto-memory seeded and pass with it cleared, identical files. Each run: turn 1 saves the constraint, turn 2 the sideload decision, turn 3 saves the Web Store decision and marks the sideload line `[superseded] … → id:new`, turns 4 and 5 leave the file unchanged. No assistant prose in any saved line. Per run: 6 `decide` calls (one escalation), ~$0.0009 in Jev.
- One harness finding: when a `claude -p` turn ends with `Error: Reached max turns`, Claude Code does not fire the Stop hook at all, so the harness allows up to 15 tool turns per prompt.

## [0.3.2] - 2026-09-22

### Fixed
- **Hooks never ran from the Claude Code desktop app.** Two causes, both confirmed against a real `claude` session with a stripped environment. (1) The registered command depended on PATH (`jevmem hook`, or `node "…/cli.js" hook`), and GUI apps on macOS inherit a bare `/usr/bin:/bin:/usr/sbin:/sbin` without nvm/volta/homebrew, so the hook process never started. `jevmem init` now registers `"<absolute node>" "<absolute cli.js>" hook`, and re-running `init` repairs an existing jevmem command in place. (2) Hooks get no shell profile, so `TYPESAFE_API_KEY` from `~/.zshenv` was invisible and the hook no-oped silently. The hook now falls back to `<project>/.jevmem/.env`, `~/.jevmem/env`, and `export VAR=…` lines in the user's shell profiles, reading only the jevmem-relevant variables.
- `UserPromptSubmit` sends the prompt as `user_prompt` on current Claude Code (`prompt` on 2.0.x); both are accepted. `Stop` sends no message text, only `transcript_path` (and `last_assistant_message` on newer versions); the turn is read from the transcript, with `last_assistant_message` as a fallback.
- No more silent failures: a missing key, an unreadable transcript, an empty turn, or any exception in the hook path is written to `.jevmem/log.jsonl` as a `hook` entry with the error. `JEVMEM_DEBUG=1` additionally appends every raw hook payload (plus PATH and whether the key was found) to `.jevmem/hook-debug.log`.
- The project root is `CLAUDE_PROJECT_DIR` when set (stable across worktrees), then the payload `cwd`.
- Writer lines are now up to 200 characters, cut only at word boundaries and never inside a URL; a URL that would straddle the limit is dropped whole, and a lone URL is kept intact.
- **Response-format instructions no longer read as injection.** In the real session, "…never bump engines above that. Acknowledge in one sentence, no tools." was escalated and then skipped with the injection family at 0.54. Every injection noul (both tiers) now carries a negative example of that phrasing ("Reply in one sentence, no tools", "Just acknowledge"), and the eval set has two such turns (42 turns total). Re-run: save/skip 97.6% in all three modes; save+kind 95.2% fast/auto and 97.6% full, the difference being one turn that starts with the word "Decision:" and states a must/never rule, which tier 1 files as `decision` and the label calls `constraint`.

### Real payloads observed (Claude Code CLI 2.0.30, 2026-09-22)
```text
UserPromptSubmit: session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt
Stop:             session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active
env:              PATH=/usr/bin:/bin:/usr/sbin:/sbin  CLAUDE_PROJECT_DIR=<project>  (no shell profile)
```

## [0.3.1] - 2026-09-22

### Changed
- **Two-tier decide.** Tier 1 (the nine broad nouls with one positive and one negative example each, plus `kind`, `touches_memory_id`, `importance`) runs on every turn. Tier 2 (the 30 atomic nouls) runs only when the borderline rule fires; its combined result then wins. `tiers.mode` = `auto` (default) | `fast` (tier 1 only) | `full` (always tier 2, v0.3.0 behaviour).
- **Borderline rule** under `tiers.borderline`: strongest kind noul in [0.3, 0.7] (`kindNoulScope: "max"`; `"any"` is available but fires on 80% of real turns), `kind` confidence < 0.6, `contradicts_existing_memory` ≥ 0.5, `importance` confidence < 0.5, injection noul in [0.3, 0.7]; never when tier 1 is already sure the turn is injection (> 0.7) or chit-chat (≥ 0.9).
- Tier 2 criteria trimmed from 2+2 to 1+1 examples per noul (`tiers.tier2ExamplesPerSide`); accuracy held at 97.5%, tokens fell from ~6,300 to ~5,500.
- `why` shows tier 1 answers, tier 2 answers when it ran, and the escalation reasons. Labels record both tiers; `fit` refits weights + `thresholds` from tier-2 labels and `tiers.tier1Thresholds` from tier-1 labels, and says how many labels went to each.
- Cache keys include the tier; log entries carry the tier; `jevmem stats` prints tier counts and the escalation rate.
- `scripts/eval.mjs` runs all three modes and prints accuracy, tokens/turn, cost/turn, p50/p95 latency, and escalation.

### Measured (live `jev-latest`, 2026-09-22, 40-turn eval set, warm client, no cache)
| mode | accuracy | F1 | tokens/turn | cost/turn | p50 | p95 | escalated |
|---|---|---|---|---|---|---|---|
| `fast` | 97.5% | 98.4% | 2,318 | $0.000097 | 263 ms | 340 ms | – |
| `auto` | 97.5% | 98.4% | 3,138 | $0.000132 | 267 ms | 560 ms | 15% |
| `full` (= v0.3.0) | 97.5% | 98.4% | 5,463 | $0.000229 | 264 ms | 301 ms | – |
| v0.2.0 | 97.5% | 98.4% | 1,897 | $0.000080 | ~272 ms | – | – |

Targets: accuracy ≥ 97.5% met; escalation ≤ 25% met (15%); cost ≤ 1.3× v0.2.0 **not met** (`auto` is 1.65×, `fast` 1.22×); tier-1 ≤ 2,000 tokens **not met** (2,318, of which roughly 500 are state and JSON framing). See DECISIONS.md.

## [0.3.0] - 2026-09-22

### Added
- **Decomposed question set.** `decide` now asks 30 atomic, literal nouls in nine families (decision, constraint, preference, bug, architecture, todo, chit_chat, injection, contradiction), every one with structured `what` / `examples` criteria on both outcomes, plus `kind` and `touches_memory_id` choices with `what` / `not_for` / `examples` per option and an `importance` score with `summary` / `what` / `signals` per level. 33 questions per call.
- **Combination in code** (`src/combine.ts`): a logistic score per family with hand-set default weights; `content = max` over the kind families gates saving. Weights live in `jevmem.config.json` under `weights`.
- **Feedback loop:** `jevmem why <id|hash>` prints every noul, family score, choice distribution, importance, and which threshold was cleared; `jevmem right`, `jevmem wrong [--should-be …]`, and `jevmem missed "<text>"` append labels (with the original Jev answers) to `.jevmem/labels.jsonl`; `jevmem fit` refits per-kind weights and `contentMin` / `importanceMin` / `chitChatMax` / `injectionMax` to maximise F1 on ≥ 40 labels and prints a reliability table; `JEVMEM.md` ends with `<!-- jevmem: N labels, last fit DATE -->`.
- **Answer cache** in `.jevmem/cache/` keyed by (model, state, questions); hits are logged with `cacheHit: true` and cost 0. `jevmem stats` shows p50/p95 latency, cost per day, cache hit rate, label count, and last fit.
- **Zero data retention:** `zeroDataRetention: true` is sent automatically when `TYPESAFE_BASE_URL` is a Vercel AI Gateway, or always with `jev.zeroDataRetention: true`.
- **Reach:** `jevmem init --tool claude|cursor|codex|claude-desktop|all` (default: detect). Cursor gets `.cursor/mcp.json` + `.cursor/rules/jevmem.mdc`; Codex gets an `AGENTS.md` section and a `[mcp_servers.jevmem]` entry in `~/.codex/config.toml` when present; Claude Desktop gets the exact config snippet printed. `jevmem watch` tails Codex's JSONL session rollouts for the current project and runs the same decide → write path per completed turn.
- `eval/transcript.jsonl` (40 hand-labelled turns) and `scripts/eval.mjs` to score any build's `decide` against it.
- PII scrubbing: email addresses and 16-digit numbers join the credential patterns.

### Changed
- `decide` sends only the current turn and the two before it; `recall` / `search` cap candidates at 60 (`jev.maxRecallCandidates`).
- Every decision (saved or skipped) is recorded in `.jevmem/decisions.jsonl` (bounded to the last 500).
- Recall's per-candidate noul and `none` option now use structured criteria.

### Measured (live `jev-latest`, 2026-09-22)
| | v0.2.0 | v0.3.0 |
|---|---|---|
| `decide` p50, warm daemon | ~230 ms | ~250–400 ms |
| `decide` p50, cold process | ~630 ms | ~860 ms |
| Tokens per `decide` | ~1,900 | ~6,300 |
| Cost per `decide` | $0.00008 | $0.00026 |
| Accuracy on the 40-turn set (save/skip + kind) | 97.5% | 97.5% (92.5% before weight tuning) |
| Cache hit rate | – | depends on repeats; 11% in the demo run |

The decomposed set **tied** the v0.2.0 set on this transcript at 3.3× the tokens. It is kept because it makes `why` and `fit` possible; see DECISIONS.md.

## [0.2.0] - 2026-09-22

### Added
- Warm daemon (`jevmem daemon`): the hook's first call in a project starts a small detached process that keeps the Jev client's connection open; later hook calls go through its local socket. Cuts the per-turn `decide` latency from ~630 ms (fresh process) to ~230 ms. Auto-started, exits after `daemon.idleMinutes` (30) of inactivity, disabled with `JEVMEM_DAEMON=0` or `daemon.enabled: false`.
- `jevmem daemon status|start|stop`.
- `HookOutcome.summary` and `HookOutcome.via` so callers can see cost, latency, and whether the daemon served the request.

### Changed
- Secrets are now scrubbed inside `decide`, `recall`, and `audit` when the state is built, in addition to the existing scrub in the Jev client. A test asserts a pasted key never reaches the Jev caller.
- `publishConfig.access: public` for npm.

## [0.1.1] - 2026-09-22

### Fixed
- The injection-guard noul was worded as "instructions aimed at an AI assistant", which live Jev (correctly, literally) answered *yes* for ordinary requests such as "Switch the primary store to Postgres 16" (0.78–0.86), so real decisions were skipped. It now asks whether the message tries to override, bypass, or rewrite an AI system's rules or plant text in its memory, with explicit true/false examples. Live probe: 0.02–0.05 on eleven normal turns, 0.89–0.99 on three injection attempts.
- The no-LLM fallback writer took the first sentence of the turn, which for a bug finding was the user's question. It now skips questions, prefers sentences with cue words for the memory kind, and prefers the assistant's text for `bug` and `architecture`.

## [0.1.0] - 2026-09-22

### Added
- `JEVMEM.md` memory store: one memory per line, `- [kind] text  <!-- id ts conf -->`, plus a gitignored `.jevmem/` index and cache.
- The decider (`src/decide.ts`): one Jev System One call per turn with nine nouls, a `kind` choice, a `touches_memory_id` choice, and an `importance` score. Configurable threshold policy in `jevmem.config.json`.
- The writer (`src/write.ts`): one cheap LLM call (OpenAI-compatible or Anthropic) that produces a single line of at most 140 characters, with a deterministic first-sentence fallback when no LLM key is present. Contradictions tag the old line `[superseded] … → id:new`.
- Claude Code integration: `jevmem init` registers `Stop` and `UserPromptSubmit` hooks. `Stop` runs decide → write; `UserPromptSubmit` injects the top five relevant memories chosen by a Jev `choice`.
- MCP server (`jevmem mcp`) exposing `search_memory`, `add_memory`, `list_memory`, and `audit_memory` over stdio.
- `jevmem audit`: re-scores every memory against a repository snapshot with one noul per line and flags `[stale?]` lines.
- Secret scrubbing before anything is sent to Jev or the writer.
- Per-call latency and cost logging to `.jevmem/log.jsonl`, summarised by `jevmem log` and by `JEVMEM_VERBOSE=1`.
- Vitest suite with a mocked Jev and an opt-in live test behind `JEVMEM_LIVE=1`.

[0.3.7]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Avinash-jetwani/jevmem/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Avinash-jetwani/jevmem/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Avinash-jetwani/jevmem/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Avinash-jetwani/jevmem/releases/tag/v0.1.0
