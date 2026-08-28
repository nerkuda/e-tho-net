-- Change layers (фаза S, задача S2; docs/13-layers.md §2–§3, §9;
-- docs/02-data-model.md §3.0).
--
-- Copy-on-write слои поверх живой основы. Что делает эта миграция:
--
--   1. Таблица `layers` (сама не ветвится) + строка основы с фиксированным id
--      (`BASE_LAYER_ID` из shared/constants.ts; тот же приём фиксированных id,
--      что у корневых типов в 021).
--   2. Все ветвимые таблицы (13-layers.md §3) перестраиваются: суррогатный
--      `pk`, пара `(id, layer_id)` c UNIQUE, `deleted` (надгробие) и
--      `base_version` (версия строки предка на момент материализации; 0 в
--      основе — у строк основы нет предка).
--   3. SQL-FK между сущностями СНИМАЮТСЯ: ссылки идут на логический `id`,
--      который больше не уникален (13-layers.md §3, осознанная потеря
--      целостности на уровне СУБД). FK остаётся только у `layer_id → layers.id`
--      (ON DELETE CASCADE: удаление слоя физически сносит его теневые строки и
--      надгробия, §2.4) и у `layers.parent_id → layers.id` (каскад поддерева
--      слоёв, §2.4).
--   4. Неветвимые таблицы с FK на мысли (thought_views, user_focus_*,
--      user_pinned_thoughts, thought_read_metrics) перестраиваются без FK:
--      родительский ключ `thoughts.id` перестал быть уникальным, FK невозможен;
--      очистка при физическом удалении мысли выполняет приложение.
--   5. `links.position` — ручной порядок как поле самой связи (решение T1,
--      13-layers.md §3): порядок ветвится вместе со связью. Перенос данных из
--      `user_focus_order` — сама задача T1; здесь только поле.
--   6. FTS-таблицы пересоздаются с `layer_id UNINDEXED` (подготовка к S6;
--      поиск по слоям — не здесь).
--
-- Почему перестройка таблиц безопасна здесь, хотя 013 её избегала: 013 боялся
-- DROP TABLE под foreign_keys=ON (неявный DELETE каскадом сносит данные
-- дочерних таблиц). Здесь данные ВСЕХ затронутых таблиц сначала копируются в
-- `*_new`, затем дочерние (в порядке FK-графа) удаляются, затем родители —
-- каскадам уже нечего сносить, — и только потом *_new переименовываются.
-- Триггеры FTS снимаются до копирования, чтобы копия не писала в старый индекс;
-- индекс пересоздаётся и наполняется заново в конце.
--
-- `thought_synonyms` и `comment_targets` получают собственный `id` (UUID,
-- DEFAULT gen_uuid() — функция регистрируется в registerMigrationHelpers):
-- адресация ветвимой строки — пара (id, layer_id), у этих таблиц её не было.
-- DEFAULT layer_id = основа означает: весь существующий код, не знающий про
-- слои, продолжает писать в основу без изменений (в S3 запись начнёт передавать
-- слой явно).
--
-- Мигратор не повторяет файл, поэтому обычные CREATE/INSERT без IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- 1. layers + основа
-- ---------------------------------------------------------------------------

CREATE TABLE layers (
  id               TEXT PRIMARY KEY,         -- UUID
  parent_id        TEXT REFERENCES layers (id) ON DELETE CASCADE,
                                 -- NULL только у основы; каскад = удаление поддерева слоёв (§2.4)
  title            TEXT NOT NULL,            -- у основы фиксировано «Основа»
  comment          TEXT,                     -- необязательный, но настоятельно рекомендуемый
  git_branch       TEXT,                     -- ветка репозитория; ничем не проверяется на MVP
  is_service       INTEGER NOT NULL DEFAULT 0, -- 1 — резервный слой, скрыт из списка выбора (§8.2)
  is_base          INTEGER NOT NULL DEFAULT 0, -- 1 ровно у одной строки на сеть
  depth            INTEGER NOT NULL,         -- 0 у основы; денормализована для лимита §2.1
  created_by       TEXT NOT NULL,            -- user_id в _system.db
  created_at       TEXT NOT NULL,            -- ISO-8601, точность до секунды
  last_activity_at TEXT NOT NULL,            -- последняя запись в любую ветвимую строку слоя
  version          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_layers_parent ON layers (parent_id);
CREATE INDEX idx_layers_service ON layers (is_service) WHERE is_service = 1;

INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base,
                    depth, created_by, created_at, last_activity_at, version)
