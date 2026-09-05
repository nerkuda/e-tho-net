-- 032: properties — network-wide property registry (0.6.5, задачи «Схема и
-- миграция: справочник свойств и привязки» + «Домен: справочник свойств и
-- разрешение по привязкам»; спека — сущности properties / type_properties /
-- property_values / type_property_overrides и требование «Миграция свойств в
-- справочник: слияние дублей и переименование»).
--
-- До 0.6.5 определение свойства принадлежало типу (`type_properties` несла
-- key/value_type/config/description), поэтому одно и то же по смыслу поле
-- существовало в базе отдельной строкой в каждом типе, которому было нужно.
-- Теперь определение живёт один раз в справочнике `properties`, а
-- `type_properties` превращается в привязку свойства к типу.
--
-- Что делает миграция (одним файлом = одной транзакцией мигратора):
--
--   1. создаёт ветвимую `properties` (UNIQUE (name_key, layer_id) — имя
--      уникально в пределах сети, сравнение регистронезависимое);
--   2. переносит каждое определение из `type_properties` в справочник,
--      сливая дубли: критерий — имя (регистронезависимо), value_type,
--      config.multiple и config.options (отсутствие у обоих — совпадение);
--      allowed_type_ids у сливаемых ссылочных свойств ОБЪЕДИНЯЮТСЯ;
--   3. пересобирает `type_properties` в привязку (owner_type, owner_id,
--      property_id, required, position): каждая старая строка становится
--      привязкой, сохранив свой id и слой-колонки (надгробия и тени остаются
--      согласованными — данные переносятся во ВСЕХ слоях, не только в основе);
--   4. переадресует на выжившие id: property_values.property_id,
--      type_property_overrides.property_id и условия внутри JSON
--      saved_filters.definition (это единственное место, где миграция правит
--      данные значений/отборов);
--   5. одноимённые, но разные по природе свойства получают составное имя
--      `<имя типа>.<имя свойства>` (для типа связи — имя «вперёд»), при
--      остаточном совпадении — числовой суффикс.
--
-- Группировка идёт ГЛОБАЛЬЛЬНО по всем слоям: все физические строки одной
-- природы (включая теневые копии в живых слоях) образуют одну группу, выживает
-- определение с наименьшим pk (pk — суррогат, но в перестроенных таблицах он
-- совпадает с порядком вставки, т.е. аппроксимирует «раньше создано»; время
-- создания старая схема не хранила). Свойство-победитель сохраняет свой
-- старый id — ссылки значений и переопределений на выжившие определения
-- не переписываются вовсе.
--
-- НЕОБРАТИМО: отката нет. Перед обновлением нужна резервная копия data.db
-- сети (docs/install-server.md, CHANGELOG).

-- ---------------------------------------------------------------------------
-- 1. Справочник properties
-- ---------------------------------------------------------------------------

CREATE TABLE properties (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,                     -- логический UUID (id выжившего определения)
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,                     -- имя, как его видит пользователь
  name_key     TEXT NOT NULL,                     -- нормализованное имя (регистронезависимая уникальность)
  value_type   TEXT NOT NULL,                     -- 'text'|'date'|'number'|'bool'|'thought_ref'|'url'
  config       TEXT,                              -- JSON: default_value, options, multiple, allowed_type_ids
  description  TEXT,                              -- подсказка редактора и контекст для агентов
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (name_key, layer_id)
);

-- ---------------------------------------------------------------------------
-- 2. Временные таблицы: природа каждой строки, группы, карта перенаправления
-- ---------------------------------------------------------------------------

-- Природа определения: name_key | value_type | multiple | options.
-- options сравнивается как канонический JSON-текст (JSON.stringify без
-- пробелов); '[]' и отсутствие приравнены («у обоих отсутствует — совпадение»).
CREATE TEMP TABLE tp_nature AS
SELECT pk, id, layer_id, deleted, base_version, owner_type, owner_id,
       key, value_type, config, required, position, description,
       type_name_key(key) || '|' || value_type || '|' ||
         COALESCE(json_extract(config, '$.multiple'), 0) || '|' ||
         COALESCE(NULLIF(json_extract(config, '$.options'), '[]'), '') AS gkey,
       type_name_key(key) AS nk
