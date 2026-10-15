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

## Rules for every change, past sessions, and a line you no longer want

- **Rules every change must follow** (0.7.1): a line jevmem marks always-on (Jev reads it as a standing rule for how any work in the project is done; `jevmem always <id>` marks by hand) reaches Claude at the start of every session, whatever the prompt, through a `SessionStart` hook that reads `JEVMEM.md` and nothing else. On six held-out tasks whose files were written before their conventions, Claude followed the convention in 14 of 18 sessions with 0.7.0 and 18 of 18 with 0.7.1, as with the same lines in a hand-kept `CLAUDE.md` (one run each, 2026-10-13: [0.7.0](../../results/ab-alwayson-v2-2026-10-13-v070.json), [0.7.1](../../results/ab-alwayson-v2-2026-10-13-v071.json); [method and limits](results.md#do-rules-every-change-must-follow-reach-claude)).
- **Memory from past sessions** (0.7.1): `jevmem import --from sessions` reads the project's past Claude Code sessions and proposes the decisions, rules and dead ends in them, after showing the count and the cost and asking; `--apply` writes them. On 12 real held-out sessions with 27 turns it read every turn and proposed a line for all 17 turns labelled to give one, and 4 more from turns labelled skip (one run, 2026-10-13, [results](../../results/import-heldout-2026-10-13-v071.json)).
- **A line you no longer want** (0.7.0): `jevmem forget <id>` retires it in place. It stays in `JEVMEM.md` as `[retired]`, and nothing serves or enforces it; `jevmem wrong <id> --should-be none` does the same.

## Set it up

{{include README.md#install}}

## CLAUDE.md, auto memory and jevmem side by side

{{include docs/how-it-works.md#how-this-differs-from-the-tools-own-memory}}

The same comparison with other memory tools for Claude Code: [jevmem compared](compare.md).
