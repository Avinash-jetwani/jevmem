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

/**
 * gpt-5* and o-series models, by id, with or without a provider prefix ("gpt-5-mini", "openai/gpt-5-mini" on OpenRouter,
 * "o4-mini"). They spend completion tokens on reasoning before the line, so the writer asks them for minimal effort.
 */
export function isReasoningModel(model: string): boolean {
  return /^(?:[\w.-]+\/)?(gpt-5|o\d)/i.test(model.trim());
}

/** What an OpenAI-compatible endpoint returned for the writer, and what had to change on the way. */
export interface WriterReply {
  text: string;
  /** Set when the request had to be sent again without `reasoning_effort` (the endpoint rejected it). */
  note?: string;
  /** Why the text is empty, when it is: the finish reason and the reasoning tokens, as the endpoint reported them. */
  empty?: string;
}

/**
 * One line from an OpenAI-compatible chat-completions endpoint: api.openai.com, or `OPENAI_BASE_URL` (docs/configuration.md
 * names OpenRouter, Groq and Ollama). A reasoning model is asked for `reasoning_effort: "minimal"` on any endpoint (OpenRouter
 * documents the parameter); an endpoint that rejects it with a 400 gets the request once more without it, and the reply
 * says so. The caller falls back to the local writer on an empty text and logs why.
 */
