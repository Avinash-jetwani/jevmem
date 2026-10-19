/**
 * Automatic saving in Cursor (0.7.4). Cursor runs a project's `.cursor/hooks.json` hooks, in the app and in its
 * `agent` CLI, with a JSON payload on stdin and the project root as the working directory. jevmem's entries run a
 * launcher copied into the project (`.cursor/hooks/jevmem-hook.sh`, relative commands, no path of one computer, so both
 * files can be committed), which runs `jevmem hook --cursor`. What each event does, measured on Cursor 3.24.18 and the
 * CLI 2026.08.11 to 2026.10.16 (the probe in .reports/release-0.7.4.md):
 *
 * - `beforeSubmitPrompt` (the app; the CLI does not fire it): the prompt and the turn's `generation_id` go to a stash,
 *   `.jevmem/cursor/<conversation_id>.json`; the hook answers `{"continue": true}`.
 * - `afterAgentResponse` (the app, once per turn with the final message's text): appended to the stash.
 * - `stop` with `status: completed` (the app): the turn is read from the transcript Cursor names in `transcript_path`,
 *   a JSONL of the whole conversation (one line per message: the user's text wrapped in `<timestamp>` and `<user_query>`,
 *   the assistant's text and `tool_use` blocks, a `turn_ended` line when a turn finishes; a resumed chat's file keeps
 *   only the last `turn_ended`, so a turn is also closed by the next user line; a user line Cursor wrote itself after a
 *   background task continues the turn), or, when there is no transcript, from
 *   the stash; then the same queue, decide and write as Claude Code's Stop hook. `aborted` and `error` decide nothing.
 * - `sessionEnd` with `reason: completed`: the transcript's last finished turn, when it is not decided yet. This is how
 *   the CLI's runs end (one turn each); in the app it adds nothing after `stop`.
 * - `sessionStart`: the always-on lines as `additional_context`, through the same gate as Claude Code's SessionStart.
 *
 * A turn is marked decided by conversation id and turn number (src/turns.ts), so a second hook for the same turn does
 * nothing. Recall stays over MCP: `beforeSubmitPrompt` has no field for context.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { isJevmemHookCommand } from "./config.js";
import { isDecided } from "./turns.js";

export const CURSOR_HOOK_EVENTS = ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"] as const;
export type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number];
/** Seconds, per Cursor's `timeout` field: the synchronous hooks write a file; stop and sessionEnd hand off and exit. */
const TIMEOUTS: Record<CursorHookEvent, number> = { sessionStart: 5, beforeSubmitPrompt: 5, afterAgentResponse: 5, stop: 20, sessionEnd: 20 };
export const CURSOR_HOOKS_FILE = path.join(".cursor", "hooks.json");
export const CURSOR_LAUNCHER_FILE = path.join(".cursor", "hooks", "jevmem-hook.sh");
/** The command in `.cursor/hooks.json`: relative to the project root, which is where Cursor runs project hooks. */
export const cursorHookCommand = (event: CursorHookEvent): string => `sh .cursor/hooks/jevmem-hook.sh ${event}`;
/** The stash of a turn in progress, one file per conversation, under the gitignored `.jevmem/`. */
export const CURSOR_STASH_DIR = path.join(".jevmem", "cursor");
const STASH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CursorTurn {
  /** 1-based, in transcript order. */
  index: number;
  user: string;
  assistant: string;
  /** Closed by a `turn_ended` line or by a later user line; only the last turn of a file can be open. */
  ended: boolean;
  status: string | null;
  /** 0.7.6 (fix d): the turn's user line is Cursor's own follow-up and no person's turn came before it: not decided. */
  automatic?: boolean;
}

/**
 * A user line Cursor wrote itself, not the person: after a background task ends, the CLI (2026.08.11 on) and the app
 * submit a follow-up ("Briefly inform the user about the task result and perform any follow-up actions…") whose
 * `<user_query>` holds the text on the tag's own line, where a typed prompt sits on its own lines inside the tag; a
 * hook payload carries it bare. Such a line and the assistant's answer to it belong to the turn before it, whether
 * that turn is still open (a held-out session, 0.7.4) or has ended (0.7.4's live check, fixed in 0.7.6, fix d).
 */
