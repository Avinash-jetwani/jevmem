# Claude Code hooks

How `jevmem init` registers the hooks, where the hook finds your key, the warm daemon, and what Claude Code actually sends.

## The Claude Code plugin

The plugin lives in [`plugin/`](../plugin) and contains no jevmem code: a manifest, the hook configuration, one short POSIX shell launcher and a README. It runs the `jevmem` CLI you install from npm, so the install is:

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem enable
```

**What it runs.** Both hooks run `"${CLAUDE_PLUGIN_ROOT}/hooks/jevmem-hook.sh"` (quoted, as in Claude Code's plugin docs and as the plugin directory's checklist asks for a plugin in a subfolder): `UserPromptSubmit` synchronously, `Stop` with `"async": true` and `--detach`. The launcher (1) ignores SIGTERM for `--detach`, (2) exits at once in a project without `jevmem.config.json`, (3) finds the `jevmem` CLI with `command -v jevmem`, else at the path it cached in `${CLAUDE_PLUGIN_DATA}/cli` the last time it found one, else in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and `~/.volta/bin`, in that order, else in the newest Node version under `~/.nvm/versions/node` that has it (it runs no package manager to find it), (4) finds Node 20+ to run it with, (5) prints one warning line to stderr when the CLI is older than the plugin, and (6) runs `jevmem hook --plugin`, for `Stop` by saving the hook JSON to a temp file and starting the CLI in its own process group. Steps 4 and 5 are cached in the same file per CLI file and plugin version. The directory list covers the desktop app, which can run hooks with a PATH that lacks `jevmem`. It downloads nothing. As a process, the plugin's Stop launcher took 14 ms p50 against 12 ms for the `init` launcher in the same run (v0.5.6), and 15 ms on a bare PATH with the CLI in `~/.local/bin`, read from the cache after the first run; the turn's decision was recorded 260–272 ms after it started ([Cost math](cost.md#cost-math)).

**When the CLI is missing** (since v0.5.6). In a project without `jevmem.config.json` the launcher still exits before looking for anything, and prints nothing. In an enabled project where it finds no `jevmem` CLI, memory is off, and the `UserPromptSubmit` hook returns one `systemMessage`, which Claude Code shows you: "jevmem: CLI not found, so memory is off in this project. See the jevmem README to set it up", with a link to the README. It is shown once per session (the session ids already told are kept in `${CLAUDE_PLUGIN_DATA}/notified`); the async `Stop` hook stays silent, and both exit 0. A CLI with no Node 20+ to run it gets the same treatment, with "Node.js 20 or newer not found". Until v0.5.5 both cases were silent. The MCP server is the plain command `jevmem mcp`: without `jevmem` on the PATH Claude Code runs with, it fails to start (`/mcp` shows it) until you `npm install -g jevmem`.

**Your key.** Enter your TypeSafe API key with `/plugin configure jevmem@jevmem` in Claude Code; the `claude plugin install` shell command doesn't ask for it. It is the `typesafe_api_key` [user configuration](https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration) option, marked sensitive, so Claude Code keeps it in your system's secure credential store rather than `settings.json`. Claude Code passes it to the hooks as `CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY` and to the MCP server through `${user_config.typesafe_api_key}`. It is used before `TYPESAFE_API_KEY` and `~/.jevmem/env`, which remain the fallbacks when you leave the option empty. jevmem never writes the key to a file or a log.

**The plugin does nothing until you run `jevmem enable` in a project.** Installed for the user (the default), it is loaded in every project you open, but in a project without `jevmem.config.json` its hooks and MCP server make no network calls, create no files and print nothing, and the MCP tools answer only "jevmem isn't enabled in this project: run `jevmem enable`". `jevmem enable` creates `jevmem.config.json`, `JEVMEM.md` and `.jevmem/` and adds `.jevmem/` to `.gitignore`, like `init` without the hooks; `jevmem disable` sets the config aside (in `.jevmem/`, restored by the next `enable`) and leaves `JEVMEM.md` alone. A project that also has `jevmem init` hooks would run jevmem twice per event, so the plugin's hooks stand down there, log it once a day, and show a one-line warning once per session; `jevmem init --remove-hooks` removes the init hooks. On Windows the plugin needs Git for Windows' `sh` on PATH.

## What `init` sets up

`jevmem init` also opts the project in (it writes `jevmem.config.json`). If a project has both the plugin and `init` hooks, the plugin's hooks stand down (nothing runs twice) and say so once per session; `jevmem init --remove-hooks` removes the init hooks and keeps only the plugin.

`jevmem init` creates `JEVMEM.md`, `jevmem.config.json`, a gitignored `.jevmem/` folder, and registers two Claude Code hooks in `.claude/settings.local.json` (per-machine; `jevmem init` adds it to `.gitignore`, and creates a `.gitignore` in a git repository that has none). The file is per-machine because the registered command uses the absolute paths of `node` and the CLI (Claude Code runs hooks without your shell profile and, from the desktop app, with a bare PATH). If you upgrade or move Node, run `jevmem init` again and it repairs the command in place; a jevmem hook found in the shared `.claude/settings.json` is moved to the local file. Every command accepts `--help`.

With no `--tool`, `init` sets up whatever it finds **in the project** (`.claude/`, `.cursor/`, `AGENTS.md`), and Claude Code when it finds nothing. It never looks at your home directory, and it edits `~/.codex/config.toml` only when you pass `--tool codex` or `--tool all`.

| Hook | What it does | Budget |
|---|---|---|
| `Stop` (async) | Reads the turn that just finished, queues it and hands it to the daemon, which makes one Jev call (two on borderline turns: 6–14% of turns in our evals) and writes one line if Jev says so. | Returns in milliseconds; Jev 2 s per call, writer 8 s, in the daemon; exits 0 on any failure (tested by spawning the built CLI) |
| `UserPromptSubmit` | Makes one Jev call to pick the five memories most relevant to your prompt and injects them as context. | Jev 2 s |

That's it. Keep working. `JEVMEM.md` fills itself, and it's a normal file: edit it, commit it, review it in PRs.

By default jevmem writes the line itself: the most relevant sentence of the turn, trimmed to 200 characters at a word boundary, not inside a URL (tested). An LLM writer (OpenAI or Anthropic) condenses the turn instead only when `jevmem.config.json` sets `"writer": "openai"` or `"anthropic"` ([configuration](configuration.md#the-one-line-writer)); an OpenAI or Anthropic key in your environment is not enough on its own. Without `TYPESAFE_API_KEY` the hooks no-op and say so in `.jevmem/log.jsonl`.

**Where the hook finds your key.** Claude Code hooks (and MCP servers started by Cursor, Codex, or Claude Desktop) do not get your shell's variables, and jevmem does not read shell profiles. It looks for `TYPESAFE_API_KEY` (and the writer keys) in this order: the plugin's key setting, the process environment, `<project>/.jevmem/.env`, then `~/.jevmem/env`. The last two are jevmem's own files, which you create. Put `TYPESAFE_API_KEY=...` in `~/.jevmem/env` (and `chmod 600` it). `jevmem doctor` says which one it found, without printing the key.

**When Jev is down.** A Stop turn is first written, scrubbed, to `.jevmem/queue.jsonl`, and turns are evaluated from there oldest first. If Jev times out or answers 408, 429 or 5xx (529 included), the turn stays at the head and is retried after 15 s, 30 s, 1 min, 2 min, 5 min, then every 10 min, on the next hook run or by the idle daemon (which stays up while turns are queued); newer turns wait behind it so a reversal is never decided before the decision it reverses. A turn already decided is not evaluated again (its hash is checked against `.jevmem/decisions.jsonl`; tested). Turns older than 24 hours, or beyond 200 in the queue, are dropped with a `dropped` line in `.jevmem/log.jsonl`. Other errors (a 400, a bad key) drop the turn with a log line as before. `jevmem stats` shows queued, retried, saved-from-queue, dropped and pending counts.

**The Stop hook does not make you wait** (since v0.5.0). `init` registers it with `"async": true`, so Claude Code carries on without waiting for it, and on macOS and Linux its command is the package's POSIX launcher, `sh ".../hooks/jevmem-hook.sh" --node "<node>" --detach hook`. The launcher saves the hook JSON to a temp file, starts node in its own process group and exits: 13–15 ms p50 as a process, against 355 ms for the v0.4.5 hook that waited for Jev through the warm daemon ([Cost math](cost.md#cost-math)). Node then queues the turn and hands it to the daemon, which decides and writes it; the decision was recorded 221–428 ms p50 after the hook started. The own process group matters: when a session ends, Claude Code sends SIGTERM and then SIGKILL to an async hook's process group, and with `claude -p` that happens as soon as the Stop hook starts. On Windows the Stop command is the plain node command, still async. Re-running `jevmem init` upgrades a v0.4 project's Stop hook in place. `UserPromptSubmit` stays synchronous: its output is the context Claude reads.

The first hook call in a project starts a small **warm daemon** (`jevmem daemon status` to see it) that keeps the Jev client's connection open and evaluates the turn queue. It exits after 30 idle minutes (not while turns are queued) and is off with `JEVMEM_DAEMON=0`, in which case the detached hook process evaluates the queue itself. Through the warm daemon, `UserPromptSubmit` takes 302–304 ms end to end including Node start-up, against 629–642 ms as a cold process.

### What the hooks actually receive

Observed on Claude Code CLI 2.0.30. `Stop` carries **no message text**; jevmem reads the last user and assistant turn from `transcript_path` (JSONL). Some newer versions document `last_assistant_message` and `user_prompt`; both shapes are handled.

```json
{"session_id":"…","transcript_path":"~/.claude/projects/<slug>/<session>.jsonl","cwd":"/your/project","permission_mode":"default","hook_event_name":"Stop","stop_hook_active":false}
{"session_id":"…","transcript_path":"…","cwd":"/your/project","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"your prompt text"}
```
