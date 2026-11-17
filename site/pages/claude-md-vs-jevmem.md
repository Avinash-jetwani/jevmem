---
path: /claude-md-vs-jevmem/
description: Use both. CLAUDE.md holds what you write by hand; JEVMEM.md holds the decisions, rules and failed approaches jevmem saves from your chats, read by Claude Code, Cursor and Codex and checked by the guard.
order: 17
---
# Should I use CLAUDE.md or JEVMEM.md?

Use both: keep in `CLAUDE.md` what you want to write and edit by hand, such as how to build and test the project, and let jevmem keep `JEVMEM.md`, the decisions, rules and failed approaches that come up in your chats, which it saves as you work, brings back when a prompt needs them, and checks Claude's commands against.

In 72 real Claude Code sessions, Claude followed the project's saved decision in 66 with jevmem (66/72) and in 67 with the same lines in a hand-written `CLAUDE.md` (67/72), against 28 with no project memory (28/72) ([no memory and CLAUDE.md](../../results/ab-2026-09-28.json), [jevmem](../../results/ab-jevmem-2026-09-29-3b.json); [method and limits](results.md#does-claude-act-on-the-saved-line)). So the two did about as well; the difference is who writes the file and what reads it.

## Side by side

| | `CLAUDE.md` | `JEVMEM.md` |
|---|---|---|
| Who writes it | You, by hand | jevmem, from your chats; you can add, retire and mark lines |
| What goes in it | Anything you choose | One line per decision, rule, failed approach, bug or to-do |
| When Claude Code gets it | The whole file, at the start of each session | The lines a prompt needs, on every prompt; always-on rules at the start of each session |
| Checked before a command or edit runs | No | Yes, by the guard |
| Written for | Claude Code | Claude Code, Cursor and Codex, and Claude Desktop over MCP |
| Shared with your team | Through git | Through git |
| Needs a key | No | A paid TypeSafe API key |

## When CLAUDE.md alone is enough

If you already keep a `CLAUDE.md` up to date and work alone in Claude Code, it covers the decisions you remember to write down. jevmem helps when rules come up in chats and never reach the file, when teammates or other tools need the same rules, and when you want commands checked against them before they run.

## Already have a CLAUDE.md?

`jevmem import` splits `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/*` into statements, puts each through the same check as a chat turn, and prints what it would add; `--apply` writes them. The source files are only read, so your `CLAUDE.md` stays as it is ([install](install.md)).

## Rules every change must follow

A rule like "every new string goes through `t()`" applies to work whose prompt never mentions it. `CLAUDE.md` is in every session, so it reaches Claude. jevmem marks such a rule always-on (since 0.7.1) and sends it at the start of every session: on six held-out tasks written for that case, Claude followed the convention in 18 of 18 sessions with 0.7.1, as with the same lines in a hand-kept `CLAUDE.md` ([results](../../results/ab-alwayson-v2-2026-10-13-v071.json)).

## jevmem next to CLAUDE.md and Claude Code's auto memory

{{include docs/how-it-works.md#how-this-differs-from-the-tools-own-memory}}

The same comparison with other memory tools: [jevmem compared](compare.md).
