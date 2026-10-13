import { config } from "./config.js";
import { openDb } from "./db.js";
import { startPoller } from "./poller.js";
import { buildApp } from "./server.js";

const db = openDb();
const app = buildApp(db);
startPoller(db);
await app.listen({ port: config.port, host: "0.0.0.0" });
