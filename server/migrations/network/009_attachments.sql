-- attachments: URLs or local file references attached to a thought/link
-- (docs/02-data-model.md §3.9). Polymorphic owner (no SQL FK). On MVP
-- kind = 'file' stores a path in the user's OS; the binary is not uploaded to
-- the server (the networks/<id>/attachments/ directory is reserved for future
-- server-side storage).

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,                   -- UUID v4
  owner_type  TEXT NOT NULL,                      -- 'thought' | 'link'
  owner_id    TEXT NOT NULL,                      -- FK (no SQL constraint) → thoughts/links
  kind        TEXT NOT NULL,                      -- 'url' | 'file'
  url         TEXT,                               -- populated when kind = 'url'
  file_path   TEXT,                               -- populated when kind = 'file' (OS path, not uploaded)
  file_size   INTEGER,                            -- optional size hint
  mime_type   TEXT,                               -- optional MIME hint
  title       TEXT,                               -- for URLs: page title (client-provided on MVP)
  description TEXT,                               -- free-form comment
  position    INTEGER NOT NULL DEFAULT 0,         -- display order
  created_at  TEXT NOT NULL,                      -- ISO-8601 UTC
  created_by  TEXT NOT NULL                       -- user_id in _system.db
);

CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments (owner_type, owner_id);