FROM type_properties;

-- Группа природы → выжившее определение (минимальный pk по всем слоям).
CREATE TEMP TABLE tp_group AS
SELECT gkey, MIN(pk) AS survivor_pk
FROM tp_nature
GROUP BY gkey;

-- Карта: старый id определения → id свойства-победителя группы.
CREATE TEMP TABLE tp_map AS
SELECT n.id AS old_id, s.id AS new_id
FROM tp_nature n
JOIN tp_group g ON g.gkey = n.gkey
JOIN tp_nature s ON s.pk = g.survivor_pk;

-- ---------------------------------------------------------------------------
-- 3. Имена выживших свойств: слияние по регистру и переименование коллизий
-- ---------------------------------------------------------------------------

-- Сколько разных групп претендует на одно и то же имя.
CREATE TEMP TABLE tp_name_clash AS
SELECT nk, COUNT(*) AS groups_cnt
FROM (SELECT DISTINCT gkey, nk FROM tp_nature)
GROUP BY nk;

-- Имя типа-владельца выжившего определения (для составных имён).
CREATE TEMP TABLE tp_owner_name AS
SELECT g.gkey,
       COALESCE(
         (SELECT tt.name FROM thought_types tt WHERE tt.id = s.owner_id LIMIT 1),
         (SELECT lt.name_forward FROM link_types lt WHERE lt.id = s.owner_id LIMIT 1),
         s.owner_id
       ) AS owner_name,
       s.key AS survivor_key, s.nk AS survivor_nk, s.pk AS survivor_pk
FROM tp_group g
JOIN tp_nature s ON s.pk = g.survivor_pk;

-- Шаг 1: бесконфликтные группы сохраняют имя; в конфликтной группе имя
-- сохраняет самая ранняя группа (наименьший survivor_pk).
CREATE TEMP TABLE tp_ranked AS
SELECT o.*, c.groups_cnt,
       (SELECT COUNT(*) FROM tp_owner_name o2
         JOIN tp_name_clash c2 ON c2.nk = o2.survivor_nk
        WHERE c2.groups_cnt > 1 AND o2.survivor_pk < o.survivor_pk) AS clash_rank
FROM tp_owner_name o
JOIN tp_name_clash c ON c.nk = o.survivor_nk;

-- Шаг 2: группы с clash_rank > 0 получают составное имя `<тип>.<имя>`.
CREATE TEMP TABLE tp_candidate AS
SELECT gkey, survivor_key, survivor_nk, survivor_pk,
       CASE WHEN groups_cnt > 1 AND clash_rank > 0
            THEN owner_name || '.' || survivor_key
            ELSE survivor_key
       END AS candidate
FROM tp_ranked;

-- Шаг 3: устранение остаточных совпадений среди составных имён: считаем
-- повторы по name_key кандидата; дубликат (и первенец, столкнувшийся с уже
-- занятым бесконфликтным именем) получают числовой суффикс.
CREATE TEMP TABLE tp_final AS
SELECT c.gkey,
       CASE
         WHEN dup = 1 AND taken = 0 THEN c.candidate
         WHEN dup = 1 AND taken = 1 THEN c.candidate || ' 2'
         ELSE c.candidate || ' ' || (dup + CASE WHEN taken = 1 THEN 1 ELSE 0 END)
       END AS final_name,
       c.survivor_pk
FROM (
  SELECT b.gkey, b.candidate, b.survivor_pk, b.survivor_nk,
         (SELECT COUNT(*) FROM tp_candidate b2
           WHERE type_name_key(b2.candidate) = type_name_key(b.candidate)
             AND b2.gkey != b.gkey AND b2.survivor_pk < b.survivor_pk) + 1 AS dup,
         EXISTS (SELECT 1 FROM tp_candidate b2
                  JOIN tp_name_clash c2 ON c2.nk = b2.survivor_nk
                 WHERE c2.groups_cnt = 1
                   AND b2.gkey != b.gkey
                   AND type_name_key(b2.candidate) = type_name_key(b.candidate)) AS taken
  FROM tp_candidate b
) c;

