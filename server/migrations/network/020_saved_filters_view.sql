-- saved_filters: per-view named filters (L20, docs/02-data-model.md §3.10.5,
-- 03-server-api.md §18). The new `view` column separates the filters of the
-- «Структуры мыслей» view from the «Хроника» view; the name must be unique per
-- (user, view), so the table is rebuilt (SQLite cannot drop the old
-- UNIQUE (user_id, name) autoindex). The migrator never re-runs this file.

CREATE TABLE saved_filters_new (
  id          TEXT NOT NULL,                          -- UUID
  user_id     TEXT NOT NULL,                          -- owner; only this user sees/edits the filter
  view        TEXT NOT NULL DEFAULT 'structures',     -- 'structures' | 'chronicle'
  name        TEXT NOT NULL,                          -- unique per (user, view), 1..200 chars
  definition  TEXT NOT NULL,                          -- JSON: per-view filter + order
  created_at  TEXT NOT NULL,                          -- ISO-8601 UTC
  updated_at  TEXT NOT NULL,                          -- ISO-8601 UTC
  PRIMARY KEY (id),
  UNIQUE (user_id, view, name)
);

INSERT INTO saved_filters_new (id, user_id, view, name, definition, created_at, updated_at)
  SELECT id, user_id, 'structures', name, definition, created_at, updated_at
  FROM saved_filters;

DROP TABLE saved_filters;
ALTER TABLE saved_filters_new RENAME TO saved_filters;

CREATE INDEX IF NOT EXISTS idx_saved_filters_user ON saved_filters (user_id, view, name);
