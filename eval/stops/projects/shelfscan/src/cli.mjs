#!/usr/bin/env node
import { parseIsbn, toIsbn13 } from "./isbn.mjs";

const [cmd, arg] = process.argv.slice(2);
if (!cmd || !arg) {
  console.error("usage: shelfscan check <isbn> | shelfscan to13 <isbn10>");
  process.exit(2);
}
try {
  if (cmd === "check") {
    const r = parseIsbn(arg);
    console.log(`${r.value} is a valid ${r.kind === "isbn10" ? "ISBN-10" : "ISBN-13"}`);
  } else if (cmd === "to13") {
    console.log(toIsbn13(arg));
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
