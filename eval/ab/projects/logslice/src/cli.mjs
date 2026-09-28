import fs from "node:fs";
import readline from "node:readline";
import { formatLine } from "./output.mjs";
import { parseStamp, parseWhen } from "./time.mjs";

function parseArgs(argv) {
  const opts = { grep: null, since: null, format: "text", file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grep") opts.grep = argv[++i];
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--format") opts.format = argv[++i];
    else opts.file = a;
  }
  return opts;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.file) {
    console.error("usage: logslice [--grep <regex>] [--since <time>] [--format text|json] <file>");
    process.exit(1);
  }
  const re = opts.grep ? new RegExp(opts.grep) : null;
  const since = opts.since ? parseWhen(opts.since) : null;
  const rl = readline.createInterface({ input: fs.createReadStream(opts.file), crlfDelay: Infinity });
  let matched = 0;
  for await (const line of rl) {
    if (re && !re.test(line)) continue;
    if (since) {
      const at = parseStamp(line);
      if (at && at < since) continue;
    }
    matched++;
    process.stdout.write(formatLine(line, opts.format) + "\n");
  }
  return matched > 0 ? 0 : 1;
}
