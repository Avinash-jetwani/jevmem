#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

// Opt-in per project: a hook in a project without jevmem.config.json does nothing. When Claude Code names the project
// (CLAUDE_PROJECT_DIR), the check runs here, before the rest of the CLI is loaded; the hook code checks again against
// the hook payload's cwd.
const argv = process.argv.slice(2);
if (argv[0] === "hook" && process.env.CLAUDE_PROJECT_DIR && !fs.existsSync(path.join(process.env.CLAUDE_PROJECT_DIR, "jevmem.config.json"))) {
  process.stdin.resume();
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
} else if (argv[0] === "hook" && !argv.includes("--stdin-file")) {
  // The hook's input is read here, once. PreToolUse (every Bash, Edit and Write call) loads only the guard, not the
  // rest of the CLI; every other event goes to the CLI with the input already read.
  const raw = await readStdin();
  let event: unknown;
  try {
    event = JSON.parse(raw)?.hook_event_name;
  } catch {
    // Broken JSON that names PreToolUse goes to the guard, which logs it and prints nothing; other text is a turn to
    // simulate, as before.
    event = /"hook_event_name"\s*:\s*"PreToolUse"/.test(raw) ? "PreToolUse" : undefined;
  }
  if (event === "PreToolUse") {
    let out = "";
    try {
      const { runGuardHook } = await import("./guardrail.js");
      out = await runGuardHook(raw, { viaPlugin: argv.includes("--plugin") });
    } catch {
      out = ""; // runGuardHook logs its own failures; a failed import leaves nothing to log with
    }
    // Stdout is empty or exactly one JSON object; the exit code is always 0 (a timed-out Jev request may still be open).
    if (out) process.stdout.write(out + "\n", () => process.exit(0));
    else process.exit(0);
  } else await run(raw);
} else await run();

async function run(stdin?: string): Promise<void> {
  const { main } = await import("./cli-main.js");
  main(argv, undefined, { stdin }).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (err) => {
      process.stderr.write(`jevmem: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(argv[0] === "hook" ? 0 : 1);
    },
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
