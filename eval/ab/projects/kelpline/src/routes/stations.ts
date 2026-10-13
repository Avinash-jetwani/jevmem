import type { FastifyInstance } from "fastify";
import { toReading, toStation, type Db, type ReadingRow, type StationRow } from "../db.js";
import { ApiError } from "../errors.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function pageOf(query: { limit?: string; offset?: string }) {
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) throw new ApiError("limit_too_large", "limit and offset must be whole numbers");
  if (limit > MAX_LIMIT) throw new ApiError("limit_too_large", `limit is at most ${MAX_LIMIT}`);
  return { limit, offset };
}

export function stationRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/v1/stations", async (req) => {
    const { limit, offset } = pageOf(req.query);
    const rows = db.prepare("SELECT id, name, lat, lon FROM stations ORDER BY name LIMIT ? OFFSET ?").all(limit, offset) as StationRow[];
    return rows.map(toStation);
  });

  app.get<{ Params: { id: string } }>("/v1/stations/:id", async (req) => {
    if (!/^\d{7}$/.test(req.params.id)) throw new ApiError("invalid_station_id");
    const row = db.prepare("SELECT id, name, lat, lon FROM stations WHERE id = ?").get(req.params.id) as StationRow | undefined;
    if (!row) throw new ApiError("station_not_found");
    return toStation(row);
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>("/v1/stations/:id/readings", async (req) => {
    const station = db.prepare("SELECT id FROM stations WHERE id = ?").get(req.params.id);
    if (!station) throw new ApiError("station_not_found");
    const { limit } = pageOf({ limit: req.query.limit });
    const since = req.query.since ?? "1970-01-01T00:00:00.000Z";
    const rows = db.prepare("SELECT id, station_id, height_mm, at FROM readings WHERE station_id = ? AND at > ? ORDER BY at DESC LIMIT ?").all(req.params.id, since, limit) as ReadingRow[];
    return rows.map(toReading);
  });
}
