---
path: /stop-rule-breaks/
description: Write the rule down where the agent reads it, and have something check each command and edit against it before it runs. jevmem's guard does that in Claude Code, from the rules in JEVMEM.md, and asks you first when one may break.
order: 16
---
# How do I stop an AI coding agent from breaking my project's rules?

Write each rule where the agent reads it at the start of the work, and have something check the agent's actions against the rules before they run: jevmem keeps the rules in `JEVMEM.md` in your repo, and in Claude Code its guard checks each command, file edit and file write against them and asks you first when one may break a rule.

In real Claude Code sessions (0.7.7, checked by hand), a change a rule forbids was left in the code in 0 of 15 sessions with jevmem on, against 9 of 15 with no project memory ([results](../../results/ab-automem-2026-11-02-audit.json); [method](../../docs/benchmark.md#against-claude-codes-auto-memory-077)). On a held-out set of 274 tool calls, the guard caught 66 of 68 rule breaks ([results](../../results/guard-heldout-v2-2026-09-30-v061.json)).

## Write the rule where the agent reads it

A rule the agent never sees can't be followed. Claude Code reads `CLAUDE.md`, Cursor reads its Project Rules and `AGENTS.md`, and Codex reads `AGENTS.md`. jevmem saves the rules you state in chat ("don't hand-edit `db/migrations/`: those files are generated") as lines in `JEVMEM.md`, gives the ones a prompt needs back to Claude Code on every prompt, sends rules marked always-on at the start of every session, and lets Cursor's and Codex's agents look them up over MCP.

## Check the action before it runs

A rule in the context is a request; a check before the call is a second line. jevmem's guard runs as a Claude Code `PreToolUse` hook: before a Bash command, an Edit or a Write runs, it finds the saved rules the call may touch and asks Jev whether the call would break one. If so, Claude Code shows you the rule and asks:

```text
jevmem: this may break a saved rule: "Don't hand-edit db/migrations/: those files are generated." (JEVMEM.md)
```

In `block` mode, a call that breaks a rule you marked verified with `jevmem trust` does not run, and Claude is told to tell you about the rule instead of working around it. How the guard reads a call, its modes and its settings: [the guard](guard.md).

## What it does not catch

The guard is a backstop, not a sandbox. It looks at the words a rule and a call share, so a script or a make target that already exists and does the forbidden thing can be missed. It checks Claude Code's Bash, Edit and Write calls, not MCP tools or what a script changes when it runs, and it runs in Claude Code only: Cursor and Codex get the rules, not the check. Every limit: [the guard's limits](guard.md#limits).

## Set it up

{{include README.md#install}}
