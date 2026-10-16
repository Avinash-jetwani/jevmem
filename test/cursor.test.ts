/**
 * Automatic saving in Cursor (0.7.4): the transcript reader, the stash, `jevmem init --tool cursor`'s hooks file and
 * launcher, and the `jevmem hook --cursor` path through the built CLI, on the payloads Cursor really sends
 * (test/fixtures/cursor: the app 3.24.18, R6, and the `agent` CLI 2026.08.11, R1 and R3b; see the README there).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CURSOR_HOOK_EVENTS, cursorHooksStatus, readCursorTranscript, registerCursorHooks, stripCursorPrompt, unregisterCursorHooks } from "../src/cursor.js";
import { init } from "../src/init.js";
import { readQueue } from "../src/queue.js";
import { recordProvenance } from "../src/provenance.js";
import { MemoryStore } from "../src/store.js";
import { setupCursor } from "../src/tools.js";

const CLI = path.resolve("dist/cli.js");
const LAUNCHER = path.resolve("hooks/jevmem-cursor-hook.sh");
const FIX = path.resolve("test/fixtures/cursor");
const tmp = (p = "jevmem-cursor-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
beforeAll(() => {
  if (!fs.existsSync(CLI)) execFileSync("pnpm", ["build"], { stdio: "ignore" });
}, 60_000);

/** A fixture payload, with `<project>` and `<home>` placed; `transcript` replaces transcript_path with a copy of the fixture's transcript. */
function payload(name: string, opts: { project?: string; transcript?: string | null } = {}): Record<string, any> {
  const file = fs.readdirSync(path.join(FIX, "app-r6")).find((f) => f.endsWith(`.${name}.json`)) ?? "";
  const dir = file ? path.join(FIX, "app-r6") : path.join(FIX, "cli-r1");
  const f = file || (fs.readdirSync(dir).find((x) => x.endsWith(`.${name}.json`)) ?? "");
  if (!f) throw new Error(`no fixture ${name}`);
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const p = j.payload;
  const text = JSON.stringify(p).split("<project>").join(opts.project ?? "/project").split("<home>").join(os.homedir());
  const out = JSON.parse(text);
  if (opts.transcript !== undefined) out.transcript_path = opts.transcript;
  if (opts.project) out.workspace_roots = [opts.project];
  return out;
}
/** The nth app payload of an event (0-based), by time. */
function appPayloads(name: string): Record<string, any>[] {
  return fs
    .readdirSync(path.join(FIX, "app-r6"))
    .filter((f) => f.endsWith(`.${name}.json`))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIX, "app-r6", f), "utf8")).payload);
}
const transcriptFixture = (dir: string, suffix: string): string => {
  const f = fs.readdirSync(path.join(FIX, dir)).filter((x) => x.endsWith(suffix)).sort().at(-1);
  if (!f) throw new Error(`no transcript ${dir} ${suffix}`);
  return path.join(FIX, dir, f);
};
const copyTranscript = (from: string): string => {
  const dir = tmp("jevmem-cursor-transcript-");
  const to = path.join(dir, "conversation.jsonl");
  fs.copyFileSync(from, to);
  return to;
};
const PROMPT_1 = "Say the word ready, then list the files with the shell tool, then say the word done.";
const PROMPT_2 = "Say the word again, then stop.";

function hook(root: string, input: object, extra: string[] = ["--cursor"], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, "hook", ...extra], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp("jevmem-cursor-home-"), TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:9", JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none", CLAUDE_PROJECT_DIR: root, CURSOR_PROJECT_DIR: root, CURSOR_VERSION: "3.24.18", ...env }, input: JSON.stringify(input), encoding: "utf8", timeout: 20_000 });
}

