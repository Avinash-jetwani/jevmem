import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { runHook, type HookOutcome } from "./hook.js";
import { MemoryStore } from "./store.js";

type PiMessage = AgentEndEvent["messages"][number];
type PiTurn = { user: string; assistant: string; previous: string };

function textOf(message: PiMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}

function lastUserIndex(messages: PiMessage[], match?: PiMessage): number {
  if (match) {
    const sameMessage = messages.lastIndexOf(match);
    if (sameMessage >= 0) return sameMessage;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (!match || (message.timestamp === match.timestamp && textOf(message) === textOf(match))) return i;
  }
  return -1;
}

function completedPiTurns(messages: PiMessage[], prior: PiMessage[] = []): PiTurn[] {
  const turns: PiTurn[] = [];
  const history = prior.filter((message) => message.role === "user" || message.role === "assistant");
  let users: string[] = [];
  let previous = "";
  let replies: string[] = [];
  let completed = false;
  const finish = () => {
    if (!completed || users.length === 0 || replies.length === 0) return;
    turns.push({ user: users.join("\n"), assistant: replies.join("\n"), previous });
  };

  for (const message of messages) {
    if (message.role === "user") {
      if (completed) {
        finish();
        users = [];
        replies = [];
      }
      if (users.length === 0) previous = history.slice(-2).map((entry) => `${entry.role}: ${textOf(entry).slice(0, 400)}`).join("\n");
      const text = textOf(message);
      if (text) users.push(text);
      completed = false;
    } else if (message.role === "assistant" && users.length > 0) {
      const text = textOf(message);
      if (text) replies.push(text);
      completed = message.stopReason === "stop";
    }
    if (message.role === "user" || message.role === "assistant") history.push(message);
  }
  finish();
  return turns;
}

/**
 * Select the latest completed user/assistant exchange from one Pi agent run.
 * Tool results and injected context are deliberately excluded from the text sent to Jev.
 */
export function lastPiTurn(messages: AgentEndEvent["messages"]): PiTurn | null {
  return completedPiTurns(messages).at(-1) ?? null;
}

// Retry events can omit the user messages; restore only the unfinished exchange.
function unfinishedPrefix(branch: PiMessage[], lastUser: number, boundary: number): { messages: PiMessage[]; prior: PiMessage[] } {
  let start = lastUser;
  for (let i = lastUser - 1; i >= Math.max(0, boundary); i--) {
    const message = branch[i];
    if (message?.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "aborted")) break;
    if (message?.role === "user") start = i;
  }
  return {
    messages: branch.slice(start, lastUser + 1).filter((message) => message.role === "user" || (message.role === "assistant" && message.stopReason === "toolUse")),
    prior: branch.slice(0, start),
  };
}

function turnsForRun(messages: PiMessage[], branch: PiMessage[], startedPrompt: boolean, boundary: number): PiTurn[] {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) {
    const index = lastUserIndex(branch);
    if (index < 0) return [];
    const prefix = unfinishedPrefix(branch, index, boundary);
    return completedPiTurns([...prefix.messages, ...messages], prefix.prior);
  }

  const index = lastUserIndex(branch, messages[firstUser]);
  if (firstUser === 0 && !startedPrompt && index > 0) {
    const precedingUser = lastUserIndex(branch.slice(0, index));
    if (precedingUser >= 0 && branch.slice(precedingUser + 1, index).some((message) => message.role === "assistant" && message.stopReason === "error")) {
      const prefix = unfinishedPrefix(branch, precedingUser, boundary);
      return completedPiTurns([...prefix.messages, ...messages], prefix.prior);
    }
  }
  if (firstUser > 0 && messages.slice(0, firstUser).some((message) => message.role === "assistant") && index > 0) {
    const precedingUser = lastUserIndex(branch.slice(0, index));
    if (precedingUser >= 0) {
      const prefix = unfinishedPrefix(branch, precedingUser, boundary);
      return completedPiTurns([...prefix.messages, ...messages], prefix.prior);
    }
  }
  return completedPiTurns(messages, index < 0 ? [] : branch.slice(0, index));
}

function initialized(root: string): boolean {
  return new MemoryStore(root, loadConfig(root).memoryFile).exists();
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

function recallNotice(context: string): string {
  const lines = context.split("\n").filter((line) => line.startsWith("- ["));
  const first = lines[0]?.slice(2).replace(/ \(id:[^)]*\)$/, "");
  if (!first) return "jevmem: recalled relevant project memory";
  return `jevmem: recalled ${preview(first)}${lines.length > 1 ? ` (+${lines.length - 1} more)` : ""}`;
}

/**
 * Register automatic recall and capture for projects initialized with jevmem.
 * Pi's event messages are adapted to the existing Claude hook decision pipeline.
 */
