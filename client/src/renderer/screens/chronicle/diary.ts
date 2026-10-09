/**
 * Чистые помощники экрана «Дневник» (0.10.1, задача T6 64ca2b48).
 *
 * Всё, что можно посчитать без DOM и сети, живёт здесь: разбор локального дня
 * наблюдателя, разворот длинной записи по дням периода, группировка ленты,
 * периоды клика по календарю и состав видимых чипсов. Модуль без DOM —
 * проверяется обычными юнит-тестами (`tests/chronicle-diary.test.ts`).
 *
 * Требования-первоисточники: 26f0aa52 (немедленное создание записи), e0970b70
 * (видимость записи в периоде), c6ddc1ea (порядок ленты), c81964c7 (запись
 * дня/HOME), 80b31f7a (переименование). Дата принадлежности записи вычисляется в
 * поясе наблюдателя (ADR времени 994d076a).
 */

import type { ChronicleRow, ChronicleTarget, SortOrder } from '@etn/shared';

import { BARE_DATE_RE, addDays, mondayIndex, pad2, todayLocal } from '../../lib/dates.js';

// Общие чистые примитивы дат живут в `lib/dates.ts` (перенос календаря в
// библиотеку, приёмка №5). Реэкспорт сохраняет прежние точки импорта у
// потребителей (`addDays`/`isoWeekNumber`/`todayLocal` из этого модуля).
export { addDays, isoWeekNumber, todayLocal } from '../../lib/dates.js';

/** Голова глобального токена даты периода (0.10.1, требование 91f8d8dd). */
const TOKEN_HEAD_RE =
  /^\$(today|now|week\.start|week\.end|month\.start|month\.end|year\.start|year\.end)/;
/** Хвостовая арифметика токена: `±Nd` / `±Nw` / `±Nmo` / `±Ny`. */
const TOKEN_ARITH_RE = /^([+-])(\d+)(mo|y|w|d)$/;

