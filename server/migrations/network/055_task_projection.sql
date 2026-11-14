-- 055_task_projection.sql - материализованная проекция задач (0.16.1,
-- задача 632eca85; ADR d0c07f33, сущность `tasks` 46e00dde).
--
-- Задача - строка `- [ ]` в body_md комментария (хроно-записи ИЛИ постоянного);
-- текст - источник истины, а эти таблицы - пере-создаваемая парсером
-- (@etn/markdown, parseTaskLines) проекция. Ручные правки запрещены: строки
-- пере-создаются при записи комментария и событиях слоёв.
--
-- По слоям таблицы НЕ ветвятся (нет `deleted`/`base_version`/суррогатного
-- `pk`, адресующего логический id): слой - атрибут СТРОКИ (`layer_id`), потому
-- что строка проекции существует только вместе с конкретной редакцией
-- комментария. `layer_id = NULL` - основа. Закрытый список неветвимых таблиц
-- спецификации слоёв (b80cba23) дополнен этой записью.
--
-- `line_no` - номер строки body_md С НУЛЯ (операция de4cee18: адресация
-- comment_id + line_no), строка СОДЕРЖИМОГО пункта (там стоит маркер).
-- Дедуп строк - (comment_id, layer_id, line_no): парсер может вернуть
-- несколько строк с одним line_no (таблица с двумя date-ссылками в одной
-- строке), задача одна - первая.
--
-- `task_row_dates` - ВСЕ date-ссылки строки, включая не-задачные (потребители
-- «Связи дня», календарь), поэтому строка на каждую дату.
-- `task_row_subjects` - резолвы ID-ссылок `[[#uuid]]` строки (legacy-имена не
-- собираются, решение 2026-11-14); индекс по мысли - панель «Задачи» редактора.
--
-- `task_projection_state` - глобальный маркер актуальности сети: максимум
-- ревизии комментариев, из которых построена проекция. Клиент сравнивает его
-- со своим и показывает «Обновить». Строка одна (id = 1).

CREATE TABLE IF NOT EXISTS task_rows (
  comment_id      TEXT NOT NULL,                 -- комментарий-источник строки
  layer_id        TEXT REFERENCES layers (id) ON DELETE CASCADE, -- NULL = основа
  line_no         INTEGER NOT NULL,              -- номер строки body_md с нуля
  is_task         INTEGER NOT NULL DEFAULT 0,    -- задача (не подстрока чек-листа)
  text            TEXT NOT NULL,                 -- снапшот строки без маркера
  period_from     TEXT,                          -- первая date-ссылка (YYYY-MM-DD)
  period_to       TEXT,                          -- последняя date-ссылка
  due             TEXT,                          -- срок = последняя date-ссылка
  done            INTEGER NOT NULL DEFAULT 0,    -- состояние чекбокса
  depth           INTEGER NOT NULL DEFAULT 0,    -- уровень вложенности списка
  parent_line_no  INTEGER,                       -- ближайшая задача-родитель (line_no)
  subtask         INTEGER NOT NULL DEFAULT 0,    -- подстрока без даты при родителе
  parsed_revision INTEGER NOT NULL DEFAULT 0     -- ревизия комментария при разборе
);

-- Ключ строки: парсер может вернуть несколько строк с одним line_no
-- (не-задачная строка с двумя date-ссылками) - задача одна, дедуп здесь.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_rows_key
  ON task_rows (comment_id, COALESCE(layer_id, ''), line_no);

-- Порядок выдачи GET /tasks: due -> period_from -> id (keyset, 3f2fdc41).
CREATE INDEX IF NOT EXISTS idx_task_rows_order
  ON task_rows (due, period_from, comment_id, line_no);

-- Связка «родитель-задача ↔ подстроки» (массовая отмена с подзадачами).
CREATE INDEX IF NOT EXISTS idx_task_rows_parent
  ON task_rows (comment_id, COALESCE(layer_id, ''), parent_line_no);

CREATE TABLE IF NOT EXISTS task_row_dates (
  comment_id TEXT NOT NULL,
  layer_id   TEXT REFERENCES layers (id) ON DELETE CASCADE, -- NULL = основа
  line_no    INTEGER NOT NULL,
  date       TEXT NOT NULL,                      -- YYYY-MM-DD — дата как написана
  time       TEXT                                -- HH:MM или NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_row_dates_key
  ON task_row_dates (comment_id, COALESCE(layer_id, ''), line_no, date, COALESCE(time, ''));

-- «Связи дня» и календарь: выборка всех date-ссылок за день.
CREATE INDEX IF NOT EXISTS idx_task_row_dates_date
  ON task_row_dates (date);

CREATE TABLE IF NOT EXISTS task_row_subjects (
  comment_id TEXT NOT NULL,
  layer_id   TEXT REFERENCES layers (id) ON DELETE CASCADE, -- NULL = основа
  line_no    INTEGER NOT NULL,
  thought_id TEXT NOT NULL                       -- резолв `[[#uuid]]`
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_row_subjects_key
  ON task_row_subjects (comment_id, COALESCE(layer_id, ''), line_no, thought_id);

-- Панель «Задачи» редактора: задачи по субъектной мысли (e6d65f51).
CREATE INDEX IF NOT EXISTS idx_task_row_subjects_thought
  ON task_row_subjects (thought_id);

CREATE TABLE IF NOT EXISTS task_projection_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  max_revision INTEGER NOT NULL DEFAULT 0      -- маркер актуальности проекции
);

INSERT OR IGNORE INTO task_projection_state (id, max_revision) VALUES (1, 0);
