-- Pinned thoughts (docs/02-data-model.md §3.10.6, workplan L18).
--
-- The per-user ordered list of «закреплённые мысли». Level L3 (user × network):
-- identical across all clients of the same user, synced via the
-- `pinned-thoughts.updated` event with audience = "user"
-- (docs/04-realtime.md §4.8). Rows always belong to exactly one user.
--
-- `position` is 0-based and dense (the service rewrites the whole list on
-- every change, replace semantics like `user_focus_order`). The application
-- limit (PINNED_THOUGHTS_LIMIT = 20) is enforced by the service, not by CHECK.

CREATE TABLE IF NOT EXISTS user_pinned_thoughts (
  user_id     TEXT NOT NULL,          -- owner; only this user sees/edits the list
  thought_id  TEXT NOT NULL,          -- FK → thoughts.id ON DELETE CASCADE
  position    INTEGER NOT NULL,       -- 0-based order in the list
  pinned_at   TEXT NOT NULL,          -- ISO-8601 UTC
  PRIMARY KEY (user_id, thought_id),
  FOREIGN KEY (thought_id) REFERENCES thoughts (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_pinned_thoughts_pos
  ON user_pinned_thoughts (user_id, position);
