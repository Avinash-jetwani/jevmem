CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,          -- NOAA's station number, as a string
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  height_mm INTEGER NOT NULL,   -- integer millimetres
  at TEXT NOT NULL              -- ISO 8601, UTC
);

CREATE INDEX IF NOT EXISTS readings_station_at ON readings (station_id, at);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id),
  threshold_mm INTEGER NOT NULL,
  email TEXT NOT NULL,
  armed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO stations (id, name, lat, lon) VALUES
  ('8443970', 'Boston', 42.3539, -71.0503),
  ('8447930', 'Woods Hole', 41.5236, -70.6711);