/** Один день ленты: локальная дата `YYYY-MM-DD` и записи, видимые в этот день. */
export interface DiaryDay {
  day: string;
  rows: ChronicleRow[];
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
  if (isPeriodToken(value)) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Является ли строка глобальным токеном даты периода (новая грамматика). */
export function isPeriodToken(text: string): boolean {
  return TOKEN_HEAD_RE.test(text.trim());
}

/**
 * Раскрыть глобальный токен даты относительно локального дня наблюдателя
 * (`today`) — зеркало серверного раскрытия для подсветки календаря. Неделя
 * начинается с понедельника; месячная арифметика сдвигает ЯКОРЬ месяца
 * (границы — первое/последнее число нужного месяца). `''` — не токен.
 */
export function resolveDateToken(text: string, today: string = todayLocal()): string {
  const value = text.trim();
  const head = TOKEN_HEAD_RE.exec(value);
  if (head === null) return '';
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
  switch (head[1]) {
    case 'today':
    case 'now':
      return addMonths(addDays(today, days), months);
    case 'week.start': {
      const monday = addDays(today, -mondayIndex(today));
      return addMonths(addDays(monday, days), months);
    }
    case 'week.end': {
      const sunday = addDays(today, 6 - mondayIndex(today));
      return addMonths(addDays(sunday, days), months);
    }
    case 'month.start': {
      const first = `${today.slice(0, 7)}-01`;
      return addDays(addMonths(first, months), days);
    }
    case 'month.end': {
      const first = `${today.slice(0, 7)}-01`;
      // Арифметика месяцев — по ЯКОРЮ месяца, затем берётся последнее число.
      return addDays(monthEdge(addMonths(first, months), 'end'), days);
    }
    case 'year.start': {
      const first = `${today.slice(0, 4)}-01-01`;
      return addDays(addMonths(first, months), days);
    }
    case 'year.end': {
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
function addMonths(day: string, n: number): string {
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
function monthEdge(firstOfMonth: string, edge: 'start' | 'end'): string {
  const m = BARE_DATE_RE.exec(firstOfMonth.trim());
  if (m === null) return '';
  if (edge === 'start') return firstOfMonth;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
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
  if (isPeriodToken(text)) return resolveDateToken(text, today);
  return localDay(text);
}

/**
 * Суббота или воскресенье для локального дня `YYYY-MM-DD` (0.10.2, задача
 * 41ed99ab): заголовок группы выходного дня красится отдельным токеном
 * `--cal-weekend`. Праздники сверх сб/вс не учитываются. Неразобранный день —
 * не выходной.
 */
export function isWeekend(day: string): boolean {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

/**
 * Обратное преобразование периода календаря в значения полей панели
 * (требование 91f8d8dd, элемент 55b07702): клик по дате/неделе пытается
 * распознать ШАБЛОН и записать токены, а не точные даты:
 *
 *  * один день, равный сегодня → `$today`/`$today`;
 *  * одиночный день не сегодня → день-арифметика `$today±Nd` на обеих границах;
 *  * ровно эта/прошлая/будущая неделя (пн…вс) → `$week.start`/`$week.end`
 *    с оффсетом `±1w`;
 *  * ровно этот/прошлый/будущий месяц → `$month.start`/`$month.end` с `±1mo`;
 *  * ровно этот/прошлый/будущий год → `$year.start`/`$year.end` с `±1y`;
 *  * иначе (произвольный интервал) → день-арифметика `$today±Nd` на «С» и «По»
 *    (правило режима «Пресеты», приёмка №2 0.10.1).
 */
export function periodTokensForRange(
  from: string,
  to: string,
  today: string = todayLocal(),
): PeriodRange {
  if (from === '' && to === '') return { from: '', to: '' };
  if (from === to) {
    const token = dayOffsetToken(from, today);
    return { from: token, to: token };
  }

  const weekAnchors: Array<{ from: string; to: string; f: string; t: string }> = [
    { f: '$week.start', t: '$week.end', ...weekPeriod(today) },
    { f: '$week.start-1w', t: '$week.end-1w', ...weekPeriod(addDays(today, -7)) },
    { f: '$week.start+1w', t: '$week.end+1w', ...weekPeriod(addDays(today, 7)) },
  ];
  for (const w of weekAnchors) {
    if (from === w.from && to === w.to) return { from: w.f, to: w.t };
  }
  const monthAnchors: Array<{ from: string; to: string; f: string; t: string }> = [
    { f: '$month.start', t: '$month.end', ...monthPeriod(today) },
    { f: '$month.start-1mo', t: '$month.end-1mo', ...monthPeriod(addMonths(today, -1)) },
    { f: '$month.start+1mo', t: '$month.end+1mo', ...monthPeriod(addMonths(today, 1)) },
  ];
  for (const mo of monthAnchors) {
    if (from === mo.from && to === mo.to) return { from: mo.f, to: mo.t };
  }
  const yearAnchors: Array<{ from: string; to: string; f: string; t: string }> = [
    { f: '$year.start', t: '$year.end', ...yearPeriod(today) },
    { f: '$year.start-1y', t: '$year.end-1y', ...yearPeriod(addMonths(today, -12)) },
    { f: '$year.start+1y', t: '$year.end+1y', ...yearPeriod(addMonths(today, 12)) },
  ];
  for (const y of yearAnchors) {
    if (from === y.from && to === y.to) return { from: y.f, to: y.t };
  }
  // Произвольный интервал — день-арифметика относительно сегодня на обеих границах.
  return { from: dayOffsetToken(from, today), to: dayOffsetToken(to, today) };
}

/** Период года (1 января — 31 декабря) для дня `day`. */
function yearPeriod(day: string): PeriodRange {
  return { from: `${day.slice(0, 4)}-01-01`, to: `${day.slice(0, 4)}-12-31` };
}

/**
 * Токен одиночного дня относительно сегодня по правилу режима «Пресеты»:
 * сегодня → `$today`, иначе `$today±Nd` (день-арифметика). Неразобранный день
 * возвращается как есть.
 */
export function dayOffsetToken(day: string, today: string = todayLocal()): string {
  const diff = dayDiff(day, today);
  if (diff === null) return day;
  if (diff === 0) return '$today';
  return diff > 0 ? `$today+${diff}d` : `$today-${-diff}d`;
}

/** Разница в сутках `day - base` (UTC); `null` — дата не разобралась. */
function dayDiff(day: string, base: string): number | null {
  const a = BARE_DATE_RE.exec(day.trim());
  const b = BARE_DATE_RE.exec(base.trim());
  if (a === null || b === null) return null;
  const ms =
    Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3])) -
    Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round(ms / 86_400_000);
}

/** Режим панельного периода (приёмка №2, 0.10.1): «Пресеты» или «Даты». */
export type PeriodEditMode = 'presets' | 'dates';

/**
 * Привести ОДНУ границу периода к полному UTC-инстансу для запроса ленты:
 * токен → ЛОКАЛЬНАЯ календарная дата наблюдателя (тот же вычислитель, что и
 * для подсветки календаря, {@link resolveDateToken}), «голая дата» — локальная
 * календарная дата, полный инстанс — как есть; затем дата раскрывается в
 * начало (`edge: 'start'`) или конец (`edge: 'end'`) ЛОКАЛЬНЫХ суток. `''` —
 * граница не задана.
 */
export function resolvePeriodBoundForQuery(
  value: string,
  edge: 'start' | 'end',
  today: string = todayLocal(),
): string {
  const text = value.trim();
  if (text === '') return '';
  const day = isPeriodToken(text) ? resolveDateToken(text, today) : text;
  if (day === '') return '';
  // Полный инстанс (переход к записи) — как есть; «голая дата» — локальные сутки.
  if (BARE_DATE_RE.exec(day) === null) return day;
  return edge === 'start' ? localDayStart(day) : localDayEnd(day);
}

/**
 * Границы периода для ЗАПРОСА ленты (0.10.1, приёмка №4, задача fd9eef49):
 * каждая граница приводится к полному UTC-инстансу ЛОКАЛЬНЫХ суток наблюдателя
 * («с» — начало локального дня, «по» — конец `23:59:59.999`).
 *
 * Зачем: день принадлежности записи клиент считает в ЛОКАЛЬНОМ поясе (ADR
 * времени 994d076a, требование d58aa1a4) и группирует ленту по локальным дням.
 * Серверное раскрытие токена и «голая дата» опираются на UTC-сутки (требование
 * 469d8d69) и запись у локальной полуночи не покрывают: запись за 26.09 по
 * Москве хранится как `2026-09-25T21:00Z` и «выпадала» из своего дня, оставаясь
 * видимой в неделе. Полные инстансы передаются серверу как есть (469d8d69:
 * «полный инстанс — как есть») и согласованы с подсветкой календаря.
 * Сохранённый отбор по-прежнему хранит токен; раскрытие — в момент применения
 * (требование 91f8d8dd).
 */
export function resolvePeriodForQuery(
  from: string,
  to: string,
  today: string = todayLocal(),
): PeriodRange {
  return {
    from: resolvePeriodBoundForQuery(from, 'start', today),
    to: resolvePeriodBoundForQuery(to, 'end', today),
  };
}

/**
 * Значения полей периода для интервала календаря с учётом режима панели:
 * `dates` — точные даты без токенов; `presets` — токены по правилу
 * {@link periodTokensForRange}.
 */
export function periodValuesForRange(
  from: string,
  to: string,
  today: string = todayLocal(),
  mode: PeriodEditMode = 'presets',
): PeriodRange {
  if (mode === 'dates') return { from, to };
  return periodTokensForRange(from, to, today);
}

/** Период месяца (первое — последнее число) для дня `day`. */
function monthPeriod(day: string): PeriodRange {
  const first = `${day.slice(0, 7)}-01`;
  return { from: first, to: monthEdge(first, 'end') };
}

/**
 * Дата по умолчанию новой записи дневника: `clamp(сегодня, начало, конец
 * периода)` — требование 26f0aa52. Пустые границы не ограничивают.
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
 * Сравнение двух локальных дней `YYYY-MM-DD` по направлению сортировки
 * (0.10.1, итерация приёмки №8, п.3). Одна точка правды для группировки ленты
 * (вставки дня в ленту нет с демонтажом слотовой псевдозаписи).
 */
export function compareDays(a: string, b: string, order: SortOrder = 'asc'): number {
  if (a === b) return 0;
  const asc = a < b ? -1 : 1;
  return order === 'desc' ? -asc : asc;
}

/**
 * Заголовок группы дат ленты в локальной зоне наблюдателя: «Четверг, 24 сентября
 * 2026» (0.10.1, итерация приёмки №8, п.5). Собирается из частей вручную:
 * `Intl` с `year: 'numeric'` дописывает «г.» («24 сентября 2026 г.»), а в
 * заголовке год нужен без него. Год берётся у самого `Date`, месяц — `Intl`
 * (длинное имя в нужном падеже).
 */
export function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(d);
  const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(d);
  const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${cap}, ${dayMonth} ${d.getFullYear()}`;
}

/**
 * Класс записи (0.10.1, требование c6ddc1ea): `0` — все привязки записи — это
 * HOME («запись дня»), `1` — есть хотя бы одна привязка вне HOME (мысль или
 * связь). Локальная строка (`localRowFromComment`) уже отбрасывает HOME из
 * `targets`, поэтому у неё класс 0 = пустой список привязок; для серверных
 * строк HOME приходит в `targets` и сверяется с `homeId`.
 */
export function recordClass(row: ChronicleRow, homeId: string | null = null): 0 | 1 {
  const isHomeOnly = row.targets.every(
    (target) =>
      target.kind === 'thought' && homeId !== null && target.thought.id === homeId,
  );
  return isHomeOnly ? 0 : 1;
}

/**
 * Порядок записей ленты (требование c6ddc1ea): класс записи ВСЕГДА по
 * возрастанию (0 первыми) — направление к нему НЕ применяется; затем
 * `valid_from` → `valid_to` → `created_at` → `id` в направлении `order`.
 * Та же модель, что у серверного `ORDER BY`, — клиентская локальная вставка не
 * расходится с порядком страницы.
 */
export function compareRecords(
  a: ChronicleRow,
  b: ChronicleRow,
  order: SortOrder = 'asc',
  homeId: string | null = null,
): number {
  const cls = recordClass(a, homeId) - recordClass(b, homeId);
  if (cls !== 0) return cls;
  const dir = order === 'desc' ? -1 : 1;
  const byDate = a.valid_from === b.valid_from ? 0 : a.valid_from < b.valid_from ? -1 : 1;
  if (byDate !== 0) return byDate * dir;
  const at = a.valid_to ?? '';
  const bt = b.valid_to ?? '';
  const byTo = at === bt ? 0 : at < bt ? -1 : 1;
  if (byTo !== 0) return byTo * dir;
  const byCreated = a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? -1 : 1;
  if (byCreated !== 0) return byCreated * dir;
  if (a.id === b.id) return 0;
  return (a.id < b.id ? -1 : 1) * dir;
}

/**
 * Вставить строку в локальный список ленты (0.10.1, итерация приёмки №8, п.2 и
 * №9, п.1): локально созданная запись встаёт на своё место без полной
 * перерисовки, по тому же порядку, что серверный (`compareRecords`): класс
 * записи — всегда первым, затем даты/тайбрейкеры в направлении отбора.
 * Поэтому запись дня (класс 0) при «убывании» всё равно попадает в верхний
 * блок своего дня, а не в конец списка.
 */
export function insertRowByDay(
  list: readonly ChronicleRow[],
  row: ChronicleRow,
  order: SortOrder = 'asc',
  homeId: string | null = null,
): ChronicleRow[] {
  const out = [...list];
  let i = 0;
  while (i < out.length && compareRecords(out[i]!, row, order, homeId) <= 0) i += 1;
  out.splice(i, 0, row);
  return out;
}

/**
 * Группировка записей по локальным дням наблюдателя. Порядок записей внутри дня
 * — серверный (класс → `valid_from` → `valid_to` → `created_at` → `id`,
 * требование c6ddc1ea): клиент его не пересортировывает, а сохраняет порядок
 * входа (сервер уже отдал строки в выбранном направлении). Дни сортируются по
 * `order` (0.10.1, итерация приёмки №8, п.3: «Убывание» — дни по убыванию,
 * записи внутри — серверный порядок выбранного направления). `from`/`to` —
 * развёрнутые границы периода (см. {@link resolvePeriodDay}).
 */
export function groupByLocalDays(
  rows: readonly ChronicleRow[],
  opts: { from?: string; to?: string; order?: SortOrder } = {},
): DiaryDay[] {
  const from = opts.from ?? '';
  const to = opts.to ?? '';
  const order = opts.order ?? 'asc';
  const byDay = new Map<string, ChronicleRow[]>();
  for (const row of rows) {
    for (const day of rowDays(row, from, to)) {
      const bucket = byDay.get(day);
      if (bucket === undefined) byDay.set(day, [row]);
      else bucket.push(row);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => compareDays(a[0], b[0], order))
    .map(([day, list]) => ({ day, rows: list }));
}

/**
 * Забрать страницы ленты до глубины `depth` (0.10.2, ошибка f5809943).
 *
 * Refresh ТЕКУЩЕГО вида (правка записи, fallback realtime) обязан сохранять уже
 * загруженную глубину: полный перезапрос только первой страницы терял
 * дозагруженные «+50», состав ленты укорачивался, и позицию прокрутки держать
 * становилось нечем (keyed-сверка снимает лишние узлы → клампинг `scrollTop`).
 * Запросы идут до `max(pageSize, depth)` и не дальше `total`; страницы
 * собираются ДО единственной перерисовки ленты — промежуточный рендер усечённого
 * состава успел бы сбросить прокрутку.
 *
 * `fetchPage(offset, limit)` отдаёт очередную страницу в текущем отборе и
 * порядке. Остановка — на пустой странице (сервер отдал меньше `total`) либо
 * при достижении `total`. Смена критериев не терпит этой глубины: сброс на
 * первую страницу — вызывающий передаёт `depth = pageSize`.
 */
export async function collectRowsToDepth<T>(
  depth: number,
  pageSize: number,
  fetchPage: (offset: number, limit: number) => Promise<{ rows: T[]; total: number }>,
): Promise<{ rows: T[]; total: number }> {
  const target = Math.max(pageSize, depth);
  const first = await fetchPage(0, pageSize);
  let rows = first.rows;
  let total = first.total;
  while (rows.length < target && rows.length < total) {
    const page = await fetchPage(rows.length, pageSize);
    if (page.rows.length === 0) break;
    rows = [...rows, ...page.rows];
    total = page.total;
  }
  return { rows, total };
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

/**
 * Задержка применения строки поиска «Дневника» (0.10.1, T7): ввод-критерий
 * применяется не на каждое нажатие, а через паузу — как живой поиск клиента.
 */
export const SEARCH_DEBOUNCE_MS = 300;

/** Начало локального дня наблюдателя как полный UTC-инстанс. */
export function localDayStart(day: string): string {
  const m = BARE_DATE_RE.exec(day.trim());
  if (m === null) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Конец локального дня наблюдателя как полный UTC-инстанс (включительно). */
export function localDayEnd(day: string): string {
  const m = BARE_DATE_RE.exec(day.trim());
  if (m === null) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * Период панели для перехода к записи (0.10.1, T7; элемент «Поиск в
 * дневниковой ленте»): диапазон записи `valid_from`/`valid_to`, развёрнутый в
 * ЛОКАЛЬНЫЕ сутки наблюдателя — точечная запись даёт одни сутки. Границы —
 * полные UTC-инстансы начала/конца локального дня, поэтому запись у полуночи
 * не выпадает из UTC-суток, а лента показывает весь её день. `''` — дата не
 * разобралась.
 */
export function recordPeriod(row: {
  valid_from: string;
  valid_to: string | null;
}): PeriodRange {
  let from = localDay(row.valid_from);
  let to = row.valid_to !== null ? localDay(row.valid_to) : from;
  if (from === '') return { from: '', to: '' };
  if (to === '') to = from;
  if (to < from) [from, to] = [to, from];
  return { from: localDayStart(from), to: localDayEnd(to) };
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

/**
 * Есть ли в ленте строка с таким id. Дедуп локальной вставки созданной записи
 * (ошибка 0757cd08, круг 1): строку могла вставить другая ветка (realtime-
 * событие, перезагрузка/сверка), пока шло создание. Повторная вставка даёт
 * ленте два узла с одним ключом и роняет `reconcileKeyed`.
 */
export function hasRowId(rows: readonly { id: string }[], id: string): boolean {
  return rows.some((row) => row.id === id);
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
 * Мысли-владельцы записи (родители новой мысли, ТЗ5 «Дневник без псевдослота»):
 * все её цели-чипсы. Для чипса-связи берётся источник (мысль, к которой
 * привязан комментарий связи — как в `wiki-link-create`), дубли схлопываются.
 */
export function parentThoughtIds(targets: readonly ChronicleTarget[]): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    const id = target.kind === 'thought' ? target.thought.id : target.link.source.id;
    if (id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Владелец файлового вложения для вставки картинки из буфера в правку
 * комментария записи (0.10.1, итерация приёмки №10, задача 197b3b05; ошибка
 * 8f090884). Паритет с постоянным комментарием мысли: цель вложения — первая
 * ПРИВЯЗАННАЯ МЫСЛЬ записи (первый thought-чипс среди видимых привязок); если
 * среди привязок мыслей нет (пусто или только чипсы-связи) — первичный
 * владелец записи HOME. `null` — ни привязок, ни HOME (вложение невозможно).
 */
export function attachmentOwnerForRow(
  targets: readonly ChronicleTarget[],
  homeId: string | null,
): { ownerType: 'thought'; ownerId: string } | null {
  for (const target of visibleChips(targets, homeId)) {
    if (target.kind === 'thought') {
      return { ownerType: 'thought', ownerId: target.thought.id };
    }
  }
  if (homeId !== null) return { ownerType: 'thought', ownerId: homeId };
  return null;
}
