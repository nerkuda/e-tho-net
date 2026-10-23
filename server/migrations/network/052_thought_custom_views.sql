-- 052: внетиповые отборы мысли — отдельная ветвимая таблица
-- `thought_custom_views` (0.14.1, задача a28d444b; сущность 52d34fed;
-- ADR 6021918b «внетиповой отбор — строка ветвимой таблицы при мысли»;
-- операция 5e55b7bb «CRUD /thoughts/{id}/views»).
--
-- Владелец отбора — мысль (`thought_id`), а не тип. Отборы общие для сети
-- (не личные), видны только у мысли-владельца и не наследуются её потомками.
-- Таблица ветвится построчно, как `thought_type_views` (037): правка одного
-- отбора сливается независимо от мысли и соседей.
--
-- **Имя таблицы.** `thought_views` занято пер-пользовательскими метками
-- просмотра (миграция 010), поэтому новая таблица — `thought_custom_views`.
-- Имя событий — `thought-custom-view.*`: `thought-view.updated` занято
-- событием меток просмотра.
--
-- **Уникальность имени.** `name_key` (trim + lowercase) уникален в пределах
-- мысли-владельца среди ЖИВЫХ строк слоя. В отличие от 037 — PARTIAL UNIQUE
-- `WHERE deleted = 0`: надгробие удалённого отбора НЕ занимает имя, повторное
-- создание того же имени в том же слое даёт новую живую строку с новым id
-- (прецедент — `idx_shelves_title_key_live` миграции 047). Надгробие с прежним
-- id продолжает прятать строку-предка.
--
-- **Ссылки.** SQL-FK на `thoughts` снят (как и у прочих логических ссылок
-- после 025: `thoughts.id` не уникален в `main` — строка живёт в нескольких
-- слоях). Каскадная чистка при необратимом удалении мысли выполняется
-- приложением (`domain/owner-cleanup.ts`), в слое — надгробиями.
--
-- **Ветвимость.** Таблица внесена в `BRANCHABLE_TABLES` (db/layer-chain.ts):
-- у строки `layer_id` + `deleted` + `base_version` + суррогат `pk`, пара
-- (id, layer_id) уникальна. `version` есть: правка отбора участвует в
-- If-Match и слиянии.
--
-- Мигратор не перезапускает файл; CREATE без IF NOT EXISTS.

CREATE TABLE thought_custom_views (
  pk            INTEGER PRIMARY KEY AUTOINCREMENT,                  -- суррогат
  id            TEXT NOT NULL,                                      -- случайный логический UUID
  layer_id      TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                REFERENCES layers (id) ON DELETE CASCADE,
  deleted       INTEGER NOT NULL DEFAULT 0,                         -- надгробие (§5.2)
  base_version  INTEGER NOT NULL DEFAULT 0,                         -- версия предка при материализации; 0 в основе
  thought_id    TEXT NOT NULL,                                      -- логический id мысли-владельца
  name          TEXT NOT NULL,                                      -- видимое имя (1..200 символов)
  name_key      TEXT NOT NULL DEFAULT '',                           -- нормализованное имя (trim+lowercase)
  description   TEXT,                                               -- необязательное описание
  definition    TEXT NOT NULL,                                      -- JSON: StructureFilter + sort + order
  position      INTEGER NOT NULL DEFAULT 0,                         -- порядок среди внетиповых отборов мысли
  is_default    INTEGER NOT NULL DEFAULT 0,                         -- 1 — открывается сам при фокусе мысли
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,                                      -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  UNIQUE (id, layer_id)
);

-- Имя уникально в пределах мысли в слое среди ЖИВЫХ строк; надгробие имя
-- не занимает (в отличие от `thought_type_views`).
CREATE UNIQUE INDEX idx_thought_custom_views_name_live
  ON thought_custom_views (thought_id, name_key, layer_id)
  WHERE deleted = 0;

-- Основной путь чтения: «внетиповые отборы мысли в порядке position».
CREATE INDEX idx_thought_custom_views_thought
  ON thought_custom_views (thought_id, layer_id, position);

-- Поиск собственного дефолта мысли (у мысли не более одного внетипового).
CREATE INDEX idx_thought_custom_views_default
  ON thought_custom_views (thought_id, layer_id)
  WHERE is_default = 1;

-- Ускоряет каскадное удаление слоя (как у других ветвимых таблиц).
CREATE INDEX idx_thought_custom_views_layer
  ON thought_custom_views (layer_id);