-- ---------------------------------------------------------------------------
-- 4. Наполнение справочника: по одной строке на (группа, слой)
-- ---------------------------------------------------------------------------

INSERT INTO properties (id, layer_id, deleted, base_version, name, name_key,
                        value_type, config, description, created_at, updated_at)
SELECT s.id, n.layer_id, n.deleted, n.base_version,
       f.final_name, type_name_key(f.final_name),
       s.value_type,
       -- config: у сливаемых ссылочных свойств allowed_type_ids объединяются
       -- (legacy-allowed_type_id учитывается наравне со списком); одиночные
       -- группы переносят config выжившего дословно.
       CASE
         WHEN (SELECT COUNT(*) FROM tp_nature n2 WHERE n2.gkey = n.gkey) = 1 THEN s.config
         WHEN u.allowed IS NULL OR u.allowed = '[]' THEN s.config
         ELSE json_set(COALESCE(s.config, '{}'), '$.allowed_type_ids', json(u.allowed))
       END,
       s.description,
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM tp_group g
JOIN tp_nature s ON s.pk = g.survivor_pk
JOIN tp_final f ON f.survivor_pk = g.survivor_pk
JOIN (
  -- Представитель группы в конкретном слое: живая строка, а надгробие — только
  -- если живых строк группы в этом слое нет (иначе одна группа дала бы две
  -- строки properties с одинаковым (id, layer_id)).
  SELECT gkey, layer_id, MIN(pk) AS layer_pk
  FROM tp_nature n
  WHERE deleted = 0
     OR NOT EXISTS (
       SELECT 1 FROM tp_nature n2
       WHERE n2.gkey = n.gkey AND n2.layer_id = n.layer_id AND n2.deleted = 0
     )
  GROUP BY gkey, layer_id
) pick ON pick.gkey = g.gkey
JOIN tp_nature n ON n.pk = pick.layer_pk
LEFT JOIN (
  -- Объединение допустимых типов ссылок по всем строкам группы.
  SELECT gkey,
         (SELECT json_group_array(val) FROM (
            SELECT DISTINCT val FROM (
              SELECT je.value AS val
              FROM tp_nature n3, json_each(CASE WHEN n3.config IS NULL THEN 'null' ELSE n3.config END, '$.allowed_type_ids') je
              WHERE n3.gkey = tp_group_by.gkey
              UNION
              SELECT json_extract(n3.config, '$.allowed_type_id')
              FROM tp_nature n3
              WHERE n3.gkey = tp_group_by.gkey
                AND json_extract(n3.config, '$.allowed_type_id') IS NOT NULL
            ) WHERE val IS NOT NULL AND val != ''
          )) AS allowed
  FROM (SELECT gkey FROM tp_group GROUP BY gkey) tp_group_by
) u ON u.gkey = g.gkey;

-- ---------------------------------------------------------------------------
-- 5. type_properties → привязки
-- ---------------------------------------------------------------------------

CREATE TABLE type_properties_new (
  pk           INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL,                     -- логический UUID привязки (бывший id определения)
  layer_id     TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
               REFERENCES layers (id) ON DELETE CASCADE,
  deleted      INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  owner_type   TEXT NOT NULL,                     -- 'thought_type' | 'link_type'
  owner_id     TEXT NOT NULL,                     -- логический id типа
  property_id  TEXT NOT NULL,                     -- свойство из справочника properties
  required     INTEGER NOT NULL DEFAULT 0,        -- обязательность в ЭТОМ типе
  position     INTEGER NOT NULL DEFAULT 0,        -- порядок отображения в этом типе
  UNIQUE (id, layer_id),
  UNIQUE (owner_type, owner_id, property_id, layer_id)
);