export default function jevmemExtension(pi: ExtensionAPI): void {
  let missingKeyNotified = false;
  const notifyMissingKey = (outcome: HookOutcome, ctx: ExtensionContext): void => {
    if (missingKeyNotified || outcome.action !== "noop" || !outcome.detail.startsWith("TYPESAFE_API_KEY not set")) return;
    missingKeyNotified = true;
    ctx.ui.notify("jevmem: TYPESAFE_API_KEY missing; recall and capture disabled", "warning");
  };

  let queuedRecall: { key: string; context: string | undefined } | undefined;
  let promptWithoutRecall: string | undefined;
  // Explicit prompts fire before_agent_start; queued prompts and retries do not.
  let startedPrompt = false;
  let activePrompt: PiMessage | undefined;
  pi.on("session_start", () => {
    queuedRecall = undefined;
    promptWithoutRecall = undefined;
    startedPrompt = false;
    activePrompt = undefined;
    missingKeyNotified = false;
  });
  pi.on("session_tree", () => { queuedRecall = undefined; promptWithoutRecall = undefined; startedPrompt = false; activePrompt = undefined; });

  const recall = async (prompt: string, ctx: ExtensionContext): Promise<string | undefined> => {
    const outcome = await runHook({ hook_event_name: "UserPromptSubmit", cwd: ctx.cwd, prompt }, { root: ctx.cwd });
    notifyMissingKey(outcome, ctx);
    if (outcome.action === "error") ctx.ui.notify(`jevmem: recall failed — ${preview(outcome.detail)}`, "warning");
    if (outcome.action === "noop" && outcome.detail === "no relevant memories") ctx.ui.notify("jevmem: no relevant memory for this prompt", "info");
    if (outcome.additionalContext) ctx.ui.notify(recallNotice(outcome.additionalContext), "info");
    return outcome.additionalContext;
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (!initialized(ctx.cwd) || !event.prompt.trim()) return;
    const prompt = event.prompt.trim();
    startedPrompt = true;
    const context = await recall(prompt, ctx);
    promptWithoutRecall = context ? undefined : prompt;
    if (!context) return;
    return { message: { customType: "jevmem-recall", content: context, display: false } };
  });

  // Queued steering and follow-ups skip before_agent_start. Transform only the current
  // provider request; cache its lookup because context runs again after tool calls.
  pi.on("context", async (event, ctx) => {
    if (!initialized(ctx.cwd)) return;
    const index = lastUserIndex(event.messages);
    if (index < 0) return;
    let first = index;
    while (first > 0 && event.messages[first - 1]?.role === "user") first--;
    const user = event.messages[index]!;
    const prompt = event.messages.slice(first, index + 1).map(textOf).filter(Boolean).join("\n");
    const following = event.messages.slice(index + 1);
    if (following.some((message) => message.role === "custom" && message.customType === "jevmem-recall")) return;
    const key = `${ctx.cwd}:${event.messages[first]!.timestamp}:${user.timestamp}:${prompt}`;
    if (queuedRecall?.key !== key) {
      if (following.some((message) => message.role === "assistant") || !prompt) return;
      const context = promptWithoutRecall === prompt ? undefined : await recall(prompt, ctx);
      promptWithoutRecall = undefined;
      queuedRecall = { key, context };
    }
    if (!queuedRecall.context) return;
    const injected: PiMessage = { role: "custom", customType: "jevmem-recall", content: queuedRecall.context, display: false, timestamp: Date.now() };
    return { messages: [...event.messages.slice(0, index + 1), injected, ...following] };
  });

  pi.on("agent_end", async (event, ctx) => {
    const startedHere = startedPrompt;
    startedPrompt = false;
    if (!initialized(ctx.cwd)) return;
    const branch = ctx.sessionManager.getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    if (startedHere) activePrompt = event.messages.find((message) => message.role === "user");
    const boundary = activePrompt ? lastUserIndex(branch, activePrompt) : -1;
    const finalAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (finalAssistant?.role === "assistant" && (finalAssistant.stopReason === "stop" || finalAssistant.stopReason === "aborted")) activePrompt = undefined;
    for (const turn of turnsForRun(event.messages, branch, startedHere, boundary)) {
      const outcome = await runHook({ hook_event_name: "Stop", cwd: ctx.cwd, user_message: turn.user, assistant_message: turn.assistant, recent_context: turn.previous }, { root: ctx.cwd });
      notifyMissingKey(outcome, ctx);
      if (outcome.action === "saved") {
        const saved = outcome.detail.replace(/ id:[a-z0-9]+/, "").replace(/ via \S+$/, "");
        ctx.ui.notify(`jevmem: saved ${preview(saved)}`, "info");
      } else if (outcome.action === "skipped") ctx.ui.notify(`jevmem: no memory saved — ${preview(outcome.detail)}`, "info");
      else if (outcome.action === "error") ctx.ui.notify(`jevmem: capture failed — ${preview(outcome.detail)}`, "warning");
    }
  });
}
