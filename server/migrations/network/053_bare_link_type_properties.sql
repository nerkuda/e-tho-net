-- 053: парное свойство-связь каждому «голому» типу связи (0.15.4,
-- ошибка 117a999a <Тип связи из ontology.write без парного свойства не
-- редактируется в GUI>; требование 09f692ff <Свойство-связь и тип связи —
-- единый жизненный цикл>; грабли 26a2a77c).
--
-- С версии 0.8.1 тип связи и его свойство-связь — единый жизненный цикл:
-- GUI редактирует тип ТОЛЬКО через парное свойство реестра
-- (`value_type = 'link'`, `config.link_type_id`). MCP-инструмент
-- `etn.ontology.write` секцией `link_types[]` до этой версии создавал строку
-- `link_types` без свойства: тип был виден в дереве «Типы связей», но
-- «Правка» не активировалась (property-manager.ts: `item.prop` не найден).
--
-- Эта миграция закрывает исторические данные: каждому живому нерутовому
-- типу связи без живого свойства-связи создаётся свойство в том же слое, где
-- лежит тип. Новая логика создания пары — в `ensureLinkPropertyForLinkType`
-- (ontology-write-service.ts / import-service.ts); миграция нужна ровно один
-- раз для сетей, где «голые» типы уже успели появиться.
--
-- Правила (зеркало шага 3 миграции 042, с уточнениями 0.15.4):
--   1. Поиск — по физическим таблицам (миграция идёт до наполнения
--      `layer_chain` соединения), `deleted = 0`, `is_root = 0`.
--      `NOT EXISTS` делает повторный прогон безопасным (no-op).
--   2. Имя свойства — `name_forward` типа. Если имя занято ЛЮБОЙ строкой
--      слоя (включая надгробие `deleted = 1`: она даст нарушение
--      `UNIQUE (name_key, layer_id)` при вставке) либо тем же именем другого
--      голого типа — числовой суффикс ` <N>`; если и суффикс занят —
--      короткий суффикс из id свойства (гарантированно уникален, не роняет
--      старт сервера).
--   3. Конфиг — `show_on_map: true`, `blocks_target_deletion: true`.
--      Настоящие JSON-булевы (`json('true')`), не `1`: потребители
--      сравнивают строго (`config.show_on_map === true` в shared
--      `computeDefaultCanvasLinkFilter`, `config.blocks_target_deletion ===
--      true` в доменном `listBlockingLinkProperties`). Флаги повторяют
--      поведение до 0.8.1: рёбра голых типов рисовались на карте всегда,
--      а `show_on_map = false` молча убрал бы их из дефолтного фильтра.
--      Для типов, созданных уже после 0.8.1, это осознанно возвращает их на
--      карту — иначе исправление чинит редактор, но прячет связи.
--   4. Привязки к типам мысли (`type_properties`) НЕ создаются: свойство
--      живёт в реестре как внетиповое (требование e93001ac). Существующие
--      рёбра типа остаются живыми и видны в редакторе мысли в группе
--      «Свойства вне типов».
--   5. `description` — маркер миграции (как в 042); рантайм-автосоздание
--      пишет `NULL`.
--
-- Диагностика: `_mig053_report` (kind = create_property: тип → свойство,
-- `name_suffixed` — имя не совпало с `name_forward`, `final_name`).
--
-- Миграция идемпотентна по данным и не меняет схему. ВНИМАНИЕ: необратима —
-- перед обновлением сделайте резервную копию `data.db` сети
-- (docs/install-server.md, CHANGELOG).

-- ---------------------------------------------------------------------------
-- 1. Общие значения: автор и метки времени.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig053_vars;
CREATE TEMP TABLE _mig053_vars AS
SELECT
  COALESCE(NULLIF(etn_first_user_id(), ''), 'system') AS author_id,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS now_iso,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms;

