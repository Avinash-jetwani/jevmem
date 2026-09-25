#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

// Opt-in per project: a hook in a project without jevmem.config.json does nothing. When Claude Code names the project
// (CLAUDE_PROJECT_DIR), the check runs here, before the rest of the CLI is loaded; cli-main checks again against the
// hook payload's cwd.
if (process.argv[2] === "hook" && process.env.CLAUDE_PROJECT_DIR && !fs.existsSync(path.join(process.env.CLAUDE_PROJECT_DIR, "jevmem.config.json"))) {
  process.stdin.resume();
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
} else {
  const { main } = await import("./cli-main.js");
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (err) => {
      process.stderr.write(`jevmem: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(process.argv[2] === "hook" ? 0 : 1);
    },
  );
}
