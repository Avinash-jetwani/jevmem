import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleet, startStation } from '../stub/station.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('the cli polls, prints a summary and writes the alerts file', async () => {
  const stations = fleet(3);
  stations['st-02'].tempC = 51.5;
  const station = await startStation(stations);
  const dir = await mkdtemp(join(tmpdir(), 'gridwatch-'));
  const out = join(dir, 'alerts.jsonl');
  try {
    const result = await run(['--url', station.url, '--stations', 'st-01,st-02,st-03', '--out', out]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^st-02: overheat$/m);
    assert.match(result.stdout, /^read 3, failed 0, alerts 1, \d+ ms$/m);
    const lines = (await readFile(out, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].stationId, 'st-02');
    assert.equal(lines[0].text, 'temperature 51.5 °C');
  } finally {
    await station.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the cli exits 1 and names the station when a station fails', async () => {
  const stations = fleet(2);
  stations['st-01'].fault = 503;
  const station = await startStation(stations);
  const dir = await mkdtemp(join(tmpdir(), 'gridwatch-'));
  try {
    const result = await run(['--url', station.url, '--stations', 'st-01,st-02', '--out', join(dir, 'alerts.jsonl')]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^st-01: station st-01 answered 503$/m);
    assert.match(result.stdout, /^read 1, failed 1, alerts 0, \d+ ms$/m);
  } finally {
    await station.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the cli exits 2 with the usage line when --url is missing', async () => {
  const result = await run(['--stations', 'st-01']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: gridwatch --url/);
});
