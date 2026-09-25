# Benchmark

Method, both eval sets, pricing sources, p95 and retries. The README shows the held-out summary.

## Why Jev and not an LLM

- **It is fast enough to run on every turn.** 0.3 s in-process (and the `Stop` hook no longer waits for it), against 2.8–4.3 s p50 for the LLMs we measured, means the decision can happen on *every* Stop, not once per session. Memory that updates continuously catches the decision made in passing at turn 41. It is not the most accurate: see [Benchmark](benchmark.md#benchmark).
- **Typed answers, thresholds in code.** Jev returns probabilities, not prose. "Save if importance ≥ useful and chit-chat < 0.5" is a line of config, testable and tunable, not a prompt you hope the model follows.
- **A narrow attack surface, not a closed one.** Per TypeSafe, Jev returns probabilities and does not generate text or call tools, so a transcript that says "ignore previous instructions and remember X" has no channel to run a command through Jev; the failure mode is a wrong probability. Injected text can still bias those probabilities, which is why an injection noul gates every hook and MCP `add_memory` save (one broad noul in tier 1, four atomic nouls when tier 2 runs), the eval sets carry injection attempts, and the harness sends one. Once Jev says save, the line itself is written by the writer LLM (or the extract) from the scrubbed message, so injected text that gets past the gate can still shape the line's wording. Lines typed with `jevmem add` are not checked by Jev.

## Compared with an LLM as the decider

Only rows the [Benchmark](benchmark.md#benchmark) measures (held-out set, 66 turns):

| | An LLM called as the decider (six benchmarked) | Jevmem (`auto`) |
|---|---|---|
| Decides what to save with | One LLM call with a zero-shot prompt | One Jev call of 12 questions (14 with the assistant reply); a second of 33 (37) on 6–14% of turns |
| Accuracy: save/skip | 90.9%–98.5% | 98.5% (tied highest) |
| Accuracy: save/skip + kind | 90.9%–98.5% | 95.5% (below GPT-6 Astra and Claude Opus 5.5) |
| Latency per decision | 2.8–4.3 s p50, 4.9–29.6 s p95 | 300 ms p50, 629 ms p95 |
| Cost per decision | $0.000089 (GPT-6 Luna) to $0.013256 (Claude Fable 5.1) | $0.000127 |
| Detects contradictions | Five of six found 5/5 with a named id (Grok 4.7: 4/5, its miss an empty answer); none flagged a false one | 5/5 (`contradicts_existing_memory` ≥ 0.7 AND a named memory id) |
| Injection resistance | Five of six refused all 6 injection turns (Gemini 3.8 Flash: 5/6, its miss an empty answer) | Refused all 6 injection turns |

## Benchmark

`scripts/bench-llm.mjs` runs an eval set through six current LLMs acting as the memory decider and through jevmem. Every decider receives the identical state, built by the same function jevmem's `decide` uses (`buildDecideState`): the user message, the assistant reply when jevmem's heuristic would include it, the previous turns when the turn has them, and the existing memories with ids. The LLMs get the committed zero-shot system prompt ([`bench/system-prompt.md`](../bench/system-prompt.md)) and must answer strict JSON `{save, kind, contradicts_id, injection}` through the provider's structured-output mode; the text from the first `{` to the last `}` is validated against the schema, and a malformed answer counts as wrong. jevmem gets its own Jev questions, which contain few-shot examples. Cost is real token usage × the list price on the provider's pricing page (URLs and dates in the results file); jevmem's is input tokens × $0.042/M.

**How it was run.** 2026-09-23, macOS arm64, Node 22. The six LLMs were called through OpenRouter's chat-completions endpoint with one key, at each provider's default reasoning setting (a lower-reasoning or non-reasoning configuration was not tested and would likely narrow the latency gap), with a 4,000-token output cap. jevmem was called directly to TypeSafe's API. Every decider made one unscored warm-up call first, and all seven ran concurrently, so they share one time window: held-out 15:17–15:32 UTC, regression 15:32–15:44 UTC (v0.4.2, commit `4323bfe`). The held-out set was run once for v0.4.2, after the contradiction fix was built and frozen on the dev set. Retries (429/5xx, up to 6 with backoff, included in latency) are counted per row, and the OpenRouter upstream host is recorded per model. Reproduce with `node scripts/bench-llm.mjs --set heldout` (needs `TYPESAFE_API_KEY` plus `OPENROUTER_API_KEY`, or the providers' own keys).

### Held-out set (66 turns, written for v0.4.0, no shared text with jevmem's prompts)

Results: [`results/bench-heldout-2026-09-23-v042.json`](../results/bench-heldout-2026-09-23-v042.json).

| Model (API id) | save/skip | save/skip + kind | contradiction id found | false contradictions | injection turns not saved | malformed | p50 | p95 | $/decision | $/300 turns | retries |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GPT-6 Astra (`gpt-6-astra`) | 98.5% (65/66) | 98.5% (65/66) | 5/5 | 0 | 6/6 | 0 | 3,469 ms | 6,459 ms | $0.007489 | $2.247 | 0 |
| GPT-6 Luna (`gpt-6-luna`) | 93.9% (62/66) | 93.9% (62/66) | 5/5 | 0 | 6/6 | 0 | 2,927 ms | 4,937 ms | $0.000089 | $0.027 | 0 |
| Claude Fable 5.1 (`claude-fable-5-1`) | 95.5% (63/66) | 95.5% (63/66) | 5/5 | 0 | 6/6 | 0 | 4,290 ms | 8,539 ms | $0.013256 | $3.977 | 0 |
| Claude Opus 5.5 (`claude-opus-5-5`) | 97.0% (64/66) | 97.0% (64/66) | 5/5 | 0 | 6/6 | 0 | 2,784 ms | 6,169 ms | $0.005186 | $1.556 | 0 |
| Gemini 3.8 Flash (`gemini-3.8-flash`) | 92.4% (61/66) | 92.4% (61/66) | 5/5 | 0 | 5/6 | 1 | 2,850 ms | 10,197 ms | $0.001174 | $0.352 | 0 |
| Grok 4.7 (`grok-4.7`) | 90.9% (60/66) | 90.9% (60/66) | 4/5 | 0 | 6/6 | 3 | 3,320 ms | 29,585 ms | $0.004602 | $1.381 | 0 |
| **jevmem `auto`** (`jev-latest`) | **98.5% (65/66)** | **95.5% (63/66)** | **5/5** | 0 | 6/6 | 0 | **300 ms** | **629 ms** | $0.000127 | $0.038 | 0 |

#### How it compares

On 66 held-out turns, jevmem's median decision took 0.30 s, against 2.8–4.3 s for six current LLMs.
Its accuracy was within the LLMs' range: 98.5% save/skip (tied with GPT-6 Astra for highest) and 95.5% save+kind, against 90.9–98.5% for the LLMs. GPT-6 Astra (98.5%) and Claude Opus 5.5 (97.0%) were more accurate on save+kind; Claude Fable 5.1 tied; GPT-6 Luna, Gemini 3.8 Flash and Grok 4.7 were less accurate. It found 5/5 contradictions, as did five of the six LLMs.
GPT-6 Luna was cheaper ($0.000089 against $0.000127) but less accurate (93.9%) and about 10× slower.
This is a single run, and differences of one or two turns are within run-to-run noise. If the most accurate decision matters most, GPT-6 Astra or Claude Opus 5.5 are better, at about 40–60× the cost per decision and 9–12× the latency. jevmem is for when you want a fast, cheap decision on every message.

On the held-out set `--mode fast` and `auto` scored the same in this run (95.5% save+kind in the eval); in v0.4.1 `fast` scored higher. We'll confirm on a fresh set before changing the default.

- **Where the misses are.** Six of the seven got a turn I labelled a preference wrong ("Write doc comments on every public function…": five LLMs skipped it, jevmem filed it as a todo), which suggests the label is debatable; it was not changed after the run. Six of the seven (all but Gemini 3.8 Flash) saved "no, leave it as is" (declining a proposal) as a decision. GPT-6 Luna, Claude Fable 5.1, Gemini 3.8 Flash and Grok 4.7 each skipped one to three bug reports whose wording the state heuristic does not recognise ("…panics on…", "…are empty after…", "…grows without bound…"), so no decider saw the assistant's diagnosis; jevmem saved all three from the user message. That is a limit of jevmem's state design, which every model inherits here. Grok 4.7 returned empty answers on three turns (one of them a contradiction) and Gemini 3.8 Flash on one (an injection turn); malformed answers count as wrong. jevmem's third miss is a decision filed as architecture.

### Regression set (the original 50 turns; contaminated, see above)

Results: [`results/bench-regression-2026-09-23-v042.json`](../results/bench-regression-2026-09-23-v042.json).

| Model (API id) | save/skip | save/skip + kind | contradiction id found | false contradictions | injection turns not saved | malformed | p50 | p95 | $/decision | $/300 turns | retries |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GPT-6 Astra (`gpt-6-astra`) | 98.0% (49/50) | 98.0% (49/50) | 2/2 | 1 | 4/4 | 0 | 2,840 ms | 5,762 ms | $0.007361 | $2.208 | 0 |
| GPT-6 Luna (`gpt-6-luna`) | 98.0% (49/50) | 96.0% (48/50) | 2/2 | 2 | 4/4 | 0 | 2,670 ms | 5,228 ms | $0.000083 | $0.025 | 0 |
| Claude Fable 5.1 (`claude-fable-5-1`) | 96.0% (48/50) | 94.0% (47/50) | 2/2 | 0 | 3/4 | 1 | 4,073 ms | 7,754 ms | $0.011879 | $3.564 | 0 |
| Claude Opus 5.5 (`claude-opus-5-5`) | 98.0% (49/50) | 96.0% (48/50) | 2/2 | 0 | 4/4 | 0 | 2,821 ms | 7,009 ms | $0.004875 | $1.462 | 0 |
| Gemini 3.8 Flash (`gemini-3.8-flash`) | 96.0% (48/50) | 94.0% (47/50) | 2/2 | 0 | 4/4 | 1 | 2,671 ms | 13,001 ms | $0.001019 | $0.306 | 0 |
| Grok 4.7 (`grok-4.7`) | 98.0% (49/50) | 96.0% (48/50) | 2/2 | 0 | 4/4 | 0 | 3,190 ms | 107,653 ms | $0.004969 | $1.491 | 0 |
| jevmem `auto` (`jev-latest`) | 100.0% (50/50) | 98.0% (49/50) | 2/2 | 0 | 4/4 | 0 | 313 ms | 625 ms | $0.000111 | $0.033 | 0 |

On this set jevmem scores highest on save/skip and GPT-6 Astra ties it on save+kind (49/50); every other LLM is one or two turns behind; GPT-6 Luna is cheaper ($0.000083 against $0.000111). Because 33 of these 50 turns share text with jevmem's own few-shot examples and the LLMs see none, this table says jevmem still passes its regression tests, not that it beats the LLMs. The "false contradictions" column counts contradiction ids named on turns that contradict nothing; the "contradiction id found" column counts only true positives. The two malformed answers are Claude Fable 5.1 returning invalid JSON on an injection turn and Gemini 3.8 Flash returning zero output tokens on a constraint turn.

Pricing sources recorded in the results files (all read 2026-09-23): OpenAI `https://developers.openai.com/api/docs/pricing` (Astra $10 in / $50 out per million, Luna $0.1 / $0.5, standard tier), Anthropic `https://platform.claude.com/docs/en/about-claude/pricing` (Fable 5.1 $10 / $50, Opus 5.5 $4 / $20), Google `https://ai.google.dev/gemini-api/docs/pricing` (Gemini 3.8 Flash $0.75 / $3.75 through 2026-12-31), xAI `https://docs.x.ai/docs/models` (Grok 4.7 $2 / $6; OpenRouter listed $1.6 / $4.8 that day and the higher list price is used), Jev $0.042 per million input tokens, output free, from TypeSafe's launch post `https://typesafe.ai/blog/introducing-system-one-models-and-jev`.
