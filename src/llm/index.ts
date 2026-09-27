import { scrubSecrets } from "../scrub.js";

export type WriterProvider = "openai" | "anthropic" | "none";

export interface WriterConfig {
  /**
   * `"openai"` or `"anthropic"` turns the LLM writer on for this project. `"none"` (the default) and the legacy
   * `"auto"` leave it off: jevmem writes the line itself.
   */
  provider: "auto" | WriterProvider;
  model?: string;
  timeoutMs: number;
}

export interface ResolvedWriter {
  provider: WriterProvider;
  model: string;
  /** Why this writer, in one sentence, for `jevmem doctor` and `jevmem stats`. */
  reason: string;
}

export const DEFAULT_MODELS: Record<Exclude<WriterProvider, "none">, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

const KEY_OF: Record<Exclude<WriterProvider, "none">, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

/**
 * The LLM writer is opt-in per project: it runs only when `writer.provider` in jevmem.config.json is `"openai"` or
 * `"anthropic"` and that provider's key is set. A key being present is never enough, and `JEVMEM_WRITER` can only
 * turn the writer off (`none`). Otherwise jevmem writes the line itself (the deterministic extract).
 */
export function resolveWriter(cfg: WriterConfig, env: NodeJS.ProcessEnv = process.env): ResolvedWriter {
  const model = env.JEVMEM_WRITER_MODEL?.trim() || cfg.model;
  const self = (reason: string): ResolvedWriter => ({ provider: "none", model: "", reason });
  if (env.JEVMEM_WRITER?.trim().toLowerCase() === "none") return self("JEVMEM_WRITER=none: jevmem writes the line itself");
  const p = cfg.provider;
  if (p !== "openai" && p !== "anthropic") return self("no LLM writer set in jevmem.config.json (the default): jevmem writes the line itself");
  if (!env[KEY_OF[p]]?.trim()) return self(`writer is "${p}" in jevmem.config.json, but ${KEY_OF[p]} is not set: jevmem writes the line itself`);
  return { provider: p, model: model ?? DEFAULT_MODELS[p], reason: `writer is "${p}" in jevmem.config.json and ${KEY_OF[p]} is set` };
}

