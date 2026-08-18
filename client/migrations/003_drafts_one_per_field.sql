-- 003: один черновик на (профиль, сеть, тип сущности, сущность, поле).
--
-- До этой миграции каждый тик debounce-сохранения черновика генерировал
-- новый id — строки накапливались, а восстановление брало самую старую из
-- них и затирало свежий текст поля (у пользователя пропадала, например,
-- запятая в заголовке сразу после сохранения).

-- 1. Оставить по одной, самой свежей строке на ключ.
DELETE FROM drafts
WHERE rowid NOT IN (
  SELECT MAX(rowid)
  FROM drafts
  GROUP BY profile_id, network_id, entity_type, entity_id, field
);

-- 2. Уникальность ключа: upsert черновика идёт по полю, а не по случайному id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_one_per_field
  ON drafts (profile_id, network_id, entity_type, entity_id, field);
