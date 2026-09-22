# Decisions

Design decisions made while building Jevmem v1, with the reasoning, so they can be revisited deliberately.

## Product

- **Name is Jevmem.** Package `jevmem`, memory file `JEVMEM.md`, cache dir `.jevmem/`, config `jevmem.config.json`, env prefix `JEVMEM_`.
- **The Stop hook evaluates the whole turn, not just the user prompt.** The state Jev sees is `USER: … / ASSISTANT: …`. Decisions usually come from the user, but bug root causes and architecture facts usually come from the assistant. Evaluating both in one call costs nothing extra.
- **One Jev call per turn, always.** Every question (nine nouls, two choices, one score) goes in a single `systemOne` request. Jev evaluates them independently and in parallel, so batching is free and keeps the hook at one round trip.
- **The read side uses `choice` probabilities, not nouls.** `UserPromptSubmit` must be fast and cheap. A single `choice` over memory ids returns a full distribution, which is enough to rank and take the top five. `search_memory` (MCP) and `jevmem search` add one noul per candidate (capped at 50) because there a per-item relevance score is worth the extra tokens.
- **Importance uses the rounded expected score.** Jev returns a probability-weighted mean over the five levels. `round(score) >= index("useful")` is more stable than argmax when the distribution is split between two adjacent levels.
- **Contradiction needs two signals.** `contradicts_existing_memory >= 0.7` AND `touches_memory_id != none`. Either alone produces false supersedes: the noul fires on "we changed our mind about something" even when no listed memory is the target.
- **Superseded lines stay in the file.** They are tagged `[superseded]` and get `→ id:new`, which keeps `git blame` and history readable and lets `audit` reason about what changed. They are excluded from recall and search.

## Jev usage

- **Every choice has a `none` option**, every noul is phrased positively with a single condition, and every score level is a concrete situation rather than an adjective. This follows the Jev docs on literal reading, indirection, and score rubrics.
- **Memory ids are capped at 200 per `touches_memory_id` choice.** Jev supports 255 options, but accuracy drops with irrelevant context, so above the cap the code pre-filters by keyword overlap with the message. The same filter feeds recall.
- **Secrets are scrubbed at the client boundary** (`createJev`) and again before the writer LLM. The scrubber is deliberately over-eager (long opaque blobs, `key=value` pairs, connection-string credentials, private key blocks). A redacted token never harms a memory decision.
- **The hook hard-times-out Jev at 2 s** with no SDK retries (`maxRetries: 0` on the timed call). A missed memory is cheaper than a slow prompt. The CLI commands (`audit`, `search`) use the SDK defaults (10 s, one retry) because nobody is waiting on a keystroke.
- **Cost is computed as tokens × $0.042 / M** (the figure given in the brief) and is configurable in `jevmem.config.json` under `jev.usdPerMillionTokens`, since the public docs do not state a price.

## Writer

- **No OpenAI or Anthropic SDK dependency.** Both providers are called with `fetch` directly (chat completions and Messages API). It keeps the install small and the hook start-up fast.
- **Defaults: `gpt-5-mini` for OpenAI, `claude-haiku-4-5-20251001` for Anthropic.** Provider is auto-detected from whichever key is present; `JEVMEM_WRITER` forces one and `JEVMEM_WRITER_MODEL` overrides the model.
- **The fallback is the first substantive sentence**, with role prefixes and code fences removed, clamped to 140 characters. It is deterministic so tests and the no-key path are reproducible.
- **Duplicate lines are dropped after writing.** If the writer produces a line identical (case-insensitive) to a live memory and nothing was superseded, the new line is removed again. This costs one extra file write and avoids a second Jev call.

## Claude Code hook

- **The hook command is resolved at `init` time.** If `node_modules/.bin/jevmem` exists in the project the command is `npx jevmem hook`; if the CLI runs from a global install it is `jevmem hook`; otherwise (a checkout, or an `npx` cache) it is `node "<absolute path to cli.js>" hook`. `--command` overrides it. A bare `npx jevmem` would hit the network on every turn when the package is not installed locally.
- **Hooks are merged into `.claude/settings.json`, never overwritten.** Existing hook groups and permissions are kept. Detection is by an existing command matching `jevmem … hook`, so re-running `init` is idempotent.
- **Timeouts:** Stop hook 20 s (Jev 2 s + writer 8 s + slack), UserPromptSubmit 5 s. Both always exit 0.
- **The same turn is never evaluated twice.** A SHA-1 of the merged turn is stored in `.jevmem/state.json`; Stop can fire more than once per turn.
- **Simulation fields.** The hook accepts `user_message`, `assistant_message`, and `recent_context` in the stdin JSON in addition to the real `transcript_path`. That is what the tests and `DEMO.md` use, and it makes the hook scriptable from other tools.

