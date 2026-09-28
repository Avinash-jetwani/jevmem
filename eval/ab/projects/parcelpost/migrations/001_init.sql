CREATE TABLE parcels (
  id              text PRIMARY KEY,
  tracking_number text NOT NULL UNIQUE,
  weight_grams    integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
