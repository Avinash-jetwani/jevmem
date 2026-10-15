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

3. In a terminal, in your project's folder, finish the setup in one go:

   ```bash
   jevmem setup
   ```

   It says which `jevmem` and which plugin it found; asks for your TypeSafe key (from [console.typesafe.ai/keys](https://console.typesafe.ai/keys)) without showing it as you paste, and saves it in `~/.jevmem/env`, readable only by you (a key already saved is kept); turns jevmem on in that folder, where the plugin does nothing until then; checks the key with one request to TypeSafe (the fixed words "jevmem setup: key check", nothing from your project: [PRIVACY.md](../PRIVACY.md)); runs `jevmem doctor`; and, when the project has past Claude Code sessions, offers to import them: the count and the cost first, then the lines it would add, and nothing is sent or written before you say yes to each. By hand instead: `jevmem key`, then `jevmem enable` in the folder.
4. Start Claude Code in that project, signed in with the same Claude account as the app. The plugin shows as `jevmem@synced` (run `/reload-plugins` if Claude Code asks).
5. `jevmem doctor` checks the setup any time. If Claude Code shows "jevmem: CLI not found", see [if the plugin can't find the CLI](install.md#if-the-plugin-cant-find-the-cli).

**If you start Claude Code before the setup is done** (since 0.7.2), the plugin says so once, at the start of a session, and names what is left: the `jevmem` command, or this project not turned on yet, with `jevmem setup` as the one command, which asks for your key if none is saved. It is shown once per machine, and never again after it has been shown, after the setup is done, or after you opt out; it sends nothing and writes nothing inside the project ([the one-time setup message](hooks.md#the-claude-code-plugin)). A terminal shows it as a line from the `SessionStart` hook; in the Claude desktop app's Code tab, which does not draw such lines, Claude passes it on at the start of its first reply.

Claude Code's own memory may also say it saved something; `JEVMEM.md` shows what jevmem saved.

## From the jevmem marketplace

```bash
npm install -g jevmem
claude plugin marketplace add Avinash-jetwani/jevmem
claude plugin install jevmem@jevmem
cd your-project && jevmem setup
```

`jevmem setup` asks for your key (or run `jevmem key`); for a plugin installed from a marketplace you can instead enter it in Claude Code with `/plugin configure jevmem`, which Claude Code keeps in your system's secure credential store (the `claude plugin install` shell command doesn't ask for it). That setting exists only for a plugin installed from a marketplace: the directory's `jevmem@synced` has no Configure options.

## If the plugin can't find the CLI

The plugin runs the `jevmem` CLI from npm, so install that first. The hooks find it on the PATH Claude Code gives them or, when that PATH lacks it (the desktop app's can), in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.volta/bin` or the newest Node version under `~/.nvm`. Without it, an enabled project shows "jevmem: CLI not found, so memory is off in this project" on the first prompt of each session, and the MCP server fails to start (`/mcp` shows it as failed). The plugin does nothing until you run `jevmem enable` in a project; what it runs, and how to switch it off: [docs/hooks.md](hooks.md#the-claude-code-plugin).

**Option 2: npm** (also sets up Cursor and Codex)

```bash
npm install -g jevmem
cd your-project
jevmem init --tool claude
```

`init` creates `JEVMEM.md`, `jevmem.config.json` and `.jevmem/`, and registers the four Claude Code hooks: `Stop`, `UserPromptSubmit`, `PreToolUse` and, since 0.7.1, `SessionStart` ([details](hooks.md#what-init-sets-up)). Hooks don't get your shell's variables and jevmem doesn't read shell profiles, so save the key with `jevmem key`, which puts it in `~/.jevmem/env`. `jevmem doctor` checks the setup.

**Already have a `CLAUDE.md`?** `jevmem import` splits `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/*` into statements, puts each through the same gate as a turn, and prints what it would add; `--apply` writes them. `--from claude-auto-memory` also reads Claude Code's own auto memory for the project. The source files are only read. Since 0.7.1, `jevmem import --from sessions` reads the project's past Claude Code sessions the same way, after showing the count and the cost and asking ([how it works](how-it-works.md#import-srcimportts)).

## Works with

What is automatic and what depends on the agent:

| Tool | Setup | Capture | Recall |
|---|---|---|---|
| **Claude Code** | the plugin, or `jevmem init --tool claude` | **Automatic**, every turn, via the `Stop` hook | **Automatic**, every prompt, via `UserPromptSubmit` |
| **Codex** | `jevmem init --tool codex` | **Automatic while `jevmem watch` runs** (it tails Codex's session log for this project and runs the same decide → write path); otherwise agent-initiated via MCP `add_memory`, prompted by an `AGENTS.md` section | Agent-initiated: `search_memory` via MCP, prompted by `AGENTS.md` |
| **Cursor** | `jevmem init --tool cursor` | Agent-initiated: a `.cursor/rules/jevmem.mdc` rule tells the agent to call MCP `add_memory` when you state a decision. Nothing is captured if it doesn't | Agent-initiated: the rule tells it to call `search_memory` before non-trivial tasks |
| **Claude Desktop** | `jevmem init --tool claude-desktop` prints a config snippet to paste (one project per config, named with `--root`) | Manual: ask it to call `add_memory` (no hook, no rule file) | On request: `search_memory` |

MCP `add_memory` goes through the same gate as the hook. Client configs: [docs/mcp.md](mcp.md).
