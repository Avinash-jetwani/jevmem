import { evaluateAlerts } from "./alerts/evaluate.js";
import { config } from "./config.js";
import { type Db, type StationRow } from "./db.js";
import { newId } from "./lib/ids.js";
import { log } from "./lib/log.js";
import { notify } from "./notify.js";
import { fetchLatest } from "./upstream/noaa.js";

/** One poll: the newest reading of every station, stored when it is new, and the alerts it fires. */
export async function pollOnce(db: Db): Promise<number> {
  const stations = db.prepare("SELECT id, name, lat, lon FROM stations").all() as StationRow[];
  let stored = 0;
  for (const s of stations) {
    const latest = await fetchLatest(s.id);
    if (!latest) continue;
    const seen = db.prepare("SELECT 1 FROM readings WHERE station_id = ? AND at = ?").get(s.id, latest.at);
    if (seen) continue;
    db.prepare("INSERT INTO readings (id, station_id, height_mm, at) VALUES (?, ?, ?, ?)").run(newId(), s.id, latest.heightMm, latest.at);
    stored++;
    for (const f of evaluateAlerts(db, s.id, latest.heightMm)) await notify(f);
  }
  log.debug({ stored }, "poll done");
  return stored;
}

/** The poller loop, inside the API process (a cron job double-inserted readings when runs overlapped). */
export function startPoller(db: Db): NodeJS.Timeout {
  return setInterval(() => void pollOnce(db), config.pollIntervalMs);
}
