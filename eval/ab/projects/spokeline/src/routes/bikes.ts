import type { FastifyInstance } from "fastify";
import { one } from "../db.js";

interface BikeRow {
  id: string;
  station_id: string | null;
  status: string;
  updated_at: Date;
}

const STATUSES = ["docked", "rented", "maintenance"];

export async function bikeRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const row = await one<BikeRow>("SELECT * FROM bikes WHERE id = $1", [req.params.id]);
    if (!row) return reply.code(404).send({ error: { code: "bike_not_found", message: "No bike with that id" } });
    return toJson(row);
  });

  app.patch<{ Params: { id: string }; Body: { status: string } }>("/:id/status", async (req, reply) => {
    const { status } = req.body;
    if (!STATUSES.includes(status)) return reply.code(422).send({ error: { code: "bad_status", message: `status must be one of ${STATUSES.join(", ")}` } });
    const row = await one<BikeRow>("UPDATE bikes SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [req.params.id, status]);
    if (!row) return reply.code(404).send({ error: { code: "bike_not_found", message: "No bike with that id" } });
    return toJson(row);
  });
}

function toJson(row: BikeRow) {
  return { id: row.id, stationId: row.station_id, status: row.status, updatedAt: row.updated_at.toISOString() };
}
