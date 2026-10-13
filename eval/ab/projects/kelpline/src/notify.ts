import type { Fired } from "./alerts/evaluate.js";
import { log } from "./lib/log.js";

/** Send the alert email through Postmark. The stand-in here logs it; the real sender lives in the deploy's secrets. */
export async function notify(f: Fired): Promise<void> {
  log.info({ alertId: f.alertId, stationId: f.stationId, heightMm: f.heightMm }, "alert fired");
}
