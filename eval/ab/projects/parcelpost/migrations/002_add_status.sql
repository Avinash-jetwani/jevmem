ALTER TABLE parcels ADD COLUMN status text NOT NULL DEFAULT 'created';
ALTER TABLE parcels ADD COLUMN status_at timestamptz;
