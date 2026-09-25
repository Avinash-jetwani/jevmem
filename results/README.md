# Results

Every measured number in the docs comes from a file listed in [`CURRENT.json`](CURRENT.json); `node scripts/check-claims.mjs` (run in CI) fails if a doc number has no source here.

| File | Produced by | What it is |
|---|---|---|
| `contradictions-dev-before.json`, `contradictions-dev-after-run1.json`, `contradictions-dev-after-run2.json` | `node scripts/diag-contradictions.mjs` | v0.4.1 code (before, commit `b1b38a2`) and v0.4.2 code (two after runs, commit `5f2fe15`) on `eval/contradictions-dev.jsonl`: found / wrong id / false supersedes per mode, and every tier's contradiction signals per case |
| `bench-heldout-2026-09-23-v042.json` | `node scripts/bench-llm.mjs --set heldout` | v0.4.2 final exam, run once after the fix: six LLMs + jevmem `auto` on `eval/heldout.jsonl` (66 turns), all seven concurrently (15:17–15:32 UTC) |
| `bench-regression-2026-09-23-v042.json` | `node scripts/bench-llm.mjs --set regression` | v0.4.2. The same on `eval/transcript.jsonl` (50 turns), 15:32–15:44 UTC |
| `eval-heldout-2026-09-23-v042.json`, `eval-regression-2026-09-23-v042.json` | `node scripts/eval.mjs --set … --out …` | v0.4.2. jevmem `decide` in `fast` / `auto` / `full` |
| `ops-2026-09-23-v042.json` | `node scripts/bench-ops.mjs` | v0.4.2. recall / search / audit warm, cache hit, cold processes, hook processes through the warm daemon |
| `demo-2026-09-23-v042.txt` | the DEMO.md scripted steps | v0.4.2. Captured CLI output (home directory replaced with `~`) |
| `e2e-2026-09-23-v042.txt` | `scripts/e2e.sh --runs 3` | v0.4.2. Real Claude Code session, three runs (paths replaced with `~` / `<scratch>`) |
| `memory-injection-2026-09-25-run1.json`, `memory-injection-2026-09-25-run2.json` | `node scripts/eval-injection.mjs` | v0.5.0 poisoning gate on `eval/memory-injection.jsonl` (44 lines, committed in `e9f4111` before the first run), two runs: blocked planted lines, false blocks, and the gate's added tokens and latency against the same recall call without it |
| `ops-2026-09-25-before-async.json` | `node scripts/bench-ops.mjs` | v0.5.0 code before the non-blocking Stop hook (commit `e9f4111`): the gated recall rows, and the "before" Stop hook wall time |
| `*-v041.*` | v0.4.1 | History: the v0.4.1 runs (before the contradiction fix). Not cited by the v0.4.2 docs |
| `bench-*-2026-09-23.json`, `eval-*-2026-09-23.json`, `ops-2026-09-23.json`, `demo-2026-09-23.txt`, `e2e-2026-09-23.txt` (no suffix) | v0.4.0 | History: the same runs on v0.4.0, whose tier 1 also asked the four atomic injection nouls. Not cited by the v0.4.1 docs |
| `a5-tier1-injection/` | `node scripts/eval.mjs --modes fast,auto` | History: tier 1 with one injection noul vs five, the measurement behind the v0.4.1 revert |
| `bench-2026-09-23.json`, `bench-2026-09-23-r2.json` | v0.3.7 / v0.3.8 | History. The LLMs got `previous_turns: null`, ran cold, and the eval set overlaps jevmem's prompt examples |

Notes on provenance:

- The v0.4.2 bench, eval and ops files record `commit 4323bfe` (the fix `5f2fe15` plus the dev-set results and DECISIONS entry), with a clean `src/`.
- The v0.4.1 files record `commit bd6951b` with a clean `src/`. A first v0.4.1 benchmark run (14:03–14:28 UTC) was discarded: its regression half hit OpenRouter's key credit limit (HTTP 402) for four LLMs. Both sets were re-run back to back after the limit was raised; the files here are that re-run.
- The v0.4.0 bench and eval files record `commit 32dc637` (bench) and `32dc637+dirty` (eval). `dist/` was built from `32dc637` before the runs and not rebuilt during them; the `+dirty` flag reflected edits to help text, agent rules and the writer made while the runs were in progress.
- Costs: LLMs = input × input price + output × output price; jevmem = input tokens × $0.042/M (output free).
- Latency percentiles exclude malformed answers; latency includes retries.
