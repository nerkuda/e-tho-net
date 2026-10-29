-- 051: пер-мысленный порядок внетиповых свойств — отдельная ветвимая таблица
-- (0.14.1, задача 3948af62; ADR «пер-мысленный порядок внетиповых — отдельная
-- ветвимая таблица» 75a79109; сущность thought_property_order e41cea2e;
-- контракт 27ed2b39).
--
-- Что делает миграция:
--
--   1. Добавляет `property_values.created_at` — время ПОЯВЛЕНИЯ значения у
--      владельца (дефолт порядка «появление свойства у мысли»). Для
--      существующих строк backfill = текущий `updated_at`: другой отметки в
--      схеме нет. Правка значения `created_at` не меняет (его обновляет только
--      INSERT, не UPDATE-upsert).
--   2. Заводит ВЕТВИМУЮ таблицу `thought_property_order` — одна строка = одна
--      внетиповая сторона свойства у конкретной мысли. Общий шаблон ветвимой
--      таблицы (025): суррогатный `pk`, пара `(id, layer_id)` c UNIQUE,
--      `deleted` (надгробие) и `base_version`, `layer_id → layers(id) ON DELETE
--      CASCADE`.
--
--      Уникальность натурального ключа — по ВЫРАЖЕНИЮ
--      `(thought_id, property_id, COALESCE(side,''), layer_id)`: у скаляров
--      `side` = NULL, а UNIQUE-индекс SQLite считает NULL-ы различными —
--      COALESCE не даёт двум скалярным строкам одного свойства разъехаться.
--      Поэтому это отдельный UNIQUE INDEX, а не табличный UNIQUE.
--
--      `id` детерминирован (UUID v5 от натурального ключа, см.
--      `server/src/db/property-order-id.ts`), поэтому прослойка наследует id
--      основы. Таблица БЕЗВЕРСИОННАЯ: `base_version` всегда 0, слияние —
--      построчный last-write-wins.
--
-- Мигратор не повторяет файл, поэтому обычные ALTER/CREATE без IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- 1. property_values.created_at — время появления значения
-- ---------------------------------------------------------------------------

-- DEFAULT '' оставлен для совместимости прямых INSERT-ов (тестовые фикстуры,
-- старые архивы): рабочие пути записи всегда передают created_at явно.
ALTER TABLE property_values ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

UPDATE property_values SET created_at = updated_at;

-- ---------------------------------------------------------------------------
-- 2. thought_property_order — порядок внетиповых сторон у мысли
-- ---------------------------------------------------------------------------

CREATE TABLE thought_property_order (
  pk            INTEGER PRIMARY KEY AUTOINCREMENT, -- суррогат
  id            TEXT NOT NULL,                     -- логический UUID (v5 от натурального ключа)
  layer_id      TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                REFERENCES layers (id) ON DELETE CASCADE,
  deleted       INTEGER NOT NULL DEFAULT 0,        -- надгробие (§5.2)
  base_version  INTEGER NOT NULL DEFAULT 0,        -- всегда 0: таблица безверсионная
  thought_id    TEXT NOT NULL,                     -- мысль-владелец
  property_id   TEXT NOT NULL,                     -- свойство из справочника
  side          TEXT,                              -- NULL — скаляр; source/target — свойство-связь
  position      INTEGER NOT NULL DEFAULT 0,        -- позиция в группе «Свойства вне типа»
  updated_at    TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

-- Натуральный ключ строки порядка. NULL-сторона скаляра нормализуется в ''.
CREATE UNIQUE INDEX idx_thought_property_order_natural
  ON thought_property_order (thought_id, property_id, COALESCE(side, ''), layer_id);

CREATE INDEX idx_thought_property_order_thought
  ON thought_property_order (thought_id, layer_id);
CREATE INDEX idx_thought_property_order_layer ON thought_property_order (layer_id);
