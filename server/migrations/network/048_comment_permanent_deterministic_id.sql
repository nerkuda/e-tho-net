-- 048: постоянный комментарий — детерминированные id от natural key
-- (ошибка 086cb735-9acf-4b60-8d0f-0a0601989ef3 «Легаси-дубли постоянных
-- комментариев владельца не сводятся детерминированным id — нужна миграция
-- нормализации», версия 0.12.1; write-side фикс — 46b93145, коммит dff9ed4f;
-- прецедент — миграция 036 для `property_values`, ошибка dc119240).
--
-- КОРЕНЬ. Логическая идентичность постоянного комментария — его владелец
-- `(owner_type, owner_id)`, а не суррогатный `id`. Представления слоёв `*_v`
-- (db/layer-chain.ts) дедуплицируют «ближайший слой побеждает» ПО `id`,
-- поэтому у одного владельца могли возникнуть ДВА постоянных комментария с
-- РАЗНЫМИ случайными id — по одному физическому ряду в не видящих друг друга
-- слоях цепочки (дочерний слой, затем основа). Частичный уникальный индекс
-- `idx_comments_permanent_one (owner_type, owner_id, layer_id) WHERE
-- kind='permanent'` и проверка дубля в `createCommentWithTargets` действуют
-- лишь В ПРЕДЕЛАХ одного слоя — кросс-слойной уникальности не было. В
-- контексте, где видны оба ряда, `comments_v` (и `listComments`) отдают ДВА
-- постоянных комментария владельца.
--
-- Write-side фикс 46b93145 закрыл первопричину только для НОВЫХ записей: id
-- выводится детерминированно из natural key (`db/comment-permanent-id.ts`,
-- UUIDv5(namespace, `${owner_type}:${owner_id}`)), независимые «первые записи»
-- разных слоёв сходятся в один id. Уже разошедшиеся ряды он не сводит — эта
-- миграция нормализует накопленные легаси-данные.
--
-- РЕШЕНИЕ. `id` каждого физического ряда `kind='permanent'` приводится к
-- `etn_comment_permanent_id(owner_type, owner_id)` — SQL-помощнику,
-- зарегистрированному в `registerMigrationHelpers` (db/network-db.ts) поверх
-- ТОГО ЖЕ TypeScript-кода, что пишет домен (`permanentCommentId`): миграция и
-- рантайм не могут разойтись в вычисленном id. После сведения два легаси-ряда
-- владельца получают ОДИН логический id в разных слоях (UNIQUE (id, layer_id)
-- нарушен быть не может — в пределах слоя постоянный комментарий владельца
-- уже един по `idx_comments_permanent_one`), и вся по-id инфраструктура
-- (`comments_v`, `getPermanentRow`, copy-on-write `materializeShadow`)
-- корректна без правки потребителей: «ближайший слой побеждает» отдаёт ровно
-- один видимый постоянный комментарий на контекст.
--
-- ССЫЛКИ НА `comments.id` ПЕРЕПИСЫВАЮТСЯ СИНХРОННО. Их в схеме ровно две
-- (проверено по каталогу миграций и `server/src`):
--   * `comment_targets.comment_id` — m2m-привязка комментария к владельцам
--     (миграция 019/025). Уникальность `UNIQUE (comment_id, owner_type,
--     owner_id, layer_id)` соблюдается: в одном слое целевой ряд владельца
--     один (постоянный комментарий владельца в слое един). На всякий случай
--     UPDATE снабжён защитой от коллизии.
--   * `activity_log.entity_id` — журнал ссылается на id комментария снимком
--     (миграция 035, `entity_type='comment'`). Без переписывания исторические
--     записи осиротели бы; уникальных ограничений на `entity_id` нет.
-- Вложений у комментариев нет (таблица `attachments` вешается только на
-- мысли/связи, owner_type='thought'|'link'); отдельных таблиц комментариев в
-- схеме нет. FTS-триггеры (`trg_comments_*_fts`) ключуются физическим `pk`,
-- а не `id`, и переживают UPDATE без потери связи.
--
-- СТРАТЕГИЯ КОНФЛИКТОВ. `etn_comment_permanent_id` — UUIDv5 от natural key, а
-- id уникален в пределах слоя, поэтому штатно коллизия невозможна. Но если
-- детерминированный id в ТОМ ЖЕ слое уже занят другой строкой (испорченные
-- данные: например, хронологический комментарий со случайно совпавшим id),
-- миграция НЕ падает и НЕ трогает такой логический ряд (ни сам комментарий,
-- ни его `comment_targets`/`activity_log`) — иначе нарушилось бы
-- `UNIQUE (id, layer_id)` и транзакция откатилась бы целиком. О конфликте
-- сообщает `etn_migration_warn` (пишет в `MigrationHelpersContext.warn`, т.е.
-- в лог сервера при старте сети). Ряд остаётся как есть — нормализация
-- безопасна и может быть повторена после ручного разбора данных.
--
-- ИДЕМПОТЕНТНОСТЬ. Отбор идёт по `id != det`, поэтому прямое переисполнение
-- файла — no-op: карта переименования пуста, ни один UPDATE не меняет строк.
-- На чистой БД постоянных комментариев нет — миграция ничего не делает.
-- Схема не меняется (детерминированный id — это данные, не DDL).
--
-- ОДНА ТРАНЗАКЦИЯ. Файл целиком исполняется мигратором внутри одной
-- транзакции (db/migrator.ts); временная карта `_perm_comment_id_map` живёт
-- на соединении только на время прогона и удаляется в конце.

