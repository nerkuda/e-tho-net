-- 042: миграция единого реестра свойств и связей (0.8.1, задача f7633481
-- «Сервер: миграция единого реестра свойств и связей», сценарий e93001ac
-- «Миграция 0.8.1: единый реестр свойств и связей»; требования b9562306
-- «Свойство-связь одно на тип связи; сторона задана привязкой», 115e44fa
-- «Привязка со стороны назначения равноправна с привязкой источника»).
--
-- Что делает миграция (одним файлом = одной транзакцией мигратора, по
-- каждой сети инстанса):
--
--   0. Схема. Добавляем ЧАСТИЧНЫЙ UNIQUE-индекс
--      `idx_type_properties_owner_property_layer_side` для пары
--      `(owner_type, owner_id, property_id, side, layer_id)` при условии
--      `side IS NOT NULL`. Старый UNIQUE `(owner_type, owner_id, property_id,
--      layer_id)` (для скаляров и структурных, у которых side IS NULL)
--      остаётся без изменений — это даёт прежнюю семантику для тех
--      свойств, у которых стороны нет. Для link-связей новый частичный
--      индекс означает: source и target одного свойства в одном типе
--      сосуществуют (требование b9562306, 115e44fa), поскольку старый
--      UNIQUE срабатывает только для строк с side IS NULL.
--   1. СЛИЯНИЕ ВСТРЕЧНЫХ СВОЙСТВ. Для каждой пары свойств вида «связь» с
--      одним `config.link_type_id` и противоположными `config.direction`
--      выживает одна строка реестра — та, что была прямой (direction='out')
--      с наименьшим pk. Привязки обратных (direction='in') становятся
--      привязками назначения (`type_properties.side='target'`) у победителя;
--      свойства-проигравшие удаляются целиком (включая теневые копии и
--      надгробия во всех слоях). Конфиги проигравших логируются в отчёт и
--      отбрасываются — приоритет у прямой стороны.
--   2. СВОЙСТВО КАЖДОМУ «ГОЛОМУ» ТИПУ СВЯЗИ. У каждого живого нерутового
--      типа связи, у которого нет свойства в реестре, появляется
--      автоматическое свойство вида «связь» с пустыми списками
--      источников/назначений; имя берётся из `name_forward` типа связи;
--      привязка — к корневому типу мысли (`side='source'`, `required=0`,
--      без дефолта). Существующие рёбра этого типа остаются живыми и
--      становятся видны как внетиповое свойство.
--   3. МАТЕРИАЛИЗАЦИЯ ЗЕРКАЛ. Для каждого живого свойства-связи с непустым
--      `config.allowed_target_type_ids` создаются НАСТОЯЩИЕ привязки со
--      стороны назначения (`side='target'`, `required=0`, без дефолта) у
--      каждого типа из списка, где ещё нет привязки этого свойства. Это
--      превращает «вычисляемые зеркала» в редактируемые привязки.
--   4. СНЯТИЕ `direction`. У всех живых свойств-связей колонка
--      `config.direction` удаляется; направление живёт только в привязке
--      (`type_properties.side`). Структурные свойства-связи «Родители» /
--      «Потомки» не трогаются — у них направление хранится в `direction`
--      как атрибут реестровой строки (требование 39a76760).
--   5. ВОССТАНОВЛЕНИЕ ВИСЯЧИХ `link_type_id`. У свойств-связей, чей
--      `config.link_type_id` указывает на несуществующий тип связи,
--      создаётся новый link_type с именами, выведенными из самого
--      свойства (`properties.name` → `name_forward`, `«обратная сторона»`
--      → `name_reverse`); иначе — генерируются числовым суффиксом.
--      Покрывает случай, когда link_type был удалён, а свойство
--      осталось, — имя свойства больше не деградирует до id.
--   6. ОТЧЁТ МИГРАЦИИ. Все слияния, расхождения конфигов, созданные
--      свойства и типы связи записываются во временную таблицу
--      `_mig042_report` и в итоге — в лог мигратора (через SELECT перед
--      COMMIT'ом транзакции; сами файлы лога читаются при диагностике).
--
-- СЛОИ. Все правки идут по ВСЕМ слоям сети (включая теневые копии и
-- надгробия — id общий для определения свойства, различается только
-- физическая строка). Слияние рабочего слоя после миграции безопасно:
-- теневое правило «shadow-копия наследует все поля» даёт тот же
-- результат, что и применение к основе; несовпадений нет.
--
-- ЗЕРКАЛА из старой модели (привязки с direction='in' у встречного
-- свойства) уже материзованы в свойство-«обратку»; шаг 1 схлопывает их
-- в одну строку реестра и переносит привязки на правильную сторону.
--
-- НЕОБРАТИМО: отката нет (данные переписываются). Перед обновлением
-- рекомендуется резервная копия data.db сети
-- (docs/install-server.md, CHANGELOG).

-- ---------------------------------------------------------------------------
-- 0. Частичный UNIQUE-индекс по стороне для link-связей.
--    Старый UNIQUE (owner_type, owner_id, property_id, layer_id) сохраняется
--    и продолжает действовать для строк с side IS NULL (скаляры и
--    структурные свойства). Новый частичный индекс действует только для
--    строк с side IS NOT NULL и не дублирует старый constraint.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_type_properties_owner_property_layer_side
  ON type_properties (owner_type, owner_id, property_id, side, layer_id)
  WHERE side IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1. Общие переменные и таблица отчёта.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig042_vars;
CREATE TEMP TABLE _mig042_vars AS
SELECT
  COALESCE(NULLIF(etn_first_user_id(), ''), 'system') AS author_id,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS now_iso,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms;

DROP TABLE IF EXISTS _mig042_report;
CREATE TEMP TABLE _mig042_report (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  link_type_id TEXT,
  property_id TEXT,
  layer_id    TEXT,
  details     TEXT,
  recorded_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. СЛИЯНИЕ ВСТРЕЧНЫХ СВОЙСТВ.
--    Для каждого `config.link_type_id` в реестре ровно одно свойство с
--    direction='out' выживает; все свойства с direction='in' на тот же
--    link_type_id становятся его привязками-«target». Критерий выбора
--    победителя — минимальный pk среди прямых (стабильный порядок
--    создания). Расхождения конфигов (show_on_map, blocks_target_deletion,
--    default_value) — отбрасываются в пользу прямого.
-- ---------------------------------------------------------------------------

-- Прямые и обратные свойства по link_type_id.
DROP TABLE IF EXISTS _mig042_groups;
CREATE TEMP TABLE _mig042_groups AS
SELECT
  json_extract(p.config, '$.link_type_id') AS link_type_id,
  p.id AS property_id,
  json_extract(p.config, '$.direction') AS direction,
  p.pk,
  p.config AS config
FROM properties p
WHERE p.value_type = 'link'
  AND p.deleted = 0
  AND (json_extract(p.config, '$.structural') IS NULL
       OR json_extract(p.config, '$.structural') = 0)
  AND json_extract(p.config, '$.link_type_id') IS NOT NULL
  AND json_extract(p.config, '$.direction') IN ('out', 'in');

-- Победитель для каждого link_type_id: прямое (direction='out') с мин pk.
DROP TABLE IF EXISTS _mig042_winners;
CREATE TEMP TABLE _mig042_winners AS
SELECT link_type_id, property_id AS winner_id, MIN(pk) AS winner_pk
FROM _mig042_groups
WHERE direction = 'out'
GROUP BY link_type_id;

-- Проигравшие: все обратные (direction='in') на тот же link_type_id.
DROP TABLE IF EXISTS _mig042_losers;
CREATE TEMP TABLE _mig042_losers AS
SELECT g.link_type_id, g.property_id AS loser_id, g.config AS loser_config,
       w.winner_id
FROM _mig042_groups g
JOIN _mig042_winners w ON w.link_type_id = g.link_type_id
WHERE g.direction = 'in';

-- Расхождения конфигов: для каждого (winner, loser) перечислим ключи
-- config, значения которых различаются.
INSERT INTO _mig042_report (kind, link_type_id, property_id, layer_id, details, recorded_at)
SELECT
  'config_diverge',
  l.link_type_id,
  l.loser_id,
  NULL,
  json_object(
    'winner_property_id', l.winner_id,
    'loser_property_id', l.loser_id,
    'diverge_keys', (
      SELECT json_group_array(key) FROM (
        SELECT 'show_on_map' AS key
          WHERE json_extract(w.config, '$.show_on_map') IS NOT json_extract(l.loser_config, '$.show_on_map')
        UNION ALL SELECT 'blocks_target_deletion'
          WHERE json_extract(w.config, '$.blocks_target_deletion') IS NOT json_extract(l.loser_config, '$.blocks_target_deletion')
        UNION ALL SELECT 'multiple'
          WHERE json_extract(w.config, '$.multiple') IS NOT json_extract(l.loser_config, '$.multiple')
        UNION ALL SELECT 'allowed_target_type_ids'
          WHERE json_extract(w.config, '$.allowed_target_type_ids') IS NOT json_extract(l.loser_config, '$.allowed_target_type_ids')
        UNION ALL SELECT 'default_value'
          WHERE json_extract(w.config, '$.default_value') IS NOT json_extract(l.loser_config, '$.default_value')
      )
    )
  ),
  (SELECT now_iso FROM _mig042_vars)
FROM _mig042_losers l
JOIN (
  -- минимальный pk победителя (для выбора одной строки конфига)
  SELECT w.link_type_id, w.winner_id, MIN(g2.pk) AS pk, MIN(g2.config) AS config
  FROM _mig042_winners w
  JOIN _mig042_groups g2 ON g2.property_id = w.winner_id AND g2.direction = 'out'
  GROUP BY w.link_type_id
) w ON w.link_type_id = l.link_type_id;

-- Запись слияния (merge) — что с чем слилось.
INSERT INTO _mig042_report (kind, link_type_id, property_id, layer_id, details, recorded_at)
SELECT
  'merge',
  link_type_id,
  winner_id,
  NULL,
  json_object('merged_property_id', loser_id, 'winner_property_id', winner_id),
  (SELECT now_iso FROM _mig042_vars)
FROM _mig042_losers;

-- 2a. Перенос привязок проигравших на победителя со стороной 'target'.
--     У одного свойства в одном типе может быть только одна привязка
--     (UNIQUE (owner_type, owner_id, property_id, layer_id) остаётся в
--     силе — действует для всех строк). Поэтому при наличии у победителя
--     уже source-привязки на тот же (owner_type, owner_id, layer_id)
--     target-привязка проигравшего не переносится (source покрывает оба
--     направления: ребро от этого owner к другому уже видно через
--     source-привязку победителя). Иначе переносим target-привязку на
--     победителя.
UPDATE type_properties AS tp
   SET property_id = l.winner_id,
       side = 'target'
  FROM _mig042_losers l
 WHERE tp.property_id = l.loser_id
   AND tp.deleted = 0
   AND NOT EXISTS (
     SELECT 1 FROM type_properties tp2
      WHERE tp2.owner_type = tp.owner_type
        AND tp2.owner_id = tp.owner_id
        AND tp2.layer_id = tp.layer_id
        AND tp2.property_id = l.winner_id
        AND tp2.deleted = 0
   );

-- 2b. Удаление остатков проигравших: привязок со свойством-«проигравшим»
--     больше нет — все перенесены (2a) или были отброшены из-за уже
--     существующей привязки победителя на тот же owner. Удаляем живые
--     строки.
DELETE FROM type_properties
 WHERE property_id IN (SELECT loser_id FROM _mig042_losers)
   AND deleted = 0;

-- 2c. Удаление свойств-проигравших целиком (все строки во всех слоях,
--     включая теневые копии и надгробия). Уникальность `id` — по
--     `(id, layer_id)`; одного DELETE по id достаточно.
DELETE FROM properties WHERE id IN (SELECT loser_id FROM _mig042_losers);

-- ---------------------------------------------------------------------------
-- 3. СВОЙСТВО КАЖДОМУ «ГОЛОМУ» ТИПУ СВЯЗИ.
--    У каждого живого нерутового link_type, у которого нет свойства в
--    реестре, появляется автоматическое свойство. Имя — name_forward
--    типа связи; уникальный id; привязка к корневому типу мысли
--    (side='source', required=0).
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig042_bare_lt;
CREATE TEMP TABLE _mig042_bare_lt AS
SELECT lt.id AS lt_id, lt.layer_id AS lt_layer, lt.name_forward, lt.name_reverse
FROM link_types lt
WHERE lt.deleted = 0
  AND lt.is_root = 0
  AND NOT EXISTS (
    SELECT 1 FROM properties p
     WHERE p.value_type = 'link'
       AND p.deleted = 0
       AND (json_extract(p.config, '$.structural') IS NULL
            OR json_extract(p.config, '$.structural') = 0)
       AND json_extract(p.config, '$.link_type_id') = lt.id
  );

-- Уникальные имена: при коллизии с уже существующим именем свойства в
-- слое — добавляем числовой суффикс.
DROP TABLE IF EXISTS _mig042_bare_named;
CREATE TEMP TABLE _mig042_bare_named AS
SELECT
  b.lt_id, b.lt_layer, b.name_forward, b.name_reverse,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM properties p
       WHERE p.layer_id = b.lt_layer
         AND p.deleted = 0
         AND type_name_key(p.name) = type_name_key(b.name_forward)
    ) THEN b.name_forward || ' ' || (
      SELECT COUNT(*) FROM _mig042_bare_lt b2
       WHERE b2.lt_layer = b.lt_layer
         AND type_name_key(b2.name_forward) = type_name_key(b.name_forward)
         AND b2.lt_id <= b.lt_id
    ) + 1
    ELSE b.name_forward
  END AS final_name
FROM _mig042_bare_lt b;

-- Свежий UUID для каждого свойства (один на link_type, чтобы не
-- пересекаться с возможными существующими).
DROP TABLE IF EXISTS _mig042_bare_with_id;
CREATE TEMP TABLE _mig042_bare_with_id AS
SELECT n.lt_id, n.lt_layer, n.name_forward, n.name_reverse, n.final_name,
       gen_uuid() AS prop_id
FROM _mig042_bare_named n;

INSERT INTO properties (
  id, layer_id, deleted, base_version, name, name_key, value_type, config,
  description, created_at, updated_at, created_by, updated_by,
  created_at_ms, updated_at_ms
)
SELECT
  b.prop_id, b.lt_layer, 0, 0, b.final_name, type_name_key(b.final_name),
  'link',
  json_object(
    'link_type_id', b.lt_id,
    'show_on_map', 0,
    'blocks_target_deletion', 1
  ),
  'создано миграцией 042 (0.8.1) для голого link_type «' || b.name_forward || '»',
  v.now_iso, v.now_iso, v.author_id, v.author_id,
  v.now_ms, v.now_ms
FROM _mig042_bare_with_id b, _mig042_vars v;

-- Привязка к корневому типу мысли (id из миграции 021) со стороны source.
INSERT INTO type_properties (
  id, layer_id, deleted, base_version, owner_type, owner_id, property_id,
  required, position, side
)
SELECT
  gen_uuid(), b.lt_layer, 0, 0, 'thought_type',
  '00000000-0000-4000-8000-000000000001',
  b.prop_id, 0, 0, 'source'
FROM _mig042_bare_with_id b;

INSERT INTO _mig042_report (kind, link_type_id, property_id, layer_id, details, recorded_at)
SELECT
  'create_property',
  b.lt_id, b.prop_id, b.lt_layer,
  json_object('reason', 'bare_link_type', 'link_type_name_forward', b.name_forward),
  (SELECT now_iso FROM _mig042_vars)
FROM _mig042_bare_with_id b;

-- ---------------------------------------------------------------------------
-- 4. МАТЕРИАЛИЗАЦИЯ ЗЕРКАЛ.
--    Для каждого живого link-свойства с непустым `allowed_target_type_ids`
--    создаём привязку со стороны target у каждого типа из списка, где ещё
--    нет привязки этого свойства. position — следующий после максимального
--    у типа-владельца; required=0; дефолта нет.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig042_mirror_candidates;
CREATE TEMP TABLE _mig042_mirror_candidates AS
SELECT
  p.id AS property_id,
  p.layer_id AS prop_layer,
  je.value AS target_type_id,
  (SELECT l.id FROM layers l
    WHERE l.is_base = 1
      AND EXISTS (SELECT 1 FROM thought_types tt
                   WHERE tt.id = je.value AND tt.layer_id = l.id)
    LIMIT 1) AS target_type_layer
FROM properties p, json_each(json_extract(p.config, '$.allowed_target_type_ids')) je
WHERE p.value_type = 'link'
  AND p.deleted = 0
  AND (json_extract(p.config, '$.structural') IS NULL
       OR json_extract(p.config, '$.structural') = 0)
  AND json_extract(p.config, '$.allowed_target_type_ids') IS NOT NULL
  AND json_array_length(json_extract(p.config, '$.allowed_target_type_ids')) > 0
  AND EXISTS (SELECT 1 FROM thought_types tt WHERE tt.id = je.value AND tt.deleted = 0);

-- Уникальные (property_id, target_type_id) — оставляем одну запись
-- (якорь: минимальный слой свойства, tie-break — минимальный target_type).
DELETE FROM _mig042_mirror_candidates
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM _mig042_mirror_candidates
   GROUP BY property_id, target_type_id
 );

