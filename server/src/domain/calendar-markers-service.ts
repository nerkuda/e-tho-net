/**
 * Маркеры дней календаря месяца «Дневника» (0.16.1, задача `d793fd69`;
 * требование `ab9d627b`, элемент интерфейса `55b07702`).
 *
 * Один агрегатный запрос на месяц вместо поштучных чтений: отдаёт всё, что
 * нужно нарисовать маркерами в клетках календаря панели отбора «Дневника».
 * Источники — только индексные чтения существующих проекций:
 *   1. **записи** — интервалы `comments_v` вида `chronological` (день записи
 *      клиент считает сам: интервал приходит UTC-инстансами);
 *   2. **задачи** — периоды `task_rows` материализованной проекции
 *      (`is_task = 1`): задача отмечает ВСЕ даты своего периода, поэтому дни
 *      разворачиваются в диапазон `period_from…period_to`;
 *   3. **просрочка** — незакрытые задачи со сроком (`due`) раньше «сегодня»
 *      клиента: отмечается ДЕНЬ СРОКА;
 *   4. **факты** — значения-даты свойств мыслей (`property_values_v`) и
 *      date-ссылки не-задачных строк (`task_row_dates` + `task_rows.is_task = 0`),
 *      как в «Связях дня»;
 *   5. **напоминания** — раскрытие серий напоминаний ЗАПРОСИВШЕГО пользователя
 *      движком повторов (`domain/reminder-service.ts` → `expandOccurrences`):
 *      вхождения приходят UTC-инстансами, день показа считает клиент.
 *
 * **Сутки наблюдателя — клиент.** Сервер не хранит пояс и не решает, какой
 * сейчас день (требование `fcdcd75f`): календарные дни (`from`/`to`/`today`)
 * приходят из запроса. Для записей и напоминаний окно поиска расширяется на
 * сутки в обе стороны по UTC — это ТЕХНИЧЕСКОЕ окно (любой пояс укладывается в
 * ±14 ч), а не «сутки наблюдателя»: дни вне своего месяца клиент отбрасывает
 * при раскладке инстансов по локальным дням.
 *
 * Видимость задач и date-ссылок — как у GET /tasks и «Связей дня»: строка
 * видима, когда её `layer_id` совпадает со слоем победителя `comments_v`
 * (`NULL` — основа). Правило одно на все чтения (`task-visibility.ts`):
 * постоянные комментарии помеченных на удаление сущностей исключены всегда, а
 * при выключенной настройке «показывать содержимое корзины» — и остальные
 * записи помеченных владельцев (пачка 11, задача 173e8368).
 */

import {
  BASE_LAYER_ID,
  EtnError,
  type CalendarMarkersResult,
  type CalendarRecordSpan,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { normaliseInstant } from './dates.js';
import { listReminders } from './reminder-service.js';
import { taskRowVisibilitySql, trashContentSql } from './task-visibility.js';

/** Параметры выборки маркеров месяца. */
export interface CalendarMarkersOptions {
  /** Первый день месяца/диапазона (`YYYY-MM-DD`). */
  from: string;
  /** Последний день диапазона (`YYYY-MM-DD`); не задан — равен `from`. */
  to?: string;
  /** Локальные сутки клиента для расчёта просрочки (`YYYY-MM-DD`). */
  today: string;
  /** Владелец напоминаний (per-user, операция ae19b1bf); пусто — их нет. */
  userId?: string;
  /** Настройка сети «Показывать неактуальные мысли и связи». */
  show_inactive?: boolean;
  /**
   * Показывать содержимое корзины (per-user `show_trash`, по умолчанию `true`):
   * при `false` записи/задачи помеченных на удаление владельцев в маркерах не
   * учитываются (пачка 11, задача 173e8368).
   */
  show_trash?: boolean;
  /** Часы исполнения раскрытия серий (тесты и детерминизм). */
  nowMs?: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Проверить календарный день входа: иначе 400 (сервер не угадывает сутки). */
function day(value: string | undefined, field: string): string {
  if (value === undefined || value === '') {
    throw new EtnError('VALIDATION_ERROR', `${field} is required (YYYY-MM-DD).`, { field });
  }
  if (!DAY_RE.test(value)) {
    throw new EtnError('VALIDATION_ERROR', `${field} must be a calendar day (YYYY-MM-DD).`, {
      field,
    });
  }
  return value;
}

/** Сдвиг календарного дня на `n` суток (арифметика в UTC — без переходов DST). */
function shiftDay(value: string, days: number): string {
  const [year, month, dayOfMonth] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, dayOfMonth + days)).toISOString().slice(0, 10);
}

