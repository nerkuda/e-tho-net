-- Authorship columns on editable network entities (task 38ba3498,
-- requirements e6d4165e «колонки авторства» и c6fd9d80 «backfill первым
-- пользователем»; docs/02-data-model.md §3 — таблицы мыслесети).
--
-- У каждой редактируемой сущности сети появляются четыре колонки:
--
--   created_by  TEXT NOT NULL    -- id пользователя, создавшего строку
--   updated_by  TEXT NOT NULL    -- id пользователя, последним изменившего
--   created_at_ms INTEGER NOT NULL  -- Unix-миллисекунды создания
--   updated_at_ms INTEGER NOT NULL  -- Unix-миллисекунды последнего изменения
--
-- Существующие колонки `created_at`/`updated_at` (ISO-8601 TEXT) не трогаются:
-- хранятся для обратной совместимости и для отображения пользователю.
-- Миллисекундные колонки используются для сортировки (требование e6d4165e).
--
-- Backfill (требование c6fd9d80): для существующих строк
-- `created_by = updated_by` = id первого пользователя сервера
-- (`users.is_first_user = 1`, ADR af47a08b «Защищённые сущности»).
-- Миллисекундные даты вычисляются из существующих ISO-колонок
-- `created_at`/`updated_at`; если исходной ISO-даты нет (например,
-- `property_values.created_at` отсутствует, а у `attachments`/`layers`
-- есть только `created_at`) — берётся время миграции.
--
-- id первого пользователя передаётся миграции через SQL-функцию
-- `etn_first_user_id()` (регистрируется в `registerMigrationHelpers`;
-- для тестов и in-memory БД без `_system.db` возвращает пустую строку —
-- миграция подставляет литерал `'system'` как заведомо непустой сентинел).
-- Сама запись `created_by`/`updated_by` в операциях записи — отдельная
-- задача `5ef8b5bb` (этап 2); здесь только схема и backfill.
--
-- Охват таблиц: `thoughts`, `links`, `thought_types`, `link_types`,
-- `properties`, `comments`, `attachments`, `layers`, `property_values`.
-- Для каждой таблицы добавляются ТОЛЬКО отсутствующие колонки —
-- `ALTER TABLE ADD COLUMN` идемпотентен по отсутствию колонки и сразу
-- ставит `NOT NULL DEFAULT`, чтобы новая колонка не нарушала контракт
-- существующих строк до UPDATE.

-- ---------------------------------------------------------------------------
-- 1. thoughts: created_by / updated_by уже есть (025), добавляем *_ms.
-- ---------------------------------------------------------------------------

ALTER TABLE thoughts ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. links: created_by / updated_by уже есть (025), добавляем *_ms.
-- ---------------------------------------------------------------------------

ALTER TABLE links ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. thought_types: created_by есть (025), нет updated_by и *_ms.
-- ---------------------------------------------------------------------------

ALTER TABLE thought_types ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE thought_types ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thought_types ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 4. link_types: created_by есть (025), нет updated_by и *_ms.
-- ---------------------------------------------------------------------------

ALTER TABLE link_types ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE link_types ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link_types ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5. properties (реестр из 032): нет ни авторства, ни *_ms.
-- ---------------------------------------------------------------------------

ALTER TABLE properties ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE properties ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 6. comments: created_by / updated_by уже есть (025), добавляем *_ms.
-- ---------------------------------------------------------------------------

ALTER TABLE comments ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 7. attachments: created_by есть (009), нет updated_by и *_ms;
--    updated_at ISO тоже отсутствует (спека §3.9 хранит только created_at) —
--    updated_at_ms придётся брать из created_at как лучшее приближение.
-- ---------------------------------------------------------------------------

ALTER TABLE attachments ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 8. layers: created_by есть (025), нет updated_by и *_ms; updated_at ISO
--    отсутствует (спека §3.0 хранит только created_at и last_activity_at) —
--    updated_at_ms берётся из created_at как лучшее приближение для бэкфилла.
-- ---------------------------------------------------------------------------

ALTER TABLE layers ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE layers ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE layers ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 9. property_values: updated_at есть (025), created_by/updated_by и *_ms
--    отсутствуют; created_at ISO тоже нет (спека §3.5) — created_at_ms берётся
--    из времени миграции (требование c6fd9d80: «нет — из времени миграции»).
-- ---------------------------------------------------------------------------

ALTER TABLE property_values ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE property_values ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE property_values ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE property_values ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 10. Общие для всех бэкфиллов переменные: id первого пользователя сервера
--     (или сентинел 'system', если первый пользователь не известен — тесты
--     с in-memory БД без `_system.db`) и Unix-миллисекунды момента миграции
--     как fallback для строк без исходной ISO-даты.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _migration_vars;
CREATE TEMP TABLE _migration_vars AS
SELECT
  COALESCE(NULLIF(etn_first_user_id(), ''), 'system') AS author_id,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS migration_ms;

