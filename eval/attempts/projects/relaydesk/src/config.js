import fs from 'node:fs';

const DEFAULTS = {
  leaseMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffCapMs: 3_600_000,
};

// Reads KEY=VALUE lines from a .env file into process.env.
// Variables that are already set keep their value. Returns false when there is no file.
export function loadEnv(file = '.env') {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function number(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function settings(env = process.env) {
  return {
    leaseMs: number(env.RELAYDESK_LEASE_MS, DEFAULTS.leaseMs),
    maxAttempts: number(env.RELAYDESK_MAX_ATTEMPTS, DEFAULTS.maxAttempts),
    backoffBaseMs: number(env.RELAYDESK_BACKOFF_BASE_MS, DEFAULTS.backoffBaseMs),
    backoffCapMs: number(env.RELAYDESK_BACKOFF_CAP_MS, DEFAULTS.backoffCapMs),
  };
}
