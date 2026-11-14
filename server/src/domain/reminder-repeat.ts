/**
 * Движок повторов напоминаний — закрытая грамматика (0.16.1, задача b47f1fd2;
 * требование bbca8f7d, раскрытие на период 4401beb8, управление вхождением
 * 86cb7451).
 *
 * Одна точка расчёта: серия вхождений вычисляется ЧИСТО из `schedule` +
 * `anchor_at` (никакого материализованного календаря), а выдача на период,
 * `next_at` и превью редактора читают этот же вычислитель — «GET и превью не
 * расходятся». Время суток каждого вхождения наследуется от `anchor_at`;
 * сервер оперирует только UTC-инстансами (требование fcdcd75f: «сегодня» и
 * границы суток — забота клиента).
 *
 * Края нормализуются по требованию bbca8f7d:
 *   * 31-е число в коротком месяце и 29.02 в невисокосный год → последний день
 *     месяца;
 *   * N-й день недели, которого в месяце нет (5-й четверг), — вхождение
 *     пропускается, серия продолжается по расписанию;
 *   * окончания у серии нет (без `until`/`count`).
 *
 * Исключения (`exceptions`) — карта «UTC-момент вхождения → snooze{until} |
 * dismiss». Сравнение СТРОГОЕ: вхождение скрыто, только если `until` строго
 * больше момента вхождения; вхождение, попавшее ровно в `until`, остаётся
 * видимым (требования 4401beb8/86cb7451).
 */

import {
  EtnError,
  type ReminderException,
  type ReminderKind,
  type ReminderOccurrence,
  type ReminderSchedule,
} from '@etn/shared';

/** Миллисекунд в сутках — шаг «каждый N-й день» и границы периода. */
export const MS_PER_DAY = 86_400_000;

/** Предохранители от зацикливания: серия обязана дать вхождение. */
const MAX_DAY_STEPS = 400;
const MAX_MONTH_STEPS = 24_000;
const MAX_YEAR_STEPS = 4_000;

/** Ошибка грамматики повтора: REST/MCP отвечают 400 (операция ae19b1bf). */
function grammarError(message: string, field = 'schedule'): never {
  throw new EtnError('VALIDATION_ERROR', message, { status: 400, field });
}

/** Момент в UTC-миллисекундах из ISO-инстанса; невалидный вход — 400. */
export function parseInstant(value: string, field = 'anchor_at'): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    grammarError(`\`${field}\` must be a valid ISO-8601 instant.`, field);
  }
  return ms;
}

