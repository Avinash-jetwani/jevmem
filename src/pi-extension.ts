import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { runHook } from "./hook.js";
import { MemoryStore } from "./store.js";

type PiMessage = AgentEndEvent["messages"][number];

/**
 * Select the latest completed user/assistant exchange from one Pi agent run.
 * Tool results and injected context are deliberately excluded from the text sent to Jev.
 */
export function lastPiTurn(messages: AgentEndEvent["messages"]): { user: string; assistant: string; previous: string } | null {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUser = i;
  if (lastUser < 0) return null;

  const text = (message: PiMessage): string => {
    if (message.role !== "user" && message.role !== "assistant") return "";
    const content = message.content;
    if (typeof content === "string") return content.trim();
    return content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  };
  const finalAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!finalAssistant || finalAssistant.stopReason === "error" || finalAssistant.stopReason === "aborted") return null;

  const user = text(messages[lastUser]!);
  const assistant = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "assistant")
    .map(text)
    .filter(Boolean)
    .join("\n");
  if (!user || !assistant) return null;

  const previous = messages
    .slice(0, lastUser)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-2)
    .map((message) => `${message.role}: ${text(message).slice(0, 400)}`)
    .join("\n");
  return { user, assistant, previous };
}

function initialized(root: string): boolean {
  return new MemoryStore(root, loadConfig(root).memoryFile).exists();
}

/**
 * Register automatic recall and capture for projects initialized with jevmem.
 * Pi's event messages are adapted to the existing Claude hook decision pipeline.
 */
export default function jevmemExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!initialized(ctx.cwd) || !event.prompt.trim()) return;
    const outcome = await runHook({ hook_event_name: "UserPromptSubmit", cwd: ctx.cwd, prompt: event.prompt }, { root: ctx.cwd });
    if (!outcome.additionalContext) return;
    return { message: { customType: "jevmem-recall", content: outcome.additionalContext, display: false } };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!initialized(ctx.cwd)) return;
    const turn = lastPiTurn(event.messages);
    if (!turn) return;
    const branchMessages = ctx.sessionManager.getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    const branchTurn = lastPiTurn(branchMessages);
    const previous = branchTurn?.user === turn.user && branchTurn.assistant === turn.assistant ? branchTurn.previous : turn.previous;
    await runHook({ hook_event_name: "Stop", cwd: ctx.cwd, user_message: turn.user, assistant_message: turn.assistant, recent_context: previous }, { root: ctx.cwd });
  });
}
