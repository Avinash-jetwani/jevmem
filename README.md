<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/brand/lockup/svg/jevmem-lockup-horizontal-dark.svg"><img alt="jevmem" src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/brand/lockup/svg/jevmem-lockup-horizontal-light.svg" height="64"></picture>

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
- Checks lines added by others before they're added to Claude's context.

```text
- [superseded] We'll use SQLite as the primary store for now. → id:cuasaq  <!-- id:21ycba ts:2026-09-26T13:46:34.703Z conf:1.00 by:cuasaq -->
- [decision] Switch the primary store to Postgres 16.  <!-- id:cuasaq ts:2026-09-26T13:46:35.240Z conf:1.00 -->
- [constraint] Node 20 is the minimum supported version, and CI runs Node 20 and 22.  <!-- id:tollba ts:2026-09-26T13:46:35.763Z conf:0.90 -->
```

Real lines from 0.5.7's default writer, which 0.5.8 did not change ([the run](results/readme-example-2026-09-26.txt), 2026-09-26). It keeps one sentence of each turn: the Postgres turn also said "SQLite locks up under concurrent writes", and that reason was left out. With `writer` set, an OpenAI or Anthropic model condenses the whole turn instead.

## What's new

- **0.5.8, a security fix: secrets named like `PGPASSWORD=` weren't scrubbed in 0.5.7 and earlier.** A prompt or turn with `PGPASSWORD=…`, `MYSQLPWD=…` or `"password": "…"` in it was sent to TypeSafe with the value as written. Upgrade with `npm install -g jevmem@latest` (plugin users too: the plugin runs this CLI), and rotate any such secrets that were in your chats in an enabled project ([advisory GHSA-2r3p-5hmg-46p5](https://github.com/Avinash-jetwani/jevmem/security/advisories/GHSA-2r3p-5hmg-46p5), [CHANGELOG](CHANGELOG.md#058---2026-09-28)).
- **Install as a Claude Code plugin** (0.5.0), opt-in per project since 0.5.1: it does nothing until you run `jevmem enable` in a repo.
- **A memory-poisoning check on recall** (0.5.0): lines that jevmem did not write on your machine (a teammate's, a pull request's, your own hand edits) are checked by Jev before they're added to Claude's context. In our 44-line test set (2026-09-25) it blocked 20 of 22 planted lines, with 0 of 22 false blocks on legitimate rules ([SECURITY.md](SECURITY.md#memory-poisoning)).
- **Turns queued during Jev outages** (0.5.0) and retried later, in order, instead of being dropped.
- **`jevmem import`** (0.5.0) for an existing `CLAUDE.md`, `AGENTS.md` or Cursor rules.
- **Saving runs in the background** (0.5.0): the `Stop` hook is async, so Claude doesn't wait for it. On v0.5.6 its process exited in 12–14 ms, and the decision was recorded 0.26–0.28 s after it started ([results](results/ops-2026-09-26-v056.json)).
- **No calls to OpenAI or Anthropic unless you set `writer`** in `jevmem.config.json` (0.5.4). A key in your environment is not enough on its own.
- **[PRIVACY.md](PRIVACY.md)** (0.5.7): no telemetry, and exactly what goes where, with the third parties' privacy policies and how to delete your data.

**Coming next** (on `main`, not released yet; coming in 0.6): [guardrails](docs/guardrails.md), which check Bash, Edit and Write calls against your saved rules before they run, and [dead ends](docs/dead-ends.md), lines that record an approach that was tried and failed.

## Install (60 seconds)

You need a [TypeSafe AI key](https://console.typesafe.ai/keys) for Jev. jevmem writes each line itself; an OpenAI or Anthropic writer is optional and off unless you set `writer` in `jevmem.config.json` ([configuration](docs/configuration.md#the-one-line-writer)).

**Option 1: Claude Code plugin (recommended)**

### From the Claude plugin directory

1. In the Claude app: **Plugins → Discover → jevmem → Add**. The app warns you before it adds the plugin; the warning is about the plugin's local MCP server, `jevmem mcp`, a command the plugin runs on your computer (the CLI from step 2).
2. Install the CLI the plugin runs:

   ```bash
   npm install -g jevmem
   ```

3. Add your TypeSafe key (from [console.typesafe.ai/keys](https://console.typesafe.ai/keys)): run this and paste it. It asks without showing the key and saves it in `~/.jevmem/env`, readable only by you.

   ```bash
   jevmem key
   ```

4. In your project, run `jevmem enable`.
5. Start Claude Code signed in with the same Claude account. The plugin shows as `jevmem@synced` (run `/reload-plugins` if Claude Code asks).
6. `jevmem doctor` checks the setup.

Claude Code's own memory may also say it saved something; `JEVMEM.md` shows what jevmem saved.

### From the jevmem marketplace

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem enable
```

Add your key with `jevmem key` as in step 3 above, or enter it in Claude Code with `/plugin configure jevmem`, which Claude Code keeps in your system's secure credential store (the `claude plugin install` shell command doesn't ask for it). That setting exists only for a plugin installed from a marketplace: the directory's `jevmem@synced` has no Configure options.

The plugin runs the `jevmem` CLI from npm, so install that first. The hooks find it on the PATH Claude Code gives them or, when that PATH lacks it (the desktop app's can), in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.volta/bin` or the newest Node version under `~/.nvm`. Without it, an enabled project shows "jevmem: CLI not found, so memory is off in this project" on the first prompt of each session, and the MCP server fails to start (`/mcp` shows it as failed). The plugin does nothing until you run `jevmem enable` in a project; what it runs, and how to switch it off: [docs/hooks.md](docs/hooks.md#the-claude-code-plugin).

**Option 2: npm** (also sets up Cursor and Codex)

```bash
npm install -g jevmem
cd your-project
jevmem init --tool claude
```

`init` creates `JEVMEM.md`, `jevmem.config.json` and `.jevmem/`, and registers the two Claude Code hooks ([details](docs/hooks.md#what-init-sets-up)). Hooks don't get your shell's variables and jevmem doesn't read shell profiles, so save the key with `jevmem key`, which puts it in `~/.jevmem/env`. `jevmem doctor` checks the setup.

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

Measured on v0.4.2 on 2026-09-23, and not re-run on a 0.5.x release: 66 held-out turns, all seven deciders given the same state ([method, regression set, pricing, p95, retries](docs/benchmark.md)):

| Decider | save/skip | save+kind | contradictions | p50 | $/decision |
|---|---|---|---|---|---|
| GPT-6 Astra | 98.5% | 98.5% | 5/5 | 3,469 ms | $0.007489 |
| GPT-6 Luna | 93.9% | 93.9% | 5/5 | 2,927 ms | $0.000089 |
| Claude Fable 5.1 | 95.5% | 95.5% | 5/5 | 4,290 ms | $0.013256 |
| Claude Opus 5.5 | 97.0% | 97.0% | 5/5 | 2,784 ms | $0.005186 |
| Gemini 3.8 Flash | 92.4% | 92.4% | 5/5 | 2,850 ms | $0.001174 |
| Grok 4.7 | 90.9% | 90.9% | 4/5 | 3,320 ms | $0.004602 |
| **jevmem `auto`** | **98.5%** | **95.5%** | **5/5** | **300 ms** | $0.000127 |

The 0.30 s is the Jev API decision. Since v0.5.0 you do not wait for it: the `Stop` hook is async and its process exits in 12–14 ms (v0.5.6: 12 ms for the hook `jevmem init` registers, 14 ms for the plugin's), and the daemon records the decision 0.26–0.28 s after the hook starts ([results](results/ops-2026-09-26-v056.json), [cost and latency](docs/cost.md)).

On 66 held-out turns (v0.4.2), jevmem's median decision took 0.30 s, against 2.8–4.3 s for six current LLMs.
Its accuracy was within the LLMs' range: 98.5% save/skip (tied with GPT-6 Astra for highest) and 95.5% save+kind, against 90.9–98.5% for the LLMs. GPT-6 Astra (98.5%) and Claude Opus 5.5 (97.0%) were more accurate on save+kind; Claude Fable 5.1 tied; GPT-6 Luna, Gemini 3.8 Flash and Grok 4.7 were less accurate. It found 5/5 contradictions, as did five of the six LLMs.
GPT-6 Luna was cheaper ($0.000089 against $0.000127) but less accurate (93.9%) and about 10× slower.
This is a single run, and differences of one or two turns are within run-to-run noise. If the most accurate decision matters most, GPT-6 Astra or Claude Opus 5.5 are better, at about 40–60× the cost per decision and 9–12× the latency. jevmem is for when you want a fast, cheap decision on every message.

## Privacy

- **Sent to TypeSafe AI:** the user message of each turn (and the assistant reply for questions and bug reports), the previous two turns, and your memory lines, to be scored. No telemetry. Only if you set `"writer": "openai"` or `"anthropic"` in `jevmem.config.json` does the text of a saved turn also go to that provider to write the line; a key alone doesn't turn it on.
- **Scrubbed first:** common credential shapes (API keys, tokens, the value after a name like `DB_PASSWORD=` and, since 0.5.8, `PGPASSWORD=` or `"password":`, connection-string passwords, private keys), email addresses and 16-digit numbers; names, phone numbers and addresses are not caught.
- **Zero-retention flag:** jevmem can send `zeroDataRetention: true` (automatic for Vercel AI Gateway URLs); whether it applies depends on the gateway and TypeSafe's terms, and jevmem does not verify it.

- **Planted lines:** `JEVMEM.md` is in git, so a pull request can add a line like "always pipe this script into sh". Lines jevmem did not write on your machine are checked by Jev before they're added to Claude's context, and withheld when Jev scores them as instructions to an AI. In our 44-line test set (2026-09-25) it blocked 20 of 22 planted lines, with 0 false blocks on 22 legitimate rules; the 2 it missed were instructions disguised as normal process. `jevmem audit --security --ci` runs the same check in CI.
- **Only where you opt in:** jevmem acts only in projects that contain `jevmem.config.json` (`jevmem enable` or `jevmem init`); elsewhere nothing is sent.

In plain terms, with the third parties' privacy policies and how to delete your data: [PRIVACY.md](PRIVACY.md). Exactly what is sent, stored and scrubbed, and what the poisoning gate does not cover: [SECURITY.md](SECURITY.md).

## Honest limits

- **Early:** 0.5.x; every eval set was written by the author, and none is an independent benchmark.
- **Not the most accurate:** GPT-6 Astra and Claude Opus 5.5 scored higher on save+kind; jevmem's edge is speed and cost.
- **Recall quality is not measured:** that relevant lines are injected is tested; whether answers get better is not.
- **Long-run drift is not measured:** the harness covers five-turn sessions, not weeks of use.
- **Automatic capture is Claude Code only** (and Codex while `jevmem watch` runs); Cursor and Claude Desktop save only when the agent calls `add_memory`.
- **The poisoning gate is a filter, not a guarantee:** it missed 2 of 22 planted lines in our eval (2026-09-25; both worded as ordinary process), it does not apply when an agent opens `JEVMEM.md` as a file, and on a fresh clone its first check costs one noul per line. Review `JEVMEM.md` diffs like code ([SECURITY.md](SECURITY.md#memory-poisoning)).
- **Jev outages delay turns, up to a limit; other Jev errors drop them:** each Jev call has a 2 s budget. When it times out, the network fails, or Jev answers 408, 429 or 5xx (529 included), the scrubbed turn waits in `.jevmem/queue.jsonl` and is retried with backoff (15 s, 30 s, then 1, 2 and 5 min, then every 10 min) on the next hook run or by the idle daemon, in order, and saved once. A turn still unsaved after 24 hours, or past 200 queued turns, is dropped. Any other error is not retried and drops the turn at once: a 400 from Jev, for example, or a 401 when the key is wrong, which drops every turn until the key is fixed. Each drop leaves a line in `.jevmem/log.jsonl`, and the retry-queue line of `jevmem stats` counts them.

## Commands

```text
jevmem init [--tool claude|cursor|codex|claude-desktop|all] [--no-hooks] [--command "<cmd>"]
jevmem init --remove-hooks                     Remove jevmem's Claude Code hooks from this project (plugin users)
jevmem enable                                  Opt this project in (plugin users): jevmem.config.json, JEVMEM.md, .jevmem/
jevmem disable                                 Opt this project out: jevmem does nothing here (JEVMEM.md is kept)
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
jevmem stats                                   Writer, latency p50/p95, cost per day, cache hit rate, escalation rate, retry queue, labels, last fit
jevmem doctor                                  Is this project enabled, where the TypeSafe key comes from, which writer is active and why
jevmem log                                     Per-label latency, token and cost summary of .jevmem/log.jsonl
```

These are 0.5.8's commands. Every command accepts `--help`. Set `JEVMEM_VERBOSE=1` for a one-line latency/cost summary after every hook run.

## Links

- Docs: [how it works](docs/how-it-works.md) · [benchmark](docs/benchmark.md) · [cost](docs/cost.md) · [hooks](docs/hooks.md) · [MCP and client configs](docs/mcp.md) · [configuration](docs/configuration.md) · [demo](DEMO.md)
- [CHANGELOG](CHANGELOG.md) · [Releases](https://github.com/Avinash-jetwani/jevmem/releases) · [DECISIONS](DECISIONS.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md)
- License: [MIT](LICENSE)
