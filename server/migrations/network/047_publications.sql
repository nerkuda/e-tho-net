-- 047: модель данных подсистемы «Публикации» (0.11.1, задача 8178e007;
-- тех.проект «Публикации — живые документы из мыслесети» c5261d02;
-- сущности bc147b40, 18f3bebf, e6aeb7ba, f0a51091; ADR 1d7e4b43;
-- требование ветвимости e7487d77).
--
-- Пять ветвимых таблиц сети:
--   * publications            — карточка публикации (рецепты/титул — JSON-поля);
--   * publication_order       — поузловый локальный порядок (естественный ключ
--                               (publication_id, node_key));
--   * publication_exclusions  — исключённые мысли (publication_id, thought_id);
--   * shelves                 — полка библиотеки;
--   * shelf_items             — состав полки (shelf_id, publication_id).
--
-- Все таблицы ветвимы: колонки `layer_id` (DEFAULT — основа), `deleted`
-- (надгробие) и `base_version` (версия предка при материализации), пара
-- `(id, layer_id)` UNIQUE, `layer_id → layers(id) ON DELETE CASCADE` — общий
-- шаблон 025_layers.sql. Таблицы внесены в закрытый реестр ветвимых таблиц
-- (db/layer-chain.ts, BRANCHABLE_TABLES), читаются только через `*_v`.
--
-- **Детерминированные id.** У order/exclusions/shelf_items логическая
-- идентичность — естественный ключ, а не суррогатный id; id выводится
-- детерминированно (UUIDv5) доменным слоем (db/publication-id.ts), чтобы
-- независимые первые записи одного ключа в разных слоях сходились в один id
-- (прецедент property_values, ошибка dc119240, миграция 036). Поэтому рядом с
-- `UNIQUE (id, layer_id)` стоит `UNIQUE (<natural key>, layer_id)`.
--
-- `publications` — колонка `version` (If-Match/слияние); у строк-деталей
-- версии нет (base_version = 0, конфликты слияния по ним не детектируются —
-- как у property_values); у `shelves` version есть (полноценная сущность с
-- правкой настроек).
--
-- ВАЛИДАЦИИ, не выражаемые схемой (резюме без заголовков, ровно один
-- источник обложки, text_sources ∩ extra_properties = ∅, numbering_from ≤
-- numbering_to), живут в домене (domain/publication-service.ts) и описаны
-- мыслями-требованиями, связанными с сущностями.

-- ---------------------------------------------------------------------------
-- publications — карточка публикации
-- ---------------------------------------------------------------------------

