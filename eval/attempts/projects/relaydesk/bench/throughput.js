// Enqueues, claims and completes N jobs against a store in the temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaydesk-bench-'));
process.env.RELAYDESK_DB = path.join(dir, 'bench.json');
const { enqueue, claim, complete } = await import('../src/queue.js');

const count = Number(process.argv[2] ?? 300);
const started = performance.now();
for (let i = 0; i < count; i++) enqueue('bench', { i });
for (let i = 0; i < count; i++) complete(claim().id);
const ms = performance.now() - started;

console.log(`${count} jobs in ${ms.toFixed(0)} ms: ${Math.round(count / (ms / 1000))} jobs/s`);
fs.rmSync(dir, { recursive: true, force: true });
