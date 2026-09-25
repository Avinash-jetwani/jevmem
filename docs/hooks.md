# Claude Code hooks

How `jevmem init` registers the hooks, where the hook finds your key, the warm daemon, and what Claude Code actually sends.

## What `init` sets up

`jevmem init` creates `JEVMEM.md`, `jevmem.config.json`, a gitignored `.jevmem/` folder, and registers two Claude Code hooks in `.claude/settings.local.json` (per-machine; `jevmem init` adds it to `.gitignore`, and creates a `.gitignore` in a git repository that has none). The file is per-machine because the registered command uses the absolute paths of `node` and the CLI (Claude Code runs hooks without your shell profile and, from the desktop app, with a bare PATH). If you upgrade or move Node, run `jevmem init` again and it repairs the command in place; a jevmem hook found in the shared `.claude/settings.json` is moved to the local file. Every command accepts `--help`.

With no `--tool`, `init` sets up whatever it finds **in the project** (`.claude/`, `.cursor/`, `AGENTS.md`), and Claude Code when it finds nothing. It never looks at your home directory, and it edits `~/.codex/config.toml` only when you pass `--tool codex` or `--tool all`.

| Hook | What it does | Budget |
|---|---|---|
| `Stop` (async) | Reads the turn that just finished, queues it and hands it to the daemon, which makes one Jev call (two on borderline turns: 6–14% of turns in our evals) and writes one line if Jev says so. | Returns in milliseconds; Jev 2 s per call, writer 8 s, in the daemon; exits 0 on any failure (tested by spawning the built CLI) |
| `UserPromptSubmit` | Makes one Jev call to pick the five memories most relevant to your prompt and injects them as context. | Jev 2 s |

That's it. Keep working. `JEVMEM.md` fills itself, and it's a normal file: edit it, commit it, review it in PRs.

Without an LLM key Jevmem still works: the writer falls back to the most relevant sentence of the turn, trimmed to 200 characters at a word boundary, not inside a URL (tested). Without `TYPESAFE_API_KEY` the hooks no-op and say so in `.jevmem/log.jsonl`.

**Where the hook finds your key.** Claude Code hooks (and MCP servers started by Cursor, Codex, or Claude Desktop) do not load your shell profile. Jevmem therefore looks for `TYPESAFE_API_KEY` (and the optional writer keys) in this order: the process environment, `<project>/.jevmem/.env`, `~/.jevmem/env`, then `export TYPESAFE_API_KEY=…` lines in `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.profile`. Only those named variables are read. If you'd rather it not read your profiles, put the key in `~/.jevmem/env`.

**When Jev is down.** A Stop turn is first written, scrubbed, to `.jevmem/queue.jsonl`, and turns are evaluated from there oldest first. If Jev times out or answers 408, 429 or 5xx (529 included), the turn stays at the head and is retried after 15 s, 30 s, 1 min, 2 min, 5 min, then every 10 min, on the next hook run or by the idle daemon (which stays up while turns are queued); newer turns wait behind it so a reversal is never decided before the decision it reverses. A turn already decided is not evaluated again (its hash is checked against `.jevmem/decisions.jsonl`; tested). Turns older than 24 hours, or beyond 200 in the queue, are dropped with a `dropped` line in `.jevmem/log.jsonl`. Other errors (a 400, a bad key) drop the turn with a log line as before. `jevmem stats` shows queued, retried, saved-from-queue, dropped and pending counts.

**The Stop hook does not make you wait** (since v0.5.0). `init` registers it with `"async": true`, so Claude Code carries on without waiting for it, and on macOS and Linux its command is the package's POSIX launcher, `sh ".../bin/jevmem-hook.sh" --node "<node>" --detach hook`. The launcher saves the hook JSON to a temp file, starts node in its own process group and exits: 13–15 ms p50 as a process, against 355 ms for the v0.4.5 hook that waited for Jev through the warm daemon ([Cost math](cost.md#cost-math)). Node then queues the turn and hands it to the daemon, which decides and writes it; the decision was recorded 221–428 ms p50 after the hook started. The own process group matters: when a session ends, Claude Code sends SIGTERM and then SIGKILL to an async hook's process group, and with `claude -p` that happens as soon as the Stop hook starts. On Windows the Stop command is the plain node command, still async. Re-running `jevmem init` upgrades a v0.4 project's Stop hook in place. `UserPromptSubmit` stays synchronous: its output is the context Claude reads.

The first hook call in a project starts a small **warm daemon** (`jevmem daemon status` to see it) that keeps the Jev client's connection open and evaluates the turn queue. It exits after 30 idle minutes (not while turns are queued) and is off with `JEVMEM_DAEMON=0`, in which case the detached hook process evaluates the queue itself. Through the warm daemon, `UserPromptSubmit` takes 302–304 ms end to end including Node start-up, against 629–642 ms as a cold process.

### What the hooks actually receive

Observed on Claude Code CLI 2.0.30. `Stop` carries **no message text**; jevmem reads the last user and assistant turn from `transcript_path` (JSONL). Some newer versions document `last_assistant_message` and `user_prompt`; both shapes are handled.

```json
{"session_id":"…","transcript_path":"~/.claude/projects/<slug>/<session>.jsonl","cwd":"/your/project","permission_mode":"default","hook_event_name":"Stop","stop_hook_active":false}
{"session_id":"…","transcript_path":"…","cwd":"/your/project","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"your prompt text"}
```
