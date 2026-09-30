/**
 * The plugin's launcher with the jevmem CLI from npm, 0.5.7, which has no guard: the guard check gates only the
 * PreToolUse hook, and Stop and UserPromptSubmit run exactly as they did under the 0.5.7 plugin.
 *
 * The real 0.5.7 CLI and the 0.5.7 plugin folder come from the v0.5.7 git tag (the CLI is built once and cached under
 * node_modules/.cache), or the CLI from JEVMEM_OLD_CLI (a 0.5.7 dist/cli.js, such as one unpacked from npm). Without
 * the tag the suite is skipped. Each hook runs as Claude Code runs it, `sh -c` with the command from that plugin's
 * hooks.json. A `node` next to the CLI records every process the launcher starts; both plugins run the same CLI.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";
import { OLD_TAG, oldRelease } from "./oldrelease.js";

const TAG = OLD_TAG;
const tmp = (p = "jevmem-oldcli-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const release = process.platform === "win32" ? null : oldRelease();
if (!release) console.warn(`old-cli-launcher.test.ts skipped: no ${TAG} tag in this checkout (git fetch --tags)`);

describe.skipIf(!release)(`the plugin's launcher with the jevmem ${TAG.slice(1)} CLI`, () => {
  const OLD_PLUGIN = release?.plugin ?? "";
  const NEW_PLUGIN = path.resolve("plugin");
  /** This plugin's version: newer than the 0.5.7 CLI once the plugin is bumped, when the launcher prints one warning line per run. */
  const NEW_VERSION: string = JSON.parse(fs.readFileSync(path.join(NEW_PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;
  const versionWarning = new RegExp(`^jevmem: the jevmem CLI is ${TAG.slice(1).replace(/\./g, "\\.")}, older than this plugin \\(${NEW_VERSION.replace(/\./g, "\\.")}\\); update the jevmem CLI\n`, "gm");
  let bin = "";
  let fake: FakeJev | null = null;
  beforeAll(() => {
    // A global bin as npm leaves it: `jevmem` → the CLI, and a `node` beside it that the launcher picks first. This one
    // records how it was started (working directory and arguments), then runs the real Node.
    bin = tmp("jevmem-oldcli-bin-");
    fs.chmodSync(release!.cli, 0o755);
    fs.symlinkSync(release!.cli, path.join(bin, "jevmem"));
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$JEVMEM_TEST_RECORD"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    expect(execFileSync(process.execPath, [release!.cli, "--version"], { encoding: "utf8" }).trim()).toBe(TAG.slice(1));
  }, 120_000);
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  const hooksOf = (plugin: string) => JSON.parse(fs.readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).hooks;
  const commandOf = (plugin: string, event: string) => hooksOf(plugin)[event][0].hooks[0].command as string;

  /** A fresh enabled project set up by the 0.5.7 CLI, with one memory line. */
  function project(): string {
    const root = tmp("jevmem-oldcli-proj-");
    execFileSync(process.execPath, [release!.cli, "init", "--no-hooks"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, stdio: "ignore" });
    fs.appendFileSync(path.join(root, "JEVMEM.md"), "- [decision] Use Postgres 16 for the main database  <!-- id:pg16db -->\n");
    return root;
  }
  interface Run {
    status: number | null;
    stdout: string;
    stderr: string;
    /** Processes the launcher started through `node`, so far: [working directory, arguments]. A detached Stop CLI
     * may record itself after the launcher has exited, so read this once the turn is decided. */
    started: () => string[][];
  }
  /** One hook, as Claude Code runs it: `sh -c` with the command from the plugin's hooks.json. */
  function hook(plugin: string, event: string, root: string, data: string, input: object): Promise<Run> {
    const record = path.join(tmp("jevmem-oldcli-rec-"), "started");
    fs.writeFileSync(record, "");
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(data, "home"), TMPDIR: path.join(data, "tmp"), CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_DATA: path.join(data, "plugin-data"), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake!.url, JEVMEM_DAEMON: "0", JEVMEM_TEST_RECORD: record };
    for (const d of [env.HOME, env.TMPDIR]) fs.mkdirSync(d, { recursive: true });
    return new Promise((resolve) => {
      const p = spawn("sh", ["-c", commandOf(plugin, event)], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => {
        const started = () => fs.readFileSync(record, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
        resolve({ status, stdout, stderr, started });
      });
      p.stdin.end(JSON.stringify({ session_id: "s1", transcript_path: path.join(root, "t.jsonl"), cwd: root, hook_event_name: event, ...input }));
    });
  }
  const decided = (root: string) => (fs.existsSync(path.join(root, ".jevmem", "decisions.jsonl")) ? fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8").trim().split("\n").length : 0);
  /** n turns decided and the drain finished: the line's provenance is written after its decision, before the lock goes. */
  const settled = (root: string, n: number) => decided(root) >= n && !fs.existsSync(path.join(root, ".jevmem", "drain.lock"));
  async function until(cond: () => boolean, ms = 20_000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return cond();
  }
  /** Recall picks the first memory; decide says save a decision. */
  const answers = (q: Record<string, any>) => (q.most_relevant ? { most_relevant: Object.keys(q.most_relevant.criteria).find((k) => k !== "none")! } : SAVE_DECISION);

  /** Everything observable from a scenario, with the per-run paths, pids and memory ids replaced. */
  async function scenario(plugin: string) {
    const root = project();
    const data = tmp("jevmem-oldcli-data-");
    const from = fake!.requests.length;
    const steps: { name: string; run: Run; started: string[][] }[] = [];
    const turn = async (name: string, event: string, input: object, wait?: number) => {
      const run = await hook(plugin, event, root, data, input);
      if (wait !== undefined) expect(await until(() => settled(root, wait)), `${name}: the turn was decided`).toBe(true);
      steps.push({ name, run, started: run.started() });
    };
    await turn("UserPromptSubmit, first run (nothing cached)", "UserPromptSubmit", { prompt: "How should the API connect to the database?" });
    await turn("Stop", "Stop", { user_message: "Decision: we use Redis for the job queue." }, 1);
    await turn("UserPromptSubmit", "UserPromptSubmit", { prompt: "Where do background jobs go?" });
    await turn("Stop, again", "Stop", { user_message: "Decision: deploys go through GitHub Actions only." }, 2);
    // A Stop hook first, in a fresh plugin data folder.
    const data2 = tmp("jevmem-oldcli-data-");
    const coldStop = await hook(plugin, "Stop", root, data2, { user_message: "Decision: logs are kept for 30 days." });
    expect(await until(() => settled(root, 3))).toBe(true);
    steps.push({ name: "Stop, first run (nothing cached)", run: coldStop, started: coldStop.started() });
    const memory = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    const ids = [...memory.matchAll(/<!-- id:(\w+)/g)].map((m) => m[1]!);
    const norm = (s: string) => {
      let out = s.split(root).join("<project>").split(data2).join("<data>").split(data).join("<data>").split(bin).join("<bin>");
      out = out.replace(/jevmem-hook\.\d+/g, "jevmem-hook.<pid>").replace(/ ts:\d{4}-\d\d-\d\dT[\d:.]+Z/g, " ts:<time>");
      ids.forEach((id, i) => (out = out.split(id).join(`<id${i}>`)));
      return out;
    };
    return {
      steps: steps.map((s) => ({ name: s.name, status: s.run.status, stdout: norm(s.run.stdout), stderr: norm(s.run.stderr), started: s.started.map(([cwd, args]) => [norm(cwd!), norm(args!)]) })),
      jev: norm(JSON.stringify(fake!.requests.slice(from).map((r) => ({ state: r.state, questions: r.questions })))),
      memory: norm(memory),
    };
  }

  it("hooks.json: the Stop and UserPromptSubmit entries are the 0.5.7 ones; only PreToolUse, with --guard, is new", () => {
    const [before, after] = [hooksOf(OLD_PLUGIN), hooksOf(NEW_PLUGIN)];
    expect(Object.keys(before).sort()).toEqual(["Stop", "UserPromptSubmit"]);
    expect(Object.keys(after).sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"]);
    expect(after.Stop).toEqual(before.Stop);
    expect(after.UserPromptSubmit).toEqual(before.UserPromptSubmit);
    expect(after.PreToolUse[0].hooks[0].command).toBe('"${CLAUDE_PLUGIN_ROOT}/hooks/jevmem-hook.sh" --guard hook --plugin');
  });

  it("Stop and UserPromptSubmit behave exactly as under the 0.5.7 plugin: same processes, input, output, Jev requests and memory; the guard check is one extra process, from /, on a run with nothing cached", async () => {
    fake = await startFakeJev(answers);
    const before = await scenario(OLD_PLUGIN);
    const after = await scenario(NEW_PLUGIN);
    // The CLI saw the same requests and wrote the same memory.
    expect(after.jev).toBe(before.jev);
    expect(after.memory).toBe(before.memory);
    expect(before.memory).toMatch(/\[decision\] We use Redis for the job queue/);
    // Recall reached Claude Code the same way.
    expect(JSON.parse(before.steps[0]!.stdout).hookSpecificOutput.additionalContext).toContain("Use Postgres 16 for the main database (id:<id0>");
    const probe = ["/", "<bin>/jevmem guard --help"];
    // The 0.5.7 launcher's Stop hook can print bash's harmless "child setpgid (…): Operation not permitted" race (about 1
    // launch in 1,000); this launcher keeps it off stderr, so it is left out of the comparison and must never show here.
    const setpgid = /^.*: child setpgid \(\d+ to \d+\): Operation not permitted\n/gm;
    for (const [i, b] of before.steps.entries()) {
      const a = after.steps[i]!;
      expect(a.stderr, a.name).not.toMatch(setpgid);
      // A plugin newer than the 0.5.7 CLI says so, once per run, on stderr; nothing else differs.
      expect(a.stderr.match(versionWarning)?.length ?? 0, a.name).toBe(NEW_VERSION === TAG.slice(1) ? 0 : 1);
      expect([a.name, a.status, a.stdout, a.stderr.replace(versionWarning, "")]).toEqual([b.name, b.status, b.stdout, b.stderr.replace(setpgid, "")]);
      // The same processes in the same order, but for the guard check on a run with nothing cached.
      const extra = a.started.filter((p) => p.join("\t") === probe.join("\t"));
      expect(a.started.filter((p) => p.join("\t") !== probe.join("\t")), a.name).toEqual(b.started);
      expect(extra, a.name).toHaveLength(/nothing cached/.test(a.name) ? 1 : 0);
      expect(b.started.some((p) => p.join("\t") === probe.join("\t"))).toBe(false);
    }
    // What was compared: on a cold run, the Node check, --version and the hook itself (Stop hands over a saved input file).
    expect(before.steps[0]!.started.map((p) => p[1]!.replace(/^-e .*/, "-e <node check>"))).toEqual(["-e <node check>", "<bin>/jevmem --version", "<bin>/jevmem hook --plugin"]);
    expect(before.steps[1]!.started).toEqual([["<project>", "<bin>/jevmem hook --plugin --stdin-file <data>/tmp/jevmem-hook.<pid>"]]);
    for (const s of [...before.steps, ...after.steps]) expect([s.status, s.stderr.replace(setpgid, "").replace(versionWarning, "")]).toEqual([0, ""]);
  }, 120_000);

  it("the PreToolUse hook never starts the 0.5.7 CLI's hook: no output, no request, no file; that CLI would have queued a turn", async () => {
    fake = await startFakeJev(answers);
    const root = project();
    fs.writeFileSync(path.join(root, "t.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "Commit the env file please." } }) + "\n" + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Running git add .env now." }] } }) + "\n");
    const listing = () => execFileSync("find", [root, "-type", "f"], { encoding: "utf8" }).split("\n").sort().join("\n");
    const filesBefore = listing();
    const data = tmp("jevmem-oldcli-data-");
    const pre = { tool_name: "Bash", tool_input: { command: "git add .env" }, tool_use_id: "toolu_1" };
    for (let i = 0; i < 2; i++) {
      const r = await hook(NEW_PLUGIN, "PreToolUse", root, data, pre);
      expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
      await new Promise((res) => setTimeout(res, 200));
      const args = r.started().map((p) => p[1]!.split(bin).join("<bin>"));
      expect(args.filter((a) => !a.startsWith("-e "))).toEqual(i === 0 ? ["<bin>/jevmem --version", "<bin>/jevmem guard --help"] : []);
    }
    expect(fs.readFileSync(path.join(data, "plugin-data", "cli"), "utf8").split("\n")[4]).toBe("0");
    await new Promise((r) => setTimeout(r, 300));
    expect(listing()).toBe(filesBefore);
    expect(fake.requests).toHaveLength(0);
    // Why the check exists: given the same event directly, the 0.5.7 CLI takes it for a finished turn.
    const direct = spawn(process.execPath, [release!.cli, "hook"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: data, CLAUDE_PROJECT_DIR: root, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0" }, stdio: ["pipe", "ignore", "ignore"] });
    direct.stdin.end(JSON.stringify({ session_id: "s1", transcript_path: path.join(root, "t.jsonl"), cwd: root, hook_event_name: "PreToolUse", ...pre }));
    await new Promise((r) => direct.on("close", r));
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests[0]!.state.user_message).toBe("Commit the env file please.");
  }, 60_000);

  it("the guard check itself (`guard --help` from /) exits 1 with the 0.5.7 CLI and writes nothing", () => {
    const home = tmp("jevmem-oldcli-home-");
    const t = tmp("jevmem-oldcli-t-");
    let status = 0;
    try {
      execFileSync(process.execPath, [release!.cli, "guard", "--help"], { cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: t }, stdio: "ignore" });
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).toBe(1);
    expect([fs.readdirSync(home), fs.readdirSync(t)]).toEqual([[], []]);
  });

  it("after the plugin update, a cache from the 0.5.7 launcher is checked again once, then used", async () => {
    fake = await startFakeJev(answers);
    const root = project();
    const data = tmp("jevmem-oldcli-data-");
    await hook(OLD_PLUGIN, "UserPromptSubmit", root, data, { prompt: "How should the API connect to the database?" });
    const cacheLines = () => fs.readFileSync(path.join(data, "plugin-data", "cli"), "utf8").split("\n").length - 1;
    expect(cacheLines()).toBe(4); // the 0.5.7 launcher's cache: no guard line
    const first = await hook(NEW_PLUGIN, "UserPromptSubmit", root, data, { prompt: "How should the API connect to the database?" });
    const second = await hook(NEW_PLUGIN, "UserPromptSubmit", root, data, { prompt: "How should the API connect to the database?" });
    const args = (r: Run) => r.started().map((p) => p[1]!.split(bin).join("<bin>")).filter((a) => !a.startsWith("-e "));
    expect(args(first)).toEqual(["<bin>/jevmem --version", "<bin>/jevmem guard --help", "<bin>/jevmem hook --plugin"]);
    expect(args(second)).toEqual(["<bin>/jevmem hook --plugin"]);
    expect(cacheLines()).toBe(5);
    expect(first.stdout).toBe(second.stdout);
  }, 60_000);
});
