import fs from "node:fs";
import path from "node:path";
import { TypeSafeClient, type Questions, type SystemOneResult, type EntryType } from "@typesafe-ai/sdk";
import { scrubSecrets } from "./scrub.js";

export interface JevCallOptions {
  /** Short label written to the log, e.g. `decide`, `recall`, `search`, `audit`. */
  label: string;
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

export function summarizeLog(entries: JevLogEntry[]): { calls: number; ok: number; avgLatencyMs: number; p50LatencyMs: number; totalTokens: number; totalCostUsd: number } {
  const ok = entries.filter((e) => e.ok);
  const lat = ok.map((e) => e.latencyMs).sort((a, b) => a - b);
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)]! : 0;
  return {
    calls: entries.length,
    ok: ok.length,
    avgLatencyMs: Math.round(avg),
    p50LatencyMs: p50,
    totalTokens: ok.reduce((a, e) => a + e.inputTokens + e.outputTokens, 0),
    totalCostUsd: ok.reduce((a, e) => a + e.costUsd, 0),
  };
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
    defaultModel: opts.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
    timeout: opts.timeoutMs ?? 10_000,
    // The hook path has its own hard deadline; the SDK's retries would blow through it.
    retry: { maxRetries: 1 },
    logLevel: "off",
    fetch: opts.fetch,
  });
  const usdPerM = opts.usdPerMillionTokens ?? 0.042;
  const log: JevLogEntry[] = [];
  return {
    log,
    async call(state, questions, callOpts) {
      const t0 = performance.now();
      const base = { ts: new Date().toISOString(), label: callOpts.label, questions: Object.keys(questions).length };
      try {
        const res = await client.systemOne(
          { state: scrubState(state), questions },
          { timeout: callOpts.timeoutMs ?? opts.timeoutMs, signal: callOpts.signal, retry: callOpts.timeoutMs ? { maxRetries: 0 } : undefined },
        );
        const tokens = res.usage.input_tokens + res.usage.output_tokens;
        const entry: JevLogEntry = {
          ...base,
          ok: true,
          latencyMs: Math.round(performance.now() - t0),
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          costUsd: (tokens / 1_000_000) * usdPerM,
          model: res.model,
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
