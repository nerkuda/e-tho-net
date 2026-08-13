-- links: directed connections between thoughts (docs/02-data-model.md §3.6).
--
-- Direction: source_id → target_id. Loops (source = target) are forbidden by
-- the application (link-service, task C4). type_id may be NULL (untyped link).
-- The manual display order is per-user and lives in user_focus_order (§3.10.4),
-- not here.
--
-- NOTE on the UNIQUE constraint: SQLite treats NULL as distinct in a UNIQUE
-- index, so the (source_id, target_id, type_id) constraint prevents duplicate
-- typed links but not duplicate untyped (type_id IS NULL) ones. The application
-- enforces the untyped-pair uniqueness explicitly (task C4), matching
-- docs/03-server-api.md §7.1.

CREATE TABLE IF NOT EXISTS links (
  id          TEXT PRIMARY KEY,                   -- UUID v4
  source_id   TEXT NOT NULL,                      -- FK → thoughts.id
  target_id   TEXT NOT NULL,                      -- FK → thoughts.id
  type_id     TEXT,                               -- FK → link_types.id (ON DELETE SET NULL)
  active      INTEGER NOT NULL DEFAULT 1,
  version     INTEGER NOT NULL DEFAULT 1,         -- optimistic concurrency token
  created_at  TEXT NOT NULL,                      -- ISO-8601 UTC
  updated_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,                      -- user_id in _system.db
  updated_by  TEXT NOT NULL,
  UNIQUE (source_id, target_id, type_id),
  FOREIGN KEY (source_id) REFERENCES thoughts (id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES thoughts (id) ON DELETE CASCADE,
  FOREIGN KEY (type_id) REFERENCES link_types (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_links_source ON links (source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_id);
CREATE INDEX IF NOT EXISTS idx_links_type   ON links (type_id);
CREATE INDEX IF NOT EXISTS idx_links_active ON links (active);
