CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Launch environment is snapshotted onto the session so a restart re-applies
-- exactly what the pane was created with (D9). Existing rows get an empty map,
-- which is byte-for-byte the previous behavior.
ALTER TABLE sessions ADD COLUMN env TEXT NOT NULL DEFAULT '{}';
