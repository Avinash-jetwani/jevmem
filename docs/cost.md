# Cost

## Cost math

Every Jev call is logged to `.jevmem/log.jsonl` (question count, tier, tokens, latency, cost, cache hit), and `jevmem stats` summarises it, including the tier-1 → tier-2 escalation rate. Cost is **input tokens × $0.042 / 1M**; output tokens are free per TypeSafe's launch post (configurable under `jev.usdPerMillionTokens`). The same method is used by `jevmem stats`, `scripts/eval.mjs` and `scripts/bench-llm.mjs`.

| Call | Input tokens | p50 in-process, warm | p50 as a real process (hook or CLI) | Cost per call |
|---|---|---|---|---|
| `decide` tier 1 (`fast`) | 2,143–2,259 | 268–269 ms | – | $0.000090–$0.000095 |
| `decide` in `auto` | 2,443–2,948 | 269–310 ms | `Stop` hook: 773 ms cold, 599 ms via the warm daemon | $0.000103–$0.000124 |
| `decide` tier 2 (`full`) | 4,915–5,040 | 276–322 ms | – | $0.000206–$0.000212 |
| `decide`, cache hit | 0 | 1 ms | – | $0 |
| `recall` (choice over 19 memories) | 1,668 | 278 ms | `UserPromptSubmit` hook: 522 ms cold, 429 ms via the warm daemon | $0.000070 |
| `recall`, 19 unverified memories not yet checked (a fresh clone's first prompt: the choice plus a poisoning-gate noul per line) | 6,559 | 221 ms (207 ms ungated, same run) | – | $0.000275 |
| `recall`, the same lines once their gate verdicts are cached, or verified lines | 1,672 | 198–208 ms | – | $0.000070 |
| `search` (choice + noul per candidate, 19 memories) | 4,597 | 308 ms | `jevmem search`: 496 ms | $0.000193 |
| `audit` (noul per memory, 19 memories) | 3,290 | 309 ms | `jevmem audit --dry-run`: 628 ms | $0.000138 |

`decide` rows are the two eval runs above (the range spans the held-out and regression sets). The two gated `recall` rows are [`results/ops-2026-09-25-before-async.json`](../results/ops-2026-09-25-before-async.json) (same script, v0.5.0 code). The other rows are [`results/ops-2026-09-23-v042.json`](../results/ops-2026-09-23-v042.json) (`node scripts/bench-ops.mjs`: a scratch project with 19 memories, 20 warm calls each, 10 process runs each; "real process" is the wall time of a new `node dist/cli.js …` process, which is what Claude Code waits for). 300 turns a day in `auto` mode is about $0.03–$0.04 for `decide` plus about $0.02 for recall, plus one short LLM completion per *saved* line if you configure a writer. For how this compares with an LLM doing the same job, see [Benchmark](benchmark.md#benchmark).
