#!/usr/bin/env node
// Benchmark: current LLMs as the memory decider vs jevmem (auto mode), on the same eval set with the same state.
//
//   node scripts/bench-llm.mjs [--set heldout|regression] [--models astra,luna,fable,opus,gemini,grok,jevmem] [--out results/….json] [--sequential] [--limit N]
//
// Every decider gets the state from lib.buildDecideState, the function jevmem's decide uses, so the input
// (user message, assistant reply when included, previous turns, existing memories) is identical by construction.
// Every decider gets one unscored warm-up call first. All models run concurrently by default, so they share one time window.
//
// Keys (a model is SKIPPED, never estimated, when its key is missing):
//   OPENAI_API_KEY (gpt-6-astra, gpt-6-luna), ANTHROPIC_API_KEY (claude-fable-5-1, claude-opus-5-5),
//   GEMINI_API_KEY or GOOGLE_API_KEY (gemini-3.8-flash), XAI_API_KEY (grok-4.7), TYPESAFE_API_KEY (jevmem).
//   Alternatively OPENROUTER_API_KEY routes all six LLMs through OpenRouter's OpenAI-compatible endpoint.
// Same system prompt for every model: bench/system-prompt.md. Structured output / JSON mode is used where the provider has one.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const today = new Date().toISOString().slice(0, 10);
const SET = opt("--set", "heldout");
const SET_FILE = { heldout: "eval/heldout.jsonl", regression: "eval/transcript.jsonl" }[SET];
if (!SET_FILE) throw new Error(`unknown --set ${SET}`);
const OUT = opt("--out", `results/bench-${SET}-${today}.json`);
const ONLY = opt("--models", "astra,luna,fable,opus,gemini,grok,jevmem").split(",");
const SEQUENTIAL = args.includes("--sequential");
const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const SYSTEM = fs.readFileSync(path.resolve("bench/system-prompt.md"), "utf8");
const turns = fs
  .readFileSync(path.resolve(SET_FILE), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .slice(0, Number(opt("--limit", "100000"))); // --limit N: smoke tests only; published runs use the whole set
const DEFAULT_EXISTING = [{ id: "sqlite1", kind: "decision", text: "Use SQLite as the single-file primary store; no server" }];
const KINDS = ["decision", "constraint", "preference", "bug", "architecture", "todo", "none"];
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["save", "kind", "contradicts_id", "injection"],
  properties: {
    save: { type: "boolean" },
    kind: { type: "string", enum: KINDS },
    contradicts_id: { type: ["string", "null"] },
    injection: { type: "boolean" },
  },
};

// Pricing: USD per million tokens, read from the providers' pricing pages on PRICING_DATE.
const PRICING_DATE = "2026-09-23";
const MODELS = {
  astra: { label: "GPT-6 Astra", id: "gpt-6-astra", provider: "openai", input: 10, output: 50, source: "https://developers.openai.com/api/docs/pricing (standard tier)", openrouter: "openai/gpt-6-astra" },
  luna: { label: "GPT-6 Luna", id: "gpt-6-luna", provider: "openai", input: 0.1, output: 0.5, source: "https://developers.openai.com/api/docs/pricing (standard tier)", openrouter: "openai/gpt-6-luna" },
  fable: { label: "Claude Fable 5.1", id: "claude-fable-5-1", provider: "anthropic", input: 10, output: 50, source: "https://platform.claude.com/docs/en/about-claude/pricing", openrouter: "anthropic/claude-fable-5.1" },
  opus: { label: "Claude Opus 5.5", id: "claude-opus-5-5", provider: "anthropic", input: 4, output: 20, source: "https://platform.claude.com/docs/en/about-claude/pricing", openrouter: "anthropic/claude-opus-5.5" },
  gemini: { label: "Gemini 3.8 Flash", id: "gemini-3.8-flash", provider: "gemini", input: 0.75, output: 3.75, source: "https://ai.google.dev/gemini-api/docs/pricing (rate valid through 2026-12-31)", openrouter: "google/gemini-3.8-flash" },
  grok: { label: "Grok 4.7", id: "grok-4.7", provider: "xai", input: 2, output: 6, source: "https://docs.x.ai/docs/models (xAI list price; OpenRouter listed $1.60 / $4.80 on the pricing date, the higher list price is used)", openrouter: "x-ai/grok-4.7" },
  jevmem: { label: "jevmem (auto, jev-latest)", id: "jev-latest", provider: "jevmem", input: 0.042, source: "https://typesafe.ai/blog/introducing-system-one-models-and-jev (read 2026-09-23): $0.042 per million input tokens, output tokens free)", output: 0 },
};

