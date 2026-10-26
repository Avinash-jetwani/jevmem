import type { FastifyInstance } from "fastify";
import { one, query } from "../db.js";

interface StationRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  capacity: number;
  docked: string;
}

const STATION_SQL = `SELECT s.id, s.name, s.lat, s.lng, s.capacity, count(b.id) FILTER (WHERE b.status = 'docked') AS docked
  FROM stations s LEFT JOIN bikes b ON b.station_id = s.id`;

export async function stationRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const rows = await query<StationRow>(`${STATION_SQL} GROUP BY s.id ORDER BY s.name`);
    return rows.map(toJson);
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const row = await one<StationRow>(`${STATION_SQL} WHERE s.id = $1 GROUP BY s.id`, [req.params.id]);
    if (!row) return reply.code(404).send({ error: { code: "station_not_found", message: "No station with that id" } });
    return toJson(row);
  });
}

function toJson(row: StationRow) {
  return { id: row.id, name: row.name, lat: row.lat, lng: row.lng, capacity: row.capacity, dockedBikes: Number(row.docked) };
}
