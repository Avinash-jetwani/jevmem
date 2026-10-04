---
path: /claude-desktop/
description: Run jevmem init --tool claude-desktop in your project and paste the config it prints into Claude Desktop. jevmem then saves and looks up lines when you ask Claude to, over MCP.
order: 8
---
# How do I use jevmem in Claude Desktop?

Run `jevmem init --tool claude-desktop` in your project and paste the config snippet it prints into Claude Desktop's `claude_desktop_config.json`: that starts jevmem's MCP server for that one project, and jevmem then saves a line when you ask Claude to call `add_memory` and looks lines up when you ask for `search_memory`.

Nothing is automatic in Claude Desktop: it has no hook and no rule file, so jevmem acts only when you ask. A line added this way goes through the same check as a Claude Code turn: on 66 held-out turns that check was right on save or skip for 98.5% (jevmem 0.6.0, one run on 2026-09-30, [results](../../results/eval-heldout-2026-09-30-v060.json)). Those turns were given to the decider directly; nothing has been measured inside Claude Desktop.

## Set it up

1. Install the CLI:
   ```bash
   npm install -g jevmem
   ```
2. In your project's folder:
   ```bash
   jevmem init --tool claude-desktop
   ```
3. Paste the snippet it prints into the config file named below, with your [TypeSafe API key](https://console.typesafe.ai/keys) in its `env`, and restart Claude Desktop.

Every install path: [install](install.md).

## The MCP config

{{include docs/mcp.md#claude-desktop}}

## What Claude can call

{{include docs/mcp.md#mcp-server only}}

## What is automatic in each tool

{{include docs/install.md#works-with}}
