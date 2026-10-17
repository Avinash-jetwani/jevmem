---
path: /cursor/
description: Run jevmem init --tool cursor in your project. Since jevmem 0.7.4, Cursor's hooks save the decisions, rules and failed approaches from each finished agent turn, as Claude Code's do; the agent reads memory over MCP.
order: 6
---
# How do I use jevmem in Cursor?

Run `jevmem init --tool cursor` in your project. Since jevmem 0.7.4 it writes Cursor's hooks into `.cursor/hooks.json`, with a small launcher at `.cursor/hooks/jevmem-hook.sh` that runs jevmem, and both files can be committed: nothing in them names your computer. When an agent turn finishes, the `stop` hook reads the turn from the transcript Cursor keeps and runs the same decide and write path as in Claude Code, so the decisions, rules and failed approaches you state in a Cursor chat land in `JEVMEM.md` on their own. It also adds jevmem's MCP server to `.cursor/mcp.json` and a rule, `.cursor/rules/jevmem.mdc`, that tells the agent to call `search_memory` before a non-trivial task: Cursor's prompt hook takes no context, so reading memory is the agent's call, over MCP.

Before 0.7.4, saving in Cursor happened only when the agent called `add_memory`. If you set jevmem up for Cursor earlier, run `jevmem init --tool cursor` once more: it adds the two files, updates the rule's text when you have not changed it, and keeps your MCP entry; then reload the window.

## What was measured

Twenty real Cursor sessions were captured through Cursor's `agent` CLI in scratch copies of small projects, before any of the Cursor code was written, and each turn was labelled with what jevmem should save. On the ten held-out sessions (24 turns), the first run on the build paired 21 of 24 turns whole, the prompt with the whole reply and no tool output: the three misses were one session where Cursor's CLI had written a line of its own after a background task, which the reader took as a new turn ([the first run](../../results/cursor-heldout-2026-10-16-v074.json)). That fix came from reading the held-out session, so the second run, after it, is no longer a first look: it paired 24 of 24, and the decider, unchanged from Claude Code, was right on save or skip for 21 of 24 turns and on save and kind for 20 of 24, each saved line carried its labelled words, and the one reversal replaced the line it reversed ([results](../../results/cursor-heldout-2026-10-16-v074-run2.json)). The three decide misses are a fact stated in a reply saved as an architecture line, twice, and a failing test runner found by "Run the tests" saved as a bug. The sessions were served by Grok 4.7 Extra High; what Cursor's hooks send, and what each of jevmem's does with it, is on the repository's [hooks page](../../docs/hooks.md#cursor-hooks-074).

## Set it up

1. Install the CLI:
   ```bash
   npm install -g jevmem
   ```
2. Save your [TypeSafe API key](https://console.typesafe.ai/keys) (paste it when asked; it isn't shown):
   ```bash
   jevmem key
   ```
3. In your project's folder:
   ```bash
   jevmem init --tool cursor
   ```
4. Reload the Cursor window, so that it picks up the hooks. Cursor runs project hooks in a trusted workspace.
5. Turn the project's MCP server on once, in the Cursor app: Customize → MCPs → jevmem → Configure → the source toggle for `.cursor/mcp.json`, then Reload. Cursor starts a project's MCP server only after this; the hooks need no server ([what you see, and what was measured](#the-mcp-config-if-you-write-it-yourself)).

`init` also creates `JEVMEM.md`, `jevmem.config.json` and a gitignored `.jevmem/` folder in the project. `jevmem doctor` shows a `cursor` line with what it found. Every install path: [install](install.md).

## What is saved, and what is not

A turn that ends with `status: completed` is saved; a turn you stopped, or that ended in an error, is not. In Cursor's `agent` CLI, which fires `sessionEnd` and not the app's `stop`, each `agent -p` run is one turn, saved when the run ends. A turn's `previous` context is the turn before it, as in Claude Code. What goes to TypeSafe is the same as from a Claude Code turn ([privacy](privacy.md)). Known limits in Cursor: [limits](../../docs/limits.md).

## The MCP config, if you write it yourself

{{include docs/mcp.md#cursor}}

## What the agent can call

{{include docs/mcp.md#mcp-server only}}

## What is automatic in each tool

{{include docs/install.md#works-with}}
