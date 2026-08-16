-- Named saved filters of the «Структуры мыслей» view (L15, docs/02-data-model.md
-- §3.10.5, 03-server-api.md §18). Level L3 (user × network): identical on all
-- clients of the same user, synced via `saved-filter.*` events with
-- audience = "user" (docs/04-realtime.md §4.8). Publication to other users is
-- out of the MVP scope — rows always belong to exactly one user.

CREATE TABLE IF NOT EXISTS saved_filters (
  id          TEXT NOT NULL,                          -- UUID
  user_id     TEXT NOT NULL,                          -- owner; only this user sees/edits the filter
  name        TEXT NOT NULL,                          -- unique per user, 1..200 chars
  definition  TEXT NOT NULL,                          -- JSON: filter + sort/order (03-server-api.md §6.10/§18)
  created_at  TEXT NOT NULL,                          -- ISO-8601 UTC
  updated_at  TEXT NOT NULL,                          -- ISO-8601 UTC
  PRIMARY KEY (id),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_filters_user
  ON saved_filters (user_id, name);
