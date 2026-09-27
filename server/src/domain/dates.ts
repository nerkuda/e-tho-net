/**
 * Каноническая нормализация дат хроно-записей (0.10.1, задача T2 fca5b507;
 * ADR времени 994d076a, требования «Формат дат хроно-записи» d58aa1a4 и
 * «Голая дата во входных параметрах API = сутки UTC» 469d8d69).
 *
 * Единая точка для REST, MCP и домена: сервер не придаёт датам смысла
 * «календарного дня» и не конвертирует пояса относительно серверной зоны.
 *
 * Правила:
 *   * «голая дата» `YYYY-MM-DD` трактуется как сутки UTC —
 *     начало (`00:00:00.000Z`) для поля-начала и конец
 *     (`23:59:59.999Z`) для поля-окончания (границы включительные);
 *   * полный ISO-8601-инстанс ОБЯЗАН нести явный пояс (`Z` или `±HH:MM`) —
 *     иначе строка была бы разобрана в локальной зоне сервера, что ADR
 *     запрещает; результат приводится к UTC (`toISOString()`, мс);
 *   * пустое/отсутствующее значение — `null` (дефолт решает вызывающий);
 *   * нераспознаваемая или невозможная дата (например, `2024-02-30`) —
 *     `VALIDATION_ERROR` с понятным `details.field`.
 *
 * Хранилище держит только полные UTC-инстансы: date-only в
 * `valid_from`/`valid_to` не попадает (сторож `guard-chrono-write.test.ts`).
 */

import { EtnError } from '@etn/shared';

/** «Голая дата» `YYYY-MM-DD`. */
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Полный ISO-8601-инстанс с ЯВНЫМ поясом: дата, `T`, часы:минуты,
 * необязательные секунды и миллисекунды, затем `Z` или `±HH:MM`.
 * Отсутствие пояса — ошибка (нельзя молча трактовать как локальное время).
 */
const FULL_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** Куда отображается «голая дата»: начало или конец суток UTC. */
export type DateBoundary = 'start' | 'end';

/** Проверка, что тройка (y, m, d) — реальная календарная дата. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Начало суток UTC для «голой даты». */
function startOfUtcDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)).toISOString();
}

/** Конец суток UTC для «голой даты» (`23:59:59.999Z`, граница включительная). */
function endOfUtcDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999)).toISOString();
}

/** `VALIDATION_ERROR` о некорректной дате. */
function invalidDate(field: string, value: string): EtnError {
  return new EtnError(
    'VALIDATION_ERROR',
    `${field}: ожидается полный UTC-инстанс ISO-8601 либо «голая дата» YYYY-MM-DD`,
    { field, value },
  );
}

/**
 * Нормализовать входную дату хроно-записи к полному UTC-инстансу ISO-8601
 * с миллисекундами.
 *
 * @param value    вход: строка, `Date`, `null`/`undefined` (пусто).
 * @param field    имя поля для `details.field` в ошибке.
 * @param boundary куда отображается «голая дата» — начало (`start`) или
 *                 конец (`end`) суток UTC.
 * @returns полный UTC-инстанс или `null` для пустого входа.
 * @throws EtnError `VALIDATION_ERROR` для нераспознаваемой/невозможной даты
 *         или инстанса без явного пояса.
 */
export function normaliseInstant(
  value: string | null | undefined | Date,
  field: string,
  boundary: DateBoundary,
): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidDate(field, String(value));
    return value.toISOString();
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const bare = BARE_DATE.exec(trimmed);
  if (bare !== null) {
    const year = Number(bare[1]);
    const month = Number(bare[2]);
    const day = Number(bare[3]);
    if (!isRealCalendarDate(year, month, day)) throw invalidDate(field, value);
    return boundary === 'end' ? endOfUtcDay(year, month, day) : startOfUtcDay(year, month, day);
  }

  const full = FULL_INSTANT.exec(trimmed);
  if (full === null) {
    // Строка без явного пояса (`2024-01-01T10:00:00`) сюда попадает и
    // отвергается: `new Date` разобрал бы её в локальной зоне сервера.
    throw invalidDate(field, value);
  }
  const year = Number(full[1]);
  const month = Number(full[2]);
  const day = Number(full[3]);
  const hour = Number(full[4]);
  const minute = Number(full[5]);
  const second = full[6] === undefined ? 0 : Number(full[6]);
  // `new Date` для ISO-строки молча «перекатывает» лишний день
  // (`2024-02-30T00:00:00Z` → 1 марта), поэтому календарь и время
  // проверяем сами — иначе домен сохранил бы не ту дату.
  if (
    !isRealCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw invalidDate(field, value);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw invalidDate(field, value);
  return parsed.toISOString();
}
