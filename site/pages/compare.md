---
path: /compare/
nav: Compare
description: jevmem writes project memory to a file in your repo and brings back the lines a prompt needs. How that differs from CLAUDE.md, Claude Code's auto memory and five other memory tools, by each project's own page.
order: 3
---
# How does jevmem compare with CLAUDE.md, Claude Code's auto memory and other memory tools?

jevmem writes a memory file in your repo for you, `JEVMEM.md`, and brings back only the lines a prompt needs; `CLAUDE.md` is a file you write by hand that Claude Code loads at the start of every session, Claude Code's auto memory is notes that Claude keeps on one machine, and the five other memory tools on this page each keep their memories in a local database or on a server, by their own pages.

Only jevmem and `CLAUDE.md` were measured against each other, and the numbers are jevmem's own: in 72 real Claude Code sessions, Claude followed the project's saved decision in 66 with jevmem (66/72) and in 67 with the same lines in a hand-written `CLAUDE.md` (67/72), against 28 with no project memory (28/72). That was 24 tasks in three small projects, 3 runs each, with Claude Code 2.1.281, on 2026-09-28 and 2026-09-29 ([no memory and CLAUDE.md](../../results/ab-2026-09-28.json), [jevmem](../../results/ab-jevmem-2026-09-29-3b.json)). We did not test the other tools, and Claude Code's auto memory started empty in every session of that test, so nothing on this page says that one tool does better than another.

## At a glance

