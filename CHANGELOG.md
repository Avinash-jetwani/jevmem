# Changelog

All notable changes to Jevmem are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[0.1.1]: https://github.com/Avinash-jetwani/jevmem/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Avinash-jetwani/jevmem/releases/tag/v0.1.0
