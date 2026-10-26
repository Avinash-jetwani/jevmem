import { formatStamp } from "./time.mjs";

/** One line per event: the start, the summary and the feed it came from. */
export function listing(events) {
  if (!events.length) return "no events\n";
  return events.map((e) => `${formatStamp(e.start, e.allDay).padEnd(16)}  ${e.summary || "(untitled)"}  (${e.feed})`).join("\n") + "\n";
}
