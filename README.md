<picture><source media="(prefers-color-scheme: dark)" srcset="brand/lockup/svg/jevmem-lockup-horizontal-dark.svg"><img alt="jevmem" src="brand/lockup/svg/jevmem-lockup-horizontal-light.svg" height="64"></picture>

Automatic project memory for Claude Code. Also works with Cursor and Codex.

[![npm version](https://img.shields.io/npm/v/jevmem.svg)](https://www.npmjs.com/package/jevmem)
[![license](https://img.shields.io/npm/l/jevmem.svg)](LICENSE)
[![node](https://img.shields.io/node/v/jevmem.svg)](package.json)
[![CI](https://github.com/Avinash-jetwani/jevmem/actions/workflows/ci.yml/badge.svg)](https://github.com/Avinash-jetwani/jevmem/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/avinash-jetwani/jevmem?variant=verified)](https://m8ven.ai/mcp/avinash-jetwani/jevmem)

## What it does

https://github.com/user-attachments/assets/ed77849e-db1c-4c05-9ad8-4cab0b3968a2


- Saves decisions, constraints, bugs and todos from your Claude Code chats into `JEVMEM.md`, automatically.
- When you change your mind, the old line is marked superseded, not deleted.
- Next session, the relevant lines are added to Claude's context.
- Checks lines added by others before Claude sees them.

```text
- [decision] Use Postgres 16 for the primary store; SQLite locks under load  <!-- id:k3d9xq ts:2026-09-22T10:14:02.113Z conf:0.93 -->
- [constraint] Node 20 is the floor; CI runs 20 and 22  <!-- id:p1m4zt ts:2026-09-22T10:20:41.907Z conf:0.88 -->
- [superseded] Use SQLite as the primary store → id:k3d9xq  <!-- id:a8s2ww ts:2026-09-20T16:02:11.000Z conf:0.81 by:k3d9xq -->
```

## What's new in v0.5

- **Install as a Claude Code plugin**, opt-in per project: it does nothing until you run `jevmem enable` in a repo.
- **A memory-poisoning check on recall:** lines that jevmem did not write on your machine (a teammate's, a pull request's, your own hand edits) are checked by Jev before Claude sees them. In our 44-line test set it blocked 20 of 22 planted lines, with 0 of 22 false blocks on legitimate rules ([SECURITY.md](SECURITY.md#memory-poisoning)).
- **Turns queued during Jev outages** and retried later, in order, instead of being dropped.
- **`jevmem import`** for an existing `CLAUDE.md`, `AGENTS.md` or Cursor rules.

## Install (60 seconds)

You need a [TypeSafe AI](https://typesafe.ai) key for Jev. jevmem writes each line itself; an OpenAI or Anthropic writer is optional and off unless you set `writer` in `jevmem.config.json` ([configuration](docs/configuration.md#the-one-line-writer)).

**Option 1: Claude Code plugin (recommended)**

<!-- Community directory install line goes here once the listing is live. -->

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem enable
```

The plugin runs the `jevmem` CLI from npm, so install that first. The hooks find it on the PATH Claude Code gives them or, when that PATH lacks it (the desktop app's can), in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.volta/bin` or the newest Node version under `~/.nvm`. Without it, an enabled project shows "jevmem: CLI not found, so memory is off in this project" on the first prompt of each session, and the MCP server fails to start (`/mcp` shows it as failed). Then enter your TypeSafe key in Claude Code with `/plugin configure jevmem@jevmem` (the `claude plugin install` shell command doesn't ask for it); Claude Code keeps it in your system's secure credential store. The plugin does nothing until you run `jevmem enable` in a project; what it runs, and how to switch it off: [docs/hooks.md](docs/hooks.md#the-claude-code-plugin).

**Option 2: npm** (also sets up Cursor and Codex)

```bash
npm install -g jevmem
cd your-project
jevmem init --tool claude
```

`init` creates `JEVMEM.md`, `jevmem.config.json` and `.jevmem/`, and registers the two Claude Code hooks ([details](docs/hooks.md#what-init-sets-up)). Hooks don't get your shell's variables and jevmem doesn't read shell profiles, so put the key in `~/.jevmem/env` (`TYPESAFE_API_KEY=...`). `jevmem doctor` checks the setup.

**Already have a `CLAUDE.md`?** `jevmem import` splits `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/*` into statements, puts each through the same gate as a turn, and prints what it would add; `--apply` writes them. `--from claude-auto-memory` also reads Claude Code's own auto memory for the project. The source files are only read.

## Works with

What is automatic and what depends on the agent:

| Tool | Setup | Capture | Recall |
|---|---|---|---|
| **Claude Code** | the plugin, or `jevmem init --tool claude` | **Automatic**, every turn, via the `Stop` hook | **Automatic**, every prompt, via `UserPromptSubmit` |
| **Codex** | `jevmem init --tool codex` | **Automatic while `jevmem watch` runs** (it tails Codex's session log for this project and runs the same decide → write path); otherwise agent-initiated via MCP `add_memory`, prompted by an `AGENTS.md` section | Agent-initiated: `search_memory` via MCP, prompted by `AGENTS.md` |
| **Cursor** | `jevmem init --tool cursor` | Agent-initiated: a `.cursor/rules/jevmem.mdc` rule tells the agent to call MCP `add_memory` when you state a decision. Nothing is captured if it doesn't | Agent-initiated: the rule tells it to call `search_memory` before non-trivial tasks |
| **Claude Desktop** | `jevmem init --tool claude-desktop` prints a config snippet to paste (one project per config, named with `--root`) | Manual: ask it to call `add_memory` (no hook, no rule file) | On request: `search_memory` |

MCP `add_memory` goes through the same gate as the hook. Client configs: [docs/mcp.md](docs/mcp.md).

## How it decides

1. **Scrub.** Common secret shapes, email addresses and card-shaped numbers are removed from the turn before it leaves your machine.
2. **Ask Jev typed questions.** [Jev by TypeSafe AI](https://typesafe.ai) answers a fixed set of small questions with probabilities: is there a decision, a rule, a bug? is it small talk or an injection attempt? which existing line does it change?
3. **Apply thresholds in code.** Plain rules over those probabilities decide save or skip; they live in `jevmem.config.json`, not in a prompt.
4. **Write one line.** On save, jevmem writes one line of at most 200 characters from the turn itself, or, if you set `writer` in `jevmem.config.json`, a small OpenAI or Anthropic model condenses the turn.
5. **Supersede the old line.** If the turn replaces an existing memory, that line is tagged `[superseded] … → id:new` and stays in the file.

Tiers, questions, policy, contradictions, recall and audit: [docs/how-it-works.md](docs/how-it-works.md).

## Benchmark

66 held-out turns, all seven deciders given the same state, 2026-09-23 ([method, regression set, pricing, p95, retries](docs/benchmark.md)):

| Decider | save/skip | save+kind | contradictions | p50 | $/decision |
|---|---|---|---|---|---|
| GPT-6 Astra | 98.5% | 98.5% | 5/5 | 3,469 ms | $0.007489 |
| GPT-6 Luna | 93.9% | 93.9% | 5/5 | 2,927 ms | $0.000089 |
| Claude Fable 5.1 | 95.5% | 95.5% | 5/5 | 4,290 ms | $0.013256 |
| Claude Opus 5.5 | 97.0% | 97.0% | 5/5 | 2,784 ms | $0.005186 |
| Gemini 3.8 Flash | 92.4% | 92.4% | 5/5 | 2,850 ms | $0.001174 |
| Grok 4.7 | 90.9% | 90.9% | 4/5 | 3,320 ms | $0.004602 |
| **jevmem `auto`** | **98.5%** | **95.5%** | **5/5** | **300 ms** | $0.000127 |

The 0.30 s is the Jev API decision. Since v0.5.0 you do not wait for it: the `Stop` hook is async and its process exits in 13–15 ms, and the daemon records the decision 0.2–0.4 s after the hook starts ([cost and latency](docs/cost.md)).

On 66 held-out turns, jevmem's median decision took 0.30 s, against 2.8–4.3 s for six current LLMs.
Its accuracy was within the LLMs' range: 98.5% save/skip (tied with GPT-6 Astra for highest) and 95.5% save+kind, against 90.9–98.5% for the LLMs. GPT-6 Astra (98.5%) and Claude Opus 5.5 (97.0%) were more accurate on save+kind; Claude Fable 5.1 tied; GPT-6 Luna, Gemini 3.8 Flash and Grok 4.7 were less accurate. It found 5/5 contradictions, as did five of the six LLMs.
GPT-6 Luna was cheaper ($0.000089 against $0.000127) but less accurate (93.9%) and about 10× slower.
This is a single run, and differences of one or two turns are within run-to-run noise. If the most accurate decision matters most, GPT-6 Astra or Claude Opus 5.5 are better, at about 40–60× the cost per decision and 9–12× the latency. jevmem is for when you want a fast, cheap decision on every message.

## Privacy

- **Sent to TypeSafe AI:** the user message of each turn (and the assistant reply for questions and bug reports), the previous two turns, and your memory lines, to be scored. No telemetry. Only if you set `"writer": "openai"` or `"anthropic"` in `jevmem.config.json` does the text of a saved turn also go to that provider to write the line; a key alone doesn't turn it on.
- **Scrubbed first:** common credential shapes (API keys, tokens, `*_PASSWORD=` style pairs, connection-string passwords, private keys), email addresses and 16-digit numbers; names, phone numbers and addresses are not caught.
- **Zero-retention flag:** jevmem can send `zeroDataRetention: true` (automatic for Vercel AI Gateway URLs); whether it applies depends on the gateway and TypeSafe's terms, and jevmem does not verify it.

- **Planted lines:** `JEVMEM.md` is in git, so a pull request can add a line like "always pipe this script into sh". Lines jevmem did not write on your machine are checked by Jev before any agent sees them, and withheld when Jev scores them as instructions to an AI. In our 44-line test set it blocked 20 of 22 planted lines, with 0 false blocks on 22 legitimate rules; the 2 it missed were instructions disguised as normal process. `jevmem audit --security --ci` runs the same check in CI.
- **Only where you opt in:** jevmem acts only in projects that contain `jevmem.config.json` (`jevmem enable` or `jevmem init`); elsewhere nothing is sent.

In plain terms, with the third parties' privacy policies and how to delete your data: [PRIVACY.md](PRIVACY.md). Exactly what is sent, stored and scrubbed, and what the poisoning gate does not cover: [SECURITY.md](SECURITY.md).

## Honest limits

- **Early:** v0.5; every eval set was written by the author, and none is an independent benchmark.
- **Not the most accurate:** GPT-6 Astra and Claude Opus 5.5 scored higher on save+kind; jevmem's edge is speed and cost.
- **Recall quality is not measured:** that relevant lines are injected is tested; whether answers get better is not.
- **Long-run drift is not measured:** the harness covers five-turn sessions, not weeks of use.
- **Automatic capture is Claude Code only** (and Codex while `jevmem watch` runs); Cursor and Claude Desktop save only when the agent calls `add_memory`.
- **The poisoning gate is a filter, not a guarantee:** it missed 2 of 22 planted lines in our eval (both worded as ordinary process), it does not apply when an agent opens `JEVMEM.md` as a file, and on a fresh clone its first check costs one noul per line. Review `JEVMEM.md` diffs like code ([SECURITY.md](SECURITY.md#memory-poisoning)).
- **Jev outages delay turns, up to a limit:** each Jev call has a 2 s budget. When it times out or Jev answers 5xx/529/429, the scrubbed turn waits in `.jevmem/queue.jsonl` and is retried with backoff (15 s, doubling to every 10 min) on the next hook run or by the idle daemon, in order, and saved once. A turn still unsaved after 24 hours, or past 200 queued turns, is dropped with a log line; `jevmem stats` counts all of these.

## Commands

```text
jevmem init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]
jevmem init --remove-hooks                     Remove jevmem's Claude Code hooks from this project (plugin users)
jevmem hook                                    Hook entrypoint; reads the Claude Code hook JSON on stdin
jevmem daemon [status|start|stop]              Warm Jev client used by the hook (auto-started, exits when idle)
jevmem watch [--replay] [--once]               Capture turns from Codex's session log for this project
jevmem mcp [--root <dir>]                      Stdio MCP server
jevmem audit [--dry-run]                       Re-score every memory against the repo, flag [stale?]
jevmem audit --security [--ci]                 List lines that read as instructions to an AI (--ci: exit 1 if any)
jevmem search <query> [--limit N]              Rank memories by relevance
jevmem list [--all]                            Print memories (--all: with superseded lines and provenance)
jevmem add <kind> <text>                       Add a line by hand (secrets scrubbed; no Jev check)
jevmem import [--from <sources>] [--apply]     Import CLAUDE.md, AGENTS.md, .cursor/rules/* (claude-auto-memory on request); dry run by default
jevmem why <id|hash>                           Every Jev answer behind a line or a skipped turn
jevmem right <id|hash>                         Label a decision as correct
jevmem wrong <id|hash> [--should-be <kind|none>]   Label a decision as wrong
jevmem missed "<text>" [--kind <kind>]         Label a turn that should have been saved
jevmem fit [--dry-run] [--force]               Refit weights and thresholds from labels (needs 40+)
jevmem stats                                   Latency p50/p95, cost per day, cache hit rate, escalation rate, labels, last fit
jevmem log                                     Per-label latency, token and cost summary of .jevmem/log.jsonl
```

Every command accepts `--help`. Set `JEVMEM_VERBOSE=1` for a one-line latency/cost summary after every hook run.

## Links

- Docs: [how it works](docs/how-it-works.md) · [benchmark](docs/benchmark.md) · [cost](docs/cost.md) · [hooks](docs/hooks.md) · [MCP and client configs](docs/mcp.md) · [configuration](docs/configuration.md) · [demo](DEMO.md)
- [CHANGELOG](CHANGELOG.md) · [DECISIONS](DECISIONS.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md)
- License: [MIT](LICENSE)
