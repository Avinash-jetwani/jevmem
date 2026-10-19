---
path: /cursor/
description: Install the jevmem plugin for Cursor (0.7.6), or run jevmem init --tool cursor in your project. Since jevmem 0.7.4, Cursor's hooks save the decisions, rules and failed approaches from each finished agent turn, as Claude Code's do; the agent reads memory over MCP.
order: 6
---
# How do I use jevmem in Cursor?

Install the jevmem plugin for Cursor (since jevmem 0.7.6), or run `jevmem init --tool cursor` in your project (since 0.7.4). Either way, when an agent turn finishes, Cursor's `stop` hook reads the turn from the transcript Cursor keeps and runs the same decide and write path as in Claude Code, so the decisions, rules and failed approaches you state in a Cursor chat land in `JEVMEM.md` on their own; jevmem's MCP server and a rule tell the agent to call `search_memory` before a non-trivial task, since Cursor's prompt hook takes no context and reading memory is the agent's call, over MCP.

**The plugin** carries the hooks, the MCP server and the rule for every Cursor window, so a project needs no `.cursor/` files from jevmem: you turn each project on with `jevmem setup`, and elsewhere the plugin stays silent (its hooks exit at once, its server answers that jevmem is off there, and its rule tells the agent to leave jevmem alone). Like the Claude Code plugin it ships no code: one shell launcher runs the `jevmem` command from npm. Until jevmem is listed on the Cursor Marketplace, the plugin installs from the repository's `cursor-plugin/` folder (below).

**`jevmem init --tool cursor`** writes the same hooks into the project instead, `.cursor/hooks.json` with a small launcher at `.cursor/hooks/jevmem-hook.sh`, both free of any path of your computer so they can be committed, plus jevmem's MCP server in `.cursor/mcp.json` and the rule `.cursor/rules/jevmem.mdc`. With the plugin installed on your computer, `init` only turns the project on and writes none of them. A project set up this way keeps working beside the plugin, which stands down there so nothing is saved twice; `jevmem init --remove-hooks` moves it to the plugin alone.

Before 0.7.4, saving in Cursor happened only when the agent called `add_memory`. If you set jevmem up for Cursor earlier and use no plugin, run `jevmem init --tool cursor` once more: it adds the two files, updates the rule's text when you have not changed it, and keeps your MCP entry; then reload the window.

## What was measured

Twenty real Cursor sessions were captured through Cursor's `agent` CLI in scratch copies of small projects, before any of the Cursor code was written, and each turn was labelled with what jevmem should save. On the ten held-out sessions (24 turns), the first run on the build paired 21 of 24 turns whole, the prompt with the whole reply and no tool output: the three misses were one session where Cursor's CLI had written a line of its own after a background task, which the reader took as a new turn ([the first run](../../results/cursor-heldout-2026-10-16-v074.json)). That fix came from reading the held-out session, so the second run, after it, is no longer a first look: it paired 24 of 24, and the decider, unchanged from Claude Code, was right on save or skip for 21 of 24 turns and on save and kind for 20 of 24, each saved line carried its labelled words, and the one reversal replaced the line it reversed ([results](../../results/cursor-heldout-2026-10-16-v074-run2.json)). The three decide misses are a fact stated in a reply saved as an architecture line, twice, and a failing test runner found by "Run the tests" saved as a bug. The sessions were served by Grok 4.7 Extra High; what Cursor's hooks send, and what each of jevmem's does with it, is on the repository's [hooks page](../../docs/hooks.md#cursor-hooks-074).

## Set it up with the plugin

1. Install the CLI:
   ```bash
   npm install -g jevmem
   ```
2. Save your [TypeSafe API key](https://console.typesafe.ai/keys) (paste it when asked; it isn't shown):
   ```bash
   jevmem key
   ```
3. Install the plugin: from the Cursor Marketplace once jevmem is listed there (Customize → find jevmem → Install), or now from the repository: copy its `cursor-plugin/` folder to `~/.cursor/plugins/local/jevmem`, then **Developer: Reload Window**. Customize shows the plugin's hooks, MCP server and rule.
4. In each project's folder:
   ```bash
   jevmem setup
   ```
   It turns jevmem on there (`JEVMEM.md`, `jevmem.config.json`, a gitignored `.jevmem/` folder) and checks the setup. The plugin's MCP server already runs in every window, with no toggle. `jevmem doctor` shows a `cursor` line that names the plugin.

## Set it up without the plugin

1. Install the CLI and save your key, as above.
2. In your project's folder:
   ```bash
   jevmem init --tool cursor
   ```
3. Reload the Cursor window, so that it picks up the hooks. Cursor runs project hooks in a trusted workspace.
4. Turn the project's MCP server on once, in the Cursor app: Customize → MCPs → jevmem → Configure → the source toggle for `.cursor/mcp.json`, then Reload. Cursor starts a project's MCP server only after this; the hooks need no server ([what you see, and what was measured](#the-mcp-config-if-you-write-it-yourself)).

`init` also creates `JEVMEM.md`, `jevmem.config.json` and a gitignored `.jevmem/` folder in the project. `jevmem doctor` shows a `cursor` line with what it found. Every install path: [install](install.md).

## What is saved, and what is not

A turn that ends with `status: completed` is saved; a turn you stopped, or that ended in an error, is not. In Cursor's `agent` CLI, which fires `sessionEnd` and not the app's `stop`, each `agent -p` run is one turn, saved when the run ends. A turn's `previous` context is the turn before it, as in Claude Code. Cursor's own follow-up line after a background task ("Briefly inform the user about the task result…") belongs to the turn before it, since 0.7.6 also when that turn had ended. What goes to TypeSafe is the same as from a Claude Code turn, from the plugin as from the project's hooks ([privacy](privacy.md)). Known limits in Cursor: [limits](../../docs/limits.md).

## The MCP config, if you write it yourself

{{include docs/mcp.md#cursor}}

## What the agent can call

{{include docs/mcp.md#mcp-server only}}

## What is automatic in each tool

{{include docs/install.md#works-with}}
