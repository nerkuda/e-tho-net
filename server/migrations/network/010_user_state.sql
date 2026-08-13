-- Per-user state inside a network (docs/02-data-model.md §3.10). These four
-- tables are level L3 (user × network): identical across all clients of the same
-- user, synced via real-time events with audience = "user"
-- (docs/11-settings-and-state.md §2, §4).
--
--   * user_preferences   — key/value JSON affecting server-side selection
--                          (e.g. show_inactive);
--   * thought_views      — last_viewed_at per (user, thought), drives the
--                          "viewed" focus-zone sort;
--   * user_focus_preferences — chosen sort strategy per (user, focus, dir);
--   * user_focus_order      — manual positions per (user, focus, dir, thought).

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,                      -- e.g. 'show_inactive'
  value       TEXT NOT NULL,                      -- JSON-encoded value
  updated_at  TEXT NOT NULL,                      -- ISO-8601 UTC
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS thought_views (
  user_id        TEXT NOT NULL,
  thought_id     TEXT NOT NULL,
  last_viewed_at TEXT NOT NULL,                   -- ISO-8601 UTC
  PRIMARY KEY (user_id, thought_id),
  FOREIGN KEY (thought_id) REFERENCES thoughts (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_focus_preferences (
  user_id           TEXT NOT NULL,
  focus_thought_id  TEXT NOT NULL,
  dir               TEXT NOT NULL,                -- 'children' | 'parents' | 'siblings'
  sort              TEXT NOT NULL,                -- 'manual' | 'alpha' | 'created' | 'viewed'
  sort_order        TEXT NOT NULL,                -- 'asc' | 'desc'
  updated_at        TEXT NOT NULL,                -- ISO-8601 UTC
  PRIMARY KEY (user_id, focus_thought_id, dir),
  FOREIGN KEY (focus_thought_id) REFERENCES thoughts (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_focus_order (
  user_id           TEXT NOT NULL,
  focus_thought_id  TEXT NOT NULL,
  dir               TEXT NOT NULL,                -- 'children' | 'parents' (never 'siblings')
  thought_id        TEXT NOT NULL,                -- the child or parent of the focus
  position          INTEGER NOT NULL,
  updated_at        TEXT NOT NULL,                -- ISO-8601 UTC
  PRIMARY KEY (user_id, focus_thought_id, dir, thought_id),
  FOREIGN KEY (focus_thought_id) REFERENCES thoughts (id) ON DELETE CASCADE,
  FOREIGN KEY (thought_id) REFERENCES thoughts (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_focus_order_pos
  ON user_focus_order (user_id, focus_thought_id, dir, position);
