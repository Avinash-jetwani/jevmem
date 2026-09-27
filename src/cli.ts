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
  let code: number;
  try {
    const { main } = await import("./cli-main.js");
    code = await main(argv, undefined, { stdin });
  } catch (err) {
    process.stderr.write(`jevmem: ${err instanceof Error ? err.message : String(err)}\n`);
    if (argv[0] === "hook") logHookFailure(err instanceof Error ? `${err.name}: ${err.message}` : String(err), stdin);
    code = argv[0] === "hook" ? 0 : 1;
  }
  if (code >= 0) process.exit(code);
}

/**
 * A hook that failed before or outside the CLI's own error handling (the CLI's main module did not load, say, after an
 * upgrade replaced it): the error goes to the project's .jevmem/log.jsonl, where doctor and stats find it. The Stop
 * hook's detached CLI has no stderr to tell anyone. Written only in an enabled project; the saved hook input
 * (--stdin-file) is removed, as the CLI would have done.
 */
function logHookFailure(message: string, stdin?: string): void {
  try {
    const i = argv.indexOf("--stdin-file");
    const file = i >= 0 ? argv[i + 1] : undefined;
    let raw = stdin ?? "";
    if (file) {
      try {
        raw = fs.readFileSync(file, "utf8");
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    let input: { hook_event_name?: unknown; cwd?: unknown } = {};
    try {
      input = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    const root = [process.env.CLAUDE_PROJECT_DIR, typeof input.cwd === "string" ? input.cwd : undefined, process.cwd()].find((d) => d && fs.existsSync(d))!;
    if (!fs.existsSync(path.join(root, "jevmem.config.json"))) return;
    const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "hook";
    fs.mkdirSync(path.join(root, ".jevmem"), { recursive: true });
    fs.appendFileSync(path.join(root, ".jevmem", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), label: "hook", ok: false, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, questions: 0, error: `${event}: ${message}` }) + "\n");
  } catch {
    /* nowhere left to report it */
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
