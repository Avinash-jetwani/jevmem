import Fastify from "fastify";
import { config } from "./config.js";
import { type Db } from "./db.js";
import { ApiError } from "./errors.js";
import { log } from "./lib/log.js";
import { alertRoutes } from "./routes/alerts.js";
import { stationRoutes } from "./routes/stations.js";

/** The app, without listening: tests call it with app.inject. */
export function buildApp(db: Db) {
  const app = Fastify({ loggerInstance: log });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("access-control-allow-origin", config.dashboardOrigin);
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "something went wrong" } });
  });
  stationRoutes(app, db);
  alertRoutes(app, db);
  return app;
}
