/**
 * Key discovery for processes that don't get a login shell (Claude Code desktop hooks, Cursor/Codex MCP servers).
 * Order: the Claude Code plugin's `typesafe_api_key` option (`CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY`, see
 * `applyPluginOption`) → process env → `<project>/.jevmem/.env` → `~/.jevmem/env` → `export VAR=…` lines in the
 * user's shell profiles. Only the named variables are read; nothing else in those files is touched. The key is never
 * logged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KEY_VARS = ["TYPESAFE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_BASE_URL", "OPENAI_BASE_URL", "JEVMEM_WRITER", "JEVMEM_WRITER_MODEL"] as const;

const LINE_RE = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/;

/** Parse `KEY=value` / `export KEY="value"` lines from an env-style file. Never throws. */
export function parseEnvFile(file: string, wanted: readonly string[] = KEY_VARS): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (!wanted.includes(name)) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (value && !/\$[({A-Za-z_]/.test(value)) out[name] = value; // skip values that need shell expansion
  }
  return out;
}

export function envFileCandidates(root: string, home = os.homedir()): string[] {
  return [
    path.join(root, ".jevmem", ".env"),
    path.join(home, ".jevmem", "env"),
    path.join(home, ".zshenv"),
    path.join(home, ".zprofile"),
    path.join(home, ".zshrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".bashrc"),
    path.join(home, ".profile"),
  ];
}

/**
 * Fill missing key variables into `env` (default `process.env`) from the fallback files.
 * Returns the names that were loaded and where from, for `jevmem doctor` and the debug log.
 */
export function loadEnvFallbacks(root: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): { name: string; from: string }[] {
  const loaded: { name: string; from: string }[] = [];
  const missing = () => KEY_VARS.filter((k) => !env[k]?.trim());
  if (missing().length === 0) return loaded;
  for (const file of envFileCandidates(root, home)) {
    const need = missing();
    if (need.length === 0) break;
    const found = parseEnvFile(file, need);
    for (const [k, v] of Object.entries(found)) {
      env[k] = v;
      loaded.push({ name: k, from: file.replace(home, "~") });
    }
  }
  return loaded;
}

/** The Claude Code plugin's sensitive `typesafe_api_key` option, as Claude Code passes it to hooks and the MCP server. */
export const PLUGIN_KEY_VAR = "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY";

/**
 * When the plugin's `typesafe_api_key` option is set, it wins over TYPESAFE_API_KEY. An empty value, or a
 * `${user_config.…}` reference Claude Code left unsubstituted, counts as unset. Returns true when it applied.
 */
export function applyPluginOption(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[PLUGIN_KEY_VAR]?.trim();
  if (!v || v.startsWith("${")) return false;
  env.TYPESAFE_API_KEY = v;
  return true;
}
