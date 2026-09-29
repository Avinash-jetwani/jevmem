/**
 * What failed silently in the last days, from `.jevmem/log.jsonl` alone (no network): turns that were dropped, recall
 * requests that failed, and guard checks that failed or timed out. `jevmem doctor` and `jevmem stats` show it.
 *
 * - Dropped turns: the queue's `dropped` events (not retryable, older than 24 h, over 200 entries), and the Stop hook's
 *   problems (no key, a transcript it could not read, an error). A turn read fine with nothing in it is not a drop, and
 *   a drop that `runHook` (`jevmem watch`) also logged as the hook's error is counted once.
 * - Failed recalls: the UserPromptSubmit hook's problems (the request failed, or no key). Each failed prompt got no
 *   project memory at all. createJev also logs the failed request itself; that line is not counted again.
 * - Guard failures: the guard's own failure lines (Jev failed or timed out, no key, a bad config or input): each is a
 *   Bash, Edit or Write call that ran unchecked. createJev's line for the same request is not counted again. A guard
 *   setting replaced by its default (`guard-config`) is another problem: the call was still checked.
 * - Writer fallbacks: the LLM writer set in jevmem.config.json gave no line (an error, an empty line) and the line was
 *   written locally, or its request had to change (an OpenAI-compatible endpoint that rejected `reasoning_effort`); or
 *   (v0.6 part 3c) Jev's pick of the line's sentences failed, and jevmem's own writer chose one by its words.
 * - Recalls by word match (v0.6 part 3b): the prompt's Jev call failed or ran past `jev.recallTimeoutMs`, so the prompt
 *   got the lines sharing the most words with it instead of Jev's pick (the `served` events of src/hook.ts).
 */
import type { JevLogEntry } from "./jev.js";

export interface FailureGroup {
  count: number;
  /** Reasons, most frequent first: how many times, and the most recent message. */
  reasons: { count: number; latest: string; latestAt: string }[];
}

export interface RecentFailures {
  days: number;
  since: string;
  dropped: FailureGroup;
  recall: FailureGroup;
  guard: FailureGroup;
  /** Writer fallbacks: the LLM writer's (lines written locally, requests sent again without `reasoning_effort`), and failed picks of a line's sentences. */
  writer: FailureGroup;
  /** Prompts served by word match because Jev's call failed or ran late. */
  wordMatch: FailureGroup;
  /** Other hook problems (for example the Stop drain's gate check of new rules, or an event that could not be read). */
  other: FailureGroup;
}

const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** Messages that differ only in numbers (a JSON position, a time in ms, an attempt count) are one reason. */
const reasonKey = (s: string) => {
  if (/TYPESAFE_API_KEY not set|no TypeSafe API key/.test(s)) return "no key";
  return s.replace(/\d+/g, "N");
};

function group(items: { at: string; message: string }[]): FailureGroup {
  const by = new Map<string, { count: number; latest: string; latestAt: string }>();
  for (const { at, message } of items) {
    const k = reasonKey(message);
    const cur = by.get(k);
    if (!cur) by.set(k, { count: 1, latest: message, latestAt: at });
    else {
      cur.count++;
      if (at >= cur.latestAt) [cur.latest, cur.latestAt] = [message, at];
    }
  }
  return { count: items.length, reasons: [...by.values()].sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt)) };
}

