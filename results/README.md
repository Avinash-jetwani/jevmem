# Results

Every measured number in the docs comes from a file listed in [`CURRENT.json`](CURRENT.json); `node scripts/check-claims.mjs` (run in CI) fails if a doc number has no source here.

| File | Produced by | What it is |
|---|---|---|
| `bench-heldout-2026-09-23-v041.json` | `node scripts/bench-llm.mjs --set heldout` | v0.4.1. Six LLMs + jevmem `auto` as the memory decider on `eval/heldout.jsonl` (66 turns). Same state for all, one warm-up call each, all seven concurrently (14:35–14:42 UTC), retries per row, network path and OpenRouter upstream host per model |
| `bench-regression-2026-09-23-v041.json` | `node scripts/bench-llm.mjs --set regression` | v0.4.1. The same on `eval/transcript.jsonl` (50 turns), 14:42–14:48 UTC |
| `eval-heldout-2026-09-23-v041.json`, `eval-regression-2026-09-23-v041.json` | `node scripts/eval.mjs --set … --out …` | v0.4.1. jevmem `decide` in `fast` / `auto` / `full`, every row's answer and reason |
| `ops-2026-09-23-v041.json` | `node scripts/bench-ops.mjs` | v0.4.1. recall / search / audit warm, cache hit, cold processes, hook processes through the warm daemon |
| `demo-2026-09-23-v041.txt` | the DEMO.md scripted steps | v0.4.1. Captured CLI output (home directory replaced with `~`) |
| `e2e-2026-09-23-v041.txt` | `scripts/e2e.sh --runs 3` | v0.4.1. Real Claude Code 2.1.280 session, all three runs passed (paths replaced with `~` / `<scratch>`) |
| `bench-*-2026-09-23.json`, `eval-*-2026-09-23.json`, `ops-2026-09-23.json`, `demo-2026-09-23.txt`, `e2e-2026-09-23.txt` (no suffix) | v0.4.0 | History: the same runs on v0.4.0, whose tier 1 also asked the four atomic injection nouls. Not cited by the v0.4.1 docs |
| `a5-tier1-injection/` | `node scripts/eval.mjs --modes fast,auto` | History: tier 1 with one injection noul vs five, the measurement behind the v0.4.1 revert |
| `bench-2026-09-23.json`, `bench-2026-09-23-r2.json` | v0.3.7 / v0.3.8 | History. The LLMs got `previous_turns: null`, ran cold, and the eval set overlaps jevmem's prompt examples |

Notes on provenance:

- The v0.4.1 files record `commit bd6951b` with a clean `src/`. A first v0.4.1 benchmark run (14:03–14:28 UTC) was discarded: its regression half hit OpenRouter's key credit limit (HTTP 402) for four LLMs. Both sets were re-run back to back after the limit was raised; the files here are that re-run.
- The v0.4.0 bench and eval files record `commit 32dc637` (bench) and `32dc637+dirty` (eval). `dist/` was built from `32dc637` before the runs and not rebuilt during them; the `+dirty` flag reflected edits to help text, agent rules and the writer made while the runs were in progress.
- Costs: LLMs = input × input price + output × output price; jevmem = input tokens × $0.042/M (output free).
- Latency percentiles exclude malformed answers; latency includes retries.
