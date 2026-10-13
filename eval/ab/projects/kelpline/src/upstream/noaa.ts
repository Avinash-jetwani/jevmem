import { config } from "../config.js";
import { httpGet } from "../lib/http.js";

interface NoaaAnswer {
  data?: { t: string; v: string }[];
}

export interface LatestReading {
  stationId: string;
  heightMm: number;
  at: string;
}

/** The station's newest water level from NOAA CO-OPS. NOAA answers metres; this is the one place they become millimetres. */
export async function fetchLatest(stationId: string): Promise<LatestReading | null> {
  const url = `${config.noaaBaseUrl}/datagetter?product=water_level&datum=MLLW&units=metric&time_zone=gmt&format=json&date=latest&station=${encodeURIComponent(stationId)}`;
  const answer = await httpGet<NoaaAnswer>(url);
  const last = answer.data?.at(-1);
  if (!last) return null;
  const heightMm = Math.round(Number(last.v) * 1000);
  const at = new Date(last.t.replace(" ", "T") + "Z").toISOString();
  return { stationId, heightMm, at };
}
