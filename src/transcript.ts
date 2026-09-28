import fs from "node:fs";

/**
 * One turn of a Claude Code session: a prompt the user typed and everything the main agent wrote in answer to it, until
 * the user's next prompt (v0.6 part 3b).
 *
 * Not every `user` entry of a transcript is the user. Tool results are not; nor are a background task's report, which
 * Claude Code writes as a `user` entry that starts with `<task-notification>` (and marks with `origin.kind`
 * "task-notification" and `promptSource` "system" since 2.1.2xx), commands, system reminders and meta entries. A task
 * notification does not start a turn: it wakes the main agent up inside the turn that launched the task.
 *
 * A background subagent's launch is a tool result with `toolUseResult.isAsync` (text "Async agent launched
 * successfully… agentId: <id>"); its report is the notification naming that id (`<task-id>`) or the Agent call
 * (`<tool-use-id>`). While a subagent launched in a turn has not reported back, the turn is still running: the main agent
 * stops and Claude Code runs the `Stop` hooks, but the turn goes on when the report arrives.
 */
export interface TranscriptTurn {
  /** The uuid of the entry that starts the turn (the user's prompt); null in a transcript without uuids. */
  id: string | null;
  user: string;
  /** The main agent's text in the turn, in order. */
  assistant: string;
  /** The two blocks (user, assistant) before the turn, 400 characters each at most. */
  previous: string;
  /** Background subagents launched in this turn that have not reported back yet (agent ids, else tool-use ids). */
  waiting: string[];
  /** A later prompt follows this turn in the transcript: it is over, whatever it still waits for. */
  closed: boolean;
}

interface Building {
  id: string | null;
  user: string;
  assistant: string[];
  launched: { agent: string | null; tool: string | null }[];
  reported: Set<string>;
}

const notificationIds = (text: string): string[] => [...text.matchAll(/<(?:task-id|tool-use-id)>\s*([^<\s]+)\s*<\//g)].map((m) => m[1]!);

/** An automated entry written as `user`: a task notification (or another event Claude Code marks with an origin). */
function isAutomated(entry: any, text: string): boolean {
  if (/^<task-notification>/.test(text)) return true;
  if (entry?.promptSource === "system" || entry?.turnOrigin === "task_notification") return true;
  const kind = entry?.origin?.kind;
  return typeof kind === "string" && kind !== "user" && kind !== "human";
}

/** A background subagent launched by this tool-result entry, if any: its agent id and the Agent call's tool-use id. */
function asyncLaunch(entry: any): { agent: string | null; tool: string | null } | null {
  const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const result = content.find((c: any) => c?.type === "tool_result");
  if (!result) return null;
  const r = entry.toolUseResult;
  const text = typeof result.content === "string" ? result.content : Array.isArray(result.content) ? result.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "";
  const launched = (r && typeof r === "object" && (r.isAsync === true || r.status === "async_launched")) || /^Async agent launched successfully/.test(text.trim());
  if (!launched) return null;
  const agent = typeof r?.agentId === "string" ? r.agentId : (/agentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null);
  return { agent, tool: typeof result.tool_use_id === "string" ? result.tool_use_id : null };
}

/**
 * Every turn of a transcript, oldest first. `lastAssistantMessage` is the Stop payload's `last_assistant_message`: when
 * a `Stop` hook runs, Claude Code has not yet written the main agent's final text to the transcript, so it is added to
 * the last turn unless the turn already ends with it.
 */
export function readTranscriptTurns(transcriptPath: string, opts: { lastAssistantMessage?: string } = {}): TranscriptTurn[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const turns: Building[] = [];
  // Assistant text before the first prompt (a resumed or compacted session) only counts as context.
  const preamble: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain === true) continue;
    const cur = turns[turns.length - 1];
    if (entry?.type === "assistant") {
      const text = textOf(entry.message?.content);
      if (!text) continue;
      if (cur) cur.assistant.push(text);
      else preamble.push(text);
      continue;
    }
    if (entry?.type !== "user") continue;
    const launch = asyncLaunch(entry);
    if (launch) {
      cur?.launched.push(launch);
      continue;
    }
    const text = textOf(entry.message?.content);
    if (!text) continue;
    if (isAutomated(entry, text)) {
      for (const id of notificationIds(text)) cur?.reported.add(id);
      continue;
    }
    if (entry.isMeta || /^<(?:command|local-command|system-reminder)/.test(text) || /^\[Request interrupted by user/.test(text)) continue;
    // Two prompts with nothing from the assistant between them are one turn, as before.
    if (cur && cur.assistant.length === 0 && cur.launched.length === 0) {
      cur.user += "\n" + text;
      continue;
    }
    turns.push({ id: typeof entry.uuid === "string" ? entry.uuid : null, user: text, assistant: [], launched: [], reported: new Set() });
  }
  if (!turns.length) return null;
  const last = turns[turns.length - 1]!;
  const final = opts.lastAssistantMessage?.trim();
  if (final && squash(last.assistant[last.assistant.length - 1] ?? "") !== squash(final)) last.assistant.push(final);
  return turns.map((t, i) => {
    const before: string[] = [];
    if (i === 0) {
      if (preamble.length) before.push(`assistant: ${preamble.join("\n").slice(0, 400)}`);
    } else {
      const p = turns[i - 1]!;
      before.push(`user: ${p.user.slice(0, 400)}`);
      if (p.assistant.length) before.push(`assistant: ${p.assistant.join("\n").slice(0, 400)}`);
    }
    return {
      id: t.id,
      user: t.user,
      assistant: t.assistant.join("\n"),
      // Only the two blocks before this turn: Jev accuracy falls as unrelated context grows.
      previous: before.slice(-2).join("\n"),
      waiting: t.launched.filter((l) => !(l.agent && t.reported.has(l.agent)) && !(l.tool && t.reported.has(l.tool))).map((l) => l.agent ?? l.tool ?? "unknown"),
      closed: i < turns.length - 1,
    };
  });
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The last prompt the user typed and the assistant text that followed it, from a Claude Code transcript (JSONL). */
export function lastTurnFromTranscript(transcriptPath: string, opts: { lastAssistantMessage?: string } = {}): { user: string; assistant: string; previous: string } | null {
  const t = readTranscriptTurns(transcriptPath, opts)?.at(-1);
  return t ? { user: t.user, assistant: t.assistant, previous: t.previous } : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (c && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Merge a turn into the single string Jev evaluates. */
export function mergeTurn(user: string, assistant: string): string {
  const parts: string[] = [];
  if (user) parts.push(`USER: ${user.trim()}`);
  if (assistant) parts.push(`ASSISTANT: ${assistant.trim()}`);
  return parts.join("\n\n");
}
