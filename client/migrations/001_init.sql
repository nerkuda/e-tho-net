-- ETN client local.db — начальная схема.
-- Источник: docs/07-client-electron.md §3 (server_profiles, ui_state, drafts,
-- focus_history, client_meta). Локальная БД хранит ТОЛЬКО персональное
-- состояние и кэш; авторитетные данные сети живут на сервере (online-only).

-- Включаем внешний ключ-контроль на каждом подключении.
PRAGMA foreign_keys = ON;

-- История применённых миграций (по аналогии с серверным мигратором, B2).
CREATE TABLE IF NOT EXISTS _migrations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- server_profiles: подключения к серверам ETN (07-client-electron.md §3.1).
-- api_key_encrypted — зашифрованный через safeStorage BLOB (задача G2).
CREATE TABLE IF NOT EXISTS server_profiles (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  base_url           TEXT NOT NULL,
  api_key_encrypted  BLOB,
  user_id            TEXT,
  is_active          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ui_state: персональный UI-state по сети, уровень L4
-- (07-client-electron.md §3.2; 11-settings-and-state.md §2.1).
CREATE TABLE IF NOT EXISTS ui_state (
  profile_id  TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (profile_id, network_id, key)
);

-- drafts: черновики правок, защита от потери при разрыве связи
-- (07-client-electron.md §3.3, §5.2).
CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL,
  network_id   TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT,
  base_version INTEGER,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  status       TEXT NOT NULL DEFAULT 'pending'
);

-- focus_history: история мыслей, побывавших в фокусе, уровень L4
-- (07-client-electron.md §3.5; 11-settings-and-state.md §2.3).
CREATE TABLE IF NOT EXISTS focus_history (
  profile_id  TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  thought_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  visited_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, network_id, thought_id)
);

CREATE INDEX IF NOT EXISTS idx_focus_history_seq
  ON focus_history (profile_id, network_id, seq DESC);

-- client_meta: состояние установки, уровень L5 (07-client-electron.md §3.4).
-- Сюда записываются client_id (G4), last_seq, theme, zoom, active_profile_id.
CREATE TABLE IF NOT EXISTS client_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
