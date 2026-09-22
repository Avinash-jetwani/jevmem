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