VALUES ('00000000-0000-4000-8000-0000000000ba5e', NULL, 'Основа', NULL, NULL, 0, 1,
        0, 'system', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 1);

-- ---------------------------------------------------------------------------
-- 2. Снять FTS-триггеры и удалить FTS-таблицы (пересоздаются в конце)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_thoughts_ai_names;
DROP TRIGGER IF EXISTS trg_thoughts_ad_names;
DROP TRIGGER IF EXISTS trg_thoughts_au_names;
DROP TRIGGER IF EXISTS trg_synonyms_ai_names;
DROP TRIGGER IF EXISTS trg_synonyms_ad_names;
DROP TRIGGER IF EXISTS trg_synonyms_au_names;
DROP TRIGGER IF EXISTS trg_comments_ai_fts;
DROP TRIGGER IF EXISTS trg_comments_ad_fts;
DROP TRIGGER IF EXISTS trg_comments_au_fts;

DROP TABLE IF EXISTS fts_thought_names;
DROP TABLE IF EXISTS fts_thought_texts;
DROP TABLE IF EXISTS fts_link_texts;

-- ---------------------------------------------------------------------------
-- 3. Новые схемы ветвимых таблиц (данные — в шаге 4)
-- ---------------------------------------------------------------------------

CREATE TABLE thoughts_new (
  pk                     INTEGER PRIMARY KEY AUTOINCREMENT, -- суррогат
  id                     TEXT NOT NULL,                     -- логический UUID
  layer_id               TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                         REFERENCES layers (id) ON DELETE CASCADE,
  deleted                INTEGER NOT NULL DEFAULT 0,        -- надгробие (§5.2)
  base_version           INTEGER NOT NULL DEFAULT 0,        -- версия предка при материализации (§5.1); 0 в основе
  title                  TEXT NOT NULL,
  title_norm             TEXT NOT NULL,
  type_id                TEXT,                              -- ссылка на логический id; SQL-FK снят
  icon                   TEXT,
  icon_kind              TEXT NOT NULL DEFAULT 'emoji',
  icon_attachment_id     TEXT,
  active                 INTEGER NOT NULL DEFAULT 1,
  is_protected           INTEGER NOT NULL DEFAULT 0,
  is_root                INTEGER NOT NULL DEFAULT 0,
  marked_for_deletion    INTEGER NOT NULL DEFAULT 0,
  marked_for_deletion_at TEXT,
  marked_for_deletion_by TEXT,
  fg_color               TEXT,
  bg_color               TEXT,
  font_bold              INTEGER NOT NULL DEFAULT 0,
  font_italic            INTEGER NOT NULL DEFAULT 0,
  font_underline         INTEGER NOT NULL DEFAULT 0,
  font_strike            INTEGER NOT NULL DEFAULT 0,
  font_manual            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  updated_by             TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

CREATE TABLE thought_synonyms_new (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL DEFAULT (gen_uuid()),          -- новый UUID-идентификатор строки
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  thought_id   TEXT NOT NULL,                               -- логический id мысли; SQL-FK снят
  synonym      TEXT NOT NULL,
  synonym_norm TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (thought_id, synonym_norm, layer_id)               -- естественный ключ — в пределах слоя
);

CREATE TABLE thought_types_new (
  pk                  INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL,
  layer_id            TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                      REFERENCES layers (id) ON DELETE CASCADE,
  deleted             INTEGER NOT NULL DEFAULT 0,
  base_version        INTEGER NOT NULL DEFAULT 0,
  name                TEXT NOT NULL,
  name_key            TEXT NOT NULL DEFAULT '',  -- DEFAULT сохранён с 017: сырые INSERT без ключа не ломаются
  parent_id           TEXT,                                 -- логический id родительского типа; SQL-FK снят
  is_root             INTEGER NOT NULL DEFAULT 0,
  icon                TEXT,
  icon_kind           TEXT NOT NULL DEFAULT 'emoji',
  fg_color            TEXT,
  bg_color            TEXT,
  font_bold           INTEGER,
  font_italic         INTEGER,
  font_underline      INTEGER,
  font_strike         INTEGER,
  description         TEXT,
  comment_template_md TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (name_key, layer_id)                               -- имена уникальны в пределах слоя
);

CREATE TABLE link_types_new (
  pk               INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL,
  layer_id         TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                   REFERENCES layers (id) ON DELETE CASCADE,
  deleted          INTEGER NOT NULL DEFAULT 0,
  base_version     INTEGER NOT NULL DEFAULT 0,
  name_forward     TEXT NOT NULL,
  name_forward_key TEXT NOT NULL DEFAULT '',   -- DEFAULT сохранён с 017
  name_reverse     TEXT NOT NULL,
  name_reverse_key TEXT NOT NULL DEFAULT '',   -- DEFAULT сохранён с 017,
  parent_id        TEXT,                                    -- SQL-FK снят
  is_root          INTEGER NOT NULL DEFAULT 0,
  color            TEXT,
  style            TEXT NOT NULL DEFAULT 'solid',
  width            INTEGER NOT NULL DEFAULT 1,
  style_set        INTEGER NOT NULL DEFAULT 1,
  width_set        INTEGER NOT NULL DEFAULT 1,
  description      TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (name_forward_key, name_reverse_key, layer_id)
);

CREATE TABLE type_properties_new (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  owner_type   TEXT NOT NULL,               -- 'thought_type' | 'link_type'
  owner_id     TEXT NOT NULL,               -- логический id типа; SQL-FK снят
  key          TEXT NOT NULL,
  value_type   TEXT NOT NULL,
  config       TEXT,
  required     INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, layer_id),
  UNIQUE (owner_type, owner_id, key, layer_id)
);

