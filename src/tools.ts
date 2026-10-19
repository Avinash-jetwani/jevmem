/** Per-tool setup for `jevmem init --tool …`: Cursor, Codex, Claude Desktop. Claude Code hooks live in init.ts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorHooksStatus, readCursorPluginMarker, registerCursorHooks } from "./cursor.js";
import { ensureGitignore } from "./init.js";

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

/**
 * Which tools look present in this project. Only the project is inspected, never the home directory: a machine
 * with Codex installed must not turn a plain `jevmem init` into a Codex-only setup. Empty means "use claude".
 */
export function detectTools(root: string): Tool[] {
  const out: Tool[] = [];
  if (fs.existsSync(path.join(root, ".claude"))) out.push("claude");
  if (fs.existsSync(path.join(root, ".cursor"))) out.push("cursor");
  if (fs.existsSync(path.join(root, "AGENTS.md"))) out.push("codex");
  return out;
}

const MCP_ENTRY = { command: "npx", args: ["-y", "jevmem", "mcp"] };
const CURSOR_HOOK_EVENT_LIST = "sessionStart, beforeSubmitPrompt, afterAgentResponse, stop and sessionEnd";
/** Cursor reads the key from its own environment: this reference is written to `.cursor/mcp.json` as it is, not expanded by jevmem. */
const CURSOR_KEY_REFERENCE = "${env:TYPESAFE_API_KEY}";

/**
 * The rule, one text for `init --tool cursor`'s file and the plugin's (0.7.6): the plugin's rule is in every chat of
 * every project the plugin is installed for, so it is short and its first sentence keeps the agent off jevmem where
 * the project is not turned on (no `jevmem.config.json`): no tool call, no wasted request. Its context cost is
 * measured in docs/limits.md.
 */
export const CURSOR_RULE = `---
description: jevmem project memory (JEVMEM.md); only in a project that has jevmem.config.json
alwaysApply: true
---

# jevmem project memory

This rule applies only in a project that has a \`jevmem.config.json\` file. Without that file, jevmem is off here: do not call its tools.

Where it is on: before a non-trivial task, call \`search_memory\` with a one-line description of the task and follow what it returns (decisions, rules and failed approaches from earlier sessions; the user's word overrides them). jevmem's hooks save each finished turn on their own, so call \`add_memory\` only for something the user asks to record that the chat does not state. Never edit \`JEVMEM.md\` directly: jevmem writes it.
`;

/** The 0.7.4 and 0.7.5 rule, the 0.4.4 to 0.7.3 rule and the v0.4.3 rule, verbatim; `init --tool cursor` replaces a file that still matches one exactly. */
export const LEGACY_CURSOR_RULES: readonly string[] = [
  `---
description: Project memory via Jevmem (JEVMEM.md). Use the jevmem MCP tools to read it; jevmem saves each turn itself.
alwaysApply: true
---

# Jevmem project memory

This project keeps durable memory in \`JEVMEM.md\` (one line per decision, constraint, preference, bug, architecture fact, to-do or dead end), managed by the \`jevmem\` MCP server. Since jevmem 0.7.4 the hooks in \`.cursor/hooks.json\` save the decisions, rules and failed approaches from each finished agent turn on their own.

- Before any non-trivial task, call \`search_memory\` with a one-line description of the task and read the results. They are decisions and constraints from earlier sessions; follow them unless the user overrides.
- \`add_memory\` is only for something the user asks to record that the conversation does not state (one line, at most 200 characters, with the right kind: decision | constraint | preference | bug | architecture | todo | dead-end). jevmem scrubs secrets and asks Jev first; it may refuse the line (injection, small talk, duplicate) or correct the kind, and says why. What the user says in the chat is saved by the hooks: do not add it again.
- If something you learned contradicts a memory, tell the user which line it contradicts; jevmem supersedes the old line when the user states the change.
- Never add, edit or remove lines in \`JEVMEM.md\` directly: record memories only through \`add_memory\`, which checks and formats them.
`,
  `---
description: Project memory via Jevmem (JEVMEM.md). Use the jevmem MCP tools to read and write it.
alwaysApply: true
---

# Jevmem project memory

This project keeps durable memory in \`JEVMEM.md\` (one line per decision, constraint, preference, bug, architecture fact, or todo), managed by the \`jevmem\` MCP server.

- Before any non-trivial task, call \`search_memory\` with a one-line description of the task and read the results. They are decisions and constraints from earlier sessions; follow them unless the user overrides.
- When the user states a decision, a hard rule, a preference, a root cause, or defers work, call \`add_memory\` with one line (≤ 200 chars) and the right kind: decision | constraint | preference | bug | architecture | todo. jevmem scrubs secrets and asks Jev first; it may refuse the line (injection, small talk, duplicate) or correct the kind, and says why.
- If something you learned contradicts a memory, add the new memory and tell the user which line it replaces.
- Do not add greetings, questions, or anything already obvious from the code.
- Never add, edit or remove lines in \`JEVMEM.md\` directly: record memories only through \`add_memory\`, which checks and formats them.
`,
`---
description: Project memory via Jevmem (JEVMEM.md). Use the jevmem MCP tools to read and write it.
alwaysApply: true
---

# Jevmem project memory

This project keeps durable memory in \`JEVMEM.md\` (one line per decision, constraint, preference, bug, architecture fact, or todo), managed by the \`jevmem\` MCP server.

- Before any non-trivial task, call \`search_memory\` with a one-line description of the task and read the results. They are decisions and constraints from earlier sessions; follow them unless the user overrides.
- When the user states a decision, a hard rule, a preference, a root cause, or defers work, call \`add_memory\` with one line (≤ 200 chars) and the right kind: decision | constraint | preference | bug | architecture | todo. jevmem scrubs secrets and asks Jev first; it may refuse the line (injection, small talk, duplicate) or correct the kind, and says why.
- If something you learned contradicts a memory, add the new memory and tell the user which line it replaces.
- Do not add greetings, questions, or anything already obvious from the code.
`];

