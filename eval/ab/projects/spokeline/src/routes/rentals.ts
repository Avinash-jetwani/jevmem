import type { FastifyInstance } from "fastify";
import { one, query } from "../db.js";
import { newId } from "../lib/ids.js";
import { log } from "../lib/log.js";

interface RentalRow {
  id: string;
  bike_id: string;
  user_id: string;
  start_station_id: string;
  end_station_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  status: string;
}

export async function rentalRoutes(app: FastifyInstance) {
  app.post<{ Body: { bikeId: string; userId: string } }>("/", async (req, reply) => {
    const { bikeId, userId } = req.body;
    const bike = await one<{ id: string; station_id: string | null; status: string }>("SELECT id, station_id, status FROM bikes WHERE id = $1", [bikeId]);
    if (!bike || bike.status !== "docked" || !bike.station_id) return reply.code(409).send({ error: { code: "bike_unavailable", message: "That bike is not docked" } });
    const id = newId();
    await query("INSERT INTO rentals (id, bike_id, user_id, start_station_id) VALUES ($1, $2, $3, $4)", [id, bikeId, userId, bike.station_id]);
    await query("UPDATE bikes SET station_id = NULL, status = 'rented', updated_at = now() WHERE id = $1", [bikeId]);
    log.info({ rentalId: id, bikeId, userId }, "rental started");
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const row = await one<RentalRow>("SELECT * FROM rentals WHERE id = $1", [req.params.id]);
    if (!row) return reply.code(404).send({ error: { code: "rental_not_found", message: "No rental with that id" } });
    return toJson(row);
  });

  app.post<{ Params: { id: string }; Body: { stationId: string } }>("/:id/end", async (req, reply) => {
    const row = await one<RentalRow>("SELECT * FROM rentals WHERE id = $1", [req.params.id]);
    if (!row) return reply.code(404).send({ error: { code: "rental_not_found", message: "No rental with that id" } });
    if (row.status !== "active") return reply.code(409).send({ error: { code: "rental_not_active", message: "That rental has already ended" } });
    const ended = await one<RentalRow>("UPDATE rentals SET ended_at = now(), end_station_id = $2, status = 'ended' WHERE id = $1 RETURNING *", [row.id, req.body.stationId]);
    await query("UPDATE bikes SET station_id = $2, status = 'docked', updated_at = now() WHERE id = $1", [row.bike_id, req.body.stationId]);
    log.info({ rentalId: row.id, stationId: req.body.stationId }, "rental ended");
    return toJson(ended!);
  });
}

function toJson(row: RentalRow) {
  return {
    id: row.id,
    bikeId: row.bike_id,
    userId: row.user_id,
    startStationId: row.start_station_id,
    endStationId: row.end_station_id,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    status: row.status,
  };
}
