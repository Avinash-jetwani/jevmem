/**
 * A turn is decided once, when it is over (v0.6 part 3b). With a background subagent Claude Code runs the Stop hooks
 * while the subagent still works, and brings its report back as a `<task-notification>` written as a user entry; the
 * Stop hook must not decide the half turn, must not read the notification as the user's message, and must decide the
 * whole turn, final message included, once. The transcripts below come from real Claude Code 2.1.281 sessions
 * (eval/stops-dev.jsonl, captured with scripts/capture-stops.mjs) or are built from their entries.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureTurns, releaseQuietTurns, runHook } from "../src/hook.js";
import { readQueue } from "../src/queue.js";
import { MemoryStore } from "../src/store.js";
import { lastTurnFromTranscript, readTranscriptTurns } from "../src/transcript.js";
import { deferredTurns, isDecided, QUIET_MS, readTurnState } from "../src/turns.js";
import { CHIT_CHAT, mockJev, SAVE_DECISION } from "./helpers.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-turns-")));
const env = { JEVMEM_WRITER: "none" } as NodeJS.ProcessEnv;
const DEV = fs.readFileSync("eval/stops-dev.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const session = (id: string) => DEV.find((s) => s.id === id)!;

/** Write a captured Stop's transcript into `root` and return its payload pointed at it. */
function stopAt(root: string, s: any, i: number, file = path.join(root, "t.jsonl")) {
  const st = s.stops[i];
  const text = JSON.stringify(st.transcript).split("<project>").join(root);
  fs.writeFileSync(file, (JSON.parse(text) as unknown[]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { ...JSON.parse(JSON.stringify(st.payload).split("<project>").join(root)), transcript_path: file, cwd: root };
}

const user = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", uuid: `u-${text.slice(0, 8)}`, message: { role: "user", content: text }, ...extra });
const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const launch = (agentId: string, tool: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)` }] }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId } });
const notification = (agentId: string, tool: string, extra: Record<string, unknown> = { origin: { kind: "task-notification" }, promptSource: "system" }) =>
  JSON.stringify({ type: "user", message: { role: "user", content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<note>The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>Found 3 files.</result>\n</task-notification>` }, ...extra });

