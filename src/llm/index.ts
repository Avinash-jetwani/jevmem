import { scrubSecrets } from "../scrub.js";

export type WriterProvider = "openai" | "anthropic" | "none";

export interface WriterConfig {
  provider: "auto" | WriterProvider;
  model?: string;
  timeoutMs: number;
}

export interface ResolvedWriter {
  provider: WriterProvider;
  model: string;
}

export const DEFAULT_MODELS: Record<Exclude<WriterProvider, "none">, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

/** Pick the writer from `JEVMEM_WRITER`, then config, then whichever key is present. */
export function resolveWriter(cfg: WriterConfig, env: NodeJS.ProcessEnv = process.env): ResolvedWriter {
  const forced = (env.JEVMEM_WRITER?.trim().toLowerCase() || cfg.provider) as WriterConfig["provider"];
  const model = env.JEVMEM_WRITER_MODEL?.trim() || cfg.model;
  const pick = (p: WriterProvider): ResolvedWriter => ({ provider: p, model: model ?? (p === "none" ? "" : DEFAULT_MODELS[p]) });
  if (forced === "openai" || forced === "anthropic" || forced === "none") return pick(forced);
  if (env.OPENAI_API_KEY?.trim()) return pick("openai");
  if (env.ANTHROPIC_API_KEY?.trim()) return pick("anthropic");
  return pick("none");
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

/**
 * Deterministic fallback when no LLM key is present: the most relevant declarative sentence, trimmed to `maxChars`.
 * Skips questions, prefers sentences that carry cue words for the memory kind, and for findings (bug, architecture)
 * prefers the assistant's text over the user's.
 */
export function extractFirstSentence(message: string, maxChars: number, kind?: string): string {
  const clean = scrubSecrets(message).replace(/```[\s\S]*?```/g, " ");
  const roles: { role: "user" | "assistant"; text: string }[] = [];
  for (const chunk of clean.split(/(?=^|\n)\s*(?=(?:USER|ASSISTANT):)/)) {
    const m = /^\s*(USER|ASSISTANT):\s*([\s\S]*)$/.exec(chunk);
    if (m) roles.push({ role: m[1] === "USER" ? "user" : "assistant", text: m[2]! });
    else if (chunk.trim()) roles.push({ role: "user", text: chunk });
  }
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

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+|^www\.\S+/i;

const FILLER_LABEL = /^(?:decision|decided|update|note|fyi|reminder|change of plan|heads[ -]?up|quick note|context)\s*:\s*/i;
const FILLER_WORD = /^(?:actually|so|ok|okay|also|well|alright|right|anyway|basically|honestly|just so you know|to be clear|for the record|btw|by the way)\b/i;
const SEP = /^\s*(?:[,:;]|[-–—])\s*/;

/** Drop leading conversational filler ("Decision:", "Actually,", "So,", "OK,"); keep the rest verbatim, capitalised. */
export function stripFiller(line: string): string {
  let t = line.trim();
  // Peel filler from the front: "Label:" prefixes, and filler words followed by punctuation or by another filler word.
  for (;;) {
    const label = FILLER_LABEL.exec(t);
    if (label) {
      t = t.slice(label[0].length).trimStart();
      continue;
    }
    const word = FILLER_WORD.exec(t);
    if (!word) break;
    const rest = t.slice(word[0].length);
    const sep = SEP.exec(rest);
    if (sep) t = rest.slice(sep[0].length).trimStart();
    else if (/^\s+/.test(rest) && (FILLER_WORD.test(rest.trimStart()) || FILLER_LABEL.test(rest.trimStart()))) t = rest.trimStart();
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
