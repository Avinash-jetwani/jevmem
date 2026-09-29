# Benchmark

Method, eval sets, pricing sources, p95 and retries. The README shows the held-out summary. The write side (what gets saved, compared with six LLMs) was measured on v0.4.2 on 2026-09-23, and has not been re-run against the LLMs on a 0.5.x release. The read side was measured on 2026-09-28: [retrieval](#retrieval-does-the-right-line-get-injected) on `main` and on 0.5.9 (part 3, then part 3b on a fresh held-out set), and the [outcome A/B](#outcome-ab-does-claude-act-on-the-memory) on `main`. Part 3b also measured [the Stop hook with background subagents](#the-stop-hook-with-background-subagents), on real Claude Code transcripts. `main`'s recall and Stop hook are not released yet (coming in 0.6).

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

Cost per prompt counts the calls that answered. In part 3's tables, input tokens per prompt count 0 for a call that failed or ran past the budget (here 4 of `main`'s 90, 3 of them on the large file, and 1 of 0.5.9's; on dev, 3 of the build before the change), so they understate those requests; in the dev run below, where every call of the change answered, the large file's requests were 22,184 tokens. From part 3b on, the harness counts such a call's tokens as unknown, like its cost.

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

### Part 3b: held-out v2, 0.5.9 against `main`, run once

Part 3's held-out set was used, so part 3b wrote a fresh one with the same design before any change ([`eval/recall-heldout-v2.jsonl`](../eval/recall-heldout-v2.jsonl), `04efca2`): three new projects of 20, 80 and 250 lines (a theatre's cue app, a vegetable-box service, an EV-charging operator), 90 prompts, 18 of each type, 6 of them needing two lines; it shares no five-word run with any other set (tested). It was run once on the final code (`48cc67d`) and on the published 0.5.9, each prompt to both builds in turn, from 21:15 to 21:23 UTC ([0.5.9](../results/recall-heldout2-2026-09-28-v059.json), [`main`](../results/recall-heldout2-2026-09-28-now.json)):

