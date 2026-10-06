import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaydesk-queue-'));
const file = path.join(dir, 'queue.json');
process.env.RELAYDESK_DB = file;
const queue = await import('../src/queue.js');
const { runJob, drain } = await import('../src/worker.js');

const T0 = 1_700_000_000_000;
const SECOND = 1_000;

beforeEach(() => fs.rmSync(file, { force: true }));

test('a new job is pending and has not been tried', () => {
  const job = queue.enqueue('mail', { to: 'ops' }, { now: T0 });
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
  assert.deepEqual(job.payload, { to: 'ops' });
  assert.deepEqual(queue.stats(), { pending: 1, active: 0, done: 0, dead: 0 });
});

test('every job gets its own id', () => {
  const made = [1, 2, 3].map(() => queue.enqueue('mail', null, { now: T0 }).id);
  assert.equal(new Set(made).size, 3);
  assert.ok(made.every((id) => typeof id === 'string' && id.length > 0));
});

test('claim returns null when nothing is ready', () => {
  assert.equal(queue.claim({ now: T0 }), null);
});

test('claim hands out jobs oldest first', () => {
  const first = queue.enqueue('mail', 1, { now: T0 });
  const second = queue.enqueue('mail', 2, { now: T0 });
  assert.equal(queue.claim({ now: T0 }).id, first.id);
  assert.equal(queue.claim({ now: T0 }).id, second.id);
  assert.equal(queue.claim({ now: T0 }), null);
});

test('a claimed job carries the worker, the lease and the attempt', () => {
  queue.enqueue('mail', null, { now: T0 });
  const job = queue.claim({ worker: 'w1', leaseMs: 5 * SECOND, now: T0 });
  assert.equal(job.state, 'active');
  assert.equal(job.worker, 'w1');
  assert.equal(job.attempts, 1);
  assert.equal(job.leaseUntil, T0 + 5 * SECOND);
});

test('what claim returns is a copy', () => {
  queue.enqueue('mail', { n: 1 }, { now: T0 });
  const job = queue.claim({ now: T0 });
  job.payload.n = 99;
  job.state = 'done';
  assert.equal(queue.list()[0].payload.n, 1);
  assert.equal(queue.list()[0].state, 'active');
});

test('a delayed job waits for its time', () => {
  queue.enqueue('mail', null, { delayMs: 10 * SECOND, now: T0 });
  assert.equal(queue.claim({ now: T0 + 9 * SECOND }), null);
  assert.equal(queue.claim({ now: T0 + 10 * SECOND }).attempts, 1);
});

test('a job whose lease ran out is tried again after the backoff', () => {
  const { id } = queue.enqueue('mail', null, { now: T0 });
  queue.claim({ leaseMs: SECOND, now: T0 });
  assert.equal(queue.claim({ now: T0 + SECOND }), null);
  assert.equal(queue.list()[0].lastError, 'lease expired');
  const again = queue.claim({ now: T0 + 2 * SECOND });
  assert.equal(again.id, id);
  assert.equal(again.attempts, 2);
});

test('renew pushes the lease out', () => {
  const { id } = queue.enqueue('mail', null, { now: T0 });
  queue.claim({ leaseMs: SECOND, now: T0 });
  queue.renew(id, { leaseMs: 5 * SECOND, now: T0 + 500 });
  assert.equal(queue.claim({ now: T0 + 2 * SECOND }), null);
  assert.equal(queue.list()[0].state, 'active');
});

test('backoff doubles with every attempt up to the cap', () => {
  const cfg = { backoffBaseMs: 100, backoffCapMs: 1_000 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => queue.backoffMs(n, cfg)), [100, 200, 400, 800, 1_000, 1_000]);
});

test('fail puts the job back with the reason', () => {
  const { id } = queue.enqueue('mail', null, { now: T0 });
  queue.claim({ now: T0 });
  const job = queue.fail(id, 'smtp down', { now: T0 });
  assert.equal(job.state, 'pending');
  assert.equal(job.lastError, 'smtp down');
  assert.equal(job.runAt, T0 + SECOND);
});

test('a job is dead once its attempts are used up', () => {
  const { id } = queue.enqueue('mail', null, { maxAttempts: 2, now: T0 });
  queue.claim({ now: T0 });
  queue.fail(id, 'first', { now: T0 });
  queue.claim({ now: T0 + SECOND });
  const job = queue.fail(id, 'second', { now: T0 + SECOND });
  assert.equal(job.state, 'dead');
  assert.equal(queue.claim({ now: T0 + 60 * SECOND }), null);
  assert.deepEqual(queue.stats(), { pending: 0, active: 0, done: 0, dead: 1 });
});

test('complete and fail refuse a job that is not active', () => {
  const { id } = queue.enqueue('mail', null, { now: T0 });
  assert.throws(() => queue.complete(id), /not active/);
  assert.throws(() => queue.fail(id, 'x'), /not active/);
  assert.throws(() => queue.complete('missing'), /no such job/);
});

test('runJob completes a job with what the handler returns', async () => {
  queue.enqueue('sum', [2, 3], { now: T0 });
  const job = await runJob(queue.claim({ now: T0 }), { sum: ([a, b]) => a + b });
  assert.equal(job.state, 'done');
  assert.equal(job.result, 5);
});

test('runJob records why a handler failed', async () => {
  const handlers = {
    sync: () => {
      throw new Error('bad input');
    },
    later: async () => {
      throw new Error('no route');
    },
  };
  queue.enqueue('sync', null, { now: T0 });
  queue.enqueue('later', null, { now: T0 });
  const first = await runJob(queue.claim({ now: T0 }), handlers);
  const second = await runJob(queue.claim({ now: T0 }), handlers);
  assert.deepEqual([first.state, first.lastError], ['pending', 'bad input']);
  assert.deepEqual([second.state, second.lastError], ['pending', 'no route']);
});

test('runJob fails a job nobody handles or that takes too long', async () => {
  queue.enqueue('unknown', null, { now: T0 });
  queue.enqueue('stuck', null, { now: T0 });
  const unknown = await runJob(queue.claim({ now: T0 }), {});
  const stuck = await runJob(queue.claim({ now: T0 }), { stuck: () => new Promise(() => {}) }, { timeoutMs: 20 });
  assert.equal(unknown.lastError, 'no handler for type unknown');
  assert.equal(stuck.lastError, 'timed out after 20 ms');
});

test('drain runs everything that is ready', async () => {
  for (const n of [1, 2, 3]) queue.enqueue('double', n, { now: T0 });
  const finished = await drain({ double: (n) => n * 2 }, { now: T0 });
  assert.deepEqual(finished.map((job) => job.result), [2, 4, 6]);
  assert.deepEqual(queue.stats(), { pending: 0, active: 0, done: 3, dead: 0 });
});
