#!/usr/bin/env node
// The Cursor plugin in cursor-plugin/ (0.7.6) must pass Cursor's submission checklist (https://cursor.com/docs/reference/
// plugins.md, "Submission checklist", and the template's scripts/validate-template.mjs, read 2026-10-18) and stay as
// thin as the Claude Code plugin: it runs the jevmem CLI from npm and ships one shell launcher, no code. Fails when:
// the manifest `.cursor-plugin/plugin.json` lacks a field the listing needs, its name is not `jevmem` in kebab-case,
// its version differs from package.json's, its logo is not a committed relative path, or it declares `variables`
// (the key comes from `jevmem key`, never from a plugin field); the repository's `.cursor-plugin/marketplace.json`
// does not list exactly this plugin at ./cursor-plugin with the same name; a rule file lacks frontmatter
// (`description`, `alwaysApply`) or the sentence that keeps the agent off jevmem in a project that is not turned on;
// hooks/hooks.json is not version 1 with jevmem's five events, each one command through the launcher with a timeout,
// or names `followup_message` or `failClosed`; mcp.json runs anything but the launcher's --mcp mode, or holds a
// placeholder other than ${CURSOR_PLUGIN_ROOT} and ${workspaceFolder} (every `${VAR}` must be declared, and none is);
// the launcher differs from the package's hooks/jevmem-cursor-hook.sh; README.md, LICENSE (equal to the repository's)
// or SECURITY.md is missing, or the README has no Privacy link; a manifest path is absolute or has `..`; a file is
// 256 KiB or larger, minified, an operating-system file, or an SVG with a script; the hook files name a package
// manager; the folder says "Cursor AI" or "Cursor Code" (the Publisher Terms §4.6 want "Cursor"); or any file holds
// a key-shaped string. Untracked files count too: the check reads the folder.
//
//   node scripts/check-cursor-plugin.mjs
import fs from "node:fs";
import path from "node:path";

const DIR = "cursor-plugin";
const LIMIT = 256 * 1024;
const SYSTEM = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"]);
const EVENTS = ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"];
const problems = [];
const read = (f) => fs.readFileSync(f, "utf8");
const json = (f) => {
  try {
    return JSON.parse(read(f));
  } catch (e) {
    problems.push(`${f}: ${e.message}`);
    return null;
  }
};
const kebab = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const safeRelative = (p) => typeof p === "string" && p.length > 0 && !path.isAbsolute(p) && !/^https?:/.test(p) && !p.split(/[\\/]/).includes("..");