export async function callOpenAI(input: { model: string; system: string; user: string; timeoutMs: number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<WriterReply> {
  const env = input.env ?? process.env;
  const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const f = input.fetchImpl ?? fetch;
  const reasoning = isReasoningModel(input.model);
  return withTimeout(async (signal) => {
    const send = (withEffort: boolean) =>
      f(`${base}/chat/completions`, {
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
          // nothing for the answer. Ask them for minimal effort, and cap high enough either way.
          max_completion_tokens: 1000,
          ...(withEffort ? { reasoning_effort: "minimal" } : {}),
        }),
      });
    let r = await send(reasoning);
    let note: string | undefined;
    if (reasoning && (r.status === 400 || r.status === 422)) {
      const body = (await r.text()).slice(0, 300);
      if (!/reasoning/i.test(body)) throw new Error(`openai ${r.status}: ${body.slice(0, 200)}`);
      note = `${base} rejected reasoning_effort (HTTP ${r.status}), so the request was sent again without it`;
      r = await send(false);
    }
    if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const text = String(j.choices?.[0]?.message?.content ?? "");
    if (text.trim()) return { text, ...(note ? { note } : {}) };
    const finish = j.choices?.[0]?.finish_reason;
    const used = j.usage?.completion_tokens_details?.reasoning_tokens;
    const details = [finish ? `finish_reason ${finish}` : null, typeof used === "number" ? `${used} reasoning tokens` : null].filter(Boolean).join(", ");
    const empty = `${input.model} at ${base} returned an empty line${details ? ` (${details})` : ""}`;
    return { text: "", empty, ...(note ? { note } : {}) };
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
// point of the line, so the local writer keeps the clauses from the attempt on rather than one good sentence. Whether
// the turn says why at all is Jev's call (the dead-end noul, in the decide request): the writer checks no words.

/**
 * An attempt, as people report one: "tried", "attempted", "I ran", "gave X a go", "prototyped", "was a dead end", and
 * "X didn't work out", which names the attempt (and says it failed, not why).
 */
const ATTEMPT = /\b(tried|attempted|attempts?|(i|we) (first )?ran|prototyped|experimented|tested|gave .{1,60}? a (go|try|shot)|had a go|first try|a dead end|a no-go|a dud|was (a )?non-starter|(didn't|did not|doesn't|does not|hasn't|has not|haven't) (work|worked|hold up|held up|pan out)|not working)\b/i;
/** Sentences that are not what happened: requests, conditions, plans and acknowledgements. */
const NOT_A_FACT = /^(can|could|would|will) (you|we)\b|^(please|let me know|your call|if|when|try|make|get|turn|next|i'll|i will|we'll|we will|okay|ok|noted|understood|got it|sure|thanks|great|nice|good)\b/i;

/** Sentences for a dead end: also split at ". " before a lowercase word (typed quickly), but not after e.g., i.e., vs. */
const deadEndSentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e|vs|etc|approx)\.)\s+(?=[A-Za-z0-9"'(`])/i)
    .map((s) => s.trim())
    .filter(Boolean);

/** A turn's statements: no questions, requests, conditions, plans or acknowledgements. */
const factsOf = (text: string) => deadEndSentences(text).filter((s) => s.length >= 8 && !/\?$/.test(s) && !NOT_A_FACT.test(s));

/**
 * A leading "fyi", then "I tried", "We tried" or "Tried" before what was tried: the [dead-end] tag and "Already tried:"
 * say it. Only before a gerund or an article ("switching the watcher", "the temp-dir approach"): before anything else
 * ("I tried it once", "tried rayon's par_bridge", "tried generateStaticParams") the words stay as they are.
 */
function leadingTried(s: string): string {
  const t = s.replace(/^(?:fyi|fwiw|btw)\b[,:]?\s+/i, "");
  const m = /^(?:(?:i|we)\s+(?:first\s+)?)?tried\s+([a-z]+ing|the|a|an|our|their|its)\s/i.exec(t);
  if (!m) return t;
  return m[1]!.charAt(0).toUpperCase() + t.slice(m[0].length - m[1]!.length);
}

/**
 * A sentence that holds more than the attempt: a negation ("didn't help", "no difference"), or a clause after "but",
 * "because", "so", "since" or "which", a colon, a semicolon or a spaced dash, usually says what happened. Sentence
 * structure (negations and the words that open a clause), not a list of failure words; it only decides which clauses
 * fit in the line.
 */
const MORE_THAN_THE_ATTEMPT = /n't\b|\b(?:not|no|never|nothing|without)\b|,\s*(?:but|so|which|and then|until)\b|\b(?:but|because|since|so)\b|[:;]\s|\s[—–-]\s/i;

/**
 * The local writer's dead-end line: the clauses from the sentence that says what was tried, in order, while they fit in
 * `maxChars` (the reason and the outcome usually come right after the attempt). When only the attempt fits and its
 * sentence says nothing but the attempt, its trailing clauses make room for the next sentence. The reply's sentences
 * are used when it reports the attempt (the user's are then the request); requests, conditions, plans and
 * acknowledgements never are.
 */
export function extractDeadEnd(message: string, maxChars: number): string {
  const { roles } = splitRoles(message);
  const user = roles.filter((r) => r.role === "user").flatMap((r) => factsOf(r.text));
  const reply = roles.filter((r) => r.role === "assistant").flatMap((r) => factsOf(r.text));
  // The reply's sentences when the reply reports the attempt; otherwise the user's, then the reply's.
  const pool = reply.some((s) => ATTEMPT.test(s)) ? reply : [...user, ...reply];
  if (!pool.length) return extractFirstSentence(message, maxChars);
  // From the sentence that names the attempt; with none, from the first statement, which usually says what was run
  // ("I ran X once. It fails because Y.").
  return composeDeadEnd(pool.slice(Math.max(0, pool.findIndex((s) => ATTEMPT.test(s)))), maxChars);
}

/** Which of a line's sentences states the memory, and whether Jev said that sentence holds its own reason (src/pick.ts). */
export interface PickedRoles {
  /** The index of the sentence that states the memory (what was tried, what works now); the first when absent. */
  main?: number;
  /** Jev's first answer to the reason question was that sentence itself. */
  ownReason?: boolean;
}

const squashed = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The picked sentences with the main one first, when Jev said it holds its own reason and they do not fit in `maxChars`
 * as written: the cut then falls on the other sentence, not on the reason. Otherwise as written: with the reason in
 * another sentence, text order is what a dead end's line keeps ("X has been a mess: … . Y replaces it" names X first,
 * though Y's sentence is the one Jev says states the memory; eval/dead-ends-dev-v3.jsonl).
 */
function mainFirst(sentences: string[], maxChars: number, roles: PickedRoles): string[] {
  return roles.ownReason && squashed(sentences.join(" ")).length > maxChars ? leadWith(sentences, roles.main) : sentences;
}

/** The sentences with the one at `main` moved to the front. */
function leadWith(sentences: string[], main = 0): string[] {
  return main > 0 && main < sentences.length ? [sentences[main]!, ...sentences.filter((_, i) => i !== main)] : sentences;
}

/**
 * A dead-end line from its sentences, in order (the first says what was tried): the clauses while they fit in `maxChars`,
 * keeping the reason. Used on the sentences `extractDeadEnd` takes from the turn, and on the ones Jev picked (v0.6 part 3c).
 * With Jev's pick, `roles` says which sentence states the memory and whether it holds its own reason: when it does and
 * the sentences do not fit as written, it goes first ("It didn't work, so I'm dropping the idea. I ran X, and it failed
 * because Y" keeps the second sentence, not the verdict), and when its cause comes last and it is longer than the
 * line, the cut keeps the cause (`keepCause`).
 */
export function composeDeadEnd(sentences: string[], maxChars: number, roles: PickedRoles = {}): string {
  const [first, ...rest] = mainFirst(sentences, maxChars, roles);
  if (first === undefined) return "";
  // Without "I tried" first, so what follows has that much more room.
  const attempt = leadingTried(first);
  let line = clampLine([attempt, ...rest].join(" "), maxChars);
  // The same in the attempt's own sentence, when it is too long to keep whole: "Parsing the files with a generic CSV
  // library seemed the fast way, and it handled the big four, but three banks put separators inside amounts" keeps what
  // was tried (its longest cut at a clause's end) and the reason after the "but", and the upside between them goes.
  const own = afterBut(attempt);
  if (own && !line.includes(own.slice(0, 24))) {
    const before = attempt.slice(0, attempt.length - own.length).replace(/,\s*but\s*$/i, "");
    const heads = [before, ...clauseEnds(before).map((e) => before.slice(0, e.at).replace(/[\s,;:—–-]+$/, ""))].filter((h) => h.length >= 20).sort((a, b) => b.length - a.length);
    for (const h of heads) {
      const cut = fitClause(own, maxChars - h.length - ", but ".length);
      if (cut && cut.length >= 30) {
        line = `${h}, but ${cut}`;
        break;
      }
    }
  }
  // A cut that drops the clause after a "but" in a later sentence drops the reason ("It made each path four times
  // faster, but the pool stole cores from the tick thread"), so the upside before the "but" goes instead.
  for (let k = 0; k < rest.length; k++) {
    const reason = afterBut(rest[k]!);
    if (!reason) continue;
    if (!line.includes(reason.slice(0, 24))) {
      const again = clampLine([attempt, ...rest.slice(0, k), capitalized(reason), ...rest.slice(k + 1)].join(" "), maxChars);
      if (again.includes(capitalized(reason).slice(0, 24))) line = again;
      else {
        // The reason's sentence does not fit whole after what comes before it: its first clause that does.
        const before = [attempt, ...rest.slice(0, k)].join(" ");
        const cut = fitClause(capitalized(reason), maxChars - before.length - 1);
        if (cut && cut.length >= 30) line = `${before} ${cut}`;
      }
    }
    break;
  }
  // The attempt's sentence gives its own cause last and the cut dropped it ("I ran X on Y and it failed with Z,
  // because A and B"): the cause is the point of the line, so it stays and something else goes. Only when Jev said the
  // sentence holds its own reason, or when it is the only sentence: with the reason in another sentence, the room is
  // that sentence's.
  if (roles.ownReason || rest.length === 0) {
    const cause = causeAt(attempt);
    if (cause && !squashed(line).includes(squashed(attempt.slice(cause.at + cause.length)).slice(0, 24))) line = keepCause(attempt, maxChars) ?? line;
  }
  const next = rest[0];
  if (next && line.length <= attempt.length && !MORE_THAN_THE_ATTEMPT.test(attempt)) {
    const after = clampLine(next, Math.floor(maxChars * 0.65));
    const head = clampLine(attempt, maxChars - after.length - 2);
    if (!head.endsWith("…") && head.length >= 12 && !after.endsWith("…")) line = `${head.replace(/[.!?]$/, "")}. ${after}`;
  }
  return clampLine(leadingTried(line), maxChars);
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The clause after a sentence's first ", but" outside parentheses, code spans and quotes, or null. In a dead end it is
 * usually the reason, and the clause before it the upside ("Packets got 30% smaller, but encoding took 2.4 ms").
 */
function afterBut(s: string): string | null {
  let depth = 0;
  let code = false;
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "`") code = !code;
    else if (code) continue;
    else if (c === '"') quote = !quote;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0 && !quote) {
      const m = /^,\s+but\s+(?=\S)/i.exec(s.slice(i));
      if (m) return s.slice(i + m[0].length);
    }
  }
  return null;
}

/**
 * Where a sentence turns to the cause of what it reports: at "because", "due to" or "owing to", and at ", since" or
 * ", given that" (after a comma: "since" also dates things), outside code spans, quotes and parentheses. `at` is where
 * the text before it ends, `length` covers the comma, the spaces and the word. Null when the sentence has none.
 */
function causeAt(s: string): { at: number; length: number } | null {
  let depth = 0;
  let code = false;
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "`") code = !code;
    else if (code) continue;
    else if (c === '"') quote = !quote;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if ((c === "," || c === " ") && depth === 0 && !quote && i > 0 && s[i - 1] !== ",") {
      const m = /^,?\s+(?:because|due to|owing to)\s+(?=\S)/i.exec(s.slice(i)) ?? /^,\s+(?:since|given that)\s+(?=\S)/i.exec(s.slice(i));
      if (m) return { at: i, length: m[0].length };
    }
  }
  return null;
}

