# Results

Every measured number in the docs comes from a file listed in [`CURRENT.json`](CURRENT.json); `node scripts/check-claims.mjs` (run in CI) fails if a doc number has no source here.

| File | Produced by | What it is |
|---|---|---|
| `bench-heldout-2026-09-23.json` | `node scripts/bench-llm.mjs --set heldout` | Six LLMs + jevmem `auto` as the memory decider on `eval/heldout.jsonl` (66 turns). Same state for all, one warm-up call each, all seven concurrently (13:11–13:26 UTC), retries per row, network path and OpenRouter upstream host per model |
| `bench-regression-2026-09-23.json` | `node scripts/bench-llm.mjs --set regression` | The same on `eval/transcript.jsonl` (50 turns), 13:26–13:31 UTC |
| `eval-heldout-2026-09-23.json`, `eval-regression-2026-09-23.json` | `node scripts/eval.mjs --set … --out …` | jevmem `decide` in `fast` / `auto` / `full`, every row's answer and reason |
| `ops-2026-09-23.json` | `node scripts/bench-ops.mjs` | recall / search / audit warm, cache hit, cold processes, hook processes through the warm daemon |
| `a5-tier1-injection/before-*.json`, `after-*.json` | `node scripts/eval.mjs --modes fast,auto` | Tier 1 with one injection noul (before, commit `ec3102a`) and with all five (after, the uncommitted change that became `32dc637`) |
| `demo-2026-09-23.txt` | the DEMO.md scripted steps | Captured CLI output (home directory replaced with `~`) |
| `e2e-2026-09-23.txt` | `scripts/e2e.sh --runs 3` | Real Claude Code 2.1.280 session, 3/3 passed (paths replaced with `~` / `<scratch>`) |
| `bench-2026-09-23.json`, `bench-2026-09-23-r2.json` | v0.3.7 / v0.3.8 | History. Not cited by the v0.4.0 docs: the LLMs got `previous_turns: null`, ran cold, and the eval set overlaps jevmem's prompt examples |

Notes on provenance:

- The v0.4.0 bench and eval files record `commit 32dc637` (bench) and `32dc637+dirty` (eval). `dist/` was built from `32dc637` before the runs and not rebuilt during them; the `+dirty` flag is `git status src` at run time and reflects edits to help text, agent rules and the writer that were made while the runs were in progress and are not in the `dist/` that ran. `decide` did not change after `32dc637`.
- Costs: LLMs = input × input price + output × output price; jevmem = input tokens × $0.042/M (output free).
- Latency percentiles exclude malformed answers; latency includes retries.
