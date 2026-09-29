/**
 * How the jevmem Claude Code plugin is installed on this machine, read from Claude Code's own files (read only, no
 * process started), for `jevmem doctor`, `jevmem enable` and the key advice.
 *
 * - Synced from claude.ai: a plugin added in the Claude app (Plugins → Discover → Add) shows in Claude Code as
 *   `jevmem@synced`. Claude Code 2.1.284 keeps it in `<plugins>/synced/<bucket>/<id>/`, with the plugin's own
 *   `.claude-plugin/plugin.json`; it is not listed in `settings.json` or `installed_plugins.json`. It has no Configure
 *   options, so `/plugin configure jevmem` does not apply to it.
 * - From a marketplace (`claude plugin install jevmem@<marketplace>`): enabled in the user's or the project's settings
 *   (`enabledPlugins`), with its version in `<plugins>/installed_plugins.json`. `/plugin configure jevmem` sets its
 *   key option.
 *
 * `<config>` is CLAUDE_CONFIG_DIR, else ~/.claude. `<plugins>`, the plugins root, is CLAUDE_CODE_PLUGIN_CACHE_DIR, else
 * `<config>/plugins` (code.claude.com/docs/en/env-vars: it "sets the parent directory, not the cache itself").
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PluginInstall =
  | { kind: "synced"; version: string | null; dir: string; enabled: boolean }
  | { kind: "marketplace"; id: string; version: string | null; where: string };

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const configDir = (env: NodeJS.ProcessEnv, home: string) => env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
const pluginsRoot = (env: NodeJS.ProcessEnv, home: string) => (env.CLAUDE_CODE_PLUGIN_CACHE_DIR ? path.resolve(env.CLAUDE_CODE_PLUGIN_CACHE_DIR) : path.join(configDir(env, home), "plugins"));

/** The jevmem plugins synced from claude.ai: `<plugins>/synced/*\/*\/.claude-plugin/plugin.json` named jevmem. */
function syncedInstalls(env: NodeJS.ProcessEnv, home: string, userSettings: any): PluginInstall[] {
  const base = path.join(pluginsRoot(env, home), "synced");
  const out: PluginInstall[] = [];
  const dirs = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => path.join(d, e.name));
    } catch {
      return [];
    }
  };
  // Turned off in the user's settings (`"jevmem@synced": false`), it is still on disk but its hooks do not run.
  const enabled = userSettings?.enabledPlugins?.["jevmem@synced"] !== false;
  for (const bucket of dirs(base))
    for (const dir of dirs(bucket)) {
      const pj = readJson(path.join(dir, ".claude-plugin", "plugin.json"));
      if (pj?.name === "jevmem") out.push({ kind: "synced", version: typeof pj.version === "string" ? pj.version : null, dir, enabled });
    }
  return out;
}

/**
 * Every jevmem plugin install Claude Code would load in `root`: synced from claude.ai, and enabled from a marketplace
 * in the user's settings or the project's (.claude/settings.json, .claude/settings.local.json).
 */
export function pluginInstalls(root: string, env: NodeJS.ProcessEnv = process.env, home: string = env.HOME ?? os.homedir()): PluginInstall[] {
  const userFile = path.join(configDir(env, home), "settings.json");
  const userSettings = readJson(userFile);
  const installed = readJson(path.join(pluginsRoot(env, home), "installed_plugins.json"))?.plugins ?? {};
  const versionOf = (id: string): string | null => {
    const e = installed[id];
    const v = Array.isArray(e) ? e[0]?.version : e?.version;
    return typeof v === "string" ? v : null;
  };
  const out: PluginInstall[] = syncedInstalls(env, home, userSettings);
  const seen = new Set<string>();
  const shown = (f: string) => (f.startsWith(home + path.sep) ? "~" + f.slice(home.length) : f);
  for (const file of [userFile, path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json")]) {
    const s = file === userFile ? userSettings : readJson(file);
    for (const [id, on] of Object.entries(s?.enabledPlugins ?? {})) {
      if (on !== true || !/^jevmem@/.test(id) || id === "jevmem@synced" || seen.has(id)) continue;
      seen.add(id);
      out.push({ kind: "marketplace", id, version: versionOf(id), where: shown(file) });
    }
  }
  return out;
}

/** Is a jevmem plugin installed that Claude Code runs (synced and not turned off, or enabled from a marketplace)? */
export const hasActivePlugin = (installs: PluginInstall[]) => installs.some((i) => i.kind === "marketplace" || i.enabled);

/** Does `/plugin configure jevmem` apply: a jevmem plugin installed from a marketplace? */
export const canConfigure = (installs: PluginInstall[]) => installs.some((i) => i.kind === "marketplace");

/** doctor's words for one install. */
export function describeInstall(i: PluginInstall): string {
  const v = i.version ? ` (${i.version})` : "";
  if (i.kind === "synced") return `jevmem plugin, synced from claude.ai${v}${i.enabled ? "" : ', turned off ("jevmem@synced": false in your Claude Code settings)'}`;
  return `jevmem plugin ${i.id}, installed from a marketplace${v}, enabled in ${i.where}`;
}

/**
 * The plugin a hook or MCP server runs from, by the CLAUDE_PLUGIN_ROOT Claude Code gives it: under `plugins/synced/`
 * (added in the Claude app); under `plugins/cache/` (installed from a GitHub or other remote marketplace), each also
 * under a plugins root CLAUDE_CODE_PLUGIN_CACHE_DIR moves; or anywhere
 * else while the settings enable a jevmem plugin from a marketplace (a local marketplace's plugin loads in place, from its
 * own folder); else null (not a plugin, or one loaded another way, such as `--plugin-dir`).
 */
export function runningPlugin(env: NodeJS.ProcessEnv = process.env, root?: string): "synced" | "marketplace" | null {
  if (!env.CLAUDE_PLUGIN_ROOT) return null;
  const r = env.CLAUDE_PLUGIN_ROOT.split(path.sep).join("/");
  const moved = env.CLAUDE_CODE_PLUGIN_CACHE_DIR ? path.resolve(env.CLAUDE_CODE_PLUGIN_CACHE_DIR).split(path.sep).join("/").replace(/\/+$/, "") : null;
  if (/\/plugins\/synced\//.test(r) || (moved && r.startsWith(`${moved}/synced/`))) return "synced";
  if (/\/plugins\/cache\//.test(r) || (moved && r.startsWith(`${moved}/cache/`))) return "marketplace";
  if (root && canConfigure(pluginInstalls(root, env))) return "marketplace";
  return null;
}
