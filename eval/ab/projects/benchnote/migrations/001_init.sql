CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  address     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE work_orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  device          TEXT NOT NULL,
  problem         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'received',
  labour_minutes  INTEGER NOT NULL DEFAULT 0,
  labour_rate     REAL NOT NULL DEFAULT 60.0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE parts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES work_orders(id),
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  unit_price  REAL NOT NULL
);

CREATE INDEX work_orders_status_idx ON work_orders (status, created_at);