export function systemPrompt(maxChars: number): string {
  return [
    "You maintain a project memory file for an AI coding assistant.",
    `Rewrite the given message as ONE line of at most ${maxChars} characters that a future coding session would need.`,
    "Keep URLs, paths, and identifiers whole; if a URL would not fit, leave it out rather than truncating it.",
    "Rules: state the fact, decision, rule, bug, or todo directly; present tense; no preamble, quotes, bullets, or trailing period explanations;",
    "keep concrete names (files, libraries, versions); drop pleasantries; never invent details; never include credentials.",
    "Reply with the line only.",
  ].join(" ");
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await p(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** gpt-5* and o-series models on api.openai.com accept `reasoning_effort`; other OpenAI-compatible endpoints may not. */
export function isOpenAIReasoningModel(model: string, base: string): boolean {
  return /^https:\/\/api\.openai\.com\//.test(base + "/") && /^(gpt-5|o\d)/.test(model);
}

export async function callOpenAI(input: { model: string; system: string; user: string; timeoutMs: number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<string> {
  const env = input.env ?? process.env;
  const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const f = input.fetchImpl ?? fetch;
  return withTimeout(async (signal) => {
    const r = await f(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}` },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        // Reasoning models (gpt-5*, o*) spend completion tokens on reasoning before the line; a 120 cap could leave
        // nothing for the answer. Ask api.openai.com reasoning models for minimal effort, and cap high enough either way.
        max_completion_tokens: 1000,
        ...(isOpenAIReasoningModel(input.model, base) ? { reasoning_effort: "minimal" } : {}),
      }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    return String(j.choices?.[0]?.message?.content ?? "");
  }, input.timeoutMs);
}

export async function callAnthropic(input: { model: string; system: string; user: string; timeoutMs: number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<string> {
  const env = input.env ?? process.env;
  const base = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const f = input.fetchImpl ?? fetch;
  return withTimeout(async (signal) => {
    const r = await f(`${base}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 120,
        system: input.system,
        messages: [{ role: "user", content: input.user }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    return (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  }, input.timeoutMs);
}

const KIND_CUES: Record<string, RegExp> = {
  bug: /\b(caused by|root cause|because|fix(ed|es)?|bug|race|flaky|leak|crash|fails?|broken)\b/i,
  decision: /\b(use|switch|go with|going with|decided|decision|instead of|chose|pick)\b/i,
  constraint: /\b(must|never|always|only|require[sd]?|cannot|can't|floor|limit|max|min)\b/i,
  preference: /\b(prefer|like|rather|style|convention|please)\b/i,
  architecture: /\b(lives in|located|module|package|service|layer|boundary|flows? through|calls|exposes)\b/i,
  todo: /\b(todo|later|before launch|follow[- ]up|next|remind|deferred|eventually)\b/i,
};

/** A turn's text split into its USER: / ASSISTANT: parts (plain text is the user's), code blocks removed. */
function splitRoles(message: string): { clean: string; roles: { role: "user" | "assistant"; text: string }[] } {
  const clean = scrubSecrets(message).replace(/```[\s\S]*?```/g, " ");
  const roles: { role: "user" | "assistant"; text: string }[] = [];
  for (const chunk of clean.split(/(?=^|\n)\s*(?=(?:USER|ASSISTANT):)/)) {
    const m = /^\s*(USER|ASSISTANT):\s*([\s\S]*)$/.exec(chunk);
    if (m) roles.push({ role: m[1] === "USER" ? "user" : "assistant", text: m[2]! });
    else if (chunk.trim()) roles.push({ role: "user", text: chunk });
  }
  return { clean, roles };
}

/**
 * Deterministic fallback when no LLM key is present: the most relevant declarative sentence, trimmed to `maxChars`.
 * Skips questions, prefers sentences that carry cue words for the memory kind, and for findings (bug, architecture)
 * prefers the assistant's text over the user's. A dead end keeps what was tried and why (`extractDeadEnd`).
 */
export function extractFirstSentence(message: string, maxChars: number, kind?: string): string {
  if (kind === "dead-end") return extractDeadEnd(message, maxChars);
  const { clean, roles } = splitRoles(message);
  const cue = kind ? KIND_CUES[kind] : undefined;
  const assistantFirst = kind === "bug" || kind === "architecture";
  let best: { text: string; score: number; order: number } | null = null;
  let order = 0;
  for (const r of roles) {
    const sentences = r.text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
    for (const raw of sentences) {
      const s = raw.trim();
      order++;
      if (s.length < 12) continue;
      let score = 0;
      if (/\?$/.test(s)) score -= 3;
      if (cue?.test(s)) score += 2;
      if (assistantFirst && r.role === "assistant") score += 1;
      if (/^(ok|okay|done|sure|great|thanks|yes|no)\b/i.test(s)) score -= 2;
      if (!best || score > best.score) best = { text: s, score, order };
    }
  }
  const pick = best?.text ?? clean.replace(/(^|\n)\s*(?:USER|ASSISTANT):\s*/g, "$1").replace(/\s+/g, " ").trim();
  return clampLine(pick, maxChars);
}

// ---------------------------------------------------------------------------------------------
// Dead ends (docs/dead-ends.md): the line says what was tried and why it failed or was dropped. The reason is the
// point of the line, so the local writer keeps the sentence with it rather than only the first good sentence.

/**
 * Words that say why an attempt failed or was dropped: a cause, a failure, a limit, a measurement, a cost. "Didn't work",
 * "didn't stick", "didn't pan out", "dropped it" and "went back" say that it failed, not why, so they don't count.
 */
export const DEAD_END_REASON = new RegExp(
  "\\b(" +
    [
      "because", "since", "due to", "caused", "given that",
      "fail(s|ed|ing|ure|ures)?", "broke|breaks|broken|breaking", "crash(es|ed|ing)?", "errors?", "exception", "panic(s|ked)?", "hang(s|ing)?|hung",
      "timed out|times out|time out|timeouts?", "oom|out of memory|out-of-memory", "leak(s|ed|ing)?", "block(s|ed|ing)?", "reject(s|ed)?", "refus(es|ed)",
      "denied", "throttl(ed|es|ing)", "corrupt(s|ed)?", "chok(es|ed|ing)", "peg(s|ged)", "drift(s|ed)?", "stale", "lock(s|ed)?", "overlap(s|ped|ping)?",
      "lag(s|gy|ged)?", "jank(s|y)?", "stutter(s|ed)?", "slivers?", "black", "blank",
      "can't|cannot|couldn't|could not|won't|wouldn't|isn't|is not|wasn't|aren't|no way|not supported|unsupported|incompatible|lacks?|missing|needs|requires|only",
      "(didn't|did not|doesn't|does not)\\s+(?!work\\b|stick\\b|pan\\b)\\w+",
      "too (slow|big|large|heavy|expensive|many|much|few|long|small|late|early)", "slower|bigger|larger|heavier|longer|higher|worse|more than|less than",
      "costs?|costly|bill", "limits?", "wall", "no (change|difference|effect)", "made no difference", "still", "enforc(es|ed)",
      "at most|at best|no more than", "silently", "(matched|returned|did|found|showed|changed) nothing|nothing (happened|changed|matched)",
    ].join("|") +
    // A measurement: "40 ms", "1.1 s", "12 GB", "100%", "3x", "45-minute", "3.5k requests".
    ")\\b|\\d[\\d,.]*k?(\\s?(ms|sec|seconds?|mins?|minutes?|hours?|days?|kb|mb|gb|gib|%|x|×|requests|times)|\\s(s|w)|-(second|minute|hour|day))(?![a-z])",
  "i",
);
/**
 * An attempt, as people report one: "tried", "attempted", "gave X a go", "prototyped", "was a dead end", and "X didn't
 * work out", which names the attempt (and says it failed, not why).
 */
const ATTEMPT = /\b(tried|attempted|attempts?|prototyped|experimented|tested|gave .{1,60}? a (go|try|shot)|had a go|first try|a dead end|a no-go|a dud|was (a )?non-starter|(didn't|did not|doesn't|does not|hasn't|has not|haven't) (work|worked|hold up|held up|pan out)|not working)\b/i;
/** Sentences that are not what happened: requests, conditions, plans and acknowledgements. */
const NOT_A_FACT = /^(can|could|would|will) (you|we)\b|^(please|let me know|your call|if|when|try|make|get|turn|next|i'll|i will|we'll|we will|okay|ok|noted|understood|got it|sure|thanks|great|nice|good)\b/i;

/** Does a dead-end line give a reason (docs/dead-ends.md)? A line without one is not saved as a dead end. */
export function deadEndHasReason(line: string): boolean {
  return DEAD_END_REASON.test(line);
}

/** Sentences for a dead end: also split at ". " before a lowercase word (typed quickly), but not after e.g., i.e., vs. */
const deadEndSentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e|vs|etc|approx)\.)\s+(?=[A-Za-z0-9"'(])/i)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A leading "fyi", then "I tried", "We tried" or "Tried" before what was tried: the [dead-end] tag and "Already tried:"
 * say it. Kept when what follows is a name in code (generateStaticParams, next/image), which must keep its case.
 */
function leadingTried(s: string): string {
  const t = s.replace(/^(?:fyi|fwiw|btw)\b[,:]?\s+/i, "");
  const m = /^(?:(?:i|we)\s+(?:first\s+)?)?tried\s+(?!to\b)([a-z][a-z']*)(?=[\s,;:])/i.exec(t);
  if (!m || /[A-Z]/.test(m[1]!.slice(1))) return t;
  return m[1]!.charAt(0).toUpperCase() + t.slice(m[0].length - m[1]!.length + 1);
}

/**
 * The local writer's dead-end line: from the sentence that says what was tried, the sentences that follow it, in
 * order, while they fit in `maxChars` (the reason and the outcome usually come right after the attempt). When the
 * attempt alone fills the line and says no reason, it is shortened to make room for the next sentence that does: the
 * reason is the point of the line. The reply's sentences are used when it reports the attempt (the user's are then the
 * request); requests, conditions, plans and acknowledgements never are.
 */
export function extractDeadEnd(message: string, maxChars: number): string {
  const { roles } = splitRoles(message);
  const facts = (text: string) => deadEndSentences(text).filter((s) => s.length >= 8 && !/\?$/.test(s) && !NOT_A_FACT.test(s));
  const user = roles.filter((r) => r.role === "user").flatMap((r) => facts(r.text));
  const reply = roles.filter((r) => r.role === "assistant").flatMap((r) => facts(r.text));
  // The reply's sentences when the reply reports the attempt; otherwise the user's, then the reply's.
  const pool = reply.some((s) => ATTEMPT.test(s)) ? reply : [...user, ...reply];
  if (!pool.length) return extractFirstSentence(message, maxChars);
  const attempt = pool.findIndex((s) => ATTEMPT.test(s));
  const start = Math.max(0, attempt >= 0 ? attempt : pool.findIndex((s) => DEAD_END_REASON.test(s)));
  const window = [pool[start]!];
  for (let i = start + 1; i < pool.length && [...window, pool[i]].join(" ").length <= maxChars; i++) window.push(pool[i]!);
  let line = window.join(" ");
  if (window.length === 1 && !DEAD_END_REASON.test(line)) {
    const next = pool.slice(start + 1).find((s) => DEAD_END_REASON.test(s));
    if (next) {
      const why = clampLine(next, Math.floor(maxChars * 0.65));
      line = `${clampLine(pool[start]!, maxChars - why.length - 1)} ${why}`;
    }
  }
  return clampLine(leadingTried(line), maxChars);
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+|^www\.\S+/i;

const FILLER_LABEL = /^(?:decision|decided|constraint|bug|to-?do|preference|update|note|fyi|reminder|change of plan|heads[ -]?up|quick note|context)\s*:\s*/i;
// "Remember that …" / "Remember: …" (a bare "Remember" is kept: "Remember-me tokens expire after 30 days").
const FILLER_LEAD = /^(?:please\s+)?remember(?:\s+that\b\s*|\s*:\s*)/i;
const FILLER_WORD = /^(?:actually|so|ok|okay|also|well|alright|right|anyway|basically|honestly|just so you know|to be clear|for the record|btw|by the way)\b/i;
const SEP = /^\s*(?:[,:;]|[-–—])\s*/;

/**
 * Drop leading conversational filler ("Decision:", "Constraint:", "Bug:", "Todo:", "Preference:", "Remember that",
 * "Actually,", "So,", "OK,"); keep the rest verbatim, capitalised. The kind is already recorded in the line's tag.
 */
export function stripFiller(line: string): string {
  let t = line.trim();
  // Peel filler from the front: "Label:" prefixes, and filler words followed by punctuation or by another filler word.
  for (;;) {
    const label = FILLER_LABEL.exec(t) ?? FILLER_LEAD.exec(t);
    if (label) {
      t = t.slice(label[0].length).trimStart();
      continue;
    }
    const word = FILLER_WORD.exec(t);
    if (!word) break;
    const rest = t.slice(word[0].length);
    const sep = SEP.exec(rest);
    if (sep) t = rest.slice(sep[0].length).trimStart();
    else if (/^\s+/.test(rest) && (FILLER_WORD.test(rest.trimStart()) || FILLER_LABEL.test(rest.trimStart()) || FILLER_LEAD.test(rest.trimStart()))) t = rest.trimStart();
    else break;
  }
  if (!t) return line.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * One line, at most `maxChars`. Cuts only at word boundaries and never inside a URL: a URL that would straddle the
 * limit is dropped whole (with the trailing "…"), unless it is the only token, in which case it is kept intact.
 */
export function clampLine(text: string, maxChars: number): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/^["'`\-*•\s]+|["'`\s]+$/g, "");
  if (t.length <= maxChars) return t;
  const words = t.split(" ");
  const out: string[] = [];
  let len = 0;
  for (const w of words) {
    const add = (out.length ? 1 : 0) + w.length;
    if (len + add + 1 > maxChars) break; // +1 leaves room for the ellipsis
    out.push(w);
    len += add;
  }
  if (out.length === 0) {
    const first = words[0]!;
    return URL_RE.test(first) ? first : first.slice(0, maxChars - 1) + "…";
  }
  return out.join(" ").replace(/[,;:]$/, "") + "…";
}
