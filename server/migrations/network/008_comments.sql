-- comments: permanent or chronological markdown comments on a thought/link
-- (docs/02-data-model.md §3.8). Polymorphic owner (no SQL FK). body_html is the
-- pre-rendered HTML cached by the server (comment-service, task C7).
--
-- Invariant: at most one permanent comment per (owner_type, owner_id). Enforced
-- by the partial unique index idx_comments_permanent_one. Chronological
-- comments are unrestricted.

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,                   -- UUID v4
  owner_type  TEXT NOT NULL,                      -- 'thought' | 'link'
  owner_id    TEXT NOT NULL,                      -- FK (no SQL constraint) → thoughts/links
  kind        TEXT NOT NULL,                      -- 'permanent' | 'chronological'
  title       TEXT,                               -- title for chronological; NULL for permanent
  body_md     TEXT NOT NULL,                      -- markdown source
  body_html   TEXT NOT NULL,                      -- cached rendered HTML
  valid_from  TEXT NOT NULL,                      -- for permanent: equals created_at
  valid_to    TEXT,                               -- NULL = open-ended; always NULL for permanent
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,                      -- ISO-8601 UTC
  updated_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,                      -- user_id in _system.db
  updated_by  TEXT NOT NULL
);

-- List comments of an owner; chronological listing ordered by valid_from.
CREATE INDEX IF NOT EXISTS idx_comments_owner  ON comments (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_comments_chrono ON comments (owner_type, owner_id, valid_from);

-- At most one permanent comment per owner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_permanent_one
  ON comments (owner_type, owner_id) WHERE kind = 'permanent';
