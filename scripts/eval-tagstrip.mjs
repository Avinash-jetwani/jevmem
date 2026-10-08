#!/usr/bin/env node
// The leading-tag strip (0.7.0): a saved line's text does not begin with a kind or label tag (`[constraint]`, doubled,
// `[rule]`, `[note]`, …), while other bracketed tokens stay (`[DEPRECATED] …`). eval/tagstrip-heldout.jsonl was written
// before any code; the unit tests are the dev side. Run once on the build that ships and once on the build before it.
//
//   node scripts/eval-tagstrip.mjs [path/to/dist/index.js] [--out results/…json]
//
// Each row names the path its text takes: `hook`, the writer as the Stop hook runs it (composeLine with jevmem's own
// writer and the build's Jev client, for the labelled kind); `add`, the real CLI (`jevmem add <kind> "<text>"` in a
// scratch project, the line read back); `import`, the text step `jevmem import` gives a statement (its list dash already
// removed by the collector). A row passes when the line does not begin with a bracket (`want.strip`), or begins with
// the token it must keep (`want.keep`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const distArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/index.js");
const FILE = opt("--file", "eval/tagstrip-heldout.jsonl");
const OUT = opt("--out", null);
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required (the hook path asks Jev which sentences the line is made from)");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const cli = path.join(path.dirname(path.resolve(distArg)), "cli.js");
const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}
let version = null;
for (let d = path.dirname(path.resolve(distArg)); d !== path.dirname(d); d = path.dirname(d)) {
  const p = path.join(d, "package.json");
  if (fs.existsSync(p)) {
    const pj = JSON.parse(fs.readFileSync(p, "utf8"));
    if (pj.name === "jevmem") { version = pj.version; break; }
  }
}
const meta = { kind: "tagstrip", date: new Date().toISOString().slice(0, 10), commit, jevmem_version: version, dist: path.relative(process.cwd(), path.resolve(distArg)), set: FILE, turns: rows.length };
const jev = lib.createJev({ noLogFile: true, cache: false });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-tagstrip-"));
const writer = { provider: "none", maxChars: 200, timeoutMs: 1000 };
const out = [];
for (const r of rows) {
  let line;
  if (r.path === "hook") {
    line = (await lib.composeLine(r.user, r.kind, { writer, env: {}, jev })).line;
  } else if (r.path === "add") {
    const root = fs.mkdtempSync(path.join(tmp, "p-"));
    execFileSync(process.execPath, [cli, "init", "--no-hooks"], { cwd: root, stdio: "ignore" });
    execFileSync(process.execPath, [cli, "add", r.kind, r.user], { cwd: root, stdio: "ignore" });
    line = new lib.MemoryStore(root).active().at(-1)?.text ?? "";
  } else {
    line = lib.clampLine(lib.stripFiller(lib.scrubSecrets(r.user)), 200);
  }
  const startsWithBracket = /^\[/.test(line);
  const ok = r.want.strip ? !startsWithBracket && line.startsWith(r.want.startsWith) : line.startsWith(r.want.keep);
  out.push({ id: r.id, path: r.path, kind: r.kind, text: r.user, want: r.want, line, ok, note: r.note ?? null });
  process.stderr.write(ok ? "." : "x");
}
process.stderr.write("\n");
fs.rmSync(tmp, { recursive: true, force: true });
const strip = out.filter((o) => o.want.strip);
const keep = out.filter((o) => !o.want.strip);
const byPath = {};
for (const o of out) {
  const t = (byPath[o.path] ??= { cases: 0, ok: 0 });
  t.cases++;
  if (o.ok) t.ok++;
}
const summary = { tagsStripped: `${strip.filter((o) => o.ok).length}/${strip.length}`, tokensKept: `${keep.filter((o) => o.ok).length}/${keep.length}`, byPath };
console.log(`${FILE} (${version ?? "?"} ${commit}): tags stripped ${summary.tagsStripped}, tokens kept ${summary.tokensKept}, by path ${JSON.stringify(byPath)}`);
for (const o of out.filter((x) => !x.ok)) console.log(`  ✗ ${o.id} ${o.path.padEnd(6)} ${JSON.stringify(o.line)}  (want ${o.want.strip ? `no tag, starting "${o.want.startsWith}"` : `keeps ${o.want.keep}`})`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ...meta, summary, rows: out }, null, 1) + "\n");