DROP TABLE IF EXISTS _mig042_mirror_new;
CREATE TEMP TABLE _mig042_mirror_new AS
SELECT
  mc.property_id, mc.target_type_id, mc.target_type_layer,
  -- position: max(position) + 1 среди существующих живых привязок
  -- целевого типа. NULL (нет привязок) → 0.
  COALESCE((
    SELECT MAX(tp.position) FROM type_properties tp
     WHERE tp.owner_type = 'thought_type'
       AND tp.owner_id = mc.target_type_id
       AND tp.layer_id = mc.target_type_layer
       AND tp.deleted = 0
  ), -1) + 1 AS next_pos
FROM _mig042_mirror_candidates mc
WHERE NOT EXISTS (
  SELECT 1 FROM type_properties tp
   WHERE tp.owner_type = 'thought_type'
     AND tp.owner_id = mc.target_type_id
     AND tp.layer_id = mc.target_type_layer
     AND tp.property_id = mc.property_id
     AND tp.deleted = 0
);

INSERT INTO type_properties (
  id, layer_id, deleted, base_version, owner_type, owner_id, property_id,
  required, position, side
)
SELECT
  gen_uuid(), mn.target_type_layer, 0, 0, 'thought_type',
  mn.target_type_id, mn.property_id,
  0, mn.next_pos, 'target'
