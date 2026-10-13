# kelpline

Tide-height alerts for a harbour: polls NOAA's CO-OPS readings for a few stations, keeps them, and emails when a station's water height crosses a threshold.

- Fastify 5 in TypeScript. `src/server.ts` builds the app; each resource has a route file in `src/routes/`.
- SQLite through `better-sqlite3` with hand-written SQL in `src/db.ts`; schema changes are numbered files in `migrations/`.
- Every route is also declared in `api/openapi.yaml`; `test/contract.test.ts` compares the two.
- Settings are read from the environment in `src/config.ts` only.

```
npm install
npm run dev        # the API on http://localhost:3000, the poller inside it
npm test           # vitest: the route tests call the app with app.inject
```
