import { type AlertRow, type Db } from "../db.js";

export interface Fired {
  alertId: string;
  stationId: string;
  thresholdMm: number;
  heightMm: number;
  email: string;
}

/**
 * An alert fires once when a reading crosses its threshold (armed → fired) and arms again only once the height has
 * fallen below the threshold. Returns the alerts that fired on this reading.
 */
export function evaluateAlerts(db: Db, stationId: string, heightMm: number): Fired[] {
  const alerts = db.prepare("SELECT * FROM alerts WHERE station_id = ?").all(stationId) as AlertRow[];
  const fired: Fired[] = [];
  for (const a of alerts) {
    if (a.armed === 1 && heightMm >= a.threshold_mm) {
      db.prepare("UPDATE alerts SET armed = 0 WHERE id = ?").run(a.id);
      fired.push({ alertId: a.id, stationId, thresholdMm: a.threshold_mm, heightMm, email: a.email });
    } else if (a.armed === 0 && heightMm < a.threshold_mm) {
      db.prepare("UPDATE alerts SET armed = 1 WHERE id = ?").run(a.id);
    }
  }
  return fired;
}
