# parcelpost

Parcel tracking API for small online shops: shops create parcels, look them up by id or tracking number, and see the carrier's status.

- `npm run build` compiles `src/` to `dist/`.
- `npm start` runs the API on port 3000 (`PORT` to change it).
- `npm run gen` regenerates the carrier API client.

Needs `DATABASE_URL` (Postgres) and `REDIS_URL`.
