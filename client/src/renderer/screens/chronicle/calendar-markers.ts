/**
 * Маркеры календаря месяца в панели отбора «Дневника» (0.16.1, задача
 * `d793fd69`; требование `ab9d627b`, элемент интерфейса `55b07702`).
 *
 * Модуль раскладывает ОДИН агрегатный ответ сервера (`GET
 * /chronicle/calendar-markers`) по локальным дням наблюдателя:
 *   * календарные дни задач, фактов и просрочки приходят днями — берутся как
 *     есть (с обрезкой по отображаемому месяцу);
 *   * интервалы записей (`record_spans`) и моменты вхождений напоминаний
 *     (`reminder_instants`) приходят UTC-инстансами — день считает КЛИЕНТ
 *     (ADR времени 994d076a, требование fcdcd75f): запись отмечает все дни
 *     своего интервала, вхождение напоминания — свой локальный день.
 *
 * В сеть модуль не ходит: данные приходят из `etn.chronicle.calendarMarkers`,
 * поэтому раскладка проверяется unit-тестом без DOM и без IPC.
 */

import {
  CALENDAR_MARKER_ORDER,
  type CalendarMarkerKind,
  type CalendarMarkersResult,
} from '@etn/shared';

import { intervalDays, localDay } from './diary.js';

/** Маркеры по локальным дням месяца (день `YYYY-MM-DD`). */
export type CalendarMarkersByDay = Map<string, readonly CalendarMarkerKind[]>;

/** Диапазон отображаемого месяца (локальные дни клиента). */
export interface CalendarMarkersMonth {
  from: string;
  to: string;
}

/**
 * Разложить ответ сервера по дням месяца. Дни вне `[from, to]` отбрасываются:
 * сервер расширяет поисковое окно записей и напоминаний на сутки в обе стороны
 * (чтобы запись у локальной полуночи не терялась при любом поясе), а клеток
 * чужого месяца в сетке нет.
 */
export function groupCalendarMarkers(
  result: CalendarMarkersResult,
  range: CalendarMarkersMonth,
): CalendarMarkersByDay {
  const byDay = new Map<string, Set<CalendarMarkerKind>>();
  const take = (day: string): Set<CalendarMarkerKind> | null => {
    if (day === '' || day < range.from || day > range.to) return null;
    const existing = byDay.get(day);
    if (existing !== undefined) return existing;
    const created = new Set<CalendarMarkerKind>();
    byDay.set(day, created);
    return created;
  };
  const add = (kind: CalendarMarkerKind, day: string): void => {
    take(day)?.add(kind);
  };

  for (const span of result.record_spans) {
    for (const day of intervalDays(span.from, span.to, range.from, range.to)) {
      add('records', day);
    }
  }
  for (const day of result.task_days) add('plans', day);
  for (const instant of result.reminder_instants) add('plans', localDay(instant));
  for (const day of result.fact_days) add('facts', day);
  for (const day of result.overdue_days) add('overdue', day);

  const out: CalendarMarkersByDay = new Map();
  for (const [day, kinds] of byDay) {
    // Порядок маркеров — фиксированные места клетки (одна точка правды с
    // компонентом календаря: `CALENDAR_MARKER_ORDER`).
    out.set(
      day,
      CALENDAR_MARKER_ORDER.filter((kind) => kinds.has(kind)),
    );
  }
  return out;
}
