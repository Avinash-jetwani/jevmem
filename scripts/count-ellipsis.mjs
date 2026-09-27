#!/usr/bin/env node
// Saved lines that end in "…" (cut inside a clause) across the eval runs (v0.6 part 2b).
//
//   node scripts/count-ellipsis.mjs [--recompute path/to/dist/index.js] [--files a.json,b.txt] [--out results/…json]
//
// Reads the results files (default: every results/*.json and results/e2e-*.txt that holds written lines) and counts
// the saved lines and those ending in "…":
// - dead-end pipeline runs (scripts/eval-dead-ends.mjs): the line of every saved row;
// - writer runs (scripts/eval-dead-ends.mjs --writer-only, scripts/eval-writer.mjs): every line;
// - end-to-end transcripts (scripts/e2e.sh): every memory line in the JEVMEM.md dumps, once per id.
// With --recompute, every line the local writer wrote is written again from the same input with that build (no Jev,
// no network): for a pipeline row, the text the hook gave the writer (the turn, the source Jev chose, the saved kind);
// for a writer row, its recorded input. Lines an LLM wrote and end-to-end lines are not recomputed (they need the
// provider or Claude Code; rerun those instead) and are counted as they are.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const RECOMPUTE = opt("--recompute", null);
const OUT = opt("--out", null);
const lib = RECOMPUTE ? await import(pathToFileURL(path.resolve(RECOMPUTE)).href) : null;
const files = opt("--files", null)?.split(",") ?? fs.readdirSync("results").filter((f) => /\.json$/.test(f) || /^e2e-.*\.txt$/.test(f)).map((f) => path.join("results", f));
const ends = (s) => String(s).trimEnd().endsWith("…");
const WRITER = { provider: "none", maxChars: 200, timeoutMs: 1000 };
const sets = new Map();
const setRows = (file) => {
  if (!sets.has(file)) sets.set(file, new Map(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r])));
  return sets.get(file);
};
/** The text the hook gives the writer for a saved pipeline row (decide's sourceText). */
function writerInput(row, o) {
  const works = Boolean(o.worksNow?.id);
  if (o.source === "assistant_reply") return row.assistant.trim();
  if ((o.got.kind === "dead-end" || works) && o.source === "both") return lib.mergeTurn(row.user, row.assistant);
  return row.user.trim();
}

const out = [];
for (const file of files) {
  if (file.endsWith(".txt")) {
    const seen = new Map();
    for (const m of fs.readFileSync(file, "utf8").matchAll(/^\s*(?:the saved line, as written: )?- \[[a-z]+(?:-[a-z]+)*\] (.*?)\s*<!-- id:(\w+)/gm)) seen.set(m[2], m[1].replace(/ → id:\w+$/, ""));
    if (seen.size) out.push({ file, shape: "e2e", lines: seen.size, ellipsis: [...seen.values()].filter(ends).length, recomputed: null });
    continue;
  }
  let r;
  try {
    r = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (r.kind === "dead-ends" && Array.isArray(r.rows)) {
    const saved = r.rows.filter((o) => o.got?.save && typeof o.got.line === "string");
    const entry = { file, shape: "dead-end pipeline, local writer", lines: saved.length, ellipsis: saved.filter((o) => ends(o.got.line)).length, recomputed: null };
    if (lib) {
      const rows = setRows(r.set);
      const again = [];
      for (const o of saved) {
        const row = rows.get(o.id);
        const deadEnd = o.worksNow?.id ? row.existing.find((m) => m.id === o.worksNow.id)?.text : undefined;
        const { line } = await lib.composeLine(writerInput(row, o), o.got.kind, { writer: WRITER, env: {} }, { worksNow: Boolean(o.worksNow?.id), deadEnd });
        again.push(line);
      }
      entry.recomputed = { lines: again.length, ellipsis: again.filter(ends).length };
    }
    out.push(entry);
  } else if ((r.kind === "dead-ends-writer" || (r.summary && "droppedSentences" in r.summary)) && Array.isArray(r.rows)) {
    const writer = r.summary?.writer ?? "none";
    const local = r.rows.filter((o) => o.writerUsed === "fallback");
    const entry = { file, shape: `writer ${writer}`, lines: r.rows.length, ellipsis: r.rows.filter((o) => ends(o.line)).length, localLines: local.length, recomputed: null };
    if (lib) {
      const again = [];
      for (const o of local) again.push((await lib.composeLine(o.input, o.kind ?? "dead-end", { writer: WRITER, env: {} })).line);
      const llm = r.rows.filter((o) => o.writerUsed !== "fallback");
      entry.recomputed = { lines: again.length + llm.length, ellipsis: again.filter(ends).length + llm.filter((o) => ends(o.line)).length, llmLinesNotRecomputed: llm.length, llmEllipsis: llm.filter((o) => ends(o.line)).length };
    }
    out.push(entry);
  }
}
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const summary = {
  files: out.length,
  lines: sum(out, (x) => x.lines),
  ellipsis: sum(out, (x) => x.ellipsis),
  endsInEllipsis: `${sum(out, (x) => x.ellipsis)}/${sum(out, (x) => x.lines)}`,
  evalEndsInEllipsis: `${sum(out.filter((x) => x.shape !== "e2e"), (x) => x.ellipsis)}/${sum(out.filter((x) => x.shape !== "e2e"), (x) => x.lines)}`,
  ...(lib
    ? {
        recomputedWith: RECOMPUTE,
        recomputedLines: sum(out.filter((x) => x.recomputed), (x) => x.recomputed.lines),
        recomputedEllipsis: sum(out.filter((x) => x.recomputed), (x) => x.recomputed.ellipsis),
        llmLinesNotRecomputed: sum(out.filter((x) => x.recomputed), (x) => x.recomputed.llmLinesNotRecomputed ?? 0),
        llmEllipsisNotRecomputed: sum(out.filter((x) => x.recomputed), (x) => x.recomputed.llmEllipsis ?? 0),
        e2eLines: sum(out.filter((x) => x.shape === "e2e"), (x) => x.lines),
        e2eEllipsis: sum(out.filter((x) => x.shape === "e2e"), (x) => x.ellipsis),
        localLinesRecomputed: `${sum(out.filter((x) => x.recomputed), (x) => x.recomputed.ellipsis - (x.recomputed.llmEllipsis ?? 0))}/${sum(out.filter((x) => x.recomputed), (x) => x.recomputed.lines - (x.recomputed.llmLinesNotRecomputed ?? 0))}`,
      }
    : {}),
};
for (const x of out) console.log(`${String(x.ellipsis).padStart(3)}/${String(x.lines).padEnd(4)} ${x.recomputed ? `→ ${String(x.recomputed.ellipsis).padStart(3)}/${String(x.recomputed.lines).padEnd(4)}` : "".padEnd(12)} ${x.shape.padEnd(34)} ${x.file}`);
console.log(`\n${summary.ellipsis} of ${summary.lines} saved lines end in "…" (${summary.files} files)${lib ? `; written again with ${RECOMPUTE}: ${summary.recomputedEllipsis} of ${summary.recomputedLines} (of which ${summary.llmEllipsisNotRecomputed} of ${summary.llmLinesNotRecomputed} LLM lines, not recomputed); end-to-end lines, as they were: ${summary.e2eEllipsis} of ${summary.e2eLines}` : ""}`);
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ kind: "ellipsis-count", date: new Date().toISOString().slice(0, 10), method: "Saved lines ending in … per results file; with recompute, lines the local writer wrote are written again from the same input with the given build (scripts/count-ellipsis.mjs).", summary, files: out }, null, 2) + "\n");
  console.log(`written ${OUT}`);
}
