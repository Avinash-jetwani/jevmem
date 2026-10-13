ALTER TABLE rooms ADD COLUMN capacity INTEGER NOT NULL DEFAULT 12;
UPDATE rooms SET capacity = 8 WHERE name = 'Loft';
