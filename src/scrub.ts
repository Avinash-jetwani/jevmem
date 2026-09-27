/**
 * Strip anything that looks like a credential before it reaches Jev or the writer LLM.
 * Deliberately over-eager: a redacted token never hurts a memory decision, a leaked one does. It is pattern-based, so a
 * secret in a form it does not know (an unnamed value, a name it does not recognise) still gets through.
 */
const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|rk|pk)-(?:proj|ant|live|test)?-?[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic / Stripe style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bnpm_[A-Za-z0-9]{20,}\b/g, // npm tokens
  /\bhf_[A-Za-z0-9]{20,}\b/g, // Hugging Face tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab personal access tokens
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe secret / restricted keys
];

const REST: RegExp[] = [
  // "the token is abcdefgh…": a few fixed names, then " is " and at least 8 characters. (Their `:`/`=` pairs are
  // caught above at any length.)
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd|token|secret)\b(\s*[:=]\s*|\s+is\s+)["']?[^\s"',;]{8,}["']?/gi,
  /\b[A-Za-z0-9+/=_-]{48,}\b/g, // long opaque blobs (base64-ish)
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]+@/gi, // creds in URLs
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses (PII)
  /\b(?:\d[ -]?){15}\d\b/g, // 16-digit numbers (card numbers), with or without separators
];

export const REDACTED = "[REDACTED]";

/** The words that make a name a secret's, at the end of one of its parts: PGPASSWORD, DB_PASSWORD, apiKey, x-auth-token. */
const SECRET_WORD = /(?:password|passwd|pwd|secret|token|key)$/;
/** Everyday words that end in "key". */
const NOT_SECRET = new Set(["monkey", "donkey", "turkey", "hockey", "jockey", "whiskey", "lackey", "hotkey", "turnkey"]);

/**
 * Is this the name of a secret? True when one of its parts ends in PASSWORD, PASSWD, PWD, SECRET, TOKEN or KEY, or is
 * PASS, in any case. Parts are split at `_`, `-`, `.`, digits and camelCase humps, so PGPASSWORD, DB_PASSWORD,
 * SECRET_KEY_BASE, apikey, apiKey and X-Auth-Token are secret names, and keyboard, tokenizer, MAX_TOKENS and monkey are
 * not.
 */
export function isSecretName(name: string): boolean {
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.\-0-9]+/);
  return parts.some((p) => p === "pass" || (SECRET_WORD.test(p) && !NOT_SECRET.has(p)));
}

/** A name as written in env files, YAML, JSON, headers and flags: DB_PASSWORD, api-key, spring.datasource.password. */
const NAME = String.raw`[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_])?`;
/**
 * `NAME=`, `NAME:`, `NAME :=` (not `==`, `=>` or `::`). The value is matched on its own, from where this ends; it may
 * start on the next line (`password:` then the password), as it could before.
 */
const PAIR = new RegExp(String.raw`(?<![A-Za-z0-9_])(${NAME})[ \t]*(?::=|[:=](?![=>:]))\s*`, "g");
/** `"name":` or `'name':` (JSON, a YAML flow mapping, a Python dict; TOML's `=` too). */
const QUOTED_PAIR = new RegExp(String.raw`(["'])(${NAME})\1([ \t]*[:=][ \t]*)`, "g");
/** A value: a quoted string, to its closing quote on the same line; else everything up to a space, quote, comma or semicolon. */
const VALUE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|["']?[^\s"',;]+["']?/y;
/** After a quoted name: a quoted string, or a bare scalar (a number, true, null), never the start of an object or array. */
const QUOTED_VALUE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s"',;{}[\]]+/y;

/**
 * Redact the value of every pair whose name is a secret's. `head` matches a name and its separator; the value is
 * matched from there, so a pair whose name is not a secret's never swallows the pair after it ("Note: token: x").
 */
function redactPairs(text: string, head: RegExp, value: RegExp, nameAt: number, render: (m: RegExpExecArray, v: string) => string): string {
  let out = "";
  let last = 0;
  head.lastIndex = 0;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    if (!isSecretName(m[nameAt]!)) continue;
    value.lastIndex = head.lastIndex;
    const v = value.exec(text);
    if (!v) continue;
    out += text.slice(last, m.index) + render(m, v[0]);
    last = head.lastIndex = value.lastIndex;
  }
  return out + text.slice(last);
}

export function scrubSecrets(input: string): string {
  let out = input;
  for (const re of SHAPES) out = out.replace(re, REDACTED);
  // "key": "value" keeps its quotes and separator; KEY=value, KEY: value and KEY := value become KEY=[REDACTED].
  out = redactPairs(out, QUOTED_PAIR, QUOTED_VALUE, 2, (m, v) => {
    const q = /^["']/.test(v) ? v[0]! : m[1]!;
    return `${m[1]}${m[2]}${m[1]}${m[3]}${q}${REDACTED}${q}`;
  });
  out = redactPairs(out, PAIR, VALUE, 1, (m) => `${m[1]}=${REDACTED}`);
  for (const re of REST) {
    out = out.replace(re, (m, ...rest) => {
      // For the "is" family keep the key name so Jev still knows what was said.
      // `rest` is (...captureGroups, offset, input): only that pattern has a capture group.
      const hasGroup = rest.length > 2;
      if (hasGroup && /^[A-Za-z0-9_-]+(?:\s*[:=]|\s+is\s)/.test(m)) {
        const idx = m.search(/[:=]|\sis\s/);
        return idx > 0 ? `${m.slice(0, idx).trim()}=${REDACTED}` : REDACTED;
      }
      if (/^(?:postgres|postgresql|mysql|mongodb|redis|amqp)/i.test(m)) {
        return m.replace(/:\/\/[^:\s/]+:[^@\s]+@/, `://${REDACTED}@`);
      }
      return REDACTED;
    });
  }
  return out;
}

export function looksLikeSecret(input: string): boolean {
  return scrubSecrets(input) !== input;
}
