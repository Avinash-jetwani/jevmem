import crypto from "node:crypto";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A public id: 20 characters from an alphabet without look-alikes, safe in URLs and easy to read out. */
export function newId(): string {
  const bytes = crypto.randomBytes(20);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
