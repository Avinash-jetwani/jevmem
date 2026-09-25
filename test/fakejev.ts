/**
 * A local HTTP stand-in for `POST /v1/systemone`, for tests that must go through the real SDK client and the built
 * CLI (exit codes, retries after a 529). Point `TYPESAFE_BASE_URL` at `url`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Questions } from "@typesafe-ai/sdk";
import { makeAnswers, type AnswerOverrides } from "./helpers.js";

export interface FakeJev {
  url: string;
  requests: { state: any; questions: Questions }[];
  close: () => Promise<void>;
}

/** `respond` returns answer overrides, or `{ status }` to fail the request with that HTTP status. */
export async function startFakeJev(respond: (questions: Questions, state: any, i: number) => AnswerOverrides | { status: number }): Promise<FakeJev> {
  const requests: FakeJev["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: any = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* empty */
      }
      requests.push({ state: parsed.state, questions: parsed.questions });
      const r = respond(parsed.questions ?? {}, parsed.state, requests.length - 1) as any;
      if (r && typeof r.status === "number") {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "overloaded_error", message: "fake outage" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(makeAnswers(parsed.questions ?? {}, r)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
