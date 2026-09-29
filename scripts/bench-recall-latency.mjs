#!/usr/bin/env node
// Why do the prompt hook's Jev calls run late (v0.6 part 3b)? Jev latency by request shape, on the retrieval dev set.
//
//   node scripts/bench-recall-latency.mjs [--rounds 40] [--file dev-large] [--shapes one,split2,...] [--out results/...json]
//
// Every round takes the next prompt of the file and sends each shape once, the shapes in a new random order each round,
// so they meet the same moments of the Jev API. A shape is a set of requests sent at the same time; its time is the
// slowest request's. Shapes (all built as recall builds them: the query, each live line once in the state with the lines
// it replaced, bare-id choice, one relevance noul per line):
//   one        one request with every live line (main's recall, part 3)
//   splitN     N requests at once, each with 1/N of the lines (its own state, choice and nouls)
//   stateonly  one request with every line in the state but only the choice (the state's share of the time)
//   noulsN     one request with every line in the state but the nouls of 1/N of the lines (the questions' share)
//   v059       0.5.9's request: the 60 lines sharing the most words with the prompt, each line's text in the choice
// Timeout per request: 8 s (so the tail is seen, not cut at the hook's 2 s). Cost: input tokens × $0.042 per million.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const ROUNDS = Number(opt("--rounds", "40"));
const FILE_ID = opt("--file", "dev-large");
const SET_FILE = opt("--set-file", "eval/recall-dev.jsonl");
const SHAPES = opt("--shapes", "one,split2,split3,split4,split6,stateonly,nouls4").split(",");
const OUT = opt("--out", `results/recall-latency-${new Date().toISOString().slice(0, 10)}-${FILE_ID}.json`);
const TIMEOUT = Number(opt("--timeout-ms", "8000"));
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");