/**
 * A cause in at most `max` characters: cut at one of its clause ends (`fitClause`), else before an " and " that adds a
 * second cause or a second verb ("the cache drops keys under memory pressure" without "and gives no warning"), outside
 * code spans, quotes and parentheses and never inside "between A and B" or "both A and B". At least 30 characters, or null.
 */
function fitCause(cause: string, max: number): string | null {
  const cut = fitClause(cause, max);
  if (cut) return cut;
  let depth = 0;
  let code = false;
  let quote = false;
  let at = -1;
  for (let i = 0; i < cause.length && i <= max; i++) {
    const c = cause[i]!;
    if (c === "`") code = !code;
    else if (code) continue;
    else if (c === '"') quote = !quote;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && !quote && i >= 30 && cause.startsWith(" and ", i) && !/\b(?:between|both)\b[^,;:]*$/i.test(cause.slice(0, i))) at = i;
  }
  return at < 0 ? null : cause.slice(0, at).replace(/[\s,;:]+$/, "");
}

/**
 * A sentence longer than the line that gives its cause last, cut so that the cause stays: the sentence as written up to
 * the cause, and the cause cut at one of its own clause ends or before an " and " (`fitCause`: "…, because the file
 * declares an enum at line 1" without "and strip-only mode cannot handle enums"); when that leaves the cause no room,
 * what was tried (the longest cut of the text before the cause, at a clause's end, that leaves room) and the cause
 * after a colon, as a dead-end line often reads ("I ran X on Y: the file declares an enum"). Null when the sentence has
 * no such clause or nothing fits.
 */
