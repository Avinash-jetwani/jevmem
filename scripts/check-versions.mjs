#!/usr/bin/env node
// Fails when package.json, plugin/.claude-plugin/plugin.json, pane/.claude-plugin/plugin.json, cursor-plugin/.cursor-plugin/plugin.json (0.7.6) and the plugin's JEVMEM_PLUGIN_VERSION (which the MCP
// server compares with the CLI's version) do not all carry the same version. Claude Code updates an installed plugin
// only when plugin.json "version" changes, so they must move together. server.json (the MCP Registry entry) carries the
// version twice, and its name must be package.json's mcpName: the registry checks the published package for it. The
// Dockerfile (the image MCP directories build to inspect the server) installs that version from npm.
//
//   node scripts/check-versions.mjs
import fs from "node:fs";

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const plugin = read("plugin/.claude-plugin/plugin.json");
const pane = read("pane/.claude-plugin/plugin.json");
const cursor = read("cursor-plugin/.cursor-plugin/plugin.json");
const pkg = read("package.json");
const server = read("server.json");
const versions = {
  "package.json": pkg.version,
  "plugin/.claude-plugin/plugin.json": plugin.version,
  "plugin/.claude-plugin/plugin.json (mcpServers.jevmem.env.JEVMEM_PLUGIN_VERSION)": plugin.mcpServers?.jevmem?.env?.JEVMEM_PLUGIN_VERSION,
  // 0.7.5: the pane (pane/, a second plugin in the marketplace) carries jevmem's version: it reads files the CLI of
  // the same version writes, and Claude Code updates an installed pane only when this version changes.
  "pane/.claude-plugin/plugin.json": pane.version,
  // 0.7.6: the jevmem plugin for Cursor (cursor-plugin/) carries the version too: its launcher hands it to the CLI,
  // which warns when it is older, and the Marketplace lists it.
  "cursor-plugin/.cursor-plugin/plugin.json": cursor.version,
  "server.json (version)": server.version,
  "server.json (packages[0].version)": server.packages?.[0]?.version,
  "Dockerfile (npm install -g jevmem@…)": /^RUN npm install -g jevmem@(\S+)/m.exec(fs.readFileSync("Dockerfile", "utf8"))?.[1],
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
console.log(`check-versions: package.json, plugin/.claude-plugin/plugin.json, pane/.claude-plugin/plugin.json, cursor-plugin/.cursor-plugin/plugin.json, server.json and the Dockerfile are all ${versions["package.json"]}`);
