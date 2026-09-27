/**
 * «Редактор периода» — библиотечный контрол ввода даты/периода
 * (0.10.1, задача T5 740b8045; элемент интерфейса «Поле периода» 2f14de06;
 * ADR d4d53fe6 «редактор периода — новый библиотечный модуль»; требование
 * 91f8d8dd «Динамические токены дат в периоде…»; стандарт библиотечности
 * a2488f05).
 *
 * **За что отвечает.** Один контрол на три места ввода периода: лента
 * «Дневника», панель отбора и вкладка «Дневник» редактора. Три режима:
 *  * `date`     — одна дата (умолчание): заполняет обе границы;
 *  * `datetime` — одна дата + время суток (часы:минуты);
 *  * `range`    — диапазон: начало и конец, время опционально в каждой границе.
 *
 * **Значение.** Граница — «голая дата» `YYYY-MM-DD` (сутки UTC — нормализует
 * сервер), полный UTC-инстанс ISO-8601 (когда задано время) либо динамический
 * токен (`$today`, `$now`, арифметика `±Nd`). Полный инстанс строится по
 * ЛОКАЛЬНОМУ времени наблюдателя и уходит в UTC (ADR времени 994d076a: «день
 * принадлежности записи вычисляет клиент в локальном поясе»).
 *
 * **Токены.** Только глобальные (`$today`/`$now` с арифметикой `±Nd`) —
 * токен `$thought.*` требует контекста мысли, которого у периода нет, и
 * отвергается (требование 91f8d8dd, уточнение T3). Ввод токена — выбором из
 * подсказок общей выпадашки (`lib/suggest-dropdown.ts`), а не «голым текстом»;
 * синтаксис проверяется на клиенте ({@link validatePeriodToken}).
 *
 * **Не применяет себя.** Контрол лишь сообщает значение через `onChange` —
 * применение (перезапрос ленты, сохранение записи) делает потребитель.
 *
 * **Время (ADR 994d076a).** Смена только даты сохраняет время суток; правка
 * часов:минут сохраняет секунды и миллисекунды (`setInstantTime`); смена
 * режима сохраняет время суток.
 *
 * Контрол собирается из единых фасадов: поле — `lib/ui/field.ts`, режим —
 * `lib/ui/segmented.ts`, подсказки — `lib/suggest-dropdown.ts`. Свои
 * выпадашка/поле не пишутся (сторожи `guard-suggest-dropdown`,
 * `guard-ui-fields`); полноценные поля дат периода вне этого модуля запрещены
 * (сторож `guard-period-editor`).
 */

import { div, el, span } from './dom.js';
import { optionsSuggestSource, wireSuggest, type SuggestHandle } from './suggest-dropdown.js';
import { fieldInput } from './ui/field.js';
import { segmentedControl } from './ui/segmented.js';

// ---------------------------------------------------------------------------
// Контракт значения
// ---------------------------------------------------------------------------

/** Режим контрола периода. */
export type PeriodMode = 'date' | 'datetime' | 'range';

/** Режим панельного варианта: «Пресеты» (токены) или «Даты» (точные даты). */
export type PeriodPanelMode = 'presets' | 'dates';

/** Типизированное значение периода (форма API элемента «Поле периода»). */
export interface PeriodValue {
  /** Начало периода: дата, полный UTC-инстанс или токен. Пусто — не задано. */
  from?: string;
  /** Конец периода (режим `range`); форма значения — как у {@link from}. */
  to?: string;
  /** Значение несёт время суток (режим `datetime` либо заполненное время в `range`). */
  hasTime?: boolean;
  /**
   * Динамический токен, если весь период задан одним токеном (однозначные
   * режимы `date`/`datetime`). В `range` границы-токены живут в `from`/`to`.
   */
  token?: string;
  /**
   * Режим панельного варианта (0.10.1, приёмка №2): «Пресеты» или «Даты».
   * В варианте `editor` не заполняется.
   */
  mode?: PeriodPanelMode;
}