/**
 * Предикат видимости строки проекции — ТЕ ЖЕ правила, что у GET /tasks и
 * «Связей дня»: один смысл видимости на все чтения проекции (`task-visibility.ts`,
 * `taskRowVisibilitySql`). Настройка корзины (`show_trash`) учитывается тем же
 * предикатом — отдельной копии SQL здесь нет.
 */
const VISIBLE_ROWS = `FROM task_rows tr
       JOIN (SELECT c.id, c.layer_id, c.kind, c.owner_type, c.owner_id
               FROM comments_v c) v
         ON v.id = tr.comment_id
        AND ((tr.layer_id IS NULL AND v.layer_id = ?) OR tr.layer_id = v.layer_id)`;

/** Интервалы хроно-записей, пересёкших поисковое окно. */
function readRecordSpans(
  ndb: NetworkDb,
  fromInstant: string,
  toInstant: string,
  showTrash: boolean,
): CalendarRecordSpan[] {
  const rows = ndb
    .prepare(
      `SELECT DISTINCT c.valid_from AS from_instant, c.valid_to AS to_instant
         FROM comments_v c
        WHERE c.kind = 'chronological'
          AND c.valid_from <= ?
          AND (c.valid_to IS NULL OR c.valid_to >= ?)
          AND ${trashContentSql('c', showTrash)}
        ORDER BY c.valid_from, c.valid_to`,
    )
    .all(toInstant, fromInstant) as Array<{ from_instant: string; to_instant: string | null }>;
  return rows.map((row) => ({ from: row.from_instant, to: row.to_instant }));
}

/** Дни внутри `[from, to]`, покрытые периодом `period_from…period_to`. */
function coverDays(periodFrom: string, periodTo: string, from: string, to: string): string[] {
  const start = periodFrom < from ? from : periodFrom;
  const end = periodTo > to ? to : periodTo;
  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor = shiftDay(cursor, 1)) {
    days.push(cursor);
    // Защита от битого интервала (проекция пере-создаётся парсером, но чтение
    // не должно зависнуть на мусорной строке).
    if (days.length > 3660) break;
  }
  return days;
}

/**
 * Счётчики периодов задач по дням месяца (0.16.1, уточнение 2026-11-19, пункт 7):
 * сколько задач покрывает каждый день. Дни — все даты периода, включая
 * выполненные задачи; карта же даёт и состав дней (`task_days`).
 */
function readTaskDayCounts(
  ndb: NetworkDb,
  from: string,
  to: string,
  showTrash: boolean,
): Record<string, number> {
  const rows = ndb
    .prepare(
      `SELECT tr.period_from AS period_from, tr.period_to AS period_to
         ${VISIBLE_ROWS}
        WHERE tr.is_task = 1
          AND tr.period_from IS NOT NULL
          AND tr.period_to IS NOT NULL
          AND tr.period_to >= ?
          AND tr.period_from <= ?
          AND ${taskRowVisibilitySql('tr', 'v', showTrash)}`,
    )
    .all(BASE_LAYER_ID, from, to) as Array<{ period_from: string; period_to: string }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const value of coverDays(row.period_from, row.period_to, from, to)) {
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return counts;
}

/** Счётчики дней-сроков незакрытых просроченных задач (`due < today`). */
function readOverdueDayCounts(
  ndb: NetworkDb,
  from: string,
  to: string,
  today: string,
  showTrash: boolean,
): Record<string, number> {
  const rows = ndb
    .prepare(
      `SELECT tr.due AS due, COUNT(*) AS rows_count
         ${VISIBLE_ROWS}
        WHERE tr.is_task = 1
          AND tr.done = 0
          AND tr.due IS NOT NULL
          AND tr.due < ?
          AND tr.due BETWEEN ? AND ?
          AND ${taskRowVisibilitySql('tr', 'v', showTrash)}
        GROUP BY tr.due
        ORDER BY tr.due`,
    )
    .all(BASE_LAYER_ID, today, from, to) as Array<{ due: string; rows_count: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.due] = row.rows_count;
  return counts;
}

/**
 * Счётчики датовых фактов по дням: значения-даты свойств живых мыслей
 * (справочник `properties_v`) плюс date-ссылки не-задачных строк проекции.
 * Строки-задачи сюда не входят: их даты показывает маркер «задачи и
 * напоминания».
 */
