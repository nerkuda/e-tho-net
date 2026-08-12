-- users: server accounts (docs/02-data-model.md §2.1).
--
-- Invariant: the row with is_first_user = 1 cannot be deleted and cannot be
-- demoted from is_admin; enforced at the application layer.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                -- UUID v4
  username      TEXT NOT NULL,                   -- unique login (see idx_users_username)
  display_name  TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,      -- 1 = global administrator
  is_first_user INTEGER NOT NULL DEFAULT 0,      -- 1 = created by `etn init` (root admin)
  disabled      INTEGER NOT NULL DEFAULT 0,      -- 1 = account disabled, cannot auth
  created_at    TEXT NOT NULL,                   -- ISO-8601 UTC
  updated_at    TEXT NOT NULL
);

-- Unique login index (docs/02-data-model.md §2.1 lists idx_users_username UNIQUE).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);
