# Claude Code hooks

How `jevmem init` registers the hooks, where the hook finds your key, the warm daemon, and what Claude Code actually sends.

## What `init` sets up

`jevmem init` creates `JEVMEM.md`, `jevmem.config.json`, a gitignored `.jevmem/` folder, and registers two Claude Code hooks in `.claude/settings.local.json` (per-machine; `jevmem init` adds it to `.gitignore`, and creates a `.gitignore` in a git repository that has none). The file is per-machine because the registered command uses the absolute paths of `node` and the CLI (Claude Code runs hooks without your shell profile and, from the desktop app, with a bare PATH). If you upgrade or move Node, run `jevmem init` again and it repairs the command in place; a jevmem hook found in the shared `.claude/settings.json` is moved to the local file. Every command accepts `--help`.

With no `--tool`, `init` sets up whatever it finds **in the project** (`.claude/`, `.cursor/`, `AGENTS.md`), and Claude Code when it finds nothing. It never looks at your home directory, and it edits `~/.codex/config.toml` only when you pass `--tool codex` or `--tool all`.

| Hook | What it does | Budget |
|---|---|---|
| `Stop` | Reads the turn that just finished, makes one Jev call (two on borderline turns: 6–14% of turns in our evals), and writes one line if Jev says so. | Jev 2 s per call, writer 8 s; exits 0 on any failure (tested by spawning the built CLI) |
| `UserPromptSubmit` | Makes one Jev call to pick the five memories most relevant to your prompt and injects them as context. | Jev 2 s |

That's it. Keep working. `JEVMEM.md` fills itself, and it's a normal file: edit it, commit it, review it in PRs.

Without an LLM key Jevmem still works: the writer falls back to the most relevant sentence of the turn, trimmed to 200 characters at a word boundary, not inside a URL (tested). Without `TYPESAFE_API_KEY` the hooks no-op and say so in `.jevmem/log.jsonl`.

**Where the hook finds your key.** Claude Code hooks (and MCP servers started by Cursor, Codex, or Claude Desktop) do not load your shell profile. Jevmem therefore looks for `TYPESAFE_API_KEY` (and the optional writer keys) in this order: the process environment, `<project>/.jevmem/.env`, `~/.jevmem/env`, then `export TYPESAFE_API_KEY=…` lines in `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.profile`. Only those named variables are read. If you'd rather it not read your profiles, put the key in `~/.jevmem/env`.

**When Jev is down.** A Stop turn is first written, scrubbed, to `.jevmem/queue.jsonl`, and turns are evaluated from there oldest first. If Jev times out or answers 408, 429 or 5xx (529 included), the turn stays at the head and is retried after 15 s, 30 s, 1 min, 2 min, 5 min, then every 10 min, on the next hook run or by the idle daemon (which stays up while turns are queued); newer turns wait behind it so a reversal is never decided before the decision it reverses. A turn already decided is never evaluated twice (its hash is checked against `.jevmem/decisions.jsonl`). Turns older than 24 hours, or beyond 200 in the queue, are dropped with a `dropped` line in `.jevmem/log.jsonl`. Other errors (a 400, a bad key) drop the turn with a log line as before. `jevmem stats` shows queued, retried, saved-from-queue, dropped and pending counts.

The first hook call in a project starts a small **warm daemon** (`jevmem daemon status` to see it) that keeps the Jev client's connection open. It exits after 30 idle minutes and is off with `JEVMEM_DAEMON=0`. Measured end to end, including Node start-up for the hook process, it saves a little per turn (`Stop` 599 ms against 773 ms cold; `UserPromptSubmit` 429 ms against 522 ms; [Cost math](cost.md#cost-math)).

### What the hooks actually receive

Observed on Claude Code CLI 2.0.30. `Stop` carries **no message text**; jevmem reads the last user and assistant turn from `transcript_path` (JSONL). Some newer versions document `last_assistant_message` and `user_prompt`; both shapes are handled.

```json
{"session_id":"…","transcript_path":"~/.claude/projects/<slug>/<session>.jsonl","cwd":"/your/project","permission_mode":"default","hook_event_name":"Stop","stop_hook_active":false}
{"session_id":"…","transcript_path":"…","cwd":"/your/project","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"your prompt text"}
```