/** Опции {@link buildPeriodEditor}. */
export interface PeriodEditorOptions {
  /** Режим при построении; по умолчанию `date`. */
  mode?: PeriodMode;
  /** Начальное значение; `null`/отсутствие — пустой период. */
  value?: PeriodValue | null;
  /** Сообщение о новом значении (контрол сам ничего не применяет). */
  onChange?: (value: PeriodValue) => void;
  /** Доступное имя контрола (для `aria-label`). */
  label?: string;
  /** Разрешить динамические токены дат (по умолчанию — да). */
  allowTokens?: boolean;
  /** Токены-кандидаты подсказок; по умолчанию — {@link PERIOD_TOKEN_PRESETS}. */
  tokenOptions?: readonly string[];
  /**
   * Вариант контрола. `editor` (по умолчанию) — с переключателем режимов
   * «Дата / Дата и время / Диапазон» (вкладка записи и лента). `panel` —
   * панельный вариант элемента «Поле периода» (0.10.1, приёмка №3): всегда
   * диапазон «с»–«по», БЕЗ часов/минут, со своим переключателем
   * «Пресеты»/«Даты». В режиме «Пресеты» каждая граница — комбобокс базовых
   * пресетов и компактный сдвиг ±N/единица; поле показывает человекочитаемую
   * композицию, наружу уходит канонический токен. «Даты» — точные даты.
   */
  variant?: 'editor' | 'panel';
  /** Начальный режим панельного варианта (по умолчанию `presets`). */
  panelMode?: PeriodPanelMode;
  /**
   * Раскрыть токен периода в локальную дату (переход «Пресеты» → «Даты»).
   * Без резолвера токен остаётся текстом поля. Задаёт вызывающий (единый
   * клиентский вычислитель токенов), чтобы язык не дублировался здесь.
   */
  resolveToken?: (token: string) => string;
  /**
   * Записать интервал в токены по правилу «Пресетов» (переход «Даты» →
   * «Пресеты»). Без него точные даты остаются как есть.
   */
  tokensForRange?: (from: string, to: string) => { from: string; to: string };
  /** Поле и переключатель недоступны. */
  disabled?: boolean;
  /**
   * Панельный вариант, режим «Даты» (0.10.1, приёмка №5): клик по полю даты
   * открывает диалог «Дата/период» (период разрешён, время — нет). Задано —
   * нативные поля дат заменяются кликабельными (только чтение), а контрол сам
   * применяет возвращённые даты и сообщает значение. Диалог строит потребитель
   * (`lib/date-period-dialog.ts`), модуль периода его не импортирует.
   */
  openDatesDialog?: (current: {
    from: string;
    to: string;
  }) => Promise<{ from: string; to: string } | null>;
}

/** Рукоятка построенного контрола. */
export interface PeriodEditorHandle {
  /** Корневой узел контрола. */
  root: HTMLElement;
  /** Текущий режим. */
  getMode(): PeriodMode;
  /** Сменить режим (значения и время суток сохраняются по возможности). */
  setMode(mode: PeriodMode): void;
  /** Текущее значение. */
  getValue(): PeriodValue;
  /** Записать значение (режим не меняется). */
  setValue(value: PeriodValue | null): void;
  /** Режим панельного варианта («Пресеты»/«Даты»); в `editor` — всегда `presets`. */
  getPanelMode(): PeriodPanelMode;
  /** Сменить режим панельного варианта (с конверсией значений, если возможно). */
  setPanelMode(mode: PeriodPanelMode): void;
  /** Ошибки валидации введённых дат/токенов (пусто — всё корректно). */
  errors(): string[];
  /** Снять оконные слушатели выпадашки (при разборе контрола). */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Чистые помощники (экспортируются для тестов и потребителей)
// ---------------------------------------------------------------------------

/**
 * Глобальный токен даты периода: `$today`/`$now`, границы недели/месяца/года
 * (`$week.start`/`$week.end`/`$month.start`/`$month.end`/`$year.start`/`$year.end`),
 * необязательная арифметика `±N<unit>` — `d` (дни), `w` (недели), `mo`
 * (календарные месяцы), `y` (календарные годы).
 * Только эта форма допустима в периоде: контекстных токенов `$thought.*` у
 * периода нет (требование 91f8d8dd).
 */
export const GLOBAL_DATE_TOKEN_RE =
  /^\$(?:today|now|week\.(?:start|end)|month\.(?:start|end)|year\.(?:start|end))(?:(?:[+-])\d+(?:d|w|mo|y))?$/;

/** Является ли строка допустимым глобальным токеном даты периода. */
export function isGlobalDateToken(text: string): boolean {
  return GLOBAL_DATE_TOKEN_RE.test(text.trim());
}

/**
 * Токены-кандидаты для подсказок контрола: глобальные токены и типовые
 * смещения. Значения — ровно то, что уйдёт строкой на сервер.
 */
export const PERIOD_TOKEN_PRESETS: readonly { text: string; label: string }[] = [
  { text: '$today', label: '$today — сегодня' },
  { text: '$now', label: '$now — текущий момент' },
  { text: '$today+1d', label: '$today+1d — завтра' },
  { text: '$today-1d', label: '$today-1d — вчера' },
  { text: '$week.start', label: '$week.start — начало недели (пн)' },
  { text: '$week.end', label: '$week.end — конец недели (вс)' },
  { text: '$week.start-1w', label: '$week.start-1w — начало прошлой недели' },
  { text: '$week.start+1w', label: '$week.start+1w — начало будущей недели' },
  { text: '$month.start', label: '$month.start — начало месяца' },
  { text: '$month.end', label: '$month.end — конец месяца' },
  { text: '$month.start-1mo', label: '$month.start-1mo — начало прошлого месяца' },
  { text: '$month.end+1mo', label: '$month.end+1mo — конец будущего месяца' },
  { text: '$year.start', label: '$year.start — начало года' },
  { text: '$year.end', label: '$year.end — конец года' },
  { text: '$year.start-1y', label: '$year.start-1y — начало прошлого года' },
  { text: '$year.end+1y', label: '$year.end+1y — конец будущего года' },
  { text: '$today+7d', label: '$today+7d — через неделю' },
  { text: '$today-7d', label: '$today-7d — неделю назад' },
  { text: '$today+30d', label: '$today+30d — через месяц' },
  { text: '$today-30d', label: '$today-30d — месяц назад' },
];

/**
 * Пресет-граница панельного варианта (0.10.1, приёмка №3, задача 9bef6a27):
 * каждая граница — КОМБОБКС базовых пресетов плюс компактный сдвиг ±N/единица.
 * Поле показывает ЧЕЛОВЕКОЧИТАЕМУЮ композицию опоры и сдвига («начало недели
 * − 1 нед»), а не токен; на сервер уходит канонический токен единого языка
 * (требование 91f8d8dd) — новых токенов виджет не вводит.
 */

/** Разобранная граница периода. */
export type ParsedBound =
  | { kind: 'empty' }
  | { kind: 'token'; value: string }
  | { kind: 'date'; value: string }
  | { kind: 'instant'; value: string }
  | { kind: 'invalid'; value: string };

/** «Голая дата» `YYYY-MM-DD`. */
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Полный ISO-8601-инстанс с явным поясом (`Z` или `±HH:MM`). */
const INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Реальная ли календарная дата `YYYY-MM-DD`. */
function isRealDate(iso: string): boolean {
  const m = BARE_DATE_RE.exec(iso);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  );
}

