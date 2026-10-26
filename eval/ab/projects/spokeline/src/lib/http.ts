import { log } from "./log.js";

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

async function request<T>(method: string, url: string, body: unknown, opts: HttpOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    log.debug({ method, url, status: res.status, ms: Date.now() - started }, "outbound http");
    if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const httpGet = <T>(url: string, opts: HttpOptions = {}) => request<T>("GET", url, undefined, opts);
export const httpPost = <T>(url: string, body: unknown, opts: HttpOptions = {}) => request<T>("POST", url, body, opts);
