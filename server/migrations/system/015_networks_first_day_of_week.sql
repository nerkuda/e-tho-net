-- networks.first_day_of_week: ISO first day of the week for a network
-- (1 = Monday … 7 = Sunday), a network-level setting shared by every calendar
-- widget and by the calendar tokens of filters (`$weekStart`/`$weekEnd`).
-- Requirement «Первый день недели — настройка сети, общая для всех календарных
-- виджетов» (1b77decd, version 0.13.1).
--
-- The value is chosen from the server OS locale when the network is created
-- (see `defaultFirstDayOfWeek()`); existing rows and rows created before the
-- column existed default to Monday (1) — the ISO 8601 convention and the
-- long-standing ETN behaviour (`$week.start` = Monday, task 20b2fca0).
--
-- Idempotency: the migrator records this file in `_migrations` and never
-- re-runs it, so a plain `ALTER TABLE … ADD COLUMN` is sufficient (SQLite has
-- no `ADD COLUMN IF NOT EXISTS`).

ALTER TABLE networks ADD COLUMN first_day_of_week INTEGER NOT NULL DEFAULT 1;
