-- 005: tabs — открытые табы в одном окне Electron (фаза Q, workplan/phase-q.md).
-- Добавляет таблицу tabs и колонку tab_id в таблицы историй (focus/structures/
-- chronicle). Колонка NULL для legacy-данных; новые записи пишутся с
-- tab_id = id открытого таба. PK истории расширяется tab_id-ом.

-- 1. tabs — открытые табы клиента.
CREATE TABLE IF NOT EXISTS tabs (
  profile_id        TEXT NOT NULL,
  tab_id            TEXT NOT NULL,
  slot_idx          INTEGER NOT NULL,
  network_id        TEXT NOT NULL,
  focus_id          TEXT,
  view_mode         TEXT,
  structures_state  TEXT,
  chronicle_state   TEXT,
  last_active_at    TEXT NOT NULL,
  PRIMARY KEY (profile_id, tab_id)
);
CREATE INDEX IF NOT EXISTS idx_tabs_order ON tabs (profile_id, slot_idx);

-- 2. focus_history: +tab_id, PK → (profile_id, network_id, tab_id, thought_id).
PRAGMA foreign_keys = OFF;
ALTER TABLE focus_history ADD COLUMN tab_id TEXT;
DROP INDEX IF EXISTS idx_focus_history_seq;
CREATE TABLE focus_history__new (
  profile_id  TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  tab_id      TEXT,                  -- NULL для legacy-данных (см. §3.5 07-client-electron.md)
  thought_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  visited_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, network_id, tab_id, thought_id)
);
INSERT INTO focus_history__new (profile_id, network_id, tab_id, thought_id, seq, visited_at)
  SELECT profile_id, network_id, NULL, thought_id, seq, visited_at FROM focus_history;
DROP TABLE focus_history;
ALTER TABLE focus_history__new RENAME TO focus_history;
CREATE INDEX idx_focus_history_seq ON focus_history (profile_id, network_id, tab_id, seq DESC);
PRAGMA foreign_keys = ON;

-- 3. structures_history: тот же приём.
PRAGMA foreign_keys = OFF;
ALTER TABLE structures_history ADD COLUMN tab_id TEXT;
DROP INDEX IF EXISTS idx_structures_history_seq;
CREATE TABLE structures_history__new (
  profile_id  TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  tab_id      TEXT,
  thought_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  visited_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, network_id, tab_id, thought_id)
);
INSERT INTO structures_history__new (profile_id, network_id, tab_id, thought_id, seq, visited_at)
  SELECT profile_id, network_id, NULL, thought_id, seq, visited_at FROM structures_history;
DROP TABLE structures_history;
ALTER TABLE structures_history__new RENAME TO structures_history;
CREATE INDEX idx_structures_history_seq
  ON structures_history (profile_id, network_id, tab_id, seq DESC);
PRAGMA foreign_keys = ON;

-- 4. chronicle_history: +tab_id, PK расширен tab_id и entry_kind.
PRAGMA foreign_keys = OFF;
ALTER TABLE chronicle_history ADD COLUMN tab_id TEXT;
CREATE TABLE chronicle_history__new (
  profile_id  TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  tab_id      TEXT,
  entry_kind  TEXT NOT NULL,           -- 'thought' | 'link'
  entry_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  visited_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, network_id, tab_id, entry_kind, entry_id)
);
INSERT INTO chronicle_history__new
  (profile_id, network_id, tab_id, entry_kind, entry_id, seq, visited_at)
  SELECT profile_id, network_id, NULL, entry_kind, entry_id, seq, visited_at
    FROM chronicle_history;
DROP TABLE chronicle_history;
ALTER TABLE chronicle_history__new RENAME TO chronicle_history;
CREATE INDEX idx_chronicle_history_seq
  ON chronicle_history (profile_id, network_id, tab_id, seq DESC);
PRAGMA foreign_keys = ON;