function readFactDayCounts(
  ndb: NetworkDb,
  from: string,
  to: string,
  showTrash: boolean,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (day: string, value: number): void => {
    counts[day] = (counts[day] ?? 0) + value;
  };
  const facts = ndb
    .prepare(
      `SELECT substr(pv.value_date, 1, 10) AS day, COUNT(*) AS rows_count
         FROM property_values_v pv
         JOIN properties_v p ON p.id = pv.property_id
         JOIN thoughts_v t ON t.id = pv.owner_id
        WHERE pv.owner_type = 'thought'
          AND p.value_type = 'date'
          AND pv.value_date IS NOT NULL
          AND pv.value_date <> ''
          AND substr(pv.value_date, 1, 10) BETWEEN ? AND ?
          AND t.marked_for_deletion = 0
        GROUP BY substr(pv.value_date, 1, 10)`,
    )
    .all(from, to) as Array<{ day: string; rows_count: number }>;
  for (const row of facts) add(row.day, row.rows_count);

  const links = ndb
    .prepare(
      `SELECT d.date AS day, COUNT(*) AS rows_count
         FROM task_row_dates d
         JOIN task_rows tr
           ON tr.comment_id = d.comment_id
          AND tr.line_no = d.line_no
          AND COALESCE(tr.layer_id, '') = COALESCE(d.layer_id, '')
         JOIN comments_v c
           ON c.id = tr.comment_id
          AND ((tr.layer_id IS NULL AND c.layer_id = ?) OR tr.layer_id = c.layer_id)
        WHERE d.date BETWEEN ? AND ?
          AND tr.is_task = 0
          AND ${taskRowVisibilitySql('tr', 'c', showTrash)}
        GROUP BY d.date`,
    )
    .all(BASE_LAYER_ID, from, to) as Array<{ day: string; rows_count: number }>;
  for (const row of links) add(row.day, row.rows_count);
  return counts;
}

/**
 * Моменты показов вхождений напоминаний владельца в поисковом окне: серия
 * раскрывается движком повторов (единственная реализация грамматики), а
 * `dismiss`/`snooze` учитываются картой исключений — у отложенного вхождения
 * показ перенесён на `until`.
 */
function readReminderInstants(
  ndb: NetworkDb,
  fromInstant: string,
  toInstant: string,
  options: CalendarMarkersOptions,
): string[] {
  const userId = options.userId ?? '';
  if (userId === '') return [];
  const result = listReminders(ndb, userId, {
    from: fromInstant,
    to: toInstant,
    show_inactive: options.show_inactive === true,
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  const instants = new Set<string>();
  for (const reminder of result.reminders) {
    for (const occurrence of reminder.occurrences ?? []) {
      instants.add(occurrence.until ?? occurrence.occurrence_at);
    }
  }
  return [...instants].sort();
}

/**
 * Маркеры дней месяца. Чтение синхронное и индексное (как у хронико-запроса и
 * «Связей дня»): в reader-пул не уходит.
 */
export function listCalendarMarkers(
  ndb: NetworkDb,
  options: CalendarMarkersOptions,
): CalendarMarkersResult {
  const from = day(options.from, 'from');
  const to = day(options.to ?? options.from, 'to');
  const today = day(options.today, 'today');
  const [start, end] = from <= to ? [from, to] : [to, from];

  // Поисковое окно записей и напоминаний: сутки в обе стороны по UTC.
  const fromInstant = normaliseInstant(shiftDay(start, -1), 'from', 'start')!;
  const toInstant = normaliseInstant(shiftDay(end, 1), 'to', 'end')!;

  // Счётчики по дням — серверный агрегат для попапа даты (0.16.1, уточнение
  // 2026-11-19, пункт 7). Состав дней (`*_days`) — ключи этих карт: второй
  // правды о том, какие дни отмечены, нет.
  const showTrash = options.show_trash !== false;
  const taskDayCounts = readTaskDayCounts(ndb, start, end, showTrash);
  const overdueDayCounts = readOverdueDayCounts(ndb, start, end, today, showTrash);
  const factDayCounts = readFactDayCounts(ndb, start, end, showTrash);

  return {
    record_spans: readRecordSpans(ndb, fromInstant, toInstant, showTrash),
    task_days: Object.keys(taskDayCounts).sort(),
    task_day_counts: taskDayCounts,
    overdue_days: Object.keys(overdueDayCounts).sort(),
    overdue_day_counts: overdueDayCounts,
    fact_days: Object.keys(factDayCounts).sort(),
    fact_day_counts: factDayCounts,
    reminder_instants: readReminderInstants(ndb, fromInstant, toInstant, options),
  };
}