// The files.
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (SYSTEM.has(e.name)) problems.push(`${p}: an operating-system file`);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
if (!fs.existsSync(DIR)) problems.push(`${DIR}/: missing`);
else walk(DIR);
const PACKAGE_MANAGER = /\b(?:npm|npx|pnpm|yarn|bunx?|pip3?|pipx|uvx?|brew)\b|install/i;
const KEY_SHAPE = /\b(?:sk|ts|key)-[A-Za-z0-9_-]{16,}|TYPESAFE_API_KEY\s*=\s*\S/;
for (const f of files) {
  const size = fs.statSync(f).size;
  if (size >= LIMIT) problems.push(`${f}: ${size} bytes (limit ${LIMIT})`);
  if (/\.min\.[a-z]+$/i.test(f)) problems.push(`${f}: a minified file`);
  const text = read(f);
  if (/Cursor (?:AI|Code)\b/.test(text)) problems.push(`${f}: says "Cursor AI" or "Cursor Code" (the Publisher Terms want "Cursor")`);
  if (KEY_SHAPE.test(text)) problems.push(`${f}: a key-shaped string`);
  if (f.endsWith(".svg")) {
    if (/<script|<foreignObject|\son[a-z]+\s*=|(?:href|src)\s*=\s*"(?:https?:|\/\/|data:text)/i.test(text)) problems.push(`${f}: an SVG with a script, event handler or external reference`);
    continue;
  }
  const long = text.split("\n").findIndex((l) => l.length > 1000);
  if (long >= 0) problems.push(`${f}:${long + 1}: a line over 1,000 characters`);
  if (/[\\/]hooks[\\/]/.test(f) && PACKAGE_MANAGER.test(text)) problems.push(`${f}: names a package manager or an install step (the hooks must not run one)`);
}

// The manifest.
const pkg = json("package.json");
const manifestFile = path.join(DIR, ".cursor-plugin", "plugin.json");
const m = fs.existsSync(manifestFile) ? json(manifestFile) : (problems.push(`${manifestFile}: missing`), null);
if (m) {
  if (m.name !== "jevmem" || !kebab.test(m.name)) problems.push(`${manifestFile}: name must be "jevmem" (lowercase, kebab-case), got ${JSON.stringify(m.name)}`);
  if (m.version !== pkg?.version) problems.push(`${manifestFile}: version ${m.version} is not package.json's ${pkg?.version}`);
  for (const k of ["displayName", "description", "homepage", "repository", "license"]) if (typeof m[k] !== "string" || !m[k].trim()) problems.push(`${manifestFile}: ${k} missing`);
  if (m.license !== "MIT") problems.push(`${manifestFile}: license must be MIT (the Marketplace allows permissive licences only), got ${m.license}`);
  if (typeof m.author?.name !== "string" || !m.author.name) problems.push(`${manifestFile}: author.name missing`);
  for (const k of ["homepage", "repository"]) if (typeof m[k] === "string" && !/^https:\/\//.test(m[k])) problems.push(`${manifestFile}: ${k} is not an https URL`);
  if (!Array.isArray(m.keywords) || !m.keywords.length) problems.push(`${manifestFile}: keywords missing`);
  if (typeof m.logo !== "string") problems.push(`${manifestFile}: logo missing (a committed relative path)`);
  else if (!safeRelative(m.logo) || !fs.existsSync(path.join(DIR, m.logo))) problems.push(`${manifestFile}: logo must be a relative path to a committed file, got ${m.logo}`);
  if ("variables" in m) problems.push(`${manifestFile}: declares variables (the key comes from jevmem key, never from a plugin field)`);
  if ("mcpServers" in m || "hooks" in m || "rules" in m) problems.push(`${manifestFile}: names component paths (the folders are discovered: hooks/hooks.json, mcp.json, rules/)`);
  for (const [k, v] of Object.entries(m)) if (typeof v === "string" && /[\\/]/.test(v) && !/^https?:/.test(v) && !safeRelative(v)) problems.push(`${manifestFile}: ${k} is not a safe relative path: ${v}`);
  if (/Claude Code/.test(String(m.description))) problems.push(`${manifestFile}: the description names Claude Code`);
}

// The repository's marketplace manifest.
const mkFile = path.join(".cursor-plugin", "marketplace.json");
const mk = fs.existsSync(mkFile) ? json(mkFile) : (problems.push(`${mkFile}: missing`), null);
if (mk) {
  if (typeof mk.name !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(mk.name)) problems.push(`${mkFile}: name must be kebab-case`);
  if (typeof mk.owner?.name !== "string" || !mk.owner.name) problems.push(`${mkFile}: owner.name missing`);
  if (!Array.isArray(mk.plugins) || mk.plugins.length !== 1) problems.push(`${mkFile}: plugins must list the one plugin`);
  else {
    const e = mk.plugins[0];
    if (e.name !== "jevmem") problems.push(`${mkFile}: the entry's name must be jevmem`);
    if (e.source !== `./${DIR}`) problems.push(`${mkFile}: the entry's source must be ./${DIR}, got ${e.source}`);
    if (typeof e.description !== "string" || !e.description) problems.push(`${mkFile}: the entry's description missing`);
    if (m && e.name !== m.name) problems.push(`${mkFile}: the entry's name differs from the plugin manifest's`);
  }
}

// The rule.
const rulesDir = path.join(DIR, "rules");
const rules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => /\.(mdc|md|markdown)$/.test(f)) : [];
if (rules.length !== 1 || rules[0] !== "jevmem.mdc") problems.push(`${rulesDir}: expected the one rule jevmem.mdc, got ${rules.join(", ") || "none"}`);
for (const f of rules) {
  const text = read(path.join(rulesDir, f));
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) problems.push(`${rulesDir}/${f}: no YAML frontmatter`);
  else {
    if (!/^description:\s*\S/m.test(fm[1])) problems.push(`${rulesDir}/${f}: frontmatter lacks description`);
    if (!/^alwaysApply:\s*(true|false)\s*$/m.test(fm[1])) problems.push(`${rulesDir}/${f}: frontmatter lacks alwaysApply`);
  }
  if (!/jevmem\.config\.json/.test(text) || !/off/i.test(text)) problems.push(`${rulesDir}/${f}: must say that without jevmem.config.json jevmem is off here and its tools are not to be called`);
}

// The hooks.
const hooksFile = path.join(DIR, "hooks", "hooks.json");
const h = fs.existsSync(hooksFile) ? json(hooksFile) : (problems.push(`${hooksFile}: missing`), null);
if (h) {
  if (h.version !== 1) problems.push(`${hooksFile}: version must be 1`);
  const events = Object.keys(h.hooks ?? {});
  if (events.length !== EVENTS.length || EVENTS.some((e) => !events.includes(e))) problems.push(`${hooksFile}: events must be ${EVENTS.join(", ")}, got ${events.join(", ")}`);
  for (const [ev, list] of Object.entries(h.hooks ?? {})) {
    if (!Array.isArray(list) || list.length !== 1) problems.push(`${hooksFile}: ${ev} must have one entry`);
    for (const e of Array.isArray(list) ? list : []) {
      if (e.command !== `sh "\${CURSOR_PLUGIN_ROOT}/hooks/jevmem-hook.sh" --plugin ${ev}`) problems.push(`${hooksFile}: ${ev}'s command must be the launcher with --plugin ${ev}, got ${JSON.stringify(e.command)}`);
      if (typeof e.timeout !== "number" || e.timeout < 1 || e.timeout > 30) problems.push(`${hooksFile}: ${ev} needs a timeout of 1 to 30 s`);
      if ("failClosed" in e) problems.push(`${hooksFile}: ${ev} sets failClosed (a jevmem hook never blocks Cursor)`);
    }
  }
  if (/followup_message/.test(read(hooksFile))) problems.push(`${hooksFile}: names followup_message`);
}

