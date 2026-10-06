import { load, update } from './store.js';
import { settings } from './config.js';

export const STATES = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  DEAD: 'dead',
});

let seq = 0;

function nextId(now) {
  seq += 1;
  return `${now.toString(36)}-${process.pid.toString(36)}-${seq.toString(36)}`;
}

function copy(job) {
  return JSON.parse(JSON.stringify(job));
}

function find(db, id) {
  const job = db.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`no such job: ${id}`);
  return job;
}

function active(db, id) {
  const job = find(db, id);
  if (job.state !== STATES.ACTIVE) throw new Error(`job ${id} is not active`);
  return job;
}

// Delay before the next attempt: base, 2x base, 4x base, ... up to the cap.
export function backoffMs(attempts, cfg = settings()) {
  return Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (attempts - 1));
}

// Ends an attempt that did not finish the job: pending again after the backoff,
// or dead when the attempts are used up.
function giveBack(job, reason, now, cfg) {
  job.worker = null;
  job.leaseUntil = null;
  job.lastError = reason;
  if (job.attempts >= job.maxAttempts) {
    job.state = STATES.DEAD;
    job.finishedAt = now;
  } else {
    job.state = STATES.PENDING;
    job.runAt = now + backoffMs(job.attempts, cfg);
  }
}

export function enqueue(type, payload = null, { delayMs = 0, maxAttempts, now = Date.now() } = {}) {
  if (!type) throw new Error('a job needs a type');
  const cfg = settings();
  return update((db) => {
    const job = {
      id: nextId(now),
      type,
      payload,
      state: STATES.PENDING,
      attempts: 0,
      maxAttempts: maxAttempts ?? cfg.maxAttempts,
      createdAt: now,
      runAt: now + delayMs,
      leaseUntil: null,
      worker: null,
      lastError: null,
    };
    db.jobs.push(job);
    return copy(job);
  });
}

// Hands out the first pending job that is due and leases it to the worker.
export function claim({ worker = `pid-${process.pid}`, leaseMs, now = Date.now() } = {}) {
  const cfg = settings();
  return update((db) => {
    for (const job of db.jobs) {
      if (job.state === STATES.ACTIVE && job.leaseUntil <= now) giveBack(job, 'lease expired', now, cfg);
    }
    const job = db.jobs.find((j) => j.state === STATES.PENDING && j.runAt <= now);
    if (!job) return null;
    job.state = STATES.ACTIVE;
    job.attempts += 1;
    job.worker = worker;
    job.leaseUntil = now + (leaseMs ?? cfg.leaseMs);
    return copy(job);
  });
}

export function renew(id, { leaseMs, now = Date.now() } = {}) {
  const cfg = settings();
  return update((db) => {
    const job = active(db, id);
    job.leaseUntil = now + (leaseMs ?? cfg.leaseMs);
    return copy(job);
  });
}

export function complete(id, result = null, { now = Date.now() } = {}) {
  return update((db) => {
    const job = active(db, id);
    job.state = STATES.DONE;
    job.result = result;
    job.worker = null;
    job.leaseUntil = null;
    job.finishedAt = now;
    return copy(job);
  });
}

export function fail(id, reason = 'failed', { now = Date.now() } = {}) {
  const cfg = settings();
  return update((db) => {
    const job = active(db, id);
    giveBack(job, String(reason), now, cfg);
    return copy(job);
  });
}

export function list() {
  return load().jobs.map(copy);
}

export function stats() {
  const counts = { pending: 0, active: 0, done: 0, dead: 0 };
  for (const job of load().jobs) counts[job.state] += 1;
  return counts;
}
