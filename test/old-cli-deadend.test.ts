/**
 * A JEVMEM.md with dead-end lines, for teammates still on the jevmem CLI from npm (0.5.7): its decide (the Stop hook),
 * recall (UserPromptSubmit) and doctor run with no crash, and every dead-end line is still in the file, word for word,
 * after 0.5.7 has written it. 0.5.7 reads a kind as `[a-z]+`, so to it a dead-end line is not a memory: it keeps the
 * line as text (before its first memory line, with the header; after it, as a trailing line) and never sends it to Jev.
 * main reads them all back as memories, a superseded line pointing at a dead end included.
 *
 * The real 0.5.7 CLI, built from the v0.5.7 tag (test/oldrelease.ts), as in test/old-cli-launcher.test.ts; Jev is a
 * local stand-in (test/fakejev.ts), so the answers here are simulated.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, parseMemoryFile } from "../src/store.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";
import { OLD_TAG, oldRelease } from "./oldrelease.js";

const release = process.platform === "win32" ? null : oldRelease();
if (!release) console.warn(`old-cli-deadend.test.ts skipped: no ${OLD_TAG} tag in this checkout (git fetch --tags)`);
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const TS = "2026-09-27T10:00:00.000Z";
const line = (kind: string, text: string, id: string, extra = "") => `- [${kind}] ${text}  <!-- id:${id} ts:${TS} conf:0.90${extra} -->`;

// Written as main writes them. The first memory line of the file is a dead end, so 0.5.7 sees it as part of the header;
// the superseded SQLite line points at a dead end (a dead end that reversed a decision).
const DEAD_ENDS = [
  line("dead-end", "Moving sessions to Redis added 40 ms per request from the EU region, so it was reverted", "de0001"),
  line("dead-end", "Running src/app.ts with node --experimental-strip-types fails because app.ts uses an enum; the tsc build stays", "de0002"),
  line("dead-end", "SQLite as the main database locked under our write load, so it was dropped for Postgres 16", "de0003"),
];
const OTHERS = {
  postgres: line("decision", "Use Postgres 16 for the main database", "pg16db"),
  superseded: `- [superseded] Use SQLite for the main database → id:de0003  <!-- id:sq0001 ts:${TS} conf:0.80 by:de0003 -->`,
  env: line("constraint", "Never commit .env files", "cn0001"),
};

describe.skipIf(!release)(`a JEVMEM.md with dead-end lines under the jevmem ${OLD_TAG.slice(1)} CLI`, () => {
  let fake: FakeJev;
  let root = "";
  let home = "";
  beforeAll(async () => {
    expect(execFileSync(process.execPath, [release!.cli, "--version"], { encoding: "utf8" }).trim()).toBe(OLD_TAG.slice(1));
    // Recall picks the first memory it is shown; decide says "save a decision".
    fake = await startFakeJev((q: any) => (q.most_relevant ? { most_relevant: Object.keys(q.most_relevant.criteria).find((k) => k !== "none")! } : SAVE_DECISION));
    root = tmp("jevmem-oldcli-deadend-");
    home = tmp("jevmem-oldcli-deadend-home-");
    execFileSync(process.execPath, [release!.cli, "init", "--no-hooks"], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: "ignore" });
    const header = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8").replace(/\s+$/, "");
    fs.writeFileSync(path.join(root, "JEVMEM.md"), [header, "", DEAD_ENDS[0], OTHERS.postgres, DEAD_ENDS[1], OTHERS.superseded, DEAD_ENDS[2], OTHERS.env, ""].join("\n"));
  }, 120_000);
  afterAll(async () => {
    await fake?.close();
  });

  /**
   * One 0.5.7 command, run as a hook runs it: no shell variables but these, the key and base URL, no daemon. Async, so
   * the stand-in Jev in this process can answer while it runs.
   */
  const run = (args: string[], input?: object) =>
    new Promise<{ status: number | null; stdout: string; stderr: string; error: undefined }>((resolve) => {
      const p = spawn(process.execPath, [release!.cli, ...args], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_PROJECT_DIR: root, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: fake.url, JEVMEM_DAEMON: "0" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr, error: undefined }));
      p.stdin.end(input ? JSON.stringify(input) : "");
    });
  const memory = () => fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
  const count = (text: string, s: string) => text.split("\n").filter((l) => l === s).length;

  it("decide: the Stop hook exits 0, the turn is decided and saved, and every dead-end line is still there, word for word", async () => {
    const r = await run(["hook"], { hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: "Decision: we use Redis for the job queue." });
    expect([r.status, r.stderr, r.error]).toEqual([0, "", undefined]);
    expect(fs.readFileSync(path.join(root, ".jevmem", "decisions.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    const text = memory();
    expect(text).toMatch(/^- \[decision\] We use Redis for the job queue\.? {2}<!-- id:\w+ /m);
    for (const l of [...DEAD_ENDS, OTHERS.postgres, OTHERS.superseded, OTHERS.env]) expect(count(text, l), l).toBe(1);
    // What 0.5.7 sent Jev: its own memories only; the dead ends are text to it.
    const decide = fake.requests.find((q) => q.state?.user_message);
    const ids = decide!.state.existing_memories.map((m: any) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["pg16db", "cn0001"]));
    for (const id of ["de0001", "de0002", "de0003"]) expect(ids).not.toContain(id);
  });

  it("recall: the UserPromptSubmit hook exits 0 and injects 0.5.7's own lines", async () => {
    const r = await run(["hook"], { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: root, prompt: "How should the API connect to the database?" });
    expect([r.status, r.stderr, r.error]).toEqual([0, "", undefined]);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("<jevmem-memory>");
    expect(ctx).not.toContain("Already tried");
    expect(ctx).not.toContain("de000");
  });

  it("doctor: exits 0", async () => {
    const r = await run(["doctor"]);
    expect([r.status, r.stderr, r.error]).toEqual([0, "", undefined]);
    expect(r.stdout).toMatch(new RegExp(`^jevmem ${OLD_TAG.slice(1).replace(/\./g, "\\.")}\\n`));
  });

  it("main reads every line back after 0.5.7 wrote the file, the superseded line's pointer at a dead end included, and 0.5.7 reads main's file again", async () => {
    const parsed = parseMemoryFile(memory());
    const byId = new Map(parsed.memories.map((m) => [m.id, m]));
    for (const id of ["de0001", "de0002", "de0003"]) expect(byId.get(id)?.kind, id).toBe("dead-end");
    expect(byId.get("sq0001")).toMatchObject({ kind: "superseded", supersededBy: "de0003" });
    expect(parsed.trailer).toEqual([]);
    const store = new MemoryStore(root);
    expect(store.active().map((m) => m.id)).toEqual(expect.arrayContaining(["de0001", "de0002", "de0003", "pg16db", "cn0001"]));
    // main writes the file (as its hook would), then 0.5.7 decides one more turn on it.
    store.write(store.read());
    const r = await run(["hook"], { hook_event_name: "Stop", session_id: "s1", cwd: root, user_message: "Decision: deploys go through GitHub Actions only." });
    expect([r.status, r.stderr]).toEqual([0, ""]);
    const text = memory();
    for (const l of [...DEAD_ENDS, OTHERS.superseded]) expect(count(text, l), l).toBe(1);
    expect(parseMemoryFile(text).memories.filter((m) => m.kind === "dead-end")).toHaveLength(3);
  });
});
