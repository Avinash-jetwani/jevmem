[← README](../README.md)

# Install

You need a [TypeSafe AI key](https://console.typesafe.ai/keys) for Jev. jevmem writes each line itself; an OpenAI or Anthropic writer is optional and off unless you set `writer` in `jevmem.config.json` ([configuration](configuration.md#the-one-line-writer)).

**Option 1: Claude Code plugin (recommended)**

## From the Claude plugin directory

This needs Claude Code 2.1.273 or later: earlier versions don't sync the plugins you add in the Claude app ([Claude Code docs](https://code.claude.com/docs/en/plugins/loading#synced-plugins)).

1. In the Claude app: **Plugins → Discover → jevmem → Add**. The app warns you before it adds the plugin; the warning is about the plugin's local MCP server, `jevmem mcp`, a command the plugin runs on your computer (the CLI from step 2).
2. Install the CLI the plugin runs:

   ```bash
   npm install -g jevmem
   ```

3. Add your TypeSafe key (from [console.typesafe.ai/keys](https://console.typesafe.ai/keys)): run this, then paste the key when it asks. It doesn't show the key as you paste, and saves it in `~/.jevmem/env`, readable only by you.

   ```bash
   jevmem key
   ```

4. In a terminal, in your project's folder, run `jevmem enable`. The plugin does nothing in a project until you do.
5. Start Claude Code in that project, signed in with the same Claude account as the app. The plugin shows as `jevmem@synced` (run `/reload-plugins` if Claude Code asks).
6. `jevmem doctor` checks the setup. If Claude Code shows "jevmem: CLI not found", see [if the plugin can't find the CLI](install.md#if-the-plugin-cant-find-the-cli).

Claude Code's own memory may also say it saved something; `JEVMEM.md` shows what jevmem saved.

## From the jevmem marketplace

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem enable
```

Add your key with `jevmem key` as in step 3 above, or enter it in Claude Code with `/plugin configure jevmem`, which Claude Code keeps in your system's secure credential store (the `claude plugin install` shell command doesn't ask for it). That setting exists only for a plugin installed from a marketplace: the directory's `jevmem@synced` has no Configure options.

## If the plugin can't find the CLI

The plugin runs the `jevmem` CLI from npm, so install that first. The hooks find it on the PATH Claude Code gives them or, when that PATH lacks it (the desktop app's can), in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.volta/bin` or the newest Node version under `~/.nvm`. Without it, an enabled project shows "jevmem: CLI not found, so memory is off in this project" on the first prompt of each session, and the MCP server fails to start (`/mcp` shows it as failed). The plugin does nothing until you run `jevmem enable` in a project; what it runs, and how to switch it off: [docs/hooks.md](hooks.md#the-claude-code-plugin).

**Option 2: npm** (also sets up Cursor and Codex)

```bash
npm install -g jevmem
cd your-project
jevmem init --tool claude
```

`init` creates `JEVMEM.md`, `jevmem.config.json` and `.jevmem/`, and registers the three Claude Code hooks ([details](hooks.md#what-init-sets-up)). Hooks don't get your shell's variables and jevmem doesn't read shell profiles, so save the key with `jevmem key`, which puts it in `~/.jevmem/env`. `jevmem doctor` checks the setup.

**Already have a `CLAUDE.md`?** `jevmem import` splits `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/*` into statements, puts each through the same gate as a turn, and prints what it would add; `--apply` writes them. `--from claude-auto-memory` also reads Claude Code's own auto memory for the project. The source files are only read.

## Works with

What is automatic and what depends on the agent:

| Tool | Setup | Capture | Recall |
|---|---|---|---|
| **Claude Code** | the plugin, or `jevmem init --tool claude` | **Automatic**, every turn, via the `Stop` hook | **Automatic**, every prompt, via `UserPromptSubmit` |
| **Pi** | `jevmem init --tool pi` and `pi install npm:jevmem` | **Automatic**, on completed turns via `agent_end` | **Automatic**, before prompts via `before_agent_start` (queued prompts via `context`) |
| **Codex** | `jevmem init --tool codex` | **Automatic while `jevmem watch` runs** (it tails Codex's session log for this project and runs the same decide → write path); otherwise agent-initiated via MCP `add_memory`, prompted by an `AGENTS.md` section | Agent-initiated: `search_memory` via MCP, prompted by `AGENTS.md` |
| **Cursor** | `jevmem init --tool cursor` | Agent-initiated: a `.cursor/rules/jevmem.mdc` rule tells the agent to call MCP `add_memory` when you state a decision. Nothing is captured if it doesn't | Agent-initiated: the rule tells it to call `search_memory` before non-trivial tasks |
| **Claude Desktop** | `jevmem init --tool claude-desktop` prints a config snippet to paste (one project per config, named with `--root`) | Manual: ask it to call `add_memory` (no hook, no rule file) | On request: `search_memory` |

MCP `add_memory` goes through the same gate as the hook. Client configs: [docs/mcp.md](mcp.md).
