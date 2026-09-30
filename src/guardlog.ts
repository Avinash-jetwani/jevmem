/**
 * The guard's local log: `.jevmem/guard-log.jsonl`, one line per call the PreToolUse hook checked in this project.
 * Every line has the time, the tool, how the call was decided (the route) and the decision. An ask, a denial or a
 * warning also keeps the rules at or above `guard.askMin` with their scores, the tamper check's reason, and a short
 * scrubbed summary of the command or edit. Nothing here is sent anywhere; `jevmem stats` counts the lines and
 * `jevmem guard log` lists the decisions. Past `GUARD_LOG_MAX_BYTES` the file becomes `guard-log.1.jsonl` (replacing
 * the previous one), so the two files hold the most recent calls.
 */
import fs from "node:fs";
import path from "node:path";
import type { GuardAction } from "./prefilter.js";
import { scrubSecrets } from "./scrub.js";

/**
 * How a call was decided. `no-rules`: nothing to enforce; `no-candidate`: the prefilter matched no rule (these two are
 * the fast path: nothing is sent); `cache`: every candidate's answer was cached; `jev`: a request was sent and
 * answered; `jev-failed`: sent, with no answer (timeout or error); `no-key` and `no-time`: not sent; `error`: a bad
 * config, malformed input, or an unreadable `JEVMEM.md` or index. The tamper check runs on every route.
 */
export type GuardRoute = "no-rules" | "no-candidate" | "cache" | "jev" | "jev-failed" | "no-key" | "no-time" | "error";

export interface GuardLogEntry {
  ts: string;
  tool: string;
  route: GuardRoute;
  decision: "none" | "ask" | "deny" | "warn";
  /** Asks, denials and warnings only. */
  mode?: string;
  tamper?: string;
  /**
   * `unverified`: the line was not written by jevmem on this machine, so it could only ask. `unchecked`: Jev failed
   * or ran out of time and the rule matched on more than keywords, so the call was asked about without a score.
   */
  rules?: { id: string; p?: number; text: string; unverified?: boolean; unchecked?: boolean }[];
  action?: string;
  /**
   * A part of the check failed (the tamper check, the prefilter or the git expansion; or the whole check, when the
   * route is `error`): what, scrubbed and short. The other parts still ran and decided; `jevmem doctor` lists these.
   */
  error?: string;
}

export const GUARD_LOG_FILE = "guard-log.jsonl";
export const GUARD_LOG_MAX_BYTES = 1_000_000;

const logFile = (root: string) => path.join(root, ".jevmem", GUARD_LOG_FILE);
const olderFile = (root: string) => path.join(root, ".jevmem", GUARD_LOG_FILE.replace(/\.jsonl$/, ".1.jsonl"));

/** Append one entry. Never throws: a lost line only costs a count. */
export function recordGuardCall(root: string, entry: GuardLogEntry): void {
  try {
    const file = logFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > GUARD_LOG_MAX_BYTES) fs.renameSync(file, olderFile(root));
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    /* logging must never break the hook */
  }
}

/** Both files, oldest first. Torn or foreign lines are skipped. */
export function readGuardLog(root: string): GuardLogEntry[] {
  const out: GuardLogEntry[] = [];
  for (const file of [olderFile(root), logFile(root)]) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as GuardLogEntry;
        if (typeof e.ts === "string" && typeof e.route === "string" && typeof e.decision === "string") out.push(e);
      } catch {
        /* a torn line */
      }
    }
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
/** One line of at most `max` characters. */
export const shorten = (s: string, max: number) => cut(oneLine(s), max);

/**
 * A short scrubbed summary of a call for the log: the command (and, for a git command, the staged files a rule
 * named), or the file and the start of the new text (the snippet around what matched, when one was sent). At most
 * `max` characters.
 */
export function actionSummary(action: GuardAction, payload: Record<string, string> | null, max = 160): string {
  // Scrubbed before it is shortened, over a window far longer than what is kept.
  const clean = (s: string) => oneLine(scrubSecrets(s.slice(0, 20_000)));
  if (action.tool === "Bash") {
    const command = clean(payload?.command ?? action.command ?? "");
    if (!payload?.stages) return cut(command, max);
    const stages = ` [stages ${cut(clean(payload.stages), Math.floor(max / 2))}]`;
    return cut(command, Math.max(20, max - stages.length)) + stages;
  }
  const text = clean((action.tool === "Edit" ? payload?.added : payload?.content) ?? action.added ?? "");
  return cut(`${action.file ?? ""}${text ? ` "${text}"` : ""}`, max);
}

