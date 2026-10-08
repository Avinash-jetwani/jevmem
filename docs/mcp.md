# MCP server and client configs

## MCP server

`jevmem mcp` starts a stdio MCP server with four tools:

| Tool | Args | Jev calls | Annotations (readOnly / destructive / idempotent / openWorld) |
|---|---|---|---|
| `search_memory` | `query`, `limit?` | 1 (choice over ids + noul per candidate, + a poisoning-gate noul per unverified, unchecked candidate) | true / false / true / true |
| `add_memory` | `text`, `kind` | 1, or 2 on a borderline line (the hook's decide: scrub, then refuse injection / small talk; since 0.7.0 a line a live memory already says is not added and the answer names that line, `duplicate_of`, with no error; Jev may correct the kind; a contradiction supersedes the old line) | false / true / false / true |
| `list_memory` | `include_superseded?` | 0, or 1 when unverified lines have no cached gate verdict (the poisoning gate alone) | true / false / true / true |
| `audit_memory` | `apply?` | ⌈memories / 60⌉ | false / true / true / true |

In a project without `jevmem.config.json` (not opted in with `jevmem enable` or `jevmem init`) every tool returns only "jevmem isn't enabled in this project: run `jevmem enable`" and does nothing else: no Jev call, no file.

`search_memory` and `list_memory` never return a line the [poisoning gate](../SECURITY.md#memory-poisoning) withholds (they list it under `withheld` with the reason instead), and `list_memory` without a key withholds unverified lines it cannot check. Both are marked open-world because they may ask Jev.

`add_memory` takes `kind` ∈ `decision | constraint | preference | bug | architecture | todo`, and, since 0.6.0, `dead-end`: an approach that was tried and failed or was dropped. A dead-end line must say what was tried and why, and Jev decides whether it does (the dead-end noul, in the request `add_memory` already makes, at `thresholds.deadEndMin`), or it is refused ("a dead end must say why it failed or was dropped, and Jev found no reason in this line"); a line Jev reads as a dead end with no reason keeps the kind you gave. A retry of a saved dead end that failed again for the reason that line gives is refused ("a retry that failed again adds nothing"); for a new reason, the saved line is the old line's reason followed by "retried:" and yours, and it replaces the old line ([Dead ends](dead-ends.md#when-it-is-tried-again)). `search_memory` and `list_memory` return dead ends with `"kind": "dead-end"`; the Claude Code hook injects them as `Already tried: <line>` ([Dead ends](dead-ends.md)).

Both writing tools are marked destructive because they can change existing lines, not only add new ones: `add_memory` re-tags a contradicted memory `[superseded]`, which takes it out of what is served (the line stays in the file), and `audit_memory` with `apply: true` sets or clears `[stale?]` flags on existing lines (flagged lines keep their text and stay live).

The `Dockerfile` at the repository root is for MCP directories that inspect a server in a sandbox (Glama builds it, starts the server and calls `tools/list`): it installs the jevmem CLI from npm and starts `jevmem mcp` on an empty folder, where the server lists its four tools and a call to one replies that jevmem isn't enabled there. It needs no key. It is not a way to run jevmem: the server works on the project it is started in.

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "jevmem": {
      "command": "npx",
      "args": ["-y", "jevmem", "mcp"],
      "env": { "TYPESAFE_API_KEY": "${env:TYPESAFE_API_KEY}" }
    }
  }
}
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Claude Desktop does not inherit your shell and has no project directory, so name the project with `--root` and give the key explicitly. One config entry serves one project:

```json
{
  "mcpServers": {
    "jevmem": {
      "command": "npx",
      "args": ["-y", "jevmem", "mcp", "--root", "/absolute/path/to/your-project"],
      "env": { "TYPESAFE_API_KEY": "<your TypeSafe API key>" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.jevmem]
command = "npx"
args = ["-y", "jevmem", "mcp"]
env = { TYPESAFE_API_KEY = "<your TypeSafe API key>" }
```

`jevmem init --tool codex` writes this section without the `env` line; the server then reads the key from `~/.jevmem/env` (jevmem does not read shell profiles). That needs jevmem 0.5.8 or later: 0.5.7's server read only its own environment, so with 0.5.7 keep the `env` line. Or from the CLI: `codex mcp add jevmem -- npx -y jevmem mcp`.

### Claude Code plugin

The plugin (`claude plugin install jevmem@jevmem`, see [install.md](install.md#from-the-jevmem-marketplace)) declares the server itself as the command `jevmem mcp`, serving the project in `CLAUDE_PROJECT_DIR`. It needs `jevmem` on the PATH Claude Code runs with; without it, `/mcp` shows the server as failed. With the hooks recording every turn, `add_memory` is only for things the user asks to record that the conversation does not state.

### Claude Code (as an MCP server, in addition to the hooks)

```bash
claude mcp add jevmem -- npx -y jevmem mcp
```

The server reads `JEVMEM.md` from its working directory, or from `--root <dir>` / `JEVMEM_ROOT` when given.
