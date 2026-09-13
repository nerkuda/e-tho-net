-- 040: перевод thought_ref-свойств в свойства-связи (0.8.1, задача 9542b640
-- «Перевод существующих ссылок на мысли в свойства-связи»; ADR «вид значения
-- thought_ref упраздняется», ADR «свойство-связь — проекция ребра»).
--
-- Что делает миграция (одним файлом = одной транзакцией мигратора, по каждой
-- сети инстанса):
--
--   1. для каждого свойства реестра с value_type='thought_ref' (живая строка в
--      несервисном слое) создаёт вид связи «upd: <имя свойства>» (прямое и
--      обратное имена одинаковы — симметрично, как «см. также»; префикс upd:
--      помечает автоматически созданный вид — такие стоит переименовывать в
--      осмысленные по мере ведения сети);
--   2. конвертирует определение на месте, id сохраняется (привязки к типам,
--      отборы type_views и фильтры продолжают работать): value_type='link',
--      config = { link_type_id, direction:'out', allowed_target_type_ids
--      (из allowed_type_ids/allowed_type_id, если был), show_on_map:false,
--      blocks_target_deletion:true, multiple (сохранить) };
--   3. каждое живое значение property_values (owner_type='thought',
--      любой слой) → ребро links (source=владелец, target=цель, type=новый
--      вид, слой тот же, где жило значение; позиция элемента массива — в
--      position ребра). Сконвертированные строки значений удаляются.
--      Значение с несуществующей целью (нет строки в thoughts) НЕ
--      конвертируется и остаётся строкой-«призраком»: чтением не видно
--      (свойство стало link, а значения link-свойств в property_values не
--      хранятся), физически не теряется — после миграции такие строки
--      находятся SQL-запросом по value_thought_ref IS NOT NULL;
--   4. хроно-комментарии рёбер переподчиняются мыслям-источникам рёбер:
--      comments (owner_type='link', kind='chronological') → owner_type
--      ='thought', owner_id = source_id ребра (надгробие ребра даёт свой
--      последний известный source_id; физической строки ребра нет совсем —
--      комментарий остаётся как есть), в начало body_md дописывается пометка
--      «*(перенесено с связи «A» → «B», миграция 0.8.1)*». body_html
--      пересобирается стартовым markdown-sweep (версия рендера бампнута
--      вместе с миграцией — sweepCommentHtml гоняется по всем сетям после
--      применения миграций);
--   5. значения свойств НА рёбрах (owner_type='link') дописываются строками
--      «- <имя свойства>: <значение>» в постоянный комментарий
--      соответствующего ребра (создаётся при отсутствии), затем строки
--      значений удаляются. Постоянный комментарий рёбра остаётся комментарием
--      ребра: теперь это комментарий значения свойства-связи;
--   6. вложения рёбер (attachments, owner_type='link') переподчиняются
--      мыслям-источникам рёбер;
--   7. привязки свойств к типам связей (type_properties /
--      type_property_overrides, owner_type='link_type') удаляются — у ребра
--      нет собственных атрибутов (ADR «свойство-связь — проекция ребра»).
--
-- СЛОИ. Конвертация выполняется по ВСЕМ слоям сети. Вид связи создаётся в
-- слое «якоря» определения — живой строке свойства с минимальной глубиной
-- слоя (ближайшей к основе; связи-резервы is_service=1 якорем быть не могут):
-- строка основы даёт вид, видимый из каждого слоя цепочки, а теневые копии
-- определения в рабочих слоях ссылаются на тот же id вида. Конец ребра
-- стабилен (смена концов — надгробие + новая строка с другим id), поэтому
-- источник/цель для переноса хроники и вложений читаются с любой физической
-- строки ребра. Слияние рабочего слоя после миграции безопасно: теневое
-- значение стало ребром слоя и при слиянии коллапсирует на равную тройку
-- основы (merge §6.2), надгробие значения без строки-победителя — no-op.
--
-- НЕОБРАТИМО: отката нет. Перед обновлением нужна резервная копия data.db
-- сети (docs/install-server.md, CHANGELOG).

-- ---------------------------------------------------------------------------
-- 0. Общие переменные
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig040_vars;
CREATE TEMP TABLE _mig040_vars AS
SELECT
  COALESCE(NULLIF(etn_first_user_id(), ''), 'system') AS author_id,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS now_iso,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms;