export const AGENTS_SECTION = `
## Jevmem project memory

Durable project memory lives in \`JEVMEM.md\` (one line per decision, constraint, preference, bug, architecture fact, or todo) and is served by the \`jevmem\` MCP server.

- Before any non-trivial task, call the \`search_memory\` tool with a one-line description of the task and follow what comes back unless the user overrides it.
- When the user states a decision, a hard rule, a preference, a root cause, or defers work, call \`add_memory\` with one line (≤ 200 chars) and the right kind: decision | constraint | preference | bug | architecture | todo. jevmem scrubs secrets and asks Jev first; it may refuse the line or correct the kind, and says why.
- If something contradicts an existing memory, add the new line and say which memory it replaces.
- Never add greetings, questions, or things already obvious from the code.
- Never add, edit or remove lines in \`JEVMEM.md\` directly: record memories only through \`add_memory\` (with \`jevmem watch\` running, jevmem also records them from the session on its own).
`;

/** The v0.4.3 AGENTS.md section, verbatim; `init --tool codex` replaces it only when it still matches exactly. */
export const LEGACY_AGENTS_SECTIONS: readonly string[] = [`
## Jevmem project memory

Durable project memory lives in \`JEVMEM.md\` (one line per decision, constraint, preference, bug, architecture fact, or todo) and is served by the \`jevmem\` MCP server.

- Before any non-trivial task, call the \`search_memory\` tool with a one-line description of the task and follow what comes back unless the user overrides it.
- When the user states a decision, a hard rule, a preference, a root cause, or defers work, call \`add_memory\` with one line (≤ 200 chars) and the right kind: decision | constraint | preference | bug | architecture | todo. jevmem scrubs secrets and asks Jev first; it may refuse the line or correct the kind, and says why.
- If something contradicts an existing memory, add the new line and say which memory it replaces.
- Never add greetings, questions, or things already obvious from the code.
`];

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * `jevmem init --tool cursor`. With the jevmem plugin for Cursor installed on this computer (0.7.6: the marker its
 * sessionStart hook writes, `~/.jevmem/cursor-plugin`), the plugin saves each turn, serves memory over MCP and carries
 * the rule in every window, so the project needs only to be turned on (which `init` did) and no Cursor file is
 * written; `--files` writes them anyway (a teammate without the plugin), and the plugin stands down beside them.
 */
