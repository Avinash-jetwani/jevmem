import fs from "node:fs/promises";

const TIMEOUT_MS = 10_000;

/** Reads one feed: an http(s) URL (with a timeout) or a file path. Throws when it cannot be read. */
export async function readFeed(source) {
  if (/^https?:\/\//.test(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(source, { signal: controller.signal, headers: { accept: "text/calendar, */*" } });
      if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  return fs.readFile(source, "utf8");
}
