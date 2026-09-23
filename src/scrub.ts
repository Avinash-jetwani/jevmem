/**
 * Strip anything that looks like a credential before it reaches Jev or the writer LLM.
 * Deliberately over-eager: a redacted token never hurts a memory decision, a leaked one does.
 */
const PATTERNS: RegExp[] = [
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
  // Env-style assignments of any length: DB_PASSWORD=x, AWS_SECRET_ACCESS_KEY=x, GITHUB_TOKEN=x, STRIPE_KEY: x.
  /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_(?:PASSWORD|PASSWD|PWD|PASS|SECRET|TOKEN|KEY|SECRET_KEY|ACCESS_KEY)\b(\s*[:=]\s*)["']?[^\s"',;]+["']?/gi,
  // Passwords of any length after password= / passwd: / pwd= / pass:.
  /\b(?:password|passwd|pwd|pass)\b(\s*[:=]\s*)["']?[^\s"',;]+["']?/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd|token|secret)\b(\s*[:=]\s*|\s+is\s+)["']?[^\s"',;]{8,}["']?/gi,
  /\b[A-Za-z0-9+/=_-]{48,}\b/g, // long opaque blobs (base64-ish)
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]+@/gi, // creds in URLs
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses (PII)
  /\b(?:\d[ -]?){15}\d\b/g, // 16-digit numbers (card numbers), with or without separators
];

export const REDACTED = "[REDACTED]";

export function scrubSecrets(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(re, (m, ...rest) => {
      // For the key=value family keep the key name so Jev still knows what was said.
      // `rest` is (...captureGroups, offset, input): only the key=value patterns have a capture group.
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
