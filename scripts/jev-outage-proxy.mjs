#!/usr/bin/env node
// A local proxy in front of the Jev API for the e2e outage scenario.
//
//   node scripts/jev-outage-proxy.mjs --flag <file> [--port 0] [--upstream https://api.typesafe.ai]
//
// While <file> exists every request gets HTTP 529 (overloaded); otherwise requests are forwarded to the upstream
// unchanged (method, path, body, Authorization). Prints the listening URL on stdout, then one line per request
// (`529 /v1/systemone` or `200 /v1/systemone`) on stderr.
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const FLAG = opt("--flag");
const UPSTREAM = (opt("--upstream", process.env.JEV_UPSTREAM ?? "https://api.typesafe.ai")).replace(/\/$/, "");
if (!FLAG) throw new Error("--flag <file> is required");

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (fs.existsSync(FLAG)) {
    process.stderr.write(`529 ${req.url}\n`);
    res.writeHead(529, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "overloaded_error", message: "e2e outage (proxy)" } }));
    return;
  }
  try {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!["host", "content-length", "connection"].includes(k) && typeof v === "string") headers[k] = v;
    const up = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: req.method === "GET" ? undefined : body });
    const buf = Buffer.from(await up.arrayBuffer());
    process.stderr.write(`${up.status} ${req.url}\n`);
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    res.end(buf);
  } catch (err) {
    process.stderr.write(`502 ${req.url} ${err}\n`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err) } }));
  }
});
server.listen(Number(opt("--port", "0")), "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