describe("readTranscriptTurns", () => {
  it("a real background-subagent session: running at the first Stop, one whole turn at the last", () => {
    const root = tmp();
    const s = session("d-bg-utc");
    const first = stopAt(root, s, 0);
    const t0 = readTranscriptTurns(first.transcript_path, { lastAssistantMessage: first.last_assistant_message })!;
    expect(t0).toHaveLength(1);
    expect(t0[0]!.user).toBe(s.prompts[0]);
    expect(t0[0]!.waiting).toHaveLength(1);
    expect(t0[0]!.assistant).toContain(first.last_assistant_message.trim());
    const last = stopAt(root, s, 1);
    const t1 = readTranscriptTurns(last.transcript_path, { lastAssistantMessage: last.last_assistant_message })!;
    // The notification is not a turn and not the user's words; the turn holds the reply before and after it.
    expect(t1).toHaveLength(1);
    expect(t1[0]!.user).toBe(s.prompts[0]);
    expect(t1[0]!.user).not.toContain("task-notification");
    expect(t1[0]!.waiting).toEqual([]);
    expect(t1[0]!.assistant).toContain(first.last_assistant_message.trim());
    expect(t1[0]!.assistant.endsWith(last.last_assistant_message.trim())).toBe(true);
    expect(t1[0]!.assistant).not.toContain("<task-notification>");
  });

  it("two subagents: still running until both have reported, whatever background_tasks says", () => {
    const root = tmp();
    const file = path.join(root, "t.jsonl");
    const lines = [user("Use two subagents: one lists src, the other test."), launch("aaa111", "toolu_1"), launch("bbb222", "toolu_2"), assistant("Both are running.")];
    fs.writeFileSync(file, lines.join("\n") + "\n");
    expect(readTranscriptTurns(file)![0]!.waiting).toEqual(["aaa111", "bbb222"]);
    // The first report arrives; the second subagent has finished but its report is not in the transcript yet (the
    // Stop payload's background_tasks is already empty then).
    fs.appendFileSync(file, [notification("bbb222", "toolu_2"), assistant("test/ is done; waiting on src/.")].join("\n") + "\n");
    expect(readTranscriptTurns(file)![0]!.waiting).toEqual(["aaa111"]);
    fs.appendFileSync(file, [notification("aaa111", "toolu_1"), assistant("Both lists: ...")].join("\n") + "\n");
    const t = readTranscriptTurns(file)!;
    expect(t).toHaveLength(1);
    expect(t[0]!.waiting).toEqual([]);
    expect(t[0]!.assistant).toBe("Both are running.\ntest/ is done; waiting on src/.\nBoth lists: ...");
  });

  it("an older Claude Code: a notification known only by its text, a launch only by its tool result", () => {
    const root = tmp();
    const file = path.join(root, "t.jsonl");
    const oldLaunch = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "Async agent launched successfully.\nagentId: ccc333" }] } });
    fs.writeFileSync(file, [user("Hand this to a subagent: count the tests."), oldLaunch, assistant("Delegated.")].join("\n") + "\n");
    expect(readTranscriptTurns(file)![0]!.waiting).toEqual(["ccc333"]);
    fs.appendFileSync(file, [notification("ccc333", "toolu_9", {}), assistant("There are 4 tests.")].join("\n") + "\n");
    const t = readTranscriptTurns(file)!;
    expect(t).toHaveLength(1);
    expect(t[0]!.waiting).toEqual([]);
    expect(t[0]!.user).toBe("Hand this to a subagent: count the tests.");
  });

  it("adds the Stop's final message, which the transcript does not hold yet, unless the turn already ends with it", () => {
    const root = tmp();
    const file = path.join(root, "t.jsonl");
    fs.writeFileSync(file, [user("Why does the receipt show 7.5600000000000005?"), assistant("Let me look at fare.mjs.")].join("\n") + "\n");
    expect(readTranscriptTurns(file, { lastAssistantMessage: "Floats: sum in cents instead." })![0]!.assistant).toBe("Let me look at fare.mjs.\nFloats: sum in cents instead.");
    expect(readTranscriptTurns(file, { lastAssistantMessage: "Let me look at  fare.mjs." })![0]!.assistant).toBe("Let me look at fare.mjs.");
    expect(lastTurnFromTranscript(file)!.assistant).toBe("Let me look at fare.mjs.");
  });

  it("an interruption is not a prompt, and a later prompt closes the turn before it", () => {
    const root = tmp();
    const file = path.join(root, "t.jsonl");
    fs.writeFileSync(file, [user("first ask"), assistant("working"), user("[Request interrupted by user]"), user("second ask"), assistant("done")].join("\n") + "\n");
    const t = readTranscriptTurns(file)!;
    expect(t.map((x) => [x.user, x.assistant, x.closed])).toEqual([
      ["first ask", "working", true],
      ["second ask", "done", false],
    ]);
    expect(t[1]!.previous).toBe("user: first ask\nassistant: working");
  });
});

