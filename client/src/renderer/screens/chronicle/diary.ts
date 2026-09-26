/**
 * Чистые помощники экрана «Дневник» (0.10.1, задача T6 64ca2b48).
 *
 * Всё, что можно посчитать без DOM и сети, живёт здесь: разбор локального дня
 * наблюдателя, разворот длинной записи по дням периода, группировка ленты,
 * периоды клика по календарю, решение о ленивом создании псевдо-записи и состав
 * видимых чипсов. Модуль без DOM — проверяется обычными юнит-тестами
 * (`tests/chronicle-diary.test.ts`).
 *
 * Требования-первоисточники: 26f0aa52 (ленивое создание), e0970b70 (видимость
 * записи в периоде), c6ddc1ea (порядок ленты), c81964c7 (запись дня/HOME),
 * 80b31f7a (переименование). Дата принадлежности записи вычисляется в ЛОКАЛЬНОМ
 * поясе наблюдателя (ADR времени 994d076a).
 */

import type { ChronicleRow, ChronicleTarget } from '@etn/shared';

/** «Голая дата» `YYYY-MM-DD`. */
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Глобальный токен даты периода: `$today`/`$now` с арифметикой `±Nd`. */
const TOKEN_RE = /^\$(?:today|now)([+-](\d+)d)?$/;

/** Один день ленты: локальная дата `YYYY-MM-DD` и записи, видимые в этот день. */
export interface DiaryDay {
  day: string;
  rows: ChronicleRow[];
}

/** Двузначная запись числа. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Локальная дата сегодняшнего дня наблюдателя (`YYYY-MM-DD`). */
export function todayLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Локальный день наблюдателя для значения записи: «голая дата» возвращается
 * как есть, полный инстанс переводится в локальные год-месяц-день. `''` —
 * значение не разобралось.
 */
export function localDay(iso: string): string {
  const value = iso.trim();
  if (value === '') return '';
  const bare = BARE_DATE_RE.exec(value);
  if (bare !== null) return value;
  if (TOKEN_RE.test(value)) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Сдвиг календарного дня на `n` суток (арифметика в UTC — без переходов DST). */
export function addDays(day: string, n: number): string {
  const m = BARE_DATE_RE.exec(day.trim());
  if (m === null) return day;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/**
 * Развернуть границу периода (`date_from`/`date_to`) в локальный день:
 * «голая дата» — как есть, токен — относительно сегодня, инстанс — в локальный
 * день наблюдателя. `''` — граница не задана либо не поддаётся разбору (тогда
 * считается неограниченной).
 */
export function resolvePeriodDay(value: string, today: string = todayLocal()): string {
  const text = value.trim();
  if (text === '') return '';
  const bare = BARE_DATE_RE.exec(text);
  if (bare !== null) return text;
  const token = TOKEN_RE.exec(text);
  if (token !== null) {
    const shift = token[2] !== undefined ? Number(token[2]) * (text.includes('-') ? -1 : 1) : 0;
    return addDays(today, shift);
  }
  return localDay(text);
}

/**
 * Дата по умолчанию для псевдо-записи: `clamp(сегодня, начало, конец)` —
 * требование 26f0aa52. Пустые границы не ограничивают.
 */
export function clampPseudoDate(today: string, from: string, to: string): string {
  let day = today;
  if (from !== '' && day < from) day = from;
  if (to !== '' && day > to) day = to;
  return day;
}

/**
 * Дни, в которых видна запись: пересечение её интервала с периодом (границы
 * включительные, требование e0970b70). Длительная запись возвращает все дни
 * интервала — она «мозолит глаза» в каждом дне периода.
 */
export function rowDays(row: ChronicleRow, from = '', to = ''): string[] {
  let start = localDay(row.valid_from);
  let end = row.valid_to !== null ? localDay(row.valid_to) : start;
  if (start === '') return [];
  if (end === '') end = start;
  if (end < start) [start, end] = [end, start];
  if (to !== '' && start > to) return [];
  if (from !== '' && end < from) return [];
  if (from !== '' && start < from) start = from;
  if (to !== '' && end > to) end = to;
  const out: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    out.push(day);
    if (out.length > 3660) break; // защита от битого интервала
  }
  return out;
}

/**
 * Группировка записей по локальным дням наблюдателя. Порядок записей внутри дня
 * — серверный (класс → `valid_from` → `valid_to` → `created_at` → `id`,
 * требование c6ddc1ea): клиент его не пересортировывает. Дни — по возрастанию.
 * `from`/`to` — развёрнутые границы периода (см. {@link resolvePeriodDay}).
 */
export function groupByLocalDays(
  rows: readonly ChronicleRow[],
  opts: { from?: string; to?: string } = {},
): DiaryDay[] {
  const from = opts.from ?? '';
  const to = opts.to ?? '';
  const byDay = new Map<string, ChronicleRow[]>();
  for (const row of rows) {
    for (const day of rowDays(row, from, to)) {
      const bucket = byDay.get(day);
      if (bucket === undefined) byDay.set(day, [row]);
      else bucket.push(row);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, list]) => ({ day, rows: list }));
}

