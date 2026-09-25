import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, writeDefaultConfig } from "./config.js";
import { MEMORY_HEADER, MemoryStore } from "./store.js";

export interface InitOptions {
  root: string;
  /** Command to register in `.claude/settings.local.json`. Resolved automatically when omitted. */
  command?: string;
  hooks?: boolean;
  /** Path of the running CLI (`process.argv[1]`), used to resolve the hook command. */
  cliPath?: string;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  /** Warnings to print (for example: the jevmem plugin is also enabled here). */
  warnings: string[];
  /** The UserPromptSubmit command. */
  command: string;
  /** The Stop command (the detaching launcher on macOS/Linux). */
  stopCommand: string;
}

/**
 * The hook command. Claude Code runs hooks with `sh -c` and the app's own environment: no shell profile, and on a
 * desktop launch often a bare PATH without nvm/volta/homebrew node. So the command always uses the absolute path of
 * the node binary running `init` and the absolute path of this CLI; nothing on PATH is assumed.
 */
export function resolveHookCommand(root: string, cliPath?: string, nodePath: string = process.execPath): string {
  const { node, cli } = hookPaths(cliPath, nodePath);
  void root;
  return `"${node}" "${cli}" hook`;
}

function hookPaths(cliPath?: string, nodePath: string = process.execPath): { node: string; cli: string } {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return { node: real(nodePath), cli: real(path.resolve(cliPath ?? new URL(import.meta.url).pathname)) };
}

/**
 * The Stop command. On macOS and Linux it runs the package's POSIX launcher with `--detach`
 * (`hooks/jevmem-hook.sh`): the hook process exits within milliseconds and node carries on in its own process group,
 * so the end of a session (which signals an async hook's process group) cannot cut the handoff short. On Windows, or
 * when the launcher is missing, it is the same node command as UserPromptSubmit (registered async either way).
 */
export function resolveStopCommand(root: string, cliPath?: string, nodePath: string = process.execPath, platform: NodeJS.Platform = process.platform): string {
  const hookCmd = resolveHookCommand(root, cliPath, nodePath);
  if (platform === "win32") return hookCmd;
  const { node, cli } = hookPaths(cliPath, nodePath);
  const launcher = path.join(path.dirname(path.dirname(cli)), "hooks", "jevmem-hook.sh");
  if (!fs.existsSync(launcher)) return hookCmd;
  return `sh "${launcher}" --node "${node}" --detach hook`;
}

/**
 * Add jevmem's per-machine paths to the project `.gitignore`: `.jevmem/` (local state) and, when hooks are
 * registered, `.claude/settings.local.json` (it holds absolute paths to this machine's node and CLI). A missing
 * `.gitignore` is created only when the folder is a git repository.
 */
export function ensureGitignore(root: string, entries: string[], created: string[]): void {
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi) && !fs.existsSync(path.join(root, ".git"))) return; // not a git repo; `.jevmem/.gitignore` covers .jevmem/
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim().replace(/^\//, "").replace(/\/$/, "")));
  const missing = entries.filter((e) => !have.has(e.replace(/\/$/, "")));
  if (missing.length === 0) return;
  fs.writeFileSync(gi, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + missing.join("\n") + "\n");
  created.push(`.gitignore (+ ${missing.join(", ")})`);
}

export const HOOK_SETTINGS_FILE = "settings.local.json";

