/** Every setting the service reads, in one place. Nothing else in src/ reads process.env. */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseFile: process.env.DATABASE_FILE ?? "kelpline.db",
  noaaBaseUrl: "https://api.tidesandcurrents.noaa.gov/api/prod",
  pollIntervalMs: 60_000,
  readingsRetentionDays: 90,
  dashboardOrigin: process.env.DASHBOARD_ORIGIN ?? "https://tides.harbour.example",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  logLevel: process.env.LOG_LEVEL ?? "info",
};