function keepCause(sentence: string, maxChars: number): string | null {
  const c = causeAt(sentence);
  if (!c) return null;
  const tidy = (t: string) => t.replace(/[\s,;:—–-]+$/, "");
  const head = sentence.slice(0, c.at);
  const marker = sentence.slice(c.at, c.at + c.length);
  const cause = sentence.slice(c.at + c.length).replace(/[.!]+$/, "");
  const enough = (cut: string | null): cut is string => cut !== null && cut.length >= Math.min(30, cause.length);
  const whole = fitCause(cause, maxChars - head.length - marker.length);
  if (enough(whole)) return `${head}${marker}${whole}`;
  const ats = [...clauseEnds(head).filter((e) => e.strong).map((e) => e.at), ...[...head.matchAll(AND_CLAUSE)].map((m) => m.index!)];
  const heads = [...new Set(ats.map((at) => tidy(head.slice(0, at))))].filter((h) => h.length >= 20).sort((a, b) => b.length - a.length);
  for (const h of heads) {
    const cut = fitCause(cause, maxChars - h.length - 2);
    if (enough(cut)) return `${h}: ${cut}`;
  }
  return null;
}

/**
 * A works-now sentence longer than the line that says what was changed last, after ", so" ("The enum was the blocker,
 * since strip-only mode only erases types, so I replaced it with a const object"): what the sentence opens with (its
 * longest cut at a clause's end that leaves room) and the clause after ", so", as the dead end's "but" clause is kept.
 * Null when the sentence has no such clause or nothing fits.
 */