-- Каждая старая строка становится привязкой, сохранив id и слой-колонки.
-- Защита от битых данных (одно свойство на один тип дважды в одном слое,
-- возможно только если до миграции слой и основа разошлись): остаётся живая
-- строка, при равенстве — самая поздняя по pk.
INSERT INTO type_properties_new (id, layer_id, deleted, base_version,
                                 owner_type, owner_id, property_id, required, position)
SELECT n.id, n.layer_id, n.deleted, n.base_version,
       n.owner_type, n.owner_id, m.new_id, n.required, n.position
FROM tp_nature n
JOIN tp_map m ON m.old_id = n.id
WHERE n.pk = (
  SELECT n2.pk
  FROM tp_nature n2
  JOIN tp_map m2 ON m2.old_id = n2.id
  WHERE n2.owner_type = n.owner_type AND n2.owner_id = n.owner_id
    AND n2.layer_id = n.layer_id AND m2.new_id = m.new_id
  ORDER BY n2.deleted ASC, n2.pk DESC
  LIMIT 1
);

DROP TABLE type_properties;
ALTER TABLE type_properties_new RENAME TO type_properties;

CREATE INDEX IF NOT EXISTS idx_type_properties_owner
  ON type_properties (owner_type, owner_id, position);
CREATE INDEX IF NOT EXISTS idx_type_properties_layer ON type_properties (layer_id);
CREATE INDEX IF NOT EXISTS idx_type_properties_property ON type_properties (property_id);

-- ---------------------------------------------------------------------------
-- 6. Переадресация ссылок на выжившие id
-- ---------------------------------------------------------------------------

UPDATE property_values
SET property_id = (SELECT m.new_id FROM tp_map m WHERE m.old_id = property_values.property_id)
WHERE property_id IN (SELECT old_id FROM tp_map WHERE old_id != new_id);

-- Слейшиеся дубли могли оставить два значения одного свойства у одного
-- владельца в одном слое (владелец менял тип туда-обратно): остаётся самое
-- позднее по pk (updated_at-порядок аппроксимируется порядком вставки).
DELETE FROM property_values
WHERE pk NOT IN (SELECT MAX(pk) FROM property_values
                  GROUP BY owner_type, owner_id, property_id, layer_id);

UPDATE type_property_overrides
SET property_id = (SELECT m.new_id FROM tp_map m WHERE m.old_id = type_property_overrides.property_id)
WHERE property_id IN (SELECT old_id FROM tp_map WHERE old_id != new_id);

DELETE FROM type_property_overrides
WHERE pk NOT IN (SELECT MAX(pk) FROM type_property_overrides
                  GROUP BY owner_type, type_id, property_id, layer_id);

-- Сохранённые отборы: JSON definition содержит property_id сливаемых дублей
-- в quoted-виде ("<uuid>"). UUID уникальны, поэтому замена подстроки по
-- точному quoted-вхождению безопасна; итерация по парам — рекурсивным CTE
-- (корреляция внутри CTE запрещена, поэтому CTE строится по всем строкам
-- saved_filters, а внешний UPDATE выбирает свою).
UPDATE saved_filters SET definition = COALESCE((
  WITH RECURSIVE rewrite(fid, iter, txt) AS (
    SELECT f.id, 0, f.definition FROM saved_filters f
    UNION ALL
    SELECT r.fid, r.iter + 1,
           REPLACE(r.txt, '"' || m.old_id || '"', '"' || m.new_id || '"')
    FROM rewrite r
    JOIN tp_map m ON m.rowid = r.iter + 1
  )
  SELECT txt FROM rewrite
  WHERE fid = saved_filters.id
    AND iter = (SELECT COUNT(*) FROM tp_map)
), saved_filters.definition);

-- ---------------------------------------------------------------------------
-- 7. Индексы справочника
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_properties_layer ON properties (layer_id);
CREATE INDEX IF NOT EXISTS idx_property_values_property ON property_values (property_id);

DROP TABLE tp_final;
DROP TABLE tp_candidate;
DROP TABLE tp_ranked;
DROP TABLE tp_owner_name;
DROP TABLE tp_name_clash;
DROP TABLE tp_map;
DROP TABLE tp_group;
DROP TABLE tp_nature;