FROM _mig042_mirror_new mn;

INSERT INTO _mig042_report (kind, link_type_id, property_id, layer_id, details, recorded_at)
SELECT
  'materialise_mirror',
  json_extract(p.config, '$.link_type_id'),
  mn.property_id, mn.target_type_layer,
  json_object('target_type_id', mn.target_type_id, 'position', mn.next_pos),
  (SELECT now_iso FROM _mig042_vars)
FROM _mig042_mirror_new mn
JOIN properties p ON p.id = mn.property_id;

-- ---------------------------------------------------------------------------
-- 5. СНЯТИЕ `direction` ИЗ КОНФИГОВ.
--    У неструктурных link-свойств ключ `direction` удаляется; у
--    структурных («Родители», «Потомки») — остаётся (требование 39a76760).
--    Надгробия и теневые копии тоже чистятся — id общий, конфиг должен
--    совпадать в каждом слое.
-- ---------------------------------------------------------------------------

UPDATE properties
   SET config = json_remove(config, '$.direction'),
       updated_at = (SELECT now_iso FROM _mig042_vars),
       updated_by = (SELECT author_id FROM _mig042_vars),
       updated_at_ms = (SELECT now_ms FROM _mig042_vars)
 WHERE value_type = 'link'
   AND deleted = 0
   AND (json_extract(config, '$.structural') IS NULL
        OR json_extract(config, '$.structural') = 0)
   AND json_extract(config, '$.direction') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. ВОССТАНОВЛЕНИЕ ВИСЯЧИХ `link_type_id`.
