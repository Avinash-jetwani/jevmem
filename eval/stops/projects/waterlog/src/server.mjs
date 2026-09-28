import http from "node:http";
import { load, recordWatering } from "./store.mjs";

const PORT = Number(process.env.PORT ?? 3000);

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/plants") return send(res, 200, load().plants);
  const m = /^\/plants\/([^/]+)\/water$/.exec(url.pathname);
  if (req.method === "POST" && m) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { by } = JSON.parse(body || "{}");
        const name = decodeURIComponent(m[1]);
        console.log(`watering ${name} by ${by}`);
        send(res, 200, recordWatering(name, by));
      } catch (err) {
        console.error(err);
        send(res, 500, { error: "internal error" });
      }
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`waterlog on :${PORT}`));