/** Разобрать строку границы: токен, «голая дата», полный инстанс или ошибка. */
export function parseBound(text: string): ParsedBound {
  const value = text.trim();
  if (value === '') return { kind: 'empty' };
  if (isGlobalDateToken(value)) return { kind: 'token', value };
  if (BARE_DATE_RE.test(value)) {
    return isRealDate(value) ? { kind: 'date', value } : { kind: 'invalid', value };
  }
  if (INSTANT_RE.test(value) && !Number.isNaN(new Date(value).getTime())) {
    return { kind: 'instant', value };
  }
  return { kind: 'invalid', value };
}

/**
 * Проверить синтаксис токена в строке границы. `null` — строка не содержит
 * токенов либо это ровно допустимый глобальный токен. Иначе — понятное
 * сообщение (в том числе для отвергаемых `$thought.*`).
 */
export function validatePeriodToken(text: string): string | null {
  const value = text.trim();
  if (!value.includes('$')) return null;
  if (isGlobalDateToken(value)) return null;
  return (
    `«${value}» — не токен периода: доступны $today/$now, $week.start/$week.end, ` +
    '$month.start/$month.end, $year.start/$year.end и арифметика ±Nd/±Nw/±Nmo/±Ny ' +
    '(токены $thought.* требуют контекста мысли).'
  );
}

