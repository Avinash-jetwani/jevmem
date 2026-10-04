---
path: /codex/
description: Run jevmem init --tool codex in your project and keep jevmem watch running. watch saves from each Codex turn. Codex's agent looks saved lines up through jevmem's MCP server.
order: 7
---
# How do I use jevmem in Codex?

Run `jevmem init --tool codex` in your project, then keep `jevmem watch` running while you work: `init` registers jevmem's MCP server in `~/.codex/config.toml` and adds a section to the project's `AGENTS.md`, and `watch` reads Codex's session log for the project and decides, turn by turn, what to save, as jevmem does in Claude Code.

Saving is automatic in Codex only while `jevmem watch` runs; without it, a line is saved when Codex's agent calls `add_memory`. Bringing lines back is up to the agent: the `AGENTS.md` section tells it to call `search_memory`. The check behind each save is the one a Claude Code turn gets: on 66 held-out turns it was right on save or skip for 98.5% (jevmem 0.6.0, one run on 2026-09-30, [results](../../results/eval-heldout-2026-09-30-v060.json)). Those turns were given to the decider directly; nothing has been measured inside Codex.

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
   jevmem init --tool codex
   ```
   `~/.codex/config.toml` is the only file outside the project that `init` edits. It prints the file, a backup path and the exact lines before it writes, and keeps the backup.
4. While you work in Codex, keep this running in the project's folder:
   ```bash
   jevmem watch
   ```

`init` also creates `JEVMEM.md`, `jevmem.config.json` and a gitignored `.jevmem/` folder in the project. Every install path: [install](install.md).

## The MCP config, if you write it yourself

{{include docs/mcp.md#codex}}

## What the agent can call

{{include docs/mcp.md#mcp-server only}}

## What is automatic in each tool

{{include docs/install.md#works-with}}
