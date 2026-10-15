/**
 * `jevmem setup` (0.7.2): refused without a terminal, with the steps by hand; on a terminal (a stand-in answers the
 * prompts here; the e2e `setup` scenario drives a real pseudo-terminal), the key asked for without showing it and saved
 * as `jevmem key` saves it, the folder turned on, the key checked with one request of fixed words, doctor run, what is
 * next said, the marker that ends the plugin's one-time message written, and past sessions offered with the lines shown
 * before anything is written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type TerminalIo } from "../src/cli-main.js";
import { projectSlug } from "../src/import.js";
import { readSetupMarker, SETUP_KEY_CHECK_TEXT, SETUP_NEEDS_TERMINAL } from "../src/setup.js";
import { MemoryStore } from "../src/store.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { startFakeJev, type FakeJev } from "./fakejev.js";
import { SAVE_DECISION } from "./helpers.js";

const tmp = (p = "jevmem-setup-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function run(argv: string[], cwd: string, opts: { stdin?: string; terminal?: TerminalIo } = {}) {
  let out = "";
  let err = "";
  return main(argv, { out: (s) => void (out += s), err: (s) => void (err += s), cwd }, opts).then((code) => ({ code, out, err }));
}
/** A terminal stand-in: answers each prompt by a substring of it, and records what was asked (hidden or not). */
function terminal(answers: Record<string, string>): TerminalIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (prompt, o) => {
      asked.push(`${o.hidden ? "[hidden] " : ""}${prompt}`);
      const k = Object.keys(answers).find((a) => prompt.includes(a));
      if (k === undefined) throw new Error(`unexpected prompt: ${prompt}`);
      return answers[k]!;
    },
  };
}
const KEY = "example-key-abcdef1234";
const KEY_PROMPT = "TypeSafe API key (input hidden): ";
let fake: FakeJev | null = null;
const saved: Record<string, string | undefined> = {};
const VARS = ["HOME", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "JEVMEM_DAEMON", "JEVMEM_WRITER"];
beforeEach(() => {
  for (const k of VARS) saved[k] = process.env[k];
  for (const k of ["TYPESAFE_API_KEY", "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT"]) delete process.env[k];
  process.env.JEVMEM_DAEMON = "0";
  process.env.JEVMEM_WRITER = "none";
  process.env.HOME = tmp("jevmem-setup-home-");
});
afterEach(async () => {
  await fake?.close();
  fake = null;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const logOf = (root: string) => (fs.existsSync(path.join(root, ".jevmem", "log.jsonl")) ? fs.readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe.skipIf(process.platform === "win32")("jevmem setup", () => {
  it("refuses without a terminal: the three steps by hand, exit 1, nothing created or written", async () => {
    const cwd = tmp();
    const r = await run(["setup"], cwd);
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe(SETUP_NEEDS_TERMINAL);
    expect(r.err).toContain("1. jevmem key");
    expect(fs.existsSync(path.join(cwd, "jevmem.config.json"))).toBe(false);
    expect(fs.existsSync(path.join(process.env.HOME!, ".jevmem"))).toBe(false);
    expect(readSetupMarker(process.env.HOME!)).toBeNull();
  });

  it("on a terminal: asks for the key without showing it, saves it (700/600), turns the folder on, checks the key with one request of fixed words, runs doctor, says what is next, writes the marker; run again, finds everything", async () => {
    fake = await startFakeJev(() => ({}));
    process.env.TYPESAFE_BASE_URL = fake.url;
    const home = process.env.HOME!;
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules\n");
    fs.mkdirSync(path.join(cwd, ".git"));
    const term = terminal({ [KEY_PROMPT]: KEY });
    const r = await run(["setup"], cwd, { terminal: term });
    expect(r.code).toBe(0);
    expect(term.asked).toEqual([`[hidden] ${KEY_PROMPT}`]);
    expect(r.out).toContain(`jevmem ${PACKAGE_VERSION} (`);
    expect(r.out).toContain("Claude Code plugin: none found");
    expect(r.out).toContain("TypeSafe API key: none found. Get one at https://console.typesafe.ai/keys");
    expect(r.out).toContain("Saved your TypeSafe API key to ~/.jevmem/env (readable only by you).");
    expect(r.out).toMatch(/^ {2}created {2}jevmem\.config\.json$/m);
    expect(r.out).toMatch(/^ {2}updated {2}\.gitignore \(\+ \.jevmem\/\)$/m);
    expect(r.out).toContain("jevmem is turned on in this project.");
    expect(r.out).toMatch(/TypeSafe accepted the key \(\d+ ms\)\./);
    expect(r.out).toContain("\njevmem doctor:\n  jevmem ");
    expect(r.out).toMatch(/^ {2}project {2}.*: enabled \(jevmem\.config\.json\)$/m);
    expect(r.out).toContain("\nNext: start Claude Code in this folder");
    expect(r.out).not.toContain("Found ");
    expect(r.out + r.err).not.toContain(KEY);
    const envFile = path.join(home, ".jevmem", "env");
    expect(fs.readFileSync(envFile, "utf8")).toBe(`TYPESAFE_API_KEY=${KEY}\n`);
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, ".jevmem")).mode & 0o777).toBe(0o700);
    for (const f of ["jevmem.config.json", "JEVMEM.md", ".jevmem"]) expect(fs.existsSync(path.join(cwd, f)), f).toBe(true);
    expect(readSetupMarker(home)).toMatch(/^done 20\d\d-\d\d-\d\dT/);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.state.query).toBe(SETUP_KEY_CHECK_TEXT);
    expect(fake.requests[0]!.state.memories).toEqual([]);
    expect(Object.keys(fake.requests[0]!.questions)).toEqual(["setup_check"]);
    const checks = logOf(cwd).filter((e) => e.label === "setup");
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(true);
    // Again: the key is found, the folder already on, nothing asked.
    delete process.env.TYPESAFE_API_KEY;
    const again = await run(["setup"], cwd, { terminal: terminal({}) });
    expect(again.code).toBe(0);
    expect(again.out).toContain("TypeSafe API key: found (~/.jevmem/env)");
    expect(again.out).toContain("jevmem was already turned on in this project.");
    expect(again.out).not.toContain("Saved your TypeSafe API key");
    expect(fake.requests).toHaveLength(2);
  });

  it("a rejected key is said, and setup goes on; TypeSafe unreachable is said, and the key stays saved", async () => {
    fake = await startFakeJev(() => ({ status: 401 }));
    process.env.TYPESAFE_BASE_URL = fake.url;
    const cwd = tmp();
    const r = await run(["setup"], cwd, { terminal: terminal({ [KEY_PROMPT]: KEY }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("TypeSafe rejected the key (401). Run jevmem key to replace it.");
    expect(r.out).toContain("jevmem is turned on in this project.");
    expect(readSetupMarker(process.env.HOME!)).toMatch(/^done /);
    expect(logOf(cwd).filter((e) => e.label === "setup" && e.ok === false)).toHaveLength(1);
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:9";
    delete process.env.TYPESAFE_API_KEY;
    const cwd2 = tmp();
    const r2 = await run(["setup"], cwd2, { terminal: terminal({}) });
    expect(r2.code).toBe(0);
    expect(r2.out).toContain("TypeSafe API key: found (~/.jevmem/env)");
    expect(r2.out).toMatch(/Could not reach TypeSafe \(.+\): the key is saved; jevmem retries on its own\./);
    expect(fs.readFileSync(path.join(process.env.HOME!, ".jevmem", "env"), "utf8")).toBe(`TYPESAFE_API_KEY=${KEY}\n`);
  });

  it("a paste that cannot be a key: nothing changed, exit 1", async () => {
    const cwd = tmp();
    const r = await run(["setup"], cwd, { terminal: terminal({ [KEY_PROMPT]: "no key" }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("no usable key read, so nothing was changed");
    expect(fs.existsSync(path.join(cwd, "jevmem.config.json"))).toBe(false);
    expect(fs.existsSync(path.join(process.env.HOME!, ".jevmem", "env"))).toBe(false);
    expect(readSetupMarker(process.env.HOME!)).toBeNull();
  });

  it("offers past sessions: the count and the cost, the lines before anything is written, each after a yes; N at either question writes nothing", async () => {
    fake = await startFakeJev((q) => ("setup_check" in q ? {} : SAVE_DECISION));
    process.env.TYPESAFE_BASE_URL = fake.url;
    const cwd = tmp();
    const configDir = tmp("jevmem-setup-config-");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const dir = path.join(configDir, "projects", projectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const entry = (type: "user" | "assistant", text: string) => JSON.stringify({ type, uuid: `${type}-${Math.random().toString(36).slice(2, 8)}`, isSidechain: false, timestamp: "2026-10-01T10:00:00.000Z", version: "2.1.296", message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
    fs.writeFileSync(path.join(dir, "s1.jsonl"), [entry("user", "Decision: we use SQLite as the single-file store, no server."), entry("assistant", "Noted: SQLite it is.")].join("\n") + "\n");
    // N at the first question: nothing sent for the import (the key check is the only request).
    const first = await run(["setup"], cwd, { terminal: terminal({ [KEY_PROMPT]: KEY, "[y/N]": "n" }) });
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Found 1 past Claude Code session with 1 turn in this project/);
    expect(first.out).toContain("you see the lines before anything is written");
    expect(first.out).toContain("Skipped. Later: jevmem import --from sessions shows what it would add, and --apply writes it.");
    expect(fake.requests).toHaveLength(1);
    // y, then N at "Write these": the lines are shown and nothing is written.
    const askedSoFar: string[] = [];
    const t2: TerminalIo = { ask: async (prompt) => { askedSoFar.push(prompt); return prompt.startsWith("Write these") ? "n" : "y"; } };
    delete process.env.TYPESAFE_API_KEY;
    const second = await run(["setup"], cwd, { terminal: t2 });
    expect(second.code).toBe(0);
    expect(askedSoFar).toEqual(["Send 1 turn from 1 session to TypeSafe? [y/N] ", "Write these 1 line to JEVMEM.md? [y/N] "]);
    expect(second.out).toMatch(/^ {2}\+ \[decision\] .*SQLite/m);
    expect(second.out).not.toContain("Would add");
    expect(second.out).toContain("Nothing written.");
    expect(new MemoryStore(cwd).active()).toEqual([]);
    // y and y: written, with its provenance.
    delete process.env.TYPESAFE_API_KEY;
    const third = await run(["setup"], cwd, { terminal: terminal({ "[y/N]": "y" }) });
    expect(third.code).toBe(0);
    expect(third.out).toMatch(/Added 1 line\(s\) to JEVMEM\.md; the session files were not changed\. jevmem forget <id> retires a line\./);
    const lines = new MemoryStore(cwd).active();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toMatch(/SQLite/);
  });
});
