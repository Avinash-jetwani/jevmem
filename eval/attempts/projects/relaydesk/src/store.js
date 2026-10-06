import fs from 'node:fs';
import path from 'node:path';
import { acquire } from './lock.js';

const file = path.resolve(process.env.RELAYDESK_DB ?? 'relaydesk.json');
let state = null;
let stamp = null;

function fingerprint() {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    throw err;
  }
}

export function dbPath() {
  return file;
}

// Returns the queue state: { version, jobs }.
export function load() {
  const seen = fingerprint();
  if (state && seen === stamp) return state;
  state = seen === 'absent' ? { version: 1, jobs: [] } : JSON.parse(fs.readFileSync(file, 'utf8'));
  stamp = seen;
  return state;
}

export function save() {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
  stamp = fingerprint();
}

// Runs fn(state) under the store lock and writes the state back.
export function update(fn) {
  const release = acquire(`${file}.lock`);
  try {
    const result = fn(load());
    save();
    return result;
  } catch (err) {
    state = null;
    throw err;
  } finally {
    release();
  }
}

// Keeps the store as it is now under <store>.<name>.snap and returns that path.
export function snapshot(name) {
  if (!name) throw new Error('a snapshot needs a name');
  const target = `${file}.${name}.snap`;
  fs.rmSync(target, { force: true });
  fs.linkSync(file, target);
  return target;
}
