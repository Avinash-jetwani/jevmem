CREATE TABLE stations (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  capacity    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bikes (
  id          text PRIMARY KEY,
  station_id  text REFERENCES stations(id),
  status      text NOT NULL DEFAULT 'docked',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rentals (
  id                text PRIMARY KEY,
  bike_id           text NOT NULL REFERENCES bikes(id),
  user_id           text NOT NULL,
  start_station_id  text NOT NULL REFERENCES stations(id),
  end_station_id    text REFERENCES stations(id),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  status            text NOT NULL DEFAULT 'active'
);

CREATE INDEX rentals_user_idx ON rentals (user_id, started_at DESC);
