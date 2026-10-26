import Fastify from "fastify";
import { log } from "./lib/log.js";
import { bikeRoutes } from "./routes/bikes.js";
import { rentalRoutes } from "./routes/rentals.js";
import { stationRoutes } from "./routes/stations.js";

export function buildApp() {
  const app = Fastify({ loggerInstance: log });
  app.get("/healthz", async () => ({ ok: true }));
  app.register(stationRoutes, { prefix: "/v1/stations" });
  app.register(bikeRoutes, { prefix: "/v1/bikes" });
  app.register(rentalRoutes, { prefix: "/v1/rentals" });
  return app;
}
