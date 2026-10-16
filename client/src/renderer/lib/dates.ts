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

/**
 * Смещение дня от НАЧАЛА его недели при первом дне недели `firstDayOfWeek`
 * (ISO 1 = понедельник … 7 = воскресенье), в сутках: 0 — сам первый день.
 * Настройка сети «первый день недели» (требование 1b77decd) общая для
 * календарных виджетов и календарных токенов `$weekStart`/`$weekEnd`; резолвер
 * клиента обязан считать неделю от неё, а не жёстко от понедельника.
 */
export function weekStartOffset(day: string, firstDayOfWeek = 1): number {
  const iso = firstDayOfWeek >= 1 && firstDayOfWeek <= 7 ? firstDayOfWeek : 1;
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 0;
  return (d.getUTCDay() - (iso % 7) + 7) % 7;
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

/** Одна строка недели календаря (первый … последний день недели сети). */
export interface CalendarWeek {
  /** Номер недели (ISO-номер её «срединного» дня — 4-го дня строки). */
  week: number;
  days: CalendarCell[];
}

/**
 * Шесть недель сетки месяца (42 дня, всегда одинаковое число строк — высота
 * календаря не прыгает при переключении месяца). `month` — 1..12.
 *
 * `firstDayOfWeek` — первый день недели сети (ISO 1 = пн … 7 = вс, требование
 * 1b77decd): строка недели начинается с него, поэтому `days[0]` — первый день
 * недели, а не обязательно понедельник. Номер недели считается ISO-номером
 * «срединного» дня строки (4-го): при `firstDayOfWeek = 1` это четверг той же
 * ISO-недели, что и прежний расчёт по понедельнику строки, — номер не меняется.
 */
export function buildMonthWeeks(
  year: number,
  month: number,
  firstDayOfWeek = 1,
): CalendarWeek[] {
  const first = firstOfMonth(year, month);
  const lead = weekStartOffset(first, firstDayOfWeek);
  let cursor = addDays(first, -lead);
  const weeks: CalendarWeek[] = [];
  for (let w = 0; w < 6; w++) {
    const days: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      days.push({ day: cursor, inMonth: cursor.slice(0, 7) === first.slice(0, 7) });
      cursor = addDays(cursor, 1);
    }
    weeks.push({ week: isoWeekNumber(days[3]!.day), days });
  }
  return weeks;
}

// ---------------------------------------------------------------------------
// Глобальные токены даты периода (перенесены из screens/chronicle/diary.ts —
// общий резолвер нужен и экрану «Дневник», и виджету значения условия; экран
// реэкспортирует эти функции, чтобы прежние точки импорта не менялись)
// ---------------------------------------------------------------------------

/**
 * Голова глобального токена даты периода. КАНОН имени границ — camelCase
 * (`$weekStart`/`$weekEnd`/`$monthStart`/`$monthEnd`/`$yearStart`/`$yearEnd`,
 * ревизия 0.13.1 требования 91f8d8dd): именно её пишет контрол периода и хранят
 * предопределённые наборы. Точечные формы (`$week.start` и др.) — ЛЕГАСИ-СИНОНИМЫ
 * выпущенного клиента; они продолжают читаться (паритет со словарём сервера
 * `thought-type-view-tokens.ts`).
 */
const TOKEN_HEAD_RE =
  /^\$(today|now|weekStart|weekEnd|monthStart|monthEnd|yearStart|yearEnd|week\.start|week\.end|month\.start|month\.end|year\.start|year\.end)/;
/** Хвостовая арифметика токена: `±Nd` / `±Nw` / `±Nmo` / `±Ny`. */
const TOKEN_ARITH_RE = /^([+-])(\d+)(mo|y|w|d)$/;
/** Легаси-синонимы головы (точка) → канон camelCase (паритет с сервером). */
const TOKEN_HEAD_ALIASES: Readonly<Record<string, string>> = {
  'week.start': 'weekStart',
  'week.end': 'weekEnd',
  'month.start': 'monthStart',
  'month.end': 'monthEnd',
  'year.start': 'yearStart',
  'year.end': 'yearEnd',
};

/** Является ли строка глобальным токеном даты периода. */
export function isPeriodToken(text: string): boolean {
  return TOKEN_HEAD_RE.test(text.trim());
}

/**
 * Раскрыть глобальный токен даты относительно локального дня наблюдателя
 * (`today`) — зеркало серверного раскрытия для подсветки календаря и сравнения
 * границ. Канон головы — camelCase, легаси точечные формы приводятся к канону.
 * Неделя считается от первого дня недели сети `firstDayOfWeek` (ISO 1 = пн … 7 =
 * вс, требование 1b77decd): `$weekStart`/`$weekEnd` и подсветка согласованы с
 * сервером. Месячная арифметика сдвигает ЯКОРЬ месяца (границы — первое/последнее
 * число нужного месяца). `''` — не токен.
 */
export function resolveDateToken(
  text: string,
  today: string = todayLocal(),
  firstDayOfWeek = 1,
): string {
  const value = text.trim();
  const head = TOKEN_HEAD_RE.exec(value);
  if (head === null) return '';
  const rawHead = head[1]!;
  const name = TOKEN_HEAD_ALIASES[rawHead] ?? rawHead;
  const rest = value.slice(head[0].length);
  let days = 0;
  let months = 0;
  if (rest !== '') {
    const m = TOKEN_ARITH_RE.exec(rest);
    if (m === null) return '';
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    if (m[3] === 'd') days = n;
    else if (m[3] === 'w') days = n * 7;
    else if (m[3] === 'y') months = n * 12;
    else months = n;
  }
  switch (name) {
    case 'today':
    case 'now':
      return addMonths(addDays(today, days), months);
    case 'weekStart': {
      const start = addDays(today, -weekStartOffset(today, firstDayOfWeek));
      return addMonths(addDays(start, days), months);
    }
    case 'weekEnd': {
      const start = addDays(today, -weekStartOffset(today, firstDayOfWeek));
      return addMonths(addDays(start, 6 + days), months);
    }
    case 'monthStart': {
      const first = `${today.slice(0, 7)}-01`;
      return addDays(addMonths(first, months), days);
    }
    case 'monthEnd': {
      const first = `${today.slice(0, 7)}-01`;
      // Арифметика месяцев — по ЯКОРЮ месяца, затем берётся последнее число.
      return addDays(monthEdge(addMonths(first, months), 'end'), days);
    }
    case 'yearStart': {
      const first = `${today.slice(0, 4)}-01-01`;
      return addDays(addMonths(first, months), days);
    }
    case 'yearEnd': {
      const first = `${today.slice(0, 4)}-01-01`;
      // Год = 12 месяцев: конец 12-месячного периода от сдвинутого 1 января.
      const shiftedFirst = addMonths(first, months);
      return addDays(monthEdge(addMonths(shiftedFirst, 11), 'end'), days);
    }
    default:
      return '';
  }
}

/** Сдвиг «голой даты» на `n` календарных месяцев с прижатием дня к концу месяца. */
export function addMonths(day: string, n: number): string {
  if (n === 0) return day;
  const m = BARE_DATE_RE.exec(day.trim());
  if (m === null) return day;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1 + n;
  const date = Number(m[3]);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date, lastDay))).toISOString().slice(0, 10);
}

/** Граница месяца `day` (должен быть первым числом): `start` — само число, `end` — последнее. */
export function monthEdge(firstOfMonth: string, edge: 'start' | 'end'): string {
  const m = BARE_DATE_RE.exec(firstOfMonth.trim());
  if (m === null) return '';
  if (edge === 'start') return firstOfMonth;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
}
