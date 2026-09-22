import fs from "node:fs";

/** Extract the last user prompt and the assistant text that followed it from a Claude Code transcript (JSONL). */
export function lastTurnFromTranscript(transcriptPath: string): { user: string; assistant: string; previous: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry?.type === "user" ? "user" : entry?.type === "assistant" ? "assistant" : null;
    if (!role) continue;
    const text = textOf(entry.message?.content);
    if (!text) continue;
    if (role === "user" && (entry.isMeta || /^<(?:command|local-command|system-reminder)/.test(text))) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += "\n" + text;
    else turns.push({ role, text });
  }
  let ui = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === "user") {
      ui = i;
      break;
    }
  }
  if (ui < 0) return null;
  const user = turns[ui]!.text;
  const assistant = turns
    .slice(ui + 1)
    .filter((t) => t.role === "assistant")
    .map((t) => t.text)
    .join("\n");
  const previous = turns
    .slice(Math.max(0, ui - 4), ui)
    .map((t) => `${t.role}: ${t.text.slice(0, 500)}`)
    .join("\n");
  return { user, assistant, previous };
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
