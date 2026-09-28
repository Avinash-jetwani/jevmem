const RELATIVE = /^(\d+)([smhd])$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A `--since` value: ISO 8601, or relative to now (`2h`, `30m`). Returns null when it can't be read. */
export function parseWhen(value, now = Date.now()) {
  const rel = RELATIVE.exec(value);
  if (rel) return new Date(now - Number(rel[1]) * UNIT_MS[rel[2]]);
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

/** The timestamp at the start of a log line, in the three formats our services write. Null when there is none. */
export function parseStamp(line) {
  let m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(line);
  if (m) return new Date(m[1]);
  m = /^\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) \+0000\]/.exec(line);
  if (m) return new Date(`${m[2]} ${m[1]} ${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`);
  m = /^(\d{10})(?:\.\d+)?\s/.exec(line);
  if (m) return new Date(Number(m[1]) * 1000);
  return null;
}
