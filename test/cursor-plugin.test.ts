/**
 * The jevmem plugin for Cursor (0.7.6, cursor-plugin/), written before the code: its files against Cursor's submission
 * checklist (scripts/check-cursor-plugin.mjs), the launcher's --plugin and --mcp arguments, the plugin's hooks through
 * the built CLI on the payloads Cursor really sends (test/fixtures/cursor), the stand-down beside a project's own
 * hooks, what `init`, `doctor` and `init --remove-hooks` do once the plugin has run on this computer (the marker
 * ~/.jevmem/cursor-plugin), the MCP server in a project that is not turned on (answers that jevmem is off here, sends
 * nothing, writes nothing) and from a working directory that is not the project (`--root`, as the Cursor app starts
 * a plugin's server from the home folder with `${workspaceFolder}` expanded; the CLI leaves the placeholder literal
 * and runs it from the project), and the Claude Code plugin's launcher on Cursor's payloads (Cursor imports the
 * plugins installed in Claude Code and runs their hooks with its own payloads: nothing may happen).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import { CURSOR_HOOK_EVENTS } from "../src/cursor.js";
import { init } from "../src/init.js";
import { readQueue } from "../src/queue.js";
import { CURSOR_RULE, setupCursor } from "../src/tools.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";

const ROOT = path.resolve(".");
const CLI = path.resolve("dist/cli.js");
const PLUGIN = path.join(ROOT, "cursor-plugin");
const LAUNCHER = path.join(PLUGIN, "hooks", "jevmem-hook.sh");
const PROJECT_LAUNCHER = path.join(ROOT, "hooks", "jevmem-cursor-hook.sh");
const CC_PLUGIN = path.join(ROOT, "plugin");
const CC_LAUNCHER = path.join(CC_PLUGIN, "hooks", "jevmem-hook.sh");
const FIX = path.resolve("test/fixtures/cursor");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;
const NOT_ON = "isn't enabled in this project";
const PROMPT_1 = "Say the word ready, then list the files with the shell tool, then say the word done.";
const tmp = (p = "jevmem-cplug-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

const listing = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      out.push(path.relative(root, p));
      if (fs.statSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
};
/** The nth app payload of an event, by time; `<project>` and `<home>` placed. */
function appPayloads(name: string, project = "/project"): Record<string, any>[] {
  return fs
    .readdirSync(path.join(FIX, "app-r6"))
    .filter((f) => f.endsWith(`.${name}.json`))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIX, "app-r6", f), "utf8").split("<project>").join(project).split("<home>").join(os.homedir())).payload);
}
const transcriptCopy = (): string => {
  const f = fs.readdirSync(path.join(FIX, "app-r6")).filter((x) => x.endsWith("1792174567.567.9372.stop.transcript")).sort().at(-1)!;
  const dir = tmp("jevmem-cplug-transcript-");
  const to = path.join(dir, "conversation.jsonl");
  fs.copyFileSync(path.join(FIX, "app-r6", f), to);
  return to;
};
/** A bin folder with the built CLI as `jevmem` and this Node beside it, for the launcher's PATH search. */
function cliBin(): string {
  const bin = tmp("jevmem-cplug-bin-");
  fs.writeFileSync(path.join(bin, "jevmem"), `#!/usr/bin/env node\nimport("${CLI}");\n`);
  fs.chmodSync(path.join(bin, "jevmem"), 0o755);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  return bin;
}
/** A stand-in CLI on PATH that records its arguments, the plugin version it was given and its stdin. */
function fakeCli(): { bin: string; log: string } {
  const bin = tmp("jevmem-cplug-fake-");
  const log = path.join(bin, "calls.log");
  fs.writeFileSync(path.join(bin, "jevmem"), `#!/bin/sh\nprintf 'args: %s\\nversion: %s\\n' "$*" "\${JEVMEM_PLUGIN_VERSION-unset}" >> "${log}"\nif [ "$4" = --stdin-file ]; then cat "$5" >> "${log}"; else cat >> "${log}"; fi\nprintf '\\n' >> "${log}"\n`);
  fs.chmodSync(path.join(bin, "jevmem"), 0o755);
  return { bin, log };
}
type RunOpts = { cwd?: string; root: string; home?: string; bin?: string; env?: Record<string, string>; input?: string; launcher?: string };
function runLauncher(args: string[], o: RunOpts) {
  const home = o.home ?? tmp("jevmem-cplug-home-");
  const t0 = performance.now();
  const r = spawnSync("sh", [o.launcher ?? LAUNCHER, ...args], {
    cwd: o.cwd ?? PLUGIN, // the agent CLI runs a plugin's hooks from the plugin folder; the app from the project root
    env: { PATH: `${o.bin ? `${o.bin}:` : ""}/usr/bin:/bin`, HOME: home, CURSOR_PROJECT_DIR: o.root, CLAUDE_PROJECT_DIR: o.root, CURSOR_PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN, CURSOR_VERSION: "3.25.9", TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake?.url ?? "http://127.0.0.1:9", JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none", ...o.env },
    input: o.input ?? "{}",
    encoding: "utf8",
    timeout: 20_000,
  });
  return { ...r, ms: performance.now() - t0, home };
}
const marker = (home: string) => path.join(home, ".jevmem", "cursor-plugin");
const writeMarker = (home: string, version = VERSION) => {
  fs.mkdirSync(path.join(home, ".jevmem"), { recursive: true });
  fs.writeFileSync(marker(home), `${version}\n2026-10-18T19:00:00Z\n`);
};
const withHome = async (home: string, fn: () => Promise<void>) => {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn();
  } finally {
    process.env.HOME = prev;
  }
};
const cli = async (args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> => {
  let out = "";
  let err = "";
  const code = await main(args, { out: (s) => void (out += s), err: (s) => void (err += s), cwd });
  return { code, out, err };
};
const waitFor = async (cond: () => boolean, ms = 15_000) => {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
  return cond();
};

/** A short MCP session over stdio: initialize, then the requests, answered by id. */
async function mcpSession(cmd: string, args: string[], o: { cwd: string; env: Record<string, string> }, requests: { id: number; method: string; params?: unknown }[]): Promise<{ answers: Record<number, any>; stderr: string; code: number | null }> {
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
  const answers: Record<number, any> = {};
  let out = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => void (stderr += d));
  child.stdout.on("data", (d) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i).trim();
      out = out.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number") answers[m.id] = m;
      } catch {
        /* not JSON */
      }
    }
  });
  const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jevmem-test", version: "0" } } }) + "\n");
  await waitFor(() => Boolean(answers[0]), 15_000);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  for (const r of requests) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, method: r.method, params: r.params ?? {} }) + "\n");
    await waitFor(() => Boolean(answers[r.id]), 15_000);
  }
  child.stdin.end();
  const code = await Promise.race([exited, new Promise<number | null>((res) => setTimeout(() => res(null), 3000))]);
  if (code === null) child.kill("SIGKILL");
  return { answers, stderr, code };
}
const toolText = (answer: any): string => String(answer?.result?.content?.[0]?.text ?? "");

