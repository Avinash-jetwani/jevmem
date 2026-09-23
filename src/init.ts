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
  command: string;
}

/**
 * The hook command. Claude Code runs hooks with `sh -c` and the app's own environment: no shell profile, and on a
 * desktop launch often a bare PATH without nvm/volta/homebrew node. So the command always uses the absolute path of
 * the node binary running `init` and the absolute path of this CLI; nothing on PATH is assumed.
 */
export function resolveHookCommand(root: string, cliPath?: string, nodePath: string = process.execPath): string {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  void root;
  const cli = real(path.resolve(cliPath ?? new URL(import.meta.url).pathname));
  return `"${real(nodePath)}" "${cli}" hook`;
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

function isJevmemHook(h: any, command?: string): boolean {
  return typeof h?.command === "string" && ((command !== undefined && h.command === command) || /jevmem[^ ]*\s+hook\b/.test(h.command) || /jevmem\S*[\\/]dist[\\/]cli\.js"? hook\b/.test(h.command));
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
export function registerClaudeHooks(root: string, command: string): "added" | "updated" | "present" {
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
    const list: any[] = (local.hooks[event] ??= []);
    let present = false;
    for (const g of list) {
      if (!Array.isArray(g?.hooks)) continue;
      for (const h of g.hooks) {
        if (!isJevmemHook(h, command)) continue;
        present = true;
        if (h.command !== command) {
          h.command = command; // re-running init repairs a stale or PATH-dependent command
          h.timeout ??= timeout;
          updated = true;
        }
      }
    }
    if (present) continue;
    list.push({ hooks: [{ type: "command", command, timeout }] });
    added = true;
  }
  if (added || updated) fs.writeFileSync(localFile, JSON.stringify(local, null, 2) + "\n");
  return updated ? "updated" : added ? "added" : "present";
}

export function init(opts: InitOptions): InitResult {
  const root = opts.root;
  const created: string[] = [];
  const skipped: string[] = [];
  const store = new MemoryStore(root);
  if (!store.exists()) {
    fs.writeFileSync(store.file, MEMORY_HEADER);
    created.push("JEVMEM.md");
  } else skipped.push("JEVMEM.md");
  if (writeDefaultConfig(root)) created.push(CONFIG_FILE);
  else skipped.push(CONFIG_FILE);
  store.ensureDir();
  created.push(".jevmem/");
  const command = opts.command ?? resolveHookCommand(root, opts.cliPath);
  ensureGitignore(root, opts.hooks !== false ? [".jevmem/", `.claude/${HOOK_SETTINGS_FILE}`] : [".jevmem/"], created);
  if (opts.hooks !== false) {
    const r = registerClaudeHooks(root, command);
    (r === "present" ? skipped : created).push(`.claude/${HOOK_SETTINGS_FILE} (Stop + UserPromptSubmit hooks${r === "updated" ? ", command updated" : ""})`);
  }
  return { created, skipped, command };
}
