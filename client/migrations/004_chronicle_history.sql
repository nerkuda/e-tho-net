-- chronicle_history: история мыслей и связей вида «Хроника», уровень L4
-- (docs/11-settings-and-state.md §2.3.1, 08-ui-spec.md §17). Пополняется при
-- открытии мысли или связи в редакторе из вида «Хроника»; в отличие от
-- focus_history/structures_history хранит и связи (entry_kind 'thought'|'link'),
-- поэтому PK включает entry_kind.

CREATE TABLE IF NOT EXISTS chronicle_history (
  profile_id  TEXT NOT NULL,
  network_id  TEXT NOT NULL,
  entry_kind  TEXT NOT NULL,   -- 'thought' | 'link'
  entry_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  visited_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, network_id, entry_kind, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_chronicle_history_seq
  ON chronicle_history (profile_id, network_id, seq DESC);