describe("the plugin's files (cursor-plugin/)", () => {
  it("scripts/check-cursor-plugin.mjs passes: the manifest, the marketplace entry, the rule, the hooks, the MCP server, the launcher, the licence, the README, the logo", () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-cursor-plugin.mjs")], { cwd: ROOT, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^check-cursor-plugin: 9 files/);
  });

  it("carries jevmem's version, which scripts/check-versions.mjs holds to package.json's", () => {
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".cursor-plugin", "plugin.json"), "utf8"));
    expect(m.name).toBe("jevmem");
    expect(m.version).toBe(VERSION);
    expect(m.author?.name).toBe("Avinash Jetwani");
    expect(m.logo).toBe("assets/logo.svg");
    expect(m.license).toBe("MIT");
    expect(m).not.toHaveProperty("variables");
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-versions.mjs")], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cursor-plugin/.cursor-plugin/plugin.json");
  });

  it("the repository's .cursor-plugin/marketplace.json lists the one plugin at ./cursor-plugin, beside the Claude marketplace in .claude-plugin/", () => {
    const mk = JSON.parse(fs.readFileSync(path.join(ROOT, ".cursor-plugin", "marketplace.json"), "utf8"));
    expect(mk.name).toBe("jevmem");
    expect(mk.owner?.name).toBe("Avinash Jetwani");
    expect(mk.plugins).toHaveLength(1);
    expect(mk.plugins[0]).toMatchObject({ name: "jevmem", source: "./cursor-plugin" });
    expect(fs.existsSync(path.join(ROOT, ".claude-plugin", "marketplace.json"))).toBe(true);
  });

  it("the rule is the text `jevmem init --tool cursor` writes, applies always, and keeps the agent off jevmem where the project is not turned on", () => {
    const text = fs.readFileSync(path.join(PLUGIN, "rules", "jevmem.mdc"), "utf8");
    expect(text).toBe(CURSOR_RULE);
    expect(text).toMatch(/^---\n[\s\S]*?\nalwaysApply: true\n---\n/);
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(body).toMatch(/jevmem\.config\.json/);
    expect(body).toMatch(/off here/);
    expect(body).toMatch(/search_memory/);
    expect(body).toMatch(/Never edit `JEVMEM\.md`/);
    // The context it costs in every chat of every project the plugin is installed for: the body, measured and documented in docs/limits.md.
    expect(body.length).toBeLessThanOrEqual(700);
  });

  it("the launcher is the package's hooks/jevmem-cursor-hook.sh, copied", () => {
    expect(fs.readFileSync(LAUNCHER, "utf8")).toBe(fs.readFileSync(PROJECT_LAUNCHER, "utf8"));
    expect(fs.statSync(LAUNCHER).mode & 0o111).not.toBe(0);
  });

  it("hooks.json names the five events, each through the launcher with --plugin, and mcp.json the launcher's --mcp mode with the workspace as --root", () => {
    const h = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8"));
    expect(h.version).toBe(1);
    expect(Object.keys(h.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    for (const ev of CURSOR_HOOK_EVENTS) expect(h.hooks[ev]).toEqual([{ command: `sh "\${CURSOR_PLUGIN_ROOT}/hooks/jevmem-hook.sh" --plugin ${ev}`, timeout: expect.any(Number) }]);
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, "mcp.json"), "utf8"));
    expect(m.mcpServers.jevmem).toEqual({ command: "sh", args: ["${CURSOR_PLUGIN_ROOT}/hooks/jevmem-hook.sh", "--plugin", "--mcp", "--root", "${workspaceFolder}"] });
  });
});