export interface GuardLogStats {
  since: string | null;
  seen: number;
  fast: number;
  cache: number;
  sent: number;
  sentFailed: number;
  notSent: number;
  errors: number;
  asked: number;
  tamperAsks: number;
  denied: number;
  warned: number;
}

export function guardLogStats(entries: GuardLogEntry[]): GuardLogStats {
  const n = (f: (e: GuardLogEntry) => boolean) => entries.filter(f).length;
  return {
    since: entries[0]?.ts ?? null,
    seen: entries.length,
    fast: n((e) => e.route === "no-rules" || e.route === "no-candidate"),
    cache: n((e) => e.route === "cache"),
    sent: n((e) => e.route === "jev" || e.route === "jev-failed"),
    sentFailed: n((e) => e.route === "jev-failed"),
    notSent: n((e) => e.route === "no-key" || e.route === "no-time"),
    errors: n((e) => e.route === "error" || typeof e.error === "string"),
    asked: n((e) => e.decision === "ask"),
    tamperAsks: n((e) => e.decision === "ask" && Boolean(e.tamper)),
    denied: n((e) => e.decision === "deny"),
    warned: n((e) => e.decision === "warn"),
  };
}

/** A timestamp as local `YYYY-MM-DD HH:MM:SS`. */
export function localTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `jevmem stats`'s guard lines, or null when the guard has logged nothing here. */
export function formatGuardStats(s: GuardLogStats): string | null {
  if (!s.seen) return null;
  return [
    `guard: ${s.seen} call(s) seen since ${localTime(s.since!)}: ${s.fast} fast path (no candidate rule, nothing sent), ${s.cache} answered from the cache, ${s.sent} sent to Jev${s.sentFailed ? ` (${s.sentFailed} failed or timed out)` : ""}${s.notSent ? `, ${s.notSent} not sent (no key or no time left)` : ""}${s.errors ? `, ${s.errors} with an error in a part of the check (\`jevmem doctor\` lists them)` : ""}`,
    `       ${s.asked} asked (${s.tamperAsks} tamper), ${s.denied} denied, ${s.warned} warned; \`jevmem guard log\` lists them`,
  ].join("\n");
}

/** `jevmem guard log`: the `n` most recent asks, denials and warnings, newest first. */
export function formatGuardLog(entries: GuardLogEntry[], n: number): string {
  const decided = entries.filter((e) => e.decision !== "none");
  // Calls where a part of the check failed: counted here, listed by `jevmem doctor`.
  const errors = entries.filter((e) => e.route === "error" || typeof e.error === "string");
  const last = errors[errors.length - 1];
  const errorLine = errors.length ? `\n${errors.length} call(s) had an error in a part of the check, the last at ${localTime(last!.ts)}${last!.error ? `: ${last!.error}` : ""}; \`jevmem doctor\` lists them` : "";
  if (!decided.length) return `jevmem guard log: no asks or denials logged in this project${entries.length ? ` (${entries.length} call(s) checked since ${localTime(entries[0]!.ts)})` : ""} (.jevmem/${GUARD_LOG_FILE})${errorLine}`;
  const shown = decided.slice(-n).reverse();
  const word = { ask: ["ask", "asks"], deny: ["denial", "denials"], warn: ["warning", "warnings"] } as const;
  const kinds = (["ask", "deny", "warn"] as const).map((d) => [decided.filter((e) => e.decision === d).length, d] as const).filter(([k]) => k > 0);
  const counted = kinds.map(([k, d]) => `${k} ${word[d][k === 1 ? 0 : 1]}`).join(", ");
  const out = [`jevmem guard log: ${shown.length === decided.length ? counted : `the ${shown.length} most recent of ${counted}`} since ${localTime(entries[0]!.ts)}, newest first (.jevmem/${GUARD_LOG_FILE})`, ""];
  const pad = " ".repeat(21);
  for (const e of shown) {
    out.push(`${localTime(e.ts)}  ${e.decision.padEnd(4)}  ${e.tool.padEnd(5)}  ${e.action ?? ""}`);
    for (const r of e.rules ?? []) out.push(`${pad}rule ${r.id}  ${r.unchecked || typeof r.p !== "number" ? "not checked in time" : `p=${r.p.toFixed(2)}`}  "${r.text}"${r.unverified ? "  (unverified line)" : ""}`);
    if (e.tamper) out.push(`${pad}tamper: ${e.tamper}`);
    if (e.error) out.push(`${pad}error: ${e.error}`);
  }
  return out.join("\n") + errorLine;
}