-- ---------------------------------------------------------------------------
-- 11. Бэкфилл.
--
--     Шаблон для ms из ISO (TEXT → INTEGER Unix ms):
--
--       CAST((julianday(SUBSTR(<col>, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
--       + CASE
--           WHEN LENGTH(<col>) >= 24 THEN CAST(SUBSTR(<col>, 21, 3) AS INTEGER)  -- .NNN
--           WHEN LENGTH(<col>) = 23 THEN CAST(SUBSTR(<col>, 21, 2) AS INTEGER) * 10
--           WHEN LENGTH(<col>) = 22 THEN CAST(SUBSTR(<col>, 21, 1) AS INTEGER) * 100
--           ELSE 0
--         END
--
--     SUBSTR(<col>, 1, 19) — «YYYY-MM-DDTHH:MM:SS»; julianday ожидает 'Z'
--     после секунд, дописываем. Фракционная часть (если есть) парсится по
--     длине хвоста: 3 цифры = миллисекунды as-is, 2 цифры × 10, 1 цифра × 100.
--     Покрывает оба формата, которые встречаются в БД: `2026-09-06T07:15:02Z`
--     (strftime из 025) и `2026-09-06T07:15:02.251Z` (new Date().toISOString()).
--
--     COALESCE(<iso_ms>, migration_ms) — fallback на время миграции, когда
--     исходная ISO-колонка отсутствует (NULL по природе схемы или NULL после
--     ручной правки).
-- ---------------------------------------------------------------------------

-- 11.1. thoughts (created_by/updated_by уже заполнены в 025, но требование
--       предписывает перезаписать на первого пользователя — старые значения
--       остаются в истории, но для backfill мы используем единый источник).
UPDATE thoughts SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(updated_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(updated_at) >= 24 THEN CAST(SUBSTR(updated_at, 21, 3) AS INTEGER)
        WHEN LENGTH(updated_at) = 23 THEN CAST(SUBSTR(updated_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(updated_at) = 22 THEN CAST(SUBSTR(updated_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.2. links (created_by/updated_by уже заполнены в 025, перезаписываем).
UPDATE links SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(updated_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(updated_at) >= 24 THEN CAST(SUBSTR(updated_at, 21, 3) AS INTEGER)
        WHEN LENGTH(updated_at) = 23 THEN CAST(SUBSTR(updated_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(updated_at) = 22 THEN CAST(SUBSTR(updated_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.3. thought_types (created_by заполняется в 025 при первом INSERT,
--       updated_by отсутствовал — теперь подставляется тот же author_id).
UPDATE thought_types SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(updated_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(updated_at) >= 24 THEN CAST(SUBSTR(updated_at, 21, 3) AS INTEGER)
        WHEN LENGTH(updated_at) = 23 THEN CAST(SUBSTR(updated_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(updated_at) = 22 THEN CAST(SUBSTR(updated_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.4. link_types (аналогично thought_types).
UPDATE link_types SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(updated_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(updated_at) >= 24 THEN CAST(SUBSTR(updated_at, 21, 3) AS INTEGER)
        WHEN LENGTH(updated_at) = 23 THEN CAST(SUBSTR(updated_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(updated_at) = 22 THEN CAST(SUBSTR(updated_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.5. properties (реестр из 032, created_at/updated_at ISO заполняются при
--       INSERT текущим временем; created_by и *_ms добавляются этой миграцией).
UPDATE properties SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(updated_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(updated_at) >= 24 THEN CAST(SUBSTR(updated_at, 21, 3) AS INTEGER)
        WHEN LENGTH(updated_at) = 23 THEN CAST(SUBSTR(updated_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(updated_at) = 22 THEN CAST(SUBSTR(updated_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.6. comments (created_by/updated_by заполнены в 025, перезаписываем).
UPDATE comments SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(updated_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(updated_at) >= 24 THEN CAST(SUBSTR(updated_at, 21, 3) AS INTEGER)
        WHEN LENGTH(updated_at) = 23 THEN CAST(SUBSTR(updated_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(updated_at) = 22 THEN CAST(SUBSTR(updated_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.7. attachments: created_by есть, updated_at ISO отсутствует — для
--       updated_at_ms используем created_at как лучшее имеющееся приближение.
UPDATE attachments SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.8. layers: created_by есть, updated_at ISO отсутствует — updated_at_ms
--       берём из created_at (приближение; см. комментарий к attachments).
UPDATE layers SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  ),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(created_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(created_at) >= 24 THEN CAST(SUBSTR(created_at, 21, 3) AS INTEGER)
        WHEN LENGTH(created_at) = 23 THEN CAST(SUBSTR(created_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(created_at) = 22 THEN CAST(SUBSTR(created_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- 11.9. property_values: created_at ISO отсутствует — created_at_ms берётся
--       из времени миграции (требование c6fd9d80: «нет — из времени миграции»);
--       updated_at_ms — из существующего updated_at.
UPDATE property_values SET
  created_by = (SELECT author_id FROM _migration_vars),
  updated_by = (SELECT author_id FROM _migration_vars),
  created_at_ms = (SELECT migration_ms FROM _migration_vars),
  updated_at_ms = COALESCE(
    CAST((julianday(SUBSTR(updated_at, 1, 19) || 'Z') - 2440587.5) * 86400000 AS INTEGER)
    + CASE
        WHEN LENGTH(updated_at) >= 24 THEN CAST(SUBSTR(updated_at, 21, 3) AS INTEGER)
        WHEN LENGTH(updated_at) = 23 THEN CAST(SUBSTR(updated_at, 21, 2) AS INTEGER) * 10
        WHEN LENGTH(updated_at) = 22 THEN CAST(SUBSTR(updated_at, 21, 1) AS INTEGER) * 100
        ELSE 0
      END,
    (SELECT migration_ms FROM _migration_vars)
  );

-- ---------------------------------------------------------------------------
-- 12. Чистка временной таблицы (TEMP живёт до конца соединения, но
--     гигиена и явность не повредят: следующая миграция начинается с чистого
--     состояния).
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS _migration_vars;