CREATE TABLE type_property_overrides_new (
  pk            INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL,
  layer_id      TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                REFERENCES layers (id) ON DELETE CASCADE,
  deleted       INTEGER NOT NULL DEFAULT 0,
  base_version  INTEGER NOT NULL DEFAULT 0,
  owner_type    TEXT NOT NULL,
  type_id       TEXT NOT NULL,
  property_id   TEXT NOT NULL,              -- SQL-FK снят
  default_value TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (owner_type, type_id, property_id, layer_id)
);

CREATE TABLE property_values_new (
  pk                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL,
  layer_id          TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                    REFERENCES layers (id) ON DELETE CASCADE,
  deleted           INTEGER NOT NULL DEFAULT 0,
  base_version      INTEGER NOT NULL DEFAULT 0,
  owner_type        TEXT NOT NULL,
  owner_id          TEXT NOT NULL,          -- SQL-FK снят (полиморфно и так)
  property_id       TEXT NOT NULL,          -- SQL-FK снят
  value_text        TEXT,
  value_date        TEXT,
  value_number      REAL,
  value_bool        INTEGER,
  value_thought_ref TEXT,
  updated_at        TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (owner_type, owner_id, property_id, layer_id)
);

CREATE TABLE links_new (
  pk                     INTEGER PRIMARY KEY AUTOINCREMENT,
  id                     TEXT NOT NULL,
  layer_id               TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                         REFERENCES layers (id) ON DELETE CASCADE,
  deleted                INTEGER NOT NULL DEFAULT 0,
  base_version           INTEGER NOT NULL DEFAULT 0,
  source_id              TEXT NOT NULL,                     -- SQL-FK снят
  target_id              TEXT NOT NULL,                     -- SQL-FK снят
  type_id                TEXT,                              -- SQL-FK снят
  position               INTEGER NOT NULL DEFAULT 0,        -- ручной порядок (T1): поле связи, ветвится вместе с ней
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
  UNIQUE (id, layer_id),
  UNIQUE (source_id, target_id, type_id, layer_id)          -- тройка уникальна в пределах слоя (§3)
);