--    У живых link-свойств, чей `config.link_type_id` указывает на
--    несуществующий link_type, создаётся новый link_type. Имена
--    выводятся: name_forward = properties.name; name_reverse = «обратная
--    сторона: <name_forward>»; при коллизии — числовой суффикс.
--    Привязка к корневому link_type (id из миграции 021).
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig042_dangling;
CREATE TEMP TABLE _mig042_dangling AS
SELECT p.id AS property_id, p.layer_id AS prop_layer,
       p.name AS prop_name,
       json_extract(p.config, '$.link_type_id') AS old_lt_id
FROM properties p
WHERE p.value_type = 'link'
  AND p.deleted = 0
  AND (json_extract(p.config, '$.structural') IS NULL
       OR json_extract(p.config, '$.structural') = 0)
  AND json_extract(p.config, '$.link_type_id') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM link_types lt
     WHERE lt.id = json_extract(p.config, '$.link_type_id')
       AND lt.deleted = 0
  );

-- Уникальные old_lt_id (одно свойство → один новый link_type; если на
-- один old_lt_id висят несколько свойств — переадресуем все на новый).
DROP TABLE IF EXISTS _mig042_dangling_lt;
CREATE TEMP TABLE _mig042_dangling_lt AS
SELECT old_lt_id, MIN(prop_layer) AS lt_layer,
       -- имя берём с самого свойства, чей pk минимален
       (SELECT prop_name FROM _mig042_dangling d2
         WHERE d2.old_lt_id = d.old_lt_id
         ORDER BY (SELECT pk FROM properties p2 WHERE p2.id = d2.property_id) ASC
         LIMIT 1) AS lt_name
