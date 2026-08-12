-- user_preferences (server-side): per-user-per-network preferences that
-- influence server-side data selection (docs/02-data-model.md §2.5).
--
-- Reserved key: 'show_inactive' (bool, default false). Client-only UI-state
-- (collapsed groups, editor position, etc.) lives on the client, not here.

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT NOT NULL,
  network_id TEXT NOT NULL,
  key        TEXT NOT NULL,                      -- preference name (e.g. 'show_inactive')
  value      TEXT NOT NULL,                      -- JSON-encoded value
  updated_at TEXT NOT NULL,                      -- ISO-8601 UTC
  PRIMARY KEY (user_id, network_id, key),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks (id) ON DELETE CASCADE
);
