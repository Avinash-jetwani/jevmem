#!/usr/bin/env node
import { main } from "./cli-main.js";

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`jevmem: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(process.argv[2] === "hook" ? 0 : 1);
  },
);
