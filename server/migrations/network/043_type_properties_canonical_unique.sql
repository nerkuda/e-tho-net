-- 043: канонический вид `type_properties` — табличный UNIQUE без `side`
-- (версия 0.8.2; ошибка e7dfb36a-406c-4f0f-9abb-b90518f103e9 «Привязка свойства
-- к типу падает с 500: UNIQUE-ключ type_properties расходится с кодом»).
--
-- СИМПТОМ. На сети, чья база мигрировала ранней (dev) сборкой 0.8.1, привязка
-- свойства к типу (`POST /networks/{id}/thought-types/{typeId}/properties`,
-- MCP `etn.ontology.write`) падает с 500 «Внутренняя ошибка сервера». В логе:
--   SQLITE_ERROR: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
--   constraint
--
-- КОРЕНЬ. `createTypeProperty` (server/src/domain/property-service.ts) пишет
-- привязку через
--   INSERT INTO type_properties (…) VALUES (…)
--   ON CONFLICT (owner_type, owner_id, property_id, layer_id) DO UPDATE SET …
-- Цель `ON CONFLICT` обязана совпадать с существующим PRIMARY KEY/UNIQUE
-- ограничением таблицы. Ранняя редакция миграции 041 пересобирала таблицу с
-- пятиколоночным ключом
--   UNIQUE (owner_type, owner_id, property_id, side, layer_id)
-- а сам файл 041 к тому моменту уже лежал в `_migrations` как применённый.
-- Позже файл 041 изменён на `ALTER TABLE … ADD COLUMN side` — но к базам,
-- записавшим старую редакцию, этот ALTER больше не применяется: их схема
-- осталась с пятиколоночным ключом навсегда. Четырёхколоночного ограничения в
-- такой таблице нет, цель `ON CONFLICT` ни с чем не совпадает — SQLite бросает
-- SQLITE_ERROR (не EtnError), обработчик отдаёт 500.
--
-- Канонический вид (то, что даёт свежая сборка — миграции 032/041/042):
--   UNIQUE (id, layer_id)
--   UNIQUE (owner_type, owner_id, property_id, layer_id)
--   side TEXT CHECK (side IS NULL OR side IN ('source', 'target'))
--   CREATE UNIQUE INDEX idx_type_properties_owner_property_layer_side
--     ON type_properties (owner_type, owner_id, property_id, side, layer_id)
--     WHERE side IS NOT NULL
--
-- ЧТО ДЕЛАЕТ МИГРАЦИЯ (одним файлом = одной транзакцией мигратора, по каждой
-- сети инстанса): пересобирает `type_properties` в канонический вид —
-- создаёт таблицу заново, переносит строки, роняет старую, переименовывает
-- новую и пересоздаёт индексы. Схема сети снова совпадает со свежей сборкой,
-- `ON CONFLICT` в `createTypeProperty` начинает совпадать с ограничением.
--
-- ДЕДУПЛИКАЦИЯ ОБЯЗАТЕЛЬНА. Пятиколоночный ключ допускал в одном слое ДВЕ
-- строки одной тройки (owner_type, owner_id, property_id) — с разными `side`
-- (`UNIQUE` в SQLite считает NULL-ы различными, поэтому строк с `side IS NULL`
-- могло быть и больше двух). Четырёхколоночный ключ такую пару запрещает,
-- поэтому при переносе на каждую четвёрку (owner_type, owner_id, property_id,
-- layer_id) остаётся ровно одна строка. Правило выбора — как у миграции 042
-- «source покрывает оба направления» (042 отбрасывает target-привязку
-- проигравшего, если у победителя уже есть source-привязка на тот же тип):
--   1) `side = 'source'` — привязка источника покрывает оба направления ребра,
--      поэтому она информативнее target-строки;
--   2) иначе `side = 'target'`;
--   3) иначе (`side IS NULL` — скаляры и структурные свойства) — минимальный
--      `pk`, то есть самая ранняя по порядку создания строка.
-- Правило детерминировано (не зависит от порядка сканирования) и сохраняет
-- каждую тройку: теряется только дублирующая строка, которую новый ключ
-- запрещает в любом случае. На каноничной базе дублей нет по определению
-- четырёхколоночного ключа — шаг дедупликации там ничего не отбрасывает.
--
-- ИДЕМПОТЕНТНОСТЬ. Условного DDL в SQLite нет: файл всегда пересобирает
-- таблицу. Повторный прогон безопасен и, если база уже канонична, ничего НЕ
-- МЕНЯЕТ по существу: строки переносятся 1:1 вместе с `pk`, набор колонок,
-- ограничения и индексы остаются каноническими (пересборка воспроизводит ту же
-- схему, что создаёт свежая сборка). Мигратор файл не перезапускает — запись в
-- `_migrations` (см. docs/02-data-model.md §5) гарантирует однократное
-- применение; дедупликация делает прямое переисполнение оператора no-op-ом.
--
-- СЛОИ. Переносятся ВСЕ строки всех слоёв — и живые, и теневые копии, и
-- надгробия (`deleted = 1`): пересборка схемы не должна менять видимость
-- цепочек. Дедупликация работает внутри одной четвёрки (owner_type, owner_id,
-- property_id, layer_id), то есть в пределах одного слоя, и не схлопывает
-- теневые копии разных слоёв между собой. `pk` сохраняется — физический rowid
-- строки остаётся прежним (на него завязаны temp-представления `*_v` и
-- `sqlite_sequence` таблицы).
--
-- Ссылок на `type_properties` по SQL-FK в схеме нет (проверено: на таблицу
-- ссылается только её собственный `layer_id → layers.id`), поэтому
-- `DROP TABLE` под `foreign_keys = ON` ничего не сносит каскадом. На боевом
-- пути пересборка идёт ДО создания представлений слоёв (db/network-db.ts:
-- runMigrations → setupLayerContext); если файл исполняется на уже открытом
-- соединении (повторный прогон), подмену прикрывает `PRAGMA
-- legacy_alter_table` из шага 3 — см. пояснение там.
--
-- НЕОБРАТИМО: отката нет (таблица пересобирается, дубли-строки отбрасываются).
-- Перед обновлением рекомендуется резервная копия data.db сети
-- (docs/install-server.md, CHANGELOG).

