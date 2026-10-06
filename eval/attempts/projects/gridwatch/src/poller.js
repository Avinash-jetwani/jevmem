import { defaults } from './config.js';
import { fetchReading } from './client.js';
import { mapLimit } from './pool.js';

// One cycle: every station is asked once. A station that fails is listed in
// `failures`; it does not stop the cycle.
export async function pollAll(baseUrl, stationIds, options = {}) {
  const { concurrency = defaults.concurrency, timeoutMs = defaults.timeoutMs } = options;
  const started = performance.now();

  const settled = await mapLimit(stationIds, concurrency, async (stationId) => {
    try {
      return { reading: await fetchReading(baseUrl, stationId, { timeoutMs }) };
    } catch (error) {
      return { failure: { stationId, error } };
    }
  });

  return {
    readings: settled.filter((s) => s.reading).map((s) => s.reading),
    failures: settled.filter((s) => s.failure).map((s) => s.failure),
    elapsedMs: Math.round(performance.now() - started),
  };
}
