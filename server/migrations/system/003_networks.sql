-- networks: registry of thought networks (docs/02-data-model.md §2.3).
--
-- The id (UUID v4) is immutable and doubles as the networks/<id>/ directory
-- name. display_name and description are freely editable by the owner.

CREATE TABLE IF NOT EXISTS networks (
  id           TEXT PRIMARY KEY,                 -- UUID v4; also networks/<id>/ dir name
  display_name TEXT NOT NULL,                    -- user-editable name
  owner_id     TEXT NOT NULL,                    -- current owner (transferable)
  description  TEXT,
  created_at   TEXT NOT NULL,                    -- ISO-8601 UTC
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT
);
