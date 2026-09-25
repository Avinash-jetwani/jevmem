#!/usr/bin/env node
// Fails when package.json, plugin/.claude-plugin/plugin.json and the plugin's JEVMEM_PLUGIN_VERSION (which the MCP
// server compares with the CLI's version) do not all carry the same version. Claude Code updates an installed plugin
// only when plugin.json "version" changes, so they must move together.
//
//   node scripts/check-versions.mjs
import fs from "node:fs";

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const plugin = read("plugin/.claude-plugin/plugin.json");
const versions = {
  "package.json": read("package.json").version,
  "plugin/.claude-plugin/plugin.json": plugin.version,
  "plugin/.claude-plugin/plugin.json (mcpServers.jevmem.env.JEVMEM_PLUGIN_VERSION)": plugin.mcpServers?.jevmem?.env?.JEVMEM_PLUGIN_VERSION,
};
if (new Set(Object.values(versions)).size !== 1 || Object.values(versions).some((v) => typeof v !== "string")) {
  console.error("check-versions: versions differ; bump them together:");
  for (const [f, v] of Object.entries(versions)) console.error(`  ${f}: ${v}`);
  process.exit(1);
}
console.log(`check-versions: package.json and plugin/.claude-plugin/plugin.json are both ${versions["package.json"]}`);
