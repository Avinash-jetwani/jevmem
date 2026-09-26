# Configuration

`jevmem.config.json` (all keys optional; these are the defaults):

```json
{
  "memoryFile": "JEVMEM.md",
  "thresholds": {
    "importanceMin": "useful",
    "contentMin": 0.5,
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
  "weights": { "...": "written by `jevmem fit`; omit to use the hand-set defaults" }
}
```

### The one-line writer

`writer.provider` is `"none"` by default: jevmem writes each line itself from the turn, and no text goes to OpenAI or Anthropic. Set `"openai"` or `"anthropic"` (or the shorthand `"writer": "openai"`) to have that provider condense the turn into the line; it then also needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Nothing else turns the LLM writer on: a key in your environment is not enough, and `JEVMEM_WRITER` can only turn it off. Projects set up before v0.5.4 have `"provider": "auto"`, which now means `"none"`; jevmem says so once. `jevmem doctor` and `jevmem stats` show the active writer and why.

`usdPerMillionTokens` is applied to input tokens only. `injectionMax` gates two things: a turn is not saved when its injection family reaches it, and an unverified memory line is not served to an agent when the poisoning gate's noul reaches it ([SECURITY.md](../SECURITY.md#memory-poisoning)).

Environment:

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Jev. Required for decisions, recall, search, audit and MCP `add_memory`. Also read from `<project>/.jevmem/.env` and `~/.jevmem/env`; the plugin's key setting comes first. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Used only when `writer` in `jevmem.config.json` is `"openai"` or `"anthropic"`. |
| `JEVMEM_WRITER` | `none` turns the LLM writer off. Other values are ignored: only the config turns it on. |
| `JEVMEM_WRITER_MODEL` | Override the model (defaults: `gpt-5-mini` with minimal reasoning, `claude-haiku-4-5-20251001`). |
| `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter…). |
| `JEVMEM_VERBOSE` | `1` prints the Jev latency/cost line after each hook run. |
| `JEVMEM_DEBUG` | `1` appends every raw hook payload (and whether the key was found) to `.jevmem/hook-debug.log`. Set it under `"env"` in `.claude/settings.local.json` to debug the desktop app. |
| `JEVMEM_DAEMON` | `0` disables the warm daemon (hook runs inline), `1` forces it on. |
| `JEVMEM_CACHE` | `0` disables the answer cache. |
| `JEVMEM_ROOT` | Project root for `jevmem mcp` when the client has no working directory (same as `--root`). |
| `TYPESAFE_BASE_URL` | Route Jev through a proxy or gateway. A Vercel AI Gateway URL adds the `zeroDataRetention: true` request field automatically. |
| `JEVMEM_LIVE` | `1` enables the live Jev test in `pnpm test`. |