function readSettings(file: string): any {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const HOOK_EVENTS: Record<string, number> = { Stop: 20, UserPromptSubmit: 5 };

export function isJevmemHook(h: any, command?: string): boolean {
  return typeof h?.command === "string" && ((command !== undefined && h.command === command) || /jevmem[^ ]*\s+hook\b/.test(h.command) || /jevmem\S*[\\/]dist[\\/]cli\.js"? hook\b/.test(h.command) || /jevmem-hook\.sh"?\s/.test(h.command));
}

/** Remove every jevmem hook from a settings object; returns true when something was removed. Empty groups and events are pruned. */
function removeJevmemHooks(settings: any): boolean {
  if (!settings?.hooks) return false;
  let removed = false;
  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      if (!Array.isArray(g?.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h: any) => !isJevmemHook(h));
      if (g.hooks.length !== before) removed = true;
    }
    settings.hooks[event] = list.filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

/**
 * Register the Stop and UserPromptSubmit hooks in `.claude/settings.local.json`. The command holds absolute
 * machine paths (node binary, CLI), so it does not belong in the shared, committed `.claude/settings.json`;
 * a jevmem hook found there is moved out.
 */
export function registerClaudeHooks(root: string, command: string, stopCommand: string = command): "added" | "updated" | "present" {
  const dir = path.join(root, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const localFile = path.join(dir, HOOK_SETTINGS_FILE);
  const sharedFile = path.join(dir, "settings.json");
  const local: any = readSettings(localFile) ?? {};
  let added = false;
  let updated = false;

  // Migrate: drop any jevmem hook from the shared settings.json.
  const shared = readSettings(sharedFile);
  if (shared && removeJevmemHooks(shared)) {
    fs.writeFileSync(sharedFile, JSON.stringify(shared, null, 2) + "\n");
    updated = true;
  }

  local.hooks ??= {};
  for (const [event, timeout] of Object.entries(HOOK_EVENTS)) {
    const cmd = event === "Stop" ? stopCommand : command;
    // Stop is async (since v0.5.0): it only queues the turn, so Claude Code never waits for it.
    const isAsync = event === "Stop";
    const list: any[] = (local.hooks[event] ??= []);
    let present = false;
    for (const g of list) {
      if (!Array.isArray(g?.hooks)) continue;
      for (const h of g.hooks) {
        if (!isJevmemHook(h, cmd)) continue;
        present = true;
        if (h.command !== cmd) {
          h.command = cmd; // re-running init repairs a stale or PATH-dependent command
          h.timeout ??= timeout;
          updated = true;
        }
        if (isAsync && h.async !== true) {
          h.async = true;
          updated = true;
        }
      }
    }
    if (present) continue;
    list.push({ hooks: [{ type: "command", command: cmd, timeout, ...(isAsync ? { async: true } : {}) }] });
    added = true;
  }
  if (added || updated) fs.writeFileSync(localFile, JSON.stringify(local, null, 2) + "\n");
  return updated ? "updated" : added ? "added" : "present";
}

/** `jevmem init --remove-hooks`: take jevmem's hooks out of the project's Claude Code settings (other hooks stay). */
export function unregisterClaudeHooks(root: string): string[] {
  const removed: string[] = [];
  for (const f of [HOOK_SETTINGS_FILE, "settings.json"]) {
    const file = path.join(root, ".claude", f);
    const s = readSettings(file);
    if (s && removeJevmemHooks(s)) {
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      removed.push(`.claude/${f}`);
    }
  }
  return removed;
}

/** Does this project's `.claude/settings.local.json` or `.claude/settings.json` register a jevmem hook (from `init`)? */
export function projectHasInitHooks(root: string): boolean {
  for (const f of [HOOK_SETTINGS_FILE, "settings.json"]) {
    const s = readSettings(path.join(root, ".claude", f));
    for (const list of Object.values(s?.hooks ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const g of list) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (isJevmemHook(h) && !/--plugin\b/.test(String(h.command) + " " + JSON.stringify(h.args ?? []))) return true;
    }
  }
  return false;
}

/** Does this project's settings enable the jevmem Claude Code plugin (project or local scope)? User scope lives in the home directory, which init does not read. */
export function projectEnablesPlugin(root: string): boolean {
  for (const f of [HOOK_SETTINGS_FILE, "settings.json"]) {
    const s = readSettings(path.join(root, ".claude", f));
    for (const [id, on] of Object.entries(s?.enabledPlugins ?? {})) if (on === true && /^jevmem@/.test(id)) return true;
  }
  return false;
}

export function init(opts: InitOptions): InitResult {
  const root = opts.root;
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const store = new MemoryStore(root);
  if (!store.exists()) {
    fs.writeFileSync(store.file, MEMORY_HEADER);
    created.push("JEVMEM.md");
  } else if (store.upgradeHeader()) created.push("JEVMEM.md (header updated: tells AI assistants not to edit it)");
  else skipped.push("JEVMEM.md");
  if (writeDefaultConfig(root)) created.push(CONFIG_FILE);
  else skipped.push(CONFIG_FILE);
  store.ensureDir();
  created.push(".jevmem/");
  const command = opts.command ?? resolveHookCommand(root, opts.cliPath);
  const stopCommand = opts.command ?? resolveStopCommand(root, opts.cliPath);
  ensureGitignore(root, opts.hooks !== false ? [".jevmem/", `.claude/${HOOK_SETTINGS_FILE}`] : [".jevmem/"], created);
  if (opts.hooks !== false) {
    const r = registerClaudeHooks(root, command, stopCommand);
    (r === "present" ? skipped : created).push(`.claude/${HOOK_SETTINGS_FILE} (Stop (async) + UserPromptSubmit hooks${r === "updated" ? ", updated" : ""})`);
    if (projectEnablesPlugin(root))
      warnings.push("The jevmem Claude Code plugin is also enabled in this project. Its hooks stand down while these init hooks exist, so nothing runs twice. To use only the plugin, run `jevmem init --remove-hooks`.");
  }
  return { created, skipped, warnings, command, stopCommand };
}

const DISABLED_CONFIG = path.join(".jevmem", "jevmem.config.json.disabled");

/**
 * `jevmem enable`: opt this project in (for the Claude Code plugin, or any jevmem hook or MCP server). Creates
 * `jevmem.config.json` (restoring the one `jevmem disable` set aside, if any), `JEVMEM.md` and `.jevmem/`, and adds
 * `.jevmem/` to `.gitignore`, as `init` does, but registers no hooks.
 */
export function enableProject(root: string): InitResult & { restored: boolean } {
  const backup = path.join(root, DISABLED_CONFIG);
  let restored = false;
  if (!fs.existsSync(path.join(root, CONFIG_FILE)) && fs.existsSync(backup)) {
    fs.renameSync(backup, path.join(root, CONFIG_FILE));
    restored = true;
  }
  const r = init({ root, hooks: false });
  if (restored) {
    r.skipped = r.skipped.filter((k) => k !== CONFIG_FILE);
    r.created.unshift(`${CONFIG_FILE} (restored from ${DISABLED_CONFIG})`);
  }
  return { ...r, restored };
}

/**
 * `jevmem disable`: opt this project out. Moves `jevmem.config.json` to `.jevmem/jevmem.config.json.disabled` (so
 * `jevmem enable` brings back any fitted thresholds), after which hooks and the MCP server do nothing here.
 * `JEVMEM.md` is left untouched.
 */
export function disableProject(root: string): { disabled: boolean; backup: string | null; initHooks: boolean } {
  const cfg = path.join(root, CONFIG_FILE);
  const initHooks = projectHasInitHooks(root);
  if (!fs.existsSync(cfg)) return { disabled: false, backup: null, initHooks };
  fs.mkdirSync(path.join(root, ".jevmem"), { recursive: true });
  fs.renameSync(cfg, path.join(root, DISABLED_CONFIG));
  return { disabled: true, backup: DISABLED_CONFIG, initHooks };
}
