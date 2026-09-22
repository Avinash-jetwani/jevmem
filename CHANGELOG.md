# Changelog

All notable changes to Jevmem are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[0.3.1]: https://github.com/Avinash-jetwani/jevmem/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Avinash-jetwani/jevmem/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Avinash-jetwani/jevmem/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Avinash-jetwani/jevmem/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Avinash-jetwani/jevmem/releases/tag/v0.1.0