-- ---------------------------------------------------------------------------
-- 1. Предупреждения о строках, которые будут оставлены из-за конфликта id.
--    Считается ДО переименования, по исходному состоянию.
-- ---------------------------------------------------------------------------

SELECT etn_migration_warn(
         '048: постоянный комментарий ' || c.id ||
         ' (owner ' || c.owner_type || ':' || c.owner_id ||
         ', слой ' || c.layer_id || ') оставлен без нормализации: ' ||
         'детерминированный id ' || etn_comment_permanent_id(c.owner_type, c.owner_id) ||
         ' уже занят в этом слое другой строкой'
       )
  FROM comments c
 WHERE c.kind = 'permanent'
   AND c.id != etn_comment_permanent_id(c.owner_type, c.owner_id)
   AND EXISTS (
         SELECT 1 FROM comments y
          WHERE y.id = etn_comment_permanent_id(c.owner_type, c.owner_id)
            AND y.layer_id = c.layer_id
            AND y.pk != c.pk
       );

-- ---------------------------------------------------------------------------
-- 2. Карта переименования: логический старый id → детерминированный новый.
--    Логический id, у которого ХОТЬ ОДНА физическая копия конфликтует,
--    исключается целиком — чтобы тень/надгробие в другом слое не разошлись по
--    id со своим живым рядом. Владелец у всех копий одного id один, поэтому
--    новый id в группе тоже один.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _perm_comment_id_map;

CREATE TEMP TABLE _perm_comment_id_map AS
SELECT c.id AS old_id,
       etn_comment_permanent_id(c.owner_type, c.owner_id) AS new_id
  FROM comments c
 WHERE c.kind = 'permanent'
   AND c.id != etn_comment_permanent_id(c.owner_type, c.owner_id)
   AND NOT EXISTS (
         SELECT 1 FROM comments x
          WHERE x.kind = 'permanent'
            AND x.id = c.id
            AND EXISTS (
                  SELECT 1 FROM comments y
                   WHERE y.id = etn_comment_permanent_id(x.owner_type, x.owner_id)
                     AND y.layer_id = x.layer_id
                     AND y.pk != x.pk
                )
       )
 GROUP BY c.id;

-- ---------------------------------------------------------------------------
-- 3. Переименование самих комментариев (все слои: живые ряды, теневые копии и
--    надгробия). `pk IN (…)` фиксирует набор до изменения, `WHERE id IN
--    (карта)` ограничивает нормализуемыми логическими id. UPDATE `id` —
--    обычная колонка вне PRIMARY KEY (суррогат — `pk`), UNIQUE (id, layer_id)
--    и `idx_comments_permanent_one` не нарушаются.
-- ---------------------------------------------------------------------------

UPDATE comments
   SET id = (
         SELECT m.new_id FROM _perm_comment_id_map m WHERE m.old_id = comments.id
       )
 WHERE pk IN (
         SELECT c.pk FROM comments c
          WHERE c.kind = 'permanent'
            AND c.id IN (SELECT old_id FROM _perm_comment_id_map)
       );

-- ---------------------------------------------------------------------------
-- 4. Привязки `comment_targets` — синхронно к новому логическому id. Защита от
--    коллизии UNIQUE (comment_id, owner_type, owner_id, layer_id): ряд, чей
--    новый ключ уже занят другим рядом того же слоя, оставляется и озвучивается
--    предупреждением (штатно такого быть не может — постоянный комментарий
--    владельца в слое един).
-- ---------------------------------------------------------------------------

SELECT etn_migration_warn(
         '048: привязка комментария ' || t.comment_id || ' (owner ' || t.owner_type || ':' ||
         t.owner_id || ', слой ' || t.layer_id || ') оставлена: целевой id ' || m.new_id ||
         ' уже занят другой привязкой в этом слое'
       )
  FROM comment_targets t
  JOIN _perm_comment_id_map m ON m.old_id = t.comment_id
 WHERE EXISTS (
       SELECT 1 FROM comment_targets x
        WHERE x.comment_id = m.new_id
          AND x.owner_type = t.owner_type
          AND x.owner_id = t.owner_id
          AND x.layer_id = t.layer_id
          AND x.pk != t.pk
     );

UPDATE comment_targets
   SET comment_id = (
         SELECT m.new_id FROM _perm_comment_id_map m WHERE m.old_id = comment_targets.comment_id
       )
 WHERE pk IN (
         SELECT t.pk
           FROM comment_targets t
           JOIN _perm_comment_id_map m ON m.old_id = t.comment_id
          WHERE NOT EXISTS (
                SELECT 1 FROM comment_targets x
                 WHERE x.comment_id = m.new_id
                   AND x.owner_type = t.owner_type
                   AND x.owner_id = t.owner_id
                   AND x.layer_id = t.layer_id
                   AND x.pk != t.pk
              )
       );

-- ---------------------------------------------------------------------------
-- 5. Журнал активности — исторические записи о комментариях (`entity_type =
--    'comment'`) указывают на логический id; переписываем, чтобы история не
--    осиротела. Журнал не ветвится (единая таблица), уникальных ограничений на
--    `entity_id` нет.
-- ---------------------------------------------------------------------------

UPDATE activity_log
   SET entity_id = (
         SELECT m.new_id FROM _perm_comment_id_map m WHERE m.old_id = activity_log.entity_id
       )
 WHERE entity_type = 'comment'
   AND entity_id IN (SELECT old_id FROM _perm_comment_id_map);

-- ---------------------------------------------------------------------------
-- 6. Уборка временной карты (соединение может быть долгоживущим).
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _perm_comment_id_map;
