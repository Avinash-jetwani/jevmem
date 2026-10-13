import type { FastifyInstance } from "fastify";
import { toAlert, type AlertRow, type Db } from "../db.js";
import { ApiError } from "../errors.js";
import { newId } from "../lib/ids.js";

interface NewAlert {
  stationId: string;
  thresholdMm: number;
  email: string;
}

export function alertRoutes(app: FastifyInstance, db: Db) {
  app.post<{ Body: NewAlert }>("/v1/alerts", async (req, reply) => {
    const { stationId, thresholdMm, email } = req.body ?? ({} as NewAlert);
    if (!db.prepare("SELECT id FROM stations WHERE id = ?").get(stationId)) throw new ApiError("station_not_found");
    if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError("invalid_email");
    const row: AlertRow = { id: newId(), station_id: stationId, threshold_mm: Math.round(thresholdMm), email, armed: 1, created_at: new Date().toISOString() };
    db.prepare("INSERT INTO alerts (id, station_id, threshold_mm, email, armed, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.station_id, row.threshold_mm, row.email, row.armed, row.created_at);
    reply.code(201);
    return toAlert(row);
  });

  app.get<{ Params: { id: string } }>("/v1/alerts/:id", async (req) => {
    const row = db.prepare("SELECT * FROM alerts WHERE id = ?").get(req.params.id) as AlertRow | undefined;
    if (!row) throw new ApiError("alert_not_found");
    return toAlert(row);
  });

  app.delete<{ Params: { id: string } }>("/v1/alerts/:id", async (req, reply) => {
    const r = db.prepare("DELETE FROM alerts WHERE id = ?").run(req.params.id);
    if (r.changes === 0) throw new ApiError("alert_not_found");
    reply.code(204);
    return null;
  });
}