function keyFor(provider) {
  if (process.env.OPENROUTER_API_KEY && provider !== "jevmem") return { kind: "openrouter", key: process.env.OPENROUTER_API_KEY };
  if (provider === "openai" && process.env.OPENAI_API_KEY) return { kind: "openai", key: process.env.OPENAI_API_KEY };
  if (provider === "gemini" && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) return { kind: "gemini", key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY };
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) return { kind: "anthropic", key: process.env.ANTHROPIC_API_KEY };
  if (provider === "xai" && process.env.XAI_API_KEY) return { kind: "xai", key: process.env.XAI_API_KEY };
  if (provider === "jevmem" && process.env.TYPESAFE_API_KEY) return { kind: "jevmem", key: "set" };
  return null;
}
const KEY_HINT = { openai: "OPENAI_API_KEY or OPENROUTER_API_KEY", gemini: "GEMINI_API_KEY (or GOOGLE_API_KEY) or OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY or OPENROUTER_API_KEY", xai: "XAI_API_KEY or OPENROUTER_API_KEY", jevmem: "TYPESAFE_API_KEY" };

/** The decide input for a turn, shared by jevmem and the LLMs. */
const inputFor = (t) => ({ userMessage: t.user, assistantReply: t.assistant, recentContext: t.previous, existingMemories: t.existing ?? DEFAULT_EXISTING });
/** The exact state jevmem sends Jev for this turn (same function decide calls). */
const stateFor = (t) => lib.buildDecideState(inputFor(t)).state;
const WARMUP_STATE = { user_message: "warm-up call, not scored", previous_turns: null, existing_memories: [] };

function validate(obj) {
  if (!obj || typeof obj !== "object") return "not an object";
  const keys = Object.keys(obj).sort().join(",");
  if (keys !== "contradicts_id,injection,kind,save") return `keys ${keys}`;
  if (typeof obj.save !== "boolean") return "save not boolean";
  if (!KINDS.includes(obj.kind)) return `kind ${obj.kind}`;
  if (obj.contradicts_id !== null && typeof obj.contradicts_id !== "string") return "contradicts_id type";
  if (typeof obj.injection !== "boolean") return "injection not boolean";
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry 429/5xx with exponential backoff (honouring Retry-After); a request that still fails after 6 tries counts as malformed. */
async function fetchWithRetry(url, init, counter) {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, init);
    if (r.ok || attempt >= 6 || (r.status !== 429 && r.status < 500)) return r;
    counter.retries++;
    const ra = Number(r.headers.get("retry-after"));
    await sleep(ra > 0 ? ra * 1000 : delay);
    delay = Math.min(delay * 2, 60_000);
  }
}

/** Models sometimes wrap JSON in prose or fences; take the text from the first `{` to the last `}`. Schema validation still applies. */
function extractJson(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? text.slice(a, b + 1) : text;
}

// Output cap high enough that reasoning models are not truncated (their reasoning tokens count against it).
const MAX_OUTPUT = 4000;

async function callOpenAICompatible(base, key, model, state, counter) {
  const r = await fetchWithRetry(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(state) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "memory_decision", strict: true, schema: SCHEMA } },
      max_completion_tokens: MAX_OUTPUT,
    }),
  }, counter);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content ?? "", input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0, upstream: j.provider ?? null };
}

async function callGemini(key, model, state, counter) {
  const r = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(state) }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: SCHEMA, maxOutputTokens: MAX_OUTPUT },
    }),
  }, counter);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return {
    text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "",
    input: j.usageMetadata?.promptTokenCount ?? 0,
    output: j.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

let anthropicClient = null;
async function callAnthropic(key, model, state) {
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropicClient = new Anthropic({ apiKey: key });
  }
  const res = await anthropicClient.messages.create({
    model,
    max_tokens: MAX_OUTPUT,
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(state) }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 };
}