export function recentFailures(entries: JevLogEntry[], opts: { now?: number; days?: number } = {}): RecentFailures {
  const days = opts.days ?? 7;
  const since = new Date((opts.now ?? Date.now()) - days * 86_400_000).toISOString();
  const recent = entries.filter((e) => typeof e.ts === "string" && e.ts >= since);
  const dropped: { at: string; message: string }[] = [];
  const recall: { at: string; message: string }[] = [];
  const guard: { at: string; message: string }[] = [];
  const writer: { at: string; message: string }[] = [];
  const wordMatch: { at: string; message: string }[] = [];
  const other: { at: string; message: string }[] = [];
  // The queue's drops, to recognise the same drop logged again as the hook's error (`not retryable: <error>` / `<error>`).
  const queueDrops = recent.filter((e) => e.label === "queue" && e.event === "dropped").map((e) => ({ t: Date.parse(e.ts), m: one(e.detail ?? "") }));
  const alsoQueued = (at: string, m: string) => queueDrops.some((d) => d.m === `not retryable: ${m}` && Math.abs(d.t - Date.parse(at)) < 10_000);
  for (const e of recent) {
    if (e.label === "queue" && e.event === "dropped") dropped.push({ at: e.ts, message: one(e.detail ?? "dropped") });
    else if (e.label === "hook" && e.ok === false && !e.event) {
      const err = one(e.error ?? "");
      if (err.startsWith("UserPromptSubmit: ")) recall.push({ at: e.ts, message: err.slice("UserPromptSubmit: ".length) });
      else if (err.startsWith("Stop: ")) {
        const m = err.slice("Stop: ".length);
        // Read fine, nothing to save: not a drop. The drain's gate check of new rules is not about the turn.
        if (/^empty turn \(source: transcript(\+last_assistant_message)?,/.test(m) || alsoQueued(e.ts, m)) continue;
        (/^gate check of new rules/.test(m) ? other : dropped).push({ at: e.ts, message: m });
      } else other.push({ at: e.ts, message: err });
    } else if (e.label === "guard" && e.ok === false && !e.event && !(e.questions > 0)) guard.push({ at: e.ts, message: one((e.error ?? "").replace(/^Jev check failed, no decision: /, "")) });
    // A guard setting the guard replaced with the default: the call was still checked, so not a failed check.
    else if (e.label === "guard" && e.event === "guard-config") other.push({ at: e.ts, message: one(e.error ?? "guard setting not used") });
    else if (e.label === "writer" && e.event === "writer-fallback") writer.push({ at: e.ts, message: one(e.detail ?? "writer fallback") });
    else if (e.label === "recall" && e.event === "served" && /^word match\b/.test(e.detail ?? "")) wordMatch.push({ at: e.ts, message: one((e.detail ?? "").replace(/^word match: \d+ line\(s\); /, "")) });
  }
  return { days, since, dropped: group(dropped), recall: group(recall), guard: group(guard), writer: group(writer), wordMatch: group(wordMatch), other: group(other) };
}

/** Lines for doctor and stats, each starting with `indent` (the first with `head`). */
export function formatFailures(f: RecentFailures, head: string, indent: string): string[] {
  const total = f.dropped.count + f.recall.count + f.guard.count + f.writer.count + f.wordMatch.count + f.other.count;
  if (!total) return [`${head}none in the last ${f.days} days: no dropped turn, failed recall, failed guard check or writer fallback in .jevmem/log.jsonl`];
  const out = [`${head}in the last ${f.days} days: ${f.dropped.count} dropped turn(s), ${f.recall.count} failed recall(s), ${f.guard.count} guard check(s) failed or timed out${f.wordMatch.count ? `, ${f.wordMatch.count} recall(s) by word match` : ""}${f.writer.count ? `, ${f.writer.count} writer fallback(s)` : ""}${f.other.count ? `, ${f.other.count} other hook problem(s)` : ""} (.jevmem/log.jsonl)`];
  const cut = (s: string) => (s.length > 150 ? s.slice(0, 149) + "…" : s);
  const section = (name: string, g: FailureGroup, note: string) => {
    if (!g.count) return;
    out.push(`${indent}${name}${note}:`);
    for (const r of g.reasons.slice(0, 5)) out.push(`${indent}  ${r.count}× ${cut(r.latest)} (last ${r.latestAt.slice(0, 16).replace("T", " ")} UTC)`);
    if (g.reasons.length > 5) out.push(`${indent}  and ${g.reasons.length - 5} other reason(s)`);
  };
  section("dropped turns", f.dropped, ", never evaluated");
  section("failed recalls", f.recall, ", the prompt got no project memory");
  section("guard checks that failed or timed out", f.guard, ", the call ran unchecked");
  section("recalls by word match", f.wordMatch, ", Jev failed or ran late, so the prompt got the lines sharing the most words with it");
  section("writer fallbacks", f.writer, ", the line was not written as configured: the LLM writer set in jevmem.config.json did not give it as asked, or Jev's pick of its sentences failed");
  section("other hook problems", f.other, "");
  return out;
}
