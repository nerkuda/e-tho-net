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
 * (`NULL` — основа); строки постоянных комментариев сущностей, помеченных на
 * удаление, исключены.
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
 * Предикат видимости строки проекции и исключение постоянных комментариев
 * помеченных на удаление сущностей — ТЕ ЖЕ правила, что у GET /tasks
 * (`buildFilter` в `task-service.ts`) и «Связей дня»: один смысл видимости на
 * все чтения проекции.
 */
const VISIBLE_ROWS = `FROM task_rows tr
       JOIN (SELECT c.id, c.layer_id, c.kind, c.owner_type, c.owner_id
               FROM comments_v c) v
         ON v.id = tr.comment_id
        AND ((tr.layer_id IS NULL AND v.layer_id = ?) OR tr.layer_id = v.layer_id)`;

/**
 * Исключение строк постоянных комментариев сущностей, помеченных на удаление —
 * ТО ЖЕ правило, что у GET /tasks (`buildFilter` в `task-service.ts`) и
 * «Связей дня». `alias` — псевдоним выборки `comments_v` в запросе.
 */
function markedOwnerExclusion(alias: string): string {
  return `NOT (${alias}.kind = 'permanent' AND (
        (${alias}.owner_type = 'thought' AND EXISTS (
           SELECT 1 FROM thoughts_v t WHERE t.id = ${alias}.owner_id AND t.marked_for_deletion = 1))
     OR (${alias}.owner_type = 'link' AND EXISTS (
           SELECT 1 FROM links_v l WHERE l.id = ${alias}.owner_id AND l.marked_for_deletion = 1))
     OR (${alias}.owner_type = 'publication' AND EXISTS (
           SELECT 1 FROM publications_v p
            WHERE p.id = ${alias}.owner_id AND p.marked_for_deletion = 1))
     ))`;
}

/** Интервалы хроно-записей, пересёкших поисковое окно. */
function readRecordSpans(
  ndb: NetworkDb,
  fromInstant: string,
  toInstant: string,
): CalendarRecordSpan[] {
  const rows = ndb
    .prepare(
      `SELECT DISTINCT c.valid_from AS from_instant, c.valid_to AS to_instant
         FROM comments_v c
        WHERE c.kind = 'chronological'
          AND c.valid_from <= ?
          AND (c.valid_to IS NULL OR c.valid_to >= ?)
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

/** Дни периодов задач месяца (все даты периода, включая выполненные задачи). */
function readTaskDays(ndb: NetworkDb, from: string, to: string): string[] {
  const rows = ndb
    .prepare(
      `SELECT tr.period_from AS period_from, tr.period_to AS period_to
         ${VISIBLE_ROWS}
        WHERE tr.is_task = 1
          AND tr.period_from IS NOT NULL
          AND tr.period_to IS NOT NULL
          AND tr.period_to >= ?
          AND tr.period_from <= ?
          AND ${markedOwnerExclusion('v')}`,
    )
    .all(BASE_LAYER_ID, from, to) as Array<{ period_from: string; period_to: string }>;
  const days = new Set<string>();
  for (const row of rows) {
    for (const value of coverDays(row.period_from, row.period_to, from, to)) days.add(value);
  }
  return [...days].sort();
}

/** Дни-сроки незакрытых просроченных задач (`due < today`), внутри месяца. */
function readOverdueDays(ndb: NetworkDb, from: string, to: string, today: string): string[] {
  const rows = ndb
    .prepare(
      `SELECT DISTINCT tr.due AS due
         ${VISIBLE_ROWS}
        WHERE tr.is_task = 1
          AND tr.done = 0
          AND tr.due IS NOT NULL
          AND tr.due < ?
          AND tr.due BETWEEN ? AND ?
          AND ${markedOwnerExclusion('v')}
        ORDER BY tr.due`,
    )
    .all(BASE_LAYER_ID, today, from, to) as Array<{ due: string }>;
  return rows.map((row) => row.due);
}

/**
 * Дни датовых фактов: значения-даты свойств живых мыслей (справочник
 * `properties_v`) плюс date-ссылки не-задачных строк проекции. Строки-задачи
 * сюда не входят: их даты показывает маркер «задачи и напоминания».
 */
function readFactDays(ndb: NetworkDb, from: string, to: string): string[] {
  const days = new Set<string>();
  const facts = ndb
    .prepare(
      `SELECT DISTINCT substr(pv.value_date, 1, 10) AS day
         FROM property_values_v pv
         JOIN properties_v p ON p.id = pv.property_id
         JOIN thoughts_v t ON t.id = pv.owner_id
        WHERE pv.owner_type = 'thought'
          AND p.value_type = 'date'
          AND pv.value_date IS NOT NULL
          AND pv.value_date <> ''
          AND substr(pv.value_date, 1, 10) BETWEEN ? AND ?
          AND t.marked_for_deletion = 0`,
    )
    .all(from, to) as Array<{ day: string }>;
  for (const row of facts) days.add(row.day);

  const links = ndb
    .prepare(
      `SELECT DISTINCT d.date AS day
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
          AND ${markedOwnerExclusion('c')}`,
    )
    .all(BASE_LAYER_ID, from, to) as Array<{ day: string }>;
  for (const row of links) days.add(row.day);
  return [...days].sort();
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

  return {
    record_spans: readRecordSpans(ndb, fromInstant, toInstant),
    task_days: readTaskDays(ndb, start, end),
    overdue_days: readOverdueDays(ndb, start, end, today),
    fact_days: readFactDays(ndb, start, end),
    reminder_instants: readReminderInstants(ndb, fromInstant, toInstant, options),
  };
}
