-- 054_reminders.sql — напоминания (0.16.1, задача b47f1fd2; сущность
-- 62e6787b, ADR 03e429ed).
--
-- `reminders` — сервисная per-user таблица напоминаний сети. НЕ ветвится по
-- слоям (закрытый список неветвимых таблиц спеки слоёв b80cba23): напоминание
-- видно владельцу в любом слое, поэтому `layer_id`/`deleted`/`base_version`
-- здесь нет, как у `user_preferences`/`saved_filters`.
--
-- Серия вхождений считается чисто из `schedule` + `anchor_at` (закрытая
-- грамматика повтора bbca8f7d); `next_at` — первое необработанное вхождение
-- (ленивое продвижение от `anchor_at`); `exceptions` — карта UTC-момент
-- вхождения → { kind: snooze, until } | { kind: dismiss } (управление
-- вхождением 86cb7451). Строка `state='removed'` — удаление владельцем,
-- в выдачи не попадает.

CREATE TABLE IF NOT EXISTS reminders (
  id           TEXT PRIMARY KEY,                                  -- UUID
  user_id      TEXT NOT NULL,                                     -- владелец (per-user)
  subject_type TEXT NOT NULL                                      -- цель напоминания
               CHECK (subject_type IN ('thought', 'publication')),
  subject_id   TEXT NOT NULL,
  kind         TEXT NOT NULL                                      -- один раз / период / правило
               CHECK (kind IN ('one', 'period', 'rule')),
  schedule     TEXT NOT NULL,                                     -- JSON: закрытая грамматика повтора
  anchor_at    TEXT NOT NULL,                                     -- ISO-8601 UTC: опорное вхождение (время суток наследуют все вхождения)
  next_at      TEXT,                                              -- ISO-8601 UTC: первое необработанное вхождение; NULL — вхождений нет
  exceptions   TEXT NOT NULL DEFAULT '{}',                        -- JSON-карта: момент вхождения → snooze{until} | dismiss
  state        TEXT NOT NULL DEFAULT 'active'                     -- active | removed
               CHECK (state IN ('active', 'removed')),
  created_at   TEXT NOT NULL,                                     -- ISO-8601 UTC
  updated_at   TEXT NOT NULL                                      -- ISO-8601 UTC
);

-- Основной отбор: напоминания владельца по близости срабатывания.
CREATE INDEX IF NOT EXISTS idx_reminders_user_next
  ON reminders (user_id, next_at);

-- Обратный отбор: напоминания субъекта (флаг в карточке, индикатор в облачке).
CREATE INDEX IF NOT EXISTS idx_reminders_subject
  ON reminders (subject_type, subject_id);
