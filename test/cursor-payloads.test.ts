/**
 * Cursor runs a project's Claude Code hooks (`.claude/settings*.json`) with its own payloads and event names when its
 * third-party import is on (the default), measured on 2026-10-16 with Cursor 3.24.18. jevmem's Claude Code hooks must
 * do nothing with those payloads: no request, no file, no output, exit 0. The payloads are the real ones from that
 * measurement (test/fixtures/cursor/app-r6: `cc-*` are the ones Cursor passed to the Claude-format entries, the rest
 * its native ones, whose shape is the same) and from the `agent` CLI (cli-r1).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { init } from "../src/init.js";
import { readQueue } from "../src/queue.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";

const CLI = path.resolve("dist/cli.js");
const INIT_LAUNCHER = path.resolve("hooks/jevmem-hook.sh");
const FIX = path.resolve("test/fixtures/cursor");
const tmp = (p = "jevmem-cursor-cc-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
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

const fixtures = (dir: string) =>
  fs
    .readdirSync(path.join(FIX, dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, tag: f.split(".").at(-2)!, payload: JSON.parse(fs.readFileSync(path.join(FIX, dir, f), "utf8")).payload as Record<string, any> }));

describe("Cursor's payloads into the Claude Code hooks jevmem init registers", () => {
  it("every payload Cursor sends (the app, both turns; the CLI): the hook command exits 0 with nothing, no request, no file", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    init({ root }); // the four Claude Code hooks, as 0.7.3 writes them
    const before = listing(root);
    const home = tmp("jevmem-cursor-cc-home-");
    const all = [...fixtures("app-r6"), ...fixtures("cli-r1")];
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) {
      const p: Record<string, any> = { ...f.payload, workspace_roots: [root], transcript_path: f.payload.transcript_path ? path.join(root, "no-such-transcript.jsonl") : null };
      const r = spawnSync(process.execPath, [CLI, "hook"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none", CLAUDE_PROJECT_DIR: root, CURSOR_PROJECT_DIR: root, CURSOR_VERSION: String(p.cursor_version ?? "") }, input: JSON.stringify(p), encoding: "utf8", timeout: 20_000 });
      expect(r.status, f.name).toBe(0);
      expect(r.stdout, f.name).toBe("");
      expect(r.stderr, f.name).toBe("");
    }
    expect(fake.requests).toHaveLength(0);
    expect(readQueue(root)).toHaveLength(0);
    expect(listing(root)).toEqual(before);
  });

  it.skipIf(process.platform === "win32")("the same through the init launcher for Stop (--detach) and PreToolUse", async () => {
    fake = await startFakeJev(() => ({}));
    const root = tmp();
    init({ root });
    const before = listing(root);
    const home = tmp("jevmem-cursor-cc-home-");
    const stop = fixtures("app-r6").find((f) => f.tag === "cc-Stop")!.payload;
    const pre = fixtures("app-r6").find((f) => f.tag === "preToolUse")!.payload;
    for (const [args, p] of [
      [["--node", process.execPath, "--detach", "hook"], stop],
      [["--node", process.execPath, "hook"], pre],
    ] as const) {
      const r = spawnSync("sh", [INIT_LAUNCHER, ...args], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none", CLAUDE_PROJECT_DIR: root, CURSOR_PROJECT_DIR: root, CURSOR_VERSION: "3.24.18" }, input: JSON.stringify({ ...p, workspace_roots: [root], transcript_path: null }), encoding: "utf8", timeout: 20_000 });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    }
    await new Promise((res) => setTimeout(res, 3_000)); // the detached process, had it done anything
    expect(fake.requests).toHaveLength(0);
    expect(readQueue(root)).toHaveLength(0);
    expect(listing(root)).toEqual(before);
  });
});