describe("Cursor's transcript", () => {
  it("strips Cursor's timestamp and user_query wrappers from a prompt and leaves a plain prompt alone", () => {
    expect(stripCursorPrompt("<timestamp>Friday, Oct 16, 2026, 7:15 PM (UTC+1)</timestamp>\n<user_query>\nSay the word ready.\n</user_query>")).toBe("Say the word ready.");
    expect(stripCursorPrompt("Say the word ready.")).toBe("Say the word ready.");
    expect(stripCursorPrompt("<user_query>\nTwo\nlines\n</user_query>")).toBe("Two\nlines");
  });

  it("reads the app's two-turn transcript: one turn per user line, the text blocks joined, tool_use skipped, turn_ended closes a turn", () => {
    const turns = readCursorTranscript(transcriptFixture("app-r6", ".stop.transcript"));
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ index: 1, user: PROMPT_1, assistant: "ready\n\ndone", ended: true, status: "success" });
    expect(turns[1]).toMatchObject({ index: 2, user: PROMPT_2, assistant: "again", ended: true, status: "success" });
    expect(turns[0]!.assistant).not.toContain("Shell");
    expect(turns[0]!.assistant).not.toContain("ls -la");
  });

  it("reads the CLI's one-turn transcript the same way", () => {
    const turns = readCursorTranscript(transcriptFixture("cli-r1", ".sessionEnd.transcript"));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ index: 1, user: PROMPT_1, assistant: "ready\n\ndone", ended: true });
  });

  it("an interrupted turn (no turn_ended line) is read but not ended", () => {
    const turns = readCursorTranscript(path.join(FIX, "cli-r3b-interrupted.transcript"));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.ended).toBe(false);
    expect(turns[0]!.user).toMatch(/^Run the shell command sleep 2 twenty times/);
    expect(turns[0]!.assistant).toMatch(/^I'll run `sleep 2` twenty times/);
    expect(turns[0]!.assistant).not.toContain("tool_use");
  });

  it("a user line Cursor wrote itself after a background task continues the turn; the person's next prompt starts one", () => {
    const f = path.join(tmp(), "follow-up.jsonl");
    const line = (o: unknown) => JSON.stringify(o);
    const user = (text: string) => line({ role: "user", message: { content: [{ type: "text", text }] } });
    const assistant = (text: string) => line({ role: "assistant", message: { content: [{ type: "text", text }] } });
    fs.writeFileSync(
      f,
      [
        user("<timestamp>Friday, Oct 16, 2026, 8:34 PM (UTC+1)</timestamp>\n<user_query>\nRule: the server listens on 8080, not 3000.\n</user_query>"),
        assistant("I'll change the port and start the server to check it."),
        user("<timestamp>Friday, Oct 16, 2026, 8:35 PM (UTC+1)</timestamp>\n\n<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.</user_query>"),
        assistant("The server listens on 8080 now; the check server has stopped."),
        line({ type: "turn_ended", status: "success" }),
        user("<timestamp>Friday, Oct 16, 2026, 8:36 PM (UTC+1)</timestamp>\n<user_query>\nRun the tests.\n</user_query>"),
        assistant("All green."),
        line({ type: "turn_ended", status: "success" }),
      ].join("\n") + "\n",
    );
    const turns = readCursorTranscript(f);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ user: "Rule: the server listens on 8080, not 3000.", assistant: "I'll change the port and start the server to check it.\n\nThe server listens on 8080 now; the check server has stopped.", ended: true });
    expect(turns[1]).toMatchObject({ user: "Run the tests.", assistant: "All green.", ended: true });
  });

  it("a missing or broken file gives no turns and no throw", () => {
    expect(readCursorTranscript(path.join(tmp(), "none.jsonl"))).toEqual([]);
    const f = path.join(tmp(), "bad.jsonl");
    fs.writeFileSync(f, "{not json\n\n{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n");
    expect(readCursorTranscript(f)).toMatchObject([{ user: "hi", assistant: "", ended: false }]);
  });
});

