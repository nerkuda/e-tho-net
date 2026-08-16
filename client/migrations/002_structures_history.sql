-- structures_history: история мыслей вида «Структуры мыслей», уровень L4
-- (docs/11-settings-and-state.md §2.3.1, 08-ui-spec.md §15.9).
-- Пополняется при открытии мысли в редакторе из вида «Структуры»; отдельна от
-- focus_history (истории фокуса холста). Схема идентична focus_history.

CREATE TABLE IF NOT EXISTS structures_history (
  profile_id  TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  thought_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  visited_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, network_id, thought_id)
);

CREATE INDEX IF NOT EXISTS idx_structures_history_seq
  ON structures_history (profile_id, network_id, seq DESC);
