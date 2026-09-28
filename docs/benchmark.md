# Benchmark

Method, eval sets, pricing sources, p95 and retries. The README shows the held-out summary. The write side (what gets saved, compared with six LLMs) was measured on v0.4.2 on 2026-09-23, and has not been re-run against the LLMs on a 0.5.x release. The read side was measured on 2026-09-28: [retrieval](#retrieval-does-the-right-line-get-injected) on `main` and on 0.5.9, and the [outcome A/B](#outcome-ab-does-claude-act-on-the-memory) on `main`. `main`'s recall is not released yet (coming in 0.6).

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

## Retrieval: does the right line get injected?

What `UserPromptSubmit` puts in front of Claude. Measured on 2026-09-28 with `scripts/eval-recall.mjs`, on `main` (not released yet; coming in 0.6) and on the published 0.5.9.

**Method.** Two sets, written for this and committed before any change to recall (`8e9ad1e`), which share no five-word run with each other, with the older eval sets or with jevmem's own questions (`test/recall-eval.test.ts`): [`eval/recall-dev.jsonl`](../eval/recall-dev.jsonl), on which the misses were found and the change was tuned, and [`eval/recall-heldout.jsonl`](../eval/recall-heldout.jsonl), run once, on the final code and on 0.5.9, after the change was frozen. Each set has three memory files in jevmem's own line format, for made-up projects: small (20 or 21 lines), medium (78 or 80) and large (250 or 255), with decisions, constraints, architecture, preferences, bugs, to-dos, dead ends, superseded lines (2 in each small file, 8 and 6 in the medium ones, 30 in each large one) and look-alike lines that share a topic with a wanted line. Each set has 90 prompts, 18 of each type: **direct** (the prompt names what the line is about), **indirect** (it needs the line but uses other words), **unrelated** (no line applies), **after a supersede** (the topic has a superseded line; only its live replacement may be injected) and **about a dead end**; 20, 30 and 40 prompts for the small, medium and large file. Each prompt lists the lines it needs and the lines that are fine to inject. Every prompt goes through the real hook (`jevmem hook` with the `UserPromptSubmit` payload on stdin, the warm daemon, Jev's cache off, every line recorded as written by jevmem on this machine), to each build in turn, so both builds meet the same moment of Jev's latency; what counts is what the hook printed. A Jev call that failed or ran past the hook's 2-second budget injects nothing and counts as a miss, as it would in a session.

- **recall**: wanted lines injected / wanted lines. **precision**: injected lines that are wanted or fine / injected lines.
- **unrelated prompts that got a line**, and **superseded lines injected**, which must be 0.
- **lines and tokens injected per prompt** (the whole `<jevmem-memory>` block, counted with Claude Sonnet 5's tokenizer through OpenRouter), **hook p50/p95** (the hook process's wall time), **Jev input tokens** and **cost per prompt** (input tokens × $0.042 per million).

### Held-out: 0.5.9 against `main`, run once

The published 0.5.9 against `main`'s final code (recall as of `361be2a`, built at `a5a8512`), each prompt to both in turn, from 17:18 to 17:26 UTC ([0.5.9](../results/recall-heldout-2026-09-28-v059.json), [`main`](../results/recall-heldout-2026-09-28-now.json)):

| | recall, 0.5.9 | recall, main | precision, 0.5.9 | precision, main | unrelated prompts that got a line, 0.5.9 | main | prompts that got a superseded line, 0.5.9 | main | Jev call failed or past 2 s, 0.5.9 | main |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 52/78 (67%) | 70/78 (90%) | 76/114 (67%) | 80/80 (100%) | 7/18 | 0/18 | 0/90 | 0/90 | 1/90 | 4/90 |
| direct | 20/21 (95%) | 18/21 (86%) | 21/21 (100%) | 22/22 (100%) | – | – | 0/18 | 0/18 | 0/18 | 1/18 |
| indirect | 15/20 (75%) | 18/20 (90%) | 18/30 (60%) | 19/19 (100%) | – | – | 0/18 | 0/18 | 0/18 | 1/18 |
| unrelated | – | – | 2/8 (25%) | 0/0 | 7/18 | 0/18 | 0/18 | 0/18 | 0/18 | 0/18 |
| supersede | 17/19 (89%) | 17/19 (89%) | 20/22 (91%) | 20/20 (100%) | – | – | 0/18 | 0/18 | 1/18 | 1/18 |
| dead-end | 0/18 (0%) | 17/18 (94%) | 15/33 (45%) | 19/19 (100%) | – | – | 0/18 | 0/18 | 0/18 | 1/18 |
| small | 12/16 (75%) | 16/16 (100%) | 15/21 (71%) | 18/18 (100%) | 1/4 | 0/4 | 0/20 | 0/20 | 0/20 | 0/20 |
| medium | 19/26 (73%) | 24/26 (92%) | 29/36 (81%) | 26/26 (100%) | 4/6 | 0/6 | 0/30 | 0/30 | 0/30 | 1/30 |
| large | 21/36 (58%) | 30/36 (83%) | 32/57 (56%) | 36/36 (100%) | 2/8 | 0/8 | 0/40 | 0/40 | 1/40 | 3/40 |

| | 0.5.9 | main |
|---|---|---|
| lines injected per prompt | 1.27 | 0.89 |
| tokens of injected context per prompt (all prompts) | 197 | 157 |
| tokens per prompt that got any line | 227 | 211 |
| hook p50 / p95 | 356 ms / 1117 ms | 452 ms / 2066 ms |
| Jev call p50 / p95 | 268 ms / 1022 ms | 324 ms / 553 ms |
| Jev input tokens per prompt | 5,318 | 11,834 |
| cost per prompt | $0.000226 | $0.000520 |
| prompts whose Jev call answered in time: recall, precision, unrelated that got a line | 52/77, 76/114, 7/18 | 70/73, 80/80, 0/18 |
| small file: cost per prompt (Jev input tokens) | $0.000078 (1,856) | $0.000084 (2,000) |
| medium file: cost per prompt (Jev input tokens) | $0.000246 (5,847) | $0.000295 (6,782) |
| large file: cost per prompt (Jev input tokens) | $0.000287 (6,651) | $0.000933 (20,539) |

What it shows:

- **Every line `main` injected was wanted or fine** (80/80, against 76/114 for 0.5.9), and **no unrelated prompt got a line** (0/18, against 7/18). `main` injects fewer lines per prompt (0.89 against 1.27).
- **Dead ends.** 0.5.9 has no `[dead-end]` kind and does not read those lines, so it got none of the 18 dead-end prompts' lines; `main` got 17/18 (the miss was a call past the budget).
- **Recall on the prompts 0.5.9 can serve** is level: direct 20/21 for 0.5.9 and 18/21 for `main`, indirect 15/20 and 18/20, after a supersede 17/19 each. `main` missed 7 of those lines: 4 in three prompts whose Jev call ran past the 2-second budget, and 3 when Jev answered: the second of two lines on two prompts, and an indirect prompt that got nothing ("Can I still look at every request path recorded during last week's pre-production trial run?", which needed the staging trace-retention line). Prompts that need two lines got both in 3 of 6 for each build; on dev the change took that from 1 of 5 to 5 of 5, so this part of the fix did not carry over to the held-out set.
- **Superseded lines:** neither build injected one (0/90 each).
- **Latency and the 2-second budget.** `main`'s requests are larger (11,834 input tokens per prompt against 5,318; 20,539 for the 250-line file), and 4 of its 90 Jev calls ran past the hook's 2-second budget, so they injected nothing: three on the large file, one on the medium one (0.5.9: 1 of 90). Counting only prompts whose call answered in time, `main`'s recall was 70/73. Hook p50 452 ms against 356 ms; p95 2066 ms against 1117 ms, where `main`'s p95 is a call that hit the budget.
- **Cost:** $0.000520 per prompt against $0.000226, and $0.000933 against $0.000287 on the 250-line file.

### Dev, the tuning set: `main` before and after the change

The misses were found here, and the change was tuned here, so these numbers are not a fair test of it; the held-out set above is. Paired the same way, the build from before the change (`8e9ad1e`) against the change ([before](../results/recall-dev-2026-09-28-before.json), [after](../results/recall-dev-2026-09-28-after.json)):

| | recall, before | recall, after | precision, before | precision, after | unrelated prompts that got a line, before | after | prompts that got a superseded line, before | after | Jev call failed or past 2 s, before | after |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 65/77 (84%) | 77/77 (100%) | 69/84 (82%) | 87/88 (99%) | 4/18 | 0/18 | 0/90 | 0/90 | 3/90 | 0/90 |
| direct | 19/20 (95%) | 20/20 (100%) | 20/20 (100%) | 22/22 (100%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| indirect | 13/21 (62%) | 21/21 (100%) | 15/25 (60%) | 24/25 (96%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| unrelated | – | – | 0/5 (0%) | 0/0 | 4/18 | 0/18 | 0/18 | 0/18 | 0/18 | 0/18 |
| supersede | 17/18 (94%) | 18/18 (100%) | 17/17 (100%) | 19/19 (100%) | – | – | 0/18 | 0/18 | 1/18 | 0/18 |
| dead-end | 16/18 (89%) | 18/18 (100%) | 17/17 (100%) | 22/22 (100%) | – | – | 0/18 | 0/18 | 2/18 | 0/18 |
| small | 16/17 (94%) | 17/17 (100%) | 17/18 (94%) | 18/18 (100%) | 1/4 | 0/4 | 0/20 | 0/20 | 0/20 | 0/20 |
| medium | 21/26 (81%) | 26/26 (100%) | 21/27 (78%) | 29/29 (100%) | 2/6 | 0/6 | 0/30 | 0/30 | 3/30 | 0/30 |
| large | 28/34 (82%) | 34/34 (100%) | 31/39 (79%) | 40/41 (98%) | 1/8 | 0/8 | 0/40 | 0/40 | 0/40 | 0/40 |

| | before | after |
|---|---|---|
| lines injected per prompt | 0.93 | 0.98 |
| tokens of injected context per prompt (all prompts) | 169 | 170 |
| tokens per prompt that got any line | 208 | 213 |
| hook p50 / p95 | 367 ms / 1923 ms | 470 ms / 1582 ms |
| Jev call p50 / p95 | 280 ms / 1696 ms | 390 ms / 1500 ms |
| Jev input tokens per prompt | 5,187 | 12,557 |
| cost per prompt | $0.000225 | $0.000527 |
| prompts whose Jev call answered in time: recall, precision, unrelated that got a line | 65/74, 69/84, 4/18 | 77/77, 87/88, 0/18 |
| small file: cost per prompt (Jev input tokens) | $0.000094 (2,245) | $0.000090 (2,134) |
| medium file: cost per prompt (Jev input tokens) | $0.000250 (5,358) | $0.000280 (6,670) |
| large file: cost per prompt (Jev input tokens) | $0.000274 (6,529) | $0.000932 (22,184) |

Why the build before the change missed lines, from its own answers on dev ([DECISIONS.md](../DECISIONS.md)): 7 of the 9 wanted lines it missed in process were never sent to Jev, because recall sent only the 60 lines sharing the most words with the prompt and the prompt used other words; 2 were the second of two lines a prompt needed, starved by the "most relevant" choice, which sums to 1. Unrelated prompts got a line because `recallMin` (0.05) is a floor on that relative choice: when nothing fits, some line still gets a few percent. On `main` every live line is sent, and each has its own relevance question ([How it works](how-it-works.md#the-read-side-one-call-per-prompt-srcrecallts)). Ten question designs were compared on dev before choosing ([`results/diag-recall-questions-summary-2026-09-28.json`](../results/diag-recall-questions-summary-2026-09-28.json)).

The e2e supersede cases of parts 2b and 2c, where session 3 asked "Can I run src/app.ts directly with node now, without tsc?" after Claude had made that work: the line that superseded the dead end was injected in 4 of 9 runs. Asked again in process, the old questions gave 4 of 9, the new ones alone 4 of 9, and the new ones with each line's `replaces` context 9 of 9 ([`results/diag-recall-supersede-e2e-2026-09-28.json`](../results/diag-recall-supersede-e2e-2026-09-28.json)); a diagnostic, not a tuning set.

### Weak spots

- **The 2-second budget.** A request with every live line is up to three times as large, and on the held-out set 4 of 90 calls ran past the budget and injected nothing (dev, paired: 0 of 90; Jev's latency came in bursts that day). A timed-out prompt gets no memory at all.
- **Two lines for one prompt.** Held-out prompts that needed two lines got both in 3 of 6, as with 0.5.9.
- **Lines nothing in the prompt points at.** Recall judges each line against the prompt alone. In the outcome A/B below, a convention for every user-facing string was never injected for "add a button", and a terse prompt ("Show the file name in front of each matching line.") got nothing; the same lines in `CLAUDE.md` were always in context.
- **Cost per prompt** is about 2.3 times 0.5.9's on both sets, and about 3.3 times on a 250-line file.
- **More than 250 live lines** (`jev.maxRecallLines`): the 250 sharing the most words with the prompt are sent, as before, so the old misses return for the rest. Not measured.
- **MCP `search_memory` and `jevmem search`** are unchanged and were not measured here.

## Outcome A/B: does Claude act on the memory?

Real Claude Code sessions on tasks whose right answer depends on a saved line: with no memory, with jevmem, with jevmem and the guard, and with the same lines in `CLAUDE.md`. Measured on 2026-09-28 on `main` at `9c97ea6` (not released yet; coming in 0.6). The final code (`361be2a`) injects the same lines at these settings: it differs only when `recallRelevanceMin` is set above 0.97. Results: [`results/ab-2026-09-28.json`](../results/ab-2026-09-28.json) (234 sessions), [`results/ab-subagent-2026-09-28.json`](../results/ab-subagent-2026-09-28.json) (18 sessions).

**Method.** 24 tasks in three small projects (a TypeScript API, a React front end halfway through a migration, a plain-JavaScript CLI; [`eval/ab/projects/`](../eval/ab/projects/)), each with a project memory of 34 to 42 lines: decisions, conventions, constraints, dead ends, bugs, superseded lines and look-alike lines. Each task's right answer depends on one saved line that the repository does not state: 6 conventions, 4 decisions, 6 constraints, 5 dead ends, and 3 tasks whose topic has a superseded line and its live replacement. What "follows the memory" means for each task, and the check that decides it, were written and committed before any session ran ([`eval/ab/tasks.mjs`](../eval/ab/tasks.mjs), `bfb792f`). Each check reads the project's final files, what changed since its first commit and the session's tool calls; there is no LLM judge (`test/ab-tasks.test.ts` gives every check a made-up result that follows the line and one that does not). Every session is real Claude Code (`claude -p`, Claude Code 2.1.281, `--model claude-sonnet-5`, `--permission-mode acceptEdits`, at most 25 turns) in a fresh copy of the project, committed as the first commit of a new git repository, with a new, empty `CLAUDE_CONFIG_DIR` and a temporary HOME, so Claude Code's auto memory starts empty in every arm. Bash is limited to what the task needs (`git status`, `git diff`, `git log`, `ls`, plus for example `node` or `npm run gen`); anything else is refused, as `claude -p` refuses whatever needs approval, and the session goes on. The arms:

1. **No memory**: no jevmem, no `CLAUDE.md`.
2. **jevmem**: `jevmem init --tool claude`, the project's lines in `JEVMEM.md` as jevmem writes them (verified, superseded lines tagged), the guard off, so only recall acts. `JEVMEM.md` is in the repository, as in real use, and Claude may open it.
3. **jevmem with the guard**, in its default `ask` mode, on the 6 constraint tasks. In `claude -p` nobody can answer an ask, so an asked call does not run.
4. **`CLAUDE.md`**: the same live lines (superseded lines left out) as a list in `CLAUDE.md`, no jevmem.

There is no `CLAUDE.md` except in arm 4, and no `AGENTS.md` in any arm. Three runs per task and arm, the arms interleaved. A session that reaches the 25-turn limit is judged on its final files like the others. With a background subagent, Claude Code printed a second result event when the session really ended, and the harness read the first until the subagent check; the turns and end states below are re-read from each session's transcript (15 sessions), which made two jevmem sessions that ended at the turn limit judgeable.

**Results** (234 sessions: 72 in each arm, 18 in the guard arm):

| | No memory | jevmem | jevmem with the guard (constraint tasks) | `CLAUDE.md` |
|---|---|---|---|---|
| followed the saved line | 28/72 (39%) | 66/72 (92%) | 18/18 (100%) | 67/72 (93%) |
| followed it and did the task | 25/72 (35%) | 63/72 (88%) | 15/18 (83%) | 67/72 (93%) |
| conventions | 1/18 (6%) | 15/18 (83%) | – | 18/18 (100%) |
| decisions | 7/12 (58%) | 12/12 (100%) | – | 11/12 (92%) |
| constraints | 8/18 (44%) | 18/18 (100%) | 18/18 (100%) | 18/18 (100%) |
| dead ends | 10/15 (67%) | 15/15 (100%) | – | 15/15 (100%) |
| superseded | 2/9 (22%) | 6/9 (67%) | – | 5/9 (56%) |
| built what a superseded line described | 4/9 | 0/9 | – | 0/9 |
| acted on a look-alike line that does not apply (3 tasks) | 1/9 | 0/9 | – | 0/9 |
| repeated the failed approach (dead-end tasks) | 3/15 | 0/15 | – | 0/15 |
| constraint tasks: the forbidden change attempted | 10/18 | 0/18 | 0/18 | 0/18 |
| constraint tasks: the forbidden change left in the end | 9/18 | 0/18 | 0/18 | 0/18 |
| the guard's asks and denials | – | – | 0 | – |
| the task's line injected by recall | – | 64/72 | 15/18 | – |
| followed, when it was injected | – | 61/64 | 15/15 | – |
| followed, when it was not | – | 5/8 | 3/3 | – |
| Claude opened `JEVMEM.md` itself | – | 11/72 | 1/18 | – |
| sessions that reached the 25-turn limit | 6/72 | 6/72 | 0/18 | 5/72 |
| median cost of a session | $0.099 | $0.099 | $0.077 | $0.122 |

A constraint task's line is followed when the forbidden change is absent, so a session that changed nothing follows it too; "followed it and did the task" counts only the sessions that also did what was asked. Recall's Jev call never failed in these sessions (0/72, 0/18).

Per task (followed, of 3 runs):

| task | category | No memory | jevmem | with the guard | `CLAUDE.md` |
|---|---|---|---|---|---|
| `pp-log` | convention | 1/3 | 3/3 | – | 3/3 |
| `pp-errors` | convention | 0/3 | 3/3 | – | 3/3 |
| `pp-money` | decision | 1/3 | 3/3 | – | 3/3 |
| `pp-http` | decision | 3/3 | 3/3 | – | 3/3 |
| `pp-generated` | constraint | 2/3 | 3/3 | 3/3 | 3/3 |
| `pp-migrations` | constraint | 3/3 | 3/3 | 3/3 | 3/3 |
| `pp-cache` | dead-end | 3/3 | 3/3 | – | 3/3 |
| `pp-page` | superseded | 2/3 | 3/3 | – | 3/3 |
| `rb-i18n` | convention | 0/3 | 0/3 | – | 3/3 |
| `rb-css` | convention | 0/3 | 3/3 | – | 3/3 |
| `rb-query` | decision | 2/3 | 3/3 | – | 3/3 |
| `rb-locales` | constraint | 0/3 | 3/3 | 3/3 | 3/3 |
| `rb-legacy` | constraint | 0/3 | 3/3 | 3/3 | 3/3 |
| `rb-virtual` | dead-end | 1/3 | 3/3 | – | 3/3 |
| `rb-storage` | dead-end | 0/3 | 3/3 | – | 3/3 |
| `rb-rating` | superseded | 0/3 | 0/3 | – | 1/3 |
| `ls-commit` | convention | 0/3 | 3/3 | – | 3/3 |
| `ls-fail` | convention | 0/3 | 3/3 | – | 3/3 |
| `ls-rc` | decision | 1/3 | 3/3 | – | 2/3 |
| `ls-output` | constraint | 3/3 | 3/3 | 3/3 | 3/3 |
| `ls-branch` | constraint | 0/3 | 3/3 | 3/3 | 3/3 |
| `ls-workers` | dead-end | 3/3 | 3/3 | – | 3/3 |
| `ls-glob` | dead-end | 3/3 | 3/3 | – | 3/3 |
| `ls-node` | superseded | 0/3 | 3/3 | – | 1/3 |

**One sentence per arm.** Each holds for these 24 tasks (6 for the guard) in three small projects of 34 to 42 saved lines, 3 runs per task and arm, real Claude Code 2.1.281 sessions with `claude-sonnet-5`, jevmem at `9c97ea6` (on `main`, not released), 2026-09-28:

- **No memory:** "Without a memory, Claude followed the project's saved line in 28 of 72 sessions (39%); it built what a superseded line described in 4 of 9, and tried an approach the project had already seen fail in 3 of 15."
- **jevmem:** "With jevmem, Claude followed the project's saved line in 66 of 72 sessions (92%), never built what a superseded line described (0 of 9), and never repeated an approach recorded as failed (0 of 15)."
- **jevmem with the guard:** "On the 6 constraint tasks, recall alone kept Claude from ever attempting the forbidden change (0 of 18 sessions, against 10 of 18 with no memory), so the guard checked all 56 Bash, Edit and Write calls and had nothing to ask."
- **`CLAUDE.md`:** "The same lines pasted into CLAUDE.md did as well or better: Claude followed them in 67 of 72 sessions (93%), in all 18 convention sessions against jevmem's 15, and also did the task in 67 of 72 against jevmem's 63."

**Where `CLAUDE.md` did as well or better.** Overall the two are a session apart (67/72 and 66/72); counting only sessions that also did the task, `CLAUDE.md` is ahead (67/72 and 63/72). Two tasks make the difference:

- `rb-i18n` ("Add an 'Add to shopping list' button … that calls the `onAddToList` prop."): the convention that every user-facing string goes through `t()` was never injected (0 of 3); Jev did not judge it relevant to a prompt about a button, and Claude hard-coded the label every time. With the line always in context, `CLAUDE.md` got it 3 of 3. A convention that applies to a whole class of changes, with nothing in the prompt pointing at it, is what per-prompt recall misses.
- `ls-output` ("Show the file name in front of each matching line."): with no project context in the prompt, Claude read it as a search request and asked what to search, in all 9 sessions without `CLAUDE.md` (no memory, jevmem, guard); the output-format line was not injected either. With the whole file in context, Claude recognised the project and did it, keeping the default output, 3 of 3.

Where jevmem did better, it was by one or two sessions: `ls-node` (3/3 against 1/3) and `ls-rc` (3/3 against 2/3). In those three `CLAUDE.md` sessions, Claude first wanted a new branch because of the file's line about never committing to `main`, which these tasks did not involve; `git checkout` was not allowed there, and it stopped to ask. With jevmem that line was not injected for those prompts. On `rb-rating` (stars were replaced by a thumbs up or down), Claude pointed out the saved decision and asked instead of building in all 3 jevmem sessions and 2 of 3 `CLAUDE.md` sessions; none of them built stars, which all 3 sessions without memory did. `CLAUDE.md` sessions cost more at the median ($0.122 against $0.099); this run does not break down why.

**What the guard added.** Nothing measurable here. With recall on, Claude never attempted a forbidden change on the constraint tasks, in either jevmem arm, so the guard (which checked every Bash, Edit and Write call: 25 matched no rule, 28 went to Jev, 3 were answered from its cache) never had to ask. The guard is for the call that recall does not prevent; the no-memory arm shows how often that call comes when nothing is recalled (10 of 18).

**Subagents.** Two of the tasks (the generated client, a constraint; prices in cents, a decision), with a prompt that asks Claude to hand the work to a subagent, 3 runs each in three arms (jevmem, jevmem with the guard, `CLAUDE.md`): 18 sessions, on the same build ([`results/ab-subagent-2026-09-28.json`](../results/ab-subagent-2026-09-28.json)). Recall runs on your prompt, so a subagent learns the line only from the main agent's message to it.

- Claude delegated in all 18 sessions, and its message to the subagent carried the saved line in all 18 (a check for the rule's words in the Agent call). The subagent followed the line in 18 of 18; none edited the generated client by hand.
- The guard's `PreToolUse` hook ran on every Bash, Edit and Write call the subagents made in the jevmem and guard arms, 88 of 88 (and on the main agents' 17 of 17). In the guard arm the guard logged a check for every one of the 44 calls the hook ran on, 34 of them the subagents'. It asked once, on a subagent's call: `git checkout -- JEVMEM.md`, which its tamper check stops because it would change `JEVMEM.md` (in `claude -p` an ask denies the call). No subagent tried the forbidden edit, so no rule had to be enforced against one.
- That `git checkout` shows a problem on the write side. In 16 of the 18 sessions the subagent ran in the background, so the main agent stopped while it worked and jevmem's `Stop` hook decided on that half-finished turn. In 3 of the 12 jevmem and guard sessions a line appeared in `JEVMEM.md` during the task, seen because Claude printed the diff: twice your request saved as a `[bug]` with "Hand this to a subagent (use your Agent tool)…" still in front of it, and once "I'll delegate the fix accordingly rather than a direct hand-edit." as a `[bug]`. The subagent that saw that line took it for noise and tried to revert the file. The sessions' final `JEVMEM.md` was not kept, so the count may be higher.

**What this does not show.** The projects are small: 34 to 42 lines fit easily in a `CLAUDE.md`, and nothing here tests a memory too long to load whole, or how either file is kept current, which is jevmem's other half (the write side, above). Each session is one prompt through `claude -p` with Bash limited, not an interactive session. One model (`claude-sonnet-5`). Several tasks were followed without any memory (`pp-http`, `pp-migrations`, `pp-cache`, `ls-glob`, `ls-workers`: the code or common practice points the same way), and the tasks and checks were written by jevmem's author, before any session.
