import pino from "pino";
import { config } from "../config.js";

/** The one logger. Structured fields first, the message second: `log.warn({ stationId, err }, "noaa fetch failed")`. */
export const log = pino({ level: config.logLevel });
