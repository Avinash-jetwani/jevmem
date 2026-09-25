import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TypeSafeClient, type Questions, type SystemOneResult, type EntryType } from "@typesafe-ai/sdk";
import { scrubSecrets } from "./scrub.js";

export interface JevCallOptions {
  /** Short label written to the log, e.g. `decide`, `recall`, `search`, `audit`. */
  label: string;
  /** Decide tier (1 = broad set, 2 = atomic set). Part of the cache key and the log. */
  tier?: 1 | 2;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JevLogEntry {
  ts: string;
  label: string;
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  questions: number;
  model?: string;
  error?: string;
  /** True when the answer came from `.jevmem/cache/` and no request was made. */
  cacheHit?: boolean;
  /** Where the call ran, when known. */
  via?: "inline" | "daemon";
  tier?: 1 | 2;
  /**
   * Set on entries that record an event rather than a Jev call (the poisoning gate withholding a line, the retry
   * queue). They carry no latency or cost and are left out of every latency/cost summary.
   */
  event?: "withheld" | "queued" | "retried" | "dequeued" | "dropped" | "plugin-standdown";
  memoryId?: string;
  injection?: number;
  detail?: string;
}

/** Anything that can answer a batch of Jev questions. The real client and test mocks both implement it. */
export interface JevCaller {
  call<Q extends Questions>(state: EntryType, questions: Q, opts: JevCallOptions): Promise<SystemOneResult<Q>>;
  /** Log entries recorded by this caller (most recent last). */
  readonly log: JevLogEntry[];
}

export interface CreateJevOptions {
  apiKey?: string;
  model?: string;
  root?: string;
  usdPerMillionTokens?: number;
  /** Default per-call timeout; per-call `timeoutMs` overrides. */
  timeoutMs?: number;
  /** Set to disable writing `.jevmem/log.jsonl`. */
  noLogFile?: boolean;
  /** Cache identical (model, tier, state, questions) → answers under `.jevmem/cache/`. Needs `root`. Default true. */
  cache?: boolean;
  /** Send `zeroDataRetention: true` in every request body. `"auto"`: only when the base URL is a Vercel AI Gateway. */
  zeroDataRetention?: boolean | "auto";
  baseURL?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function hasJevKey(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

function scrubState(state: EntryType): EntryType {
  if (state === null) return null;
  if (typeof state === "string") return scrubSecrets(state);
  return JSON.parse(scrubSecrets(JSON.stringify(state)));
}

export function appendLog(root: string, entry: JevLogEntry): void {
  try {
    const dir = path.join(root, ".jevmem");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    /* logging must never break the hook */
  }
}

export interface LogSummary {
  calls: number;
  ok: number;
  cacheHits: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  /** USD per calendar day, keyed by YYYY-MM-DD. */
  costPerDay: Record<string, number>;
  /** Decide calls by tier, and the share of tier-1 turns that escalated to tier 2 (null when tier 1 never ran). */
  decideTier1: number;
  decideTier2: number;
  escalationRate: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** Latency percentiles exclude cache hits (they measure the network, not the cache). Cost includes only real calls. */
export function summarizeLog(entries: JevLogEntry[]): LogSummary {
  entries = entries.filter((e) => !e.event);
  const ok = entries.filter((e) => e.ok);
  const hits = ok.filter((e) => e.cacheHit);
  const net = ok.filter((e) => !e.cacheHit);
  const lat = net.map((e) => e.latencyMs).sort((a, b) => a - b);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;
  const costPerDay: Record<string, number> = {};
  for (const e of net) {
    const d = e.ts.slice(0, 10);
    costPerDay[d] = (costPerDay[d] ?? 0) + e.costUsd;
  }
  const decideTier1 = ok.filter((e) => e.label === "decide" && e.tier === 1).length;
  const decideTier2 = ok.filter((e) => e.label === "decide" && e.tier === 2).length;
  return {
    calls: entries.length,
    ok: ok.length,
    decideTier1,
    decideTier2,
    escalationRate: decideTier1 ? Math.min(1, decideTier2 / decideTier1) : null,
    cacheHits: hits.length,
    cacheHitRate: ok.length ? hits.length / ok.length : 0,
    avgLatencyMs: Math.round(avg),
    p50LatencyMs: percentile(lat, 0.5),
    p95LatencyMs: percentile(lat, 0.95),
    totalTokens: net.reduce((a, e) => a + e.inputTokens + e.outputTokens, 0),
    totalCostUsd: net.reduce((a, e) => a + e.costUsd, 0),
    costPerDay,
  };
}

// ---------------------------------------------------------------------------------------------
// Answer cache

export function cacheDir(root: string): string {
  return path.join(root, ".jevmem", "cache");
}

export function cacheKey(model: string, state: EntryType, questions: Questions, tier?: number): string {
  return crypto.createHash("sha256").update(JSON.stringify({ model, tier: tier ?? null, state, questions })).digest("hex").slice(0, 40);
}

function readCache(root: string, key: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir(root), key + ".json"), "utf8"));
  } catch {
    return null;
  }
}