Each cell for a tool other than jevmem is what that project says on its own page, linked under [What each one says about itself](#what-each-one-says-about-itself).

| | How it saves | Where it stores | Works with | Account or key | Runs locally | Licence |
|---|---|---|---|---|---|---|
| **jevmem** | Automatic in Claude Code, after every turn; in Codex while `jevmem watch` runs; in Cursor and Claude Desktop when the agent calls it | A file in the repo, `JEVMEM.md`, shared through git | Claude Code, Codex, Cursor, Claude Desktop | A TypeSafe API key | The CLI runs on your machine; each decision is a request to TypeSafe's API | MIT |
| **`CLAUDE.md`** | Manual: you write it | A file in the repo, shared through version control, or in your home folder | Claude Code | None named in the docs | Yes: a file Claude Code reads | A Claude Code feature |
| **Claude Code's auto memory** | Automatic: Claude writes a note when it judges one worth keeping | Files under `~/.claude/projects/<project>/memory/`, on one machine | Claude Code | None named in the docs | Yes: machine-local files | A Claude Code feature |
| **claude-mem** | Automatic, through Claude Code hooks | A local SQLite database, `~/.claude-mem/claude-mem.db`; a backup to cmem.ai is offered | Claude Code, and Cursor, Windsurf, OpenCode, Codex CLI and others | Its installer asks you to sign in to claude-mem, which can be skipped; memory is processed by a provider you pick | A local worker and database; the pre-selected provider is hosted | Apache-2.0 |
| **Mem0** (its Claude Code plugin) | Automatic: hooks capture the session and a background worker sends it on | The Mem0 Platform, a hosted service | Claude Code; the project itself is a library and a server for applications | A Mem0 Platform API key | The plugin uses the hosted platform; the project also has a library and a self-hosted server | Apache-2.0 |
| **MemPalace** | Hooks tell the agent when to save, and the agent files the memory through MCP tools; a `mine` command reads past sessions | A local embedded ChromaDB, by default under `~/.mempalace/palace` | Claude Code, Codex CLI and Cursor through hooks; Gemini CLI and other MCP clients | No API key for the core local workflow | Yes | MIT |
| **Hindsight** | Automatic for coding agents, from git history and past sessions; also MCP tools | A Hindsight server: Hindsight Cloud, one you run, or a local daemon | Claude Code, Codex CLI, Cursor CLI, GitHub Copilot CLI and others | Cloud: an API token. Local daemon: an LLM key, or the Claude Code CLI | Hosted, self-hosted or a local daemon | MIT |
| **OpenViking** | Automatic, through hooks, with no tool call by the model | An OpenViking server: one you run, or Volcengine's hosted service | Claude Code, Codex, Cursor, TRAE, OpenCode and more | Self-hosted: a model provider's API key. Hosted: an API key from its console | Self-hosted or hosted | AGPL-3.0; its `examples/` folder, where the Claude Code plugin is, Apache-2.0 |

## How the five tools were chosen

They are the five most-starred repositories found on GitHub on 2026-10-04 whose own pages describe lasting memory for Claude Code and give setup steps for it. The search was GitHub's repository search, 34 queries such as "claude code memory", sorted by stars; a repository none of those queries returned is not here. Code indexes, issue trackers and agent frameworks were left out, and so were memory projects whose README does not mention Claude Code.

Stars, read from GitHub's API on 2026-10-04 at 12:08 UTC:

- [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem): 95,854
- [mem0ai/mem0](https://github.com/mem0ai/mem0): 66,556
- [MemPalace/mempalace](https://github.com/MemPalace/mempalace): 59,406
- [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight): 45,284
- [volcengine/OpenViking](https://github.com/volcengine/OpenViking): 39,188

The stars are for each whole repository. Of the five, claude-mem is the one that describes itself as built for Claude Code; the other four are general memory projects with a Claude Code plugin or setup. Mem0's main README does not present it as memory for Claude Code, so its row describes the Claude Code plugin kept in the same repository.

## What each one says about itself

### CLAUDE.md

From [Anthropic's Claude Code docs](https://code.claude.com/docs/en/memory), read on 2026-10-04. You write the file in plain text and Claude Code reads it at the start of every session. The project's file is `./CLAUDE.md` or `./.claude/CLAUDE.md` and is shared with the team through version control; a file in `~/.claude/` holds your own preferences for every project. The docs advise keeping each file under 200 lines, and say Claude treats the file as context, not as enforced configuration.

### Claude Code's auto memory

From the same page. Auto memory is notes Claude writes itself, on by default. Claude decides what is worth keeping, and also saves when you ask it to remember something. Each project's notes are in `~/.claude/projects/<project>/memory/`; they are machine-local and are not shared across machines. The first 200 lines or 25KB of the `MEMORY.md` index are loaded at the start of every conversation.

### jevmem next to those two

jevmem replaces neither. Rules every task must follow still belong in `CLAUDE.md`: in the test above, `CLAUDE.md` did better on a convention nothing in the prompt points at (3 of 3 sessions against 0 of 3). `jevmem import` reads an existing `CLAUDE.md` and shows what it would add from it. A longer table of the three: [CLAUDE.md, auto memory and jevmem side by side](claude-code-memory.md#claudemd-auto-memory-and-jevmem-side-by-side).

### claude-mem

From its [README](https://github.com/thedotmack/claude-mem/blob/main/README.md) and [installation page](https://github.com/thedotmack/claude-mem/blob/main/docs/public/installation.mdx). It describes itself as a memory compression system built for Claude Code. Lifecycle hooks capture what the tools do and summarise it for later sessions, with no manual step. Sessions, observations and summaries go to a SQLite database at `~/.claude-mem/claude-mem.db`, served by a local worker; a backup to cmem.ai is offered. The installer asks you to sign in to claude-mem and then to pick a memory provider (its own hosted observer, which is pre-selected, your own OpenRouter or Gemini key, or your Anthropic plan); the sign-in can be skipped. Its licence is Apache-2.0.

### Mem0

From its [README](https://github.com/mem0ai/mem0/blob/main/README.md) and the [Claude Code plugin's README](https://github.com/mem0ai/mem0/blob/main/integrations/claude-code-plugin/README.md) in the same repository. The project is a memory library, a self-hosted server and a cloud platform for applications. Its Claude Code plugin captures session details with hooks; a background worker sends them to Mem0 in batches, and Claude gets the relevant memories back at the start of later sessions. The plugin needs a Mem0 Platform API key. Its licence is Apache-2.0.

### MemPalace

From its [README](https://github.com/MemPalace/mempalace/blob/develop/README.md) and its guides to [hooks](https://github.com/MemPalace/mempalace/blob/develop/website/guide/hooks.md), [configuration](https://github.com/MemPalace/mempalace/blob/develop/website/guide/configuration.md) and [getting started](https://github.com/MemPalace/mempalace/blob/develop/website/guide/getting-started.md). It describes itself as local-first AI memory. Auto-save hooks for Claude Code, Codex CLI and Cursor tell the agent when to save, and the agent files the memory through MCP tools; a `mine` command reads past sessions and project files. Storage is an embedded ChromaDB, by default under `~/.mempalace/palace`. The core local workflow needs no API key, and the README says nothing leaves your machine unless you opt in. Its licence is MIT.

### Hindsight

From its [README](https://github.com/vectorize-io/hindsight/blob/main/README.md) and its [coding agents page](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs-integrations/coding-agents.md). It describes itself as an agent memory system. For command-line coding agents, one package builds a memory bank per repository from git history and past sessions, without a setup command, and an MCP server offers the same memory as tools. The install asks where memory should live: Hindsight Cloud (the default on that page), a server you run, or a local daemon. Cloud needs an API token; the local daemon needs an LLM key or uses the Claude Code CLI. Its licence is MIT.

### OpenViking

From its [README](https://github.com/volcengine/OpenViking/blob/main/README.md) and its [Claude Code page](https://github.com/volcengine/OpenViking/blob/main/docs/en/agent-integrations/02-claude-code.md). It describes itself as a context database for AI agents, which coding agents connect to for memory across sessions. Once its plugin is installed, each conversation recalls and captures memories through hooks, without the model calling a tool. The memories are kept by an OpenViking server: one you run, which needs a model provider and its API key, or the hosted service run by Volcengine, which needs an API key from its console. The main project is AGPLv3, and its `examples/` folder, where the Claude Code plugin lives, is Apache 2.0.

## To try jevmem

The four steps are on [the install page](install.md). jevmem's own measurements, with their methods and limits: [Does jevmem work?](results.md)

Compared on 2026-10-04. If a line on this page is wrong or out of date, please [open an issue](https://github.com/Avinash-jetwani/jevmem/issues).
