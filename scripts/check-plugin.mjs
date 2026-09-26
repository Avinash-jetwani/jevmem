#!/usr/bin/env node
// The Claude Code plugin in plugin/ must stay thin: it runs the jevmem CLI installed from npm and ships no code of
// its own. Fails when any file in plugin/ is 256 KiB or larger (the directory's review limit), when plugin/ contains
// a dist/ folder, when a file looks minified or bundled (a .min.* name, or a line over 1,000 characters), when it
// holds an operating-system file the directory refuses (.DS_Store, Thumbs.db, desktop.ini, __MACOSX), or when
// plugin/LICENSE differs from the repository's LICENSE. Untracked files count too: the check reads the folder.
//
//   node scripts/check-plugin.mjs
import fs from "node:fs";
import path from "node:path";

const LIMIT = 256 * 1024;
const SYSTEM = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"]);
const problems = [];
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (SYSTEM.has(e.name)) problems.push(`${p}: an operating-system file (the directory blocks a plugin that has one)`);
    if (e.isDirectory()) {
      if (e.name === "dist") problems.push(`${p}/: a dist/ folder (the plugin must not ship built code)`);
      walk(p);
    } else files.push(p);
  }
};
walk("plugin");
for (const f of files) {
  const size = fs.statSync(f).size;
  if (size >= LIMIT) problems.push(`${f}: ${size} bytes (limit ${LIMIT})`);
  if (/\.min\.[a-z]+$/i.test(f)) problems.push(`${f}: a minified file`);
  const text = fs.readFileSync(f, "utf8");
  const long = text.split("\n").findIndex((l) => l.length > 1000);
  if (long >= 0) problems.push(`${f}:${long + 1}: a line over 1,000 characters (minified or bundled code?)`);
}
if (!fs.existsSync("plugin/LICENSE")) problems.push("plugin/LICENSE: missing");
else if (fs.readFileSync("plugin/LICENSE", "utf8") !== fs.readFileSync("LICENSE", "utf8")) problems.push("plugin/LICENSE: differs from LICENSE");
if (problems.length) {
  console.error("check-plugin:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`check-plugin: ${files.length} files in plugin/, all under 256 KiB, no dist/, nothing minified, no system files, LICENSE matches`);