export function isCursorAutomaticPrompt(text: string): boolean {
  const t = String(text ?? "");
  return /<user_query>[^\n<]/.test(t) || /<user_query>\s*Briefly inform the user about the task result/.test(t) || /^\s*Briefly inform the user about the task result/.test(t);
}

/** The text Cursor's transcript keeps for a prompt: the prompt, wrapped in `<timestamp>` and `<user_query>`. */
export function stripCursorPrompt(text: string): string {
  let t = String(text ?? "").replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "");
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(t);
  if (m) t = m[1]!;
  return t.trim();
}

/** The turns of a Cursor transcript file; `[]` when the file is missing, and a broken line is skipped. */
export function readCursorTranscript(file: string): CursorTurn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const turns: CursorTurn[] = [];
  let cur: CursorTurn | null = null;
  const texts = (e: any): string[] => {
    const content = e?.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((c: any) => c && c.type === "text" && typeof c.text === "string" && c.text.trim()).map((c: any) => String(c.text).trim());
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.role === "user") {
      const raw = texts(e).join("\n\n");
      // Cursor's own follow-up line belongs to the turn before it, open or ended (its answer is appended; an ended
      // turn stays ended and decided); with no turn before it, it is a turn of its own that is never decided.
      const automatic = isCursorAutomaticPrompt(raw);
      if (cur && automatic) continue;
      if (cur) cur.ended = true;
      cur = { index: turns.length + 1, user: stripCursorPrompt(raw), assistant: "", ended: false, status: null, ...(automatic ? { automatic: true } : {}) };
      turns.push(cur);
    } else if (e?.role === "assistant" && cur) {
      const t = texts(e);
      if (t.length) cur.assistant = cur.assistant ? `${cur.assistant}\n\n${t.join("\n\n")}` : t.join("\n\n");
    } else if (e?.type === "turn_ended" && cur) {
      cur.ended = true;
      cur.status = typeof e.status === "string" ? e.status : null;
    }
  }
  return turns;
}

/** Is this payload Cursor's (its hooks carry `cursor_version` and Cursor's event names)? */
export function isCursorPayload(input: any): boolean {
  return Boolean(input && (typeof input.cursor_version === "string" || (CURSOR_HOOK_EVENTS as readonly string[]).includes(String(input.hook_event_name))));
}

// The stash.

