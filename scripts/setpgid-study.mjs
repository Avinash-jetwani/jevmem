#!/usr/bin/env node
// The setpgid race in the Stop launchers: does the detached CLI always end up outside the hook's process group, and
// does it survive the end of that group and finish the turn?
//
//   node scripts/setpgid-study.mjs [--launches 6000] [--workers 3] [--shipped] [--out results/setpgid-<date>.json]
//
// Both launchers, at the same time: the plugin's (plugin/hooks/jevmem-hook.sh --detach hook --plugin, with the CLI on
// PATH) and the one `jevmem init` registers (hooks/jevmem-hook.sh --node <node> --detach hook), from a copy of this
// checkout's package (dist/, hooks/, plugin/, package.json; run `pnpm build` first). Each launch is one Stop hook as
// Claude Code starts it: the launcher in a process group of its own, the hook JSON on stdin, a turn of its own. As soon
// as the launcher exits, the script checks whether anything is left in the hook's process group, then sends SIGTERM
// and SIGKILL to that group, as a session end can. The CLI runs with the daemon off, so the detached CLI itself must
// evaluate the turn (against a stand-in Jev on 127.0.0.1): the turn is finished when its decision is in
// .jevmem/decisions.jsonl. A preload (NODE_OPTIONS --require) records the CLI's pid and process group when it starts,
// and its exit code.
//
// Without --shipped the launchers differ from the package's in one line: `exec 2>/dev/null` becomes
// `exec 2>>"$STUDY_STDERR"`, so bash's "child setpgid (…): Operation not permitted" lands in a file per launch and
// each race can be looked at. With --shipped they run as shipped, and no race can be seen.
// The run is added to --out (a list of runs): per launcher, the counts, and every launch that raced.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const LAUNCHES = Number(opt("--launches", "6000"));
const WORKERS = Number(opt("--workers", "3"));
const SHIPPED = args.includes("--shipped");
const OUT = opt("--out", `results/setpgid-${new Date().toISOString().slice(0, 10)}.json`);
const PER_PROJECT = 300; // decisions.jsonl is trimmed past 1,000 entries; a new project well before that
if (!fs.existsSync("dist/cli.js")) throw new Error("run pnpm build first");

// ------------------------------------------------------------------ the package, copied
const RUN = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-setpgid-")));
const PKG = path.join(RUN, "pkg");
for (const d of ["dist", "hooks", "plugin"]) fs.cpSync(d, path.join(PKG, d), { recursive: true });
fs.copyFileSync("package.json", path.join(PKG, "package.json"));
function studyCopy(file) {
  const text = fs.readFileSync(file, "utf8");
  if (text.split("exec 2>/dev/null").length !== 2) throw new Error(`${file}: expected one "exec 2>/dev/null"`);
  fs.writeFileSync(file, text.replace("exec 2>/dev/null", 'exec 2>>"${STUDY_STDERR:-/dev/null}"'));
}
if (!SHIPPED) for (const f of ["hooks/jevmem-hook.sh", "plugin/hooks/jevmem-hook.sh"]) studyCopy(path.join(PKG, f));

// ------------------------------------------------------------------ a stand-in Jev: every noul low (the turn is skipped)
function answers(questions) {
  const out = {};
  for (const [name, q] of Object.entries(questions ?? {})) {
    if (q.type === "noul") out[name] = { type: "noul", noul: 0.05 };
    else if (q.type === "choice") {
      const labels = Object.keys(q.criteria);
      const choice = labels.includes("none") ? "none" : labels[0];
      out[name] = { type: "choice", choice, probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? 0.9 : 0.1 / Math.max(1, labels.length - 1)])), confidence: 0.9 };
    } else out[name] = { type: "score", score: 0, probabilities: { 0: 1 }, legend: {}, confidence: 1 };
  }
  return { model: "stand-in", answers: out, usage: { input_tokens: 1, output_tokens: 1 } };
}
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let q = {};
    try {
      q = JSON.parse(body).questions;
    } catch {
      /* empty */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answers(q)));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const JEV_URL = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ the preload that records the CLI process
