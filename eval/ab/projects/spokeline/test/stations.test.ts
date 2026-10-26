import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ query: vi.fn(), one: vi.fn() }));

import { buildApp } from "../src/app.js";
import * as db from "../src/db.js";

describe("GET /v1/stations", () => {
  afterEach(() => vi.resetAllMocks());

  it("lists stations with their docked bike counts", async () => {
    vi.mocked(db.query).mockResolvedValueOnce([{ id: "01J", name: "Harbour", lat: 53.55, lng: 9.99, capacity: 20, docked: "7" }]);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/stations" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: "01J", name: "Harbour", lat: 53.55, lng: 9.99, capacity: 20, dockedBikes: 7 }]);
  });

  it("answers 404 for an unknown station", async () => {
    vi.mocked(db.one).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/stations/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("station_not_found");
  });
});
