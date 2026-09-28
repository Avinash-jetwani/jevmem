import { Router } from "express";
import { query } from "../db.js";
import { newId } from "../lib/ids.js";

export const parcels = Router();

interface ParcelRow {
  id: string;
  tracking_number: string;
  weight_grams: number;
  status: string;
  created_at: Date;
}

function toJson(row: ParcelRow) {
  return {
    id: row.id,
    trackingNumber: row.tracking_number,
    weightGrams: row.weight_grams,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

parcels.get("/", async (_req, res) => {
  const rows = await query<ParcelRow>("SELECT * FROM parcels ORDER BY created_at DESC");
  res.json({ parcels: rows.map(toJson) });
});

parcels.get("/:id", async (req, res) => {
  const rows = await query<ParcelRow>("SELECT * FROM parcels WHERE id = $1", [req.params.id]);
  res.json(rows[0] ? toJson(rows[0]) : null);
});

parcels.post("/", async (req, res) => {
  const id = newId();
  const { trackingNumber, weightGrams } = req.body;
  await query("INSERT INTO parcels (id, tracking_number, weight_grams, status) VALUES ($1, $2, $3, 'created')", [id, String(trackingNumber).toUpperCase(), weightGrams]);
  res.status(201).json({ id });
});
