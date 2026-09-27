/**
 * The Stop hook's detached CLI, through both launchers (the plugin's and the one `jevmem init` registers):
 * - it runs in a process group of its own, so ending the hook's group when the hook exits does not reach it, and it
 *   finishes the turn. On macOS (no `setsid`) the launcher uses job control: the shell and the child both put the child
 *   in its new group before the shell goes on, so nothing is left in the hook's group when it exits, and the group can
 *   be killed at once. When the second of the two calls fails, bash prints "child setpgid (…): Operation not
 *   permitted"; the child is in its new group either way, so the launchers send that message to /dev/null. Elsewhere
 *   `setsid` moves the child a moment later, in the child, so the test does what a session end does: SIGTERM at once
 *   (ignored until then), SIGKILL later;
 * - since nothing it prints reaches anyone, its errors must land in .jevmem/log.jsonl: a Jev error it handles, and a
 *   failure before its own error handling runs (here, its main module missing, as after an upgrade).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { readLog } from "../src/jev.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { T1_QUIET } from "./helpers.js";

const CLI = path.resolve("dist/cli.js");
const tmp = (p = "jevmem-detach-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);
let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});
async function waitFor(cond: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  return cond();
}
const decisions = (root: string) => {
  try {
    return fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8");
  } catch {
    return "";
  }
};

/** A package folder like the one npm installs, from this build: dist/, hooks/, plugin/, package.json. */
function packageCopy(): string {
  const pkg = tmp("jevmem-pkg-");
  for (const d of ["dist", "hooks", "plugin"]) fs.cpSync(path.resolve(d), path.join(pkg, d), { recursive: true });
  fs.copyFileSync(path.resolve("package.json"), path.join(pkg, "package.json"));
  return pkg;
}

/** The Stop command of one launcher, from package folder `pkg`, and the environment it needs. */
function launcher(kind: "plugin" | "init", pkg: string, root: string, extra: Record<string, string>) {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: tmp(), TMPDIR: tmp(), CLAUDE_PROJECT_DIR: root, JEVMEM_DAEMON: "0", JEVMEM_CACHE: "0", JEVMEM_WRITER: "none", ...extra };
  if (kind === "init") return { cmd: "sh", args: [path.join(pkg, "hooks/jevmem-hook.sh"), "--node", process.execPath, "--detach", "hook"], env };
  const bin = tmp("jevmem-bin-");
  fs.symlinkSync(path.join(pkg, "dist/cli.js"), path.join(bin, "jevmem"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  return { cmd: "sh", args: [path.join(pkg, "plugin/hooks/jevmem-hook.sh"), "--detach", "hook", "--plugin"], env: { ...env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_PLUGIN_ROOT: path.join(pkg, "plugin"), CLAUDE_PLUGIN_DATA: tmp() } };
}

/** Start a Stop hook in a process group of its own, as Claude Code does; resolves when the hook process exits. */
function stopHook(l: ReturnType<typeof launcher>, root: string, text: string): Promise<{ child: ChildProcess; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(l.cmd, l.args, { cwd: root, env: l.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ child, code, stdout, stderr }));
    child.stdin!.end(JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: text }));
  });
}

describe.skipIf(process.platform === "win32").each(["plugin", "init"] as const)("the detached Stop CLI, through the %s launcher", (kind) => {
  it("is outside the hook's process group: ending that group when the hook exits loses no turn", async () => {
    fake = await startFakeJev(() => T1_QUIET);
    const root = tmp();
    init({ root, hooks: false });
    const l = launcher(kind, path.resolve("."), root, { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url });
    const N = 25;
    for (let i = 0; i < N; i++) {
      const r = await stopHook(l, root, `Decision ${i}: turn ${i} of the process group test.`);
      expect([r.code, r.stdout, r.stderr]).toEqual([0, "", ""]);
      const kill = (sig: NodeJS.Signals | 0) => {
        try {
          process.kill(-r.child.pid!, sig);
          return true;
        } catch {
          return false; // no such group
        }
      };
      if (process.platform === "darwin") {
        expect(kill(0)).toBe(false); // nothing left in the hook's group
        kill("SIGTERM");
        kill("SIGKILL");
      } else {
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 500);
      }
      expect(await waitFor(() => decisions(root).includes(`turn ${i} of the process group test`))).toBe(true);
    }
    expect(decisions(root).trim().split("\n")).toHaveLength(N);
  });

  it("a Jev error reaches .jevmem/log.jsonl", async () => {
    fake = await startFakeJev(() => ({ status: 400 }));
    const root = tmp();
    init({ root, hooks: false });
    const r = await stopHook(launcher(kind, path.resolve("."), root, { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url }), root, "Decision: the queue runs on Redis streams.");
    expect([r.code, r.stdout, r.stderr]).toEqual([0, "", ""]);
    expect(await waitFor(() => readLog(root).some((e) => e.event === "dropped"))).toBe(true);
    expect(readLog(root).find((e) => e.event === "dropped")!.detail).toMatch(/^not retryable: .*400/);
  });

  it("a failure before the CLI's own error handling reaches .jevmem/log.jsonl, and the saved hook input is removed", async () => {
    const pkg = packageCopy();
    const chunk = fs.readdirSync(path.join(pkg, "dist")).find((f) => /^cli-main-.*\.js$/.test(f))!;
    fs.rmSync(path.join(pkg, "dist", chunk)); // as if an upgrade replaced dist/ while the hook started
    const root = tmp();
    init({ root, hooks: false });
    const l = launcher(kind, pkg, root, { TYPESAFE_API_KEY: "k" });
    const r = await stopHook(l, root, "Decision: the queue runs on Redis streams.");
    expect([r.code, r.stdout, r.stderr]).toEqual([0, "", ""]);
    expect(await waitFor(() => readLog(root).some((e) => e.label === "hook" && e.ok === false))).toBe(true);
    const e = readLog(root).find((x) => x.label === "hook" && x.ok === false)!;
    expect(e.error).toMatch(new RegExp(`^Stop: Error: Cannot find module '.*${chunk.replace(".", "\\.")}'`));
    expect(await waitFor(() => fs.readdirSync(l.env.TMPDIR!).length === 0)).toBe(true);
  });
});
