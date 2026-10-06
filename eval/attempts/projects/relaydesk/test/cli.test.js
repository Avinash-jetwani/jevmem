import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatAge, parseArgs } from '../src/cli.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// A working directory of its own, and a runner for the CLI inside it.
function sandbox(extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relaydesk-cli-'));
  const env = { ...process.env, RELAYDESK_DB: path.join(cwd, 'jobs.json'), ...extraEnv };
  for (const key of Object.keys(env)) if (env[key] === null) delete env[key];
  const run = (...args) => {
    const res = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
    return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
  };
  return { cwd, run };
}

test('formatAge prints seconds, minutes and hours', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(59_999), '59s');
  assert.equal(formatAge(192_000), '3m 12s');
  assert.equal(formatAge(7_500_000), '2h 5m');
});

test('parseArgs separates options from arguments', () => {
  assert.deepEqual(parseArgs(['mail', '--lease', '500', '--worker=w1', '{}']), {
    args: ['mail', '{}'],
    opts: { lease: '500', worker: 'w1' },
  });
});

test('enqueue prints the id and list shows the job', () => {
  const { run } = sandbox();
  const id = run('enqueue', 'mail', '{"to":"ops"}').out;
  assert.match(id, /\S+/);
  const line = run('list').out;
  assert.ok(line.startsWith(`${id}  mail  pending  0/3  `), line);
});

test('claim prints the job as JSON and holds it for the lease', () => {
  const { run } = sandbox();
  const id = run('enqueue', 'mail').out;
  const job = JSON.parse(run('claim', '--worker', 'w1', '--lease', '60000').out);
  assert.equal(job.id, id);
  assert.equal(job.worker, 'w1');
  assert.equal(run('claim').out, 'nothing ready');
});

test('done and fail move a job on, and stats counts them', () => {
  const { run } = sandbox();
  const a = run('enqueue', 'mail').out;
  const b = run('enqueue', 'mail', '--max-attempts', '1').out;
  run('claim');
  run('claim');
  assert.equal(run('done', a).out, 'done');
  assert.equal(run('fail', b, 'bounced').out, 'dead');
  assert.deepEqual(JSON.parse(run('stats').out), { pending: 0, active: 0, done: 1, dead: 1 });
});

test('work runs the handlers from a module', () => {
  const { cwd, run } = sandbox();
  fs.writeFileSync(path.join(cwd, 'handlers.js'), 'export default { upper: (text) => text.toUpperCase() };\n');
  run('enqueue', 'upper', '"hello"');
  run('enqueue', 'upper', '"queue"');
  assert.equal(run('work', 'handlers.js').out, 'ran 2 job(s)');
  assert.deepEqual(JSON.parse(run('stats').out), { pending: 0, active: 0, done: 2, dead: 0 });
});

test('snapshot prints where the copy is', () => {
  const { cwd, run } = sandbox();
  run('enqueue', 'mail');
  const target = run('snapshot', 'nightly').out;
  assert.equal(path.basename(target), 'jobs.json.nightly.snap');
  assert.ok(fs.existsSync(path.join(cwd, 'jobs.json.nightly.snap')));
});

test('the store path can come from .env in the working directory', () => {
  const { cwd, run } = sandbox({ RELAYDESK_DB: null });
  fs.writeFileSync(path.join(cwd, '.env'), '# local settings\nRELAYDESK_DB="from-dotenv.json"\nRELAYDESK_MAX_ATTEMPTS=7\n');
  run('enqueue', 'mail');
  assert.ok(fs.existsSync(path.join(cwd, 'from-dotenv.json')));
  assert.match(run('list').out, /  0\/7  /);
});

test('the environment wins over .env', () => {
  const { cwd, run } = sandbox();
  fs.writeFileSync(path.join(cwd, '.env'), 'RELAYDESK_DB=from-dotenv.json\n');
  run('enqueue', 'mail');
  assert.ok(fs.existsSync(path.join(cwd, 'jobs.json')));
  assert.equal(fs.existsSync(path.join(cwd, 'from-dotenv.json')), false);
});

test('an unknown command prints the usage and exits with 1', () => {
  const { run } = sandbox();
  const res = run('frobnicate');
  assert.equal(res.code, 1);
  assert.match(res.err, /^usage: relaydesk/);
});

test('an error is reported in one line', () => {
  const { run } = sandbox();
  const res = run('done', 'nope');
  assert.equal(res.code, 1);
  assert.equal(res.err, 'relaydesk: no such job: nope');
});