/** Сколько дней в месяце (month0 — 0..11). */
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** ISO-день недели: 1 = понедельник … 7 = воскресенье. */
function isoWeekday(ms: number): number {
  const dow = new Date(ms).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Время суток опорного вхождения; его наследуют все вхождения серии. */
interface TimeOfDay {
  hours: number;
  minutes: number;
  seconds: number;
  ms: number;
}

function timeOfDay(anchorMs: number): TimeOfDay {
  const d = new Date(anchorMs);
  return {
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
  };
}

/** UTC-инстанс даты `year-month0-day` с временем суток опорного вхождения. */
function instantAt(year: number, month0: number, day: number, time: TimeOfDay): number {
  return Date.UTC(year, month0, day, time.hours, time.minutes, time.seconds, time.ms);
}

/** Сдвиг (год, месяц0) на `months` месяцев. */
function addMonths(year: number, month0: number, months: number): { year: number; month0: number } {
  const total = year * 12 + month0 + months;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

/** Разница месяцев между опорным и целевым моментом (может быть отрицательной). */
function monthDiff(anchorMs: number, targetMs: number): number {
  const a = new Date(anchorMs);
  const t = new Date(targetMs);
  return (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth());
}

/** День N-го (или последнего) дня недели месяца; `null` — такого дня в месяце нет. */
function weekdayOfMonthDay(
  year: number,
  month0: number,
  weekday: number,
  nth: number | 'last',
): number | null {
  const dim = daysInMonth(year, month0);
  if (nth === 'last') {
    const lastIso = isoWeekday(Date.UTC(year, month0, dim));
    return dim - ((lastIso - weekday + 7) % 7);
  }
  const firstIso = isoWeekday(Date.UTC(year, month0, 1));
  const day = 1 + ((weekday - firstIso + 7) % 7) + (nth - 1) * 7;
  return day <= dim ? day : null;
}

/** Целое число в диапазоне; иначе — ошибка грамматики. */
function intIn(obj: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    grammarError(`\`schedule.${key}\` must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/**
 * Проверить и нормализовать расписание повтора (закрытая грамматика).
 *
 * Возвращает канонический вид: выбранные дни недели отсортированы и
 * дедуплицированы, обязательные числовые поля приведены к числам. Неизвестный
 * тип, неизвестный ключ или значение вне диапазона — `VALIDATION_ERROR` с
 * HTTP 400 (`details.status`), как требует операция ae19b1bf.
 */
export function validateSchedule(input: unknown): ReminderSchedule {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    grammarError('`schedule` must be an object closed by the repeat grammar.');
  }
  const obj = input as Record<string, unknown>;
  const type = obj['type'];
  switch (type) {
    case 'once':
      assertOnlyKeys(obj, ['type']);
      return { type: 'once' };
    case 'weekdays': {
      assertOnlyKeys(obj, ['type', 'days']);
      const raw = obj['days'];
      if (!Array.isArray(raw) || raw.length === 0) {
        grammarError('`schedule.days` must be a non-empty array of ISO weekdays (1..7).');
      }
      const days = raw.map((day) => {
        if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) {
          grammarError('`schedule.days` values must be ISO weekdays from 1 (Mon) to 7 (Sun).');
        }
        return day;
      });
      return { type: 'weekdays', days: [...new Set(days)].sort((a, b) => a - b) };
    }
    case 'every_days':
      assertOnlyKeys(obj, ['type', 'every']);
      return { type: 'every_days', every: intIn(obj, 'every', 1, 3650) };
    case 'weekday_of_month': {
      assertOnlyKeys(obj, ['type', 'weekday', 'nth']);
      const nthRaw = obj['nth'];
      const nth =
        nthRaw === 'last'
          ? 'last'
          : typeof nthRaw === 'number' && Number.isInteger(nthRaw) && nthRaw >= 1 && nthRaw <= 5
            ? nthRaw
            : grammarError('`schedule.nth` must be an integer from 1 to 5 or "last".');
      return {
        type: 'weekday_of_month',
        weekday: intIn(obj, 'weekday', 1, 7),
        nth,
      };
    }
    case 'day_of_month':
      assertOnlyKeys(obj, ['type', 'day', 'every_months']);
      return {
        type: 'day_of_month',
        day: intIn(obj, 'day', 1, 31),
        every_months: intIn(obj, 'every_months', 1, 120),
      };
    case 'yearly':
      assertOnlyKeys(obj, ['type', 'month', 'day']);
      return {
        type: 'yearly',
        month: intIn(obj, 'month', 1, 12),
        day: intIn(obj, 'day', 1, 31),
      };
    case 'last_day_of_month':
      assertOnlyKeys(obj, ['type', 'every_months']);
      return { type: 'last_day_of_month', every_months: intIn(obj, 'every_months', 1, 120) };
    default:
      grammarError(
        '`schedule.type` must be one of once, weekdays, every_days, weekday_of_month, ' +
          'day_of_month, yearly, last_day_of_month.',
      );
  }
}

/** Расписание — закрытая схема: лишний ключ означает ошибку грамматики. */
function assertOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      grammarError(`unexpected \`schedule.${key}\` — the repeat grammar is closed.`);
    }
  }
}

/**
 * Крупный вид напоминания из типа расписания: `once` → one; серии фиксированного
 * шага → period; календарные правила → rule (требование bbca8f7d).
 */
export function kindOfSchedule(schedule: ReminderSchedule): ReminderKind {
  switch (schedule.type) {
    case 'once':
      return 'one';
    case 'every_days':
    case 'day_of_month':
    case 'last_day_of_month':
      return 'period';
    case 'weekdays':
    case 'weekday_of_month':
    case 'yearly':
      return 'rule';
  }
}

/** Согласованность `kind` и `schedule.type`; расхождение — 400. */
export function assertScheduleKind(kind: ReminderKind, schedule: ReminderSchedule): void {
  const expected = kindOfSchedule(schedule);
  if (kind !== expected) {
    grammarError(
      `\`kind\` "${kind}" does not match schedule.type "${schedule.type}" (expected "${expected}").`,
      'kind',
    );
  }
}

/**
 * Первое вхождение серии не раньше `targetMs`; `null` — вхождений больше нет
 * (только `once` после своего момента).
 *
 * Это единственный поиск вхождений: `anchor` нормализуется им же (первое
 * вхождение не раньше запрошенного опорного момента), `next_at` продвигается
 * им от «сейчас», раскрытие на период идёт последовательными вызовами.
 */
