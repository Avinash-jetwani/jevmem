import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, formatDuration, summarize, writeAlerts } from '../src/alerts.js';

const NOW = Date.UTC(2026, 2, 14, 9, 30);
const MINUTE = 60_000;

const reading = (stationId, values = {}) => ({
  stationId,
  tempC: 21.4,
  humidity: 48,
  batteryV: 3.9,
  takenAt: NOW - MINUTE,
  ...values,
});

test('formatDuration prints the two largest units', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(5 * MINUTE + 7_000), '5m 07s');
  assert.equal(formatDuration(125 * MINUTE), '2h 05m');
  assert.equal(formatDuration(23 * 60 * MINUTE + 59 * MINUTE), '23h 59m');
});

test('a healthy reading raises nothing', () => {
  assert.deepEqual(evaluate([reading('st-01')], NOW), []);
});

test('each rule raises its own alert', () => {
  const alerts = evaluate(
    [
      reading('st-01', { tempC: 47.25 }),
      reading('st-02', { tempC: null }),
      reading('st-03', { batteryV: 3.1 }),
      reading('st-04', { takenAt: NOW - 125 * MINUTE }),
    ],
    NOW,
  );
  assert.deepEqual(alerts, [
    { at: NOW, stationId: 'st-01', rule: 'overheat', severity: 'crit', text: 'temperature 47.3 °C' },
    { at: NOW, stationId: 'st-02', rule: 'probe-dead', severity: 'warn', text: 'temperature probe gives no value' },
    { at: NOW, stationId: 'st-03', rule: 'low-battery', severity: 'warn', text: 'battery at 3.10 V' },
    { at: NOW, stationId: 'st-04', rule: 'stale', severity: 'warn', text: 'no reading for 2h 05m' },
  ]);
});

test('summarize lists the rules that tripped per station', () => {
  const alerts = evaluate(
    [reading('st-01', { tempC: 50, batteryV: 3.0 }), reading('st-02'), reading('st-03', { tempC: null })],
    NOW,
  );
  assert.deepEqual(summarize(alerts), ['st-01: overheat, low-battery', 'st-03: probe-dead']);
});

test('writeAlerts appends one JSON line per alert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gridwatch-'));
  const file = join(dir, 'alerts.jsonl');
  try {
    await writeAlerts(file, evaluate([reading('st-01', { tempC: 46 })], NOW));
    await writeAlerts(file, []);
    await writeAlerts(file, evaluate([reading('st-02', { batteryV: 2.9 })], NOW + MINUTE));
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((a) => `${a.stationId} ${a.rule}`), ['st-01 overheat', 'st-02 low-battery']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
