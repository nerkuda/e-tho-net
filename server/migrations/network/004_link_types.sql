-- link_types: user-defined link types with visual style and directional names
-- (docs/02-data-model.md §3.7). The (name_forward, name_reverse) pair is unique;
-- description is free-form text used to give AI agents context about the type.

CREATE TABLE IF NOT EXISTS link_types (
  id            TEXT PRIMARY KEY,                 -- UUID v4
  name_forward  TEXT NOT NULL,                    -- label read source → target
  name_reverse  TEXT NOT NULL,                    -- label read target → source
  color         TEXT,                             -- line colour
  style         TEXT NOT NULL DEFAULT 'solid',    -- 'solid' | 'dashed' | 'dotted'
  width         INTEGER NOT NULL DEFAULT 1,       -- line width in pixels
  description   TEXT,                             -- free-form comment for AI/users
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,                    -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL                     -- user_id in _system.db
);

-- A type is identified by its forward/reverse name pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_types_names ON link_types (name_forward, name_reverse);
