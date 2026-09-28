# Configuration

`jevmem.config.json` (all keys optional; these are the defaults):

```json
{
  "memoryFile": "JEVMEM.md",
  "thresholds": {
    "importanceMin": "useful",
    "contentMin": 0.5,
    "deadEndMin": 0.7,
    "chitChatMax": 0.5,
    "injectionMax": 0.5,
    "metaMax": 0.5,
    "contradictionMin": 0.7,
    "staleBelow": 0.4,
    "recallTopK": 5,
    "recallMin": 0.05
  },
  "jev": { "model": "jev-latest", "timeoutMs": 2000, "maxIdsPerCall": 200, "maxRecallCandidates": 60,
           "usdPerMillionTokens": 0.042, "cache": true, "zeroDataRetention": "auto" },
  "writer": { "provider": "none", "maxChars": 200, "timeoutMs": 8000 },
  "daemon": { "enabled": true, "idleMinutes": 30 },
  "tiers": {
    "mode": "auto",
    "borderline": { "kindNoulScope": "max", "kindNoulLow": 0.3, "kindNoulHigh": 0.7, "kindConfidenceMin": 0.6,
                    "contradictionMin": 1.01, "importanceConfidenceMin": 0.5, "injectionLow": 0.3, "injectionHigh": 0.7,
                    "sureSkipChitChatMin": 0.9 },
    "tier2ExamplesPerSide": 1,
    "tier1Thresholds": { "...": "written by `jevmem fit` from tier-1 labels; omit to use `thresholds`" }
  },
  "weights": { "...": "written by `jevmem fit`; omit to use the hand-set defaults" },
  "guard": { "mode": "ask", "askMin": 0.5, "blockMin": 0.9, "budgetMs": 1000, "maxCandidates": 3 }
}
```

`guard` (on `main`, not yet released) sets the PreToolUse guard: `mode` is `ask`, `block`, `warn` or `off`; Jev's score must reach `askMin` for the guard to act and `blockMin` to deny in `block` mode; `budgetMs` is the hook's own time budget; `maxCandidates` caps the rules asked about per call. An unknown mode or an out-of-range value makes the guard stand aside (no decision, logged). A `blockMin` below `askMin` is refused, and the guard uses the defaults for both (0.5 and 0.9), which `jevmem doctor` and `jevmem guard test` show. In `block` mode only a rule jevmem wrote on this machine can deny; a rule from an unverified line is asked about. See [Guardrails](guardrails.md).

### The one-line writer

`writer.provider` is `"none"` by default: jevmem writes each line itself from the turn, and no text goes to OpenAI or Anthropic. Set `"openai"` or `"anthropic"` (or the shorthand `"writer": "openai"`) to have that provider condense the turn into the line; it then also needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Nothing else turns the LLM writer on: a key in your environment is not enough, and `JEVMEM_WRITER` can only turn it off. Projects set up before v0.5.4 have `"provider": "auto"`, which now means `"none"`; jevmem says so once. `jevmem doctor` and `jevmem stats` show the active writer and why.

#### OpenAI-compatible endpoints

With `"writer": "openai"`, `OPENAI_BASE_URL` points the writer at any OpenAI-compatible chat-completions endpoint instead of api.openai.com, with `OPENAI_API_KEY` as that endpoint's key and `JEVMEM_WRITER_MODEL` as its model id (for example `openai/gpt-5-mini` on OpenRouter). On `main` (not yet released):

- A reasoning model (a `gpt-5*` or `o`-series id, with or without a provider prefix such as `openai/`) is asked for `reasoning_effort: "minimal"` on every endpoint, as OpenRouter documents the parameter. Before, jevmem asked only api.openai.com, and through OpenRouter gpt-5-mini spent its 1,000 completion tokens on reasoning and returned an empty line for 14 of 29 dev dead ends (7 of 29 in part 2's run); with it, 0 of 29 ([results](../results/dead-ends-writer-dev-2026-09-27-gpt-5-mini-2b.json)).
- An endpoint that rejects `reasoning_effort` with a 400 that names it gets the request once more without it.
- When the endpoint fails or returns an empty line, jevmem writes the line itself.
- Every such case is logged to `.jevmem/log.jsonl`, and `jevmem doctor` and `jevmem stats` list them under failures ("writer fallbacks"). `jevmem doctor` also shows the endpoint.

0.5.7 asks only api.openai.com for minimal reasoning, and falls back without saying so.

`usdPerMillionTokens` is applied to input tokens only. `injectionMax` gates two things: a turn is not saved when its injection family reaches it, and an unverified memory line is not served to an agent when the poisoning gate's noul reaches it ([SECURITY.md](../SECURITY.md#memory-poisoning)).

Environment:

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Jev. Required for decisions, recall, search, audit and MCP `add_memory`. Also read from `<project>/.jevmem/.env` and `~/.jevmem/env` (by the MCP server too on `main`; 0.5.7's reads only its environment); the plugin's key setting comes first. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Used only when `writer` in `jevmem.config.json` is `"openai"` or `"anthropic"`. |
| `JEVMEM_WRITER` | `none` turns the LLM writer off. Other values are ignored: only the config turns it on. |
| `JEVMEM_WRITER_MODEL` | Override the model (defaults: `gpt-5-mini` with minimal reasoning, `claude-haiku-4-5-20251001`). |
| `OPENAI_BASE_URL` | Any OpenAI-compatible chat-completions endpoint (OpenRouter, Groq, Ollama…) for the `openai` writer. See [below](#openai-compatible-endpoints). |
| `JEVMEM_VERBOSE` | `1` prints the Jev latency/cost line after each hook run. |
| `JEVMEM_DEBUG` | `1` appends every raw hook payload (and whether the key was found) to `.jevmem/hook-debug.log`. Set it under `"env"` in `.claude/settings.local.json` to debug the desktop app. |
| `JEVMEM_DAEMON` | `0` disables the warm daemon (hook runs inline), `1` forces it on. |
| `JEVMEM_CACHE` | `0` disables the answer cache. |
| `JEVMEM_ROOT` | Project root for `jevmem mcp` when the client has no working directory (same as `--root`). |
| `TYPESAFE_BASE_URL` | Route Jev through a proxy or gateway. A Vercel AI Gateway URL adds the `zeroDataRetention: true` request field automatically. |
| `JEVMEM_LIVE` | `1` enables the live Jev test in `pnpm test`. |
