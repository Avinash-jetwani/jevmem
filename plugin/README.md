# jevmem plugin for Claude Code

Automatic project memory for Claude Code. After each message, TypeSafe's Jev decides whether it is worth remembering and saves it as one line in `JEVMEM.md` in your repository. On each prompt, the relevant lines are added to Claude's context. It is opt-in per project and does nothing until you run `jevmem enable` there. Full documentation: https://github.com/Avinash-jetwani/jevmem

## Where it works

Supported in Claude Code only: the terminal, the IDE extensions and the desktop app's Code tab. claude.ai chat ignores hooks and local MCP servers, so the plugin does nothing there. It is not supported or tested in Cowork.

## Setup

If you added jevmem from the Claude directory, skip the marketplace commands: install the CLI and run `jevmem enable`.

This plugin contains no jevmem code. It runs the `jevmem` command-line tool, which you install separately from npm. Its source is in this repository: https://github.com/Avinash-jetwani/jevmem/tree/main/src

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem enable
```

You need a TypeSafe AI key (https://typesafe.ai): enter it with `/plugin configure jevmem@jevmem` in Claude Code (see [Your API key](#your-api-key)). `jevmem doctor` checks the setup. `jevmem enable` creates `jevmem.config.json`, `JEVMEM.md` and `.jevmem/` in the project, and adds `.jevmem/` to `.gitignore`.

## What it runs

- **Two hooks.** `UserPromptSubmit` adds relevant memory lines to your prompt. `Stop` runs asynchronously, so Claude doesn't wait for it, and hands the finished turn to jevmem. Both run `hooks/jevmem-hook.sh`, a short shell script in this folder. It looks for the installed `jevmem` CLI and Node 20+, then runs `jevmem hook --plugin`. The script contains no download or install step. If the CLI is older than the plugin, it prints one warning line.
- **One MCP server:** the command `jevmem mcp`, with the tools `search_memory`, `add_memory`, `list_memory` and `audit_memory`. It needs `jevmem` on the PATH Claude Code runs with. Without it, the server fails to start and `/mcp` shows the failure.

## Projects that aren't enabled

In a project without `jevmem.config.json`, the hooks read their input and exit. The MCP tools reply only "jevmem isn't enabled in this project: run `jevmem enable`". There are no network calls, no files and no output (tested). Without the `jevmem` CLI installed, the hooks also exit silently.

## What it sends, and where

Only in an enabled project. Before anything is sent, common secret shapes are replaced with `[REDACTED]`: API keys and tokens, passwords, credentials in connection strings, private keys, email addresses. This is best effort, so don't paste secrets into prompts.

- **To TypeSafe AI, `https://api.typesafe.ai/v1/systemone`**, or the URL in `TYPESAFE_BASE_URL` if you set it:
  - on each prompt: the prompt and up to 60 of your memory lines;
  - after each turn: your message, the previous two turns (shortened), and up to 200 memory lines. Claude's reply is included only when your message reads as a question or a bug report, or has no text;
  - from the MCP tools: the line to add (`add_memory`), your memory lines (`search_memory`, `list_memory`), and for `audit_memory` the file names to depth 3 (not their contents), `package.json` fields and the first 3,000 characters of your README.
- **To OpenAI (`https://api.openai.com`) or Anthropic (`https://api.anthropic.com`)**, or the URL in `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`, only when you set `"writer": "openai"` or `"anthropic"` in the project's `jevmem.config.json` (and that provider's key): the text of a turn Jev decided to save, to condense it into one line. An OpenAI or Anthropic key in your environment is not enough on its own. By default jevmem writes the line itself and sends nothing to either.

There is no telemetry. Details: https://github.com/Avinash-jetwani/jevmem/blob/main/SECURITY.md

## What it writes

- `JEVMEM.md` in the project: the memory lines, meant to be committed.
- `.jevmem/` in the project, which is gitignored: logs, the save queue, cached Jev answers, and recent decisions with the scrubbed turn text.
- `${CLAUDE_PLUGIN_DATA}/cli`: the paths of the CLI and Node it found, so later runs start faster.
- In the system temp directory: a file holding the `Stop` hook's input, deleted when jevmem reads it. For a very long project path, jevmem's local socket goes there too, instead of in `.jevmem/`.

It writes nothing to `~/.jevmem/`. That folder is read only if you create `~/.jevmem/env` yourself.

## Your API key

Enter your TypeSafe key in the plugin's settings: in Claude Code, run `/plugin configure jevmem@jevmem` (or open jevmem in `/plugin`). The `claude plugin install` shell command doesn't ask for it. The option is marked sensitive, so Claude Code keeps the key in your system's secure credential store. jevmem uses it for the hook or MCP process and doesn't write it to a file or a log.

If you leave it empty, jevmem looks for `TYPESAFE_API_KEY` in this order: the environment, `<project>/.jevmem/.env`, then `~/.jevmem/env`. The last two are jevmem's own files, which you create (a line `TYPESAFE_API_KEY=...`). The same files can hold `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, which are used only when `writer` in `jevmem.config.json` chooses that provider. Only those named variables are parsed, and the files are not executed. jevmem doesn't read shell profiles such as `~/.zshrc`. `jevmem doctor` says where the key was found, without printing it.

## Switching it off

`jevmem disable` in a project sets its config aside and leaves `JEVMEM.md` untouched. `claude plugin uninstall jevmem@jevmem` removes the plugin.
