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
  "writer": { "provider": "auto", "maxChars": 200, "timeoutMs": 8000 },
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

`usdPerMillionTokens` is applied to input tokens only. `injectionMax` gates two things: a turn is not saved when its injection family reaches it, and an unverified memory line is not served to an agent when the poisoning gate's noul reaches it ([SECURITY.md](../SECURITY.md#memory-poisoning)).

## Pi setup and API key

Pi support requires the jevmem extension and project initialization. After publishing, run `pi install npm:jevmem` once (or `pi install --local npm:jevmem` for one trusted project), then `jevmem init --tool pi` in each project and restart Pi. From a local checkout, build and use `pi -e ./dist/pi-extension.js` instead of installing from npm. The extension is inert where `JEVMEM.md` has not been initialized.

`TYPESAFE_API_KEY` is required for automatic recall and capture. Obtain it from https://typesafe.ai. To make it available to Pi without placing a secret in project files, create `~/.jevmem/env` with a single line `TYPESAFE_API_KEY=your-key-here` and restrict the file to your user (`chmod 600 ~/.jevmem/env`). Alternatively export the variable in the environment that launches Pi. Restart Pi after configuring it. Never paste a real key into a Pi prompt, commit it, or put it in `.pi/settings.json`. Without the key, jevmem logs a no-op in `.jevmem/log.jsonl`; it cannot evaluate or recall turns. An optional `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` enables the one-line writer; without either, jevmem uses its deterministic writer.

Environment:

| Variable | Purpose |
|---|---|
| `TYPESAFE_API_KEY` | Jev. Required for decisions, recall, search, audit and MCP `add_memory`. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | The one-line writer. Auto-detected; first one present wins. |
| `JEVMEM_WRITER` | `openai`, `anthropic`, or `none` to force a provider. |
| `JEVMEM_WRITER_MODEL` | Override the model (defaults: `gpt-5-mini` with minimal reasoning, `claude-haiku-4-5-20251001`). |
| `OPENAI_BASE_URL` | Any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter…). |
| `JEVMEM_VERBOSE` | `1` prints the Jev latency/cost line after each hook run. |
| `JEVMEM_DEBUG` | `1` appends every raw hook payload (and whether the key was found) to `.jevmem/hook-debug.log`. Set it under `"env"` in `.claude/settings.local.json` to debug the desktop app. |
| `JEVMEM_DAEMON` | `0` disables the warm daemon (hook runs inline), `1` forces it on. |
| `JEVMEM_CACHE` | `0` disables the answer cache. |
| `JEVMEM_ROOT` | Project root for `jevmem mcp` when the client has no working directory (same as `--root`). |
| `TYPESAFE_BASE_URL` | Route Jev through a proxy or gateway. A Vercel AI Gateway URL adds the `zeroDataRetention: true` request field automatically. |
| `JEVMEM_LIVE` | `1` enables the live Jev test in `pnpm test`. |