export function firstOccurrenceOnOrAfter(
  schedule: ReminderSchedule,
  anchorMs: number,
  targetMs: number,
): number | null {
  const anchor = new Date(anchorMs);
  const time = timeOfDay(anchorMs);
  const floor = Math.max(anchorMs, targetMs);

  switch (schedule.type) {
    case 'once':
      return anchorMs >= targetMs ? anchorMs : null;

    case 'every_days': {
      if (targetMs <= anchorMs) return anchorMs;
      const step = schedule.every * MS_PER_DAY;
      return anchorMs + Math.ceil((targetMs - anchorMs) / step) * step;
    }

    case 'weekdays': {
      const days = new Set(schedule.days);
      const start = new Date(floor);
      let year = start.getUTCFullYear();
      let month0 = start.getUTCMonth();
      let day = start.getUTCDate();
      for (let i = 0; i <= MAX_DAY_STEPS; i++) {
        const instant = instantAt(year, month0, day, time);
        if (instant >= floor && days.has(isoWeekday(instant))) return instant;
        const next = new Date(Date.UTC(year, month0, day + 1));
        year = next.getUTCFullYear();
        month0 = next.getUTCMonth();
        day = next.getUTCDate();
      }
      throw new EtnError('INTERNAL', 'reminder recurrence did not converge (weekdays).');
    }

    case 'weekday_of_month': {
      const anchorMonth = Math.max(0, monthDiff(anchorMs, floor));
      for (let step = 0; step <= MAX_MONTH_STEPS; step++) {
        const { year, month0 } = addMonths(
          anchor.getUTCFullYear(),
          anchor.getUTCMonth(),
          anchorMonth + step,
        );
        const day = weekdayOfMonthDay(year, month0, schedule.weekday, schedule.nth);
        if (day === null) continue;
        const instant = instantAt(year, month0, day, time);
        if (instant >= floor) return instant;
      }
      throw new EtnError('INTERNAL', 'reminder recurrence did not converge (weekday_of_month).');
    }

    case 'day_of_month':
    case 'last_day_of_month': {
      const everyMonths = schedule.every_months;
      const diff = Math.max(0, monthDiff(anchorMs, floor));
      const firstStep = Math.floor(diff / everyMonths);
      for (let step = firstStep; step <= firstStep + MAX_MONTH_STEPS; step++) {
        const { year, month0 } = addMonths(
          anchor.getUTCFullYear(),
          anchor.getUTCMonth(),
          step * everyMonths,
        );
        const dim = daysInMonth(year, month0);
        const day = schedule.type === 'day_of_month' ? Math.min(schedule.day, dim) : dim;
        const instant = instantAt(year, month0, day, time);
        if (instant >= floor) return instant;
      }
      throw new EtnError('INTERNAL', 'reminder recurrence did not converge (monthly).');
    }

    case 'yearly': {
      // Целевой год и следующий: дата в текущем году могла уже пройти.
      const startYear = new Date(floor).getUTCFullYear() - 1;
      for (let year = startYear; year <= startYear + MAX_YEAR_STEPS; year++) {
        const dim = daysInMonth(year, schedule.month - 1);
        const day = Math.min(schedule.day, dim);
        const instant = instantAt(year, schedule.month - 1, day, time);
        if (instant >= floor) return instant;
      }
      throw new EtnError('INTERNAL', 'reminder recurrence did not converge (yearly).');
    }
  }
}

/**
 * Нормализовать опорное вхождение: `anchor_at` хранится как ПЕРВОЕ вхождение
 * серии не раньше запрошенного момента. Это же снимает края («31-е → последний
 * день месяца», «5-го четверга нет — серия начинается со следующего месяца»).
 * Для `once` опорный момент возвращается как есть.
 */
export function normalizeAnchor(schedule: ReminderSchedule, anchorAtMs: number): number {
  const first = firstOccurrenceOnOrAfter(schedule, anchorAtMs, anchorAtMs);
  if (first === null) {
    throw new EtnError('INTERNAL', 'reminder anchor has no occurrence at its own moment.');
  }
  return first;
}

/** Пара исключений, разобранная по моментам вхождений (UTC-миллисекунды). */
export type ExceptionMap = ReadonlyMap<number, ReminderException>;

