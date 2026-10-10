-- 050: общий каталог вложений — владения выносятся в отдельную таблицу
-- (0.12.1, задача 369241e4; тех.проект «Общие вложения» f9b8917c;
-- ADR «мульти-владение вложениями через таблицу attachment_owners» 9f90b010;
-- сущности `attachments` 19dd0b5d и `attachment_owners` 2868dac0;
-- спека слоёв 13-layers.md §3, прецедент переезда таблицы — 025_layers.sql).
--
-- Что делает эта миграция (ПЕРВЫЙ шаг тех.проекта):
--
--   1. Заводит ВЕТВИМУЮ таблицу `attachment_owners` — одна строка = одно
--      владение парой (вложение, объект). Общий шаблон ветвимой таблицы
--      (025): суррогатный `pk`, пара `(id, layer_id)` c UNIQUE, `deleted`
--      (надгробие) и `base_version`, `layer_id → layers(id) ON DELETE CASCADE`.
--      Уникальность владения — (attachment_id, owner_type, owner_id, layer_id);
--      индексы по слою, по (owner_type, owner_id) и по attachment_id.
--   2. Добавляет `attachments.content_hash` (TEXT, SHA-256 hex, nullable) и
--      best-effort заполняет его существующим ФАЙЛОВЫМ вложениям по
--      фактическому файлу (SQL-функция `etn_file_sha256`; путь не читается —
--      остаётся NULL). По хэшу пойдёт дедупликация загрузки (ADR e3a35864).
--   3. Переносит прежних владельцев из `attachments.owner_type/owner_id`
--      в `attachment_owners` — по одной строке владения на строку вложения,
--      `position` — прежний `attachments.position`. Копирование идёт в ТОМ ЖЕ
--      слое и с тем же надгробием, что у строки вложения: владение ветвится
--      ровно там, где раньше ветвилась сама строка (паритет слоевых
--      снапшотов). `owner_type ∈ thought|link|publication` переносится как есть
--      (уточнение аудита K1 — владения связей в том числе).
--   4. ОБЪЁМ (решение задачи, вариант «а»). Колонки `attachments.owner_type`/
--      `owner_id` на этом шаге НЕ снимаются: код 0.12.1 ещё читает и пишет их,
--      а снятие owner-колонок и перевод домена на `attachment_owners` — задача
--      домена 7678876a (финальная миграция). Это держит задачу миграции
--      атомарной и репозиторий зелёным: существующие запросы продолжают
--      работать, новая таблица наполняется параллельно и станет источником
--      истины на следующем шаге.
--
-- Мигратор не повторяет файл, поэтому обычные CREATE/INSERT без IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- 1. attachment_owners — ветвимая таблица владений
-- ---------------------------------------------------------------------------

CREATE TABLE attachment_owners (
  pk            INTEGER PRIMARY KEY AUTOINCREMENT, -- суррогат
  id            TEXT NOT NULL DEFAULT (gen_uuid()),-- логический UUID владения
  layer_id      TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-0000000000ba5e'
                REFERENCES layers (id) ON DELETE CASCADE,
  deleted       INTEGER NOT NULL DEFAULT 0,        -- надгробие (§5.2)
  base_version  INTEGER NOT NULL DEFAULT 0,        -- версия предка при материализации; 0 в основе
  attachment_id TEXT NOT NULL,                     -- логический id вложения; SQL-FK снят (id не уникален)
  owner_type    TEXT NOT NULL,                     -- 'thought' | 'link' | 'publication'
  owner_id      TEXT NOT NULL,                     -- логический id объекта-владельца
  position      INTEGER NOT NULL DEFAULT 0,        -- порядок вложения В СПИСКЕ ВЛАДЕЛЬЦА
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  UNIQUE (id, layer_id),
  UNIQUE (attachment_id, owner_type, owner_id, layer_id) -- одно владение на пару в пределах слоя
);

CREATE INDEX idx_attachment_owners_owner
  ON attachment_owners (owner_type, owner_id);
CREATE INDEX idx_attachment_owners_attachment
  ON attachment_owners (attachment_id);
CREATE INDEX idx_attachment_owners_layer ON attachment_owners (layer_id);

-- ---------------------------------------------------------------------------
-- 2. attachments.content_hash — SHA-256 содержимого файла (best-effort)
-- ---------------------------------------------------------------------------

ALTER TABLE attachments ADD COLUMN content_hash TEXT;

-- Best-effort: функция читает файл с диска сервера и возвращает sha256-hex,
-- либо NULL, если файл недоступен (клиентский локальный путь, отсутствующий
-- файл). Ошибка чтения одного файла не роняет миграцию — строка остаётся NULL.
UPDATE attachments
   SET content_hash = etn_file_sha256(file_path)
 WHERE kind = 'file' AND file_path IS NOT NULL;

CREATE INDEX idx_attachments_content_hash
  ON attachments (content_hash) WHERE content_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Перенос владений: по строке владения на каждую строку вложения,
--    в том же слое и с тем же надгробием (паритет слоевых снапшотов)
-- ---------------------------------------------------------------------------

INSERT INTO attachment_owners
  (id, layer_id, deleted, base_version, attachment_id, owner_type, owner_id,
   position, created_at, created_by)
SELECT gen_uuid(), layer_id, deleted, base_version, id, owner_type, owner_id,
       position, created_at, created_by
FROM attachments;
