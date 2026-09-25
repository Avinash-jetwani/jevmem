import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "../src/init.js";
import jevmemExtension, { lastPiTurn } from "../src/pi-extension.js";
import { runHook, type HookOutcome } from "../src/hook.js";

vi.mock("../src/hook.js", () => ({ runHook: vi.fn() }));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-pi-"));
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: "private" }], stopReason });
const messages = (...items: unknown[]) => items as AgentEndEvent["messages"];
const ctx = (cwd: string, branchMessages: AgentEndEvent["messages"] = [], notices: { message: string; type: string | undefined }[] = []) => ({
  cwd,
  sessionManager: { getBranch: () => branchMessages.map((message) => ({ type: "message", message })) },
  ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
});

function handlers() {
  const events: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  jevmemExtension({ on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { events[name] = handler; return () => {}; } } as unknown as ExtensionAPI);
  return events;
}

beforeEach(() => { vi.mocked(runHook).mockReset(); });

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
    expect(lastPiTurn(messages(user("Prompt"), assistant("partial", "toolUse")))).toBeNull();
    expect(lastPiTurn(messages(user("Prompt"), assistant("partial", "length")))).toBeNull();
    expect(lastPiTurn(messages(user("Prompt"), assistant("")))).toBeNull();
  });
});

describe("Pi lifecycle", () => {
  it("is inert in a project without initialized memory", async () => {
    const root = tmp();
    const events = handlers();
    expect(await events.before_agent_start!({ prompt: "Deploy?" }, ctx(root))).toBeUndefined();
    expect(await events.context!({ messages: messages(user("Deploy?")) }, ctx(root))).toBeUndefined();
    await events.agent_end!({ messages: messages(user("Deploy?"), assistant("Yes")) }, ctx(root));
    expect(runHook).not.toHaveBeenCalled();
  });

  it("is inert without project opt-in even when JEVMEM.md exists, or when explicitly disabled", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "JEVMEM.md"), "project memory\n");
    const events = handlers();
    const notices: { message: string; type: string | undefined }[] = [];
    await events.before_agent_start!({ prompt: "Use Postgres" }, ctx(root, [], notices));
    await events.context!({ messages: messages(user("Use Postgres")) }, ctx(root, [], notices));
    await events.agent_end!({ messages: messages(user("Use Postgres"), assistant("Agreed")) }, ctx(root, [], notices));
    expect(runHook).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(fs.readdirSync(root)).toEqual(["JEVMEM.md"]);

    init({ root, hooks: false });
    fs.writeFileSync(path.join(root, "jevmem.config.json"), JSON.stringify({ enabled: false }));
    await events.before_agent_start!({ prompt: "Use Postgres" }, ctx(root, [], notices));
    await events.agent_end!({ messages: messages(user("Use Postgres"), assistant("Agreed")) }, ctx(root, [], notices));
    expect(runHook).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("injects recall and captures completed turns using the Pi cwd", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const notices: { message: string; type: string | undefined }[] = [];
    const injection = "<jevmem-memory>\n- [decision] Use Postgres for the primary database (id:abc123, p=0.95)\n- [constraint] Require migrations (id:def456, p=0.70)\n</jevmem-memory>";
    vi.mocked(runHook).mockResolvedValueOnce({ event: "UserPromptSubmit", action: "injected", detail: "two", additionalContext: injection })
      .mockResolvedValueOnce({ event: "Stop", action: "saved", detail: "[decision] Use Postgres for the primary database id:abc123 via deterministic" });
    expect(await events.before_agent_start!({ prompt: "Which database?" }, ctx(root, [], notices))).toEqual({
      message: { customType: "jevmem-recall", content: injection, display: false },
    });
    await events.agent_end!({ messages: messages(user("Which database?"), assistant("Postgres")) }, ctx(root, messages(user("Use pnpm"), assistant("Okay"), user("Which database?"), assistant("Postgres")), notices));
    expect(await events.context!({ messages: messages(user("Which database?"), { role: "custom", customType: "jevmem-recall", content: injection }) }, ctx(root, [], notices))).toBeUndefined();
    expect(runHook).toHaveBeenNthCalledWith(1, { hook_event_name: "UserPromptSubmit", cwd: root, prompt: "Which database?" }, { root });
    expect(runHook).toHaveBeenNthCalledWith(2, { hook_event_name: "Stop", cwd: root, user_message: "Which database?", assistant_message: "Postgres", recent_context: "user: Use pnpm\nassistant: Okay" }, { root });
    expect(notices).toEqual([
      { message: "jevmem: recalled [decision] Use Postgres for the primary database (+1 more)", type: "info" },
      { message: "jevmem: saved [decision] Use Postgres for the primary database", type: "info" },
    ]);
  });

  it("reports no relevant memories, skipped captures, and failures without changing model context", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const notices: { message: string; type: string | undefined }[] = [];
    const context = ctx(root, [], notices);
    vi.mocked(runHook).mockResolvedValueOnce({ event: "UserPromptSubmit", action: "noop", detail: "no relevant memories (1 gated)" })
      .mockResolvedValueOnce({ event: "Stop", action: "skipped", detail: "chit-chat" })
      .mockResolvedValueOnce({ event: "UserPromptSubmit", action: "error", detail: "API timeout" })
      .mockResolvedValueOnce({ event: "Stop", action: "error", detail: "writer unavailable" });
    expect(await events.before_agent_start!({ prompt: "What changed?" }, context)).toBeUndefined();
    expect(await events.context!({ messages: messages(user("What changed?")) }, context)).toBeUndefined();
    await events.agent_end!({ messages: messages(user("Thanks"), assistant("You're welcome")) }, context);
    expect(await events.before_agent_start!({ prompt: "What changed?" }, context)).toBeUndefined();
    await events.agent_end!({ messages: messages(user("Use SQLite"), assistant("Okay")) }, context);
    expect(notices).toEqual([
      { message: "jevmem: no relevant memory for this prompt", type: "info" },
      { message: "jevmem: no memory saved — chit-chat", type: "info" },
      { message: "jevmem: recall failed — API timeout", type: "warning" },
      { message: "jevmem: capture failed — writer unavailable", type: "warning" },
    ]);
  });

  it("does not repeat an empty recall lookup for whitespace-bearing prompts", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const notices: { message: string; type: string | undefined }[] = [];
    const context = ctx(root, [], notices);
    vi.mocked(runHook).mockResolvedValue({ event: "UserPromptSubmit", action: "noop", detail: "no relevant memories" });
    expect(await events.before_agent_start!({ prompt: "  What changed?\n" }, context)).toBeUndefined();
    expect(await events.context!({ messages: messages(user("  What changed?\n")) }, context)).toBeUndefined();
    expect(runHook).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([{ message: "jevmem: no relevant memory for this prompt", type: "info" }]);
  });

  it("returns from agent_end while queued capture is still evaluating", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const notices: { message: string; type: string | undefined }[] = [];
    let finish!: (outcome: HookOutcome) => void;
    vi.mocked(runHook).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = events.agent_end!({ messages: messages(user("Use Postgres"), assistant("Agreed")) }, ctx(root, [], notices));
    expect(result).toBeUndefined();
    expect(runHook).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    finish({ event: "Stop", action: "queued", detail: "queued for retry: Jev failed (529)" });
    await vi.waitFor(() => expect(notices).toEqual([{ message: "jevmem: memory queued — queued for retry: Jev failed (529)", type: "info" }]), { timeout: 1000 });
  });

  it("warns once when the TypeSafe key is missing", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const notices: { message: string; type: string | undefined }[] = [];
    const context = ctx(root, [], notices);
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "noop", detail: "TYPESAFE_API_KEY not set (checked env)" });
    await events.before_agent_start!({ prompt: "Hello" }, context);
    await events.agent_end!({ messages: messages(user("Hello"), assistant("Hi")) }, context);
    expect(notices).toEqual([{ message: "jevmem: TYPESAFE_API_KEY missing; recall and capture disabled", type: "warning" }]);
  });

  it("recalls a queued user prompt once and re-injects it during its tool loop", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const notices: { message: string; type: string | undefined }[] = [];
    const context = ctx(root, [], notices);
    const queued = { ...user("How should we deploy?"), timestamp: 123 };
    const injection = "<jevmem-memory>\n- [decision] Use blue-green deployments (id:abc123, p=0.9)\n</jevmem-memory>";
    vi.mocked(runHook).mockResolvedValue({ event: "UserPromptSubmit", action: "injected", detail: "one", additionalContext: injection });
    const first = await events.context!({ messages: messages(user("Earlier"), assistant("Okay"), queued) }, context);
    expect(first.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user", "custom"]);
    expect(first.messages[3].content).toBe(injection);
    const next = await events.context!({ messages: messages(user("Earlier"), assistant("Okay"), queued, assistant("Checking", "toolUse")) }, context);
    expect(next.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user", "custom", "assistant"]);
    expect(runHook).toHaveBeenCalledTimes(1);
    expect(runHook).toHaveBeenCalledWith({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "How should we deploy?" }, { root });
    expect(notices).toEqual([{ message: "jevmem: recalled [decision] Use blue-green deployments", type: "info" }]);
  });

  it("recalls and captures batched queued prompts as one exchange", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const first = { ...user("Use Postgres"), timestamp: 123 };
    const second = { ...user("Use Redis for caching"), timestamp: 124 };
    const batch = messages(first, second);
    const injection = "<jevmem-memory>\n- [decision] Use Postgres and Redis (id:abc123, p=0.9)\n</jevmem-memory>";
    vi.mocked(runHook).mockResolvedValueOnce({ event: "UserPromptSubmit", action: "injected", detail: "one", additionalContext: injection })
      .mockResolvedValueOnce({ event: "Stop", action: "saved", detail: "[decision] Use Postgres and Redis id:abc123 via deterministic" });
    const recalled = await events.context!({ messages: batch }, ctx(root));
    expect(recalled.messages.map((message: { role: string }) => message.role)).toEqual(["user", "user", "custom"]);
    await events.agent_end!({ messages: messages(...batch, assistant("Configured both")) }, ctx(root, messages(...batch, assistant("Configured both"))));
    expect(runHook).toHaveBeenNthCalledWith(1, { hook_event_name: "UserPromptSubmit", cwd: root, prompt: "Use Postgres\nUse Redis for caching" }, { root });
    expect(runHook).toHaveBeenNthCalledWith(2, { hook_event_name: "Stop", cwd: root, user_message: "Use Postgres\nUse Redis for caching", assistant_message: "Configured both", recent_context: "" }, { root });
  });

  it("does not capture provisional tool output when steering is followed by an abort", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const interrupted = messages(user("Why is login failing?"), assistant("It might be the cache key", "toolUse"), user("Check token expiry too"), assistant("Partial", "aborted"));
    await events.agent_end!({ messages: interrupted }, ctx(root, interrupted));
    expect(runHook).not.toHaveBeenCalled();
  });

  it("captures a steered tool loop as one completed exchange", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const steered = messages(user("Why is login failing?"), assistant("Checking the cache key", "toolUse"), user("Check token expiry too"), assistant("The cache key caused it"));
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "skipped", detail: "already recorded" });
    await events.agent_end!({ messages: steered }, ctx(root, steered));
    expect(runHook).toHaveBeenCalledTimes(1);
    expect(runHook).toHaveBeenCalledWith({ hook_event_name: "Stop", cwd: root, user_message: "Why is login failing?\nCheck token expiry too", assistant_message: "Checking the cache key\nThe cache key caused it", recent_context: "" }, { root });
  });

  it("captures each queued exchange even if a later exchange aborts", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const first = messages(user("Use Postgres"), assistant("Agreed"), user("Thanks"), assistant("You're welcome"));
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "skipped", detail: "no new memory" });
    await events.agent_end!({ messages: first }, ctx(root, messages(user("Earlier"), assistant("Okay"), ...first)));
    expect(runHook).toHaveBeenCalledTimes(2);
    expect(runHook).toHaveBeenNthCalledWith(1, { hook_event_name: "Stop", cwd: root, user_message: "Use Postgres", assistant_message: "Agreed", recent_context: "user: Earlier\nassistant: Okay" }, { root });
    expect(runHook).toHaveBeenNthCalledWith(2, { hook_event_name: "Stop", cwd: root, user_message: "Thanks", assistant_message: "You're welcome", recent_context: "user: Use Postgres\nassistant: Agreed" }, { root });

    vi.mocked(runHook).mockClear();
    const aborted = messages(user("Use SQLite"), assistant("Agreed"), user("Deploy?"), assistant("Partial", "aborted"));
    await events.agent_end!({ messages: aborted }, ctx(root, aborted));
    expect(runHook).toHaveBeenCalledTimes(1);
    expect(runHook).toHaveBeenCalledWith({ hook_event_name: "Stop", cwd: root, user_message: "Use SQLite", assistant_message: "Agreed", recent_context: "" }, { root });
  });

  it("recovers the user prompt when a successful retry emits only an assistant reply", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const reply = assistant("The root cause is a shared cache key");
    const branch = messages(user("Earlier"), assistant("Okay"), user("Why is this failing?"), assistant("Network error", "error"), reply);
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "saved", detail: "[bug] Shared cache key id:abc123 via deterministic" });
    await events.agent_end!({ messages: messages(reply) }, ctx(root, branch));
    expect(runHook).toHaveBeenCalledWith({ hook_event_name: "Stop", cwd: root, user_message: "Why is this failing?", assistant_message: "The root cause is a shared cache key", recent_context: "user: Earlier\nassistant: Okay" }, { root });
  });

  it("recovers every queued prompt when an API error is followed by an assistant-only retry", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const reply = assistant("Configured both");
    const branch = messages(user("Earlier"), assistant("Okay"), user("Use Postgres"), user("Use Redis for caching"), assistant("API unavailable", "error"), reply);
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "saved", detail: "[decision] Use Postgres and Redis id:abc123 via deterministic" });
    await events.agent_end!({ messages: messages(reply) }, ctx(root, branch));
    expect(runHook).toHaveBeenCalledWith({ hook_event_name: "Stop", cwd: root, user_message: "Use Postgres\nUse Redis for caching", assistant_message: "Configured both", recent_context: "user: Earlier\nassistant: Okay" }, { root });
  });

  it("recovers the original prompt when an error is followed by queued steering", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const queued = user("Also use Redis");
    const reply = assistant("Configured both");
    const branch = messages(user("Use Postgres"), assistant("API unavailable", "error"), queued, reply);
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "skipped", detail: "already recorded" });
    await events.agent_end!({ messages: messages(queued, reply) }, ctx(root, branch));
    expect(runHook).toHaveBeenCalledWith({ hook_event_name: "Stop", cwd: root, user_message: "Use Postgres\nAlso use Redis", assistant_message: "Configured both", recent_context: "" }, { root });
  });

  it("does not carry aborted or explicitly restarted prompts into a retry", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const reply = assistant("Configured Postgres");
    const abandoned = messages(user("Use MySQL"), assistant("Cancelled", "aborted"), user("Use Postgres"), assistant("API unavailable", "error"), reply);
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "skipped", detail: "already recorded" });
    await events.agent_end!({ messages: messages(reply) }, ctx(root, abandoned));
    expect(runHook).toHaveBeenCalledWith({ hook_event_name: "Stop", cwd: root, user_message: "Use Postgres", assistant_message: "Configured Postgres", recent_context: "user: Use MySQL\nassistant: Cancelled" }, { root });

    vi.mocked(runHook).mockClear();
    const restarted = messages(user("Use Postgres"), assistant("API unavailable", "error"), user("Use SQLite"), assistant("Configured SQLite"));
    await events.before_agent_start!({ prompt: "Use SQLite" }, ctx(root));
    await events.agent_end!({ messages: messages(...restarted.slice(2)) }, ctx(root, restarted));
    expect(runHook).toHaveBeenCalledTimes(2);
    expect(runHook).toHaveBeenLastCalledWith({ hook_event_name: "Stop", cwd: root, user_message: "Use SQLite", assistant_message: "Configured SQLite", recent_context: "user: Use Postgres\nassistant: API unavailable" }, { root });
  });

  it("keeps an explicit prompt boundary across its assistant-only retry", async () => {
    const root = tmp();
    init({ root, hooks: false });
    const events = handlers();
    const previous = messages(user("Use MySQL"), assistant("Retries exhausted", "error"));
    const current = user("Use Postgres");
    const failed = assistant("Temporary API error", "error");
    const reply = assistant("Configured Postgres");
    vi.mocked(runHook).mockResolvedValue({ event: "Stop", action: "skipped", detail: "already recorded" });
    await events.before_agent_start!({ prompt: "Use Postgres" }, ctx(root, previous));
    await events.agent_end!({ messages: messages(current, failed) }, ctx(root, messages(...previous, current, failed)));
    await events.agent_end!({ messages: messages(reply) }, ctx(root, messages(...previous, current, failed, reply)));
    const captures = vi.mocked(runHook).mock.calls.map(([input]) => input).filter((input) => input.hook_event_name === "Stop");
    expect(captures).toEqual([{ hook_event_name: "Stop", cwd: root, user_message: "Use Postgres", assistant_message: "Configured Postgres", recent_context: "user: Use MySQL\nassistant: Retries exhausted" }]);
  });

  it("does not evaluate an aborted agent run", async () => {
    const root = tmp();
    init({ root, hooks: false });
    await handlers().agent_end!({ messages: messages(user("Decision"), assistant("Partial", "aborted")) }, ctx(root));
    expect(runHook).not.toHaveBeenCalled();
  });
});
