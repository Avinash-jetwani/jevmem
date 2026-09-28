import { parseStamp } from "./time.mjs";

/** One matching line as printed: the line itself (text), or `{"time": …, "line": …}` (json). */
export function formatLine(line, format) {
  if (format === "json") {
    const at = parseStamp(line);
    return JSON.stringify({ time: at ? at.toISOString() : null, line });
  }
  return line;
}
