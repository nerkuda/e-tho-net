-- user_settings (L3s): per-user-per-server settings that live outside any
-- network and are shared by all networks and devices of the user on this
-- server (docs/11-settings-and-state.md §2.1 L3s, ADR
-- «Сочетания клавиш — серверная настройка уровня «пользователь × сервер»»).
--
-- First key: 'comment_hotkeys' — JSON map «command → combination» of the
-- user's comment hotkeys. Accessed via /api/v1/users/me/settings.
--
-- Deliberately has NO network_id: mixing server-level user settings with the
-- network-scoped user_preferences (L3, migration 005) is forbidden by the ADR.

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT NOT NULL,                       -- FK → users.id
  key        TEXT NOT NULL,                       -- setting name (e.g. 'comment_hotkeys')
  value      TEXT NOT NULL,                       -- JSON-encoded value
  updated_at TEXT NOT NULL,                       -- ISO-8601 UTC
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
