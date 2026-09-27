/**
 * Key discovery for processes that don't get a login shell (Claude Code desktop hooks, Cursor/Codex MCP servers).
 * Order: the Claude Code plugin's `typesafe_api_key` option (`CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY`, see
 * `applyPluginOption`) → process env → `<project>/.jevmem/.env` → `~/.jevmem/env`. The last two are jevmem's own
 * files, which the user creates. Shell profiles are not read (since 0.5.4). Only the named variables are read, and
 * the key is never logged or printed.
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

/** Where the TypeSafe key comes from, by name only (never the value). */
export type KeySource = "plugin setting" | "environment" | "<project>/.jevmem/.env" | "~/.jevmem/env" | null;

/**
 * Apply the plugin option and the fallback files (as every command does), and say where TYPESAFE_API_KEY came from.
 * Call it before anything else loads keys, or the answer is "environment".
 */
export function resolveJevKey(root: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): KeySource {
  if (applyPluginOption(env)) return "plugin setting";
  if (env.TYPESAFE_API_KEY?.trim()) return "environment";
  const loaded = loadEnvFallbacks(root, env, home).find((l) => l.name === "TYPESAFE_API_KEY");
  if (!loaded) return null;
  return loaded.from.startsWith("~") ? "~/.jevmem/env" : "<project>/.jevmem/.env";
}

/**
 * A pasted key, cleaned: surrounding space and quotes and a leading `TYPESAFE_API_KEY=` (or `export …=`) removed.
 * Null when what is left cannot be written as an unquoted value that `parseEnvFile` reads back whole (empty, too short,
 * or with a space, quote, `#`, `$`, backslash or backtick).
 */
export function cleanPastedKey(raw: string): string | null {
  const k = raw
    .trim()
    .replace(/^(?:export\s+)?TYPESAFE_API_KEY\s*=\s*/, "")
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  return k.length >= 8 && k.length <= 512 && !/[\s"'#$\\`]/.test(k) ? k : null;
}

const KEY_LINE = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/;

/** Does ~/.jevmem/env already hold a TypeSafe key (a TYPESAFE_API_KEY line with a value)? */
export function hasSavedJevKey(home: string = os.homedir()): boolean {
  try {
    return fs.readFileSync(path.join(home, ".jevmem", "env"), "utf8").split("\n").some((l) => KEY_LINE.test(l) && l.replace(KEY_LINE, "").trim() !== "");
  } catch {
    return false;
  }
}

/**
 * Save the TypeSafe key to ~/.jevmem/env (`jevmem key`). An earlier TYPESAFE_API_KEY line there is replaced and every
 * other line kept. The folder is made 0700 and the file 0600, an existing one before the key goes in. Returns the
 * file's path. Never prints or logs the key.
 */
export function saveJevKey(key: string, home: string = os.homedir()): string {
  const dir = path.join(home, ".jevmem");
  const file = path.join(dir, "env");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    /* a new file */
  }
  lines = lines.filter((l) => !KEY_LINE.test(l));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  lines.push(`TYPESAFE_API_KEY=${key}`);
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** What to do when no TypeSafe key is found: the one command, and the plugin's own setting. Never prints a key. */
export const MISSING_KEY_HELP = [
  "No TypeSafe API key found, so jevmem does nothing yet. To fix it, run jevmem key in a terminal and paste your key.",
  "It is saved in ~/.jevmem/env, readable only by you.",
  "With the Claude Code plugin you can instead run /plugin configure jevmem in Claude Code (kept in your system's credential store).",
  "Get a key at https://console.typesafe.ai/keys",
].join("\n");