export function setupCursor(root: string, opts: { files?: boolean } = {}): ToolSetupResult {
  const r: ToolSetupResult = { created: [], skipped: [], notes: [] };
  const plugin = readCursorPluginMarker();
  if (plugin && !opts.files) {
    r.skipped.push(".cursor/ (the jevmem plugin for Cursor is installed on this computer: no hooks file, launcher, MCP entry or rule written here)");
    r.notes.push(`The jevmem plugin for Cursor (${plugin.version}, last ran ${plugin.seen.slice(0, 10)}) is installed on this computer: it saves each finished agent turn, serves memory over MCP and carries the rule in every Cursor window, so this project only had to be turned on, which it now is. For a teammate without the plugin, \`jevmem init --tool cursor --files\` writes the hooks, the launcher, the MCP entry and the rule into the project; the plugin stands down beside them, so nothing is saved twice.`);
    return r;
  }
  const dir = path.join(root, ".cursor");
  fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
  const mcpFile = path.join(dir, "mcp.json");
  const mcp = readJson(mcpFile);
  mcp.mcpServers ??= {};
  if (!mcp.mcpServers.jevmem) {
    mcp.mcpServers.jevmem = { ...MCP_ENTRY, env: { TYPESAFE_API_KEY: CURSOR_KEY_REFERENCE } };
    fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
    r.created.push(".cursor/mcp.json (jevmem server)");
  } else r.skipped.push(".cursor/mcp.json (jevmem server)");
  const rule = path.join(dir, "rules", "jevmem.mdc");
  if (!fs.existsSync(rule)) {
    fs.writeFileSync(rule, CURSOR_RULE);
    r.created.push(".cursor/rules/jevmem.mdc");
  } else if (LEGACY_CURSOR_RULES.includes(fs.readFileSync(rule, "utf8"))) {
    fs.writeFileSync(rule, CURSOR_RULE);
    r.created.push(".cursor/rules/jevmem.mdc (updated: the hooks save each turn; add_memory only for what the chat does not state)");
  } else r.skipped.push(".cursor/rules/jevmem.mdc");
  // 0.7.4: the hooks that save each finished agent turn, and the launcher they run, both committable (no path of this machine).
  const hooks = registerCursorHooks(root);
  const what = `.cursor/hooks.json (jevmem's ${CURSOR_HOOK_EVENT_LIST} hooks) and .cursor/hooks/jevmem-hook.sh`;
  if (hooks === "added") r.created.push(what);
  else if (hooks === "updated") r.created.push(`${what} (updated)`);
  else r.skipped.push(what);
  // 0.7.5: Cursor writes its own state file (continual-learning.json) under .cursor/hooks/state/, next to the launcher
  // the docs invite people to commit, so a git repository gets that folder gitignored (0.7.4's live check committed it).
  ensureGitignore(root, [".cursor/hooks/state/"], r.created);
  const st = cursorHooksStatus(root);
  if (st.others) r.notes.push(`Your other Cursor hooks in .cursor/hooks.json are kept (${st.others} entr${st.others === 1 ? "y" : "ies"}).`);
  if (plugin) r.notes.push(`The jevmem plugin for Cursor (${plugin.version}) is installed on this computer too: beside these project hooks it stands down, so nothing is saved twice.`);
  r.notes.push("Cursor saves each finished agent turn through the hooks in .cursor/hooks.json (the launcher runs the jevmem it finds on PATH or in the usual places; a clone without jevmem stays silent). Reload the window once so Cursor picks up the hooks. Then turn the project's MCP server on once in the Cursor app (Customize > MCPs > jevmem > Configure > the source toggle for .cursor/mcp.json, then Reload): Cursor starts a project's MCP server only after that, and recall is the agent's search_memory call over it.");
  return r;
}

/**
 * `jevmem init --remove-hooks` with the Cursor plugin on this computer (0.7.6): the plugin carries the rule and the
 * MCP server, so jevmem's rule file goes when its text is one jevmem wrote (unchanged by the user) and the `jevmem`
 * entry of `.cursor/mcp.json` when it is the one `init` wrote; other servers and a changed rule stay. The paths changed.
 */