FROM _mig042_dangling d
GROUP BY old_lt_id;

-- Свежий id link_type и итоговое имя с обходом коллизий по (name_key,
-- layer_id).
DROP TABLE IF EXISTS _mig042_dangling_with_id;
CREATE TEMP TABLE _mig042_dangling_with_id AS
SELECT
  d.old_lt_id, d.lt_layer, d.lt_name,
  gen_uuid() AS new_lt_id,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM link_types lt
       WHERE lt.layer_id = d.lt_layer
         AND lt.deleted = 0
         AND (lt.name_forward_key = type_name_key(d.lt_name)
              OR lt.name_reverse_key = type_name_key(d.lt_name))
    ) THEN d.lt_name || ' (восст.)'
    ELSE d.lt_name
  END AS final_forward,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM link_types lt
       WHERE lt.layer_id = d.lt_layer
         AND lt.deleted = 0
         AND lt.name_forward_key = type_name_key('обратная сторона: ' || d.lt_name)
    ) THEN 'обратная сторона: ' || d.lt_name || ' (восст.)'
    ELSE 'обратная сторона: ' || d.lt_name
  END AS final_reverse
FROM _mig042_dangling_lt d;

INSERT INTO link_types (
  id, layer_id, deleted, base_version,
  name_forward, name_forward_key, name_reverse, name_reverse_key,
  parent_id, is_root, color, style, width, style_set, width_set,
  description, version,
  created_at, updated_at, created_by, updated_by,
  created_at_ms, updated_at_ms
)
SELECT
  di.new_lt_id, di.lt_layer, 0, 0,
  di.final_forward, type_name_key(di.final_forward),
  di.final_reverse, type_name_key(di.final_reverse),
  '00000000-0000-4000-8000-000000000002', 0, NULL, 'solid', 1, 1, 1,
  'восстановлено миграцией 042 (0.8.1) для висячего свойства «' || di.lt_name || '»',
  1,
  v.now_iso, v.now_iso, v.author_id, v.author_id,
  v.now_ms, v.now_ms
