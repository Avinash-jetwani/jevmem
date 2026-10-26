# spokeline

The API behind a city bike-share: stations, bikes and rentals. Fastify 5 on Node 22, TypeScript, Postgres through `pg`.

## Layout

- `src/server.ts` starts the server; `src/app.ts` builds the Fastify instance and registers the routes.
- `src/routes/` has one file per resource: `stations.ts`, `bikes.ts`, `rentals.ts`.
- `src/db.ts` holds the connection pool, `query()` and `one()`.
- `src/lib/` has logging (`log.ts`, pino), ids (`ids.ts`) and outbound HTTP (`http.ts`).
- `migrations/` has numbered SQL files, applied in order by `npm run migrate`.
- `test/` is Vitest, against the app with `app.inject()` and a mocked `db`.

## Commands

```
npm run dev       # tsx watch
npm run build     # tsc
npm test          # vitest run
npm run migrate   # applies migrations/*.sql in order against DATABASE_URL
```