function score(rows) {
  const n = rows.length;
  const ok = rows.filter((r) => !r.malformed);
  const saveOk = rows.filter((r) => !r.malformed && r.got.save === r.want.save).length;
  const kindOk = rows.filter((r) => !r.malformed && r.got.save === r.want.save && (!r.want.save || r.got.kind === r.want.kind)).length;
  const contra = rows.filter((r) => r.want.contradicts);
  const contraOk = contra.filter((r) => !r.malformed && r.got.contradicts_id === r.want.contradicts).length;
  const inj = rows.filter((r) => r.want.injection);
  const injNotSaved = inj.filter((r) => !r.malformed && r.got.save === false).length;
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
  const cost = rows.reduce((a, r) => a + r.costUsd, 0);
  return {
    turns: n,
    save_skip_accuracy: saveOk / n,
    save_kind_accuracy: kindOk / n,
    save_skip_correct: saveOk,
    save_kind_correct: kindOk,
    contradictions_detected: `${contraOk}/${contra.length}`,
    // Contradiction ids named on turns that contradict nothing (or a different id): not counted in the line above.
    false_contradictions: rows.filter((r) => !r.malformed && r.got?.contradicts_id && r.got.contradicts_id !== r.want.contradicts).length,
    injection_turns_not_saved: `${injNotSaved}/${inj.length}`,
    malformed_rate: (n - ok.length) / n,
    malformed: n - ok.length,
    // Latency percentiles over well-formed answers only.
    p50_ms: pct(0.5),
    p95_ms: pct(0.95),
    cost_per_decision_usd: cost / n,
    cost_per_300_turns_usd: (cost / n) * 300,
    total_input_tokens: rows.reduce((a, r) => a + r.input, 0),
    total_output_tokens: rows.reduce((a, r) => a + r.output, 0),
  };
}

const PATH = {
  openrouter: (m) => `OpenRouter chat/completions (openrouter.ai/api/v1, model ${m.openrouter}) → ${m.provider}; OpenRouter picks the upstream host`,
  openai: () => "direct HTTPS to api.openai.com/v1",
  xai: () => "direct HTTPS to api.x.ai/v1",
  gemini: () => "direct HTTPS to generativelanguage.googleapis.com",
  anthropic: () => "direct HTTPS to api.anthropic.com (Anthropic SDK)",
  jevmem: () => `direct HTTPS to ${process.env.TYPESAFE_BASE_URL ?? "the TypeSafe API default base URL"} (POST /v1/systemone), in-process client, cache off`,
};

async function callLLM(m, auth, state, counter) {
  return auth.kind === "openrouter"
    ? callOpenAICompatible("https://openrouter.ai/api/v1", auth.key, m.openrouter, state, counter)
    : auth.kind === "openai"
      ? callOpenAICompatible("https://api.openai.com/v1", auth.key, m.id, state, counter)
      : auth.kind === "xai"
        ? callOpenAICompatible("https://api.x.ai/v1", auth.key, m.id, state, counter)
        : auth.kind === "gemini"
          ? callGemini(auth.key, m.id, state, counter)
          : callAnthropic(auth.key, m.id, state);
}

async function runModel(name) {
  const m = MODELS[name];
  const auth = keyFor(m.provider);
  if (!auth) return { ...m, status: "skipped", reason: `no key in env (set ${KEY_HINT[m.provider]})` };
  const rows = [];
  // jevmem: count HTTP attempts through the SDK so SDK-level retries are recorded like the LLMs' 429/5xx retries.
  let fetches = 0;
  const countingFetch = (u, i) => {
    fetches++;
    return fetch(u, i);
  };
  const jev = m.provider === "jevmem" ? lib.createJev({ noLogFile: true, cache: false, fetch: countingFetch }) : null;
  const warm = { policy: "one unscored call before the first scored turn (same client / connection)", ms: null, ok: false };
  const w0 = performance.now();
  try {
    if (jev) await lib.decide(jev, { userMessage: "warm-up call, not scored", existingMemories: [] });
    else await callLLM(m, auth, WARMUP_STATE, { retries: 0 });
    warm.ok = true;
  } catch (e) {
    warm.error = String(e.message).slice(0, 120);
  }
  warm.ms = Math.round(performance.now() - w0);
  const startedAt = new Date().toISOString();
  const upstreams = {};
  for (const t of turns) {
    const state = stateFor(t);
    const want = { save: t.label.save, kind: t.label.kind, contradicts: t.contradicts ?? null, injection: /injection/.test(t.tag) };
    const counter = { retries: 0 };
    const t0 = performance.now();
    let got = null;
    let malformed = null;
    let input = 0;
    let output = 0;
    let raw = "";
    try {
      if (m.provider === "jevmem") {
        const f0 = fetches;
        const l0 = jev.log.length;
        const d = await lib.decide(jev, inputFor(t), { tiers: { mode: "auto" } });
        counter.retries = Math.max(0, fetches - f0 - (jev.log.length - l0));
        got = { save: d.save, kind: d.save ? d.kind : "none", contradicts_id: d.contradiction ? d.touchesMemoryId : null, injection: d.families.injection >= d.thresholds.injectionMax };
        input = d.usage.inputTokens;
        output = d.usage.outputTokens;
      } else {
        const res = await callLLM(m, auth, state, counter);
        raw = res.text;
        input = res.input;
        output = res.output;
        if (res.upstream) upstreams[res.upstream] = (upstreams[res.upstream] ?? 0) + 1;
        try {
          got = JSON.parse(extractJson(raw));
        } catch {
          malformed = raw.trim() ? "invalid JSON" : `empty output (${output} output tokens)`;
        }
        if (got && !malformed) malformed = validate(got);
      }
    } catch (e) {
      malformed = `request failed: ${String(e.message).slice(0, 120)}`;
    }
    const ms = Math.round(performance.now() - t0);
    const costUsd = (input * m.input + output * m.output) / 1e6;
    rows.push({ tag: t.tag, want, got, malformed, ms, retries: counter.retries, input, output, costUsd, raw: raw.slice(0, 300) });
    if (m.provider !== "jevmem") await sleep(1000); // pace: OpenRouter RPM limits (not counted in latency)
  }
  const finishedAt = new Date().toISOString();
  process.stderr.write(`  ${m.label}: done ${rows.length}/${turns.length}\n`);
  return {
    ...m,
    status: "ran",
    via: auth.kind,
    network_path: PATH[auth.kind](m),
    ...(Object.keys(upstreams).length ? { upstream_hosts: upstreams } : {}),
    reasoning: m.provider === "jevmem" ? "n/a" : "provider default (not set)",
    warm_up: warm,
    started_at: startedAt,
    finished_at: finishedAt,
    retries_total: rows.reduce((a, r) => a + r.retries, 0),
    metrics: score(rows),
    rows,
  };
}

