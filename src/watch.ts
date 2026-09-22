/**
 * `jevmem watch`: capture turns from tools that have no per-turn hook.
 * Codex CLI/IDE writes JSONL rollouts under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl with a `session_meta`
 * (cwd) and `response_item` messages; assistant messages with `phase: "final_answer"` end a turn.
 * Cursor stores chats in a SQLite database (state.vscdb), not a text log, so it is not watched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WatchedTurn {
  user: string;
  assistant: string;
  previous: string;
  file: string;
}

export function codexSessionsDir(home = os.homedir()): string {
  return path.join(home, ".codex", "sessions");
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 4) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Rollout files modified within `sinceMs` whose session or turn cwd is this project. */
export function findCodexRollouts(root: string, sessionsDir = codexSessionsDir(), sinceMs = 24 * 3600_000): string[] {
  const files: string[] = [];
  walk(sessionsDir, files);
  const now = Date.now();
  const want = real(root);
  return files.filter((f) => {
    try {
      if (now - fs.statSync(f).mtimeMs > sinceMs) return false;
      const head = fs.readFileSync(f, "utf8").split("\n").slice(0, 40);
      return head.some((l) => {
        if (!l.includes('"cwd"')) return false;
        try {
          const j = JSON.parse(l);
          const cwd = j?.payload?.cwd;
          return typeof cwd === "string" && real(cwd) === want;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  });
}

interface Pending {
  user: string;
  assistant: string;
  history: { role: string; text: string }[];
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((c: any) => (c && (c.type === "input_text" || c.type === "output_text" || c.type === "text") && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Parse rollout lines into completed turns. `pending` carries partial state between polls. */
export function parseRolloutLines(lines: string[], pending: Pending, file: string): WatchedTurn[] {
  const turns: WatchedTurn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== "response_item" || j.payload?.type !== "message") continue;
    const role = j.payload.role;
    const text = textOf(j.payload.content);
    if (!text) continue;
    if (role === "user") {
      if (/^<environment_context>|^<turn_aborted>|^# Context from my IDE setup/.test(text) && text.length < 200) continue;
      if (pending.assistant) {
        // A new user message after an assistant reply that never got a final_answer marker.
        pending.history.push({ role: "user", text: pending.user }, { role: "assistant", text: pending.assistant });
        pending.assistant = "";
      }
      pending.user = pending.user && !pending.assistant ? pending.user + "\n" + text : text;
    } else if (role === "assistant") {
      pending.assistant = pending.assistant ? pending.assistant + "\n" + text : text;
      if (j.payload.phase === "final_answer" || j.payload.phase === undefined) {
        const previous = pending.history.slice(-2).map((h) => `${h.role}: ${h.text.slice(0, 400)}`).join("\n");
        turns.push({ user: pending.user, assistant: pending.assistant, previous, file });
        pending.history.push({ role: "user", text: pending.user }, { role: "assistant", text: pending.assistant });
        pending.user = "";
        pending.assistant = "";
      }
    }
  }
  return turns;
}

export interface WatchOptions {
  sessionsDir?: string;
  intervalMs?: number;
  /** Process what is already on disk from the last `sinceMs`, then keep tailing. Default: only new content. */
  replay?: boolean;
  once?: boolean;
  onTurn: (turn: WatchedTurn) => Promise<void> | void;
  onInfo?: (msg: string) => void;
  signal?: AbortSignal;
}

/** Tail Codex rollouts for this project and call `onTurn` for every completed turn. Resolves when aborted (or after one pass with `once`). */
export async function watchCodex(root: string, opts: WatchOptions): Promise<{ files: number; turns: number }> {
  const sessionsDir = opts.sessionsDir ?? codexSessionsDir();
  const offsets = new Map<string, number>();
  const pendings = new Map<string, Pending>();
  let turns = 0;
  const pass = async () => {
    const files = findCodexRollouts(root, sessionsDir);
    for (const f of files) {
      let start = offsets.get(f);
      if (start === undefined) {
        start = opts.replay ? 0 : fs.statSync(f).size;
        offsets.set(f, start);
        opts.onInfo?.(`watching ${path.basename(f)}`);
        if (!opts.replay) continue;
      }
      const size = fs.statSync(f).size;
      if (size <= start) continue;
      const fd = fs.openSync(f, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      offsets.set(f, size);
      const pending = pendings.get(f) ?? { user: "", assistant: "", history: [] };
      pendings.set(f, pending);
      for (const t of parseRolloutLines(buf.toString("utf8").split("\n"), pending, f)) {
        turns++;
        await opts.onTurn(t);
      }
    }
    return files.length;
  };
  let files = await pass();
  if (opts.once) return { files, turns };
  while (!opts.signal?.aborted) {
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
    files = await pass();
  }
  return { files, turns };
}
