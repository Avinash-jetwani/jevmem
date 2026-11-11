#!/usr/bin/env node
// Does the Stop hook's handoff survive the end of a `claude -p` session? (0.7.8, written before the fix.)
//
//   node scripts/stop-survival.mjs --launcher init|plugin --arm async|sync [--sessions 30] [--jobs 4]
//        [--model claude-haiku-5-5] [--out results/<file>.json]
//
// Each session is a real `claude -p` run in a new scratch project that is turned on (jevmem.config.json), with one
// Stop hook: jevmem's own launcher, copied byte for byte from this checkout (hooks/jevmem-hook.sh for `init`,
// plugin/hooks/jevmem-hook.sh for the plugin), registered as jevmem registers it (`--arm async`: "async": true, as
// shipped up to 0.7.7) or without "async" (`--arm sync`). The launcher runs a STAND-IN for the jevmem CLI, not the
// real one: a small node script that, given --stdin-file, waits 300 ms and writes a marker named by the session id.
// So the measure is whether the launcher got the turn to a CLI process that lived, nothing about Jev or decide. A
// session whose marker is missing 3 s after `claude` exited lost its turn. No hook other than this one runs (a new
// CLAUDE_CONFIG_DIR per run); authentication is ~/.jevmem/e2e-oauth-token, as in scripts/e2e.sh.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const launcher = opt("--launcher", "init");
const arm = opt("--arm", "async");
const sessions = Number(opt("--sessions", "30"));
const jobs = Number(opt("--jobs", "4"));
const model = opt("--model", "claude-haiku-5-5");
const out = opt("--out", null);
if (!["init", "plugin"].includes(launcher) || !["async", "sync"].includes(arm)) {
  console.error("usage: --launcher init|plugin --arm async|sync");
  process.exit(2);
}
const claudeBin = process.env.CLAUDE_BIN || execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim();
const claudeVersion = execFileSync(claudeBin, ["--version"], { encoding: "utf8" }).trim();
const token = fs.readFileSync(process.env.E2E_TOKEN_FILE || path.join(os.homedir(), ".jevmem", "e2e-oauth-token"), "utf8").trim();
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", "hooks", "plugin/hooks"], { encoding: "utf8" }).trim() !== "";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-stop-survival."));
const marks = path.join(work, "marks");
fs.mkdirSync(marks);

// The stand-in CLI (both launchers): --version and `guard --help` answer like jevmem; `hook ... --stdin-file f` waits
// 300 ms (about a cold node CLI's start), then writes marks/<session_id>.
const standIn = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (a[0] === "guard") process.exit(0);
const i = a.indexOf("--stdin-file");
if (i < 0) process.exit(0);
const f = a[i + 1];
const input = JSON.parse(fs.readFileSync(f, "utf8"));
try { fs.unlinkSync(f); } catch {}
setTimeout(() => fs.writeFileSync(path.join(${JSON.stringify(marks)}, String(input.session_id)), String(Date.now())), 300);
`;

// The kit: the launcher at its real relative place, the stand-in where it looks for the CLI.
const kit = path.join(work, "kit");
let command;
const env = { ...process.env, CLAUDE_CONFIG_DIR: "", CLAUDE_CODE_OAUTH_TOKEN: token, DISABLE_AUTOUPDATER: "1" };
delete env.ANTHROPIC_API_KEY;
if (launcher === "init") {
  fs.mkdirSync(path.join(kit, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(kit, "dist"));
  fs.copyFileSync(path.join(ROOT, "hooks", "jevmem-hook.sh"), path.join(kit, "hooks", "jevmem-hook.sh"));
  fs.writeFileSync(path.join(kit, "dist", "cli.js"), standIn);
  command = `sh "${path.join(kit, "hooks", "jevmem-hook.sh")}" --node "${process.execPath}" --detach hook`;
} else {
  fs.mkdirSync(path.join(kit, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(kit, ".claude-plugin"));
  fs.mkdirSync(path.join(kit, "bin"));
  fs.copyFileSync(path.join(ROOT, "plugin", "hooks", "jevmem-hook.sh"), path.join(kit, "hooks", "jevmem-hook.sh"));
  fs.chmodSync(path.join(kit, "hooks", "jevmem-hook.sh"), 0o755);
  fs.copyFileSync(path.join(ROOT, "plugin", ".claude-plugin", "plugin.json"), path.join(kit, ".claude-plugin", "plugin.json"));
  fs.writeFileSync(path.join(kit, "bin", "jevmem"), standIn.replace("#!/usr/bin/env node", `#!${process.execPath}`));
  fs.chmodSync(path.join(kit, "bin", "jevmem"), 0o755);
  // As the plugin's hooks.json has it, with the plugin root written out (no plugin is loaded here).
  command = `"${path.join(kit, "hooks", "jevmem-hook.sh")}" --detach hook --plugin`;
  env.CLAUDE_PLUGIN_ROOT = kit;
  env.PATH = `${path.join(kit, "bin")}:${env.PATH}`;
}
const stop = { type: "command", command, timeout: arm === "async" ? 20 : 10, ...(arm === "async" ? { async: true } : {}) };
const settingsFile = path.join(work, "settings.json");
fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [stop] }] } }, null, 2));

function runOne(n) {
  return new Promise((resolve) => {
    const project = fs.mkdtempSync(path.join(work, `p${n}-`));
    fs.writeFileSync(path.join(project, "jevmem.config.json"), "{}\n");
    const config = fs.mkdtempSync(path.join(work, `c${n}-`));
    const data = fs.mkdtempSync(path.join(work, `d${n}-`));
    const t0 = Date.now();
    const p = spawn(claudeBin, ["-p", "Reply with the word ok.", "--model", model, "--output-format", "json", "--settings", settingsFile], {
      cwd: project,
      env: { ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", (code) => {
      let r = {};
      try {
        r = JSON.parse(stdout);
      } catch {
        /* not JSON */
      }
      resolve({ n, exit: code, ms: Date.now() - t0, session_id: r.session_id ?? null, result: r.subtype ?? null, endedAt: Date.now() });
    });
  });
}

const runs = [];
let next = 0;
async function worker() {
  while (next < sessions) {
    const n = next++;
    runs.push(await runOne(n));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, sessions) }, worker));
await new Promise((r) => setTimeout(r, 3000));
for (const r of runs) {
  const f = r.session_id ? path.join(marks, r.session_id) : null;
  r.handedOff = !!(f && fs.existsSync(f));
  r.markAfterExitMs = r.handedOff ? Number(fs.readFileSync(f, "utf8")) - r.endedAt : null;
}
runs.sort((a, b) => a.n - b.n);
const valid = runs.filter((r) => r.exit === 0 && r.session_id);
const lost = valid.filter((r) => !r.handedOff).length;
const summary = { launcher, arm, model, claudeCode: claudeVersion, jevmemCommit: commit + (dirty ? "+dirty" : ""), date: new Date().toISOString(), sessions: runs.length, valid: valid.length, handedOff: valid.length - lost, lost, stopHook: stop };
console.log(`stop-survival: launcher=${launcher} arm=${arm}: ${lost} of ${valid.length} turns lost (${runs.length - valid.length} sessions not counted: exit or no session id); ${claudeVersion}, ${model}, ${summary.jevmemCommit}`);
if (out) fs.writeFileSync(out, JSON.stringify({ summary, note: "The CLI is a stand-in (writes a marker 300 ms after it starts); this measures the launcher's handoff only.", runs }, null, 2) + "\n");
fs.rmSync(work, { recursive: true, force: true });
