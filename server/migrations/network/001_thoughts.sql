-- thoughts: core thought entity (docs/02-data-model.md §3.1).
--
-- Booleans are INTEGER 0/1. id/title/title_norm/version are NOT NULL; colours,
-- icon and type are nullable. created_by/updated_by reference a user in
-- _system.db — there is no cross-database FK, so they are plain TEXT columns
-- validated at the application layer.
--
-- Invariants (enforced by the application):
--   * exactly one row with is_root = 1 per network (the HOME thought);
--   * that row also has is_protected = 1 and cannot be deleted;
--   * is_protected = 1 thoughts cannot be deactivated.
--
-- Note: the type_id FK forward-references thought_types, which is created by
-- 003_thought_types.sql. SQLite allows forward references in FK clauses; the
-- constraint is only enforced once the referenced table exists.

CREATE TABLE IF NOT EXISTS thoughts (
  id            TEXT PRIMARY KEY,                 -- UUID v4
  title         TEXT NOT NULL,                    -- display title (<= THOUGHT_TITLE_MAX)
  title_norm    TEXT NOT NULL,                    -- lowercase trim NFC, for search/dedup
  type_id       TEXT,                             -- FK → thought_types.id (ON DELETE SET NULL)
  icon          TEXT,                             -- emoji glyph or image path/URL
  icon_kind     TEXT NOT NULL DEFAULT 'emoji',    -- 'emoji' | 'image'
  active        INTEGER NOT NULL DEFAULT 1,       -- 0 = inactive (dimmed on canvas)
  is_protected  INTEGER NOT NULL DEFAULT 0,       -- 1 = system thought (HOME); not deletable
  is_root       INTEGER NOT NULL DEFAULT 0,       -- 1 = network root (HOME)
  fg_color      TEXT,                             -- text colour
  bg_color      TEXT,                             -- cloud background colour
  font_bold     INTEGER NOT NULL DEFAULT 0,
  font_italic   INTEGER NOT NULL DEFAULT 0,
  font_underline INTEGER NOT NULL DEFAULT 0,
  font_strike   INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,       -- optimistic concurrency token
  created_at    TEXT NOT NULL,                    -- ISO-8601 UTC
  created_by    TEXT NOT NULL,                    -- user_id in _system.db
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  FOREIGN KEY (type_id) REFERENCES thought_types (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_thoughts_title_norm ON thoughts (title_norm);
CREATE INDEX IF NOT EXISTS idx_thoughts_type       ON thoughts (type_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_active     ON thoughts (active);
CREATE INDEX IF NOT EXISTS idx_thoughts_updated_at ON thoughts (updated_at);