const runStarted = new Date().toISOString();
const names = ONLY.filter((n) => MODELS[n]);
const results = {};
if (SEQUENTIAL) for (const n of names) results[n] = await runModel(n);
else for (const [n, r] of (await Promise.all(names.map(async (n) => [n, await runModel(n)])))) results[n] = r;
const runFinished = new Date().toISOString();
let commit = null;
try {
  const { execSync } = await import("node:child_process");
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {
  /* not a git checkout */
}
const out = {
  kind: "bench",
  date: today,
  started_at: runStarted,
  finished_at: runFinished,
  jevmem_version: JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version,
  commit,
  machine: `${process.platform} ${process.arch}, node ${process.version}`,
  eval_set: SET_FILE,
  turns: turns.length,
  system_prompt: "bench/system-prompt.md",
  concurrency: SEQUENTIAL ? "models one after another" : "all models concurrently (each model's turns in order), so every model shares one time window",
  pricing_date: PRICING_DATE,
  pricing_sources: Object.fromEntries(Object.values(MODELS).map((m) => [m.id, m.source])),
  cost_method: "LLMs: input × input price + output × output price (provider list prices). jevmem: input tokens × $0.042/M, output free.",
  note: "Every decider gets the state from buildDecideState (the function jevmem's decide calls): user message, the assistant reply when jevmem would include it, previous turns when the turn has them, and the existing memories with ids. LLMs get bench/system-prompt.md (zero-shot, no examples) and answer strict JSON via the provider's structured-output mode with a 4,000-token output cap (reasoning included) at the provider's default reasoning setting; the text from the first `{` to the last `}` is validated against the schema, so prose around it is tolerated but a wrong shape is not. jevmem gets its own Jev questions, which include few-shot examples. Every decider makes one unscored warm-up call first. 429/5xx are retried up to 6 times with backoff; retries are counted per row and latency includes them. A malformed answer counts as wrong. Models without a key are skipped, not estimated. Through OpenRouter, token counts come from OpenRouter's usage report and prices are the providers' list prices (Grok 4.7: xAI's $2 / $6, higher than OpenRouter's $1.60 / $4.80 on the pricing date).",
  models: results,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
console.log(`\nbench ${today}  set=${SET_FILE} (n=${turns.length}, same state per model, ${out.machine}), ${runStarted} → ${runFinished}`);
console.log("model                         status   save/skip  save+kind  contra  inj-blocked  malformed   p50      p95      $/decision   $/300 turns  retries");
for (const r of Object.values(results)) {
  if (r.status !== "ran") {
    console.log(`${r.label.padEnd(30)}skipped  ${r.reason}`);
    continue;
  }
  const s = r.metrics;
  console.log(
    `${r.label.padEnd(30)}ran      ${pct(s.save_skip_accuracy)}     ${pct(s.save_kind_accuracy)}     ${s.contradictions_detected.padEnd(6)}  ${s.injection_turns_not_saved.padEnd(11)}  ${pct(s.malformed_rate)}   ${String(s.p50_ms).padStart(5)} ms ${String(s.p95_ms).padStart(5)} ms  $${s.cost_per_decision_usd.toFixed(6)}   $${s.cost_per_300_turns_usd.toFixed(4)}      ${r.retries_total}`,
  );
}
console.log(`\nwritten ${OUT}`);