describe("jevmem hook --cursor (the built CLI, the payloads Cursor sends)", () => {
  it("stop (completed) with a transcript queues the turn read from it, once", () => {
    const root = tmp();
    init({ root, hooks: false });
    const t = copyTranscript(transcriptFixture("app-r6", ".stop.transcript"));
    const first = appPayloads("stop")[0]!;
    // The first stop's payload, with the transcript as it was at the first stop (turn 1 only).
    const t1 = copyTranscript(transcriptFixture("app-r6", "1792174567.567.9372.stop.transcript"));
    const r = hook(root, { ...first, transcript_path: t1, workspace_roots: [root] });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr.trim()).toBe("");
    let q = readQueue(root);
    expect(q).toHaveLength(1);
    expect(q[0]!.user).toBe(PROMPT_1);
    expect(q[0]!.assistant).toBe("ready\n\ndone");
    expect(q[0]!.source).toMatch(/cursor/);
    // The same turn again (Cursor could fire stop twice, or sessionEnd follows): decided once.
    hook(root, { ...first, transcript_path: t1, workspace_roots: [root] });
    expect(readQueue(root)).toHaveLength(1);
    // The second turn, with the two-turn transcript: only the new turn, with the first as its context.
    const second = appPayloads("stop")[1]!;
    hook(root, { ...second, transcript_path: t, workspace_roots: [root] });
    q = readQueue(root);
    expect(q).toHaveLength(2);
    expect(q[1]!.user).toBe(PROMPT_2);
    expect(q[1]!.assistant).toBe("again");
    expect(q[1]!.previous).toContain("ready");
  });

  it("without a transcript, the stash from beforeSubmitPrompt and afterAgentResponse carries the turn", () => {
    const root = tmp();
    init({ root, hooks: false });
    const before = appPayloads("beforeSubmitPrompt")[0]!;
    let r = hook(root, { ...before, workspace_roots: [root] });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ continue: true });
    const stash = path.join(root, ".jevmem", "cursor", `${before.conversation_id}.json`);
    expect(fs.existsSync(stash)).toBe(true);
    const after = appPayloads("afterAgentResponse")[0]!;
    r = hook(root, { ...after, transcript_path: null, workspace_roots: [root] });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
    const stop = appPayloads("stop")[0]!;
    r = hook(root, { ...stop, transcript_path: null, workspace_roots: [root] });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    const q = readQueue(root);
    expect(q).toHaveLength(1);
    expect(q[0]!.user).toBe(PROMPT_1);
    expect(q[0]!.assistant).toBe("done");
    expect(q[0]!.source).toMatch(/stash/);
    expect(fs.existsSync(stash)).toBe(false);
  });

  it("stop with status aborted or error decides nothing and drops the stash", () => {
    const root = tmp();
    init({ root, hooks: false });
    const before = appPayloads("beforeSubmitPrompt")[0]!;
    hook(root, { ...before, workspace_roots: [root] });
    const stop = appPayloads("stop")[0]!;
    const t = copyTranscript(transcriptFixture("app-r6", ".stop.transcript"));
    for (const status of ["aborted", "error"]) {
      const r = hook(root, { ...stop, status, transcript_path: t, workspace_roots: [root] });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    }
    expect(readQueue(root)).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ".jevmem", "cursor", `${before.conversation_id}.json`))).toBe(false);
  });

  it("sessionEnd (completed) decides the transcript's last finished turn, which the CLI needs; an interrupted session decides nothing", () => {
    const root = tmp();
    init({ root, hooks: false });
    const end = payload("sessionEnd", { project: root, transcript: copyTranscript(transcriptFixture("cli-r1", ".sessionEnd.transcript")) });
    let r = hook(root, end);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readQueue(root)).toHaveLength(1);
    expect(readQueue(root)[0]!.user).toBe(PROMPT_1);
    // After a stop already decided the turn, sessionEnd adds nothing.
    r = hook(root, end);
    expect(readQueue(root)).toHaveLength(1);
    const root2 = tmp();
    init({ root: root2, hooks: false });
    const interrupted = JSON.parse(fs.readFileSync(path.join(FIX, "cli-r3b-interrupted.sessionEnd.json"), "utf8")).payload;
    r = hook(root2, { ...interrupted, transcript_path: copyTranscript(path.join(FIX, "cli-r3b-interrupted.transcript")), workspace_roots: [root2] });
    expect(r.status).toBe(0);
    expect(readQueue(root2)).toHaveLength(0);
  });

  it("sessionStart serves the always-on lines as additional_context, once per conversation, and nothing when there are none", () => {
    const root = tmp();
    init({ root, hooks: false });
    const start = appPayloads("sessionStart")[0]!;
    let r = hook(root, { ...start, workspace_roots: [root] });
    expect(r.status).toBe(0);
    expect(r.stdout.trim() === "" || JSON.stringify(JSON.parse(r.stdout)) === "{}").toBe(true);
    const store = new MemoryStore(root);
    recordProvenance(root, store.add({ kind: "constraint", text: "Never commit .env files.", always: true }), "hook"); // a line jevmem wrote: verified, so the gate serves it
    r = hook(root, { ...start, conversation_id: "conv-2", session_id: "conv-2", workspace_roots: [root] });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.additional_context).toContain("Never commit .env files.");
    expect(out.additional_context).toContain("<jevmem-rules>");
    r = hook(root, { ...start, conversation_id: "conv-2", session_id: "conv-2", workspace_roots: [root] });
    expect(r.stdout.trim() === "" || !JSON.parse(r.stdout).additional_context).toBe(true);
  });

  it("in a project that is not turned on, every event does nothing, and beforeSubmitPrompt still answers continue", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "README.md"), "# x\n");
    const before = fs.readdirSync(root);
    for (const ev of CURSOR_HOOK_EVENTS) {
      const p = { ...appPayloads(ev === "sessionEnd" ? "stop" : ev)[0]!, hook_event_name: ev, workspace_roots: [root] };
      const r = hook(root, p);
      expect(r.status).toBe(0);
      expect(r.stderr.trim()).toBe("");
      if (ev === "beforeSubmitPrompt") expect(JSON.parse(r.stdout)).toEqual({ continue: true });
      else expect(r.stdout.trim()).toBe("");
    }
    expect(fs.readdirSync(root)).toEqual(before);
  });
});

