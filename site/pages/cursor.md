---
path: /cursor/
description: Run jevmem init --tool cursor in your project. Cursor's agent then saves decisions and looks them up through jevmem's MCP server. In Cursor, saving happens only when the agent calls it.
order: 6
---
# How do I use jevmem in Cursor?

Run `jevmem init --tool cursor` in your project: it adds jevmem's MCP server to `.cursor/mcp.json` and writes a rule, `.cursor/rules/jevmem.mdc`, that tells Cursor's agent to save a decision with `add_memory` when you state one and to call `search_memory` before a non-trivial task.

In Cursor, jevmem saves only when the agent calls it; saving is automatic in Claude Code, and in Codex while `jevmem watch` runs. A line the agent adds goes through the same check as a Claude Code turn: on 66 held-out turns that check was right on save or skip for 98.5% (jevmem 0.6.0, one run on 2026-09-30, [results](../../results/eval-heldout-2026-09-30-v060.json)). Those turns were given to the decider directly; nothing has been measured inside Cursor.

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
4. Reload the Cursor window, so that it picks up the MCP server.

`init` also creates `JEVMEM.md`, `jevmem.config.json` and a gitignored `.jevmem/` folder in the project. Every install path: [install](install.md).

## The MCP config, if you write it yourself

{{include docs/mcp.md#cursor}}

## What the agent can call

{{include docs/mcp.md#mcp-server only}}

## What is automatic in each tool

{{include docs/install.md#works-with}}
