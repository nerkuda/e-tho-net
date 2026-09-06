-- Журнал активности (activity_log) — долговременная история операций
-- изменения сущностей сети (задача f2eca5a4, требование b0c7a57c
-- «activity_log — состав записи», операция 70dfe81d «/activity — лента,
-- свёртка и обрезка»; docs/02-data-model.md §3 — таблицы мыслесети).
--
-- На каждую операцию (создание/правка/удаление/пометка на удаление/
-- восстановление) сервер пишет одну строку с автором — исполнителем
-- операции, `entity_title` — кратким снимком описания сущности на момент
-- события и `occurred_at_ms`. Снимок нужен, чтобы лента оставалась
-- читаемой после удаления самой сущности (требование b0c7a57c).
--
-- В журнал НЕ пишутся:
--   * события захвата (edit.*) — это текущее состояние object_locks;
--   * per-user события real-time (audience=user);
--   * операции чтения.
--
-- **Не ветвится**: состояние «здесь и сейчас» (как и `object_locks` из
-- миграции 034), а не история правок per-layer. Таблица не входит в
-- BRANCHABLE_TABLES, поэтому при merge слоя не пересоздаётся — свёртка/
-- обрезка (rollup/truncate) будут отдельной задачей 6bcccd2b.
-- Поле `layer_id` сохраняется лишь как снимок слоя на момент операции —
-- на запросах ленты не сказывается.

CREATE TABLE activity_log (
  id              TEXT    PRIMARY KEY,
  network_id      TEXT    NOT NULL,
  user_id         TEXT    NOT NULL,        -- исполнитель операции
  action          TEXT    NOT NULL,        -- 'created' | 'updated' | 'deleted'
                                            -- | 'trashed' | 'restored'
  entity_type     TEXT    NOT NULL,        -- 'thought' | 'link' |
                                            -- 'thought_type' | 'link_type' |
                                            -- 'property' | 'comment' |
                                            -- 'attachment' | 'layer'
  entity_id       TEXT    NOT NULL,
  -- Краткий снимок описания сущности на момент события. Лимит 256 — чтобы
  -- строка оставалась узкой; формируется централизованно в
  -- server/src/domain/activity-snapshot.ts.
  entity_title    TEXT    NOT NULL,
  -- Слой на момент операции — снимок, не условие фильтра ленты.
  layer_id        TEXT,
  occurred_at_ms  INTEGER NOT NULL
);

-- Общая лента: «последние N событий сети».
CREATE INDEX idx_activity_log_net_time
  ON activity_log (network_id, occurred_at_ms DESC);

-- Фильтр по пользователю: «что делал конкретный участник».
CREATE INDEX idx_activity_log_user_time
  ON activity_log (network_id, user_id, occurred_at_ms DESC);

-- Фильтр по сущности: «история одной мысли/связи/типа/...».
CREATE INDEX idx_activity_log_entity_time
  ON activity_log (network_id, entity_type, entity_id, occurred_at_ms DESC);

-- Поддержка свёртки/обрезки (задача 6bcccd2b, ещё не реализована).
CREATE INDEX idx_activity_log_net_age
  ON activity_log (network_id, occurred_at_ms);
