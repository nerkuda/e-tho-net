-- links: тройка (source_id, target_id, type_id) уникальна среди ЖИВЫХ строк
-- слоя (фаза S, задача S14; docs/13-layers.md §6.1, §6 — преамбула).
--
-- 025 сделала UNIQUE (source_id, target_id, type_id, layer_id) ограничением
-- таблицы — надгробие продолжает занимать тройку. Из-за этого создание
-- типизированной связи в слое на тройку, уже занятую надгробием того же слоя
-- («удалил A→B в слое, передумал, создал A→B заново»), падает
-- SQLITE_CONSTRAINT_UNIQUE — а смена концов связи в слое (S14 §6.1:
-- надгробие старой + создание новой) упирается в ту же стену, когда новая
-- тройка совпадает с тройкой надгробия. Пункт 9 карточки S14 фиксирует это
-- для слияния («вставка не должна упираться в ещё не удалённую старую»);
-- в записи слоя физика та же.
--
-- Надгробию тройка не нужна: разрешение строк идёт по логическому `id`,
-- слияние реплеит надгробие как удаление по `id`. Поэтому ограничение
-- становится partial-индексом `WHERE deleted = 0` — уникальность тройки
-- среди живых строк слоя, надгробия её освобождают.
--
-- Table-level UNIQUE нельзя снять без пересборки таблицы, поэтому links
-- перестраивается по схеме 025: копия → DROP → RENAME → индексы. На links
-- нет FTS-триггеров (fts_link_texts синхронизируется с comments), FK ведёт
-- из links в layers (дочерняя таблица), DROP безопасен.

CREATE TABLE links_new (
  pk                     INTEGER PRIMARY KEY AUTOINCREMENT,
  id                     TEXT NOT NULL,
  layer_id               TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                         REFERENCES layers (id) ON DELETE CASCADE,
  deleted                INTEGER NOT NULL DEFAULT 0,
  base_version           INTEGER NOT NULL DEFAULT 0,
  source_id              TEXT NOT NULL,
  target_id              TEXT NOT NULL,
  type_id                TEXT,
  position               INTEGER NOT NULL DEFAULT 0,
  color                  TEXT,
  style                  TEXT,
  width                  INTEGER,
  active                 INTEGER NOT NULL DEFAULT 1,
  marked_for_deletion    INTEGER NOT NULL DEFAULT 0,
  marked_for_deletion_at TEXT,
  marked_for_deletion_by TEXT,
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,
  updated_by             TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

INSERT INTO links_new (pk, id, layer_id, deleted, base_version, source_id, target_id, type_id,
                       position, color, style, width, active,
                       marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
                       version, created_at, updated_at, created_by, updated_by)
SELECT pk, id, layer_id, deleted, base_version, source_id, target_id, type_id,
       position, color, style, width, active,
       marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
       version, created_at, updated_at, created_by, updated_by
FROM links;

DROP TABLE links;

ALTER TABLE links_new RENAME TO links;

CREATE INDEX idx_links_source ON links (source_id);
CREATE INDEX idx_links_target ON links (target_id);
CREATE INDEX idx_links_type   ON links (type_id);
CREATE INDEX idx_links_active ON links (active);
CREATE INDEX idx_links_marked_for_deletion
  ON links (marked_for_deletion) WHERE marked_for_deletion = 1;
CREATE INDEX idx_links_layer ON links (layer_id);

-- Тройка уникальна среди живых строк слоя; надгробия тройку освобождают.
-- Нетипизированные связи (type_id IS NULL) в UNIQUE-индекс не попадают
-- (SQLite считает NULL различными) — их дубль ловит сервис, как и до 025.
CREATE UNIQUE INDEX idx_links_triple_live
  ON links (source_id, target_id, type_id, layer_id) WHERE deleted = 0;
