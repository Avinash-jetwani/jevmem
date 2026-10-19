# jevmem plugin for Cursor

Automatic project memory for Cursor. When an agent turn finishes, TypeSafe's Jev decides whether it is worth
remembering and saves it as one line in `JEVMEM.md` in your repository; the agent reads those lines back over MCP when
a task needs them. It is opt-in per project and does nothing until you turn jevmem on there. Full documentation:
https://github.com/Avinash-jetwani/jevmem and https://avinash-jetwani.github.io/jevmem/cursor/

## What it needs

This plugin contains no jevmem code. It runs the `jevmem` command-line tool, a separate package on the public npm
registry (https://www.npmjs.com/package/jevmem), published with provenance by this repository's release workflow; its
source is in this repository. So you need:

1. The `jevmem` CLI, installed from npm. The command is in the main README:
   https://github.com/Avinash-jetwani/jevmem#install
2. A TypeSafe AI key (https://console.typesafe.ai/keys), saved once with `jevmem key` in a terminal: it asks for the
   key without showing it and keeps it in `~/.jevmem/env`, readable only by you. The plugin has no key setting of its
   own and never reads the key itself; the `jevmem` command does, for each request. jevmem is free; the key is your
   own account with TypeSafe.
3. The project turned on: `jevmem setup` in the project's folder (it asks for the key if none is saved, turns jevmem
   on there and checks the setup), or `jevmem enable` alone. That creates `jevmem.config.json`, `JEVMEM.md` and a
   gitignored `.jevmem/` folder. In a project without `jevmem.config.json` the plugin's hooks exit at once, its MCP
   server answers every call with one line saying jevmem is not turned on there, and nothing is sent or written.

## Install

From the Cursor Marketplace, once jevmem is listed there: open **Customize** in Cursor, find jevmem and select
**Install**. Until then, from this repository: copy the `cursor-plugin/` folder to `~/.cursor/plugins/local/jevmem`,
then **Developer: Reload Window**. Cursor shows the plugin's hooks, MCP server and rule under Customize.

A project set up earlier with `jevmem init --tool cursor` (jevmem 0.7.4 or 0.7.5) keeps working: beside a project's
own jevmem hooks the plugin stands down, so nothing is saved twice. To keep the plugin alone, run `jevmem init
--remove-hooks` in that project: it removes the hooks, the launcher, jevmem's rule file and its MCP entry, which the
plugin now carries; then reload the window.

## What it runs

- **Five hooks** (`sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `sessionEnd`), each
  `hooks/jevmem-hook.sh`, a short POSIX shell script in this folder. It looks for `jevmem` with `command -v jevmem`,
  then at the path it saved in the project's `.jevmem/` folder the last time it found it, then in `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin` and `~/.volta/bin`, then in the newest Node version under `~/.nvm` that has it;
  finds Node 20 or newer to run it with; and runs `jevmem hook --cursor --plugin`. `stop` and `sessionEnd` hand the
  finished turn to jevmem and return at once, so Cursor never waits; the other three run in place inside their
  5-second timeouts. The script downloads nothing and runs no package manager. On `sessionStart` it also writes
  `~/.jevmem/cursor-plugin`, the plugin's version and the time, once a day: that is how `jevmem init` and `jevmem
  doctor` know the plugin is installed on this computer. It is the one file the plugin writes outside a project.
- **One MCP server**, `jevmem mcp`, through the same launcher, with the tools `search_memory`, `add_memory`,
  `list_memory` and `audit_memory`. Cursor starts it in every window, with the window's folder as the project; without
  the `jevmem` command it fails to start, and Cursor's MCP list shows that.
- **One rule**, `rules/jevmem.mdc`, applied in every chat: it tells the agent to call `search_memory` before a
  non-trivial task in a project that has `jevmem.config.json`, and to leave jevmem alone elsewhere.

What each hook does with Cursor's payloads, and what was measured:
https://github.com/Avinash-jetwani/jevmem/blob/main/docs/hooks.md

## What it sends, and where

Only in a project that is turned on, and the same as `jevmem init --tool cursor`'s hooks send: after each finished
agent turn, your message, the previous turn shortened and up to 200 memory lines go to TypeSafe AI
(`https://api.typesafe.ai/v1/systemone`, or the URL in `TYPESAFE_BASE_URL`) to decide what to save; the agent's reply
(its first 2,000 characters) is in that request when the message reads as a question or a bug report, when the reply
reports an attempt, when the turn is about a saved dead end, or when the message has no text; and the MCP tools send
the line to add, your memory lines, or for `audit_memory` the project's file names and `package.json` fields. Common
secret shapes are replaced with `[REDACTED]` first. There is no telemetry. Details:
https://github.com/Avinash-jetwani/jevmem/blob/main/SECURITY.md

## Privacy

[Privacy](https://github.com/Avinash-jetwani/jevmem/blob/main/PRIVACY.md): what jevmem reads, stores and sends, the
services it sends data to and their privacy policies, and how to delete it.

## Switching it off

`jevmem disable` in a project sets its config aside and leaves `JEVMEM.md` untouched; the plugin then does nothing
there. Uninstall the plugin from Customize, or delete its folder under `~/.cursor/plugins/local/`.