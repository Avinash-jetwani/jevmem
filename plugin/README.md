# jevmem plugin for Claude Code

Automatic project memory for Claude Code. After each message, TypeSafe's Jev decides whether it is worth remembering and saves it as one line in `JEVMEM.md` in your repository; on each prompt, the relevant lines are added to Claude's context. Opt-in per project. Full documentation: https://github.com/Avinash-jetwani/jevmem

## Install

This plugin contains no jevmem code. It runs the `jevmem` command-line tool, which you install from npm first:

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem enable
```

When you enable the plugin, Claude Code asks for your TypeSafe API key (https://typesafe.ai) and keeps it in your system's secure credential store. You can leave it empty and use `TYPESAFE_API_KEY` from your environment, or `~/.jevmem/env`, instead.

## What it runs

- **Two hooks.** `UserPromptSubmit` adds relevant memory lines to your prompt; `Stop` (asynchronous, so Claude never waits for it) hands the finished turn to jevmem. Both run `hooks/jevmem-hook.sh`, a short shell script that looks for the installed `jevmem` CLI and Node, then runs `jevmem hook`. It downloads nothing.
- **One MCP server:** `jevmem mcp`, with the tools `search_memory`, `add_memory`, `list_memory` and `audit_memory`. It needs `jevmem` on the PATH Claude Code runs with; if it is missing, the server fails to start and `/mcp` shows it, and `npm install -g jevmem` fixes it.

## What it does nothing about until you opt in

In a project without `jevmem.config.json` (created by `jevmem enable`), the hooks exit at once and the MCP tools only reply "jevmem isn't enabled in this project: run `jevmem enable`": no network calls, no files, no output. Without the `jevmem` CLI installed, the hooks also exit silently.

## What is sent where

In an enabled project, jevmem sends the scrubbed text of each turn, your prompts and your memory lines to TypeSafe AI's API to be scored, and, only if you configure an OpenAI or Anthropic key, the text of a turn it decided to save to that provider to write the line. Common secrets are removed before anything is sent. No telemetry. Details: https://github.com/Avinash-jetwani/jevmem/blob/main/SECURITY.md
