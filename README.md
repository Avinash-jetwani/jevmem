<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/brand/lockup/svg/jevmem-lockup-horizontal-dark.svg"><img alt="jevmem" src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/brand/lockup/svg/jevmem-lockup-horizontal-light.svg" height="64"></picture>

**Say it once.** jevmem saves the decisions, rules and failed approaches from your Claude Code chats to JEVMEM.md in your repo, and brings the relevant ones back next session. Before Claude runs a command or edits a file, it checks the call against your saved rules. It is open source (MIT), built on TypeSafe AI's Jev, in Anthropic's Claude plugin directory and on the MCP Registry, and works with Cursor and Codex over MCP.

In Anthropic's Claude plugin directory · On the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Avinash-jetwani/jevmem) · Open source, MIT

The docs site, one page per question: [avinash-jetwani.github.io/jevmem](https://avinash-jetwani.github.io/jevmem/)

[![npm version](https://img.shields.io/npm/v/jevmem.svg)](https://www.npmjs.com/package/jevmem)
[![license](https://img.shields.io/npm/l/jevmem.svg)](LICENSE)
[![node](https://img.shields.io/node/v/jevmem.svg)](package.json)
[![CI](https://github.com/Avinash-jetwani/jevmem/actions/workflows/ci.yml/badge.svg)](https://github.com/Avinash-jetwani/jevmem/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/avinash-jetwani/jevmem?variant=verified)](https://m8ven.ai/mcp/avinash-jetwani/jevmem)

https://github.com/user-attachments/assets/65e48f03-8e1c-49d9-baad-6f217911e861

## Why

Each Claude Code session starts with a fresh context, so what you decided last week lives in last week's chat.
A `CLAUDE.md` file helps if you keep it up to date. jevmem keeps a file like it up to date for you, as you work.

## In numbers

In real Claude Code sessions on three small test projects, with jevmem and without it:

- **Claude followed the project's earlier decisions:** in 66 of 72 sessions with jevmem, 28 of 72 without (about 9 in 10, against 4 in 10).
- **Tried a change the project forbids:** in 0 of 18 sessions with jevmem, against 10 of 18 without.
- **Repeated an approach that had already failed:** in 0 of 15, against 3 of 15.
- **Saving:** about 17 cents per 1,000 messages and about a quarter of a second to decide, in the background: Claude doesn't wait for it.
- **Bringing lines back:** about a third to half a second on each prompt, which Claude waits for; the time and the cost grow with the file.
- **To be fair:** a `CLAUDE.md` you keep up to date by hand did about as well (67 of 72), and better on one convention (3 of 3 against 0 of 3). jevmem keeps a file like it up to date for you.

My own test sets, each number from one run; none is an independent benchmark. [Method and results](https://avinash-jetwani.github.io/jevmem/results/)

## How it works

You chat as usual. When you decide something, jevmem writes it as one line in a file in your repo, and brings the right lines back next session.

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/how-it-works-dark.svg"><img alt="You say it, Jev decides, jevmem writes one line to JEVMEM.md, and next session Claude gets the lines that matter." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/how-it-works-light.svg"></picture>

1. You decide something in a chat: "We use Postgres."
2. jevmem asks [Jev by TypeSafe AI](https://typesafe.ai), a model that answers yes/no questions with probabilities, whether it's worth keeping.
3. If it is, jevmem writes one line to `JEVMEM.md` in your repo.
4. Next session, the lines that matter for your prompt go back to Claude.

Change your mind, and the old line is crossed out: kept for history, not sent to Claude. Your team gets the same file through git.

jevmem keeps **decisions, rules, bugs, to-dos and dead ends** (an approach that was tried and failed, with the reason).

```text
- [superseded] We'll use SQLite as the primary store for now. → id:cuasaq
- [decision] Switch the primary store to Postgres 16.
- [constraint] Node 20 is the minimum supported version, and CI runs Node 20 and 22.
```

<details><summary>About these lines</summary>

Each line also carries a comment with its id, time and confidence, left out above. The full lines:

```text
- [superseded] We'll use SQLite as the primary store for now. → id:cuasaq  <!-- id:21ycba ts:2026-09-26T13:46:34.703Z conf:1.00 by:cuasaq -->
- [decision] Switch the primary store to Postgres 16.  <!-- id:cuasaq ts:2026-09-26T13:46:35.240Z conf:1.00 -->
- [constraint] Node 20 is the minimum supported version, and CI runs Node 20 and 22.  <!-- id:tollba ts:2026-09-26T13:46:35.763Z conf:0.90 -->
```

Real lines from 0.5.7's default writer, which 0.5.8 to 0.5.10 did not change ([the run](results/readme-example-2026-09-26.txt), 2026-09-26). It kept one sentence of each turn: the Postgres turn also said "SQLite locks up under concurrent writes", and that reason was left out. Since 0.6.0 the line is made from the sentences Jev picks, the one that states the memory and the one that gives its reason ([What's new](docs/whats-new.md)). With `writer` set, an OpenAI or Anthropic model condenses the whole turn instead.

</details>

## Does it work?

In 72 real Claude Code sessions for each setup, Claude acted on the saved line about as often with jevmem as with the same lines in a hand-written `CLAUDE.md`, and in fewer than half the sessions with neither.

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/results-dark.svg"><img alt="A/B results: followed the project's decision 28 of 72 with no project memory, 66 of 72 with jevmem, 67 of 72 with a hand-written CLAUDE.md." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/results-light.svg"></picture>

| | No project memory | jevmem | Same lines in `CLAUDE.md` |
|---|---|---|---|
| Followed the project's decision | 28 of 72 | **66 of 72** | 67 of 72 |
| Tried a change the project forbids | 10 of 18 | **0 of 18** | 0 of 18 |
| Repeated an approach that had already failed | 3 of 15 | **0 of 15** | 0 of 15 |

So jevmem did about as well as a hand-written `CLAUDE.md`, without you writing it.
`CLAUDE.md` did better on a convention nothing in the prompt points at (3 of 3 against 0 of 3), so rules every task must follow still belong there.
How the sessions were run, and every row: [the benchmark page](docs/benchmark.md#outcome-ab-does-claude-act-on-the-memory).

## The guard (new in 0.6)

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/guard-dark.svg"><img alt="The guard: Claude wants to run a command, jevmem checks it against your saved rules, and Claude Code asks you first." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/guard-light.svg"></picture>

Before Claude runs a command or edits a file, jevmem checks it against your saved rules. If one might break, Claude Code asks you first:

```text
jevmem: this may break a saved rule: "Never commit .env files" (JEVMEM.md)
```

On a test of 274 tool calls, a set the guard was not tuned on, it caught 66 of 68 rule breaks and asked about 3 or 4 of the 206 calls that broke no rule (one run each on 0.6.0 and 0.6.1).
It's a backstop, not a sandbox: it looks at the words a rule and a call share. [How the guard works](docs/guardrails.md).

## Install

You need a [TypeSafe API key](https://console.typesafe.ai/keys), which jevmem's requests are billed to, and Claude Code 2.1.273 or later.

1. In the Claude app: **Plugins → Discover → jevmem → Add**.
2. Install the CLI the plugin runs:
   ```bash
   npm install -g jevmem
   ```
3. Save your key (paste it when asked; it isn't shown):
   ```bash
   jevmem key
   ```
4. In your project's folder, turn jevmem on:
   ```bash
   jevmem enable
   ```

Start Claude Code in that project. `jevmem doctor` checks the setup.

<details><summary>Other ways to install: the jevmem marketplace, npm, Cursor, Codex</summary>

From the jevmem marketplace:

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem enable
```

With npm only (also sets up Cursor and Codex):

```bash
npm install -g jevmem
cd your-project
jevmem init --tool claude    # or cursor, codex, claude-desktop, all
```

Already have a `CLAUDE.md`? `jevmem import` shows what it would add from it; `--apply` writes it.

Every step, and what to do if the plugin can't find the CLI: [docs/install.md](docs/install.md).

</details>

## Works with

Saving is automatic in Claude Code, and in Codex while `jevmem watch` runs. Cursor, Codex and Claude Desktop reach jevmem over MCP, a standard way for an AI tool to call another program, when the agent asks for it.

| | Saving | Bringing it back |
|---|---|---|
| **Claude Code** | Automatic, every turn | Automatic, every prompt |
| **Codex** | Automatic while `jevmem watch` runs | When the agent asks, over MCP |
| **Cursor** | When the agent calls it, over MCP | When the agent asks, over MCP |
| **Claude Desktop** | When you ask it to, over MCP | When you ask it to, over MCP |

The MCP server is on the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Avinash-jetwani/jevmem) as `io.github.Avinash-jetwani/jevmem`. Client setup: [docs/mcp.md](docs/mcp.md) · [docs/install.md](docs/install.md#works-with).

## Fast and cheap

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/benchmark-dark.svg"><img alt="Median time to decide one message on 66 held-out turns: jevmem 0.28 s, six current LLMs 2.78 to 4.29 s." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/benchmark-light.svg"></picture>

Deciding what to save takes 0.27 s and costs $0.00017 per message, in the background: Claude doesn't wait for it.
On whether to save a message at all, jevmem was right as often as the best of six LLMs (98.5%); two of them were better at naming the kind of line.

Measured on 66 turns written before the code and not tuned on, one run of 0.7.0 on 2026-10-08 ([results](results/eval-heldout-2026-10-08-v070.json)); the six LLMs ran on 2026-09-23. All seven in one table, with the cost of each and how it was run: [benchmark](docs/benchmark.md#070-beside-the-six-llms).

## How it decides

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/how-it-decides-dark.svg"><img alt="How jevmem decides: scrub secrets, ask Jev typed questions, apply thresholds in code, write one line, supersede the old line." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/how-it-decides-light.svg"></picture>

No prompt decides what to save: Jev answers small yes/no questions with probabilities, and plain rules in code act on them.

<details><summary>Each step in detail</summary>

1. **Scrub.** Common secret shapes, email addresses and card-shaped numbers are removed from the turn before it leaves your machine.
2. **Ask Jev typed questions.** [Jev by TypeSafe AI](https://typesafe.ai) answers a fixed set of small questions with probabilities: is there a decision, a rule, a bug? is it small talk or an injection attempt? which existing line does it change?
3. **Apply thresholds in code.** Plain rules over those probabilities decide save or skip; they live in `jevmem.config.json`, not in a prompt.
4. **Write one line.** On save, jevmem writes one line of at most 200 characters from the sentences of the turn that Jev picks (the one that states the memory and the one that gives its reason), or, if you set `writer` in `jevmem.config.json`, a small OpenAI or Anthropic model condenses the turn.
5. **Supersede the old line.** If the turn replaces an existing memory, that line is tagged `[superseded] … → id:new` and stays in the file.

Tiers, questions, policy, contradictions, recall and audit: [docs/how-it-works.md](docs/how-it-works.md).

</details>

## Privacy

Your messages go to TypeSafe's API to be scored, with common secrets removed first, and nowhere else unless you set a `writer`.

- jevmem only runs in projects you turn on (`jevmem enable` or `jevmem init`). Elsewhere, nothing is sent.
- Your message, the previous two turns and your memory lines go to TypeSafe's API to be scored, with common secrets scrubbed first. So does Claude's reply on turns that ask a question, report a bug or try something, and, for the guard, the command or the file being changed.
- No telemetry. Nothing goes to OpenAI or Anthropic unless you set `writer` in `jevmem.config.json`.
- Lines a teammate or a pull request adds are checked before Claude sees them.

Exactly what is sent, scrubbed and checked, with the third parties' privacy policies and how to delete your data: [PRIVACY.md](PRIVACY.md). What the check on planted lines does not cover: [SECURITY.md](SECURITY.md).

## Limits

jevmem is young, and these are the limits to know before you rely on it:

- **Early:** 0.7.0, and every test set was written by the author or captured from Claude Code sessions on scratch projects built for it. None is an independent benchmark.
- **Not the most accurate:** two LLMs scored higher at picking the kind of line. jevmem's edge is speed and cost.
- **Answer quality isn't measured:** the tests check that the right lines reach Claude, not that its answers get better.
- **Automatic saving is Claude Code only** (and Codex while `jevmem watch` runs).
- **The guard looks at shared words:** a rule worded far from the command it should catch can be missed.

Every limit, with the numbers: [docs/limits.md](docs/limits.md).

## What's new

What changed, newest first; the measurements behind each line are on the what's new page.

- **0.7.0: fix what it saved.** `jevmem forget` takes an old or wrong line out of use, and `jevmem trust` lets a rule you added by hand block a command, not only ask about it, in the guard's block mode. A line that says the same as a saved one is not saved again: on a test of 25 restatements, 0.6.6 saved 15 as new lines and 0.7.0 saved 1. [Details](docs/whats-new.md).
- **0.6.6: a failed attempt is saved as a dead end, not as a decision.** When you ask Claude to try something and its reply says that failed, jevmem reads the reply: on 40 test turns, 0.6.5 saved 12 as dead ends and 0.6.6 saved 37. The reply is sent on more turns ([PRIVACY.md](PRIVACY.md)). [Details](docs/whats-new.md).
- **0.6.5: a dead end keeps its reason** when Claude's reply gives the verdict first and the cause last. On 13 test turns written that way and handed to the line writer as dead ends, the line kept the reason in 12 (0.6.4: 2 of 13). [Details](docs/whats-new.md).
- **0.6.4: this README, shorter and with graphics;** the details moved to pages in `docs/`. Docs only.
- **0.6.1 to 0.6.3: the guard checks a command with `if [ … ]` in it,** which 0.6.0 let through unchecked, and `jevmem doctor` is clearer. [Details](docs/whats-new.md).
- **0.6: the guard, and dead ends.** Claude Code asks you before a command or edit that may break a saved rule, and an approach that failed is saved with its reason and shown as "Already tried: …" when it comes up again. More of the lines a prompt needs come back, and a turn that hands work to a background subagent is saved once, when it is over. [Details](docs/whats-new.md).

Details and measurements: [docs/whats-new.md](docs/whats-new.md) · Upgrading: [docs/upgrading.md](docs/upgrading.md) · [CHANGELOG](CHANGELOG.md)

<details><summary>Commands</summary>

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
jevmem list [--all]                            Print memories (--all: with superseded and retired lines, and provenance)
jevmem add [--trust] <kind> <text>             Add a line by hand (secrets scrubbed, a leading tag dropped; no Jev check); --trust marks it verified (asks on a terminal)
jevmem forget <id> [<id>…]                     Retire a line in place: it stays in JEVMEM.md as [retired]; a rule asks for a yes on a terminal
jevmem trust <id> [<id>…]                      Mark a line you wrote as verified, after the poisoning gate (asks on a terminal); the guard can then block on it
jevmem import [--from <sources>] [--apply]     Import CLAUDE.md, AGENTS.md, .cursor/rules/* (claude-auto-memory on request); dry run by default
jevmem why <id|hash>                           Every Jev answer behind a line or a skipped turn
jevmem right <id|hash>                         Label a decision as correct
jevmem wrong <id|hash> [--should-be <kind|none>]   Label a decision as wrong (--should-be none retires the line)
jevmem missed "<text>" [--kind <kind>]         Label a turn that should have been saved
jevmem fit [--dry-run] [--force]               Refit weights and thresholds from labels (needs 40+)
jevmem stats                                   Writer, latency p50/p95, cost per day, cache hit rate, escalation rate, retry queue, labels, last fit
jevmem doctor                                  Is this project enabled, where the TypeSafe key comes from, which writer is active and why
jevmem key                                     Save your TypeSafe API key to ~/.jevmem/env (asks for it without showing it)
jevmem log                                     Per-label latency, token and cost summary of .jevmem/log.jsonl
jevmem guard test "<command>" | --edit <path>  Dry run of the PreToolUse guard on one call: rules, prefilter, Jev's answer, hook output
jevmem guard log [-n 20]                       The guard's recent asks and denials in this project, with the rule and score
```

These are 0.7.0's commands: 0.5.10's, `jevmem guard` (0.6.0), and `forget`, `trust` and `add --trust` (0.7.0). Every command accepts `--help`. Set `JEVMEM_VERBOSE=1` for a one-line latency/cost summary after every hook run.

</details>

## Links

- Docs: [how it works](docs/how-it-works.md) · [install](docs/install.md) · [the guard](docs/guardrails.md) · [dead ends](docs/dead-ends.md) · [benchmark](docs/benchmark.md) · [cost](docs/cost.md) · [hooks](docs/hooks.md) · [MCP and client configs](docs/mcp.md) · [configuration](docs/configuration.md) · [limits](docs/limits.md) · [demo](DEMO.md)
- [CHANGELOG](CHANGELOG.md) · [Releases](https://github.com/Avinash-jetwani/jevmem/releases) · [DECISIONS](DECISIONS.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md)
- Built on [Jev by TypeSafe AI](https://typesafe.ai). License: [MIT](LICENSE)
