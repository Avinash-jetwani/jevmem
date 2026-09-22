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
        max_completion_tokens: 120,
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

/** Deterministic fallback when no LLM key is present: first sentence, trimmed to `maxChars`. */
export function extractFirstSentence(message: string, maxChars: number): string {
  const clean = scrubSecrets(message)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(^|\n)\s*(?:USER|ASSISTANT):\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  // Prefer the first sentence that has some substance.
  const sentences = clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const first = sentences.find((s) => s.trim().length >= 12) ?? sentences[0] ?? clean;
  return clampLine(first, maxChars);
}

export function clampLine(text: string, maxChars: number): string {
  let t = text.replace(/\s+/g, " ").trim().replace(/^["'`\-*•\s]+|["'`\s]+$/g, "");
  if (t.length > maxChars) t = t.slice(0, maxChars - 1).replace(/\s+\S*$/, "") + "…";
  return t;
}
