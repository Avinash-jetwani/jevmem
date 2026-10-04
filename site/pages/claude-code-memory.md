---
path: /claude-code-memory/
nav: Claude Code memory
description: Keep project decisions in a file Claude Code gets back each session. jevmem writes that file for you, JEVMEM.md in your repo, and brings the relevant lines back next session.
order: 2
---
# How do I make Claude Code remember project decisions across sessions?

Keep the decisions in a file that Claude Code is given again in the next session: you can write a `CLAUDE.md` by hand, or let jevmem do it, which saves the decisions, rules and failed approaches from your Claude Code chats to JEVMEM.md in your repo, and brings the relevant ones back next session.

In 72 real Claude Code sessions, Claude followed the project's saved decision in 66 with jevmem (66/72), in 28 with no project memory (28/72) and in 67 with the same lines in a hand-written `CLAUDE.md` (67/72). That was measured on 24 tasks in three small projects of 34 to 42 saved lines, 3 runs each, with Claude Code 2.1.281 and `claude-sonnet-5`, on 2026-09-28 and 2026-09-29 ([no memory and CLAUDE.md](../../results/ab-2026-09-28.json), [jevmem](../../results/ab-jevmem-2026-09-29-3b.json); [method and limits](results.md)).

## Why a file

{{include README.md#why}}

## How jevmem does it

{{include README.md#how-it-works}}

## Set it up

{{include README.md#install}}

## CLAUDE.md, auto memory and jevmem side by side

{{include docs/how-it-works.md#how-this-differs-from-the-tools-own-memory}}

The same comparison with other memory tools for Claude Code: [jevmem compared](compare.md).