DROP TABLE IF EXISTS _mig053_report;
CREATE TEMP TABLE _mig053_report (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  link_type_id TEXT,
  property_id  TEXT,
  layer_id     TEXT,
  details      TEXT,
  recorded_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. Голые типы связи: живые, нерутовые, без живого свойства-связи.
--    `structural` исключён: структурные свойства («Родители»/«Потомки») не
--    имеют типа связи, их `link_type_id` — не наш случай.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig053_bare_lt;
CREATE TEMP TABLE _mig053_bare_lt AS
SELECT
  lt.id AS lt_id,
  lt.layer_id AS lt_layer,
  lt.name_forward,
  lt.name_reverse
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

-- ---------------------------------------------------------------------------
-- 3. Имена: база — `name_forward`; занятость проверяется по ВСЕМ строкам слоя
--    (включая надгробия) и по другим голым типам с тем же именем.
--    rn — порядковый номер голого типа в группе одинаковых forward-имён слоя.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig053_bare_named;
CREATE TEMP TABLE _mig053_bare_named AS
SELECT
  b.lt_id,
  b.lt_layer,
  b.name_forward,
  b.name_reverse,
  (SELECT COUNT(*) FROM _mig053_bare_lt b2
    WHERE b2.lt_layer = b.lt_layer
      AND type_name_key(b2.name_forward) = type_name_key(b.name_forward)
      AND b2.lt_id <= b.lt_id) AS rn,
  (SELECT COUNT(*) FROM properties p
    WHERE p.layer_id = b.lt_layer
      AND p.name_key = type_name_key(b.name_forward)) AS base_taken
FROM _mig053_bare_lt b;

DROP TABLE IF EXISTS _mig053_bare_with_id;
CREATE TEMP TABLE _mig053_bare_with_id AS
SELECT
  n.lt_id,
  n.lt_layer,
  n.name_forward,
  n.name_reverse,
  n.rn,
  n.base_taken,
  gen_uuid() AS prop_id,
  CASE
    WHEN n.base_taken = 0 AND n.rn = 1 THEN n.name_forward
    ELSE n.name_forward || ' ' || (n.base_taken + n.rn)
  END AS candidate
FROM _mig053_bare_named n;

DROP TABLE IF EXISTS _mig053_bare_final;
CREATE TEMP TABLE _mig053_bare_final AS
SELECT
  w.lt_id,
  w.lt_layer,
  w.name_forward,
  w.name_reverse,
  w.prop_id,
  CASE
    WHEN w.base_taken = 0 AND w.rn = 1 THEN w.candidate
    WHEN NOT EXISTS (
      SELECT 1 FROM properties p
       WHERE p.layer_id = w.lt_layer
         AND p.name_key = type_name_key(w.candidate)
    ) THEN w.candidate
    ELSE w.candidate || ' ' || substr(w.prop_id, 1, 8)
  END AS final_name
FROM _mig053_bare_with_id w;

-- ---------------------------------------------------------------------------
-- 4. Свойство-связь на каждый голый тип. Привязок не создаём (см. правила).
-- ---------------------------------------------------------------------------

INSERT INTO properties (
  id, layer_id, deleted, base_version, name, name_key, value_type, config,
  description, created_at, updated_at, created_by, updated_by,
  created_at_ms, updated_at_ms
)
SELECT
  f.prop_id, f.lt_layer, 0, 0, f.final_name, type_name_key(f.final_name),
  'link',
  json_object(
    'link_type_id', f.lt_id,
    'show_on_map', json('true'),
    'blocks_target_deletion', json('true')
  ),
  'создано миграцией 053 (0.15.4) для голого типа связи «' || f.name_forward || '» (ошибка 117a999a)',
  v.now_iso, v.now_iso, v.author_id, v.author_id,
  v.now_ms, v.now_ms
FROM _mig053_bare_final f, _mig053_vars v;

INSERT INTO _mig053_report (kind, link_type_id, property_id, layer_id, details, recorded_at)
SELECT
  'create_property',
  f.lt_id, f.prop_id, f.lt_layer,
  json_object(
    'reason', 'bare_link_type',
    'name_forward', f.name_forward,
    'name_reverse', f.name_reverse,
    'final_name', f.final_name,
    'name_suffixed', CASE
      WHEN type_name_key(f.final_name) = type_name_key(f.name_forward) THEN 0 ELSE 1 END,
    'attached_to_types', 0
  ),
  (SELECT now_iso FROM _mig053_vars)
FROM _mig053_bare_final f;

-- ---------------------------------------------------------------------------
-- 5. Уборка временных таблиц.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig053_bare_final;
DROP TABLE IF EXISTS _mig053_bare_with_id;
DROP TABLE IF EXISTS _mig053_bare_named;
DROP TABLE IF EXISTS _mig053_bare_lt;
DROP TABLE IF EXISTS _mig053_vars;
-- `_mig053_report` намеренно не удаляется: остаётся во временной схеме
-- соединения для диагностики (как `_mig042_report`).
