import { parseStamp } from "./time.mjs";

/** Joins folded lines (RFC 5545 3.1): a line starting with a space or tab continues the previous one. */
export function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

/** Splits one content line into its name, parameters and value: `DTSTART;TZID=Europe/Berlin:20261024T090000`. */
export function splitLine(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(";");
  const params = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Parses iCalendar text into { name, events }. Each event keeps its raw property lines for round-tripping. */
export function parseIcs(text) {
  const lines = unfold(text).split("\n").filter((l) => l.length);
  const out = { name: null, events: [] };
  let current = null;
  for (const line of lines) {
    const prop = splitLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value === "VEVENT") {
      current = { uid: null, summary: "", start: null, end: null, allDay: false, lines: [] };
      continue;
    }
    if (prop.name === "END" && prop.value === "VEVENT") {
      if (current) out.events.push(current);
      current = null;
      continue;
    }
    if (!current) {
      if (prop.name === "X-WR-CALNAME") out.name = prop.value;
      continue;
    }
    current.lines.push(line);
    if (prop.name === "UID") current.uid = prop.value;
    else if (prop.name === "SUMMARY") current.summary = unescapeText(prop.value);
    else if (prop.name === "DTSTART") {
      current.start = parseStamp(prop.value, prop.params);
      current.allDay = prop.params.VALUE === "DATE";
    } else if (prop.name === "DTEND") current.end = parseStamp(prop.value, prop.params);
  }
  return out;
}

export function unescapeText(value) {
  return value.replace(/\\n/g, "\n").replace(/\\([,;\\])/g, "$1");
}

/** Writes events back out as one calendar, with the lines folded at 75 octets. */
export function serializeIcs(events, { name = "calmerge" } = {}) {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//calmerge//EN", `X-WR-CALNAME:${name}`];
  for (const e of events) {
    out.push("BEGIN:VEVENT", ...e.lines, "END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return out.map(fold).join("\r\n") + "\r\n";
}

function fold(line) {
  const parts = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    parts.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  parts.push(rest);
  return parts.join("\r\n");
}