// The MCP server.
const mcpFile = path.join(DIR, "mcp.json");
const mcp = fs.existsSync(mcpFile) ? json(mcpFile) : (problems.push(`${mcpFile}: missing`), null);
if (mcp) {
  const names = Object.keys(mcp.mcpServers ?? {});
  if (names.length !== 1 || names[0] !== "jevmem") problems.push(`${mcpFile}: must define the one server jevmem`);
  const s = mcp.mcpServers?.jevmem ?? {};
  if (s.command !== "sh" || s.args?.[0] !== "${CURSOR_PLUGIN_ROOT}/hooks/jevmem-hook.sh" || !s.args?.includes("--plugin") || !s.args?.includes("--mcp")) problems.push(`${mcpFile}: the server must run the launcher's --plugin --mcp mode`);
  if ("env" in s) problems.push(`${mcpFile}: sets env (no key, no variable goes in the plugin)`);
  const text = read(mcpFile);
  if (/\$\{env:/.test(text)) problems.push(`${mcpFile}: uses \${env:…}`);
  for (const ph of text.match(/\$\{[^}]*\}/g) ?? []) if (ph !== "${CURSOR_PLUGIN_ROOT}" && ph !== "${workspaceFolder}") problems.push(`${mcpFile}: undeclared placeholder ${ph}`);
}

// The launcher, the licence, the README, the security note, the logo.
const launcher = path.join(DIR, "hooks", "jevmem-hook.sh");
if (!fs.existsSync(launcher)) problems.push(`${launcher}: missing`);
else if (read(launcher) !== read("hooks/jevmem-cursor-hook.sh")) problems.push(`${launcher}: differs from hooks/jevmem-cursor-hook.sh (one launcher, copied)`);
if (!fs.existsSync(path.join(DIR, "LICENSE"))) problems.push(`${DIR}/LICENSE: missing`);
else if (read(path.join(DIR, "LICENSE")) !== read("LICENSE")) problems.push(`${DIR}/LICENSE: differs from LICENSE`);
if (!fs.existsSync(path.join(DIR, "README.md"))) problems.push(`${DIR}/README.md: missing`);
else {
  const readme = read(path.join(DIR, "README.md"));
  if (!/\[Privacy\]\(https:\/\/github\.com\/Avinash-jetwani\/jevmem\/blob\/main\/PRIVACY\.md\)/.test(readme)) problems.push(`${DIR}/README.md: no Privacy link to PRIVACY.md`);
  if (!/TypeSafe/.test(readme) || !/jevmem key/.test(readme)) problems.push(`${DIR}/README.md: must say the plugin needs a TypeSafe key saved with jevmem key`);
  if (!/jevmem\.config\.json|turned on|jevmem enable|jevmem setup/.test(readme)) problems.push(`${DIR}/README.md: must say how a project is turned on`);
}
if (!fs.existsSync(path.join(DIR, "SECURITY.md"))) problems.push(`${DIR}/SECURITY.md: missing`);
if (!fs.existsSync(path.join(DIR, "assets", "logo.svg"))) problems.push(`${DIR}/assets/logo.svg: missing`);
else if (read(path.join(DIR, "assets", "logo.svg")) !== read("plugin/.claude-plugin/icon.svg")) problems.push(`${DIR}/assets/logo.svg: differs from the Claude plugin's icon`);
const expected = new Set([".cursor-plugin/plugin.json", "hooks/hooks.json", "hooks/jevmem-hook.sh", "mcp.json", "rules/jevmem.mdc", "assets/logo.svg", "README.md", "LICENSE", "SECURITY.md"]);
for (const f of files) {
  const rel = path.relative(DIR, f).split(path.sep).join("/");
  if (!expected.has(rel)) problems.push(`${f}: not one of the plugin's files (${[...expected].join(", ")})`);
}

if (problems.length) {
  console.error("check-cursor-plugin:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`check-cursor-plugin: ${files.length} files in ${DIR}/, the manifest, the marketplace entry, the rule, the five hooks, the MCP server, the launcher, LICENSE, README and the logo all as the checklist wants`);
