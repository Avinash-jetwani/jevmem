#!/usr/bin/env node
// Serves the built site at http://localhost:4173/jevmem/, the path GitHub Pages gives it. For looking at a build
// on your own machine only:
//
//   node site/build.mjs && node site/serve.mjs [--port 4173]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE } from "./build.mjs";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "_site");
const at = process.argv.indexOf("--port");
const port = Number(at > 0 ? process.argv[at + 1] : (process.env.PORT ?? 4173));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

http
  .createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (!url.startsWith(BASE)) {
      res.writeHead(302, { location: BASE }).end();
      return;
    }
    let file = path.join(out, url.slice(BASE.length));
    if (!file.startsWith(out)) file = out;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const found = fs.existsSync(file);
    if (!found) file = path.join(out, "404.html");
    res.writeHead(found ? 200 : 404, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`site: http://localhost:${port}${BASE}`));
