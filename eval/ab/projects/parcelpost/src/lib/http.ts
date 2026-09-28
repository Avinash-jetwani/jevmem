import { log } from "./log.js";

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

async function request<T>(method: string, url: string, body: unknown, opts: HttpOptions): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...opts.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      log.debug({ method, url, status: res.status, ms: Date.now() - started }, "http");
      if (res.status >= 500 && attempt < retries) continue;
      if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= retries) throw err;
      log.warn({ method, url, attempt, err: String(err) }, "http retry");
    }
  }
}

export function httpGet<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  return request<T>("GET", url, undefined, opts);
}

export function httpPost<T>(url: string, body: unknown, opts: HttpOptions = {}): Promise<T> {
  return request<T>("POST", url, body, opts);
}