## v0.3.1: two-tier decide

- **The literal borderline rule escalated 80% of turns.** With "any kind noul in [0.3, 0.7]" and "importance confidence < 0.6", 32 of 40 eval turns escalated (reason histogram: `contains_decision` 17, `contains_constraint` 12, `contains_architecture_fact` 11, importance 10, `contains_bug_finding` 3, preference 4, contradiction 1), and `auto` cost more than `full`. The cause is that a real decision turn also reads 0.4–0.6 on a neighbouring kind (constraint, architecture); tier 1 was right on 39 of those 40 turns regardless. The shipped rule keeps every condition from the brief but (a) applies the band to the strongest kind noul by default (`kindNoulScope: "max"`, with `"any"` still available), (b) adds `kind` choice confidence < 0.6 as a condition, (c) lowers the importance-confidence floor to 0.5 (its p25 across the set is 0.56), and (d) never escalates when tier 1 already scored injection > 0.7 or chit-chat ≥ 0.9, because tier 2 can only confirm a skip. Result: 15% escalation (6 of 40: the contradiction, three low-kind-confidence turns, two low-importance-confidence turns) at the same 97.5%.
- **Tier 2 keeps 1+1 examples.** Cutting tier 2 from two examples per side to one held 97.5% on three consecutive runs and dropped ~800 tokens per tier-2 call, so it stays at 1+1 (`tiers.tier2ExamplesPerSide: 1`; set 2 to restore).
- **Tier 1 is 2,318 tokens, not ≤ 2,000.** The twelve questions serialize to about 1,700 tokens after trimming every `what` to a clause and dropping `not_for` from the compact kind criteria; the remaining ~600 are the state (message, two previous turns, the memory list) and JSON framing, which no wording change removes. Trimming the compact importance rubric to summary + signals only lost a todo turn (95%), so `what` stays on the importance levels and "work agreed for later" is the first Useful signal.
- **Cost target missed, and why.** v0.2.0's twelve questions used plain-string criteria at 1,897 tokens. Adding one positive and one negative example to each noul is what the brief asked for and is worth ~400 tokens; that alone is 1.22× v0.2.0. With 15% escalation to a 5,463-token tier 2, `auto` averages 3,138 tokens, 1.65×. Getting to 1.3× would need escalation under 5% or a cheaper tier 2, neither of which we could justify on a 40-turn set where the escalated turns are exactly the ones (contradiction, low confidence) tier 2 exists for. `fast` mode is the 1.2× option for anyone who wants it.
- **Tier 1 uses the same policy shape as tier 2.** Each broad noul is its family's score, so `content = max kind noul`, and `evaluatePolicy` is shared. The only difference is that tier-1 finals read `tiers.tier1Thresholds` (fitted from tier-1 labels) over `thresholds`. That keeps `why` and `fit` symmetric across tiers.
- **Cache keys carry the tier** so a tier-1 and tier-2 call on the same state never collide, and the log carries it so `stats` can compute the escalation rate as tier-2 decide calls over tier-1 decide calls.

## v0.3.0: Jev at its maximum