/** Двузначная запись числа. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Локальная дата `YYYY-MM-DD` из полного инстанса (пусто — не разобрался). */
export function instantToLocalDate(instant: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Локальное время `HH:MM` из полного инстанса (пусто — не разобрался). */
export function instantToLocalTime(instant: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Заменить дату полного инстанса, СОХРАНИВ локальное время суток (часы, минуты,
 * секунды и миллисекунды) — ADR времени: «смена только даты сохраняет время».
 */
export function setInstantDate(instant: string, isoDate: string): string {
  const d = new Date(instant);
  const m = BARE_DATE_RE.exec(isoDate.trim());
  if (m === null || Number.isNaN(d.getTime())) return instant;
  d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toISOString();
}

/**
 * Заменить часы:минуты полного инстанса, СОХРАНИВ секунды и миллисекунды —
 * ADR времени: «правка часов:минут сохраняет секунды и миллисекунды».
 */
export function setInstantTime(instant: string, hhmm: string): string {
  const d = new Date(instant);
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (m === null || Number.isNaN(d.getTime())) return instant;
  d.setHours(Number(m[1]), Number(m[2]));
  return d.toISOString();
}

/**
 * Собрать полный UTC-инстанс из локальных даты и времени наблюдателя
 * (секунды/миллисекунды — нули). `''` — вход не разобрался.
 */
export function composeInstant(isoDate: string, hhmm: string): string {
  const dm = BARE_DATE_RE.exec(isoDate.trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (dm === null || tm === null) return '';
  const d = new Date(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
    0,
    0,
  );
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Одна граница значения периода → полный UTC-инстанс ('' — не задана). */
function resolveBoundInstant(raw: string | undefined, previous: string): string {
  if (raw === undefined || raw.trim() === '') return '';
  const parsed = parseBound(raw);
  if (parsed.kind === 'instant') return parsed.value;
  // «Голая дата» меняет только дату, время суток исходного инстанса остаётся
  // (ADR 994d076a). Токены здесь не раскрываются — потребитель с
  // `allowTokens: false` их не порождает.
  if (parsed.kind === 'date') return setInstantDate(previous, parsed.value);
  return '';
}

/**
 * Значение контрола периода → полные UTC-инстансы записи. «Голая дата» меняет
 * только дату, сохраняя время суток исходного инстанса (ADR 994d076a);
 * незаданный конец равен началу, поэтому `to` непуст (требование d58aa1a4:
 * `valid_to` NOT NULL). Потребители, которым нужны не даты, а инстансы
 * (вкладка «Дневник» редактора), применяют эту функцию вместо «сырого»
 * `getValue()`.
 *
 * @param value    значение из `getValue()`/`onChange`.
 * @param previous предыдущие инстансы записи — источник времени суток и даты
 *                 для незаполненных/частичных границ.
 */
export function resolvePeriodInstants(
  value: PeriodValue,
  previous: { from: string; to: string },
): { from: string; to: string } {
  const from = resolveBoundInstant(value.from, previous.from);
  const to = resolveBoundInstant(value.to, previous.to);
  const nextFrom = from !== '' ? from : previous.from;
  return { from: nextFrom, to: to !== '' ? to : nextFrom };
}

// ---------------------------------------------------------------------------
// Состояние одной границы
// ---------------------------------------------------------------------------

/**
 * Состояние границы: текст поля (голая дата или токен) + локальное время.
 * `instant` — исходный полный инстанс: хранит секунды/миллисекунды, которые
 * полагается сохранять при правке даты/времени (ADR времени).
 */
interface BoundState {
  text: string;
  time: string;
  instant: string | null;
}

function emptyBound(): BoundState {
  return { text: '', time: '', instant: null };
}

/** Заполнить границу из строки значения (дата/инстанс/токен). */
function boundFromValue(value: string | undefined): BoundState {
  const bound = emptyBound();
  if (value === undefined || value.trim() === '') return bound;
  const parsed = parseBound(value);
  if (parsed.kind === 'token' || parsed.kind === 'date') {
    bound.text = parsed.value;
  } else if (parsed.kind === 'instant') {
    bound.text = instantToLocalDate(parsed.value);
    bound.time = instantToLocalTime(parsed.value);
    bound.instant = parsed.value;
  } else if (parsed.kind === 'invalid') {
    // Непонятное значение сохраняем текстом — пользователь увидит и поправит.
    bound.text = parsed.value;
  }
  return bound;
}

/** Собрать строку значения границы ('' — пусто). */
function composeBound(bound: BoundState): string {
  const text = bound.text.trim();
  if (text === '') return '';
  if (isGlobalDateToken(text)) return text;
  const parsed = parseBound(text);
  if (parsed.kind === 'token') return parsed.value;
  if (parsed.kind === 'date') {
    if (bound.time === '') return parsed.value;
    const base = bound.instant !== null ? setInstantDate(bound.instant, parsed.value) : '';
    return base !== '' ? setInstantTime(base, bound.time) : composeInstant(parsed.value, bound.time);
  }
  if (parsed.kind === 'instant') {
    const time = bound.time !== '' ? bound.time : instantToLocalTime(parsed.value);
    return time !== '' ? setInstantTime(parsed.value, time) : parsed.value;
  }
  return parsed.kind === 'invalid' ? parsed.value : '';
}

/** Ошибка ввода границы (null — корректно). */
function boundError(bound: BoundState, allowTokens: boolean): string | null {
  const text = bound.text.trim();
  if (text === '') return null;
  if (text.includes('$') && !allowTokens) return 'Токены дат в этом поле отключены — укажите дату.';
  const tokenError = validatePeriodToken(text);
  if (tokenError !== null) return tokenError;
  if (parseBound(text).kind !== 'invalid') return null;
  return `«${text}» — ожидается ГГГГ-ММ-ДД, полный ISO-инстанс или токен ($today/$now, границы недели/месяца/года ± арифметика).`;
}

// ---------------------------------------------------------------------------
// Сборка контрола
// ---------------------------------------------------------------------------

/** Класс корня контрола. */
const ROOT_CLASS = 'pe-root';
/** Модификатор панельного варианта: раскладка границ колонкой (две строки). */
const PANEL_CLASS = 'pe-panel';
/** Класс контейнера полей. */
const FIELDS_CLASS = 'pe-fields';
/** Класс одной границы. */
const BOUND_CLASS = 'pe-bound';
/** Класс подписи границы («с»/«по»). */
const TAG_CLASS = 'pe-tag';
/** Класс поля даты/токена. */
const DATE_CLASS = 'pe-date-input';
/** Класс поля времени. */
const TIME_CLASS = 'pe-time-input';
/** Класс строки ошибки. */
const ERROR_CLASS = 'pe-error';
/** Класс переключателя режима панели («Пресеты»/«Даты»). */
const PANEL_MODE_CLASS = 'pe-mode';
/** Класс строки пресет-границы. */
const PRESET_BOUND_CLASS = 'pe-preset-bound';
/** Класс поля-комбобокса базового пресета (показывает композицию, не токен). */
const PRESET_ANCHOR_CLASS = 'pe-preset-anchor';
/** Класс каретки ▾ комбобокса базового пресета. */
const PRESET_CARET_CLASS = 'pe-preset-caret';
/** Класс поля числа арифметики пресета. */
const PRESET_NUM_CLASS = 'pe-preset-num';
/** Класс выпадашки единицы арифметики пресета. */
const PRESET_UNIT_CLASS = 'pe-preset-unit';

const MODE_ITEMS = [
  { id: 'date', label: 'Дата' },
  { id: 'datetime', label: 'Дата и время' },
  { id: 'range', label: 'Диапазон' },
] as const;

const PANEL_MODE_ITEMS = [
  { id: 'presets', label: 'Пресеты' },
  { id: 'dates', label: 'Даты' },
] as const;

/**
 * Базовые пресеты-опоры комбобокса панельной границы (0.10.1, приёмка №3):
 * сегодня; границы недели/месяца/года. `$now` — точный момент, оставлен для
 * совместимости прежде сохранённых отборов. Значение строки списка — токен
 * единого языка; в поле показывается человекочитаемая подпись, не токен.
 */
const PANEL_ANCHORS: readonly { id: string; label: string }[] = [
  { id: '$today', label: 'сегодня' },
  { id: '$now', label: 'сейчас' },
  { id: '$week.start', label: 'начало недели' },
  { id: '$week.end', label: 'конец недели' },
  { id: '$month.start', label: 'начало месяца' },
  { id: '$month.end', label: 'конец месяца' },
  { id: '$year.start', label: 'начало года' },
  { id: '$year.end', label: 'конец года' },
];

/** Единицы арифметики пресет-границы (код тока → краткая подпись). */
const PANEL_UNITS: readonly { id: string; label: string }[] = [
  { id: 'd', label: 'дн' },
  { id: 'w', label: 'нед' },
  { id: 'mo', label: 'мес' },
  { id: 'y', label: 'лет' },
];

/** Разбор панельного токена на опору и арифметику. */
interface PanelTokenParts {
  anchor: string;
  n: number;
  unit: string;
}

/** Разобрать панельный токен; `null` — строка не токен (дата/мусор). */
function parsePanelToken(text: string): PanelTokenParts | null {
  const value = text.trim();
  const head = /^\$(today|now|week\.start|week\.end|month\.start|month\.end|year\.start|year\.end)/.exec(
    value,
  );
  if (head === null) return null;
  const rest = value.slice(head[0].length);
  if (rest === '') return { anchor: head[0], n: 0, unit: 'd' };
  const m = /^([+-])(\d+)(mo|y|w|d)$/.exec(rest);
  if (m === null) return null;
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  return { anchor: head[0], n, unit: m[3]! };
}

/** Собрать панельный токен из опоры и арифметики (N = 0 — чистая опора). */
function composePanelToken(parts: PanelTokenParts): string {
  if (parts.n === 0) return parts.anchor;
  const sign = parts.n > 0 ? '+' : '-';
  return `${parts.anchor}${sign}${Math.abs(parts.n)}${parts.unit}`;
}

/** Человекочитаемая подпись базового пресета-опоры (неизвестная — как есть). */
export function panelAnchorLabel(anchor: string): string {
  return PANEL_ANCHORS.find((a) => a.id === anchor)?.label ?? anchor;
}

/**
 * Человекочитаемая композиция пресет-границы: «начало недели − 1 нед»,
 * «сегодня», «конец месяца + 2 мес». Токен в поле НЕ показывается никогда
 * (0.10.1, приёмка №3). Сдвиг `0` не выводится.
 */
export function composePanelLabel(parts: PanelTokenParts): string {
  const base = panelAnchorLabel(parts.anchor);
  if (parts.n === 0) return base;
  const unit = PANEL_UNITS.find((u) => u.id === parts.unit)?.label ?? parts.unit;
  // Минус — типографский U+2212: композиция читается как подпись, не как код.
  return `${base} ${parts.n > 0 ? '+' : '−'} ${Math.abs(parts.n)} ${unit}`;
}

/** Строит библиотечный контрол периода. */
export function buildPeriodEditor(opts: PeriodEditorOptions): PeriodEditorHandle {
  const allowTokens = opts.allowTokens !== false;
  const tokenPresets = opts.tokenOptions ?? PERIOD_TOKEN_PRESETS.map((t) => t.text);
  const panel = opts.variant === 'panel';

  // Панельный вариант — всегда диапазон «с»–«по» и без переключателя режимов
  // редактора; его собственный режим — «Пресеты»/«Даты».
  let mode: PeriodMode = panel ? 'range' : (opts.mode ?? 'date');
  let panelMode: PeriodPanelMode = opts.panelMode ?? 'presets';
  let from = emptyBound();
  let to = emptyBound();

  const root = div(ROOT_CLASS);
  // Панельный вариант — по строке на границу периода (0.10.1, приёмка №4):
  // модификатор корня, раскладка колонкой задана в CSS. Вариант `editor`
  // (даты записи, вкладка редактора) сохраняет однострочную раскладку.
  if (panel) root.classList.add(PANEL_CLASS);
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', opts.label ?? 'Период');

  let modes: ReturnType<typeof segmentedControl> | null = null;
  let panelModes: ReturnType<typeof segmentedControl> | null = null;
  if (!panel) {
    modes = segmentedControl({
      items: MODE_ITEMS.map((m) => ({ id: m.id, label: m.label })),
      activeId: mode,
      ariaLabel: 'Режим периода',
      size: 's',
      onChange: (id) => {
        applyMode(id as PeriodMode, true);
      },
    });
    root.append(modes.root);
  } else {
    panelModes = segmentedControl({
      items: PANEL_MODE_ITEMS.map((m) => ({ id: m.id, label: m.label })),
      activeId: panelMode,
      extraClass: PANEL_MODE_CLASS,
      ariaLabel: 'Режим периода: пресеты или даты',
      size: 's',
      onChange: (id) => {
        applyPanelMode(id as PeriodPanelMode);
      },
    });
    root.append(panelModes.root);
  }

  const fields = div(FIELDS_CLASS);
  root.append(fields);

  const suggestHandles: SuggestHandle[] = [];

  /** Значение из состояния. */
  const readValue = (): PeriodValue => {
    if (panel) {
      const fromValue = composeBound(from);
      const toValue = composeBound(to);
      const value: PeriodValue = { hasTime: false, mode: panelMode };
      if (fromValue !== '') value.from = fromValue;
      if (toValue !== '') value.to = toValue;
      return value;
    }
    if (mode === 'range') {
      const fromValue = composeBound(from);
      const toValue = composeBound(to);
      const value: PeriodValue = {};
      if (fromValue !== '') value.from = fromValue;
      if (toValue !== '') value.to = toValue;
      value.hasTime = from.time !== '' || to.time !== '';
      return value;
    }
    const single = composeBound(from);
    const value: PeriodValue = {};
    if (single !== '') {
      value.from = single;
      value.to = single;
      if (isGlobalDateToken(single)) value.token = single;
    }
    value.hasTime = mode === 'datetime';
    return value;
  };

  const emit = (): void => {
    opts.onChange?.(readValue());
  };

  /** Валидация всех видимых границ. */
  const errors = (): string[] => {
    const out: string[] = [];
    const first = boundError(from, allowTokens);
    if (first !== null) out.push(first);
    if (panel || mode === 'range') {
      const second = boundError(to, allowTokens);
      if (second !== null) out.push(second);
    }
    return out;
  };

  /** Поле даты/токена одной границы. */
  const buildDateField = (bound: BoundState, ariaLabel: string): HTMLInputElement => {
    const input = fieldInput({
      extraClass: DATE_CLASS,
      value: bound.text,
      placeholder: allowTokens ? 'ГГГГ-ММ-ДД или $today…' : 'ГГГГ-ММ-ДД',
      ariaLabel,
      disabled: opts.disabled === true,
    });
    input.type = 'text';
    const commit = (): void => {
      const parsed = parseBound(input.value);
      if (parsed.kind === 'instant') {
        bound.text = instantToLocalDate(parsed.value);
        bound.time = instantToLocalTime(parsed.value);
        bound.instant = parsed.value;
        input.value = bound.text;
      } else {
        bound.text = input.value.trim();
        if (!isGlobalDateToken(bound.text)) bound.instant = null;
      }
      repaint();
      emit();
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    if (allowTokens) {
      const handle = wireSuggest(input, {
        sources: [optionsSuggestSource(tokenPresets, { header: 'Токены' })],
        pickFirstOnEnter: false,
        onPick: (entry) => {
          input.value = entry.value;
          commit();
        },
      });
      suggestHandles.push(handle);
    }
    return input;
  };

  /** Поле времени одной границы. */
  const buildTimeField = (bound: BoundState, ariaLabel: string): HTMLInputElement => {
    const input = fieldInput({
      type: 'time',
      extraClass: TIME_CLASS,
      value: bound.time,
      ariaLabel,
      disabled: opts.disabled === true,
    });
    const commit = (): void => {
      bound.time = input.value;
      repaint();
      emit();
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    return input;
  };

  /** Одна граница: подпись + дата(+время) + строка ошибки. */
  const buildBound = (bound: BoundState, tag: string | null, ariaPrefix: string): HTMLElement => {
    const box = div(BOUND_CLASS);
    if (tag !== null) box.append(span(tag, TAG_CLASS));
    box.append(buildDateField(bound, `${ariaPrefix} — дата`));
    if (mode === 'datetime') {
      box.append(buildTimeField(bound, `${ariaPrefix} — время`));
    } else if (mode === 'range') {
      box.append(buildTimeField(bound, `${ariaPrefix} — время (необязательно)`));
    }
    const error = boundError(bound, allowTokens);
    if (error !== null) box.append(span(error, ERROR_CLASS));
    return box;
  };

  /** Полная перерисовка полей (режим/состояние). */
  const repaint = (): void => {
    // Поля пересобираются — снимаем выпадашки прошлой сборки (иначе их
    // оконные слушатели копились бы на каждой смене режима/значения).
    for (const handle of suggestHandles) handle.dispose();
    suggestHandles.length = 0;
    fields.replaceChildren();
    if (panel) {
      fields.append(
        panelMode === 'dates'
          ? buildPanelDateBound(from, 'с', 'Начало')
          : buildPanelPresetBound(from, 'с', 'Начало'),
        panelMode === 'dates'
          ? buildPanelDateBound(to, 'по', 'Конец')
          : buildPanelPresetBound(to, 'по', 'Конец'),
      );
      return;
    }
    if (mode === 'range') {
      fields.append(buildBound(from, 'с', 'Начало'), buildBound(to, 'по', 'Конец'));
    } else {
      fields.append(buildBound(from, null, 'Дата'));
    }
  };

  /** Граница режима «Даты» панели: только дата, без времени и токенов. */
  function buildPanelDateBound(bound: BoundState, tag: string, ariaPrefix: string): HTMLElement {
    const box = div(BOUND_CLASS);
    box.append(span(tag, TAG_CLASS));
    // Приёмка №5: клик по полю даты открывает диалог «Дата/период» (без
    // времени, с периодом). Поле — только чтение, нативный ввод убран.
    if (opts.openDatesDialog !== undefined) {
      const display = fieldInput({
        extraClass: DATE_CLASS,
        value: dateOnly(bound.text),
        readonly: true,
        ariaLabel: `${ariaPrefix} — дата`,
        disabled: opts.disabled === true,
      });
      display.type = 'text';
      display.title = 'Открыть диалог даты/периода';
      display.addEventListener('click', () => {
        void opts.openDatesDialog!({
          from: dateOnly(from.text),
          to: dateOnly(to.text),
        }).then((result) => {
          if (result === null) return;
          from.text = result.from;
          to.text = result.to;
          from.time = '';
          to.time = '';
          from.instant = null;
          to.instant = null;
          repaint();
          emit();
        });
      });
      box.append(display);
      return box;
    }
    const input = fieldInput({
      type: 'date',
      extraClass: DATE_CLASS,
      value: dateOnly(bound.text),
      ariaLabel: `${ariaPrefix} — дата`,
      disabled: opts.disabled === true,
    });
    input.addEventListener('change', () => {
      bound.text = input.value.trim();
      bound.time = '';
      bound.instant = null;
      emit();
    });
    box.append(input);
    const error = boundError(bound, false);
    if (error !== null) box.append(span(error, ERROR_CLASS));
    return box;
  }

  /**
   * Граница режима «Пресеты» панели (0.10.1, приёмка №3): КОМБОБКС базовых
   * пресетов + компактный сдвиг ±N/единица. Поле показывает человекочитаемую
   * композицию («начало недели − 1 нед», «сегодня»), а НЕ токен; наружу
   * (`bound.text`) уходит канонический токен единого языка. Список рисует
   * общая выпадашка `lib/suggest-dropdown.ts` — своей выпадашки виджет не
   * заводит.
   */
  function buildPanelPresetBound(bound: BoundState, tag: string, ariaPrefix: string): HTMLElement {
    const box = div(PRESET_BOUND_CLASS);
    box.append(span(tag, TAG_CLASS));
    const parts = parsePanelToken(bound.text) ?? { anchor: '$today', n: 0, unit: 'd' };
    let anchorToken = parts.anchor;

    // Поле-комбобокс: показывает композицию, ввод текста запрещён — значение
    // задаётся списком базовых пресетов и сдвигом.
    const input = fieldInput({
      extraClass: PRESET_ANCHOR_CLASS,
      readonly: true,
      value: composePanelLabel(parts),
      ariaLabel: `${ariaPrefix} — базовый пресет`,
      disabled: opts.disabled === true,
    });
    input.type = 'text';
    input.autocomplete = 'off';

    const num = fieldInput({
      type: 'number',
      extraClass: PRESET_NUM_CLASS,
      value: String(parts.n),
      ariaLabel: `${ariaPrefix} — смещение (можно отрицательное)`,
      disabled: opts.disabled === true,
    });
    num.type = 'number';
    num.value = String(parts.n);
    num.step = '1';

    const unit = el('select', PRESET_UNIT_CLASS) as HTMLSelectElement;
    unit.setAttribute('aria-label', `${ariaPrefix} — единица смещения`);
    for (const u of PANEL_UNITS) {
      const o = el('option', '', u.label) as HTMLOptionElement;
      o.value = u.id;
      unit.append(o);
    }
    unit.value = parts.unit;

    /** Синхронизировать поле-композицию и канонический токен из контролов. */
    const sync = (): void => {
      const n = Number.parseInt(num.value, 10);
      const next: PanelTokenParts = {
        anchor: anchorToken,
        n: Number.isFinite(n) ? n : 0,
        unit: unit.value,
      };
      bound.text = composePanelToken(next);
      bound.time = '';
      bound.instant = null;
      input.value = composePanelLabel(next);
    };

    let handle: SuggestHandle | null = null;
    if (opts.disabled !== true) {
      handle = wireSuggest(input, {
        sources: [
          {
            when: 'always',
            header: 'Базовые пресеты',
            load: () => PANEL_ANCHORS.map((a) => ({ value: a.id, label: a.label })),
          },
        ],
        pickFirstOnEnter: false,
        onPick: (entry) => {
          anchorToken = entry.value;
          sync();
          emit();
        },
      });
      suggestHandles.push(handle);
    }

    // Каретка ▾ — явное открытие полного списка (фокус открывает список сам).
    const caret = span('▾', PRESET_CARET_CLASS);
    caret.setAttribute('title', 'Показать список пресетов');
    caret.addEventListener('mousedown', (event) => event.preventDefault());
    caret.addEventListener('click', () => handle?.open());

    num.addEventListener('change', () => {
      sync();
      emit();
    });
    unit.addEventListener('change', () => {
      sync();
      emit();
    });

    box.append(input, caret, num, unit);
    const error = boundError(bound, allowTokens);
    if (error !== null) box.append(span(error, ERROR_CLASS));
    return box;
  }

  /**
   * Согласовать поля времени с режимом: `date` — времени нет; `datetime` —
   * время есть (нет прежнего — начинаем с 00:00); `range` — время необязательно.
   */
  const normalizeTimes = (): void => {
    if (mode === 'date') {
      from.time = '';
      to.time = '';
    } else if (mode === 'datetime' && from.time === '' && !isGlobalDateToken(from.text)) {
      from.time = '00:00';
    }
  };

  /** Смена режима с сохранением времени суток (ADR времени). */
  function applyMode(next: PeriodMode, shouldEmit: boolean): void {
    if (next === mode) return;
    // Из диапазона в однозначный: конец нужен, только если начало пусто.
    if (mode === 'range' && next !== 'range' && from.text.trim() === '' && to.text.trim() !== '') {
      from = { ...to };
    }
    mode = next;
    normalizeTimes();
    modes?.setActive(next);
    repaint();
    if (shouldEmit) emit();
  }

  const setMode = (next: PeriodMode): void => {
    applyMode(next, false);
  };

  /** Дата режима «Даты»: токен раскрывается (если есть резолвер), инстанс — в локальный день. */
  function dateOnly(text: string): string {
    const value = text.trim();
    if (value === '') return '';
    if (isGlobalDateToken(value)) return opts.resolveToken?.(value) ?? value;
    const parsed = parseBound(value);
    if (parsed.kind === 'instant') return instantToLocalDate(parsed.value);
    return value;
  }

  /** Смена режима панели «Пресеты»/«Даты» с конверсией представления значений. */
  function applyPanelMode(next: PeriodPanelMode, shouldEmit = true): void {
    if (next === panelMode) return;
    if (next === 'dates') {
      from.text = dateOnly(from.text);
      to.text = dateOnly(to.text);
    } else {
      const conv = opts.tokensForRange?.(from.text, to.text);
      if (conv !== undefined) {
        from.text = conv.from;
        to.text = conv.to;
      }
    }
    from.time = '';
    to.time = '';
    from.instant = null;
    to.instant = null;
    panelMode = next;
    panelModes?.setActive(next);
    repaint();
    if (shouldEmit) emit();
  }

  /** Привести значение поля к текущему режиму панели (дата ↔ токен). */
  function coercePanelValue(text: string): string {
    if (!panel) return text;
    if (panelMode === 'dates') return dateOnly(text);
    if (text === '' || isGlobalDateToken(text)) return text;
    const parsed = parseBound(text);
    if (parsed.kind === 'date' && opts.tokensForRange !== undefined) {
      return opts.tokensForRange(text, text).from;
    }
    return text;
  }

  const setValue = (value: PeriodValue | null): void => {
    const next = value ?? {};
    const source = next.from ?? next.to ?? next.token ?? '';
    if (panel) {
      from = boundFromValue(coercePanelValue(source));
      to = boundFromValue(coercePanelValue(next.to ?? ''));
      from.time = '';
      to.time = '';
      repaint();
      return;
    }
    from = boundFromValue(source);
    if (mode === 'range') {
      to = boundFromValue(next.to ?? '');
    } else {
      // Однозначный режим: значение одной даты заполняет обе границы.
      to = { ...from };
    }
    normalizeTimes();
    repaint();
  };

  const dispose = (): void => {
    for (const handle of suggestHandles) handle.dispose();
    suggestHandles.length = 0;
  };

  // Начальное значение.
  if (panel && opts.value?.mode !== undefined) {
    panelMode = opts.value.mode;
    panelModes?.setActive(panelMode);
  }
  setValue(opts.value ?? null);

  return {
    root,
    getMode: () => mode,
    setMode,
    getValue: readValue,
    setValue,
    getPanelMode: () => panelMode,
    setPanelMode: (next) => applyPanelMode(next, false),
    errors,
    dispose,
  };
}
