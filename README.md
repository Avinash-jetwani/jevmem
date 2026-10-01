<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/brand/lockup/svg/jevmem-lockup-horizontal-dark.svg"><img alt="jevmem" src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/brand/lockup/svg/jevmem-lockup-horizontal-light.svg" height="64"></picture>

**Say it once.** jevmem writes down what you decide in Claude Code and brings it back next session.

In Anthropic's Claude plugin directory · On the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Avinash-jetwani/jevmem) · Open source, MIT

[![npm version](https://img.shields.io/npm/v/jevmem.svg)](https://www.npmjs.com/package/jevmem)
[![license](https://img.shields.io/npm/l/jevmem.svg)](LICENSE)
[![node](https://img.shields.io/node/v/jevmem.svg)](package.json)
[![CI](https://github.com/Avinash-jetwani/jevmem/actions/workflows/ci.yml/badge.svg)](https://github.com/Avinash-jetwani/jevmem/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/avinash-jetwani/jevmem?variant=verified)](https://m8ven.ai/mcp/avinash-jetwani/jevmem)

https://github.com/user-attachments/assets/ed77849e-db1c-4c05-9ad8-4cab0b3968a2

## Why

Each Claude Code session starts with a fresh context, so what you decided last week lives in last week's chat.
A `CLAUDE.md` file helps if you keep it up to date. jevmem keeps a file like it up to date for you, as you work.

## How it works

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

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/results-dark.svg"><img alt="A/B results: followed the project's decision 28 of 72 with no project memory, 66 of 72 with jevmem, 67 of 72 with a hand-written CLAUDE.md." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/results-light.svg"></picture>

| | No project memory | jevmem | Same lines in `CLAUDE.md` |
|---|---|---|---|
| Followed the project's decision | 28 of 72 | **66 of 72** | 67 of 72 |
| Tried a change the project forbids | 10 of 18 | **0 of 18** | — |
| Repeated an approach that had already failed | 3 of 15 | **0 of 15** | 0 of 15 |

So jevmem does about as well as a hand-written `CLAUDE.md`, without you writing it.
`CLAUDE.md` did better on a convention nothing in the prompt points at (3 of 3 against 0 of 3), so rules every task must follow still belong there.
Method, dates and builds: [What's new](docs/whats-new.md).

## The guard (new in 0.6)

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/guard-dark.svg"><img alt="The guard: Claude wants to run a command, jevmem checks it against your saved rules, and Claude Code asks you first." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/guard-light.svg"></picture>

Before Claude runs a command or edits a file, jevmem checks it against your saved rules. If one might break, Claude Code asks you first:

```text
jevmem: this may break a saved rule: "Never commit .env files" (JEVMEM.md)
```

On a held-out test of 274 tool calls, it caught 66 of 68 rule breaks, with 3–4 false asks in 206 fine calls.
It's a backstop, not a sandbox: it looks at the words a rule and a call share. [How the guard works](docs/guardrails.md).

## Install

You need a [TypeSafe API key](https://console.typesafe.ai/keys) and Claude Code 2.1.273 or later.

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

| | Saving | Bringing it back |
|---|---|---|
| **Claude Code** | Automatic, every turn | Automatic, every prompt |
| **Codex** | Automatic while `jevmem watch` runs | When the agent asks, over MCP |
| **Cursor** | When the agent calls it, over MCP | When the agent asks, over MCP |
| **Claude Desktop** | When you ask it to, over MCP | When you ask it to, over MCP |

The MCP server is on the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.Avinash-jetwani/jevmem) as `io.github.Avinash-jetwani/jevmem`. Client setup: [docs/mcp.md](docs/mcp.md) · [docs/install.md](docs/install.md#works-with).

## Fast and cheap

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/benchmark-dark.svg"><img alt="Median time to decide one message on 66 held-out turns: jevmem 0.28 s, six current LLMs 2.78 to 4.29 s." src="https://raw.githubusercontent.com/Avinash-jetwani/jevmem/main/docs/img/benchmark-light.svg"></picture>

Deciding what to save takes 0.28 s and costs $0.00016 per message, in the background: Claude doesn't wait for it.
jevmem tied the best LLM on save or skip (98.5%); two LLMs were better at picking the kind of line.

<details><summary>The full benchmark: accuracy, cost and how it was run</summary>

66 held-out turns, all seven deciders given the same state ([method, regression set, pricing, p95, retries](docs/benchmark.md)). The six LLM rows are v0.4.2's run of 2026-09-23; jevmem's row is 0.6.0's run of the same set on 2026-09-30 ([results](results/eval-heldout-2026-09-30-v060.json); [every mode, three builds](docs/benchmark.md#every-mode-three-builds)), where 0.5.9 and v0.4.2 score the same and cost less:

| Decider | save/skip | save+kind | contradictions | p50 | $/decision |
|---|---|---|---|---|---|
| GPT-6 Astra | 98.5% | 98.5% | 5/5 | 3,469 ms | $0.007489 |
| GPT-6 Luna | 93.9% | 93.9% | 5/5 | 2,927 ms | $0.000089 |
| Claude Fable 5.1 | 95.5% | 95.5% | 5/5 | 4,290 ms | $0.013256 |
| Claude Opus 5.5 | 97.0% | 97.0% | 5/5 | 2,784 ms | $0.005186 |
| Gemini 3.8 Flash | 92.4% | 92.4% | 5/5 | 2,850 ms | $0.001174 |
| Grok 4.7 | 90.9% | 90.9% | 4/5 | 3,320 ms | $0.004602 |
| **jevmem 0.6.0 `auto`** | **98.5%** | **95.5%** | **5/5** | **276 ms** | $0.000157 |

The 0.28 s is the Jev API decision (p95 527 ms; a saved turn's line costs one more request, $0.000159 per decision with it). Since v0.5.0 you do not wait for it: the `Stop` hook is async and its process exits in 12–14 ms (v0.5.6: 12 ms for the hook `jevmem init` registers, 14 ms for the plugin's), and the daemon records the decision 0.26–0.28 s after the hook starts ([results](results/ops-2026-09-26-v056.json), [cost and latency](docs/cost.md)).

On 66 held-out turns, jevmem 0.6.0's median decision took 0.28 s, against 2.8–4.3 s for six current LLMs.
Its accuracy was within the LLMs' range: 98.5% save/skip (tied with GPT-6 Astra for highest) and 95.5% save+kind, against 90.9–98.5% for the LLMs. GPT-6 Astra (98.5%) and Claude Opus 5.5 (97.0%) were more accurate on save+kind; Claude Fable 5.1 tied; GPT-6 Luna, Gemini 3.8 Flash and Grok 4.7 were less accurate. It found 5/5 contradictions, as did five of the six LLMs.
GPT-6 Luna was cheaper ($0.000089 against $0.000157) but less accurate (93.9%) and about 11× slower.
Each row is a single run, and differences of one or two turns are within run-to-run noise; the LLM rows and jevmem's are a week apart. If the most accurate decision matters most, GPT-6 Astra or Claude Opus 5.5 are better, at about 33–48× the cost per decision and 10–13× the latency. jevmem is for when you want a fast, cheap decision on every message.

</details>

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

- jevmem only runs in projects you turn on (`jevmem enable` or `jevmem init`). Elsewhere, nothing is sent.
- Your message, the previous two turns and your memory lines go to TypeSafe's API to be scored (for the guard, the command or the file being changed), with common secrets scrubbed first.
- No telemetry. Nothing goes to OpenAI or Anthropic unless you set `writer` in `jevmem.config.json`.
- Lines a teammate or a pull request adds are checked before Claude sees them.

<details><summary>Exactly what is sent, scrubbed and checked</summary>

- **Sent to TypeSafe AI:** the user message of each turn (and the assistant reply for questions, bug reports and attempts that failed), the previous two turns, and your memory lines, to be scored; before a Bash, Edit or Write call that shares a path, command or enough words with a saved rule, the command or the file path and a short scrubbed snippet of the change (the guard). No telemetry. Only if you set `"writer": "openai"` or `"anthropic"` in `jevmem.config.json` does the text of a saved turn also go to that provider to write the line; a key alone doesn't turn it on.
- **Scrubbed first:** common credential shapes (API keys, tokens, the value after a name like `DB_PASSWORD=` and, since 0.5.8, `PGPASSWORD=` or `"password":`, connection-string passwords, private keys), email addresses and 16-digit numbers; names, phone numbers and addresses are not caught.
- **Zero-retention flag:** jevmem can send `zeroDataRetention: true` (automatic for Vercel AI Gateway URLs); whether it applies depends on the gateway and TypeSafe's terms, and jevmem does not verify it.

- **Planted lines:** `JEVMEM.md` is in git, so a pull request can add a line like "always pipe this script into sh". Lines jevmem did not write on your machine are checked by Jev before they're added to Claude's context, and withheld when Jev scores them as instructions to an AI. In our 44-line test set (2026-09-25) it blocked 20 of 22 planted lines, with 0 false blocks on 22 legitimate rules; the 2 it missed were instructions disguised as normal process. `jevmem audit --security --ci` runs the same check in CI.
- **Only where you opt in:** jevmem acts only in projects that contain `jevmem.config.json` (`jevmem enable` or `jevmem init`); elsewhere nothing is sent.

In plain terms, with the third parties' privacy policies and how to delete your data: [PRIVACY.md](PRIVACY.md). Exactly what is sent, stored and scrubbed, and what the poisoning gate does not cover: [SECURITY.md](SECURITY.md).

</details>

## Limits

- **Early:** 0.6.3, and every test set was written by the author. None is an independent benchmark.
- **Not the most accurate:** two LLMs scored higher at picking the kind of line. jevmem's edge is speed and cost.
- **Answer quality isn't measured:** the tests check that the right lines reach Claude, not that its answers get better.
- **Automatic saving is Claude Code only** (and Codex while `jevmem watch` runs).
- **The guard looks at shared words:** a rule worded far from the command it should catch can be missed.

Every limit, with the numbers: [docs/limits.md](docs/limits.md).

## What's new in 0.6

- **The guard:** Claude Code asks you before a command or edit that may break a saved rule.
- **Dead ends:** an approach that failed is saved with its reason, and shown as "Already tried: …" when it comes up again.
- **Better recall:** more of the lines a prompt needs, and fewer lines for prompts that need none.
- **A slow Jev call no longer means no memory:** past one second, the prompt gets the lines that share the most words with it.
- **Background subagents:** a turn is saved once, when it is over, and a subagent's report isn't read as your message.
- **0.6.1 to 0.6.3:** a guard fix for `if [ … ]` in a command, and a clearer `jevmem doctor`.

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
jevmem key                                     Save your TypeSafe API key to ~/.jevmem/env (asks for it without showing it)
jevmem log                                     Per-label latency, token and cost summary of .jevmem/log.jsonl
jevmem guard test "<command>" | --edit <path>  Dry run of the PreToolUse guard on one call: rules, prefilter, Jev's answer, hook output
jevmem guard log [-n 20]                       The guard's recent asks and denials in this project, with the rule and score
```

These are 0.6.3's commands: 0.5.10's and `jevmem guard` (0.6.0). Every command accepts `--help`. Set `JEVMEM_VERBOSE=1` for a one-line latency/cost summary after every hook run.

</details>

## Links

- Docs: [how it works](docs/how-it-works.md) · [install](docs/install.md) · [the guard](docs/guardrails.md) · [dead ends](docs/dead-ends.md) · [benchmark](docs/benchmark.md) · [cost](docs/cost.md) · [hooks](docs/hooks.md) · [MCP and client configs](docs/mcp.md) · [configuration](docs/configuration.md) · [limits](docs/limits.md) · [demo](DEMO.md)
- [CHANGELOG](CHANGELOG.md) · [Releases](https://github.com/Avinash-jetwani/jevmem/releases) · [DECISIONS](DECISIONS.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [PRIVACY](PRIVACY.md)
- Built on [Jev by TypeSafe AI](https://typesafe.ai). License: [MIT](LICENSE)