CREATE TABLE publications (
  pk                     INTEGER PRIMARY KEY AUTOINCREMENT, -- суррогат
  id                     TEXT NOT NULL,                     -- логический UUID
  layer_id               TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                         REFERENCES layers (id) ON DELETE CASCADE,
  deleted                INTEGER NOT NULL DEFAULT 0,
  base_version           INTEGER NOT NULL DEFAULT 0,
  title                  TEXT NOT NULL,                     -- заголовок титула (H1)
  subtitle               TEXT,                             -- подзаголовок; NULL — нет
  summary_md             TEXT,                             -- резюме, markdown без заголовков
  authorship             TEXT,                             -- авторство текстом; NULL — создатель
  cover_attachment_id    TEXT,                             -- строка-вложение-обложка (owner_type='publication')
  cover_url              TEXT,                             -- обложка URL; взаимоисключимо с cover_attachment_id
  assembly_date          TEXT,                             -- хранимая ISO-дата сборки; только явным rebuild
  title_recipe           TEXT,                             -- JSON рецепта заголовков (SavedFilterDefinition)
  text_sources           TEXT,                             -- JSON-массив id свойств-связей текстов
  extra_properties       TEXT,                             -- JSON-массив id свойств «дополнительных материалов»
  numbering_from         INTEGER,                          -- нижняя граница диапазона нумерации
  numbering_to           INTEGER,                          -- верхняя граница; NULL — без нумерации
  active                 INTEGER NOT NULL DEFAULT 1,
  marked_for_deletion    INTEGER NOT NULL DEFAULT 0,
  marked_for_deletion_at TEXT,
  marked_for_deletion_by TEXT,
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

CREATE INDEX idx_publications_layer ON publications (layer_id);
CREATE INDEX idx_publications_active ON publications (active);
CREATE INDEX idx_publications_trash
  ON publications (marked_for_deletion) WHERE marked_for_deletion = 1;
CREATE INDEX idx_publications_cover
  ON publications (cover_attachment_id) WHERE cover_attachment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- publication_order — поузловый локальный порядок
-- ---------------------------------------------------------------------------

CREATE TABLE publication_order (
  pk             INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL,                            -- UUIDv5(publication_id, node_key)
  layer_id       TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                 REFERENCES layers (id) ON DELETE CASCADE,
  deleted        INTEGER NOT NULL DEFAULT 0,
  base_version   INTEGER NOT NULL DEFAULT 0,
  publication_id TEXT NOT NULL,                            -- логический id публикации
  node_key       TEXT NOT NULL,                            -- id ребра вхождения либо id мысли (корень)
  position       REAL NOT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (publication_id, node_key, layer_id)
);

CREATE INDEX idx_publication_order_pub
  ON publication_order (publication_id, position);
CREATE INDEX idx_publication_order_layer ON publication_order (layer_id);

-- ---------------------------------------------------------------------------
-- publication_exclusions — исключённые мысли
-- ---------------------------------------------------------------------------

CREATE TABLE publication_exclusions (
  pk             INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL,                            -- UUIDv5(publication_id, thought_id)
  layer_id       TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                 REFERENCES layers (id) ON DELETE CASCADE,
  deleted        INTEGER NOT NULL DEFAULT 0,
  base_version   INTEGER NOT NULL DEFAULT 0,
  publication_id TEXT NOT NULL,
  thought_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (publication_id, thought_id, layer_id)
);

CREATE INDEX idx_publication_exclusions_pub ON publication_exclusions (publication_id);
CREATE INDEX idx_publication_exclusions_layer ON publication_exclusions (layer_id);

-- ---------------------------------------------------------------------------
-- shelves — полка библиотеки
-- ---------------------------------------------------------------------------

CREATE TABLE shelves (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,                              -- имя полки
  title_key    TEXT NOT NULL,                              -- нормализованное имя
  position     REAL NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

-- Уникальность имени полки в слое — только среди ЖИВЫХ строк (частичный
-- индекс по deleted = 0). Раньше здесь стоял табличный UNIQUE
-- (title_key, layer_id), который включал надгробия: удаление полки в рабочем
-- слое делает её имя невосстановимым — повторное createShelf с тем же именем
-- падало сырым SQLITE_CONSTRAINT, хотя удалённой полки для пользователя уже
-- нет. Табличный UNIQUE нельзя сделать частичным, поэтому ограничение вынесено
-- в индекс. Домен дополнительно проверяет уникальность по `shelves_v` и
-- возвращает штатную VALIDATION_ERROR.
CREATE UNIQUE INDEX idx_shelves_title_key_live
  ON shelves (title_key, layer_id) WHERE deleted = 0;

CREATE INDEX idx_shelves_layer ON shelves (layer_id);
CREATE INDEX idx_shelves_position ON shelves (position);

-- ---------------------------------------------------------------------------
-- shelf_items — состав полки
-- ---------------------------------------------------------------------------

CREATE TABLE shelf_items (
  pk             INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL,                            -- UUIDv5(shelf_id, publication_id)
  layer_id       TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                 REFERENCES layers (id) ON DELETE CASCADE,
  deleted        INTEGER NOT NULL DEFAULT 0,
  base_version   INTEGER NOT NULL DEFAULT 0,
  shelf_id       TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  position       REAL NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (shelf_id, publication_id, layer_id)
);

CREATE INDEX idx_shelf_items_shelf ON shelf_items (shelf_id, position);
CREATE INDEX idx_shelf_items_pub ON shelf_items (publication_id);
CREATE INDEX idx_shelf_items_layer ON shelf_items (layer_id);

-- Статистика планировщика (требование 239be851): ANALYZE — общий приём
-- завершения миграций, полезен и здесь для новых таблиц.
ANALYZE;
