import { defaults } from './config.js';

export class StationError extends Error {
  constructor(stationId, status) {
    super(`station ${stationId} answered ${status}`);
    this.name = 'StationError';
    this.stationId = stationId;
    this.status = status;
  }
}

function parseBody(text) {
  return JSON.parse(text.replace(/:\s*NaN\b/g, ':null'));
}

export async function fetchReading(baseUrl, stationId, { timeoutMs = defaults.timeoutMs } = {}) {
  const url = new URL(`/stations/${encodeURIComponent(stationId)}/reading`, baseUrl);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new StationError(stationId, res.status);
  }
  const body = parseBody(await res.text());
  return {
    stationId,
    tempC: body.tempC,
    humidity: body.humidity,
    batteryV: body.batteryV,
    takenAt: body.takenAt,
  };
}