const PRELOAD = path.join(RUN, "preload.cjs");
fs.writeFileSync(
  PRELOAD,
  `const fs = require("fs");
const { execFileSync } = require("child_process");
const id = process.env.STUDY_ID, dir = process.env.STUDY_DIR;
if (id && dir && process.argv.includes("hook")) {
  let pgid = null;
  try { pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim()); } catch {}
  const f = dir + "/" + id + ".cli.jsonl";
  fs.appendFileSync(f, JSON.stringify({ ev: "start", pid: process.pid, ppid: process.ppid, pgid, t: Date.now() }) + "\\n");
  process.on("exit", (code) => { try { fs.appendFileSync(f, JSON.stringify({ ev: "exit", code, t: Date.now() }) + "\\n"); } catch {} });
}
`,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (f) => {
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const decided = (root, marker) => {
  try {
    return fs.readFileSync(path.join(root, ".jevmem/decisions.jsonl"), "utf8").includes(marker);
  } catch {
    return false;
  }
};
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function worker(launcher, w, count, rows) {
  const base = path.join(RUN, `${launcher}-w${w}`);
  const [home, tmpdir, data, bin, ids] = ["home", "tmp", "plugin-data", "bin", "ids"].map((d) => path.join(base, d));
  for (const d of [home, tmpdir, data, bin, ids]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(path.join(PKG, "dist/cli.js"), path.join(bin, "jevmem"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  let root = null;
  for (let i = 0; i < count; i++) {
    if (i % PER_PROJECT === 0) {
      root = path.join(base, `project-${i / PER_PROJECT}`);
      fs.mkdirSync(root);
      execFileSync(process.execPath, [path.join(PKG, "dist/cli.js"), "init", "--tool", "claude", "--no-hooks"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: "ignore" });
    }
    const id = `${launcher}-w${w}-${i}`;
    const marker = `setpgid study turn ${id}`;
    const stderrFile = path.join(ids, `${id}.err`);
    const env = {
      PATH: launcher === "plugin" ? `${bin}:/usr/bin:/bin` : "/usr/bin:/bin",
      HOME: home,
      TMPDIR: tmpdir,
      TYPESAFE_API_KEY: "stand-in",
      TYPESAFE_BASE_URL: JEV_URL,
      JEVMEM_DAEMON: "0",
      JEVMEM_WRITER: "none",
      JEVMEM_CACHE: "0",
      NODE_OPTIONS: `--require ${PRELOAD}`,
      STUDY_ID: id,
      STUDY_DIR: ids,
      STUDY_STDERR: stderrFile,
      CLAUDE_PROJECT_DIR: root,
      ...(launcher === "plugin" ? { CLAUDE_PLUGIN_ROOT: path.join(PKG, "plugin"), CLAUDE_PLUGIN_DATA: data } : {}),
    };
    const argv = launcher === "plugin" ? ["sh", path.join(PKG, "plugin/hooks/jevmem-hook.sh"), "--detach", "hook", "--plugin"] : ["sh", path.join(PKG, "hooks/jevmem-hook.sh"), "--node", process.execPath, "--detach", "hook"];
    const t0 = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
    let hookStderr = "";
    child.stderr.on("data", (c) => (hookStderr += c));
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "study", cwd: root, user_message: `Decision: ${marker}, we keep the build under two minutes.` }));
    const hookExit = await new Promise((r) => child.on("exit", (c) => r(c)));
    const hookMs = Date.now() - t0;
    const leftInHookGroup = groupAlive(child.pid);
    for (const sig of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* nothing left */
      }
    }
    const until = Date.now() + 15_000;
    while (Date.now() < until && !(decided(root, marker) && readJsonl(path.join(ids, `${id}.cli.jsonl`)).some((e) => e.ev === "exit"))) await sleep(5);
    const cli = readJsonl(path.join(ids, `${id}.cli.jsonl`));
    const start = cli.find((e) => e.ev === "start");
    let warning = "";
    try {
      warning = fs.readFileSync(stderrFile, "utf8").trim().replace(PKG, "<package>");
    } catch {
      /* none */
    }
    rows.push({ id, hookPid: child.pid, hookExit, hookMs, hookStderr, warning, leftInHookGroup, cliPid: start?.pid ?? null, cliParent: start?.ppid ?? null, cliPgid: start?.pgid ?? null, cliOutsideHookGroup: start ? start.pgid !== child.pid : null, cliExit: cli.find((e) => e.ev === "exit")?.code ?? null, turnDecided: decided(root, marker) });
    for (const f of [stderrFile, path.join(ids, `${id}.cli.jsonl`)]) fs.rmSync(f, { force: true });
  }
}

const started = new Date().toISOString();
const perWorker = Math.ceil(LAUNCHES / WORKERS);
const byLauncher = { plugin: [], init: [] };
await Promise.all(Object.entries(byLauncher).flatMap(([launcher, rows]) => Array.from({ length: WORKERS }, (_, w) => worker(launcher, w, perWorker, rows))));
server.close();

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["status", "--porcelain", "src", "hooks", "plugin", "scripts"], { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a checkout */
}
const run = {
  started_at: started,
  finished_at: new Date().toISOString(),
  commit,
  node: process.version,
  shell: execFileSync("/bin/sh", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" }).trim() || "not bash",
  platform: `${os.platform()} ${os.release()}`,
  launchers: SHIPPED ? "as shipped (exec 2>/dev/null)" : 'one line changed: exec 2>>"$STUDY_STDERR" instead of exec 2>/dev/null',
  workers_per_launcher: WORKERS,
  by_launcher: Object.fromEntries(
    Object.entries(byLauncher).map(([launcher, rows]) => {
      const n = (f) => rows.filter(f).length;
      const raced = rows.filter((r) => r.warning);
      return [
        launcher,
        {
          launches: rows.length,
          setpgid_warnings: raced.length,
          cli_outside_hook_group: n((r) => r.cliOutsideHookGroup === true),
          left_in_hook_group_at_exit: n((r) => r.leftInHookGroup),
          cli_exit_0: n((r) => r.cliExit === 0),
          turns_decided: n((r) => r.turnDecided),
          hook_exit_not_0: n((r) => r.hookExit !== 0),
          hook_stderr: n((r) => r.hookStderr !== ""),
          hook_process_ms_p50: pct(rows.map((r) => r.hookMs), 0.5),
          hook_process_ms_p95: pct(rows.map((r) => r.hookMs), 0.95),
          raced: raced.map((r) => ({ ...r, cliLeadsOwnGroup: r.warning.includes(`(${r.cliPgid} to ${r.cliPgid})`) })),
        },
      ];
    }),
  ),
};
let file = { kind: "setpgid-study", about: "scripts/setpgid-study.mjs: the Stop launchers' setpgid race, one run per entry", runs: [] };
try {
  file = JSON.parse(fs.readFileSync(OUT, "utf8"));
} catch {
  /* a new file */
}
file.runs.push(run);
fs.writeFileSync(OUT, JSON.stringify(file, null, 1) + "\n");
fs.rmSync(RUN, { recursive: true, force: true });
for (const [l, s] of Object.entries(run.by_launcher)) console.log(`${l}: ${s.launches} launches, ${s.setpgid_warnings} setpgid warnings; CLI outside the hook's group ${s.cli_outside_hook_group}; left in the hook's group at exit ${s.left_in_hook_group_at_exit}; CLI exit 0 ${s.cli_exit_0}; turns decided ${s.turns_decided}; hook p50 ${s.hook_process_ms_p50} ms`);
console.log(`written ${OUT}`);