| | recall, 0.5.9 | recall, main | precision, 0.5.9 | precision, main | unrelated prompts that got a line, 0.5.9 | main | prompts that got a superseded line, 0.5.9 | main | Jev call failed or past its budget, 0.5.9 | main |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 55/78 (71%) | 75/78 (96%) | 88/104 (85%) | 96/97 (99%) | 5/18 | 1/18 | 0/90 | 0/90 | 0/90 | 0/90 |
| direct | 19/20 (95%) | 18/20 (90%) | 20/20 (100%) | 23/23 (100%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| indirect | 16/19 (84%) | 19/19 (100%) | 22/23 (96%) | 28/29 (97%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| unrelated | – | – | 2/6 (33%) | 1/1 (100%) | 5/18 | 1/18 | 0/18 | 0/18 | 0/18 | 0/18 |
| supersede | 18/19 (95%) | 19/19 (100%) | 19/19 (100%) | 21/21 (100%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| dead-end | 2/20 (10%) | 19/20 (95%) | 25/36 (69%) | 23/23 (100%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| small | 13/17 (76%) | 16/17 (94%) | 20/22 (91%) | 18/18 (100%) | 2/4 | 0/4 | 0/20 | 0/20 | 0/20 | 0/20 |
| medium | 18/25 (72%) | 24/25 (96%) | 32/35 (91%) | 33/33 (100%) | 1/6 | 0/6 | 0/30 | 0/30 | 0/30 | 0/30 |
| large | 24/36 (67%) | 35/36 (97%) | 36/47 (77%) | 45/46 (98%) | 2/8 | 1/8 | 0/40 | 0/40 | 0/40 | 0/40 |

| | 0.5.9 | main |
|---|---|---|
| lines injected per prompt | 1.16 | 1.08 |
| tokens of injected context per prompt (all prompts) | 201 | 189 |
| tokens per prompt that got any line | 235 | 234 |
| hook p50 / p95 | 370 ms / 491 ms | 466 ms / 596 ms |
| Jev call p50 / p95 | 278 ms / 352 ms | 382 ms / 492 ms |
| Jev input tokens per prompt | 6,366 | 13,765 |
| cost per prompt | $0.000267 | $0.000578 |
| prompts whose Jev call answered in time: recall, precision, unrelated that got a line | 55/78, 88/104, 5/18 | 75/78, 96/97, 1/18 |
| prompts served by word match (Jev failed or late) | 0/90 | 0/90 |
| prompts that needed a line and got none | 0/72 | 0/72 |
|   of those, word match would have found a wanted line | 0 | 0 |
|   of those, the Jev call failed or ran late | 0 | 0 |
| small file: cost per prompt (Jev input tokens) | $0.000085 (2,015) | $0.000088 (2,085) |
| medium file: cost per prompt (Jev input tokens) | $0.000319 (7,590) | $0.000340 (8,092) |
| large file: cost per prompt (Jev input tokens) | $0.000320 (7,623) | $0.001002 (23,859) |

What it shows, next to part 3's held-out run above:

- **The gains held on new projects.** Recall 75/78 against 55/78 for 0.5.9 (part 3: 70/78 against 52/78); every injected line but one was wanted or fine (96/97; part 3: 80/80); one unrelated prompt got a line, one labelled fine for it (the portal's stack line for "Change the portal's login page background to a lighter grey"; 0.5.9: 5 of 18); no superseded line was injected (0/90 in both). Dead-end prompts got their line 19 of 20 times, against 2 of 20 for 0.5.9, which reads no `[dead-end]` lines (the 2 it got are lines of other kinds a prompt also needed).
- **No call ran late, so word match served nothing.** Jev answered every call of both builds inside the budget that evening, `main`'s p95 at 492 ms. Hook p50 466 ms and p95 596 ms, against 370 ms and 491 ms for 0.5.9 in the same run: within the target of 0.5.9's 1,117 ms from part 3's run. What the fallback does when calls are slow is measured on dev below; this run does not show it.
- **Direct prompts: 18/20 against 19/20.** Both lines `main` missed were the second line a prompt needed (below).
- **Two lines for one prompt:** both lines in 3 of 6 prompts (0.5.9: 1 of 6). Part 3b's lower choice floor did not reach the other three (below).
- **Cost:** $0.000578 per prompt against $0.000267 (2.2 times); on the 250-line file $0.001002 against $0.000320 (3.1 times). Part 3b did not change the questions or what is sent, so the cost per prompt is part 3's (dev, below).

### Part 3b: why calls ran late, and what the hook does now

Part 3's held-out run left 4 of 90 prompts with nothing because the Jev call failed or ran past the 2-second budget, three of them on the 250-line file, and its hook p95 (2066 ms) was a call that hit the budget.

**Why calls ran late.** Jev's time grows with the request. On the dev set's 250-line file (225 live lines), 150 rounds, each sending every request shape once for the same prompt in a random order ([results](../results/recall-latency-2026-09-28-dev-large.json)): part 3's request, 22,187 input tokens, took 413 ms p50 and 526 ms p95; 0.5.9's, 6,534 tokens, 261 ms and 349 ms. Most of part 3's request is the state it sends with every question (the prompt and the lines' text): 16,177 tokens with a single question ([shapes](../results/recall-latency-2026-09-28-dev-large-shapes.json)). Splitting the lines over requests sent at the same time shortened the median (four requests: 300 ms p50, 477 ms p95), but each request carries its own state and instructions (two requests: 22,552 input tokens against 22,187; four: 23,281, 5% more). In those 1,200 requests, of every shape, none took a second. The calls that ran past 2 s on part 3's held-out set were single slow answers: the paired 0.5.9 calls for the same prompts, at most 2.2 s apart, answered in 228–347 ms ([results](../results/diag-recall-late-calls-2026-09-28.json)). Splitting cannot shorten a slow answer and costs more, so it was not done.

**What the hook does now.** The prompt's call has 1,000 ms (`jev.recallTimeoutMs`). When it fails or runs past that, the prompt gets the lines that share at least two words with it (the words 0.5.9's pre-filter counts), the most first, at most five, from the lines the poisoning gate serves without asking: never a superseded line, a line the gate withholds, or an unverified line it has not checked ([How it works](how-it-works.md#the-read-side-one-call-per-prompt-srcrecallts)). Each prompt's path is logged, and `jevmem stats` counts them. Two shared words, not one, was chosen on dev, scoring word match as if every prompt had fallen back, with no Jev call ([results](../results/diag-word-match-dev-2026-09-28.json)): with one word, 4.03 lines a prompt, 120/411 of them wanted or fine, and 11/18 unrelated prompts got a line; with two, 1.61 lines, 92/164 wanted or fine, 2/18 unrelated prompts, and 55/101 wanted lines (70/101 with one). Word match is a fallback, not a second recall: it finds a line that shares the prompt's words (direct prompts 25/32) and seldom one that does not (indirect 3/33).

On held-out v2 no call ran late, so the fallback served nothing there (above). On dev, one prompt of 102 was served by word match, an unrelated one, and it got nothing (below).

### Part 3b: every miss, and why

Each prompt that missed a wanted line was asked again in process, three times, with the hook's own questions, and each wanted line's relevance and choice were kept ([`scripts/diag-recall-misses.mjs`](../scripts/diag-recall-misses.mjs); a diagnosis of finished runs, nothing tuned on it). A miss is a **timeout** (the run's call failed or ran past its budget), a **threshold** (relevance at least `recallRelevanceMin`, 0.8, but under the sure level, 0.97, and the choice under its floor), a **relevance** (under 0.8), or, above 250 live lines, a line **not sent**.

Part 3's three direct misses on its held-out set ([results](../results/diag-recall-misses-heldout-part3-direct-2026-09-29.json)):

- "Add an Alembic revision … for a `season` column on the episodes table" missed the rule that a migration may not lock `episodes` for more than a second: relevance 0.96, the choice 0.03, three times out of three, while the migrations line took 0.97 of the choice. A threshold: under the sure level and under part 3's floor (0.05). Part 3b's floor (0.03) keeps it in all three.
- "Write the Flyway migration … named the usual way" missed the naming preference: relevance 0.95 or 0.96, the choice 0.02 or 0.03. The same threshold; part 3b's floor keeps it in one answer of three.
- "Make the Twilio auth token rotation automatic" missed the rotation line because the call ran past 2 s. Asked again, Jev gives it 0.98 and the choice 0.99; word match, which now serves a late call, finds it too.

The dev set showed neither threshold miss (every two-line prompt got both lines), so it got 12 prompts that need two lines. On dev the starved lines mostly sat under 0.94 with the choice at 0.03 or 0.04: a lower sure level barely helped (recall 98/101 at 0.95), and a lower floor did: at 0.03, recall 100/101 against 98/101, two-line prompts with both lines 16/17 against 14/17, no unrelated prompt with a line either way, precision 123/127 against 114/116, the added lines mostly ones labelled fine ([results](../results/diag-recall-sure-dev-2026-09-28.json)). `jevmem init` wrote `recallMin: 0.05` into every project's file, so the floor is a new key, `recallChoiceMin`.

Held-out v2's three misses, on the final code ([results](../results/diag-recall-misses-heldout2-2026-09-29.json)), each the second line of a two-line prompt:

- "Let's deploy stagecue to Fly.io so the director can follow the show from home." got the dead end (hosting on Fly.io was dropped) and missed the rule that the app must run with no internet connection: relevance 0.96, the choice 0.00. A threshold.
- "Call Stripe directly from the new AddOnsController to charge the eco bundle." got the billing-gateway line and missed the preference that anything touching charging ships behind a flag: relevance 0.94, the choice 0.00. A threshold.
- "Store the tariff price per kWh as a float64 in the new tariff element struct." got the line that tariff prices are int64 micro-euros (and one on unit suffixes) and missed the rule that `float64` never holds money: relevance 0.71 to 0.75. A relevance miss; that line is about invoice and payment amounts, and the tariff line already says how the price is stored.

The floor cannot reach a choice of 0.00: when one line takes the whole choice, the second line is kept only at the sure level. None of the three would have been found by word match either. A second relevance question for lines just under the sure level is the next thing to try, on dev; not done here.

### Part 3b: dev, part 3 against part 3b

The dev set gained 12 prompts that need two lines (102 prompts, 101 wanted lines), and the floor was tuned on it; these numbers are not a fair test, held-out v2 is. The build at the end of part 3 (`6e30659`) against part 3b's (`48cc67d`), paired ([part 3](../results/recall-dev-2026-09-28-part3.json), [part 3b](../results/recall-dev-2026-09-28-3b.json)):

| | recall, part 3 | recall, part 3b | precision, part 3 | precision, part 3b | unrelated prompts that got a line, part 3 | part 3b | prompts that got a superseded line, part 3 | part 3b | Jev call failed or past its budget, part 3 | part 3b |
|---|---|---|---|---|---|---|---|---|---|---|
| overall | 99/101 (98%) | 100/101 (99%) | 114/116 (98%) | 122/126 (97%) | 0/18 | 0/18 | 0/102 | 0/102 | 0/102 | 1/102 |
| direct | 32/32 (100%) | 32/32 (100%) | 37/38 (97%) | 38/40 (95%) | – | – | 0/24 | 0/24 | 0/24 | 0/24 |
| indirect | 31/33 (94%) | 32/33 (97%) | 36/37 (97%) | 41/43 (95%) | – | – | 0/24 | 0/24 | 0/24 | 0/24 |
| unrelated | – | – | 0/0 | 0/0 | 0/18 | 0/18 | 0/18 | 0/18 | 0/18 | 1/18 |
| supersede | 18/18 (100%) | 18/18 (100%) | 19/19 (100%) | 19/19 (100%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| dead-end | 18/18 (100%) | 18/18 (100%) | 22/22 (100%) | 24/24 (100%) | – | – | 0/18 | 0/18 | 0/18 | 0/18 |
| small | 17/17 (100%) | 17/17 (100%) | 18/18 (100%) | 19/19 (100%) | 0/4 | 0/4 | 0/20 | 0/20 | 0/20 | 0/20 |
| medium | 37/38 (97%) | 38/38 (100%) | 42/43 (98%) | 43/44 (98%) | 0/6 | 0/6 | 0/36 | 0/36 | 0/36 | 0/36 |
| large | 45/46 (98%) | 45/46 (98%) | 54/55 (98%) | 60/63 (95%) | 0/8 | 0/8 | 0/46 | 0/46 | 0/46 | 1/46 |

| | part 3 | part 3b |
|---|---|---|
| lines injected per prompt | 1.14 | 1.24 |
| hook p50 / p95 | 469 ms / 732 ms | 473 ms / 681 ms |
| Jev call p50 / p95 | 394 ms / 632 ms | 374 ms / 563 ms |
| cost per prompt (calls that answered) | $0.000537 | $0.000533 |
| small file: cost per prompt | $0.000090 | $0.000090 |
| medium file: cost per prompt | $0.000280 | $0.000280 |
| large file: cost per prompt | $0.000932 | $0.000932 |
| prompts served by word match | 0/102 | 1/102 |
| prompts that needed a line and got none | 0/84 | 0/84 |

Part 3b's build injected 10 more lines: one more wanted line, 7 more labelled fine, and 2 more that were neither (4 in all, against 2: 122/126 against 114/116). Cost is unchanged: the questions and what is sent did not change.

### Part 3b: a 500-line file (dev)

Above `jev.maxRecallLines` (250) live lines, recall sends the 250 that share the most words with the prompt, as 0.5.9 did with 60. To measure it, the dev set's 255-line file was grown to 500 lines (445 live) for the same 46 prompts ([`eval/recall-dev-500.jsonl`](../eval/recall-dev-500.jsonl); the 245 new lines share no five-word run with the held-out sets, tested), and run once on `48cc67d` ([results](../results/recall-dev500-2026-09-28-now.json)):

| | 255 lines (225 live), part 3b dev run | 500 lines (445 live) |
|---|---|---|
| recall | 45/46 (98%) | 37/46 (80%) |
| precision, by the 255-line file's labels | 60/63 (95%) | 45/54 (83%) |
| unrelated prompts that got a line | 0/8 | 0/8 |
| superseded lines injected | 0/46 | 0/46 |
| hook p50 / p95 | – | 503 ms / 663 ms |
| Jev call p50 / p95 | – | 426 ms / 576 ms |
| Jev input tokens per prompt | – | 24,801 |
| cost per prompt | $0.000932 | $0.001042 |

Recall fell from 45/46 to 37/46, all of it on direct and indirect prompts (indirect 8/16). 8 of the 9 missed lines were never sent: they were not among the 250 lines sharing the most words with the prompt, which is how indirect prompts are worded. The ninth was sent, and asked again Jev gives it 0.97, the sure level, three times of three; in the run it was not picked ([results](../results/diag-recall-misses-dev500-2026-09-29.json)). Precision is counted with labels written for the 255-line file: 8 of the 9 lines counted as neither wanted nor fine are lines added for the 500-line file, most of them on the prompt's topic (a credit hold, for a question about a buyer who owes money). Latency and cost grow with the 250 lines sent, not with the file. Sending every line, in two requests, would cost about twice as much per prompt on such a file; not done without asking (the proposal is in [DECISIONS.md](../DECISIONS.md)).

### Weak spots

Part 3's, with what part 3b changed:

- **A slow or failed call.** Part 3: a call past the 2-second budget injected nothing (4 of 90 held-out prompts). Since part 3b a call has one second, and past it the prompt gets word-match lines. Word match finds lines that share the prompt's words (dev, as if every prompt had fallen back: direct 25/32) and seldom the others (indirect 3/33), so a slow call still costs the indirect prompts their lines. No held-out v2 call ran late; the fallback is measured on dev only.
- **Two lines for one prompt.** Held-out prompts that needed two lines got both in 3 of 6, in part 3 and again on held-out v2 (0.5.9: 3 of 6 and 1 of 6). When the first line takes the whole choice, the second is kept only at the sure level; part 3b's lower floor does not reach a choice of 0.00.
- **Lines nothing in the prompt points at.** Recall judges each line against the prompt alone. In the outcome A/B below, a convention for every user-facing string was never injected for "add a button" (0 of 3 in both runs), and a terse prompt ("Show the file name in front of each matching line.") got nothing; the same lines in `CLAUDE.md` were always in context. Rules that must apply to every task belong in `CLAUDE.md` ([How it works](how-it-works.md)).
- **Cost per prompt** is about 2.2 to 2.3 times 0.5.9's on the two held-out sets, and about 3.1 to 3.3 times on a 250-line file. Part 3b did not change it.
- **More than 250 live lines** (`jev.maxRecallLines`): the 250 sharing the most words with the prompt are sent. On dev's 500-line file (445 live) recall fell to 37/46 from 45/46 at 255 lines, 8 of the 9 missed lines never sent.
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

**Part 3b: the jevmem arm again, on the final build.** The same 24 tasks, 3 runs each, with the same settings (Claude Code 2.1.281, `claude-sonnet-5`, at most 25 turns, the guard off), on part 3b's final code (`48cc67d`), 2026-09-29 ([results](../results/ab-jevmem-2026-09-29-3b.json)). The other arms were not run again; `CLAUDE.md`'s column is part 3's run:

| | jevmem, part 3 (`9c97ea6`) | jevmem, part 3b (`48cc67d`) | `CLAUDE.md`, part 3 |
|---|---|---|---|
| followed the saved line | 66/72 (92%) | 66/72 (92%) | 67/72 (93%) |
| followed it and did the task | 63/72 (88%) | 63/72 (88%) | 67/72 (93%) |
| conventions | 15/18 | 15/18 | 18/18 |
| decisions | 12/12 | 12/12 | 11/12 |
| constraints | 18/18 | 18/18 | 18/18 |
| dead ends | 15/15 | 15/15 | 15/15 |
| superseded | 6/9 | 6/9 | 5/9 |
| the task's line injected by recall | 64/72 | 66/72 | – |
| recall's Jev call failed or ran late | 0/72 | 0/72 | – |
| Claude opened `JEVMEM.md` itself | 11/72 | 7/72 | – |
| sessions that reached the 25-turn limit | 6/72 | 3/72 | 5/72 |
| median cost of a session | $0.099 | $0.101 | $0.122 |

"Followed" did not move: every task was followed in as many sessions as in part 3, `rb-i18n` and `rb-rating` 0 of 3 again and every other task 3 of 3. The line was injected in two more sessions, both `ls-commit` (3 of 3 against 1 of 3): Jev gives that line a relevance of 0.90 to 0.92, under the sure level, so it is kept when its share of the choice reaches the floor, which part 3b lowered. Every recall call answered within its second, so word match served no prompt.

**What this does not show.** The projects are small: 34 to 42 lines fit easily in a `CLAUDE.md`, and nothing here tests a memory too long to load whole, or how either file is kept current, which is jevmem's other half (the write side, above). Each session is one prompt through `claude -p` with Bash limited, not an interactive session. One model (`claude-sonnet-5`). Several tasks were followed without any memory (`pp-http`, `pp-migrations`, `pp-cache`, `ls-glob`, `ls-workers`: the code or common practice points the same way), and the tasks and checks were written by jevmem's author, before any session.

## The Stop hook with background subagents

Part 3's subagent check (above) found lines in `JEVMEM.md` that nobody meant to save, in 3 of the 12 jevmem and guard sessions, where the subagent ran in the background. Part 3b found the cause in the transcripts, fixed it, and measured the fix on real Claude Code sessions ([DECISIONS.md](../DECISIONS.md)).

**What the transcripts show.** In Claude Code 2.1.281 a subagent started with the Agent tool can run in the background (in an interactive session every subagent does). The main agent writes something like "I've started a subagent on it" and stops; Claude Code runs the `Stop` hooks, with the subagent listed as running in the payload's `background_tasks`. When the subagent is done, its report comes back as a user entry that starts with `<task-notification>`, the main agent goes on, and the `Stop` hooks run again. 0.5.9 and part 3 took every Stop as the end of a turn and the last user entry as your message: they decided the turn while it was still running, with only "I've started a subagent" to go on, and then decided the subagent's report as if you had typed it. The same transcripts show a third problem: when the `Stop` hooks run, the transcript does not yet hold the main agent's last message, which only the payload's `last_assistant_message` has; 0.5.9 used it only when the turn had no other text.

**What changed.** The hook reads the transcript as turns: a prompt you typed and everything the main agent wrote until your next prompt; a task notification is not a prompt. A turn waits while a subagent it launched in the background has not reported back, and is decided once, whole, with its last message: at the Stop that ends it, when your next prompt closes it, or when its session has written nothing for 10 minutes ([Hooks](hooks.md)). A background shell (a dev server) does not hold a turn.

**Method.** Real sessions, captured once: [`scripts/capture-stops.mjs`](../scripts/capture-stops.mjs) runs `claude -p` (Claude Code 2.1.281, `claude-sonnet-5`, an empty `CLAUDE_CONFIG_DIR`, a temporary HOME) in a fresh copy of a small project, with a hook that saves each Stop's payload and the transcript as it was at that moment. Subagents run in the background (`CLAUDE_CODE_FORK_SUBAGENT=1`, as in an interactive session), in the foreground (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), or the prompt asks for none. [`scripts/eval-stops.mjs`](../scripts/eval-stops.mjs) replays each session's Stops in order through a build's real hook (the daemon off, so each Stop is decided before the hook exits; Jev's cache off), each session to each build in turn, and reads what was decided and saved. Each turn's label, a line of a given kind or nothing, was written before any run. A Stop that came before the last one of its prompt's run came while the turn was still running, and must decide nothing. Two sets: dev ([`eval/stops-dev.jsonl`](../eval/stops-dev.jsonl), 24 sessions on the A/B's projects and one more), on which the fix was built, and held-out v4 ([`eval/stops-heldout-v4.jsonl`](../eval/stops-heldout-v4.jsonl), 30 sessions in two new projects: 14 with a background subagent, 4 with a foreground one, 12 with none), captured and committed before the fix (`4c27ec8`), its prompts sharing no five-word run with dev or any other set, and run once at the end on the final code (`48cc67d`) and on 0.5.9.

**Held-out v4, 0.5.9 against `main`, run once** (2026-09-28, finished at 21:58 UTC; [0.5.9](../results/stops-heldout-v4-2026-09-28-v059.json), [`main`](../results/stops-heldout-v4-2026-09-28-now.json)):

| | 0.5.9 | main |
|---|---|---|
| Stops that came while the turn was still running: decided | 16/16 | 0/16 |
| lines saved while the turn was still running | 11 | 0 |
| lines decided from a subagent's report read as your message | 12 | 0 |
| turns: save/skip right | 27/33 (82%) | 31/33 (94%) |
| turns: save/skip and kind right | 24/33 (73%) | 28/33 (85%) |
| turns that got more than one line | 9 | 0 |
| lines saved | 33 | 19 |
| decide calls per turn | 2.30 | 1.39 |
| cost per turn | $0.000327 | $0.000192 |
| background subagent (14 sessions, 15 turns): save/skip, kind | 12/15, 12/15 | 14/15, 14/15 |
| foreground subagent (4 sessions, 4 turns): save/skip, kind | 4/4, 3/4 | 4/4, 3/4 |
| no subagent (12 sessions, 14 turns): save/skip, kind | 11/14, 9/14 | 13/14, 11/14 |

- **No turn was decided while it ran** (0 of 16 such Stops, against 16 of 16), so no line was saved mid-turn (0 against 11), none came from a subagent's report read as your message (0 against 12; 0.5.9 saved lines that begin `<task-notification> <task-id>…`, filed as a bug, a to-do or architecture), and no turn got more than one line (0.5.9: 9 turns).
- **Background-subagent turns: 14 of 15 right, against 12 of 15.** 0.5.9 saved a line for three turns that should save nothing. `main`'s one miss is a turn with two background subagents, labelled a to-do: its one decide call, at the Stop that ended the turn, was under way when the Mac went to sleep (lid closed, on battery; the power log shows it) and failed when the Mac woke. The replay does not retry a failed call, so the turn stayed undecided; in a session the queue retries it. 0.5.9 had a call fail the same way on another session, whose turn still came out right.
- **Turns without a subagent: 13 of 14 against 11 of 14.** Two turns went `main`'s way: a constraint that 0.5.9 did not save, and an answer 0.5.9 saved as architecture. This run does not show why; both builds decide such a turn with the same questions, on text that differs only by the last message. Both builds saved "Explain step by step what recordWatering does." as a bug, from the explanation.
- **Kinds.** Three lines were saved with another kind than the label, by both builds: two stated decisions ("From now on the CLI exits with code 3 for a bad ISBN…", "Going forward, the CLI's check command prints JSON…") as a constraint and a to-do, and a stated preference ("I want plain node:http, no Express…") as a constraint.
- **Cost:** 1.39 decide calls per turn against 2.30, $0.000192 per turn against $0.000327, since a turn is decided once.

**Dev, before and after the fix** (the fix was built on these sessions; [before](../results/stops-dev-2026-09-28-before.json), the build at the end of part 3, `6e30659`; [after](../results/stops-dev-2026-09-28-after.json), the fix, `d1a82cc`):

| | before | after |
|---|---|---|
| Stops that came while the turn was still running: decided | 13/13 | 0/13 |
| lines saved while the turn was still running | 7 | 0 |
| lines decided from a subagent's report read as your message | 12 | 0 |
| turns: save/skip right | 21/26 (81%) | 23/26 (88%) |
| turns: save/skip and kind right | 20/26 (77%) | 22/26 (85%) |
| turns that got more than one line | 7 | 0 |
| lines saved | 28 | 17 |
| decide calls per turn | 2.31 | 1.38 |
| cost per turn | $0.000376 | $0.000193 |
| background subagent (12 sessions, 13 turns): save/skip, kind | 9/13, 9/13 | 11/13, 11/13 |
| foreground subagent (4 sessions, 4 turns): save/skip, kind | 4/4, 4/4 | 4/4, 4/4 |
| no subagent (8 sessions, 9 turns): save/skip, kind | 8/9, 7/9 | 8/9, 7/9 |

**What the scores do not show: the line's text.** The tables score whether a turn was saved and with which kind, not what the line says. Both builds wrote the same text for the same turns, and three of the 19 lines `main` saved say nothing about the project: "Have a subagent find the cause and fix it." and "Send a subagent to find out why and fix it." for two bug reports handed to a subagent, and "Don't implement it yet, just keep it in mind for later." for a to-do. jevmem's own line writer (the default; an LLM writer is opt-in) keeps one sentence of your message, and the hand-off sentence won because it holds a word it looks for with a bug ("fix"); the sentence that described the bug had none. Two of the three lines part 3's subagent check found were this: the request saved as a `[bug]` with "Hand this to a subagent (use your Agent tool)…" in front. Deciding the turn at its end does not change the text a line is written from, and on that request the writer, run again offline, gives the same line. Part 3b fixed when a turn is decided, not this; it is a known miss.

**What this does not show.** `claude -p` only: the turns are one or two prompts, and a background shell dies when the turn ends; an interactive session was not captured. The 10-minute release of a turn whose subagent never reports back is tested in code (`test/turns.test.ts`), not in these runs. One version of Claude Code (2.1.281), whose transcript format jevmem now reads (the `<task-notification>` entries, the `isAsync` launch, `background_tasks`); a later version may change it.