FROM _mig042_dangling_with_id di, _mig042_vars v;

-- Переадресация свойств на новый link_type.
UPDATE properties
   SET config = json_set(config, '$.link_type_id', di.new_lt_id),
       updated_at = (SELECT now_iso FROM _mig042_vars),
       updated_by = (SELECT author_id FROM _mig042_vars),
       updated_at_ms = (SELECT now_ms FROM _mig042_vars)
  FROM _mig042_dangling d
  JOIN _mig042_dangling_with_id di ON di.old_lt_id = d.old_lt_id
 WHERE properties.id = d.property_id
   AND properties.deleted = 0;

INSERT INTO _mig042_report (kind, link_type_id, property_id, layer_id, details, recorded_at)
SELECT
  'create_link_type',
  di.new_lt_id, NULL, di.lt_layer,
  json_object('reason', 'dangling_link_type_id', 'old_link_type_id', di.old_lt_id,
              'name_forward', di.final_forward, 'name_reverse', di.final_reverse),
  (SELECT now_iso FROM _mig042_vars)
FROM _mig042_dangling_with_id di;

-- ---------------------------------------------------------------------------
-- 7. ОТЧЁТ МИГРАЦИИ. Печатается мигратором через SELECT перед COMMIT — сами
--    файлы логов читаются при диагностике. Содержимое:
--      - merge: пары winner/loser по link_type;
--      - config_diverge: список ключей config, чьи значения разошлись;
--      - create_property: голые link_type → авто-свойство;
--      - materialise_mirror: новая привязка-назначение;
--      - create_link_type: восстановленный link_type для висячего свойства.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 8. Уборка временных таблиц.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig042_dangling_with_id;
DROP TABLE IF EXISTS _mig042_dangling_lt;
DROP TABLE IF EXISTS _mig042_dangling;
DROP TABLE IF EXISTS _mig042_mirror_new;
DROP TABLE IF EXISTS _mig042_mirror_candidates;
DROP TABLE IF EXISTS _mig042_bare_with_id;
DROP TABLE IF EXISTS _mig042_bare_named;
DROP TABLE IF EXISTS _mig042_bare_lt;
DROP TABLE IF EXISTS _mig042_losers;
DROP TABLE IF EXISTS _mig042_winners;
DROP TABLE IF EXISTS _mig042_groups;
DROP TABLE IF EXISTS _mig042_vars;
