/** Per-tool setup for `jevmem init --tool …`: Cursor, Codex, Claude Desktop. Claude Code hooks live in init.ts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOOLS = ["claude", "cursor", "codex", "claude-desktop"] as const;
export type Tool = (typeof TOOLS)[number];

export interface ToolSetupResult {
  created: string[];
  skipped: string[];
  notes: string[];
}

/** Called before any write outside the project, with the path, the backup path, and the exact text to be appended. */
export type Announce = (info: { file: string; backup: string; lines: string }) => void;

export const CODEX_MCP_SECTION = `[mcp_servers.jevmem]
command = "npx"
args = ["-y", "jevmem", "mcp"]
`;

/** Which tools look present in this project (or on this machine, for Codex). */
export function detectTools(root: string, home = os.homedir()): Tool[] {
  const out: Tool[] = [];
  if (fs.existsSync(path.join(root, ".claude"))) out.push("claude");
  if (fs.existsSync(path.join(root, ".cursor"))) out.push("cursor");
  if (fs.existsSync(path.join(root, "AGENTS.md")) || fs.existsSync(path.join(home, ".codex"))) out.push("codex");
  return out;
}

const MCP_ENTRY = { command: "npx", args: ["-y", "jevmem", "mcp"] };

export const CURSOR_RULE = `---
description: Project memory via Jevmem (JEVMEM.md). Use the jevmem MCP tools to read and write it.
alwaysApply: true
---

# Jevmem project memory

This project keeps durable memory in \`JEVMEM.md\` (one line per decision, constraint, preference, bug, architecture fact, or todo), managed by the \`jevmem\` MCP server.

- Before any non-trivial task, call \`search_memory\` with a one-line description of the task and read the results. They are decisions and constraints from earlier sessions; follow them unless the user overrides.
- When the user states a decision, a hard rule, a preference, a root cause, or defers work, call \`add_memory\` with one line (≤ 140 chars) and the right kind: decision | constraint | preference | bug | architecture | todo.
- If something you learned contradicts a memory, add the new memory and tell the user which line it replaces.
- Do not add greetings, questions, or anything already obvious from the code.
`;

export const AGENTS_SECTION = `
## Jevmem project memory

Durable project memory lives in \`JEVMEM.md\` (one line per decision, constraint, preference, bug, architecture fact, or todo) and is served by the \`jevmem\` MCP server.

- Before any non-trivial task, call the \`search_memory\` tool with a one-line description of the task and follow what comes back unless the user overrides it.
- When the user states a decision, a hard rule, a preference, a root cause, or defers work, call \`add_memory\` with one line (≤ 140 chars) and the right kind: decision | constraint | preference | bug | architecture | todo.
- If something contradicts an existing memory, add the new line and say which memory it replaces.
- Never add greetings, questions, or things already obvious from the code.
`;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function setupCursor(root: string): ToolSetupResult {
  const r: ToolSetupResult = { created: [], skipped: [], notes: [] };
  const dir = path.join(root, ".cursor");
  fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
  const mcpFile = path.join(dir, "mcp.json");
  const mcp = readJson(mcpFile);
  mcp.mcpServers ??= {};
  if (!mcp.mcpServers.jevmem) {
    mcp.mcpServers.jevmem = { ...MCP_ENTRY, env: { TYPESAFE_API_KEY: "${env:TYPESAFE_API_KEY}" } };
    fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
    r.created.push(".cursor/mcp.json (jevmem server)");
  } else r.skipped.push(".cursor/mcp.json (jevmem server)");
  const rule = path.join(dir, "rules", "jevmem.mdc");
  if (!fs.existsSync(rule)) {
    fs.writeFileSync(rule, CURSOR_RULE);
    r.created.push(".cursor/rules/jevmem.mdc");
  } else r.skipped.push(".cursor/rules/jevmem.mdc");
  r.notes.push("Cursor has no per-turn hook: capture happens when the agent calls add_memory (the rule tells it when). Reload the window so Cursor picks up the MCP server.");
  return r;
}

export function setupCodex(root: string, home = os.homedir(), announce?: Announce): ToolSetupResult {
  const r: ToolSetupResult = { created: [], skipped: [], notes: [] };
  const agents = path.join(root, "AGENTS.md");
  const cur = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
  if (/##\s+Jevmem project memory/i.test(cur)) r.skipped.push("AGENTS.md (jevmem section)");
  else {
    fs.writeFileSync(agents, (cur ? cur.replace(/\s+$/, "") + "\n" : "# AGENTS.md\n") + AGENTS_SECTION);
    r.created.push(cur ? "AGENTS.md (+ jevmem section)" : "AGENTS.md");
  }
  const cfg = path.join(home, ".codex", "config.toml");
  if (fs.existsSync(cfg)) {
    const toml = fs.readFileSync(cfg, "utf8");
    if (/^\[mcp_servers\.jevmem\]/m.test(toml)) r.skipped.push("~/.codex/config.toml (jevmem server)");
    else {
      // This is the one write outside the project: say exactly what will change, and keep a backup.
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const backup = `${cfg}.bak-${stamp}`;
      const addition = `${toml.endsWith("\n") ? "" : "\n"}\n${CODEX_MCP_SECTION}`;
      announce?.({ file: cfg, backup, lines: CODEX_MCP_SECTION });
      fs.copyFileSync(cfg, backup);
      fs.appendFileSync(cfg, addition);
      r.created.push(`~/.codex/config.toml (+ [mcp_servers.jevmem]; backup at ${backup.replace(home, "~")})`);
    }
  } else r.notes.push("~/.codex/config.toml not found; when Codex is installed, add the server with: codex mcp add jevmem -- npx -y jevmem mcp");
  r.notes.push("Codex has no per-turn hook: run `jevmem watch` in the project to capture turns from Codex's session log, or rely on add_memory.");
  return r;
}

export function claudeDesktopSnippet(root: string): string {
  return JSON.stringify({ mcpServers: { jevmem: { ...MCP_ENTRY, cwd: root, env: { TYPESAFE_API_KEY: "your-key" } } } }, null, 2);
}

export function setupClaudeDesktop(root: string): ToolSetupResult {
  const file = process.platform === "darwin" ? "~/Library/Application Support/Claude/claude_desktop_config.json" : process.platform === "win32" ? "%APPDATA%\\Claude\\claude_desktop_config.json" : "~/.config/Claude/claude_desktop_config.json";
  return { created: [], skipped: [], notes: [`Claude Desktop: add this to ${file} (not edited automatically), then restart Claude Desktop:\n${claudeDesktopSnippet(root)}`] };
}