describe("jevmem init --tool cursor: .cursor/hooks.json and the launcher", () => {
  it("writes the hooks file with jevmem's five events and relative commands, and the launcher, identical to the package's", () => {
    const root = tmp();
    expect(registerCursorHooks(root)).toBe("added");
    const hooks = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    for (const ev of CURSOR_HOOK_EVENTS) {
      expect(hooks.hooks[ev]).toHaveLength(1);
      expect(hooks.hooks[ev][0].command).toBe(`sh .cursor/hooks/jevmem-hook.sh ${ev}`);
      expect(typeof hooks.hooks[ev][0].timeout).toBe("number");
    }
    expect(JSON.stringify(hooks)).not.toContain(root);
    expect(JSON.stringify(hooks)).not.toContain(process.execPath);
    const launcher = path.join(root, ".cursor", "hooks", "jevmem-hook.sh");
    expect(fs.readFileSync(launcher, "utf8")).toBe(fs.readFileSync(LAUNCHER, "utf8"));
    expect(fs.statSync(launcher).mode & 0o111).not.toBe(0);
    expect(cursorHooksStatus(root)).toMatchObject({ file: true, events: [...CURSOR_HOOK_EVENTS], launcher: "current" });
  });

  it("merges into an existing hooks.json, keeps other hooks, runs twice without change, repairs a stale launcher", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "./audit.sh" }], stop: [{ command: "./notify.sh", loop_limit: 2 }] } }, null, 2));
    expect(registerCursorHooks(root)).toBe("added");
    const hooks = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.beforeShellExecution).toEqual([{ command: "./audit.sh" }]);
    expect(hooks.hooks.stop[0]).toEqual({ command: "./notify.sh", loop_limit: 2 });
    expect(hooks.hooks.stop[1].command).toBe("sh .cursor/hooks/jevmem-hook.sh stop");
    const bytes = fs.readFileSync(path.join(root, ".cursor", "hooks.json"));
    expect(registerCursorHooks(root)).toBe("present");
    expect(fs.readFileSync(path.join(root, ".cursor", "hooks.json")).equals(bytes)).toBe(true);
    fs.writeFileSync(path.join(root, ".cursor", "hooks", "jevmem-hook.sh"), "#!/bin/sh\n# an older launcher\nexit 0\n");
    expect(cursorHooksStatus(root).launcher).toBe("stale");
    expect(registerCursorHooks(root)).toBe("updated");
    expect(fs.readFileSync(path.join(root, ".cursor", "hooks", "jevmem-hook.sh"), "utf8")).toBe(fs.readFileSync(LAUNCHER, "utf8"));
    expect(cursorHooksStatus(root).others).toBe(2);
  });

  it("--remove-hooks takes jevmem's entries and the launcher out, keeps other hooks, and deletes a file left empty", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "./audit.sh" }] } }, null, 2));
    registerCursorHooks(root);
    expect(unregisterCursorHooks(root).sort()).toEqual([".cursor/hooks.json", ".cursor/hooks/jevmem-hook.sh"]);
    const hooks = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks).toEqual({ version: 1, hooks: { beforeShellExecution: [{ command: "./audit.sh" }] } });
    expect(fs.existsSync(path.join(root, ".cursor", "hooks", "jevmem-hook.sh"))).toBe(false);
    const root2 = tmp();
    registerCursorHooks(root2);
    unregisterCursorHooks(root2);
    expect(fs.existsSync(path.join(root2, ".cursor", "hooks.json"))).toBe(false);
    expect(cursorHooksStatus(root2)).toMatchObject({ file: false, events: [], launcher: "missing" });
  });

  it("setupCursor registers the hooks beside the MCP entry and the rule, and the rule no longer asks the agent to save stated decisions", () => {
    const root = tmp();
    const r = setupCursor(root);
    expect(r.created).toContain(".cursor/hooks.json (jevmem's sessionStart, beforeSubmitPrompt, afterAgentResponse, stop and sessionEnd hooks) and .cursor/hooks/jevmem-hook.sh");
    expect(fs.existsSync(path.join(root, ".cursor", "hooks.json"))).toBe(true);
    const rule = fs.readFileSync(path.join(root, ".cursor", "rules", "jevmem.mdc"), "utf8");
    expect(rule).toContain("search_memory");
    expect(rule).toMatch(/saves .*(each|every) .*turn/i);
    expect(rule).not.toMatch(/When the user states a decision.*call `add_memory`/);
    expect(r.notes.join(" ")).not.toContain("Cursor has no per-turn hook");
    expect(setupCursor(root).created).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("the Cursor launcher (hooks/jevmem-cursor-hook.sh)", () => {
  const run = (root: string, event: string, env: Record<string, string>, input = "{}") => {
    const t0 = performance.now();
    const r = spawnSync("sh", [LAUNCHER, event], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: tmp("jevmem-cursor-home-"), CURSOR_PROJECT_DIR: root, ...env }, input, encoding: "utf8", timeout: 15_000 });
    return { ...r, ms: performance.now() - t0 };
  };
  /** A stand-in CLI on PATH that records its arguments and stdin, and sleeps when asked. */
  const fakeCli = (sleep = 0) => {
    const bin = tmp("jevmem-cursor-bin-");
    const log = path.join(bin, "calls.log");
    fs.writeFileSync(path.join(bin, "jevmem"), `#!/bin/sh\n${sleep ? `sleep ${sleep}\n` : ""}printf 'args: %s\\n' "$*" >> "${log}"\nif [ "$3" = --stdin-file ]; then cat "$4" >> "${log}"; else cat >> "${log}"; fi\nprintf '\\n' >> "${log}"\n`);
    fs.chmodSync(path.join(bin, "jevmem"), 0o755);
    return { bin, log };
  };

  it("in a project that is not turned on it answers at once: continue for beforeSubmitPrompt, nothing for the rest, no file", () => {
    const root = tmp();
    const { bin, log } = fakeCli();
    for (const ev of CURSOR_HOOK_EVENTS) {
      const r = run(root, ev, { PATH: `${bin}:/usr/bin:/bin` }, '{"hook_event_name":"x"}');
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout.trim()).toBe(ev === "beforeSubmitPrompt" ? '{"continue":true}' : "");
    }
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("with no jevmem anywhere it answers the same and writes nothing", () => {
    const root = tmp();
    init({ root, hooks: false });
    const before = fs.readdirSync(path.join(root, ".jevmem"));
    const r = run(root, "beforeSubmitPrompt", {}, '{"prompt":"hi"}');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"continue":true}');
    expect(run(root, "stop", {}, '{"status":"completed"}').stdout).toBe("");
    expect(fs.readdirSync(path.join(root, ".jevmem"))).toEqual(before);
  });

  it("runs the jevmem on PATH as `hook --cursor` with the payload, and caches the path in .jevmem/", () => {
    const root = tmp();
    init({ root, hooks: false });
    const { bin, log } = fakeCli();
    const r = run(root, "afterAgentResponse", { PATH: `${bin}:/usr/bin:/bin` }, '{"text":"done"}');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, "utf8")).toBe('args: hook --cursor\n{"text":"done"}\n');
    expect(fs.readFileSync(path.join(root, ".jevmem", "cursor-launcher"), "utf8").split("\n")[0]).toBe(path.join(bin, "jevmem"));
    // Off PATH now, the cached path still finds it.
    const r2 = run(root, "afterAgentResponse", {}, '{"text":"again"}');
    expect(r2.status).toBe(0);
    expect(fs.readFileSync(log, "utf8")).toContain('{"text":"again"}');
  });

  it("stop and sessionEnd return at once while the CLI goes on detached", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const { bin, log } = fakeCli(4);
    const r = run(root, "stop", { PATH: `${bin}:/usr/bin:/bin` }, '{"status":"completed"}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeLessThan(2_500); // the stand-in sleeps 4 s: a launcher that waited for it would take longer
    expect(fs.existsSync(log)).toBe(false);
    const until = Date.now() + 10_000;
    while (!fs.existsSync(log) && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
    expect(fs.readFileSync(log, "utf8")).toContain("args: hook --cursor --stdin-file");
    expect(fs.readFileSync(log, "utf8")).toContain('{"status":"completed"}');
  });

  it("with the built CLI as the jevmem on PATH, a stop with a transcript lands the turn in the queue", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const bin = tmp("jevmem-cursor-bin-");
    fs.writeFileSync(path.join(bin, "jevmem"), `#!/usr/bin/env node\nimport("${CLI}");\n`);
    fs.chmodSync(path.join(bin, "jevmem"), 0o755);
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    const stop = appPayloads("stop")[0]!;
    const t = copyTranscript(transcriptFixture("app-r6", "1792174567.567.9372.stop.transcript"));
    const r = run(root, "stop", { PATH: `${bin}:/usr/bin:/bin`, TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:9", JEVMEM_DAEMON: "0", JEVMEM_WRITER: "none" }, JSON.stringify({ ...stop, transcript_path: t, workspace_roots: [root] }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const until = Date.now() + 15_000;
    while (readQueue(root).length === 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
    expect(readQueue(root)).toHaveLength(1);
    expect(readQueue(root)[0]!.user).toBe(PROMPT_1);
  });
});