const lib = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const { choice } = await import(pathToFileURL(path.resolve("node_modules/@typesafe-ai/sdk/dist/index.mjs")).href);
const rows = fs.readFileSync(SET_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const f = rows.find((r) => r.row === "file" && r.id === FILE_ID);
const byKey = new Map(f.lines.map((l) => [l.key, l]));
const memories = f.lines.map((l) => ({ id: l.id, kind: l.kind, text: l.text, ts: l.ts, conf: l.conf, ...(l.by ? { supersededBy: byKey.get(l.by).id } : {}) }));
const live = memories.filter((m) => m.kind !== "superseded" && !m.supersededBy).slice(0, 250);
const replaced = lib.replacedTexts(memories);
const prompts = rows.filter((r) => r.row === "prompt" && r.file === FILE_ID).map((r) => r.prompt);
const jev = lib.createJev({ noLogFile: true, cache: false, timeoutMs: TIMEOUT });

function request(query, stateLines, noulLines, withChoice = true) {
  const criteria = {};
  for (const m of stateLines) criteria[m.id] = null;
  criteria.none = { what: "No listed memory is relevant to the query.", examples: ["The query is about a topic none of the memories mention."] };
  const questions = withChoice ? { most_relevant: choice("Which memory is most relevant to the query?", criteria) } : {};
  for (const m of noulLines) questions[`rel_${m.id}`] = lib.relevanceNoul(m.id);
  const state = { query, memories: stateLines.map((m) => ({ id: m.id, kind: m.kind, text: m.text, ...(replaced.get(m.id)?.length ? { replaces: replaced.get(m.id).slice(0, 2) } : {}) })) };
  return { state, questions };
}
const chunks = (list, n) => Array.from({ length: n }, (_, i) => list.filter((_, j) => j % n === i));

function build(shape, query) {
  if (shape === "one") return [request(query, live, live)];
  if (shape === "stateonly") return [request(query, live, [])];
  let m = /^split(\d+)$/.exec(shape);
  if (m) return chunks(live, Number(m[1])).map((c) => request(query, c, c));
  if (shape === "v059") {
    const cands = lib.prefilterByOverlap(query, live, 60);
    const criteria = Object.fromEntries(cands.map((c) => [c.id, `[${c.kind}] ${c.text}`]));
    criteria.none = { what: "No listed memory is relevant to the query.", examples: ["The query is about a topic none of the memories mention."] };
    return [{ state: { query, memories: cands.map((c) => ({ id: c.id, kind: c.kind, text: c.text })) }, questions: { most_relevant: choice("Which memory is most relevant to the query?", criteria) } }];
  }
  m = /^nouls(\d+)$/.exec(shape);
  if (m) return [request(query, live, chunks(live, Number(m[1]))[0])];
  throw new Error(`unknown shape ${shape}`);
}

async function timed(req) {
  const t0 = performance.now();
  try {
    const res = await jev.call(req.state, req.questions, { label: "latency", timeoutMs: TIMEOUT });
    return { ms: Math.round(performance.now() - t0), ok: true, tokens: res.usage.input_tokens, questions: Object.keys(req.questions).length };
  } catch (err) {
    return { ms: Math.round(performance.now() - t0), ok: false, error: String(err?.message ?? err).slice(0, 120), questions: Object.keys(req.questions).length };
  }
}

const results = Object.fromEntries(SHAPES.map((s) => [s, []]));
for (let r = 0; r < ROUNDS; r++) {
  const query = `${prompts[r % prompts.length]}${r >= prompts.length ? ` (${r})` : ""}`;
  const order = [...SHAPES].sort(() => Math.random() - 0.5);
  for (const shape of order) {
    const at = new Date().toISOString();
    const reqs = build(shape, query);
    const t0 = performance.now();
    const parts = await Promise.all(reqs.map(timed));
    results[shape].push({ round: r, at, wall: Math.round(performance.now() - t0), ok: parts.every((p) => p.ok), parts });
  }
  process.stderr.write(`round ${r + 1}/${ROUNDS}: ${SHAPES.map((s) => `${s} ${results[s].at(-1).wall}${results[s].at(-1).ok ? "" : "!"}`).join("  ")}\n`);
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};
const summary = {};
for (const [shape, rs] of Object.entries(results)) {
  const walls = rs.map((x) => (x.ok ? x.wall : Math.max(x.wall, TIMEOUT)));
  const reqMs = rs.flatMap((x) => x.parts.map((p) => p.ms));
  const tokens = rs.map((x) => x.parts.reduce((a, p) => a + (p.tokens ?? 0), 0)).filter((t) => t > 0);
  summary[shape] = {
    requests_per_prompt: rs[0]?.parts.length ?? 0,
    questions_per_request: rs[0]?.parts.map((p) => p.questions) ?? [],
    rounds: rs.length,
    failed: rs.filter((x) => !x.ok).length,
    wall_p50: pct(walls, 0.5),
    wall_p90: pct(walls, 0.9),
    wall_p95: pct(walls, 0.95),
    wall_max: Math.max(...walls),
    over_1s: walls.filter((w) => w > 1000).length,
    over_2s: walls.filter((w) => w > 2000).length,
    request_p50: pct(reqMs, 0.5),
    request_p95: pct(reqMs, 0.95),
    input_tokens_per_prompt: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null,
    cost_per_prompt_usd: tokens.length ? (tokens.reduce((a, b) => a + b, 0) / tokens.length / 1e6) * 0.042 : null,
  };
}
const out = { kind: "recall-latency", file: FILE_ID, set: SET_FILE, live_lines: live.length, rounds: ROUNDS, timeout_ms: TIMEOUT, started_at: results[SHAPES[0]][0]?.at, finished_at: new Date().toISOString(), method: "Each round sends every shape once for the same prompt, in a random order; a shape's time is its slowest request (requests of a shape are sent at the same time). Timeout 8 s per request.", summary, rows: results };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`${FILE_ID} (${live.length} live lines), ${ROUNDS} rounds → ${OUT}`);
for (const [s, v] of Object.entries(summary)) console.log(`${s.padEnd(10)} ${String(v.requests_per_prompt).padStart(2)} req  p50 ${String(v.wall_p50).padStart(5)}  p90 ${String(v.wall_p90).padStart(5)}  p95 ${String(v.wall_p95).padStart(5)}  max ${String(v.wall_max).padStart(5)}  >1s ${String(v.over_1s).padStart(2)}  >2s ${String(v.over_2s).padStart(2)}  failed ${v.failed}  ${v.input_tokens_per_prompt} tokens  $${v.cost_per_prompt_usd?.toFixed(6)}`);
