import { log } from "./log.js";

/** GET a JSON document with a 5 s timeout and one retry. Every outbound request goes through here. */
export async function httpGet<T>(url: string, init: { headers?: Record<string, string> } = {}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(url, { headers: init.headers, signal: ac.signal });
      if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
      return (await r.json()) as T;
    } catch (err) {
      lastError = err;
      log.debug({ url, attempt, err }, "http get failed");
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
