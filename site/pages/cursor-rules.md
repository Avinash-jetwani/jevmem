---
path: /cursor-rules/
description: Cursor's User Rules follow you to every project, and Project Rules in .cursor/rules travel with a repo. jevmem adds the rules you state in chat: it saves them to JEVMEM.md in the repo, which Cursor, Claude Code, Codex and your teammates read.
order: 15
---
# How do I keep the same rules across Cursor chats, Claude Code and my teammates?

Put the rules in a file that lives in the repository: Cursor's own Project Rules (`.cursor/rules`) and `AGENTS.md` do that for rules you write by hand, and jevmem does it for the rules you state in a chat, saving them as lines in `JEVMEM.md`, which Cursor, Claude Code and Codex read and your teammates get through git.

## What Cursor gives you

Cursor's [rules](https://cursor.com/docs/rules) come in four kinds: User Rules, set in Cursor's settings, which apply across all your projects; Project Rules, `.mdc` files in `.cursor/rules` that are committed with the code; Team Rules, managed from Cursor's dashboard on Team and Enterprise plans; and `AGENTS.md`, a plain Markdown file in the project. All of them are written by hand.

## What jevmem adds

A rule often comes up in the middle of a chat ("we use pnpm, not npm") and is never written into a rules file. With jevmem on in a project, Cursor's hooks save the decisions, rules and failed approaches from each finished agent turn to `JEVMEM.md` (since 0.7.4), and before a non-trivial task the agent looks up the project's lines with jevmem's `search_memory` tool, over MCP. The same file is read by Claude Code, where lines come back on every prompt and the guard checks each command and edit against the rules before it runs, and by Codex over MCP.

In Cursor, on 10 held-out chats captured before the code was written (24 turns), jevmem paired 21 of 24 turns whole on the first run, and 24 of 24 after a reader fix, with what to save right in 21 of 24 ([first run](../../results/cursor-heldout-2026-10-16-v074.json); [how it was measured](cursor.md#what-was-measured)).

## One file for each repository

jevmem keeps memory per project: each repository has its own `JEVMEM.md`, and you turn jevmem on in each one with `jevmem setup`. The jevmem plugin for Cursor (0.7.6) runs in every Cursor window and stays silent in a project where jevmem is off. A rule you want in every project belongs in Cursor's User Rules; a rule for one codebase belongs in that codebase, where jevmem keeps it. Rules you already wrote can come in: `jevmem import` reads `.cursor/rules/*`, `AGENTS.md` and `CLAUDE.md`, prints what it would add, and writes it with `--apply`.

## Which tools read it

{{include README.md#works-with}}

## Set it up in Cursor

The plugin, the CLI and the per-project step: [jevmem in Cursor](cursor.md). The same file in Claude Code: [install](install.md).
