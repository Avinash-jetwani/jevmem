// ISBN helpers. Inputs may contain hyphens or spaces; outputs never do.

export function normalise(raw) {
  return String(raw).replace(/[\s-]/g, "").toUpperCase();
}

export function isValidIsbn10(raw) {
  const s = normalise(raw);
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (10 - i) * parseInt(s[i], 10);
  return sum % 11 === 0;
}

export function isValidIsbn13(raw) {
  const s = normalise(raw);
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(s[i]);
  return sum % 10 === 0;
}

export function toIsbn13(raw) {
  const s = normalise(raw);
  if (!isValidIsbn10(s)) throw new Error(`not a valid ISBN-10: ${raw}`);
  const body = "978" + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(body[i]);
  return body + ((10 - (sum % 10)) % 10);
}

export function parseIsbn(raw) {
  const s = normalise(raw);
  if (s.length === 10) {
    if (!isValidIsbn10(s)) throw new Error(`bad ISBN-10: ${raw}`);
    return { kind: "isbn10", value: s, isbn13: toIsbn13(s) };
  }
  if (s.length === 13) {
    if (!isValidIsbn13(s)) throw new Error(`bad ISBN-13: ${raw}`);
    return { kind: "isbn13", value: s, isbn13: s };
  }
  throw new Error(`not an ISBN: ${raw}`);
}
