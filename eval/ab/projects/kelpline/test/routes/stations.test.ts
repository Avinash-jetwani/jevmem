import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers.js";

describe("GET /v1/stations", () => {
  it("lists the seeded stations", async () => {
    const { app } = makeTestApp();
    const r = await app.inject({ method: "GET", url: "/v1/stations" });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((s: any) => s.id)).toEqual(["8443970", "8447930"]);
  });

  it("refuses a limit above 500", async () => {
    const { app } = makeTestApp();
    const r = await app.inject({ method: "GET", url: "/v1/stations?limit=501" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("limit_too_large");
  });

  it("answers 404 for an unknown station", async () => {
    const { app } = makeTestApp();
    const r = await app.inject({ method: "GET", url: "/v1/stations/1234567" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("station_not_found");
  });

  it("lists readings newest first in millimetres", async () => {
    const { app, db } = makeTestApp();
    db.prepare("INSERT INTO readings (id, station_id, height_mm, at) VALUES (?, ?, ?, ?)").run("r1", "8443970", 1234, "2026-03-01T10:00:00.000Z");
    db.prepare("INSERT INTO readings (id, station_id, height_mm, at) VALUES (?, ?, ?, ?)").run("r2", "8443970", 1300, "2026-03-01T10:06:00.000Z");
    const r = await app.inject({ method: "GET", url: "/v1/stations/8443970/readings" });
    expect(r.json().map((x: any) => x.heightMm)).toEqual([1300, 1234]);
  });
});