interface Stash {
  generation_id: string | null;
  prompt: string;
  responses: string[];
  at: string;
}
const stashFile = (root: string, conversation: string) => path.join(root, CURSOR_STASH_DIR, `${conversation.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
function readStash(root: string, conversation: string): Stash | null {
  try {
    return JSON.parse(fs.readFileSync(stashFile(root, conversation), "utf8"));
  } catch {
    return null;
  }
}
function writeStash(root: string, conversation: string, s: Stash): void {
  const f = stashFile(root, conversation);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, f);
}
/** `beforeSubmitPrompt`: a new turn in this conversation (the earlier stash of it, if any, is replaced). */
export function stashPrompt(root: string, conversation: string, generation: string | null, prompt: string, now = new Date()): void {
  // Cursor's own follow-up line (fix d) is not a person's prompt: the stash of the turn it continues stays.
  if (isCursorAutomaticPrompt(prompt)) return;
  writeStash(root, conversation, { generation_id: generation, prompt, responses: [], at: now.toISOString() });
  cleanStashes(root, now);
}
/** `afterAgentResponse`: the text, kept with its turn's prompt (or alone when `beforeSubmitPrompt` was not seen). */
export function stashResponse(root: string, conversation: string, generation: string | null, text: string, now = new Date()): void {
  const cur = readStash(root, conversation);
  if (cur && (cur.generation_id === generation || !generation || !cur.generation_id)) {
    cur.responses.push(text);
    writeStash(root, conversation, cur);
  } else writeStash(root, conversation, { generation_id: generation, prompt: "", responses: [text], at: now.toISOString() });
}
/** The stash of a conversation, removed. */
export function takeStash(root: string, conversation: string): Stash | null {
  const s = readStash(root, conversation);
  dropStash(root, conversation);
  return s;
}
export function dropStash(root: string, conversation: string): void {
  try {
    fs.unlinkSync(stashFile(root, conversation));
  } catch {
    /* none */
  }
}
/** Stashes older than a day (a turn that never ended) are removed. */
export function cleanStashes(root: string, now = new Date()): void {
  const dir = path.join(root, CURSOR_STASH_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    try {
      const p = path.join(dir, f);
      if (now.getTime() - fs.statSync(p).mtimeMs > STASH_MAX_AGE_MS) fs.unlinkSync(p);
    } catch {
      /* gone */
    }
  }
}

/** What the stop (or sessionEnd) hook hands to decide: the turn's text, where it came from, and its id for `markDecided`. */
export interface CursorCapturedTurn {
  session: string;
  turn: string;
  user: string;
  assistant: string;
  previous: string;
  source: "cursor-transcript" | "cursor-stash";
}

/**
 * The finished turn a `stop` or `sessionEnd` payload refers to: the transcript's last turn when the file is there and
 * that turn is ended, else the stash (the prompt and the responses); null when there is nothing, when the last turn is
 * still open (an interrupted run), or when it was decided before. The `previous` context is the turn before it, as
 * Claude Code's transcript reader gives it (two blocks, 400 characters each).
 */
export function cursorTurnFromInput(root: string, input: any): { turn: CursorCapturedTurn | null; reason: string } {
  const session = String(input?.conversation_id ?? input?.session_id ?? "");
  if (!session) return { turn: null, reason: "no conversation id" };
  const file = typeof input?.transcript_path === "string" ? input.transcript_path : null;
  const turns = file ? readCursorTranscript(file) : [];
  if (turns.length) {
    const last = turns[turns.length - 1]!;
    const id = `t${last.index}`;
    if (!last.ended) return { turn: null, reason: `the transcript's last turn (${last.index}) is not ended` };
    if (last.automatic) {
      dropStash(root, session);
      return { turn: null, reason: `turn ${last.index} is Cursor's own follow-up line, not a person's turn: nothing decided` };
    }
    if (isDecided(root, session, id)) return { turn: null, reason: `turn ${last.index} already decided` };
    if (!last.user && !last.assistant) return { turn: null, reason: `turn ${last.index} is empty` };
    const prev = turns[turns.length - 2];
    const previous = prev ? [prev.user.slice(0, 400), prev.assistant.slice(0, 400)].filter(Boolean).join("\n") : "";
    dropStash(root, session);
    return { turn: { session, turn: id, user: last.user, assistant: last.assistant, previous, source: "cursor-transcript" }, reason: `transcript turn ${last.index}` };
  }
  const stash = takeStash(root, session);
  if (!stash || (!stash.prompt && !stash.responses.length)) return { turn: null, reason: file ? "the transcript has no turn and there is no stash" : "no transcript and no stash" };
  const id = `g:${stash.generation_id ?? stash.at}`;
  if (isDecided(root, session, id)) return { turn: null, reason: "the stashed turn was decided before" };
  return { turn: { session, turn: id, user: stash.prompt, assistant: stash.responses.join("\n\n"), previous: "", source: "cursor-stash" }, reason: "stash" };
}

// The jevmem plugin for Cursor (0.7.6).

/**
 * The marker the plugin's launcher writes on `sessionStart` (`--plugin`), once a day, in any project: its version and
 * the time. The one file the plugin keeps outside a project, and how `init` and `doctor` know it is installed on this
 * computer (Cursor records installs in its own state, not in a project). Null when the plugin never ran here.
 */
export const CURSOR_PLUGIN_MARKER = path.join(".jevmem", "cursor-plugin");
export function readCursorPluginMarker(home: string = os.homedir()): { version: string; seen: string } | null {
  try {
    const [version, seen] = fs.readFileSync(path.join(home, CURSOR_PLUGIN_MARKER), "utf8").split("\n");
    if (!version?.trim()) return null;
    return { version: version.trim(), seen: (seen ?? "").trim() };
  } catch {
    return null;
  }
}

// `jevmem init --tool cursor`: the hooks file and the launcher.

/** The launcher the package ships, which `init` copies into the project. */
export function cursorLauncherSource(): string {
  return fs.readFileSync(fileURLToPath(new URL("../hooks/jevmem-cursor-hook.sh", import.meta.url)), "utf8");
}