let writesSincePrune = 0;
function writeCache(root: string, key: string, value: unknown): void {
  try {
    const dir = cacheDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, key + ".json"), JSON.stringify(value));
    if (++writesSincePrune >= 50) {
      writesSincePrune = 0;
      pruneCache(root, 1000);
    }
  } catch {
    /* cache is best effort */
  }
}

/** Keep at most `max` entries; drops the oldest fifth when over. */
export function pruneCache(root: string, max: number): number {
  try {
    const dir = cacheDir(root);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length <= max) return 0;
    const withTime = files.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    const drop = withTime.slice(0, Math.max(1, Math.floor(files.length / 5)));
    for (const d of drop) fs.unlinkSync(path.join(dir, d.f));
    return drop.length;
  } catch {
    return 0;
  }
}

export function isVercelGateway(baseURL: string | undefined): boolean {
  const u = (baseURL ?? process.env.TYPESAFE_BASE_URL ?? "").toLowerCase();
  return u.includes("ai-gateway.vercel.sh") || u.includes("gateway.vercel") || u.includes("vercel.sh");
}

export function readLog(root: string): JevLogEntry[] {
  try {
    return fs
      .readFileSync(path.join(root, ".jevmem", "log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JevLogEntry);
  } catch {
    return [];
  }
}

/** Real Jev caller: one `POST /v1/systemone` per `call`, secrets scrubbed, latency and cost logged. */
export function createJev(opts: CreateJevOptions = {}): JevCaller {
  const client = new TypeSafeClient({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    defaultModel: opts.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
    timeout: opts.timeoutMs ?? 10_000,
    // The hook path has its own hard deadline; the SDK's retries would blow through it.
    retry: { maxRetries: 1 },
    logLevel: "off",
    fetch: opts.fetch,
  });
  const usdPerM = opts.usdPerMillionTokens ?? 0.042;
  const useCache = (opts.cache ?? true) && Boolean(opts.root) && process.env.JEVMEM_CACHE !== "0";
  const zdr = opts.zeroDataRetention === true || (opts.zeroDataRetention !== false && isVercelGateway(opts.baseURL));
  const log: JevLogEntry[] = [];
  return {
    log,
    async call(state, questions, callOpts) {
      const t0 = performance.now();
      const base = { ts: new Date().toISOString(), label: callOpts.label, questions: Object.keys(questions).length, ...(callOpts.tier ? { tier: callOpts.tier } : {}) };
      const safeState = scrubState(state);
      const key = useCache && callOpts.label !== "prewarm" ? cacheKey(client.defaultModel, safeState, questions, callOpts.tier) : null;
      if (key) {
        const hit = readCache(opts.root!, key) as SystemOneResult<any> | null;
        if (hit) {
          const entry: JevLogEntry = { ...base, ok: true, latencyMs: Math.round(performance.now() - t0), inputTokens: hit.usage?.input_tokens ?? 0, outputTokens: hit.usage?.output_tokens ?? 0, costUsd: 0, model: hit.model, cacheHit: true };
          log.push(entry);
          if (opts.root && !opts.noLogFile) appendLog(opts.root, entry);
          return { ...hit, cacheHit: true } as any;
        }
      }
      try {
        const res = await client.systemOne(
          // Extra request fields are forwarded by the SDK; Vercel AI Gateway honours `zeroDataRetention`.
          { state: safeState, questions, ...(zdr ? { zeroDataRetention: true } : {}) } as any,
          { timeout: callOpts.timeoutMs ?? opts.timeoutMs, signal: callOpts.signal, retry: callOpts.timeoutMs ? { maxRetries: 0 } : undefined },
        );
        if (key) writeCache(opts.root!, key, { model: res.model, answers: res.answers, usage: res.usage });
        // Jev is billed on input tokens only ($0.042/M by default; output tokens are free per TypeSafe's launch post).
        const entry: JevLogEntry = {
          ...base,
          ok: true,
          latencyMs: Math.round(performance.now() - t0),
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          costUsd: (res.usage.input_tokens / 1_000_000) * usdPerM,
          model: res.model,
          cacheHit: false,
        };
        log.push(entry);
        if (opts.root && !opts.noLogFile) appendLog(opts.root, entry);
        return res;
      } catch (err) {
        const entry: JevLogEntry = {
          ...base,
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        };
        log.push(entry);
        if (opts.root && !opts.noLogFile) appendLog(opts.root, entry);
        throw err;
      }
    },
  };
}