function keepResult(sentence: string, maxChars: number): string | null {
  const m = /,\s+so\s+(?=\S)/i.exec(sentence);
  if (!m || clauseEnds(sentence).every((e) => e.at !== m.index)) return null;
  const tidy = (t: string) => t.replace(/[\s,;:—–-]+$/, "");
  const head = sentence.slice(0, m.index);
  const result = sentence.slice(m.index + m[0].length).replace(/[.!]+$/, "");
  const heads = [head, ...clauseEnds(head).filter((e) => e.strong).map((e) => tidy(head.slice(0, e.at)))].filter((h) => h.length >= 20).sort((a, b) => b.length - a.length);
  for (const h of heads) {
    const cut = fitClause(result, maxChars - h.length - ", so ".length);
    if (cut && cut.length >= Math.min(30, result.length)) return `${h}, so ${cut}`;
  }
  return null;
}

/** " and " before a word that opens a clause ("… in memory at once and the upload server was killed"). */
const AND_CLAUSE = / and (?=(?:the|a|an|it|its|we|our|they|their|every|each|this|that|these|those|no|nothing)\b)/gi;

/**
 * `text` in at most `max` characters, ending on a complete clause: `clampLine`'s cut, or when that is a word cut ("…"),
 * the longest cut before an " and " that opens a clause (at least a third of `max`); else null.
 */
function fitClause(text: string, max: number): string | null {
  if (max < 12) return null;
  const cut = clampLine(text, max);
  if (!cut.endsWith("…")) return cut;
  const at = [...text.matchAll(AND_CLAUSE)].map((m) => m.index!).filter((i) => i <= max && i >= max / 3).pop();
  return at === undefined ? null : text.slice(0, at).replace(/[\s,;:]+$/, "");
}

/** A dead-end text without its closing ", so …" (what was done about it): what was tried, and why it failed. */
function withoutConclusion(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  const m = /[,;]\s+(?:so|which is why|and so)\s+[^,;:]*$/i.exec(t);
  return m && m.index >= 30 ? t.slice(0, m.index) : t;
}

/** What a dead-end line says was tried: the text before its first strong clause end (usually "X: why it failed"). */
function triedPart(line: string): string {
  const end = clauseEnds(line).find((e) => e.strong);
  return end ? line.slice(0, end.at) : line;
}

/**
 * The ways to shorten a dead-end line that keep its reason (more than what was tried), longest first: the whole line,
 * its clause ends, and before an " and " that opens a clause ("… for it to help and the credits doubled").
 */
function reasonCuts(text: string): string[] {
  const tried = triedPart(text).length;
  const tidy = (s: string) => s.replace(/[\s,;:—–-]+$/, "");
  const ats = [...clauseEnds(text).map((e) => e.at), ...[...text.matchAll(AND_CLAUSE)].map((m) => m.index!)];
  const cuts = new Set([text, ...ats.map((at) => tidy(text.slice(0, at)))]);
  return [...cuts].filter((c) => c.length > tried + 10).sort((a, b) => b.length - a.length);
}

/**
 * The local writer's line for a listed dead end tried again that failed for a new reason (docs/dead-ends.md): the
 * earlier line without its closing ", so …", then "retried:" and the new reason, so the line keeps both. The new
 * reason is the clause after the turn's first "but" ("the drift is gone, but its UDP wrapper copies every packet"),
 * else the turn's dead-end text after the sentence that names the attempt. When both do not fit, each is cut at a
 * clause's end. With `picked`, the sentences Jev picked (v0.6 part 3c), the turn's dead-end text is made from those.
 */
export function combineRetest(earlier: string, message: string, maxChars: number, picked?: string[]): string {
  const head = withoutConclusion(earlier);
  // The turn's dead-end text: from the sentences Jev picked when there are any (v0.6 part 3c), else from the turn.
  const text = picked?.length ? composeDeadEnd(picked, 4000) : extractDeadEnd(message, 4000);
  const sentences = deadEndSentences(text);
  const but = sentences.map(afterBut).find((r) => r !== null);
  const reason = withoutConclusion(but ?? (sentences.length > 1 && ATTEMPT.test(sentences[0]!) ? sentences.slice(1).join(" ") : text));
  const sep = "; retried: ";
  const room = maxChars - sep.length;
  const join = (h: string, r: string) => `${h.replace(/[.!]+$/, "")}${sep}${r}`;
  if (head.length + reason.length <= room) return join(head, reason);
  // The longest cut of the earlier line that keeps its reason and leaves room for the new reason, cut at a clause's end;
  // when none does, the new reason to half the line (at a word if it must) and the earlier line to what is left.
  const heads = reasonCuts(head);
  for (const h of heads) {
    const r = clampLine(reason, room - h.length);
    if (!r.endsWith("…") && r.length >= 30) return join(h, r);
  }
  const r = clampLine(reason, Math.ceil(room / 2));
  return join(heads.find((h) => h.length <= room - r.length) ?? clampLine(head, room - r.length), r);
}