function readHooksFile(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write or merge jevmem's entries into `.cursor/hooks.json` and put the launcher at `.cursor/hooks/jevmem-hook.sh`.
 * Other hooks are kept; an entry whose command moved is repaired in place; running it twice changes nothing.
 */
export function registerCursorHooks(root: string): "added" | "updated" | "present" {
  const file = path.join(root, CURSOR_HOOKS_FILE);
  const hooks = readHooksFile(file) ?? { version: 1, hooks: {} };
  if (typeof hooks.version !== "number") hooks.version = 1;
  if (!hooks.hooks || typeof hooks.hooks !== "object" || Array.isArray(hooks.hooks)) hooks.hooks = {};
  let added = false;
  let updated = false;
  for (const ev of CURSOR_HOOK_EVENTS) {
    const cmd = cursorHookCommand(ev);
    const list: any[] = Array.isArray(hooks.hooks[ev]) ? hooks.hooks[ev] : (hooks.hooks[ev] = []);
    const mine = list.find((h) => isJevmemHookCommand(h));
    if (mine) {
      if (mine.command !== cmd) {
        mine.command = cmd;
        updated = true;
      }
      if (typeof mine.timeout !== "number") {
        mine.timeout = TIMEOUTS[ev];
        updated = true;
      }
    } else {
      list.push({ command: cmd, timeout: TIMEOUTS[ev] });
      added = true;
    }
  }
  if (added || updated) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(hooks, null, 2) + "\n");
  }
  const launcher = path.join(root, CURSOR_LAUNCHER_FILE);
  const source = cursorLauncherSource();
  let current: string | null = null;
  try {
    current = fs.readFileSync(launcher, "utf8");
  } catch {
    /* missing */
  }
  if (current !== source) {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, source);
    if (current === null) added = true;
    else updated = true;
  }
  try {
    fs.chmodSync(launcher, 0o755);
  } catch {
    /* Windows */
  }
  return added ? "added" : updated ? "updated" : "present";
}

/** `jevmem init --remove-hooks`: jevmem's entries out of `.cursor/hooks.json` (other hooks stay; a file left with nothing is deleted) and the launcher removed. The paths changed. */
export function unregisterCursorHooks(root: string): string[] {
  const changed: string[] = [];
  const file = path.join(root, CURSOR_HOOKS_FILE);
  const hooks = readHooksFile(file);
  if (hooks && hooks.hooks && typeof hooks.hooks === "object") {
    let removed = false;
    for (const [ev, list] of Object.entries(hooks.hooks)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((h) => !isJevmemHookCommand(h));
      if (kept.length !== list.length) removed = true;
      if (kept.length) hooks.hooks[ev] = kept;
      else delete hooks.hooks[ev];
    }
    if (removed) {
      const empty = Object.keys(hooks.hooks).length === 0 && Object.keys(hooks).every((k) => k === "version" || k === "hooks");
      if (empty) fs.unlinkSync(file);
      else fs.writeFileSync(file, JSON.stringify(hooks, null, 2) + "\n");
      changed.push(CURSOR_HOOKS_FILE.split(path.sep).join("/"));
    }
  }
  const launcher = path.join(root, CURSOR_LAUNCHER_FILE);
  if (fs.existsSync(launcher)) {
    fs.unlinkSync(launcher);
    changed.push(CURSOR_LAUNCHER_FILE.split(path.sep).join("/"));
    try {
      if (!fs.readdirSync(path.dirname(launcher)).length) fs.rmdirSync(path.dirname(launcher));
    } catch {
      /* not empty */
    }
  }
  return changed;
}

/** For `jevmem doctor` and `init`: what the project's Cursor hooks look like. */
export function cursorHooksStatus(root: string): { file: boolean; events: string[]; launcher: "missing" | "current" | "stale"; others: number } {
  const hooks = readHooksFile(path.join(root, CURSOR_HOOKS_FILE));
  const events: string[] = [];
  let others = 0;
  if (hooks?.hooks && typeof hooks.hooks === "object") {
    for (const [ev, list] of Object.entries(hooks.hooks)) {
      if (!Array.isArray(list)) continue;
      if (list.some((h) => isJevmemHookCommand(h))) events.push(ev);
      others += list.filter((h) => !isJevmemHookCommand(h)).length;
    }
  }
  let launcher: "missing" | "current" | "stale" = "missing";
  try {
    launcher = fs.readFileSync(path.join(root, CURSOR_LAUNCHER_FILE), "utf8") === cursorLauncherSource() ? "current" : "stale";
  } catch {
    /* missing */
  }
  const order = CURSOR_HOOK_EVENTS as readonly string[];
  events.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { file: Boolean(hooks), events, launcher, others };
}
