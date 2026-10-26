/**
 * Reads a DTSTART/DTEND value: `20261024T090000Z` (UTC), `20261024T090000` (floating, read as local time),
 * `20261024` with `VALUE=DATE` (all day). A TZID parameter is kept on the event's lines and otherwise ignored.
 */
export function parseStamp(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  if (params.VALUE === "DATE" || !m[4]) return new Date(Number(y), Number(mo) - 1, Number(d));
  if (z === "Z") return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

const pad = (n) => String(n).padStart(2, "0");

/** `2026-10-24 09:00` in local time, or `2026-10-24` for an all-day event. */
export function formatStamp(date, allDay = false) {
  if (!date) return "????-??-??";
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return allDay ? day : `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
