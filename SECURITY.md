# Security and privacy

This document says exactly what Jevmem sends where, what it stores, what it scrubs, and how to report a problem. It is written for v0.4.0 and dated 2026-09-23; if it and the code disagree, the code is right and the disagreement is a bug worth reporting.

## What is sent to which API

| Data | Sent to | When | Purpose |
|---|---|---|---|
| The user message of the turn just finished, the previous two turns (truncated), and the id/kind/text of your live memories (up to 200, keyword-filtered) | TypeSafe AI, `POST /v1/systemone` (default base URL `https://api.typesafe.ai`, or `TYPESAFE_BASE_URL`) | Every `Stop` hook, `jevmem missed`, `jevmem watch` | Jev scores the turn (save? kind? contradiction? injection?) |
| The assistant reply of that turn | TypeSafe AI, same endpoint | When a keyword heuristic (`looksLikeQuestion` in `src/decide.ts`) sees a question, an investigation request, or bug-report vocabulary in the user message, or when there is no user text. It is deliberately broad: a `?`, an opening word such as why/how/what/do/is/will/can/explain/debug, or words such as error, fails, broken, stale, wrong, slow, timeout, bug, a `…Error` name, or an HTTP-context 4xx/5xx ("returns 500"). So "Use Sentry for error reporting." also sends the reply. | So a root cause or structure fact the assistant found can be saved (only `bug` and `architecture` may come from the reply) |
| The line an agent passes to MCP `add_memory`, plus the id/kind/text of up to 200 live memories | TypeSafe AI, same endpoint | Every MCP `add_memory` call | The same gate as the hook: injection, small talk, kind, contradiction |
| Your new prompt and the id/kind/text of up to 60 live memories | TypeSafe AI, same endpoint | Every `UserPromptSubmit` hook, `jevmem search`, MCP `search_memory` | Pick the memories to inject or return |
| A repository snapshot: file tree to depth 3 (names only, no contents), `package.json` fields, the first 3,000 characters of the README, plus every live memory | TypeSafe AI, same endpoint | `jevmem audit`, MCP `audit_memory` | "Is this memory still true?" |
| The source text of a turn that Jev decided to save (user message, or assistant reply when the content came from it) | OpenAI (`OPENAI_API_KEY`, or `OPENAI_BASE_URL`) or Anthropic (`ANTHROPIC_API_KEY`) | Only on a hook save, only when one of those keys is set | Condense the text into one line |

Nothing else is sent by Jevmem. There is no telemetry, no analytics endpoint, and no call home. Without `TYPESAFE_API_KEY` nothing is sent at all: the hooks no-op with a log line and MCP `add_memory` refuses. (Starting the MCP server with the recommended `npx -y jevmem mcp` makes npm contact its registry to resolve the package; no project data is sent in that request. Install globally and use `jevmem mcp` to avoid it.)

## What is stored locally

| Path | Contents | In git? |
|---|---|---|
| `JEVMEM.md` | The memory lines | Yes, on purpose |
| `jevmem.config.json` | Thresholds, weights, tier settings | Yes |
| `.jevmem/index.json` | A JSON mirror of `JEVMEM.md` | No (`.jevmem/.gitignore` ignores the folder, and `init` adds `.jevmem/` to the project `.gitignore`) |
| `.jevmem/log.jsonl` | One line per Jev call: label, tier, tokens, latency, cost, cache hit, and any error | No |
| `.jevmem/decisions.jsonl` | The most recent 500–1,000 decisions (trimmed to 500 when it passes 1,000): the scrubbed turn text (2,000 chars), every noul probability, the outcome, which writer produced the line | No |
| `.jevmem/labels.jsonl` | Your `right` / `wrong` / `missed` labels with the Jev answers at the time | No |
| `.jevmem/cache/` | Jev answers (`{model, answers, usage}`), in files named by a hash of (model, tier, state, questions); no turn text | No |
| `.jevmem/hook-debug.log` | Raw hook payloads, only when `JEVMEM_DEBUG=1` | No |
| `.jevmem/state.json`, `.jevmem/daemon.json`, `.jevmem/daemon.sock` | Last turn hash, daemon pid, local socket (mode 0600). For project paths long enough to exceed the Unix socket path limit, the socket is created in the system temp directory instead | No |
| `.claude/settings.local.json` | The hook command with absolute paths to this machine's node and CLI | No: `jevmem init` adds it to the project `.gitignore` (and creates `.gitignore` if the folder is a git repository without one) |