CREATE TABLE comments_new (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  owner_type   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT,
  body_md      TEXT NOT NULL,
  body_html    TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

CREATE TABLE comment_targets_new (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL DEFAULT (gen_uuid()),
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  comment_id   TEXT NOT NULL,
  owner_type   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (comment_id, owner_type, owner_id, layer_id)
);

CREATE TABLE attachments_new (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  owner_type   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  url          TEXT,
  file_path    TEXT,
  file_size    INTEGER,
  mime_type    TEXT,
  title        TEXT,
  icon         TEXT,
  description  TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

-- ---------------------------------------------------------------------------
-- 4. Новые схемы неветвимых таблиц, лишившихся FK (thoughts.id не уникален)
-- ---------------------------------------------------------------------------

CREATE TABLE thought_views_new (
  user_id        TEXT NOT NULL,
  thought_id     TEXT NOT NULL,              -- SQL-FK снят: родитель больше не уникален
  last_viewed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, thought_id)
);

CREATE TABLE user_focus_preferences_new (
  user_id           TEXT NOT NULL,
  focus_thought_id  TEXT NOT NULL,
  dir               TEXT NOT NULL,
  sort              TEXT NOT NULL,
  sort_order        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, focus_thought_id, dir)
);

CREATE TABLE user_focus_order_new (
  user_id           TEXT NOT NULL,
  focus_thought_id  TEXT NOT NULL,
  dir               TEXT NOT NULL,
  thought_id        TEXT NOT NULL,
  position          INTEGER NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, focus_thought_id, dir, thought_id)
);

CREATE TABLE user_pinned_thoughts_new (
  user_id    TEXT NOT NULL,
  thought_id TEXT NOT NULL,
  position   INTEGER NOT NULL,
  pinned_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, thought_id)
);

