-- Задание обновления сервера (сущность «Задание обновления сервера» 1f39811c,
-- задача 0a27a63b, тех.проект 2d9f5cc7). Прогресс живёт в системной БД, а не в
-- памяти: установщик останавливает службу, и после перезапуска новому процессу
-- нужно прочитать состояние задания. Незавершённое задание после старта
-- переводится в терминальный этап `failed` и автоматически не возобновляется
-- (инвариант сущности), поэтому строка нужна и без живого процесса.
--
-- Этапы (`stage`) — значения сущности: preparing | backing-up | stopping |
-- installing | starting | health-check | done | rolling-back | failed;
-- терминальные — done и failed. Одновременно активно не более одного задания:
-- это обеспечивает не схема (частичный UNIQUE по «не терминальным» SQLite
-- выражает плохо), а синхронная проверка «активное задание + вставка» в
-- `server/src/update/apply.ts` — единственная точка создания задания.
CREATE TABLE IF NOT EXISTS update_jobs (
  id             TEXT PRIMARY KEY,
  target_version TEXT NOT NULL,
  stage          TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  finished_at    TEXT,
  error          TEXT,
  backup_path    TEXT
);

-- Поиск активного задания на каждом apply/progress: строк со временем много,
-- активная — не более одной. Терминальные значения перечислены литералами
-- намеренно: частичный индекс с NOT IN планировщик SQLite не обязан применять.
CREATE INDEX IF NOT EXISTS idx_update_jobs_active
  ON update_jobs (stage, started_at)
  WHERE stage <> 'done' AND stage <> 'failed';

-- Последнее задание для GET /api/v1/system/update/progress.
CREATE INDEX IF NOT EXISTS idx_update_jobs_started
  ON update_jobs (started_at DESC);