/**
 * A line from the sentences Jev picked for a kind other than a dead end (v0.6 part 3c): the sentences as written, in text
 * order, when they fit in `maxChars` (after the leading filler goes), else the one that states the memory alone.
 */
export function joinPicked(picked: string[], main: string, maxChars: number): string {
  const joined = picked.join(" ");
  return stripFiller(joined).replace(/\s+/g, " ").trim().length <= maxChars ? joined : main;
}

const COMMON = new Set("the and for with that this from into was were are has have had not but its now can also then than when they them there".split(" "));
/** Distinct words of three letters or more, lowercased, without the most common ones: what two sentences share. */
const wordsOf = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !COMMON.has(w)));

/**
 * The local writer's line for a turn that makes a listed dead end work (docs/dead-ends.md): the reply's statements when
 * it has any (Claude made it work), else the user's, while they fit, past a bare "It works now.". The sentence that
 * names the approach of the dead end (the most words in common with the dead-end line's first clause, what was tried,
 * at least three) goes first, so the line says what works now and then what changed, and a later prompt about that
 * approach finds it. With `picked`, the sentences Jev picked (v0.6 part 3c), those are the statements; `roles` says
 * which of them states what works now: when they do not fit as written it goes first, so the cut falls on the other
 * sentence (a plan Claude wrote before the work, "I'll replace it with …", does not push out "I replaced …"), and when
 * it says what was changed last, after ", so", and is longer than the line, the cut keeps that clause (`keepResult`).
 */
export function extractWorksNow(message: string, maxChars: number, deadEnd?: string, picked?: string[], roles: PickedRoles = {}): string {
  let pool: string[];
  if (picked?.length && squashed(picked.join(" ")).length > maxChars) {
    // Jev's sentences do not fit as written: the one that states what works now leads, and the cut falls on the other
    // sentence or keeps the leading one's ", so …" clause.
    const ordered = leadWith(picked, roles.main);
    const lead = ordered[0]!;
    const line = clampLine(ordered.join(" "), maxChars);
    const so = /,\s+so\s+(?=\S)/i.exec(lead);
    const dropped = so !== null && !squashed(line).includes(squashed(lead.slice(so.index + so[0].length)).slice(0, 24));
    return (dropped ? keepResult(lead, maxChars) : null) ?? line;
  }
  if (picked?.length) pool = picked;
  else {
    const { roles: sides } = splitRoles(message);
    const reply = sides.filter((r) => r.role === "assistant").flatMap((r) => factsOf(r.text));
    pool = reply.length ? reply : sides.filter((r) => r.role === "user").flatMap((r) => factsOf(r.text));
    if (!pool.length) return extractFirstSentence(message, maxChars, "decision");
    if (pool.length > 1 && pool[0]!.split(/\s+/).length <= 3) pool = pool.slice(1);
  }
  if (deadEnd && pool.length > 1) {
    const firstEnd = clauseEnds(deadEnd).find((e) => e.strong);
    const de = wordsOf(firstEnd ? deadEnd.slice(0, firstEnd.at) : deadEnd);
    const shared = pool.map((s) => [...wordsOf(s)].filter((w) => de.has(w)).length);
    const best = shared.indexOf(Math.max(...shared));
    if (best > 0 && shared[best]! >= 3) pool = [pool[best]!, ...pool.filter((_, i) => i !== best)];
  }
  return clampLine(pool.join(" "), maxChars);
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

// Words after ", " that start a new clause, and conjunctions that start one without a comma.
const CLAUSE_WORD = /^(?:and|but|so|or|yet|which|who|whose|because|since|while|as|where|whereas|though|although|unless|until|after|before|when|then|leaving|making|meaning|causing|except|instead)\b/i;
// Without a comma, only words that always open a clause: "so", "but", "since" and "which" also do other work ("so slow",
// "not A but B", "since 2019", "the job which runs nightly").
const BARE_CLAUSE_WORD = /^(?:because|while|although|though|unless|until|whereas)\b/i;
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|approx|cf|no|fig|vol|ca)\.$/i;

