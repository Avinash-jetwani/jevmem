import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { noul } from "@typesafe-ai/sdk";
import { cacheDir, cacheKey, createJev, isVercelGateway, pruneCache, readLog, summarizeLog } from "../src/jev.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-cache-"));

function fakeFetch(seen: any[]): (input: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ model: "jev-test", answers: { q: { type: "noul", noul: 0.77 } }, usage: { input_tokens: 100, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("answer cache", () => {
  it("serves an identical (state, questions) from disk without a request, and logs the hit", async () => {
    const root = tmp();
    const seen: any[] = [];
    const jev = createJev({ root, apiKey: "k", fetch: fakeFetch(seen) });
    const q = { q: noul("Is it?") };
    const a = await jev.call("hello", q, { label: "decide" });
    const b = await jev.call("hello", q, { label: "decide" });
    expect(seen).toHaveLength(1);
    expect(a.answers.q.noul).toBe(0.77);
    expect(b.answers.q.noul).toBe(0.77);
    expect((b as any).cacheHit).toBe(true);
    expect(fs.readdirSync(cacheDir(root))).toHaveLength(1);
    const log = readLog(root);
    expect(log.map((e) => e.cacheHit)).toEqual([false, true]);
    expect(log[1]!.costUsd).toBe(0);
    const s = summarizeLog(log);
    expect(s.cacheHits).toBe(1);
    expect(s.cacheHitRate).toBe(0.5);
    // Billed on input tokens only (100), not input + output (103).
    expect(log[0]!.costUsd).toBe((100 / 1e6) * 0.042);
    expect(s.totalCostUsd).toBe((100 / 1e6) * 0.042);
    // A different state misses.
    await jev.call("hello again", q, { label: "decide" });
    expect(seen).toHaveLength(2);
  });

  it("keys on model + state + questions and can be disabled", async () => {
    const root = tmp();
    expect(cacheKey("m", "s", { q: noul("a") })).not.toBe(cacheKey("m", "s", { q: noul("b") }));
    expect(cacheKey("m1", "s", { q: noul("a") })).not.toBe(cacheKey("m2", "s", { q: noul("a") }));
    const seen: any[] = [];
    const jev = createJev({ root, apiKey: "k", fetch: fakeFetch(seen), cache: false });
    await jev.call("x", { q: noul("a") }, { label: "decide" });
    await jev.call("x", { q: noul("a") }, { label: "decide" });
    expect(seen).toHaveLength(2);
  });

  it("never caches the daemon prewarm call and prunes the oldest entries past the cap", async () => {
    const root = tmp();
    const seen: any[] = [];
    const jev = createJev({ root, apiKey: "k", fetch: fakeFetch(seen) });
    await jev.call("ready", { q: noul("a") }, { label: "prewarm" });
    expect(fs.existsSync(cacheDir(root))).toBe(false);
    for (let i = 0; i < 12; i++) await jev.call(`s${i}`, { q: noul("a") }, { label: "decide" });
    expect(pruneCache(root, 10)).toBe(2);
    expect(fs.readdirSync(cacheDir(root))).toHaveLength(10);
  });

  it("sends zeroDataRetention only for a Vercel gateway or when forced", async () => {
    const root = tmp();
    expect(isVercelGateway("https://ai-gateway.vercel.sh/v1")).toBe(true);
    expect(isVercelGateway("https://api.typesafe.ai")).toBe(false);
    const seen: any[] = [];
    await createJev({ root, apiKey: "k", fetch: fakeFetch(seen), cache: false, baseURL: "https://api.typesafe.ai" }).call("s", { q: noul("a") }, { label: "decide" });
    expect(seen[0].body.zeroDataRetention).toBeUndefined();
    await createJev({ root, apiKey: "k", fetch: fakeFetch(seen), cache: false, baseURL: "https://ai-gateway.vercel.sh/typesafe" }).call("s", { q: noul("a") }, { label: "decide" });
    expect(seen[1].body.zeroDataRetention).toBe(true);
    await createJev({ root, apiKey: "k", fetch: fakeFetch(seen), cache: false, zeroDataRetention: true }).call("s", { q: noul("a") }, { label: "decide" });
    expect(seen[2].body.zeroDataRetention).toBe(true);
  });
});