export function unregisterCursorFiles(root: string): string[] {
  const changed: string[] = [];
  const rule = path.join(root, ".cursor", "rules", "jevmem.mdc");
  try {
    const text = fs.readFileSync(rule, "utf8");
    if (text === CURSOR_RULE || LEGACY_CURSOR_RULES.includes(text)) {
      fs.unlinkSync(rule);
      changed.push(".cursor/rules/jevmem.mdc");
      try {
        if (!fs.readdirSync(path.dirname(rule)).length) fs.rmdirSync(path.dirname(rule));
      } catch {
        /* not empty */
      }
    }
  } catch {
    /* no rule */
  }
  const mcpFile = path.join(root, ".cursor", "mcp.json");
  const mcp = readJson(mcpFile);
  const entry = mcp?.mcpServers?.jevmem;
  if (entry && JSON.stringify(entry) === JSON.stringify({ ...MCP_ENTRY, env: { TYPESAFE_API_KEY: CURSOR_KEY_REFERENCE } })) {
    delete mcp.mcpServers.jevmem;
    if (Object.keys(mcp.mcpServers).length || Object.keys(mcp).some((k) => k !== "mcpServers")) fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
    else fs.unlinkSync(mcpFile);
    changed.push(".cursor/mcp.json");
  }
  return changed;
}

/**
 * Codex setup. The AGENTS.md section is always written; `~/.codex/config.toml` (the only file outside the project
 * jevmem ever edits) is touched only when `editGlobalConfig` is true, i.e. the user passed `--tool codex` or `--tool all`.
 */
/** The whole jevmem section of an AGENTS.md: from its heading to the next `## ` heading or the end. */
function jevmemSection(text: string): string | null {
  const m = /^##\s+Jevmem project memory[^\n]*\n[\s\S]*?(?=^##\s|(?![\s\S]))/m.exec(text);
  return m ? m[0] : null;
}

export function setupCodex(root: string, home = os.homedir(), announce?: Announce, editGlobalConfig = true): ToolSetupResult {
  const r: ToolSetupResult = { created: [], skipped: [], notes: [] };
  const agents = path.join(root, "AGENTS.md");
  const cur = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
  const section = jevmemSection(cur);
  if (section !== null && LEGACY_AGENTS_SECTIONS.some((sec) => sec.trim() === section.trim())) {
    fs.writeFileSync(agents, cur.replace(section.trim(), AGENTS_SECTION.trim()));
    r.created.push("AGENTS.md (jevmem section updated: never edit JEVMEM.md directly)");
  } else if (/##\s+Jevmem project memory/i.test(cur)) r.skipped.push("AGENTS.md (jevmem section)");
  else {
    fs.writeFileSync(agents, (cur ? cur.replace(/\s+$/, "") + "\n" : "# AGENTS.md\n") + AGENTS_SECTION);
    r.created.push(cur ? "AGENTS.md (+ jevmem section)" : "AGENTS.md");
  }
  const cfg = path.join(home, ".codex", "config.toml");
  if (!editGlobalConfig) {
    r.notes.push("Codex was detected from AGENTS.md, so ~/.codex/config.toml was not edited. To register the MCP server there, run `jevmem init --tool codex` or: codex mcp add jevmem -- npx -y jevmem mcp");
  } else if (fs.existsSync(cfg)) {
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

/** Claude Desktop has one global config and no project working directory, so the project is passed with `--root`. */
export function claudeDesktopSnippet(root: string): string {
  return JSON.stringify({ mcpServers: { jevmem: { command: "npx", args: ["-y", "jevmem", "mcp", "--root", root], env: { TYPESAFE_API_KEY: "<your TypeSafe API key>" } } } }, null, 2);
}

export function setupClaudeDesktop(root: string): ToolSetupResult {
  const file = process.platform === "darwin" ? "~/Library/Application Support/Claude/claude_desktop_config.json" : process.platform === "win32" ? "%APPDATA%\\Claude\\claude_desktop_config.json" : "~/.config/Claude/claude_desktop_config.json";
  return {
    created: [],
    skipped: [],
    notes: [
      `Claude Desktop: add this to ${file} (not edited automatically), then restart Claude Desktop:\n${claudeDesktopSnippet(root)}\n` +
        "One config serves one project (the --root path). Claude Desktop has no per-turn hook and no rule file: it calls add_memory / search_memory only when you ask it to.",
    ],
  };
}