-- ---------------------------------------------------------------------------
-- 1. Якорь каждого thought_ref-свойства: живая строка определения в
--    несервисном слое с минимальной глубиной (tie-break — минимальный pk).
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig040_anchor;
CREATE TEMP TABLE _mig040_anchor AS
SELECT p.id AS prop_id, p.pk AS anchor_pk, p.layer_id AS anchor_layer,
       p.name AS prop_name, p.config AS prop_config
FROM properties p
JOIN layers l ON l.id = p.layer_id AND l.is_service = 0
WHERE p.value_type = 'thought_ref' AND p.deleted = 0
  AND p.pk = (
    SELECT p2.pk
    FROM properties p2
    JOIN layers l2 ON l2.id = p2.layer_id AND l2.is_service = 0
    WHERE p2.id = p.id AND p2.value_type = 'thought_ref' AND p2.deleted = 0
    ORDER BY l2.depth ASC, p2.pk ASC
    LIMIT 1
  );

-- ---------------------------------------------------------------------------
-- 2. Вид связи для каждого якоря. Имя «upd: <имя свойства>»; занято (живой
--    строкой того же слоя) — переиспользуется, иначе вставляется с числовым
--    суффиксом при коллизии ключей (в т.ч. с надгробием вида).
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig040_lt;
CREATE TEMP TABLE _mig040_lt AS
SELECT
  a.prop_id,
  a.anchor_layer,
  -- Живой вид с этой парой имён в слое якоря — переиспользуем.
  (SELECT lt.id FROM link_types lt
    WHERE lt.layer_id = a.anchor_layer AND lt.deleted = 0
      AND lt.name_forward_key = type_name_key('upd: ' || a.prop_name)
      AND lt.name_reverse_key = type_name_key('upd: ' || a.prop_name)
    LIMIT 1) AS reuse_lt_id,
  EXISTS (SELECT 1 FROM link_types lt
           WHERE lt.layer_id = a.anchor_layer
             AND lt.name_forward_key = type_name_key('upd: ' || a.prop_name)
             AND lt.name_reverse_key = type_name_key('upd: ' || a.prop_name)) AS name_taken,
  a.prop_name
FROM _mig040_anchor a;

-- Имя итогового вида: переиспользование → имя существующего вида;
-- коллизия ключей (нет живого вида, но имя занято надгробием) → числовой
-- суффикс; свободно → «upd: <имя>».
UPDATE _mig040_lt SET
  prop_name = prop_name || ' ' || (
    SELECT COUNT(*) FROM link_types lt
    WHERE lt.layer_id = _mig040_lt.anchor_layer
      AND lt.name_forward_key = type_name_key('upd: ' || _mig040_lt.prop_name)
      AND lt.name_reverse_key = type_name_key('upd: ' || _mig040_lt.prop_name)
  ) + 1
WHERE reuse_lt_id IS NULL AND name_taken;

-- id вида: переиспользованный существующий или свежий gen_uuid().
UPDATE _mig040_lt SET reuse_lt_id = COALESCE(reuse_lt_id, gen_uuid())
WHERE reuse_lt_id IS NULL;

-- Вставка недостающих видов связи (parent — корневой вид, id из 021).
INSERT INTO link_types (
  id, layer_id, deleted, base_version,
  name_forward, name_forward_key, name_reverse, name_reverse_key,
  parent_id, is_root, color, style, width, style_set, width_set, description,
  version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms
)
SELECT
  x.reuse_lt_id, x.anchor_layer, 0, 0,
  'upd: ' || x.prop_name, type_name_key('upd: ' || x.prop_name),
  'upd: ' || x.prop_name, type_name_key('upd: ' || x.prop_name),
  '00000000-0000-4000-8000-000000000002', 0, NULL, 'solid', 1, 1, 1,
  'создано миграцией 040 (0.8.1) из thought_ref-свойства «' || x.prop_name || '» — переименуйте в осмысленное',
  1, v.now_iso, v.now_iso, v.author_id, v.author_id, v.now_ms, v.now_ms
FROM _mig040_lt x, _mig040_vars v
WHERE NOT EXISTS (
  SELECT 1 FROM link_types lt
  WHERE lt.id = x.reuse_lt_id AND lt.layer_id = x.anchor_layer
);

-- Итоговая карта: свойство → id вида связи (вид живёт в слое якоря и виден
-- из каждого слоя, чья цепочка проходит через него).
DROP TABLE IF EXISTS _mig040_map;
CREATE TEMP TABLE _mig040_map AS
SELECT prop_id, reuse_lt_id AS lt_id FROM _mig040_lt;