/** Период клика по дню календаря. */
export interface PeriodRange {
  from: string;
  to: string;
}

/** Период одного дня (клик по дате календаря). */
export function dayPeriod(day: string): PeriodRange {
  return { from: day, to: day };
}

/** Индекс дня недели с понедельника (0 — понедельник … 6 — воскресенье). */
function mondayIndex(day: string): number {
  const d = new Date(`${day}T00:00:00Z`);
  return (d.getUTCDay() + 6) % 7;
}

/** Период недели (клик по номеру/строке недели): понедельник — воскресенье. */
export function weekPeriod(day: string): PeriodRange {
  const monday = addDays(day, -mondayIndex(day));
  return { from: monday, to: addDays(monday, 6) };
}

/**
 * Новый отбор с записанным периодом: пишутся ТОЛЬКО поля периода, остальные
 * критерии не трогаются (элемент «Календарь месяца в «Дневнике»»). Возвращает
 * копию — исходный отбор не мутируется.
 */
export function applyPeriodToFilter<T extends { dateFrom: string; dateTo: string }>(
  filter: T,
  period: PeriodRange,
): T {
  return { ...filter, dateFrom: period.from, dateTo: period.to };
}

/** Содержимое псевдо-записи, достаточное для первого сохранения. */
export interface RecordDraft {
  title?: string | null;
  body?: string | null;
  /** Сколько привязок уже готово к сохранению. */
  bindings?: number;
}

/**
 * Есть ли в псевдо-записи содержательный элемент: непустой заголовок, непустой
 * текст или хотя бы одна привязка (требование 26f0aa52). Пока `false` — в базу
 * ничего не пишется.
 */
export function hasRecordContent(draft: RecordDraft): boolean {
  if ((draft.title ?? '').trim() !== '') return true;
  if ((draft.body ?? '').trim() !== '') return true;
  return (draft.bindings ?? 0) > 0;
}

/**
 * Нужны ли сетевые вызовы при удалении слота: пустой слот (без id) удаляется
 * только в клиенте, без записи в сеть и real-time событий (требование
 * 26f0aa52).
 */
export function slotDeleteNeedsNetwork(commentId: string | null): boolean {
  return commentId !== null;
}

/**
 * Видимые чипсы записи: все привязки, кроме первичной привязки к HOME —
 * она служебная (класс записи, требование c81964c7) и крестика не имеет.
 */
export function visibleChips(
  targets: readonly ChronicleTarget[],
  homeId: string | null,
): ChronicleTarget[] {
  if (homeId === null) return [...targets];
  return targets.filter(
    (target) => !(target.kind === 'thought' && target.thought.id === homeId),
  );
}

/** Является ли привязка снятием последнего чипса (тогда нужно подтверждение). */
export function isLastChip(chips: readonly unknown[]): boolean {
  return chips.length <= 1;
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