CREATE TABLE thought_read_metrics_new (
  thought_id     TEXT PRIMARY KEY,
  reads_count    INTEGER NOT NULL DEFAULT 0,
  first_read_at  TEXT NOT NULL,
  last_read_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 5. Копирование данных (всё существующее попадает в основу)
-- ---------------------------------------------------------------------------

INSERT INTO thoughts_new (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                          icon_attachment_id, active, is_protected, is_root,
                          marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
                          fg_color, bg_color, font_bold, font_italic, font_underline, font_strike,
                          font_manual, version, created_at, created_by, updated_at, updated_by)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', title, title_norm, type_id, icon, icon_kind,
       icon_attachment_id, active, is_protected, is_root,
       marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
       fg_color, bg_color, font_bold, font_italic, font_underline, font_strike,
       font_manual, version, created_at, created_by, updated_at, updated_by
FROM thoughts;

INSERT INTO thought_synonyms_new (id, layer_id, thought_id, synonym, synonym_norm)
SELECT gen_uuid(), '00000000-0000-4000-8000-0000000000ba5e', thought_id, synonym, synonym_norm
FROM thought_synonyms;

INSERT INTO thought_types_new (id, layer_id, name, name_key, parent_id, is_root, icon, icon_kind,
                               fg_color, bg_color, font_bold, font_italic, font_underline, font_strike,
                               description, comment_template_md, version, created_at, updated_at, created_by)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', name, name_key, parent_id, is_root, icon, icon_kind,
       fg_color, bg_color, font_bold, font_italic, font_underline, font_strike,
       description, comment_template_md, version, created_at, updated_at, created_by
FROM thought_types;

INSERT INTO link_types_new (id, layer_id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                            parent_id, is_root, color, style, width, style_set, width_set,
                            description, version, created_at, updated_at, created_by)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', name_forward, name_forward_key, name_reverse, name_reverse_key,
       parent_id, is_root, color, style, width, style_set, width_set,
       description, version, created_at, updated_at, created_by
FROM link_types;

INSERT INTO type_properties_new (id, layer_id, owner_type, owner_id, key, value_type, config,
                                 required, position)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', owner_type, owner_id, key, value_type, config,
       required, position
FROM type_properties;

INSERT INTO type_property_overrides_new (id, layer_id, owner_type, type_id, property_id,
                                         default_value, created_at, updated_at)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', owner_type, type_id, property_id,
       default_value, created_at, updated_at
FROM type_property_overrides;

INSERT INTO property_values_new (id, layer_id, owner_type, owner_id, property_id,
                                 value_text, value_date, value_number, value_bool, value_thought_ref,
                                 updated_at)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', owner_type, owner_id, property_id,
       value_text, value_date, value_number, value_bool, value_thought_ref,
       updated_at
FROM property_values;

INSERT INTO links_new (id, layer_id, source_id, target_id, type_id, color, style, width, active,
                       marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
                       version, created_at, updated_at, created_by, updated_by)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', source_id, target_id, type_id, color, style, width, active,
       marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
       version, created_at, updated_at, created_by, updated_by
FROM links;

INSERT INTO comments_new (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html,
                          valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', owner_type, owner_id, kind, title, body_md, body_html,
       valid_from, valid_to, version, created_at, updated_at, created_by, updated_by
FROM comments;

INSERT INTO comment_targets_new (id, layer_id, comment_id, owner_type, owner_id)
SELECT gen_uuid(), '00000000-0000-4000-8000-0000000000ba5e', comment_id, owner_type, owner_id
FROM comment_targets;

INSERT INTO attachments_new (id, layer_id, owner_type, owner_id, kind, url, file_path,
                             file_size, mime_type, title, icon, description, position,
                             created_at, created_by)
SELECT id, '00000000-0000-4000-8000-0000000000ba5e', owner_type, owner_id, kind, url, file_path,
       file_size, mime_type, title, icon, description, position,
       created_at, created_by
FROM attachments;

INSERT INTO thought_views_new (user_id, thought_id, last_viewed_at)
SELECT user_id, thought_id, last_viewed_at FROM thought_views;

INSERT INTO user_focus_preferences_new (user_id, focus_thought_id, dir, sort, sort_order, updated_at)
SELECT user_id, focus_thought_id, dir, sort, sort_order, updated_at FROM user_focus_preferences;

INSERT INTO user_focus_order_new (user_id, focus_thought_id, dir, thought_id, position, updated_at)
SELECT user_id, focus_thought_id, dir, thought_id, position, updated_at FROM user_focus_order;

INSERT INTO user_pinned_thoughts_new (user_id, thought_id, position, pinned_at)
SELECT user_id, thought_id, position, pinned_at FROM user_pinned_thoughts;

INSERT INTO thought_read_metrics_new (thought_id, reads_count, first_read_at, last_read_at)
SELECT thought_id, reads_count, first_read_at, last_read_at FROM thought_read_metrics;

-- ---------------------------------------------------------------------------
-- 6. Удаление старых таблиц: сначала дочерние по FK-графу (каскадам при
--    удалении родителей уже нечего сносить), затем родители
-- ---------------------------------------------------------------------------

DROP TABLE thought_synonyms;
DROP TABLE links;
DROP TABLE property_values;
DROP TABLE type_property_overrides;
DROP TABLE thought_views;
DROP TABLE user_focus_preferences;
DROP TABLE user_focus_order;
DROP TABLE user_pinned_thoughts;
DROP TABLE thought_read_metrics;
DROP TABLE comments;
DROP TABLE comment_targets;
DROP TABLE attachments;
DROP TABLE thoughts;
DROP TABLE thought_types;
DROP TABLE link_types;
DROP TABLE type_properties;

-- ---------------------------------------------------------------------------
-- 7. Переименование
-- ---------------------------------------------------------------------------

ALTER TABLE thoughts_new RENAME TO thoughts;
ALTER TABLE thought_synonyms_new RENAME TO thought_synonyms;
ALTER TABLE thought_types_new RENAME TO thought_types;
ALTER TABLE link_types_new RENAME TO link_types;
ALTER TABLE type_properties_new RENAME TO type_properties;
ALTER TABLE type_property_overrides_new RENAME TO type_property_overrides;
ALTER TABLE property_values_new RENAME TO property_values;
ALTER TABLE links_new RENAME TO links;
ALTER TABLE comments_new RENAME TO comments;
ALTER TABLE comment_targets_new RENAME TO comment_targets;
ALTER TABLE attachments_new RENAME TO attachments;
ALTER TABLE thought_views_new RENAME TO thought_views;
ALTER TABLE user_focus_preferences_new RENAME TO user_focus_preferences;
ALTER TABLE user_focus_order_new RENAME TO user_focus_order;
ALTER TABLE user_pinned_thoughts_new RENAME TO user_pinned_thoughts;
ALTER TABLE thought_read_metrics_new RENAME TO thought_read_metrics;

-- ---------------------------------------------------------------------------
-- 8. Индексы (уникальные индексы UNIQUE-ограничений создаются автоматически;
--    idx_*_layer ускоряют каскад удаления слоя и выборку строк слоя)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_thoughts_title_norm ON thoughts (title_norm);
CREATE INDEX IF NOT EXISTS idx_thoughts_type       ON thoughts (type_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_active     ON thoughts (active);
CREATE INDEX IF NOT EXISTS idx_thoughts_updated_at ON thoughts (updated_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_marked_for_deletion
  ON thoughts (marked_for_deletion) WHERE marked_for_deletion = 1;
CREATE INDEX IF NOT EXISTS idx_thoughts_layer ON thoughts (layer_id);

CREATE INDEX IF NOT EXISTS idx_synonyms_norm ON thought_synonyms (synonym_norm);
CREATE INDEX IF NOT EXISTS idx_thought_synonyms_layer ON thought_synonyms (layer_id);

CREATE INDEX IF NOT EXISTS idx_links_source ON links (source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON links (target_id);
CREATE INDEX IF NOT EXISTS idx_links_type   ON links (type_id);
CREATE INDEX IF NOT EXISTS idx_links_active ON links (active);
CREATE INDEX IF NOT EXISTS idx_links_marked_for_deletion
  ON links (marked_for_deletion) WHERE marked_for_deletion = 1;
CREATE INDEX IF NOT EXISTS idx_links_layer ON links (layer_id);

CREATE INDEX IF NOT EXISTS idx_thought_types_layer ON thought_types (layer_id);
CREATE INDEX IF NOT EXISTS idx_link_types_layer ON link_types (layer_id);
CREATE INDEX IF NOT EXISTS idx_type_properties_owner
  ON type_properties (owner_type, owner_id, position);
CREATE INDEX IF NOT EXISTS idx_type_properties_layer ON type_properties (layer_id);
CREATE INDEX IF NOT EXISTS idx_type_property_overrides_layer ON type_property_overrides (layer_id);

CREATE INDEX IF NOT EXISTS idx_property_values_owner
  ON property_values (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_property_values_layer ON property_values (layer_id);

CREATE INDEX IF NOT EXISTS idx_comments_owner  ON comments (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_comments_chrono ON comments (owner_type, owner_id, valid_from);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_permanent_one
  ON comments (owner_type, owner_id, layer_id) WHERE kind = 'permanent';
CREATE INDEX IF NOT EXISTS idx_comments_layer ON comments (layer_id);

CREATE INDEX IF NOT EXISTS idx_comment_targets_owner ON comment_targets (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_comment_targets_layer ON comment_targets (layer_id);

CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_attachments_layer ON attachments (layer_id);

CREATE INDEX IF NOT EXISTS idx_user_focus_order_pos
  ON user_focus_order (user_id, focus_thought_id, dir, position);
CREATE INDEX IF NOT EXISTS idx_user_pinned_thoughts_pos
  ON user_pinned_thoughts (user_id, position);
CREATE INDEX IF NOT EXISTS idx_thought_read_metrics_count
  ON thought_read_metrics (reads_count DESC, last_read_at DESC);

-- ---------------------------------------------------------------------------
-- 9. FTS: пересоздание с layer_id UNINDEXED (подготовка S6) + бэкфилл из
--    перестроенных таблиц + триггеры, знающие про слой
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE fts_thought_names USING fts5(
  thought_id UNINDEXED,
  layer_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE fts_thought_texts USING fts5(
  thought_id UNINDEXED,
  layer_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE fts_link_texts USING fts5(
  link_id UNINDEXED,
  layer_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
SELECT t.pk, t.id, t.layer_id,
       t.title || COALESCE((
         SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
         WHERE s.thought_id = t.id AND s.layer_id = t.layer_id
       ), '')
FROM thoughts t;

INSERT INTO fts_thought_texts (rowid, thought_id, layer_id, text)
SELECT c.pk, c.owner_id, c.layer_id, c.body_md FROM comments c WHERE c.owner_type = 'thought';

INSERT INTO fts_link_texts (rowid, link_id, layer_id, text)
SELECT c.pk, c.owner_id, c.layer_id, c.body_md FROM comments c WHERE c.owner_type = 'link';

-- thoughts ↔ fts_thought_names (text = title + синонимы того же слоя)

CREATE TRIGGER trg_thoughts_ai_names AFTER INSERT ON thoughts BEGIN
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  VALUES (
    NEW.pk,
    NEW.id,
    NEW.layer_id,
    NEW.title || COALESCE((
      SELECT ' ' || group_concat(synonym, ' ') FROM thought_synonyms
      WHERE thought_id = NEW.id AND layer_id = NEW.layer_id
    ), '')
  );
END;

CREATE TRIGGER trg_thoughts_ad_names AFTER DELETE ON thoughts BEGIN
  DELETE FROM fts_thought_names WHERE rowid = OLD.pk;
END;

CREATE TRIGGER trg_thoughts_au_names AFTER UPDATE ON thoughts BEGIN
  DELETE FROM fts_thought_names WHERE rowid = OLD.pk;
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  VALUES (
    NEW.pk,
    NEW.id,
    NEW.layer_id,
    NEW.title || COALESCE((
      SELECT ' ' || group_concat(synonym, ' ') FROM thought_synonyms
      WHERE thought_id = NEW.id AND layer_id = NEW.layer_id
    ), '')
  );
END;

-- thought_synonyms ↔ fts_thought_names (пересобирают строку мысли того же слоя)

CREATE TRIGGER trg_synonyms_ai_names AFTER INSERT ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names
   WHERE rowid = (SELECT pk FROM thoughts WHERE id = NEW.thought_id AND layer_id = NEW.layer_id);
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  SELECT t.pk, t.id, t.layer_id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
           WHERE s.thought_id = t.id AND s.layer_id = t.layer_id
         ), '')
  FROM thoughts t WHERE t.id = NEW.thought_id AND t.layer_id = NEW.layer_id;
END;

CREATE TRIGGER trg_synonyms_ad_names AFTER DELETE ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names
   WHERE rowid = (SELECT pk FROM thoughts WHERE id = OLD.thought_id AND layer_id = OLD.layer_id);
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  SELECT t.pk, t.id, t.layer_id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
           WHERE s.thought_id = t.id AND s.layer_id = t.layer_id
         ), '')
  FROM thoughts t WHERE t.id = OLD.thought_id AND t.layer_id = OLD.layer_id;
END;

CREATE TRIGGER trg_synonyms_au_names AFTER UPDATE ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names
   WHERE rowid = (SELECT pk FROM thoughts WHERE id = OLD.thought_id AND layer_id = OLD.layer_id);
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  SELECT t.pk, t.id, t.layer_id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
           WHERE s.thought_id = t.id AND s.layer_id = t.layer_id
         ), '')
  FROM thoughts t WHERE t.id = OLD.thought_id AND t.layer_id = OLD.layer_id;
END;

-- comments ↔ fts_thought_texts / fts_link_texts (text = body_md, слой комментария)

CREATE TRIGGER trg_comments_ai_fts AFTER INSERT ON comments BEGIN
  INSERT INTO fts_thought_texts (rowid, thought_id, layer_id, text)
  SELECT NEW.pk, NEW.owner_id, NEW.layer_id, NEW.body_md WHERE NEW.owner_type = 'thought';
  INSERT INTO fts_link_texts (rowid, link_id, layer_id, text)
  SELECT NEW.pk, NEW.owner_id, NEW.layer_id, NEW.body_md WHERE NEW.owner_type = 'link';
END;

CREATE TRIGGER trg_comments_ad_fts AFTER DELETE ON comments BEGIN
  DELETE FROM fts_thought_texts WHERE rowid = OLD.pk;
  DELETE FROM fts_link_texts WHERE rowid = OLD.pk;
END;

CREATE TRIGGER trg_comments_au_fts AFTER UPDATE ON comments BEGIN
  DELETE FROM fts_thought_texts WHERE rowid = OLD.pk;
  DELETE FROM fts_link_texts WHERE rowid = OLD.pk;
  INSERT INTO fts_thought_texts (rowid, thought_id, layer_id, text)
  SELECT NEW.pk, NEW.owner_id, NEW.layer_id, NEW.body_md WHERE NEW.owner_type = 'thought';
  INSERT INTO fts_link_texts (rowid, link_id, layer_id, text)
  SELECT NEW.pk, NEW.owner_id, NEW.layer_id, NEW.body_md WHERE NEW.owner_type = 'link';
END;
