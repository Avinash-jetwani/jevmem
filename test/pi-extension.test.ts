import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "../src/init.js";
import jevmemExtension, { lastPiTurn } from "../src/pi-extension.js";
import { runHook } from "../src/hook.js";

vi.mock("../src/hook.js", () => ({ runHook: vi.fn() }));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-pi-"));
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: "private" }], stopReason });
const messages = (...items: unknown[]) => items as AgentEndEvent["messages"];
const ctx = (cwd: string, branchMessages: AgentEndEvent["messages"] = []) => ({ cwd, sessionManager: { getBranch: () => branchMessages.map((message) => ({ type: "message", message })) } });

function handlers() {
  const events: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  jevmemExtension({ on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { events[name] = handler; return () => {}; } } as unknown as ExtensionAPI);
  return events;
}

beforeEach(() => vi.mocked(runHook).mockReset());

describe("Pi turn extraction", () => {
  it("keeps only text from the last user exchange, excluding tools and injected context", () => {
    const turn = lastPiTurn(messages(
      user("earlier"), assistant("earlier reply"),
      user("Use Postgres"), { role: "custom", content: "injected memory" },
      assistant("Checking"), { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] },
      assistant("Agreed: Postgres"),
    ));
    expect(turn).toEqual({ user: "Use Postgres", assistant: "Checking\nAgreed: Postgres", previous: "user: earlier\nassistant: earlier reply" });
  });

  it("skips incomplete, aborted, and failed turns", () => {
    expect(lastPiTurn(messages(user("Prompt")))).toBeNull();
    expect(lastPiTurn(messages(user("Prompt"), assistant("partial", "aborted")))).toBeNull();
    expect(lastPiTurn(messages(user("Prompt"), assistant("partial", "error")))).toBeNull();
    expect(lastPiTurn(messages(user("Prompt"), assistant("")))).toBeNull();
  });
});

describe("Pi lifecycle", () => {
  it("is inert in a project without initialized memory", async () => {
    const root = tmp();
    const events = handlers();
    expect(await events.before_agent_start!({ prompt: "Deploy?" }, ctx(root))).toBeUndefined();
    await events.agent_end!({ messages: messages(user("Deploy?"), assistant("Yes")) }, ctx(root));
    expect(runHook).not.toHaveBeenCalled();
  });

  it("injects recall and captures completed turns using the Pi cwd", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    vi.mocked(runHook).mockResolvedValueOnce({ event: "UserPromptSubmit", action: "injected", detail: "one", additionalContext: "<jevmem-memory>Use Postgres</jevmem-memory>" })
      .mockResolvedValueOnce({ event: "Stop", action: "saved", detail: "saved" });
    expect(await events.before_agent_start!({ prompt: "Which database?" }, ctx(root))).toEqual({
      message: { customType: "jevmem-recall", content: "<jevmem-memory>Use Postgres</jevmem-memory>", display: false },
    });
    await events.agent_end!({ messages: messages(user("Which database?"), assistant("Postgres")) }, ctx(root, messages(user("Use pnpm"), assistant("Okay"), user("Which database?"), assistant("Postgres"))));
    expect(runHook).toHaveBeenNthCalledWith(1, { hook_event_name: "UserPromptSubmit", cwd: root, prompt: "Which database?" }, { root });
    expect(runHook).toHaveBeenNthCalledWith(2, { hook_event_name: "Stop", cwd: root, user_message: "Which database?", assistant_message: "Postgres", recent_context: "user: Use pnpm\nassistant: Okay" }, { root });
  });

  it("does not evaluate an aborted agent run", async () => {
    const root = tmp();
    init({ root, hooks: false });
    await handlers().agent_end!({ messages: messages(user("Decision"), assistant("Partial", "aborted")) }, ctx(root));
    expect(runHook).not.toHaveBeenCalled();
  });
});
