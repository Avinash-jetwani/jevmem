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

/** Decide how the hook should be invoked so it works whether jevmem is local, global, or run from a checkout. */
export function resolveHookCommand(root: string, cliPath?: string): string {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const localBin = path.join(root, "node_modules", ".bin", "jevmem");
  if (fs.existsSync(localBin)) return "npx jevmem hook";
  if (cliPath) {
    const abs = real(path.resolve(cliPath));
    if (/[\\/]node_modules[\\/]/.test(abs) && !abs.includes("_npx")) return "jevmem hook"; // global install on PATH
    return `node "${abs}" hook`;
  }
  return "npx jevmem hook";
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

export function registerClaudeHooks(root: string, command: string): "added" | "present" {
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
  let changed = false;
  const spec: Record<string, number> = { Stop: 20, UserPromptSubmit: 5 };
  for (const [event, timeout] of Object.entries(spec)) {
    const list: any[] = (settings.hooks[event] ??= []);
    const present = list.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === "string" && (h.command === command || /jevmem[^ ]*\s+hook\b/.test(h.command))));
    if (present) continue;
    list.push({ hooks: [{ type: "command", command, timeout }] });
    changed = true;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return changed ? "added" : "present";
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
    (r === "added" ? created : skipped).push(".claude/settings.json (Stop + UserPromptSubmit hooks)");
  }
  return { created, skipped, command };
}
