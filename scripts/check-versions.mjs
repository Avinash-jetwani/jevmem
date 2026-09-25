#!/usr/bin/env node
// Fails when package.json, .claude-plugin/plugin.json and the jevmem entry in .claude-plugin/marketplace.json do not
// all carry the same version. Claude Code updates an installed plugin only when plugin.json "version" changes, and the
// marketplace entry names the npm version users get, so the three must move together.
//
//   node scripts/check-versions.mjs
import fs from "node:fs";

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const versions = {
  "package.json": read("package.json").version,
  ".claude-plugin/plugin.json": read(".claude-plugin/plugin.json").version,
  ".claude-plugin/marketplace.json (jevmem npm source)": read(".claude-plugin/marketplace.json").plugins.find((p) => p.name === "jevmem")?.source?.version,
};
if (new Set(Object.values(versions)).size !== 1 || Object.values(versions).some((v) => typeof v !== "string")) {
  console.error("check-versions: versions differ; bump them together:");
  for (const [f, v] of Object.entries(versions)) console.error(`  ${f}: ${v}`);
  process.exit(1);
}
console.log(`check-versions: package.json, plugin.json and marketplace.json are all ${versions["package.json"]}`);
