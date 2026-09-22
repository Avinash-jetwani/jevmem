import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, writeDefaultConfig } from "./config.js";
import { MEMORY_HEADER, MemoryStore } from "./store.js";

export interface InitOptions {
  root: string;
  /** Command to register in `.claude/settings.json`. Resolved automatically when omitted. */
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

function ensureGitignore(root: string, created: string[]): void {
  const gi = path.join(root, ".gitignore");
  const line = ".jevmem/";
  if (!fs.existsSync(gi)) return; // don't create a .gitignore in non-git folders; `.jevmem/.gitignore` covers it anyway
  const cur = fs.readFileSync(gi, "utf8");
  if (cur.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === ".jevmem")) return;
  fs.appendFileSync(gi, (cur.endsWith("\n") || cur === "" ? "" : "\n") + line + "\n");
  created.push(".gitignore (+ .jevmem/)");
}

export function registerClaudeHooks(root: string, command: string): "added" | "updated" | "present" {
  const dir = path.join(root, ".claude");
  const file = path.join(dir, "settings.json");
  fs.mkdirSync(dir, { recursive: true });
  let settings: any = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      settings = {};
    }
  }
  settings.hooks ??= {};
  let added = false;
  let updated = false;
  const isOurs = (h: any) => typeof h?.command === "string" && (h.command === command || /jevmem[^ ]*\s+hook\b/.test(h.command) || /jevmem\S*[\\/]dist[\\/]cli\.js"? hook\b/.test(h.command));
  const spec: Record<string, number> = { Stop: 20, UserPromptSubmit: 5 };
  for (const [event, timeout] of Object.entries(spec)) {
    const list: any[] = (settings.hooks[event] ??= []);
    let present = false;
    for (const g of list) {
      if (!Array.isArray(g?.hooks)) continue;
      for (const h of g.hooks) {
        if (!isOurs(h)) continue;
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
  if (added || updated) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
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
  ensureGitignore(root, created);
  const command = opts.command ?? resolveHookCommand(root, opts.cliPath);
  if (opts.hooks !== false) {
    const r = registerClaudeHooks(root, command);
    (r === "present" ? skipped : created).push(`.claude/settings.json (Stop + UserPromptSubmit hooks${r === "updated" ? ", command updated" : ""})`);
  }
  return { created, skipped, command };
}
