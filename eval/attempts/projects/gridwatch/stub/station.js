import http from 'node:http';

const MAX_CONCURRENT = 4;
const FIRST_BYTE_MS = 150;
const LOCKOUT_MS = 1500;

// Same field order and number formatting as the gateway firmware.
function payload(stationId, s) {
  return `{"stationId":"${stationId}","tempC":${s.tempC},"humidity":${s.humidity},"batteryV":${s.batteryV},"takenAt":${s.takenAt}}`;
}

function send(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

// `count` healthy stations, st-01 and up.
export function fleet(count, takenAt = Date.now()) {
  const stations = {};
  for (let n = 1; n <= count; n++) {
    const id = `st-${String(n).padStart(2, '0')}`;
    stations[id] = { tempC: 18 + n / 2, humidity: 40 + n, batteryV: 3.9, takenAt };
  }
  return stations;
}

// Starts a site gateway on a free localhost port. `stations` maps a station id
// to its current values; `fault: <status>` makes that station answer with it.
export async function startStation(stations) {
  let inFlight = 0;
  let lockedUntil = 0;
  const stats = { served: 0, refused: 0, peak: 0 };

  const server = http.createServer((req, res) => {
    const match = /^\/stations\/([^/]+)\/reading$/.exec(req.url);
    if (req.method !== 'GET' || !match) return send(res, 404, '{"error":"no such resource"}');

    const now = Date.now();
    if (inFlight >= MAX_CONCURRENT) lockedUntil = now + LOCKOUT_MS;
    if (now < lockedUntil) {
      stats.refused++;
      const retryAfter = String(Math.ceil(LOCKOUT_MS / 1000));
      return send(res, 429, '{"error":"busy"}', { 'retry-after': retryAfter });
    }

    inFlight++;
    stats.peak = Math.max(stats.peak, inFlight);
    setTimeout(() => {
      inFlight--;
      const id = decodeURIComponent(match[1]);
      const station = stations[id];
      if (!station) return send(res, 404, '{"error":"unknown station"}');
      if (station.fault) return send(res, station.fault, '{"error":"sensor bus fault"}');
      stats.served++;
      send(res, 200, payload(id, station));
    }, FIRST_BYTE_MS);
  });

  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    stats,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
