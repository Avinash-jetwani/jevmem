import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleet, startStation } from '../stub/station.js';
import { defaults } from '../src/config.js';
import { pollAll } from '../src/poller.js';

async function withStation(stations, run) {
  const station = await startStation(stations);
  try {
    return await run(station);
  } finally {
    await station.close();
  }
}

const describeFailures = (result) => result.failures.map((f) => `${f.stationId}: ${f.error.message}`);

test('a cycle reads every station', async () => {
  const stations = fleet(12);
  await withStation(stations, async ({ url, stats }) => {
    const result = await pollAll(url, Object.keys(stations));
    assert.deepEqual(describeFailures(result), []);
    assert.deepEqual(result.readings.map((r) => r.stationId), Object.keys(stations));
    assert.equal(stats.served, 12);
  });
});

test('a cycle over twelve stations stays inside the cycle budget', async () => {
  const stations = fleet(12);
  await withStation(stations, async ({ url }) => {
    const result = await pollAll(url, Object.keys(stations));
    assert.equal(result.readings.length, 12);
    assert.ok(
      result.elapsedMs < defaults.cycleBudgetMs,
      `cycle took ${result.elapsedMs} ms, the budget is ${defaults.cycleBudgetMs} ms`,
    );
  });
});

test('a faulty station is reported and the others are still read', async () => {
  const stations = fleet(5);
  stations['st-03'].fault = 500;
  await withStation(stations, async ({ url }) => {
    const result = await pollAll(url, Object.keys(stations));
    assert.deepEqual(describeFailures(result), ['st-03: station st-03 answered 500']);
    assert.equal(result.failures[0].error.status, 500);
    assert.deepEqual(result.readings.map((r) => r.stationId), ['st-01', 'st-02', 'st-04', 'st-05']);
  });
});

test('a dead temperature probe is read as null', async () => {
  const stations = fleet(2);
  stations['st-02'].tempC = NaN;
  await withStation(stations, async ({ url }) => {
    const result = await pollAll(url, Object.keys(stations));
    assert.deepEqual(describeFailures(result), []);
    assert.equal(result.readings[0].tempC, 18.5);
    assert.equal(result.readings[1].tempC, null);
    assert.equal(result.readings[1].humidity, 42);
  });
});

test('an unknown station is a failure with status 404', async () => {
  await withStation(fleet(1), async ({ url }) => {
    const result = await pollAll(url, ['st-01', 'st-77']);
    assert.deepEqual(describeFailures(result), ['st-77: station st-77 answered 404']);
    assert.equal(result.readings.length, 1);
  });
});
