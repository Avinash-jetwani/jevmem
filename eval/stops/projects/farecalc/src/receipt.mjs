import { fare } from "./fare.mjs";

export function receipt(trips) {
  const total = trips.reduce((sum, t) => sum + fare(t.zones, t.rider), 0);
  return `Trips: ${trips.length}  Total: EUR ${total}`;
}
