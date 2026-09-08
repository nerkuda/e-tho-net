-- thought_type_views — именованные отборы типа мысли (версия 0.7.3,
-- тех.проект 918833e3 «Отборы для типов мыслей», задача 5361aa33
-- «Хранение отборов типов»). Подробнее:
--
--   * требование 141c2576 «Имя отбора уникально в пределах своего типа мысли» —
--     обеспечивается UNIQUE (thought_type_id, name_key, layer_id): одно имя не
--     может встречаться дважды среди живых строк одного типа в одном слое;
--     переопределение отбора предка потомком не запрещено, потому что у типов
--     разные `thought_type_id` (тип-потомок vs тип-предок);
--   * требование 7263e565 «У типа мысли не более одного отбора по умолчанию» —
--     на уровне БД инвариант НЕ закрыт: условие перекрытия между предком и
--     потомком намеренно решается доменным слоем (задача 17eb741e) — частичный
--     UNIQUE INDEX (thought_type_id, layer_id) WHERE is_default = 1 невозможен,
--     потому что должен учитывать эффективный набор по цепочке типов. Здесь
--     остаётся только индекс для быстрого поиска помеченного по умолчанию
--     отбора в пределах одного типа;
--   * требование eaca1253 «Эффективный набор отборов мысли» — собирается
--     доменным слоем поверх ветвимых строк; таблица даёт сырьё;
--   * требование 23e0f78e «Мысль без типа: отборы корневого типа действуют,
--     добавление запрещено» — запрет добавления тоже доменный (он про кнопку
--     «+» и редактор типов; таблица ничего не запрещает, кроме уникальности
--     имени внутри типа).
--
-- Хранение определения отбора. `definition` — JSON-строка того же формата,
-- что и у `saved_filters.definition` (docs/03-server-api.md §18): фильтр
-- панели «Структур» (`StructureFilter` + `sort`/`order`). Этап хранилища не
-- интерпретирует `definition` — это работа этапа 1 «Токены отбора». Перенос
-- дат/мысли в запросе появится в этапах 2 и 4, для них не нужны изменения
-- схемы.
--
-- Ветвимость. Таблица попадает в `BRANCHABLE_TABLES` (db/layer-chain.ts): у
-- каждой строки `layer_id` + `deleted` + `base_version` + суррогат `pk`, пара
-- (id, layer_id) уникальна. SQL-FK на thought_types СНИМАЕТСЯ — на логический
-- `thought_type_id` ссылается `thought_types.id`, который после 025 больше не
-- уникален в `main` (есть в нескольких слоях). Каскадная чистка при
-- физическом удалении типа выполняется приложением (как и у других
-- полиморфных ссылок на мысли).
--
-- Мигратор не перезапускает файл; CREATE TABLE без IF NOT EXISTS.

CREATE TABLE thought_type_views (
  pk               INTEGER PRIMARY KEY AUTOINCREMENT,                  -- суррогат
  id               TEXT NOT NULL,                                      -- логический UUID
  layer_id         TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                   REFERENCES layers (id) ON DELETE CASCADE,
  deleted          INTEGER NOT NULL DEFAULT 0,                         -- надгробие
  base_version     INTEGER NOT NULL DEFAULT 0,                         -- версия предка при материализации; 0 в основе
  thought_type_id  TEXT NOT NULL,                                      -- логический id типа мысли; SQL-FK снят
  name             TEXT NOT NULL,                                      -- видимое имя (1..200 символов)
  name_key         TEXT NOT NULL DEFAULT '',                           -- нормализованное имя (trim+lowercase); DEFAULT сохранён на случай сырых INSERT
  description      TEXT,                                               -- необязательное, для подсказок и контекста агентам
  definition       TEXT NOT NULL,                                      -- JSON: StructureFilter + sort + order (saved_filters.definition)
  position         INTEGER NOT NULL DEFAULT 0,                         -- порядок отображения внутри типа
  is_default       INTEGER NOT NULL DEFAULT 0,                         -- 1 — отбор открывается сам при переводе мысли в фокус
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,                                      -- ISO-8601 UTC
  updated_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (thought_type_id, name_key, layer_id)                         -- имя уникально в пределах типа в слое
);

-- Быстрый список отборов одного типа в заданном порядке (основной путь
-- чтения: «отборы типа X, упорядоченные по position»).
CREATE INDEX idx_thought_type_views_type
  ON thought_type_views (thought_type_id, layer_id, position);

-- Поиск отбора «по умолчанию» в пределах типа: WHERE thought_type_id = ?
-- AND layer_id = ? AND is_default = 1. Доменный слой (задача 17eb741e)
-- дополнительно решает, что у одного типа не больше одной такой строки.
CREATE INDEX idx_thought_type_views_default
  ON thought_type_views (thought_type_id, layer_id)
  WHERE is_default = 1;

-- Ускоряет каскадное удаление слоя (как и у других ветвимых таблиц).
CREATE INDEX idx_thought_type_views_layer
  ON thought_type_views (layer_id);