-- ---------------------------------------------------------------------------
-- 3. Значения thought_ref → рёбра. Раскрытие одиночного id и JSON-массива,
--    позиция элемента — в position ребра. Конвертируются только строки, у
--    которых ВСЕ цели физически существуют; остальные остаются строками.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig040_items;
CREATE TEMP TABLE _mig040_items AS
SELECT
  pv.pk AS pv_pk, pv.layer_id AS val_layer, pv.owner_id AS owner_id,
  m.lt_id AS lt_id,
  je.value AS target_id,
  CAST(je.key AS INTEGER) AS pos,
  EXISTS (SELECT 1 FROM thoughts t WHERE t.id = je.value) AS target_ok
FROM property_values pv
JOIN _mig040_map m ON m.prop_id = pv.property_id
CROSS JOIN json_each(
  CASE WHEN trim(pv.value_thought_ref) LIKE '[%'
       THEN pv.value_thought_ref
       ELSE '[' || json_quote(pv.value_thought_ref) || ']' END
) je
WHERE pv.owner_type = 'thought' AND pv.deleted = 0
  AND pv.value_thought_ref IS NOT NULL AND pv.value_thought_ref != ''
  AND pv.value_thought_ref != '[]';

DROP TABLE IF EXISTS _mig040_convert;
CREATE TEMP TABLE _mig040_convert AS
SELECT pv_pk FROM _mig040_items GROUP BY pv_pk HAVING MIN(target_ok) = 1;

INSERT INTO links (
  id, layer_id, deleted, base_version, source_id, target_id, type_id, position,
  color, style, width, active, marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
  version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms
)
SELECT
  gen_uuid(), i.val_layer, 0, 0, i.owner_id, i.target_id, i.lt_id, i.pos,
  NULL, NULL, NULL, 1, 0, NULL, NULL,
  1, pv.updated_at, pv.updated_at, pv.created_by, pv.updated_by,
  pv.created_at_ms, pv.updated_at_ms
FROM _mig040_items i
JOIN _mig040_convert c ON c.pv_pk = i.pv_pk
JOIN property_values pv ON pv.pk = i.pv_pk;

DELETE FROM property_values WHERE pk IN (SELECT pv_pk FROM _mig040_convert);

-- ---------------------------------------------------------------------------
-- 4. Значения свойств НА рёбрах → строки в постоянный комментарий ребра
--    (до конвертации определений — формат значения читается по исходному
--    value_type). Затем строки значений удаляются.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig040_link_vals;
CREATE TEMP TABLE _mig040_link_vals AS
SELECT
  pv.pk AS pv_pk, pv.owner_id AS link_id,
  p.name AS prop_name, p.value_type AS value_type,
  pv.value_text AS value_text, pv.value_date AS value_date,
  pv.value_number AS value_number, pv.value_bool AS value_bool,
  pv.value_thought_ref AS value_thought_ref
FROM property_values pv
JOIN (
  -- Одна физическая строка на свойство (min pk): у определения есть теневые
  -- копии/надгробия/копии резервов, размножать строки значений нельзя.
  SELECT p2.id AS id, p2.name AS name, p2.value_type AS value_type
  FROM properties p2
  WHERE p2.pk = (SELECT MIN(p3.pk) FROM properties p3 WHERE p3.id = p2.id)
) p ON p.id = pv.property_id
WHERE pv.owner_type = 'link' AND pv.deleted = 0;

-- Целевой постоянный комментарий ребра: живая строка в несервисном слое с
-- минимальной глубиной; отсутствует — будет создан в слое ребра той же
-- глубины (см. INSERT ниже). Ссылочные значения форматируются названиями
-- целей (fallback — raw id), массивы — через запятую.
DROP TABLE IF EXISTS _mig040_pc;
CREATE TEMP TABLE _mig040_pc AS
SELECT lv.pv_pk,
  (SELECT c.pk FROM comments c
    JOIN layers l ON l.id = c.layer_id AND l.is_service = 0
   WHERE c.owner_type = 'link' AND c.owner_id = lv.link_id
     AND c.kind = 'permanent' AND c.deleted = 0
   ORDER BY l.depth ASC, c.pk ASC LIMIT 1) AS pc_pk,
  (SELECT l.id FROM links lr
    JOIN layers l ON l.id = lr.layer_id AND l.is_service = 0
   WHERE lr.id = lv.link_id
   ORDER BY l.depth ASC, lr.pk ASC LIMIT 1) AS pc_layer,
  lv.link_id
FROM _mig040_link_vals lv;