- **Decomposition tied, and we kept it anyway.** On the 40-turn hand-labelled transcript (`eval/transcript.jsonl`: 8 decisions, 5 constraints, 4 preferences, 5 bugs, 4 architecture facts, 4 todos, 4 chit-chat, 3 questions, 3 injection attempts), the v0.2.0 set of 9 broad nouls scored 97.5% and the v0.3.0 set of 30 atomic nouls scored 92.5% with the first hand weights and 97.5% after one tuning pass, on two consecutive runs. Both sets miss the same turn ("Can you explain how the cache layer works?" → the assistant's reply is a genuine architecture fact, which both classify as `architecture`; the label says skip because it is derivable from the code). The brief said to keep whichever scored higher; they tie, so the tie-breaker is what the atomic set enables: `why` can show which specific signal fired, and `fit` has 30 features to refit instead of 9. The cost is 3.3× the tokens per `decide` ($0.00026 vs $0.00008); latency is unchanged because Jev runs the questions in parallel. A 40-turn set is small (one turn is 2.5 points) and Jev's answers vary slightly between runs, so the honest claim is "no worse", not "better".
- **What the tuning pass changed.** The first hand weights gave every noul 2.0 with bias −3, which needs two strong nouls per family. Live answers showed each family has one "core" noul that fires alone (a constraint with must/never fires `states_a_rule_with_must_never_or_always` at 0.98 while the numeric-limit and consequence nouls stay near 0). Core nouls now carry 2.5–3.5, secondaries 1.0–2.0, bias −2.5. The `importance` rubric also gained "work agreed for later (a todo)" under Useful because a bare `TODO:` line was scored Minor.
- **`content` gates on the max kind family, `kind` still comes from the choice.** Jev is good at choice; the atomic nouls are better at "is there anything here at all". Requiring both means a fitted model cannot save a turn the choice called `none`; that is deliberate, and `missed` labels exist to catch it.
- **`fit` refits only what labels can teach.** Kind families are fitted against `label.kind`; `chit_chat` against "not saved and kind none"; `injection` and `contradiction` keep their defaults because the labels carry no injection or contradiction ground truth. Thresholds are grid-searched for F1 of `save`. Weights are pulled toward the hand-set start (small L2) so 40 labels cannot flip a family upside down.
- **Cache keys include the model.** A `jev-latest` upgrade changes answers; keying on `(model, state, questions)` means old entries simply stop matching. The daemon prewarm is never cached (its point is the network round trip).
- **Zero data retention is a passthrough flag.** The TypeSafe SDK forwards extra request fields; `zeroDataRetention: true` is what Vercel AI Gateway honours. It is only added when configured or when the base URL is a gateway, because an unknown field on the direct endpoint could be rejected.
- **Cursor is not tailed.** Cursor stores chats in `state.vscdb` (SQLite) under `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/`. Reading it would need a native SQLite dependency and would touch data outside the project and outside a plain log directory, so Cursor relies on the MCP path with an always-on rule. Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with `session_meta.cwd` and `phase: "final_answer"` assistant messages, which is exactly what a tailer needs, so `watch` supports Codex only.
- **`init --tool codex` edits `~/.codex/config.toml` only when it already exists and lacks `[mcp_servers.jevmem]`**, by appending. It never rewrites the file.

## Warm daemon

- **Why a daemon and not a faster process.** The CLI itself starts in ~70 ms; the missing ~400 ms per cold hook call was TLS and connection setup to `api.typesafe.ai` in a brand-new process. Only a long-lived process can amortise that. The daemon is one `net.Server` on a Unix socket in `.jevmem/` (named pipe on Windows), holding one `TypeSafeClient`, and it runs the exact same `runHook` code path.
- **The hook never waits on the daemon.** It tries to connect for 250 ms; on failure it does the work inline and spawns the daemon detached for the next turn. A crashed or outdated daemon costs one cold turn, never a broken one.
- **Idle exit, not a service.** No launchd/systemd, no global process: one daemon per project, it exits after 30 idle minutes, and `.jevmem/daemon.json` records the pid so `jevmem daemon status/stop` can find it. A pre-warm call of one tiny noul (~300 tokens, about a hundredth of a cent) opens the connection so even the first real turn after start is warm.
- **Scrub at the source, not only at the boundary.** The reviewer could not find scrubbing in `decide.ts` because it lived only in the client wrapper. It now happens in both places; the test suite (which mocks the client) can therefore prove it.

## Repo / tooling

- **Single package, not a workspace.** The brief said monorepo; one package with a CLI, hook, MCP server, and library entry is simpler to install (`npx jevmem`) and there is nothing yet that would justify a second package. The layout (`src/`, `test/`, tsup, vitest, eslint) is ready to become `packages/jevmem` if a second package appears.
- **ESM only, Node 20+.** Matches `@typesafe-ai/sdk` and the MCP SDK.
- **`pnpm-workspace.yaml` exists only to allow esbuild's postinstall** (pnpm 11 `allowBuilds`). It declares no packages.
- **zod v4** is used for MCP tool schemas (supported by `@modelcontextprotocol/sdk` ≥ 1.23).

## Lessons from the first live run

- **Jev reads literally, so the injection guard must name the attack, not the audience.** "Instructions aimed at an AI assistant" is true of every prompt in a coding session. The question now describes overriding rules or planting memory, and the criteria carry both true and false examples ("Switch the primary store to Postgres 16" is listed as false). Structured criteria with `what` + `examples` fixed it in one iteration.
- **Fallback extraction is kind-aware.** Questions are skipped, cue words per kind are rewarded, and for `bug`/`architecture` the assistant's sentence wins. The LLM writer makes this moot, but the no-key path should still produce a usable line.

## Verification without a key

- The first end-to-end run used a local mock of `POST /v1/systemone` (selected with `TYPESAFE_BASE_URL`) to exercise the SDK, HTTP, CLI, and file writes before a key was available. The mock is deliberately not shipped: the live run (`DEMO.md`, bottom) and `JEVMEM_LIVE=1 pnpm test` are the source of truth, and the mock would have hidden the injection-wording bug above.