describe("the Stop hook with background subagents", () => {
  it("a real session: nothing decided while the subagent works, then the whole turn once", async () => {
    const root = tmp();
    const s = session("d-bg-utc");
    const jev = mockJev(() => SAVE_DECISION);
    const a = await runHook(stopAt(root, s, 0), { jev, env });
    expect(a.action).toBe("noop");
    expect(a.detail).toMatch(/turn still running: 1 background subagent/);
    expect(jev.calls).toHaveLength(0);
    expect(deferredTurns(root)).toHaveLength(1);
    const b = await runHook(stopAt(root, s, 1), { jev, env });
    expect(b.action).toBe("saved");
    expect(jev.calls).toHaveLength(1);
    const state: any = jev.calls[0]!.state;
    expect(state.user_message).toBe(s.prompts[0]);
    expect(JSON.stringify(state)).not.toContain("task-notification");
    expect(deferredTurns(root)).toHaveLength(0);
    expect(new MemoryStore(root).active()).toHaveLength(1);
    // Stop again for the same turn (another hook made Claude go on): not decided twice.
    const again = stopAt(root, s, 1);
    const c = await runHook({ ...again, last_assistant_message: `${again.last_assistant_message} And one more thing.` }, { jev, env });
    expect(c.action).toBe("noop");
    expect(c.detail).toBe("turn already decided");
    expect(jev.calls).toHaveLength(1);
  });

  it("a turn the user moved on from is decided at the next Stop, before the new turn", async () => {
    const root = tmp();
    const file = path.join(root, "t.jsonl");
    fs.writeFileSync(file, [user("We decided on UTC everywhere. Have a subagent check the parser."), launch("ddd444", "toolu_4"), assistant("Delegated; I'll report back.")].join("\n") + "\n");
    const jev = mockJev((_q, st: any) => (/UTC/.test(st.user_message) ? SAVE_DECISION : CHIT_CHAT));
    const first = await runHook({ hook_event_name: "Stop", session_id: "s1", cwd: root, transcript_path: file, last_assistant_message: "Delegated; I'll report back." }, { jev, env });
    expect(first.detail).toMatch(/still running/);
    fs.appendFileSync(file, [assistant("Delegated; I'll report back."), user("thanks, that's all"), assistant("You're welcome.")].join("\n") + "\n");
    const second = await runHook({ hook_event_name: "Stop", session_id: "s1", cwd: root, transcript_path: file, last_assistant_message: "You're welcome." }, { jev, env });
    expect(second.action).toBe("skipped");
    expect(second.detail).toMatch(/after 1 queued turn/);
    expect(jev.calls.map((c: any) => c.state.user_message)).toEqual(["We decided on UTC everywhere. Have a subagent check the parser.", "thanks, that's all"]);
    expect(new MemoryStore(root).active().map((m) => m.kind)).toEqual(["decision"]);
    expect(deferredTurns(root)).toHaveLength(0);
  });

  it("a kept turn whose session went quiet or is gone is queued by the daemon's timer, with the text it had", () => {
    const root = tmp();
    const file = path.join(root, "t.jsonl");
    fs.writeFileSync(file, [user("Rule: never log emails. Have a subagent check server.mjs."), launch("eee555", "toolu_5"), assistant("On it.")].join("\n") + "\n");
    const r = captureTurns({ hook_event_name: "Stop", session_id: "s2", cwd: root, transcript_path: file }, root, "Stop");
    expect(r.turns).toEqual([]);
    expect(deferredTurns(root)).toHaveLength(1);
    expect(releaseQuietTurns(root)).toBe(0); // written just now
    expect(releaseQuietTurns(root, Date.now() + QUIET_MS + 1000)).toBe(1);
    const q = readQueue(root);
    expect(q).toHaveLength(1);
    expect(q[0]!.user).toBe("Rule: never log emails. Have a subagent check server.mjs.");
    expect(q[0]!.assistant).toBe("On it.");
    expect(deferredTurns(root)).toHaveLength(0);
    expect(isDecided(root, "s2", readTurnState(root).decided[0]!.turn)).toBe(true);
    // Gone: the transcript was removed (a harness's temporary config dir).
    const file2 = path.join(root, "t2.jsonl");
    fs.writeFileSync(file2, [user("Decision: data stays in one JSON file. Have a subagent check store.mjs."), launch("fff666", "toolu_6"), assistant("Checking.")].join("\n") + "\n");
    captureTurns({ hook_event_name: "Stop", session_id: "s3", cwd: root, transcript_path: file2 }, root, "Stop");
    fs.rmSync(file2);
    expect(releaseQuietTurns(root)).toBe(1);
    expect(readQueue(root).map((t) => t.user)).toContain("Decision: data stays in one JSON file. Have a subagent check store.mjs.");
  });

  it("a background shell does not hold the turn", async () => {
    const root = tmp();
    const file = path.join(root, "t.jsonl");
    const shell = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_7", content: "Command running in background with ID: b123. Output is being written to: /tmp/x" }] }, toolUseResult: { backgroundTaskId: "b123" } });
    fs.writeFileSync(file, [user("We use port 8787 for the dev server from now on; start it."), shell, assistant("It's running on 8787.")].join("\n") + "\n");
    const jev = mockJev(() => SAVE_DECISION);
    const r = await runHook({ hook_event_name: "Stop", session_id: "s4", cwd: root, transcript_path: file, background_tasks: [{ id: "b123", type: "shell", status: "running" }] }, { jev, env });
    expect(r.action).toBe("saved");
  });
});
