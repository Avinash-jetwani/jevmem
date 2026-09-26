/**
 * Which jevmem CLI the hooks run, and whether it has the guard, for `jevmem doctor`. The CLI that runs `doctor` is not
 * necessarily the one the hooks run: `jevmem init` registers absolute paths, and the plugin's launcher runs the
 * `jevmem` it finds (PATH, then a fixed list of directories). A CLI from before the guard answers `guard --help` with
 * "unknown command"; the plugin's launcher asks exactly that before it runs the PreToolUse hook, and so does this.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isJevmemHookCommand } from "./config.js";

export interface CliCheck {
  /** The path as the hook names it, and its real path (null when it does not exist). */
  path: string;
  real: string | null;
  version: string | null;
  /** null: it could not be run. */
  hasGuard: boolean | null;
}

export interface InitHookCli {
  /** The hook events whose command runs this CLI. */
  events: string[];
  /** The CLI's path, or null for a command jevmem did not write (`init --command`). */
  cli: string | null;
  node: string | null;
  /** The command runs `node` directly (the launcher form looks for another Node when its `--node` is gone). */
  direct: boolean;
  command: string;
}

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The CLIs that `jevmem init`'s hooks in this project run: `"<node>" "<cli.js>" hook`, or the launcher form
 * `sh "<package>/hooks/jevmem-hook.sh" --node "<node>" [--detach] hook`, which runs `<package>/dist/cli.js`.
 */
export function initHookClis(root: string): InitHookCli[] {
  const byKey = new Map<string, InitHookCli>();
  for (const f of ["settings.local.json", "settings.json"]) {
    let s: any;
    try {
      s = JSON.parse(fs.readFileSync(path.join(root, ".claude", f), "utf8"));
    } catch {
      continue;
    }
    for (const [event, list] of Object.entries(s?.hooks ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const g of list) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (!isJevmemHookCommand(h) || /--plugin\b/.test(String(h.command))) continue;
          const cmd = String(h.command);
          let cli: string | null = null;
          let node: string | null = null;
          const direct = /^\s*"([^"]+)"\s+"([^"]+)"\s+hook\b/.exec(cmd);
          const launcher = /^\s*sh\s+"([^"]+jevmem-hook\.sh)"(?:\s+--node\s+"([^"]+)")?/.exec(cmd);
          if (direct) [node, cli] = [direct[1]!, direct[2]!];
          else if (launcher) [cli, node] = [path.join(path.dirname(path.dirname(launcher[1]!)), "dist", "cli.js"), launcher[2] ?? null];
          const key = cli ?? cmd;
          const cur = byKey.get(key) ?? { events: [], cli, node, direct: Boolean(direct), command: cmd };
          if (!cur.events.includes(event)) cur.events.push(event);
          byKey.set(key, cur);
        }
      }
    }
  }
  return [...byKey.values()];
}

/** The `jevmem` the plugin's launcher runs: on PATH, else the first of its fixed directories, else the newest nvm Node's. */
export function pluginLauncherCli(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME ?? os.homedir()): string | null {
  const executable = (f: string) => {
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  for (const dir of (env.PATH ?? "").split(path.delimiter)) if (dir && executable(path.join(dir, "jevmem"))) return path.join(dir, "jevmem");
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, ".volta", "bin")]) if (executable(path.join(dir, "jevmem"))) return path.join(dir, "jevmem");
  const nvm = path.join(home, ".nvm", "versions", "node");
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(nvm).filter((v) => /^v\d+\.\d+\.\d+$/.test(v));
  } catch {
    /* no nvm */
  }
  const num = (v: string) => v.slice(1).split(".").map(Number);
  versions.sort((a, b) => {
    const [x, y] = [num(a), num(b)];
    return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
  });
  for (const v of versions) if (executable(path.join(nvm, v, "bin", "jevmem"))) return path.join(nvm, v, "bin", "jevmem");
  return null;
}

/** Is the jevmem plugin enabled in the user's Claude Code settings (user scope)? */
export function userEnablesPlugin(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME ?? os.homedir()): string | null {
  const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json");
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [id, on] of Object.entries(s?.enabledPlugins ?? {})) if (on === true && /^jevmem@/.test(id)) return file;
  } catch {
    /* no settings */
  }
  return null;
}

/**
 * Run `<cli> guard --help` from `/` with no input, as the plugin's launcher does, and read the CLI's version from its
 * package.json. A Node script runs with `node` (the hook's own, when known); anything else runs directly.
 */
export function checkCli(cli: string, node: string | null = null): CliCheck {
  const r = real(cli);
  if (!r) return { path: cli, real: null, version: null, hasGuard: null };
  let version: string | null = null;
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(path.dirname(r), "..", "package.json"), "utf8"));
    if (pj?.name === "jevmem" && typeof pj.version === "string") version = pj.version;
  } catch {
    /* not in a package */
  }
  let head = "";
  try {
    const fd = fs.openSync(r, "r");
    const buf = Buffer.alloc(200);
    const n = fs.readSync(fd, buf, 0, 200, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
  } catch {
    /* unreadable */
  }
  const isNode = r.endsWith(".js") || /^#!.*\bnode\b/.test(head);
  const runner = isNode ? (node && real(node) ? node : process.execPath) : r;
  const args = isNode ? [r, "guard", "--help"] : ["guard", "--help"];
  const p = spawnSync(runner, args, { cwd: "/", stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 10_000 });
  // An older jevmem says "unknown command: guard"; any other failure says nothing about the guard.
  const hasGuard = p.status === 0 ? true : !p.error && !p.signal && /unknown command/.test(p.stderr ?? "") ? false : null;
  return { path: cli, real: r, version, hasGuard };
}
