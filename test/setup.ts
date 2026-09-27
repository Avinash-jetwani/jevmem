/**
 * Runs in every test worker before its tests. Tests never see the machine's home, keys or Claude Code session:
 * - HOME is a new temporary folder, so ~/.jevmem/env, ~/.claude/settings.json and the like are never read or written,
 *   and CLAUDE_CONFIG_DIR points inside it;
 * - keys, base URLs and jevmem settings from the environment are removed (a test that wants one sets it), except the
 *   TypeSafe key and base URL when JEVMEM_LIVE=1 (test/live.test.ts);
 * - Claude Code's own variables are removed too: a test run from inside a Claude Code session would otherwise inherit
 *   CLAUDE_PROJECT_DIR (the hook's project root) and the plugin's folders.
 * Child processes inherit this environment unless a test passes its own.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const live = process.env.JEVMEM_LIVE === "1";
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-test-home-")));
for (const k of Object.keys(process.env)) {
  if (k === "JEVMEM_LIVE" || k === "JEVMEM_OLD_CLI") continue;
  if (live && (k === "TYPESAFE_API_KEY" || k === "TYPESAFE_BASE_URL")) continue;
  if (/^(TYPESAFE_|OPENAI_|ANTHROPIC_|JEVMEM_|CLAUDE_|XDG_CONFIG_HOME$)/.test(k) || k === "CLAUDECODE") delete process.env[k];
}
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
