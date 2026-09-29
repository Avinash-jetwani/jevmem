#!/usr/bin/env node
// Fails when package.json, plugin/.claude-plugin/plugin.json and the plugin's JEVMEM_PLUGIN_VERSION (which the MCP
// server compares with the CLI's version) do not all carry the same version. Claude Code updates an installed plugin
// only when plugin.json "version" changes, so they must move together. server.json (the MCP Registry entry) carries the
// version twice, and its name must be package.json's mcpName: the registry checks the published package for it.
//
//   node scripts/check-versions.mjs
import fs from "node:fs";

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const plugin = read("plugin/.claude-plugin/plugin.json");
const pkg = read("package.json");
const server = read("server.json");
const versions = {
  "package.json": pkg.version,
  "plugin/.claude-plugin/plugin.json": plugin.version,
  "plugin/.claude-plugin/plugin.json (mcpServers.jevmem.env.JEVMEM_PLUGIN_VERSION)": plugin.mcpServers?.jevmem?.env?.JEVMEM_PLUGIN_VERSION,
  "server.json (version)": server.version,
  "server.json (packages[0].version)": server.packages?.[0]?.version,
};
if (server.name !== pkg.mcpName || server.packages?.[0]?.identifier !== pkg.name) {
  console.error(`check-versions: server.json name ${server.name} and package ${server.packages?.[0]?.identifier} must be package.json's mcpName ${pkg.mcpName} and name ${pkg.name}`);
  process.exit(1);
}
if (new Set(Object.values(versions)).size !== 1 || Object.values(versions).some((v) => typeof v !== "string")) {
  console.error("check-versions: versions differ; bump them together:");
  for (const [f, v] of Object.entries(versions)) console.error(`  ${f}: ${v}`);
  process.exit(1);
}
console.log(`check-versions: package.json, plugin/.claude-plugin/plugin.json and server.json are all ${versions["package.json"]}`);