/**
 * Where `t` may end on a complete clause (the cut is before position `at`): after the end of a sentence; before "; ",
 * ": " or a spaced dash; before a parenthesis that closes its clause (what follows it is punctuation or the end, not
 * more of the same clause); before ", " and a word that starts a clause ("but", "so", "which", …); before "because",
 * "although", "unless" and the like. Never inside parentheses, brackets, backticks or double quotes, so never inside a
 * code span or a URL. A bare ", " is a weak end: it may close an opening phrase, not a clause.
 */
function clauseEnds(t: string): { at: number; strong: boolean }[] {
  const out: { at: number; strong: boolean }[] = [];
  let depth = 0;
  let code = false;
  let quote = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === "`") {
      code = !code;
      continue;
    }
    if (code) continue;
    if (c === '"' || c === "“" || c === "”") {
      quote = c === "“" ? true : c === "”" ? false : !quote;
      continue;
    }
    if (c === "(" || c === "[") {
      if (depth === 0 && !quote && t[i - 1] === " " && closesItsClause(t, i)) out.push({ at: i - 1, strong: true });
      depth++;
      continue;
    }
    if (c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0 || quote) continue;
    const next = t.slice(i + 1);
    if (/[.!?]/.test(c) && (next === "" || next.startsWith(" ")) && !ABBREVIATION.test(t.slice(Math.max(0, i - 7), i + 1))) out.push({ at: i + 1, strong: true });
    else if ((c === ";" || c === ":") && next.startsWith(" ")) out.push({ at: i, strong: true });
    else if (c === " " && /^[—–-] /.test(next)) out.push({ at: i, strong: true });
    else if (c === "," && next.startsWith(" ")) out.push({ at: i, strong: CLAUSE_WORD.test(next.trimStart()) });
    else if (c === " " && t[i - 1] !== "," && BARE_CLAUSE_WORD.test(next)) out.push({ at: i, strong: true });
  }
  return out;
}

/** Does the parenthesis opening at `open` end its clause: is it followed by punctuation, a dash or the end of the text? */
function closesItsClause(t: string, open: number): boolean {
  let depth = 0;
  for (let j = open; j < t.length; j++) {
    if (t[j] === "(" || t[j] === "[") depth++;
    else if ((t[j] === ")" || t[j] === "]") && --depth === 0) return /^(?:$|[.,;:!?]|\s[—–-]\s)/.test(t.slice(j + 1));
  }
  return false;
}

/**
 * One line, at most `maxChars`, that ends on a complete clause: a longer text loses its trailing clauses (see
 * `clauseEnds`), never part of a word, a code span or a URL. The longest cut at a clause's end is taken; a bare comma
 * only when no clause ends in the first half of the line. Only a single clause longer than the line (no cut keeps a
 * quarter of it) is cut at a word, and then it ends in "…", as before.
 */
export function clampLine(text: string, maxChars: number): string {
  let t = text.replace(/\s+/g, " ").trim().replace(/^[-*•\s]+/, "");
  // Quotes or backticks around the whole line (as an LLM sometimes writes it) go; a code span at the start stays.
  const q = /^(["'`])(.*)\1$/s.exec(t);
  if (q && !q[2]!.includes(q[1]!)) t = q[2]!.trim();
  if (t.length <= maxChars) return t;
  const tidy = (s: string) => s.replace(/[\s,;:—–-]+$/, "").trim();
  const ends = clauseEnds(t)
    .map((e) => ({ strong: e.strong, text: tidy(t.slice(0, e.at)) }))
    .filter((e) => e.text.length > 0 && e.text.length <= maxChars);
  const longest = (xs: typeof ends) => xs.reduce<(typeof ends)[number] | null>((a, b) => (!a || b.text.length > a.text.length ? b : a), null);
  const strong = longest(ends.filter((e) => e.strong));
  const any = longest(ends);
  const pick = strong && strong.text.length >= maxChars / 2 ? strong : any;
  if (pick && pick.text.length >= maxChars / 4) return pick.text;
  return cutAtWord(t, maxChars);
}

/**
 * A single clause longer than the line: cut at a word, never inside a URL (a URL that would straddle the limit is
 * dropped whole, unless it is the only token, in which case it is kept intact), and end in "…".
 */
function cutAtWord(t: string, maxChars: number): string {
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