`.jevmem/decisions.jsonl` contains scrubbed turn text; `.jevmem/hook-debug.log` (when enabled) contains raw payloads. If a project is shared as a directory rather than through git, delete `.jevmem/` first.

## What is scrubbed

Before any text is placed into a Jev state or a writer prompt, and again in the Jev client right before the HTTP request, these patterns are replaced with `[REDACTED]` ([src/scrub.ts](src/scrub.ts), tested in [test/scrub.test.ts](test/scrub.test.ts) and [test/policy.test.ts](test/policy.test.ts)):

- API keys and tokens by shape: `sk-…`, `sk-ant-…`, `gh[pousr]_…`, `github_pat_…`, `xox[abprs]-…`, `AKIA…`, `AIza…`, `npm_…`, `hf_…`, `glpat-…`, Stripe `sk_live_…` / `sk_test_…` / `rk_…`, JWTs, `Bearer …`
- Env-style assignments of any length whose name ends in `_PASSWORD`, `_PASSWD`, `_PWD`, `_PASS`, `_SECRET`, `_TOKEN` or `_KEY` (`DB_PASSWORD=x`, `AWS_SECRET_ACCESS_KEY=x`, `GITHUB_TOKEN: x`); the name is kept
- `password`, `passwd`, `pwd`, `pass` followed by `=` or `:` and a value of any length
- `key=value` / `key: value` / `key is value` pairs whose key is exactly `api_key`, `access_token`, `auth_token`, `secret_key`, `client_secret`, `token` or `secret` (as a whole word) and whose value is at least 8 characters
- Credentials inside connection strings (`postgres://user:pass@host` becomes `postgres://[REDACTED]@host`)
- Private key blocks (`-----BEGIN … PRIVATE KEY-----`)
- Email addresses and 16-digit numbers (card-number shaped, with or without separators)
- Opaque base64-looking strings of 48+ characters

**Not caught** (examples, not a complete list): names, phone numbers, postal addresses, national ID numbers, 15-digit Amex numbers, a short value after a key with no underscore such as `apikey: abc`, and credential formats not listed above. The scrubber is deliberately over-eager on what it does match (`primary_key: id` is redacted too), and best effort on everything else. Do not paste secrets into prompts.

**Where scrubbing and the Jev gate apply.** Hook turns (Claude Code `Stop`, `jevmem watch`) and MCP `add_memory` lines are scrubbed and checked by Jev before anything is written; `add_memory` refuses a line that reads as instructions aimed at an AI, small talk, or a duplicate. Lines you type yourself with `jevmem add` or `jevmem missed` are scrubbed but not checked by Jev. Text you edit into `JEVMEM.md` by hand is written as you typed it.

## Zero data retention

Jevmem can add a `zeroDataRetention: true` field to every Jev request. It is added automatically when `TYPESAFE_BASE_URL` points at a Vercel AI Gateway host, and you can force it for any endpoint:

```json
{ "jev": { "zeroDataRetention": true } }
```

in `jevmem.config.json`. That is all Jevmem does: it sends the field (a test checks that it is sent). Whether any retention guarantee applies is the gateway's policy, and for requests that reach TypeSafe AI it is governed by TypeSafe's terms. Jevmem does not verify either. Check https://typesafe.ai and your gateway's documentation for their current policy.

## Where your keys are read from

Hooks do not get your shell profile, so `TYPESAFE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, the base URLs, and `JEVMEM_WRITER*` are read, in order, from the process environment, `<project>/.jevmem/.env`, `~/.jevmem/env`, and then `export NAME=…` lines in `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.profile`. Only those named variables are parsed; the files are not executed. Put the key in `~/.jevmem/env` if you would rather the profiles were not read.

## Files outside the project

`jevmem init` writes outside the project only when Codex is selected explicitly (`--tool codex` or `--tool all`): it then appends an `[mcp_servers.jevmem]` section to `~/.codex/config.toml` if that file exists and has no such section. It prints the path, the backup path, and the exact lines first, and writes a backup next to the file. Plain `jevmem init` detects tools from the project only (`.claude/`, `.cursor/`, `AGENTS.md`) and never edits `~/.codex`, even when Codex is installed (tested). For very deep project paths the daemon socket is created in the system temp directory. `jevmem watch` reads `~/.codex/sessions/**/rollout-*.jsonl` for sessions whose `cwd` is this project and writes nothing there.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: https://github.com/Avinash-jetwani/jevmem/security/advisories/new. Please do not open a public issue for a security problem. Expect an acknowledgement within a few days; this is a one-person project in its first weeks.