DROP TABLE IF EXISTS _mig040_lines;
CREATE TEMP TABLE _mig040_lines AS
SELECT
  pc.pc_pk, pc.pc_layer, pc.link_id,
  '- ' || lv.prop_name || ': ' ||
    CASE lv.value_type
      WHEN 'text'  THEN TRIM(COALESCE(lv.value_text, ''))
      WHEN 'url'   THEN CASE WHEN lv.value_text LIKE '[%'
                             THEN COALESCE((SELECT group_concat(COALESCE(TRIM(je.value), '')) FROM json_each(lv.value_text) je), '')
                             ELSE TRIM(COALESCE(lv.value_text, '')) END
      WHEN 'date'  THEN COALESCE(lv.value_date, '')
      WHEN 'number' THEN CAST(lv.value_number AS TEXT)
      WHEN 'bool'  THEN CASE lv.value_bool WHEN 1 THEN 'да' WHEN 0 THEN 'нет' ELSE '' END
      WHEN 'thought_ref' THEN COALESCE((
        SELECT group_concat(COALESCE(
          (SELECT t.title FROM thoughts t WHERE t.id = je.value ORDER BY t.pk LIMIT 1),
          je.value))
        FROM json_each(CASE WHEN lv.value_thought_ref LIKE '[%'
                             THEN lv.value_thought_ref
                             ELSE '[' || json_quote(lv.value_thought_ref) || ']' END) je), '')
      ELSE ''
    END AS line
FROM _mig040_link_vals lv
JOIN _mig040_pc pc ON pc.pv_pk = lv.pv_pk
ORDER BY lv.prop_name, lv.pv_pk;

-- Дописать строки в существующие комментарии (тело складывается из всех
-- строк ребра; пустое тело — сразу списком).
UPDATE comments AS c SET
  body_md = CASE WHEN c.body_md = '' THEN v.lines ELSE c.body_md || char(10) || char(10) || v.lines END,
  body_html = '',
  updated_at = (SELECT now_iso FROM _mig040_vars),
  updated_by = (SELECT author_id FROM _mig040_vars),
  updated_at_ms = (SELECT now_ms FROM _mig040_vars),
  version = c.version + 1
FROM (
  SELECT pc_pk, group_concat(line, char(10)) AS lines
  FROM (SELECT pc_pk, line FROM _mig040_lines WHERE pc_pk IS NOT NULL ORDER BY pc_pk, line)
  GROUP BY pc_pk
) v
WHERE c.pk = v.pc_pk;

-- Создать комментарий, когда у ребра его не было (слой — самый мелкий
-- несервисный слой строк ребра; строк ребра нет — основа).
INSERT INTO comments (
  id, layer_id, deleted, base_version, owner_type, owner_id, kind, title,
  body_md, body_html, valid_from, valid_to, version,
  created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms
)
SELECT
  gen_uuid(), COALESCE(v.pc_layer, '00000000-0000-4000-8000-0000000000ba5e'),
  0, 0, 'link', v.link_id, 'permanent', NULL,
  v.lines, '', (SELECT now_iso FROM _mig040_vars), NULL, 1,
  (SELECT now_iso FROM _mig040_vars), (SELECT now_iso FROM _mig040_vars),
  (SELECT author_id FROM _mig040_vars), (SELECT author_id FROM _mig040_vars),
  (SELECT now_ms FROM _mig040_vars), (SELECT now_ms FROM _mig040_vars)
FROM (
  SELECT link_id, MIN(COALESCE(pc_layer, '00000000-0000-4000-8000-0000000000ba5e')) AS pc_layer,
         group_concat(line, char(10)) AS lines
  FROM (SELECT link_id, pc_layer, line FROM _mig040_lines WHERE pc_pk IS NULL ORDER BY link_id, line)
  GROUP BY link_id
) v
WHERE v.link_id IS NOT NULL;

DELETE FROM property_values WHERE pk IN (SELECT pv_pk FROM _mig040_link_vals);

-- ---------------------------------------------------------------------------
-- 5. Конвертация определений (ВСЕ живые строки свойств с якорем, включая
--    теневые копии и копии резервных слоёв — id вида один на свойство).
-- ---------------------------------------------------------------------------

