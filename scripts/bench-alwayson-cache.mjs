#!/usr/bin/env node
// Prompt caching with and without jevmem, per always-on design: three prompts in one session (-p, then --continue twice)
// on the recipebox A/B project; the result event's cache_creation_input_tokens and cache_read_input_tokens per turn.
//   node scripts/bench-alwayson-cache.mjs --out results/….json [--runs 2]   (TYPESAFE_API_KEY in the environment; the Claude Code token file; CLAUDE_BIN)
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[process.argv.indexOf("--out") + 1];
const RUNS = Number(process.argv.includes("--runs") ? process.argv[process.argv.indexOf("--runs") + 1] : 2);
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const TOKEN = fs.readFileSync(path.join(os.homedir(), ".jevmem/e2e-oauth-token"), "utf8").trim();
const { PROJECTS } = await import(pathToFileURL(path.join(ROOT, "eval/ab/tasks.mjs")).href);
const { ALWAYS } = await import(pathToFileURL(path.join(ROOT, "eval/ab/always-dev.mjs")).href);
const ARMS = [
  { label: "none", pkg: null },
  { label: "v070", pkg: path.join(ROOT, "node_modules/.cache/jevmem-v0.7.0-npm/package"), config: {} },
  { label: "A-constraints", pkg: path.join(ROOT, "node_modules/.cache/jevmem-proto"), config: { alwaysOn: { mode: "constraints", maxLines: 40 } } },
  { label: "B-always", pkg: path.join(ROOT, "node_modules/.cache/jevmem-proto"), config: { alwaysOn: { mode: "always", maxLines: 40 } } },
  { label: "C-prompt", pkg: path.join(ROOT, "node_modules/.cache/jevmem-proto"), config: { alwaysOn: { mode: "prompt", maxLines: 40 } } },
];
const PROMPTS = ["In one sentence: what does this project do?", "Which file holds the API client? Answer with the path only.", "Name one component under src/components. The file name only."];
const idOf = (project, key) => { const h = crypto.createHash("sha1").update(`${project}:${key}`).digest(); const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; for (let i = 0; s.length < 6; i++) s += a[h[i] % 36]; return /^\d+$/.test(s) ? "x" + s.slice(1) : s; };
function memories(project) { const start = Date.parse("2026-01-12T09:00:00Z"); return PROJECTS[project].memory.map(([key, kind, text, by], i) => ({ key, id: idOf(project, key), kind, text, ts: new Date(start + i * 3.7 * 86400000).toISOString(), conf: 0.9, ...(by ? { supersededBy: idOf(project, by) } : {}), ...(ALWAYS[project].includes(key) ? { always: true } : {}) })); }
async function session(arm, run) {
  const project = "recipebox";
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cache-probe-${arm.label}-`)));
  fs.cpSync(path.join(ROOT, PROJECTS[project].dir), root, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cache-probe-home-"));
  fs.mkdirSync(path.join(home, ".jevmem"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".jevmem", "env"), `TYPESAFE_API_KEY=${process.env.TYPESAFE_API_KEY}\n`, { mode: 0o600 });
  if (arm.pkg) {
    const lib = await import(pathToFileURL(path.join(arm.pkg, "dist/index.js")).href);
    execFileSync(process.execPath, [path.join(arm.pkg, "dist/cli.js"), "init", "--tool", "claude"], { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore" });
    const cfgFile = path.join(root, "jevmem.config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    cfg.guard = { ...cfg.guard, mode: "off" };
    Object.assign(cfg, arm.config ?? {});
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    const mems = memories(project);
    fs.writeFileSync(path.join(root, "JEVMEM.md"), lib.MEMORY_HEADER + mems.map((m) => lib.formatLine(m)).join("\n") + "\n");
    for (const m of mems) if (m.kind !== "superseded") lib.recordProvenance(root, m, "hook");
  }
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["add", "-A"], { cwd: root }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], { cwd: root });
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "cache-probe-config-"));
  const turns = [];
  for (const [i, p] of PROMPTS.entries()) {
    const a = ["-p", p, "--output-format", "stream-json", "--verbose", "--include-hook-events", "--max-turns", "3", "--model", "claude-sonnet-5"];
    if (i > 0) a.push("--continue");
    const out = await new Promise((resolve) => { const ch = spawn(CLAUDE, a, { cwd: root, env: { HOME: home, USER: process.env.USER, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: "dumb", CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] }); let s = ""; ch.stdout.on("data", (d) => (s += d)); ch.on("close", () => resolve(s)); });
    const ev = out.split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
    const res = ev.filter((e) => e.type === "result").at(-1) ?? {};
    const hooks = ev.filter((e) => e.type === "system" && e.subtype === "hook_response").map((e) => ({ event: e.hook_event ?? e.hook_event_name, chars: (() => { try { return (JSON.parse(String(e.stdout ?? "")).hookSpecificOutput?.additionalContext ?? "").length; } catch { return 0; } })() }));
    turns.push({ turn: i + 1, usage: { input: res.usage?.input_tokens ?? null, cache_creation: res.usage?.cache_creation_input_tokens ?? null, cache_read: res.usage?.cache_read_input_tokens ?? null, output: res.usage?.output_tokens ?? null }, cost_usd: res.total_cost_usd ?? null, hooks, reply: String(res.result ?? "").slice(0, 80) });
    process.stderr.write(`${arm.label} run ${run} turn ${i + 1}: creation ${turns.at(-1).usage.cache_creation} read ${turns.at(-1).usage.cache_read} ($${res.total_cost_usd?.toFixed(4)}) hooks ${hooks.map((h) => `${h.event}:${h.chars}`).join(",") || "none"}\n`);
  }
  if (arm.pkg) { try { execFileSync(process.execPath, [path.join(arm.pkg, "dist/cli.js"), "daemon", "stop"], { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: "ignore" }); } catch {} }
  for (const d of [root, home, config]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return { arm: arm.label, run, turns };
}
const records = [];
for (let run = 1; run <= RUNS; run++) for (const arm of ARMS) records.push(await session(arm, run));
const med = (xs) => { const s = [...xs].filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summary = Object.fromEntries(ARMS.map((a) => [a.label, Object.fromEntries([1, 2, 3].map((t) => [`turn${t}`, { cache_creation_tokens: med(records.filter((r) => r.arm === a.label).map((r) => r.turns[t - 1]?.usage.cache_creation)), cache_read_tokens: med(records.filter((r) => r.arm === a.label).map((r) => r.turns[t - 1]?.usage.cache_read)), cost_usd: med(records.filter((r) => r.arm === a.label).map((r) => r.turns[t - 1]?.cost_usd)) }]))]));
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(OUT, JSON.stringify({ kind: "alwayson-cache-probe", date: new Date().toISOString().slice(0, 10), claude_code: execFileSync(CLAUDE, ["--version"], { encoding: "utf8", env: { ...process.env, DISABLE_AUTOUPDATER: "1" } }).trim(), model: "claude-sonnet-5", project: "recipebox (eval/ab/projects; 34 live lines, 6 constraints, 13 labelled always-on)", prompts: PROMPTS, arms: ARMS.map((a) => ({ label: a.label, package: a.pkg ? a.pkg.replace(os.homedir(), "~") : null, config: a.config ?? null })), runs: RUNS, summary, records }, null, 1) + "\n");