/** Момент показа для snooze-исключения. */
function snoozeUntilMs(exception: ReminderException): number | null {
  if (exception.kind !== 'snooze') return null;
  const ms = Date.parse(exception.until);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Раскрытие серии на период `[fromMs, toMs]` включительно.
 *
 * Вхождение исключается, если на его момент есть `dismiss` ИЛИ `snooze` с
 * `until` строго больше момента вхождения. Snoozed-вхождение показывается в
 * периоде, содержащем его `until` (как перенесённое); вхождение, попавшее ровно
 * в `until`, остаётся видимым и в свой момент.
 */
export function expandOccurrences(
  schedule: ReminderSchedule,
  anchorMs: number,
  fromMs: number,
  toMs: number,
  exceptions: ExceptionMap,
): ReminderOccurrence[] {
  const items: Array<{ atMs: number; occurrenceMs: number; occurrence: ReminderOccurrence }> = [];
  let cursor = Math.max(fromMs, anchorMs);
  for (;;) {
    const occurrenceMs = firstOccurrenceOnOrAfter(schedule, anchorMs, cursor);
    if (occurrenceMs === null || occurrenceMs > toMs) break;
    cursor = occurrenceMs + 1;
    const exception = exceptions.get(occurrenceMs);
    if (exception !== undefined) {
      if (exception.kind === 'dismiss') continue;
      const untilMs = snoozeUntilMs(exception);
      if (untilMs !== null && untilMs > occurrenceMs) continue;
    }
    items.push({
      atMs: occurrenceMs,
      occurrenceMs,
      occurrence: {
        occurrence_at: new Date(occurrenceMs).toISOString(),
        status: 'active',
        until: null,
      },
    });
  }

  // Перенесённые показы: карта исключений — единственный источник snooze,
  // поэтому их не нужно искать в серии (момент вхождения может быть далеко
  // в прошлом, а показ — в запрошенном периоде).
  for (const [occurrenceMs, exception] of exceptions) {
    const untilMs = snoozeUntilMs(exception);
    if (untilMs === null || untilMs <= occurrenceMs) continue;
    if (untilMs < fromMs || untilMs > toMs) continue;
    items.push({
      atMs: untilMs,
      occurrenceMs,
      occurrence: {
        occurrence_at: new Date(occurrenceMs).toISOString(),
        status: 'snoozed',
        until: new Date(untilMs).toISOString(),
      },
    });
  }

  items.sort((a, b) => a.atMs - b.atMs || a.occurrenceMs - b.occurrenceMs);
  return items.map((item) => item.occurrence);
}

/**
 * Ближайший видимый показ напоминания: вхождение и момент, когда его видно.
 *
 * `occurrence_at` — момент вхождения по расписанию (именно он адресует
 * исключение), `showing_at` — когда вхождение показывается (для отложенного —
 * его `until`). Вхождения в прошлом не отдаются (ленивое продвижение от
 * `anchor_at` — требование 4401beb8). `null` — вхождений не осталось
 * (единственное вхождение kind=one убрано).
 */
export interface ReminderNextCandidate {
  occurrence_at: number;
  showing_at: number;
}

export function nextCandidate(
  schedule: ReminderSchedule,
  anchorMs: number,
  exceptions: ExceptionMap,
  nowMs: number,
): ReminderNextCandidate | null {
  const candidates: ReminderNextCandidate[] = [];

  let cursor = Math.max(nowMs, anchorMs);
  for (let guard = 0; guard <= MAX_MONTH_STEPS; guard++) {
    const occurrenceMs = firstOccurrenceOnOrAfter(schedule, anchorMs, cursor);
    if (occurrenceMs === null) break;
    const exception = exceptions.get(occurrenceMs);
    if (exception?.kind === 'dismiss') {
      cursor = occurrenceMs + 1;
      continue;
    }
    const untilMs = exception === undefined ? null : snoozeUntilMs(exception);
    if (untilMs !== null && untilMs > occurrenceMs) {
      // Вхождение обработано (перенесено) — его показ учитывается отдельно.
      cursor = occurrenceMs + 1;
      continue;
    }
    candidates.push({ occurrence_at: occurrenceMs, showing_at: occurrenceMs });
    break;
  }

  for (const [occurrenceMs, exception] of exceptions) {
    const untilMs = snoozeUntilMs(exception);
    if (untilMs === null || untilMs <= occurrenceMs || untilMs < nowMs) continue;
    candidates.push({ occurrence_at: occurrenceMs, showing_at: untilMs });
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((best, item) => (item.showing_at < best.showing_at ? item : best));
}

/**
 * Первое необработанное вхождение (`next_at`) как UTC-инстанс: момент показа
 * ближайшего видимого вхождения (для отложенного — его `until`).
 */
export function computeNextAt(
  schedule: ReminderSchedule,
  anchorMs: number,
  exceptions: ExceptionMap,
  nowMs: number,
): string | null {
  const candidate = nextCandidate(schedule, anchorMs, exceptions, nowMs);
  return candidate === null ? null : new Date(candidate.showing_at).toISOString();
}
