---
path: /
description: jevmem saves the decisions, rules and failed approaches from your Claude Code chats to JEVMEM.md in your repo, and brings the relevant ones back next session.
order: 1
---
# What is jevmem?

**Say it once.** jevmem saves the decisions, rules and failed approaches from your Claude Code chats to JEVMEM.md in your repo, and brings the relevant ones back next session. Before Claude runs a command or edits a file, it checks the call against your saved rules. It is open source (MIT), built on TypeSafe AI's Jev, in Anthropic's Claude plugin directory and on the MCP Registry, and works with Cursor and Codex over MCP.

[Watch the film](https://github.com/user-attachments/assets/65e48f03-8e1c-49d9-baad-6f217911e861)

## What was measured

- **Does Claude act on what was saved?** With jevmem, Claude followed the project's decision in 66/72 sessions; with no project memory, in 28/72; with the same lines in a hand-written `CLAUDE.md`, in 67/72. It tried a change the project forbids in 10/18 sessions with no memory and 0/18 with jevmem, and repeated an approach that had already failed in 3/15 against 0/15. Measured on 24 tasks in three small projects, 3 runs each, in real Claude Code 2.1.281 sessions with `claude-sonnet-5`, on 2026-09-28 and 2026-09-29 ([no memory and CLAUDE.md](../../results/ab-2026-09-28.json), [jevmem](../../results/ab-jevmem-2026-09-29-3b.json)).
- **The guard** caught 66 of 68 rule breaks, with 3–4 false asks in 206 fine calls, on a held-out set of 274 tool calls, run once on 0.6.0 and once on 0.6.1 on 2026-09-30 ([0.6.0](../../results/guard-heldout-v2-2026-09-30.json), [0.6.1](../../results/guard-heldout-v2-2026-09-30-v061.json)).
- **Deciding what to save** takes 0.25 s and costs $0.00016 per message, and was right on save or skip for 98.5% of 66 held-out turns (jevmem 0.6.6, one run, 2026-10-06, [results](../../results/eval-heldout-2026-10-06-v066.json)).
- **A local model in Jev's place** was tried once, on 2026-10-02, with Ollaya 0.9.0 on an Apple M4 with 16 GB: on the same 66 turns Jev was right on save or skip for 65/66 at a median of 0.23 s a turn, `winnow:e4b` for 60/66 at 28.5 s, and `laya:typed-decisions` for 19/66. One run each, on one Mac ([Jev](../../results/local-model-2026-10-02-jev.json), [winnow:e4b](../../results/local-model-2026-10-02-winnow-e4b.json), [laya:typed-decisions](../../results/local-model-2026-10-02-laya-typed-decisions.json); [more in the FAQ](faq.md#can-jevmem-run-on-a-local-model)).

Every test set was written by the author, and none is an independent benchmark. The method and the limits of each number: [Does jevmem work?](results.md)

## How it works

{{include README.md#how-it-works}}

## Install

{{include README.md#install}}

## Works with

{{include README.md#works-with}}

## The questions this site answers

- [How do I make Claude Code remember project decisions across sessions?](claude-code-memory.md)
- [How does jevmem compare with CLAUDE.md, Claude Code's auto memory and other memory tools?](compare.md)
- [What is Jev used for in coding agents, and how does jevmem use it?](jev.md)
- [Can Claude Code check commands against my project's rules before they run?](guard.md)
- How do I use jevmem in [Cursor](cursor.md), [Codex](codex.md) or [Claude Desktop](claude-desktop.md)?
- [How do I install jevmem?](install.md)
- [Does jevmem work?](results.md)
- [What leaves my machine?](privacy.md)
- [Do I need a key, what does it cost, can it run on a local model, and what are the limits?](faq.md)
- [What changed in each version?](whats-new.md)
