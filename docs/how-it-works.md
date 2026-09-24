# How it works

## How this differs from the tools' own memory

Each tool has two kinds of built-in memory, and Jevmem is not a replacement for either; it is the layer that the tools and the team share.

| | Built-in auto-memory (e.g. Claude Code's, stored under `~/.claude/projects/…` on your machine) | Project instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`) | Jevmem |
|---|---|---|---|
| Scope | Per tool, per machine | Per tool, per repo | One `JEVMEM.md` per repo, read by Claude Code, Cursor, Codex and Claude Desktop |
| Shared with the team | No | Yes, committed files reviewed in PRs | Yes, a committed file reviewed in PRs |
| Who keeps it current | The tool | You, by hand | Jevmem, after every Claude Code turn (and Codex turns under `watch`, and agent `add_memory` calls) |
| Why a line exists | No per-line scores that we know of | You wrote it | Per-line scores on the machine that saved it: `jevmem why <id>` shows every noul, the kind distribution, importance, and which threshold it cleared |
| What happens on a reversal | Up to the tool; we have not measured it | You edit it (history if the file is in git) | The old line stays, tagged `[superseded] … → id:new`, so history and blame survive |
| Corrections | Edit its files | Edit the file | `right` / `wrong` / `missed` labels, and `fit` retunes the thresholds to your judgement |

The instruction files are shareable today; Jevmem's difference is that it **maintains** its file automatically and **scores** each line. Both can run at once; the end-to-end harness checks that Jevmem behaves the same with Claude Code's auto-memory present or cleared.

## How Jev is used

Jev decides, a model writes one line. Jevmem does not ask Jev to write anything; it asks small, literal, typed questions and combines the answers in code, and only when the answer is "save" does a small LLM (or a deterministic extract) write the line.

### The decider: two tiers (`src/decide.ts`, `src/questions.ts`, `src/combine.ts`)

State sent: `{ user_message, assistant_reply?, previous_turns, existing_memories: [{id, kind, text}] }`. **The user message is the memory.** The assistant reply is included only when a keyword heuristic (`looksLikeQuestion`) sees a question or investigation request (a `?`, or an opening word such as why/how/what/do/is/will/can/explain/debug), or bug-report vocabulary (error, fails, broken, crash, flaky, stale, wrong, slow, timeout, bug, regression, leak, a `…Error` name, or an HTTP-context 4xx/5xx such as "returns 500"), or when there is no user text. The heuristic is deliberately broad ("Use Sentry for error reporting." counts) and it also misses bug reports worded without that vocabulary ("sift panics on files with a UTF-8 BOM"). When the reply is included, only a `bug` or `architecture` fact may come from it; a `meta` family skips replies that are menus of options, "Recorded…" self-summaries, or commentary on memory, hooks, or tooling. Only the current turn and the two before it are sent; the repo tree is not part of the decide state (it is sent by `jevmem audit` only). Secrets are scrubbed first. Memory ids are capped at 200 by a keyword-overlap pre-filter.

**Tier 1 runs on every turn**: nine broad nouls, each with one positive and one negative example, plus the `kind` choice, the `touches_memory_id` choice, and the `importance` score. 2,143–2,259 input tokens per call in our evals.

| Tier-1 noul | Family |
|---|---|
| `contains_decision` | decision |
| `contains_constraint` | constraint |
| `contains_preference` | preference |
| `contains_bug_finding` | bug |
| `contains_architecture_fact` | architecture |
| `contains_todo` | todo |
| `is_only_chit_chat` | chit_chat |
| `contradicts_existing_memory` | contradiction |
| `contains_instructions_aimed_at_an_automated_system` | injection |

**Tier 2 runs only when tier 1 is unsure**: 30 atomic nouls in the same nine families, each with structured `what` / `examples` criteria, combined in code with a logistic score per family. 4,915–5,040 input tokens per call in our evals. The borderline rule (configurable under `tiers.borderline`) escalates when:

- the strongest kind noul is in `[0.3, 0.7]` (set `kindNoulScope: "any"` to test every kind noul; that fires on most real turns because secondary kinds often score 0.3–0.7), or
- the `kind` choice confidence is under 0.6, or
- the `importance` confidence is under 0.5, or
- the injection family is in `[0.3, 0.7]`,

**unless** tier 1 is already sure the turn is skipped (injection > 0.7 or chit-chat ≥ 0.9), where tier 2 could only agree. When tier 2 runs, its result wins. A likely contradiction is *not* an escalation reason (since v0.4.2; `contradictionMin` can turn it back on): escalating every reversal sent it to tier 2, which skipped terse reversals and left the old line live ([Contradictions](how-it-works.md#contradictions)).

`tiers.mode` selects `auto` (default), `fast` (tier 1 only), or `full` (always tier 2). Measured with `node scripts/eval.mjs` (live `jev-latest`, warm in-process client, no cache, v0.4.2, 2026-09-23). Save/skip, kind, contradictions and injection are all scored; cost is input tokens × $0.042 per million (Jev output tokens are free).

**Held-out set** ([`eval/heldout.jsonl`](../eval/heldout.jsonl), 66 turns written for v0.4.0 and committed before any model was run on them; a test fails if any turn shares text with `src/questions.ts` or the regression set). Results: [`results/eval-heldout-2026-09-23-v042.json`](../results/eval-heldout-2026-09-23-v042.json).

| mode | save/skip | save/skip + kind | F1 (save/skip) | input tokens/turn | cost/turn | p50 | p95 | escalated | contradictions | injection not saved |
|---|---|---|---|---|---|---|---|---|---|---|
| `fast` | 98.5% | 95.5% | 98.9% | 2,259 | $0.000095 | 269 ms | 364 ms | – | 5/5 | 6/6 |
| `auto` (default) | 98.5% | 95.5% | 98.9% | 2,948 | $0.000124 | 310 ms | 665 ms | 13.6% | 5/5 | 6/6 |
| `full` | 92.4% | 90.9% | 94.5% | 5,040 | $0.000212 | 322 ms | 429 ms | – | 5/5 | 6/6 |

On the held-out set `full` is below `fast` and `auto` (90.9% against 95.5% save+kind); tier 2 alone skips three turns that tier 1 saves. We have not retuned against these turns (that would make the set no longer held out). The v0.4.2 contradiction fix was built on a separate dev set ([Contradictions](how-it-works.md#contradictions)); this is the held-out set's first run after it.

**Regression set** ([`eval/transcript.jsonl`](../eval/transcript.jsonl), the original 50 turns). Results: [`results/eval-regression-2026-09-23-v042.json`](../results/eval-regression-2026-09-23-v042.json).

| mode | save/skip | save/skip + kind | F1 (save/skip) | input tokens/turn | cost/turn | p50 | p95 | escalated | contradictions | injection not saved |
|---|---|---|---|---|---|---|---|---|---|---|
| `fast` | 98.0% | 96.0% | 98.6% | 2,143 | $0.000090 | 268 ms | 362 ms | – | 2/2 | 4/4 |
| `auto` (default) | 100.0% | 98.0% | 100.0% | 2,443 | $0.000103 | 269 ms | 505 ms | 6.0% | 2/2 | 4/4 |
| `full` | 100.0% | 100.0% | 100.0% | 4,915 | $0.000206 | 276 ms | 355 ms | – | 2/2 | 4/4 |

This 50-turn set was written alongside jevmem, and 33 of its 50 turns share text with the examples inside jevmem's own Jev questions (`src/questions.ts`; the count is pinned by `test/heldout.test.ts`), while the LLMs in the Benchmark get a zero-shot prompt. Treat it as a regression test, not a benchmark. It has 8 decisions, 5 constraints, 4 preferences, 5 bugs, 4 architecture facts, 4 todos, 4 chit-chat, 3 questions, 3 injection attempts, 4 format-instruction turns, and 6 turns lifted verbatim from a real Claude Code desktop session (one of which is a fourth injection turn). The miss in `auto` (and one of the two in `fast`) is a turn that begins with "Decision:" but states a must/never rule. Differences of one or two turns are within run-to-run noise: the same `fast` mode found 26/27 and then 25/27 contradictions on two consecutive dev-set runs.

| Tier-2 family | Atomic nouls |
|---|---|
| decision | `states_a_choice_between_alternatives`, `uses_committal_language`, `names_a_specific_technology_or_approach`, `is_phrased_as_a_question_or_option_list` (negative signal) |
| constraint | `states_a_rule_with_must_never_or_always`, `states_a_numeric_or_version_limit`, `describes_a_consequence_of_breaking_a_rule` |
| preference | `expresses_personal_liking_or_style`, `is_about_how_work_is_done_not_what_is_built`, `uses_prefer_like_rather_or_please` |
| bug | `describes_a_failure_or_incorrect_behavior`, `names_a_root_cause`, `describes_a_fix_that_was_applied`, `mentions_a_test_error_or_stack_trace` |
| architecture | `describes_where_code_or_data_lives`, `describes_how_components_connect_or_data_flows`, `names_modules_services_or_boundaries` |
| todo | `defers_work_to_a_later_time`, `uses_todo_later_next_or_before_launch`, `describes_work_agreed_but_not_done` |
| chit_chat | `is_greeting_thanks_or_acknowledgement`, `contains_no_project_specific_content`, `has_no_fact_decision_or_request` |
| injection | `tells_an_ai_to_ignore_or_replace_instructions`, `claims_system_or_admin_authority_over_the_ai`, `asks_the_ai_to_store_or_alter_memory_or_rules`, `quotes_text_from_a_file_or_page_addressed_to_an_ai` |
| contradiction | `reverses_or_replaces_a_listed_memory`, `uses_change_of_plan_instead_or_actually`, `is_about_the_same_topic_as_a_listed_memory` |
| meta (only with the assistant reply) | `assistant_lists_options_or_next_steps`, `assistant_summarises_its_own_work`, `assistant_comments_on_memory_hooks_or_tooling` |

With the assistant reply in the state, a `content_source` choice (`user_message` | `assistant_reply` | `both` | `none`) is added, and tier 1 asks one broad `assistant_reply_is_meta` noul. The exact wording of every question is in [src/questions.ts](../src/questions.ts).

**Policy** (thresholds in `jevmem.config.json`; `thresholds` applies to tier 2, `tiers.tier1Thresholds` overrides for tier-1 finals; both refitted by `jevmem fit`):

```text
content       = max(decision, constraint, preference, bug, architecture, todo)   # tier 1: the broad noul; tier 2: the logistic family score
reversal      = contradiction >= contradictionMin (0.7) AND touches_memory_id != none
save          = kind != none AND (content >= contentMin (0.5) OR reversal) AND round(importance) >= useful
             AND chit_chat < chitChatMax (0.5) AND injection < injectionMax (0.5)
             AND NOT (source == assistant_reply AND (meta >= metaMax (0.5) OR kind ∉ {bug, architecture}))
contradiction = save AND reversal
```

On `save`, the writer produces one line (≤ 200 chars, cut at a word boundary, not inside a URL, with leading filler such as "Decision:", "Actually,", "So," or "OK," stripped). On `contradiction`, the old line is re-tagged `[superseded]` and gets `→ id:new`. Every decision, saved or skipped, is recorded in `.jevmem/decisions.jsonl` with both tiers' answers and which writer produced the line, so `jevmem why <id>` shows tier 1, and tier 2 if it ran, and which borderline condition caused the escalation.

### Contradictions

When a turn replaces a live memory and jevmem misses it, `JEVMEM.md` keeps both lines active and the tools read two conflicting instructions; when it supersedes a line that was not replaced, a valid memory is hidden. Both are measured on a dev set built for this ([`eval/contradictions-dev.jsonl`](../eval/contradictions-dev.jsonl): 43 cases, 27 reversals of every shape (explicit, implicit, different vocabulary, partial, constraint and preference reversals, one of two similar lines) and 16 same-topic near-misses, 3–15 memories each; no shared text with the prompts or the other eval sets). `node scripts/diag-contradictions.mjs`:

| mode | v0.4.1: found | v0.4.2: found (two runs) | wrong id | false supersedes | p50, turns that save (v0.4.1 → v0.4.2) |
|---|---|---|---|---|---|
| `fast` | 26/27 | 26/27, 25/27 | 0 | 0/16 | 306 ms → 285–289 ms |
| `auto` (default) | 20/27 | 25/27, 25/27 | 0 | 0/16 | 557 ms → 311–323 ms |
| `full` | 19/27 | 25/27, 25/27 | 0 | 0/16 | 277 ms → 298–313 ms |

v0.4.1's `auto` lost reversals by escalating every likely contradiction to tier 2, which then skipped the turn (terse reversals score low on its kind nouls; "I've changed my mind…" nudged its injection nouls), so the old line stayed live. v0.4.2 does not escalate on a contradiction alone, lets a confirmed reversal of a named memory pass the content gate, and tells the injection nouls that changing a project rule is not an injection ([DECISIONS.md](../DECISIONS.md)). The two remaining misses are partial reversals ("…except aim-assist checks…", "…may restart each fiscal year, as long as…"). On the held-out set, run once after the fix, `auto` found 5/5 contradictions in both the eval and the benchmark, with no false supersedes. Results: [`results/contradictions-dev-before.json`](../results/contradictions-dev-before.json), [`results/contradictions-dev-after-run1.json`](../results/contradictions-dev-after-run1.json), [`results/contradictions-dev-after-run2.json`](../results/contradictions-dev-after-run2.json).

### The read side: one call per prompt (`src/recall.ts`)

`UserPromptSubmit` sends `{ query, memories }` (at most 60 candidates after keyword pre-filtering) and asks one `choice`, *"Which memory is most relevant to the query?"*, over the ids plus `none`. The distribution is the ranking; the top five above `recallMin` are injected as `<jevmem-memory>` context, ending with the line "jevmem saves memories automatically; don't write to JEVMEM.md yourself." (nothing is injected when no memory clears `recallMin`). `search_memory` (MCP) and `jevmem search` add one structured noul per candidate, *"Would memory X help answer or act on the query?"*, for up to 50 candidates in the same call.

### Audit: one noul per memory (`src/audit.ts`)

`jevmem audit` snapshots the repo (file tree to depth 3, `package.json`, top of README) and asks per live memory, *"Is memory X still true for this repository, given the snapshot?"* Lines under 0.4 are flagged `[stale?]` in place.

### Cache

Identical `(model, tier, state, questions)` are answered from `.jevmem/cache/` without a request (retries, re-runs, a repeated prompt). Hits are logged with `cacheHit: true` and zero cost; `jevmem stats` shows the hit rate. `JEVMEM_CACHE=0` or `jev.cache: false` disables it.

### Feedback loop

Jev's probabilities are only worth trusting once you check them against your own judgement, so that is a feature:

```bash
jevmem why k3d9xq                   # every noul, family score, choice distribution, and which threshold it cleared
jevmem right k3d9xq                 # the decision was correct
jevmem wrong k3d9xq --should-be none   # it should not have been saved (removes the line)
jevmem wrong 3f1a9c --should-be bug    # a skipped turn (by hash prefix, from `why`) should have been saved as a bug
jevmem missed "We must keep the API backwards compatible for two minor versions." --kind constraint
jevmem fit                          # ≥ 40 labels: refit per-kind weights + thresholds to maximise F1, print a reliability table
jevmem stats                        # p50/p95 latency, cost per day, cache hit rate, escalation rate, label count, last fit
```

`fit` retunes; it does not calibrate Jev's probabilities. It uses whichever tier's answers a label carries: labels with tier-2 answers refit the family weights and `thresholds`; labels with tier-1 answers refit `tiers.tier1Thresholds`. The fit output says how many labels went to each. `JEVMEM.md` ends with a footer such as `<!-- jevmem: 52 labels, last fit 2026-09-22 -->` so a reader knows how much the thresholds have been tuned. `why` works on the machine that saved the line: the decision log is local (`.jevmem/`, not in git) and keeps the most recent 500–1,000 decisions, and lines added with `jevmem add` have no decision behind them.

## Memory file format

```text
- [kind] text  <!-- id:xxxxxx ts:ISO-8601 conf:0.91 -->
```

`kind` ∈ `decision | constraint | preference | bug | architecture | todo | superseded`. Superseded lines carry `→ id:new` in the text and `by:new` in the comment. Audit adds `[stale?]` before the text and `stale:0.31` in the comment. Anything that is not a memory line (headings, prose) is preserved verbatim. The header `init` writes tells AI assistants not to add, edit or remove lines (they otherwise add hand-written duplicates next to jevmem's) and tells people they may edit freely; re-running `init` replaces the pre-0.4.4 default header, and leaves any header you changed alone.

## Security and privacy

- **Retention.** Jevmem can add a `zeroDataRetention: true` field to each Jev request (automatic for Vercel AI Gateway base URLs, or forced with `jev.zeroDataRetention: true`). Whether any retention guarantee applies depends on the gateway and on TypeSafe AI's own terms; Jevmem does not verify it, and the direct TypeSafe endpoint's retention is governed by TypeSafe's policy.
- **Redaction.** Common credential shapes and some PII are redacted before text reaches Jev or the writer: `sk-`/`ghp_`/`github_pat_`/`xox*`/`AKIA`/`AIza`/`npm_`/`hf_`/`glpat-`/Stripe keys, JWTs, bearer tokens, env-style `*_PASSWORD=` / `*_SECRET=` / `*_TOKEN=` / `*_KEY=` of any length, `password=` / `pwd=` / `pass:` of any length, connection-string passwords, private key blocks, email addresses, 16-digit numbers, and 48+ character opaque blobs. It happens twice: inside `decide`, `recall`, `audit` and MCP `add_memory` when the state is built ([src/scrub.ts](../src/scrub.ts)), and again in the Jev client right before the HTTP request. Names, phone numbers, addresses and other formats are **not** caught; [SECURITY.md](../SECURITY.md#what-is-scrubbed) has the full list and [test/scrub.test.ts](../test/scrub.test.ts) the cases. `jevmem add` and `jevmem missed` scrub too; text you edit into `JEVMEM.md` by hand is written as typed.
- **Injection gate.** An injection noul gates every hook save and every MCP `add_memory` line: one broad noul in tier 1, and four atomic injection nouls in tier 2 when it runs. Lines typed with `jevmem add` are not checked by Jev.
- **The warm daemon** listens on a Unix socket with mode 0600 (in `.jevmem/`, or the system temp dir for very long paths; a named pipe on Windows) and only runs the hook code path.
- **Hooks always exit 0** and do not emit a `block` decision, so they do not make Claude continue or loop. A test spawns the built CLI with invalid JSON, no key, a broken transcript, a missing transcript and an unreachable Jev, and asserts exit code 0. A missing key, an unreadable transcript, a Jev timeout, or any exception is logged to `.jevmem/log.jsonl` as a `hook` entry (the missing-key and unreachable-Jev cases are asserted).
- **Files outside the project.** Only `init --tool codex` / `--tool all` write outside the project (the MCP section in `~/.codex/config.toml`); they print the file path, a backup path, and the exact lines before writing, and keep the backup. Plain `init` never touches your home directory.
