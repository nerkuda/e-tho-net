-- thought_types: user-defined thought types with default styling
-- (docs/02-data-model.md §3.3). The description column carries free-form text
-- used to give AI agents context about the type (see docs/03-server-api.md §8).

CREATE TABLE IF NOT EXISTS thought_types (
  id            TEXT PRIMARY KEY,                 -- UUID v4
  name          TEXT NOT NULL,                    -- unique type name (see idx_thought_types_name)
  icon          TEXT,                             -- default icon for thoughts of this type
  fg_color      TEXT,                             -- default text colour
  bg_color      TEXT,                             -- default cloud background colour
  font_bold     INTEGER,                          -- nullable: NULL = inherit application default
  font_italic   INTEGER,
  font_underline INTEGER,
  font_strike   INTEGER,
  description   TEXT,                             -- free-form comment for AI/users
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,                    -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL                     -- user_id in _system.db
);

-- Unique type name; also serves as the lookup index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_thought_types_name ON thought_types (name);
