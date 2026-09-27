/**
 * Чистые примитивы календарных дат (0.10.1, приёмка №5, задача 7ce662c4).
 *
 * Модуль выделен из `screens/chronicle/diary.ts` при переносе календаря месяца
 * в библиотеку (`lib/month-calendar.ts`): общий компонент календаря нужен и
 * панели «Дневника», и диалогу «Дата/период», а библиотека не должна зависеть
 * от экранного модуля. Здесь — только арифметика «голых дат» `YYYY-MM-DD` без
 * DOM, поясов и токенов; всё, что знает про токены периода и ленту, осталось в
 * `screens/chronicle/diary.ts` (модуль реэкспортирует эти примитивы, чтобы
 * существующие потребители не менялись).
 *
 * Дата принадлежности записи считается в ЛОКАЛЬНОМ поясе наблюдателя
 * (ADR времени 994d076a), а арифметика календарных дней — в UTC (без переходов
 * DST), поэтому «голая дата» здесь однозначна.
 */

/** «Голая дата» `YYYY-MM-DD`. */
export const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Двузначная запись числа. */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Локальная дата сегодняшнего дня наблюдателя (`YYYY-MM-DD`). */
export function todayLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Локальная дата `YYYY-MM-DD` корректна (такая дата существует в календаре).
 * Общий валидатор «голых дат»: им пользуются диалог «Дата/период» и
 * компонентное поле даты (`lib/date-field.ts`) — одна точка правды
 * (итерация приёмки №8, п.4).
 */
export function isValidLocalDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

/**
 * Назначить «С» периода: при «С» > «По» конец автоматически становится равен
 * началу (валидация периода — «По» не меньше «С»). Общая точка правды для
 * диалога даты/периода и полей «Даты» панели отбора (итерация приёмки №8, п.4).
 */
export function setPeriodFrom(
  from: string,
  to: string,
  day: string,
): { from: string; to: string } {
  return { from: day, to: to < day ? day : to };
}

/**
 * Назначить «По» периода: при «По» < «С» начало автоматически становится равно
 * концу (валидация периода).
 */
export function setPeriodTo(
  from: string,
  to: string,
  day: string,
): { from: string; to: string } {
  return { from: day < from ? day : from, to: day };
}

/**
 * Назначить «время с» периода при ОДИНАКОВЫХ датах границ: если «время с» >
 * «время по», конец автоматически становится равен началу. Зеркало
 * {@link setPeriodFrom} для времени суток (ошибка d4fbeaf7). Вызывающий сам
 * решает, когда правило применимо: при разных датах период охватывает больше
 * суток, и время границ может быть любым.
 */
export function setPeriodTimeFrom(
  fromTime: string,
  toTime: string,
  time: string,
): { fromTime: string; toTime: string } {
  return { fromTime: time, toTime: toTime < time ? time : toTime };
}

/**
 * Назначить «время по» периода при ОДИНАКОВЫХ датах границ: если «время по» <
 * «время с», начало автоматически становится равно концу. Зеркало
 * {@link setPeriodTo} для времени суток (ошибка d4fbeaf7).
 */
export function setPeriodTimeTo(
  fromTime: string,
  toTime: string,
  time: string,
): { fromTime: string; toTime: string } {
  return { fromTime: time < fromTime ? time : fromTime, toTime: time };
}

/** Сдвиг календарного дня на `n` суток (арифметика в UTC — без переходов DST). */
export function addDays(day: string, n: number): string {
  const m = BARE_DATE_RE.exec(day.trim());
  if (m === null) return day;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** Индекс дня недели с понедельника (0 — понедельник … 6 — воскресенье). */
export function mondayIndex(day: string): number {
  const d = new Date(`${day}T00:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

/** Первый день месяца `YYYY-MM-DD`. */
export function firstOfMonth(year: number, month: number): string {
  return `${year}-${pad2(month)}-01`;
}

/**
 * Номер ISO-недели календарного дня (для подписи строки недели). Чистая
 * арифметика через четверг той же недели (ISO-8601).
 */
export function isoWeekNumber(day: string): number {
  const m = BARE_DATE_RE.exec(day.trim());
  if (m === null) return 0;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Четверг текущей недели определяет ISO-год и номер недели.
  const thursday = new Date(date.getTime());
  thursday.setUTCDate(date.getUTCDate() - mondayIndex(day) + 3);
  // Четверг первой ISO-недели года — четверг недели, содержащей 4 января.
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week1Thursday = new Date(jan4.getTime());
  week1Thursday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  return Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * 86_400_000)) + 1;
}

/** Одна ячейка дня календаря. */
export interface CalendarCell {
  /** Локальная дата `YYYY-MM-DD`. */
  day: string;
  /** День принадлежит отображаемому месяцу. */
  inMonth: boolean;
}

/** Одна строка недели календаря (понедельник … воскресенье). */
export interface CalendarWeek {
  /** Номер ISO-недели. */
  week: number;
  days: CalendarCell[];
}

/**
 * Шесть недель сетки месяца (42 дня, всегда одинаковое число строк — высота
 * календаря не прыгает при переключении месяца). `month` — 1..12.
 */
export function buildMonthWeeks(year: number, month: number): CalendarWeek[] {
  const first = firstOfMonth(year, month);
  const firstDate = new Date(`${first}T00:00:00Z`);
  const lead = (firstDate.getUTCDay() + 6) % 7;
  let cursor = addDays(first, -lead);
  const weeks: CalendarWeek[] = [];
  for (let w = 0; w < 6; w++) {
    const days: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      days.push({ day: cursor, inMonth: cursor.slice(0, 7) === first.slice(0, 7) });
      cursor = addDays(cursor, 1);
    }
    const monday = days[0]!.day;
    weeks.push({ week: isoWeekNumber(monday), days });
  }
  return weeks;
}
