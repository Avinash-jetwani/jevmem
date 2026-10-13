import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers.js";

describe("/v1/alerts", () => {
  it("creates, reads and deletes an alert", async () => {
    const { app } = makeTestApp();
    const created = await app.inject({ method: "POST", url: "/v1/alerts", payload: { stationId: "8443970", thresholdMm: 2500, email: "ops@harbour.example" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(id).toMatch(/^[a-z2-9]{20}$/);
    const read = await app.inject({ method: "GET", url: `/v1/alerts/${id}` });
    expect(read.json().thresholdMm).toBe(2500);
    const gone = await app.inject({ method: "DELETE", url: `/v1/alerts/${id}` });
    expect(gone.statusCode).toBe(204);
  });

  it("refuses an unknown station and a bad email", async () => {
    const { app } = makeTestApp();
    const a = await app.inject({ method: "POST", url: "/v1/alerts", payload: { stationId: "0000000", thresholdMm: 1, email: "ops@harbour.example" } });
    expect(a.json().error.code).toBe("station_not_found");
    const b = await app.inject({ method: "POST", url: "/v1/alerts", payload: { stationId: "8443970", thresholdMm: 1, email: "nope" } });
    expect(b.json().error.code).toBe("invalid_email");
  });
});
