# MCP server and client configs

## MCP server

`jevmem mcp` starts a stdio MCP server with four tools:

| Tool | Args | Jev calls | Annotations (readOnly / destructive / idempotent / openWorld) |
|---|---|---|---|
| `search_memory` | `query`, `limit?` | 1 (choice over ids + noul per candidate) | true / false / true / true |
| `add_memory` | `text`, `kind` | 1, or 2 on a borderline line (the hook's decide: scrub, then refuse injection / small talk / duplicates; Jev may correct the kind; a contradiction supersedes the old line) | false / true / false / true |
| `list_memory` | `include_superseded?` | 0 | true / false / true / false |
| `audit_memory` | `apply?` | ⌈memories / 60⌉ | false / true / true / true |

Both writing tools are marked destructive because they can change existing lines, not only add new ones: `add_memory` re-tags a contradicted memory `[superseded]`, which takes it out of what is served (the line stays in the file), and `audit_memory` with `apply: true` sets or clears `[stale?]` flags on existing lines (flagged lines keep their text and stay live).

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
      "env": { "TYPESAFE_API_KEY": "your-key" }
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
env = { TYPESAFE_API_KEY = "your-key" }
```

`jevmem init --tool codex` writes this section without the `env` line; the server then reads the key from `~/.jevmem/env` or your shell profile. Or from the CLI: `codex mcp add jevmem -- npx -y jevmem mcp`.

### Claude Code (as an MCP server, in addition to the hooks)

```bash
claude mcp add jevmem -- npx -y jevmem mcp
```

The server reads `JEVMEM.md` from its working directory, or from `--root <dir>` / `JEVMEM_ROOT` when given.