describe.skipIf(process.platform === "win32")("the launcher's --plugin and --mcp arguments", () => {
  it("--plugin <event> runs `jevmem hook --cursor --plugin` with the plugin's version in JEVMEM_PLUGIN_VERSION; stop detaches, the rest run in place", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const { bin, log } = fakeCli();
    const r = runLauncher(["--plugin", "afterAgentResponse"], { root, bin, input: '{"text":"done"}' });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, "utf8")).toBe(`args: hook --cursor --plugin\nversion: ${VERSION}\n{"text":"done"}\n`);
    const r2 = runLauncher(["--plugin", "stop"], { root, bin, input: '{"status":"completed"}' });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toBe("");
    expect(await waitFor(() => fs.readFileSync(log, "utf8").includes('{"status":"completed"}'))).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain("args: hook --cursor --plugin --stdin-file");
  });

  it("--plugin --mcp runs `jevmem mcp` with --root when it names a folder, and without it for the literal ${workspaceFolder} or none", () => {
    const root = tmp();
    init({ root, hooks: false });
    const { bin, log } = fakeCli();
    expect(runLauncher(["--plugin", "--mcp", "--root", root], { root, bin, input: "" }).status).toBe(0);
    expect(runLauncher(["--plugin", "--mcp", "--root", "${workspaceFolder}"], { root, bin, input: "" }).status).toBe(0);
    expect(runLauncher(["--plugin", "--mcp"], { root, bin, input: "" }).status).toBe(0);
    const calls = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("args:"));
    expect(calls).toEqual([`args: mcp --root ${root}`, "args: mcp", "args: mcp"]);
    expect(fs.readFileSync(log, "utf8")).toContain(`version: ${VERSION}`);
  });

  it("--cli and --node before --plugin name the CLI and Node to run (the e2e harness's patched copy)", () => {
    const root = tmp();
    init({ root, hooks: false });
    const onPath = fakeCli();
    const chosen = fakeCli();
    const r = runLauncher(["--cli", path.join(chosen.bin, "jevmem"), "--plugin", "afterAgentResponse"], { root, bin: onPath.bin, input: '{"text":"x"}' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(chosen.log)).toBe(true);
    expect(fs.existsSync(onPath.log)).toBe(false);
  });

  it("in a project that is not turned on: a hook answers at once and runs nothing; --mcp still runs the server, which must say jevmem is off here", () => {
    const root = tmp();
    const { bin, log } = fakeCli();
    for (const ev of CURSOR_HOOK_EVENTS) {
      const r = runLauncher(["--plugin", ev], { root, bin, input: '{"hook_event_name":"x"}' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(ev === "beforeSubmitPrompt" ? '{"continue":true}' : "");
    }
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(runLauncher(["--plugin", "--mcp", "--root", root], { root, bin, input: "" }).status).toBe(0);
    expect(fs.readFileSync(log, "utf8")).toContain(`args: mcp --root ${root}`);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("with no jevmem anywhere, --mcp exits with one line on stderr that names the install, and writes nothing", () => {
    const root = tmp();
    const r = runLauncher(["--plugin", "--mcp", "--root", root], { root, input: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/jevmem.*not found/i);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toBe("");
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.existsSync(path.join(r.home, ".jevmem"))).toBe(false);
  });

  it("reads its version from its own folder, not from CURSOR_PLUGIN_ROOT, which the agent CLI can point at another plugin when several have hooks (measured 2026-10-19: the e2e's copy wrote the probe's 0.0.1)", () => {
    const root = tmp();
    const home = tmp("jevmem-cplug-home-");
    const other = tmp("jevmem-cplug-other-");
    fs.mkdirSync(path.join(other, ".cursor-plugin"), { recursive: true });
    fs.writeFileSync(path.join(other, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "other-plugin", version: "0.0.1" }));
    init({ root, hooks: false });
    const { bin, log } = fakeCli();
    const r = runLauncher(["--plugin", "sessionStart"], { root, home, bin, env: { CURSOR_PLUGIN_ROOT: other, CLAUDE_PLUGIN_ROOT: other }, input: '{"hook_event_name":"sessionStart"}' });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(marker(home), "utf8").split("\n")[0]).toBe(VERSION);
    expect(fs.readFileSync(log, "utf8")).toContain(`version: ${VERSION}`);
  });

  it("--plugin sessionStart writes the marker ~/.jevmem/cursor-plugin (the version and the day) in any project, once a day, and nothing in a project that is not turned on", () => {
    const root = tmp();
    const home = tmp("jevmem-cplug-home-");
    const { bin, log } = fakeCli();
    const r = runLauncher(["--plugin", "sessionStart"], { root, home, bin, input: '{"hook_event_name":"sessionStart"}' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    const lines = fs.readFileSync(marker(home), "utf8").trim().split("\n");
    expect(lines[0]).toBe(VERSION);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const first = fs.readFileSync(marker(home), "utf8");
    runLauncher(["--plugin", "sessionStart"], { root, home, bin, input: '{"hook_event_name":"sessionStart"}' });
    expect(fs.readFileSync(marker(home), "utf8")).toBe(first); // the same day: left alone
    runLauncher(["--plugin", "stop"], { root, home, bin, input: '{"status":"completed"}' });
    expect(fs.readdirSync(path.join(home, ".jevmem"))).toEqual(["cursor-plugin"]);
    // The project launcher (no --plugin) writes no marker.
    const home2 = tmp("jevmem-cplug-home-");
    runLauncher(["sessionStart"], { root, home: home2, bin, input: "{}", launcher: PROJECT_LAUNCHER });
    expect(fs.existsSync(path.join(home2, ".jevmem"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("the plugin's hooks through the built CLI", () => {
  it("a stop with the transcript in a turned-on project queues the turn once, and the log names the plugin", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    init({ root, hooks: false });
    const stop = appPayloads("stop", root)[0]!;
    const r = runLauncher(["--plugin", "stop"], { root, bin: cliBin(), input: JSON.stringify({ ...stop, transcript_path: transcriptCopy(), workspace_roots: [root] }) });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    // The fake Jev answers, so the turn is decided at once: the log says which turn, and decide ran once.
    const log = path.join(root, ".jevmem", "log.jsonl");
    const text = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
    expect(await waitFor(() => /"label":"cursor".*stop: transcript turn 1 \(cursor-transcript\)/.test(text()))).toBe(true);
    expect(text().split("\n").filter((l) => l.includes('"label":"decide"'))).toHaveLength(1);
    expect(fake!.requests.length).toBeGreaterThan(0);
    expect(fake!.requests[0]!.state?.user_message ?? JSON.stringify(fake!.requests[0]!.state)).toContain(PROMPT_1.slice(0, 20));
  });

  it("in a project that is not turned on every event leaves the project as it was, sends nothing", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    fs.writeFileSync(path.join(root, "README.md"), "# x\n");
    const before = listing(root);
    const bin = cliBin();
    for (const ev of CURSOR_HOOK_EVENTS) {
      const p = appPayloads(ev === "sessionEnd" ? "stop" : ev, root)[0] ?? { hook_event_name: ev, conversation_id: "c", cursor_version: "3.25.9" };
      const r = runLauncher(["--plugin", ev], { root, bin, input: JSON.stringify({ ...p, hook_event_name: ev, workspace_roots: [root], transcript_path: null }) });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(ev === "beforeSubmitPrompt" ? '{"continue":true}' : "");
    }
    await new Promise((res) => setTimeout(res, 500));
    expect(listing(root)).toEqual(before);
    expect(fake.requests).toHaveLength(0);
  });

  it("beside a project's own hooks the plugin stands down: one decision for a stop both sources fire, one log line a day", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    init({ root, hooks: false });
    setupCursor(root, { files: true }); // the project's hooks file and launcher, as `jevmem init --tool cursor` writes them
    const bin = cliBin();
    const stop = appPayloads("stop", root)[0]!;
    const t = transcriptCopy();
    const input = JSON.stringify({ ...stop, transcript_path: t, workspace_roots: [root] });
    const r = runLauncher(["--plugin", "stop"], { root, bin, input });
    expect(r.status).toBe(0);
    await new Promise((res) => setTimeout(res, 1500));
    expect(readQueue(root)).toHaveLength(0);
    const log = () => fs.readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8");
    expect(log()).toMatch(/cursor-plugin-standdown/);
    runLauncher(["--plugin", "stop"], { root, bin, input });
    await new Promise((res) => setTimeout(res, 1000));
    expect(log().split("\n").filter((l) => l.includes("cursor-plugin-standdown"))).toHaveLength(1);
    // The project's own launcher, the same payload: the turn is decided once.
    const r2 = spawnSync("sh", [path.join(root, ".cursor", "hooks", "jevmem-hook.sh"), "stop"], { cwd: root, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp("jevmem-cplug-home-"), CURSOR_PROJECT_DIR: root, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none" }, input, encoding: "utf8", timeout: 20_000 });
    expect(r2.status).toBe(0);
    const decided = () => log().split("\n").filter((l) => l.includes('"label":"decide"')).length;
    expect(await waitFor(() => /stop: transcript turn 1 \(cursor-transcript\)/.test(log()))).toBe(true);
    expect(decided()).toBe(1);
    expect(readQueue(root)).toHaveLength(0);
    runLauncher(["--plugin", "stop"], { root, bin, input });
    await new Promise((res) => setTimeout(res, 1500));
    expect(decided()).toBe(1); // the plugin stood down again: one decision for the turn, from the project's own hook
  });
});

describe("init, doctor and --remove-hooks once the plugin has run on this computer", () => {
  it("init --tool cursor turns the project on and writes no Cursor file while the marker is there; --files writes them; no marker, the files as before", async () => {
    const home = tmp("jevmem-cplug-home-");
    writeMarker(home);
    await withHome(home, async () => {
      const root = tmp();
      const r = await cli(["init", "--tool", "cursor"], root);
      expect(r.code).toBe(0);
      expect(r.out).toContain("created  JEVMEM.md");
      expect(r.out).toMatch(/plugin for Cursor/);
      expect(r.out).toMatch(/--files/);
      expect(fs.existsSync(path.join(root, "jevmem.config.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, ".cursor"))).toBe(false);
      const r2 = await cli(["init", "--tool", "cursor", "--files"], root);
      expect(r2.code).toBe(0);
      for (const f of [".cursor/hooks.json", ".cursor/hooks/jevmem-hook.sh", ".cursor/mcp.json", ".cursor/rules/jevmem.mdc"]) expect(fs.existsSync(path.join(root, f))).toBe(true);
    });
    await withHome(tmp("jevmem-cplug-home-"), async () => {
      const root = tmp();
      const r = await cli(["init", "--tool", "cursor"], root);
      expect(r.code).toBe(0);
      for (const f of [".cursor/hooks.json", ".cursor/hooks/jevmem-hook.sh", ".cursor/mcp.json", ".cursor/rules/jevmem.mdc"]) expect(fs.existsSync(path.join(root, f))).toBe(true);
    });
  });

  it("doctor names the plugin and the day it last ran, in a project without a .cursor folder too, and says the plugin stands down beside project hooks", async () => {
    const home = tmp("jevmem-cplug-home-");
    writeMarker(home);
    await withHome(home, async () => {
      const root = tmp();
      init({ root, hooks: false });
      const line = (await cli(["doctor"], root)).out.split("\n").find((l) => l.startsWith("cursor ")) ?? "";
      expect(line).toContain(`the jevmem plugin for Cursor (${VERSION})`);
      expect(line).toContain("2026-10-18");
      expect(line).not.toMatch(/stands down/);
      setupCursor(root, { files: true }); // the project's own hooks beside the plugin
      const both = (await cli(["doctor"], root)).out.split("\n").find((l) => l.startsWith("cursor ")) ?? "";
      expect(both).toContain(`the jevmem plugin for Cursor (${VERSION})`);
      expect(both).toMatch(/stands down/);
      expect(both).toMatch(/init --remove-hooks/);
    });
    await withHome(tmp("jevmem-cplug-home-"), async () => {
      const root = tmp();
      init({ root, hooks: false });
      expect((await cli(["doctor"], root)).out.split("\n").find((l) => l.startsWith("cursor "))).toBeUndefined();
    });
  });

  it("init --remove-hooks also takes out jevmem's unchanged rule and default MCP entry while the marker is there, and keeps a rule the user changed", async () => {
    const home = tmp("jevmem-cplug-home-");
    writeMarker(home);
    await withHome(home, async () => {
      const root = tmp();
      init({ root, hooks: false });
      setupCursor(root, { files: true }); // a project set up with 0.7.4 or 0.7.5, before the plugin
      const r = await cli(["init", "--remove-hooks"], root);
      expect(r.code).toBe(0);
      expect(r.out).toContain(".cursor/hooks.json");
      expect(r.out).toContain(".cursor/rules/jevmem.mdc");
      expect(r.out).toContain(".cursor/mcp.json");
      expect(fs.existsSync(path.join(root, ".cursor", "hooks.json"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".cursor", "rules", "jevmem.mdc"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".cursor", "mcp.json"))).toBe(false);
      // A changed rule and another server stay.
      const root2 = tmp();
      init({ root: root2, hooks: false });
      setupCursor(root2, { files: true });
      fs.appendFileSync(path.join(root2, ".cursor", "rules", "jevmem.mdc"), "\n- Also: prefer pnpm.\n");
      const mcp = JSON.parse(fs.readFileSync(path.join(root2, ".cursor", "mcp.json"), "utf8"));
      mcp.mcpServers.other = { command: "x" };
      fs.writeFileSync(path.join(root2, ".cursor", "mcp.json"), JSON.stringify(mcp));
      const r2 = await cli(["init", "--remove-hooks"], root2);
      expect(r2.code).toBe(0);
      expect(fs.existsSync(path.join(root2, ".cursor", "rules", "jevmem.mdc"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root2, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({ other: { command: "x" } });
    });
    await withHome(tmp("jevmem-cplug-home-"), async () => {
      const root = tmp();
      init({ root, hooks: false });
      setupCursor(root);
      await cli(["init", "--remove-hooks"], root);
      expect(fs.existsSync(path.join(root, ".cursor", "rules", "jevmem.mdc"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, ".cursor", "mcp.json"), "utf8")).mcpServers.jevmem).toBeDefined();
    });
  });
});

describe.skipIf(process.platform === "win32")("the MCP server through the launcher", () => {
  const env = (bin: string, home: string) => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: home, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake!.url, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none", CURSOR_PLUGIN_ROOT: PLUGIN });
  const search = { id: 1, method: "tools/call", params: { name: "search_memory", arguments: { query: "where are invoices archived" } } };

  it("in a project that is not turned on (the CLI's way: cwd the project, the placeholder literal): lists its tools, answers every call that jevmem is off here, sends nothing, writes nothing", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    fs.writeFileSync(path.join(root, "README.md"), "# x\n");
    const home = tmp("jevmem-cplug-home-");
    const before = listing(root);
    const s = await mcpSession("sh", [LAUNCHER, "--plugin", "--mcp", "--root", "${workspaceFolder}"], { cwd: root, env: env(cliBin(), home) }, [{ id: 2, method: "tools/list" }, search, { id: 3, method: "tools/call", params: { name: "list_memory", arguments: {} } }]);
    expect(s.answers[0]?.result?.serverInfo?.name).toBe("jevmem");
    expect((s.answers[2]?.result?.tools ?? []).map((t: any) => t.name).sort()).toEqual(["add_memory", "audit_memory", "list_memory", "search_memory"]);
    expect(s.answers[1]?.result?.isError).toBe(true);
    expect(toolText(s.answers[1])).toContain(NOT_ON);
    expect(toolText(s.answers[3])).toContain(NOT_ON);
    expect(listing(root)).toEqual(before);
    expect(fs.existsSync(path.join(home, ".jevmem"))).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("from the home folder with --root the project (the app's way): serves that project, and its files land there, not in the working directory", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    init({ root, hooks: false });
    fs.appendFileSync(path.join(root, "JEVMEM.md"), "- [decision] Invoices are archived as PDFs in S3, one file per invoice. <!-- id:abc123 kind:decision ts:2026-10-18T10:00:00Z conf:0.95 -->\n");
    const home = tmp("jevmem-cplug-home-");
    const cwdBefore = listing(home);
    const s = await mcpSession("sh", [LAUNCHER, "--plugin", "--mcp", "--root", root], { cwd: home, env: env(cliBin(), home) }, [search]);
    expect(s.answers[1]?.result?.isError).not.toBe(true);
    expect(toolText(s.answers[1])).not.toContain(NOT_ON);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, ".jevmem", "log.jsonl"))).toBe(true);
    expect(listing(home)).toEqual(cwdBefore);
  });

  it("`jevmem mcp --root '${workspaceFolder}'` itself takes the literal placeholder as no root and serves the working directory", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    init({ root, hooks: false });
    fs.appendFileSync(path.join(root, "JEVMEM.md"), "- [decision] Invoices are archived as PDFs in S3, one file per invoice. <!-- id:abc123 kind:decision ts:2026-10-18T10:00:00Z conf:0.95 -->\n");
    const s = await mcpSession(process.execPath, [CLI, "mcp", "--root", "${workspaceFolder}"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp("jevmem-cplug-home-"), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none" } }, [search]);
    expect(s.answers[0]?.result?.serverInfo?.name).toBe("jevmem");
    expect(toolText(s.answers[1])).not.toContain(NOT_ON);
    expect(fake.requests.length).toBeGreaterThan(0);
  });
});

// Cursor imports the plugins installed in Claude Code from a marketplace and runs their hooks with its own payloads
// (read in Cursor 3.25.9's loader, 2026-10-18); the jevmem Claude Code plugin's four commands must do nothing with them.
describe.skipIf(process.platform === "win32")("the Claude Code plugin's launcher on Cursor's payloads", () => {
  it("every native app and CLI payload through --start, --guard, --detach and the plain hook: no output, no request, nothing written", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    init({ root, hooks: false });
    const bin = cliBin();
    const home = tmp("jevmem-cplug-home-");
    const before = listing(root);
    const payloads = [...fs.readdirSync(path.join(FIX, "app-r6")), ...fs.readdirSync(path.join(FIX, "cli-r1")).map((f) => `cli:${f}`)]
      .filter((f) => f.endsWith(".json") && !/\.cc-/.test(f))
      .map((f) => {
        const file = f.startsWith("cli:") ? path.join(FIX, "cli-r1", f.slice(4)) : path.join(FIX, "app-r6", f);
        const p = JSON.parse(fs.readFileSync(file, "utf8")).payload;
        return { ...p, workspace_roots: [root], transcript_path: null };
      });
    expect(payloads.length).toBeGreaterThan(15);
    let runs = 0;
    for (const p of payloads) {
      for (const mode of [["--start"], ["--guard"], ["--detach"], []]) {
        const r = spawnSync("sh", [CC_LAUNCHER, ...mode, "hook", "--plugin"], { cwd: root, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CLAUDE_PLUGIN_ROOT: CC_PLUGIN, CURSOR_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, CURSOR_VERSION: String(p.cursor_version ?? ""), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none" }, input: JSON.stringify(p), encoding: "utf8", timeout: 20_000 });
        expect(r.status, `${p.hook_event_name} ${mode.join(" ")}`).toBe(0);
        expect(r.stdout, `${p.hook_event_name} ${mode.join(" ")} stdout`).toBe("");
        runs++;
      }
    }
    await new Promise((res) => setTimeout(res, 1500));
    expect(runs).toBeGreaterThan(60);
    expect(listing(root)).toEqual(before);
    expect(fake.requests).toHaveLength(0);
  }, 180_000);
});