-- ---------------------------------------------------------------------------
-- 1. Новая таблица в каноническом виде. Колонки и ограничения — ровно те,
--    что у свежей сборки: четырёхколоночный UNIQUE (цель `ON CONFLICT` в
--    createTypeProperty), UNIQUE (id, layer_id), CHECK на `side`.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS type_properties_new;
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
  side         TEXT CHECK (side IS NULL OR side IN ('source', 'target')),
  UNIQUE (id, layer_id),
  UNIQUE (owner_type, owner_id, property_id, layer_id)
);

-- ---------------------------------------------------------------------------
-- 2. Перенос строк с дедупликацией по четвёрке (owner_type, owner_id,
--    property_id, layer_id). Победитель группы: `side='source'`, иначе
--    `side='target'`, иначе минимальный `pk` (см. шапку). Все прочие колонки,
--    включая `pk`, переносятся без изменений; INSERT заодно служит проверкой —
--    нарушение нового ключа, `UNIQUE (id, layer_id)`, CHECK или FK на `layers`
--    уронило бы миграцию целиком (одна транзакция).
-- ---------------------------------------------------------------------------

INSERT INTO type_properties_new (pk, id, layer_id, deleted, base_version,
                                 owner_type, owner_id, property_id, required, position, side)
SELECT tp.pk, tp.id, tp.layer_id, tp.deleted, tp.base_version,
       tp.owner_type, tp.owner_id, tp.property_id, tp.required, tp.position, tp.side
  FROM type_properties AS tp
 WHERE tp.pk = (
         SELECT c.pk
           FROM type_properties AS c
          WHERE c.owner_type  = tp.owner_type
            AND c.owner_id    = tp.owner_id
            AND c.property_id = tp.property_id
            AND c.layer_id    = tp.layer_id
          ORDER BY CASE c.side
                     WHEN 'source' THEN 0
                     WHEN 'target' THEN 1
                     ELSE 2
                   END,
                   c.pk
          LIMIT 1
       );

-- ---------------------------------------------------------------------------
-- 3. Подмена: старая таблица (вместе со своими индексами и старым
--    ограничением) уходит, новая получает каноническое имя.
--
--    `PRAGMA legacy_alter_table = ON` — только на время подмены. По умолчанию
--    (OFF) `ALTER TABLE … RENAME` переразбирает определения всех представлений
--    и триггеров схемы, чтобы переписать в них старое имя таблицы; temp-
--    представление `type_properties_v` в этот момент ссылается на уже
--    удалённую таблицу, и переразбор падает с
--      error in view type_properties_v: no such table: main.type_properties.
--    В режиме legacy перезапись ссылок не делается — а нам она и не нужна:
--    переименовывается свежесозданная `type_properties_new`, на неё никто не
--    ссылается, а представления ссылаются на каноническое имя
--    `type_properties`, которое подмена возвращает на место. На боевом пути
--    пересборка идёт ДО создания представлений (db/network-db.ts:
--    runMigrations → setupLayerContext), поэтому там прагма ничего не меняет;
--    включена она ради повторного/прямого прогона файла на уже открытом
--    соединении (идемпотентность).
-- ---------------------------------------------------------------------------

PRAGMA legacy_alter_table = ON;

DROP TABLE type_properties;
ALTER TABLE type_properties_new RENAME TO type_properties;

PRAGMA legacy_alter_table = OFF;

-- ---------------------------------------------------------------------------
-- 4. Индексы канонического набора: три обычных (их создавали 005/025/032) и
--    частичный UNIQUE по стороне (042). Колонки — как у свежей сборки.
-- ---------------------------------------------------------------------------

CREATE INDEX idx_type_properties_owner
  ON type_properties (owner_type, owner_id, position);
CREATE INDEX idx_type_properties_layer ON type_properties (layer_id);
CREATE INDEX idx_type_properties_property ON type_properties (property_id);
CREATE UNIQUE INDEX idx_type_properties_owner_property_layer_side
  ON type_properties (owner_type, owner_id, property_id, side, layer_id)
  WHERE side IS NOT NULL;