UPDATE properties AS p SET
  value_type = 'link',
  config = (
    SELECT json_patch(
             json_patch(
               json_object('link_type_id', m.lt_id, 'direction', 'out',
                           'show_on_map', 0, 'blocks_target_deletion', 1),
               CASE WHEN COALESCE(
                      NULLIF(CAST(json_extract(a.prop_config, '$.allowed_type_ids') AS TEXT), '[]'),
                      CASE WHEN json_extract(a.prop_config, '$.allowed_type_id') IS NOT NULL
                           THEN json_array(json_extract(a.prop_config, '$.allowed_type_id')) END
                    ) IS NOT NULL
                    THEN json_object('allowed_target_type_ids', json(COALESCE(
                         NULLIF(CAST(json_extract(a.prop_config, '$.allowed_type_ids') AS TEXT), '[]'),
                         CASE WHEN json_extract(a.prop_config, '$.allowed_type_id') IS NOT NULL
                              THEN json_array(json_extract(a.prop_config, '$.allowed_type_id')) END)))
                    ELSE '{}' END
             ),
             CASE WHEN COALESCE(json_extract(p.config, '$.multiple'), 0) = 1
                  THEN json_object('multiple', 1) ELSE '{}' END
           )
    FROM _mig040_map m
    LEFT JOIN _mig040_anchor a ON a.prop_id = m.prop_id
    WHERE m.prop_id = p.id
  ),
  updated_at = (SELECT now_iso FROM _mig040_vars),
  updated_by = (SELECT author_id FROM _mig040_vars),
  updated_at_ms = (SELECT now_ms FROM _mig040_vars)
WHERE p.value_type = 'thought_ref' AND p.deleted = 0
  AND p.id IN (SELECT prop_id FROM _mig040_map);

-- ---------------------------------------------------------------------------
-- 6. Хроно-комментарии рёбер → мысли-источники (все строки, включая
--    надгробия). Пометка о переносе — в начало body_md.
-- ---------------------------------------------------------------------------

UPDATE comments AS c SET
  owner_type = 'thought',
  owner_id = COALESCE((SELECT lr.source_id FROM links lr WHERE lr.id = c.owner_id ORDER BY lr.pk LIMIT 1), c.owner_id),
  body_md = '*(перенесено с связи «' ||
      COALESCE((SELECT t.title FROM thoughts t WHERE t.id =
        (SELECT lr.source_id FROM links lr WHERE lr.id = c.owner_id ORDER BY lr.pk LIMIT 1)
        ORDER BY t.pk LIMIT 1),
        (SELECT lr.source_id FROM links lr WHERE lr.id = c.owner_id ORDER BY lr.pk LIMIT 1)) ||
    '» → «' ||
      COALESCE((SELECT t.title FROM thoughts t WHERE t.id =
        (SELECT lr.target_id FROM links lr WHERE lr.id = c.owner_id ORDER BY lr.pk LIMIT 1)
        ORDER BY t.pk LIMIT 1),
        (SELECT lr.target_id FROM links lr WHERE lr.id = c.owner_id ORDER BY lr.pk LIMIT 1)) ||
    '», миграция 0.8.1)*' || char(10) || char(10) || c.body_md,
  body_html = '',
  updated_at = (SELECT now_iso FROM _mig040_vars),
  updated_by = (SELECT author_id FROM _mig040_vars),
  updated_at_ms = (SELECT now_ms FROM _mig040_vars),
  version = c.version + 1
WHERE c.owner_type = 'link' AND c.kind = 'chronological'
  AND EXISTS (SELECT 1 FROM links lr WHERE lr.id = c.owner_id);

-- ---------------------------------------------------------------------------
-- 7. Вложения рёбер → мысли-источники.
-- ---------------------------------------------------------------------------

UPDATE attachments AS a SET
  owner_type = 'thought',
  owner_id = COALESCE((SELECT lr.source_id FROM links lr WHERE lr.id = a.owner_id ORDER BY lr.pk LIMIT 1), a.owner_id)
WHERE a.owner_type = 'link'
  AND EXISTS (SELECT 1 FROM links lr WHERE lr.id = a.owner_id);

-- ---------------------------------------------------------------------------
-- 8. Привязки свойств к типам связей и их переопределения — удалить
--    (у ребра нет собственных атрибутов).
-- ---------------------------------------------------------------------------

DELETE FROM type_properties WHERE owner_type = 'link_type';
DELETE FROM type_property_overrides WHERE owner_type = 'link_type';

-- ---------------------------------------------------------------------------
-- 9. Уборка
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _mig040_lines;
DROP TABLE IF EXISTS _mig040_pc;
DROP TABLE IF EXISTS _mig040_link_vals;
DROP TABLE IF EXISTS _mig040_convert;
DROP TABLE IF EXISTS _mig040_items;
DROP TABLE IF EXISTS _mig040_map;
DROP TABLE IF EXISTS _mig040_lt;
DROP TABLE IF EXISTS _mig040_anchor;
DROP TABLE IF EXISTS _mig040_vars;
