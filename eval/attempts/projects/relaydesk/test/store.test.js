import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaydesk-store-'));
const file = path.join(dir, 'store.json');
process.env.RELAYDESK_DB = file;
const store = await import('../src/store.js');

const onDisk = (p = file) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ids = (db) => db.jobs.map((job) => job.id);

test('uses the path from RELAYDESK_DB', () => {
  assert.equal(store.dbPath(), file);
});

test('starts empty when there is no file yet', () => {
  assert.deepEqual(store.load(), { version: 1, jobs: [] });
  assert.equal(fs.existsSync(file), false);
});

test('update writes what the callback changed', () => {
  const returned = store.update((db) => {
    db.jobs.push({ id: 'a', type: 'mail' });
    return db.jobs.length;
  });
  assert.equal(returned, 1);
  assert.deepEqual(onDisk().jobs, [{ id: 'a', type: 'mail' }]);
});

test('leaves only the store file behind', () => {
  assert.deepEqual(fs.readdirSync(dir), ['store.json']);
});

test('sees a change another process wrote', () => {
  const db = onDisk();
  db.jobs.push({ id: 'b', type: 'mail' });
  fs.writeFileSync(file, JSON.stringify(db));
  assert.deepEqual(ids(store.load()), ['a', 'b']);
});

test('a snapshot keeps the jobs it was taken with', () => {
  const snap = store.snapshot('before-c');
  store.update((db) => {
    db.jobs.push({ id: 'c', type: 'mail' });
  });
  assert.deepEqual(ids(onDisk(snap)), ['a', 'b']);
  assert.deepEqual(ids(onDisk()), ['a', 'b', 'c']);
});

test('a snapshot takes no space of its own', () => {
  const snap = store.snapshot('free');
  assert.equal(fs.statSync(snap).ino, fs.statSync(file).ino);
});

test('a callback that throws changes nothing and frees the lock', () => {
  assert.throws(
    () =>
      store.update((db) => {
        db.jobs.length = 0;
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.deepEqual(ids(store.load()), ['a', 'b', 'c']);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(store.update((db) => db.jobs.length), 3);
});
