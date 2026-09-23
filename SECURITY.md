# Security and privacy

This document says exactly what Jevmem sends where, what it stores, what it scrubs, and how to report a problem. It is written for v0.3 and dated 2026-09-23; if it and the code disagree, the code is right and the disagreement is a bug worth reporting.

## What is sent to which API

| Data | Sent to | When | Purpose |
|---|---|---|---|
| The user message of the turn just finished, the previous two turns (truncated), and the id/kind/text of your live memories (up to 200, keyword-filtered) | TypeSafe AI, `POST https://api.typesafe.ai/v1/systemone` | Every `Stop` hook, `jevmem missed`, `jevmem watch` | Jev scores the turn (save? kind? contradiction? injection?) |
| The assistant reply of that turn | TypeSafe AI, same endpoint | Only when you asked a question or reported a bug, or when there is no user text | So a root cause or structure fact the assistant found can be saved |
| Your new prompt and the id/kind/text of up to 60 live memories | TypeSafe AI, same endpoint | Every `UserPromptSubmit` hook, `jevmem search`, MCP `search_memory` | Pick the memories to inject or return |
| A repository snapshot: file tree to depth 3 (names only, no contents), `package.json` fields, the first 3,000 characters of the README, plus every live memory | TypeSafe AI, same endpoint | `jevmem audit`, MCP `audit_memory` | "Is this memory still true?" |
| The source text of a turn that Jev decided to save (user message, or assistant reply when the content came from it) | OpenAI (`OPENAI_API_KEY`, or `OPENAI_BASE_URL`) or Anthropic (`ANTHROPIC_API_KEY`) | Only on a save, only when one of those keys is set | Condense the text into one line |

Nothing is sent anywhere else. There is no telemetry, no analytics endpoint, and no call home. Without `TYPESAFE_API_KEY` nothing is sent at all and the hooks no-op with a log line.

## What is stored locally

| Path | Contents | In git? |
|---|---|---|
| `JEVMEM.md` | The memory lines | Yes, on purpose |
| `jevmem.config.json` | Thresholds, weights, tier settings | Yes |
| `.jevmem/index.json` | A JSON mirror of `JEVMEM.md` | No (`.jevmem/.gitignore` ignores the folder) |
| `.jevmem/log.jsonl` | One line per Jev call: label, tier, tokens, latency, cost, cache hit, and any error | No |
| `.jevmem/decisions.jsonl` | The last 500 decisions: the scrubbed turn text (2,000 chars), every noul probability, the outcome | No |
| `.jevmem/labels.jsonl` | Your `right` / `wrong` / `missed` labels with the Jev answers at the time | No |
| `.jevmem/cache/` | Jev answers keyed by a hash of (model, tier, state, questions) | No |
| `.jevmem/hook-debug.log` | Raw hook payloads, only when `JEVMEM_DEBUG=1` | No |
| `.jevmem/state.json`, `.jevmem/daemon.json`, `.jevmem/daemon.sock` | Last turn hash, daemon pid, local socket (mode 0600) | No |
| `.claude/settings.local.json` | The hook command with absolute paths | No (Claude Code keeps it out of git) |

`.jevmem/decisions.jsonl` and `.jevmem/cache/` contain turn text. If a project is shared as a directory rather than through git, delete `.jevmem/` first.

## What is scrubbed

Before any text is placed into a Jev state or a writer prompt, and again in the Jev client right before the HTTP request, these patterns are replaced with `[REDACTED]` (`src/scrub.ts`, unit-tested):

- API keys and tokens by shape: `sk-…`, `sk-ant-…`, `gh[pousr]_…`, `github_pat_…`, `xox[abprs]-…`, `AKIA…`, `AIza…`, JWTs, `Bearer …`
- `key=value` and `key: value` pairs whose key looks like `api_key`, `token`, `secret`, `password`, `passwd`, `pwd`, `client_secret` (the key name is kept)
- Credentials inside connection strings (`postgres://user:pass@host` becomes `postgres://[REDACTED]@host`)
- Private key blocks (`-----BEGIN … PRIVATE KEY-----`)
- Email addresses and 16-digit numbers (card-number shaped, with or without separators)
- Opaque base64-looking strings of 48+ characters

The scrubber is deliberately over-eager. It does not catch every secret shape that exists; if you paste something unusual, it may go through. Do not paste secrets into prompts.

## Zero data retention

Jevmem can add `zeroDataRetention: true` to every Jev request. It is on automatically when `TYPESAFE_BASE_URL` points at a Vercel AI Gateway host, and you can force it for any endpoint:

```json
{ "jev": { "zeroDataRetention": true } }
```

in `jevmem.config.json`. The flag is a request field that the gateway honours; whether and how long TypeSafe AI itself retains request data is governed by TypeSafe's terms, not by Jevmem. Check https://typesafe.ai for their current policy.

## Where your keys are read from

Hooks do not get your shell profile, so `TYPESAFE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, the base URLs, and `JEVMEM_WRITER*` are read, in order, from the process environment, `<project>/.jevmem/.env`, `~/.jevmem/env`, and then `export NAME=…` lines in `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.profile`. Only those named variables are parsed; the files are not executed. Put the key in `~/.jevmem/env` if you would rather the profiles were not read.

## Files outside the project

`jevmem init --tool codex` is the only command that writes outside the project: it appends an `[mcp_servers.jevmem]` section to `~/.codex/config.toml` if that file exists and has no such section. It prints the path, the backup path, and the exact lines first, and writes a backup next to the file. `jevmem watch` reads `~/.codex/sessions/**/rollout-*.jsonl` for sessions whose `cwd` is this project and writes nothing there.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: https://github.com/Avinash-jetwani/jevmem/security/advisories/new. Please do not open a public issue for a security problem. Expect an acknowledgement within a few days; this is a one-person project in its first weeks.
