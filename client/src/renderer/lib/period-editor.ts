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

import { div, span } from './dom.js';
import { optionsSuggestSource, wireSuggest, type SuggestHandle } from './suggest-dropdown.js';
import { fieldInput } from './ui/field.js';
import { segmentedControl } from './ui/segmented.js';

// ---------------------------------------------------------------------------
// Контракт значения
// ---------------------------------------------------------------------------

/** Режим контрола периода. */
export type PeriodMode = 'date' | 'datetime' | 'range';

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
  /** Поле и переключатель недоступны. */
  disabled?: boolean;
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
  /** Ошибки валидации введённых дат/токенов (пусто — всё корректно). */
  errors(): string[];
  /** Снять оконные слушатели выпадашки (при разборе контрола). */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Чистые помощники (экспортируются для тестов и потребителей)
// ---------------------------------------------------------------------------

/**
 * Глобальный токен даты периода: `$today`/`$now`, необязательная арифметика
 * `±Nd` (целое число дней). Только эта форма допустима в периоде: контекстных
 * токенов `$thought.*` у периода нет (требование 91f8d8dd).
 */
export const GLOBAL_DATE_TOKEN_RE = /^\$(?:today|now)(?:[+-]\d+d)?$/;

/** Является ли строка допустимым глобальным токеном даты периода. */
export function isGlobalDateToken(text: string): boolean {
  return GLOBAL_DATE_TOKEN_RE.test(text.trim());
}

/**
 * Токены-кандидаты для подсказок контрола: глобальные токены и типовые
 * смещения дней. Значения — ровно то, что уйдёт строкой на сервер.
 */
export const PERIOD_TOKEN_PRESETS: readonly { text: string; label: string }[] = [
  { text: '$today', label: '$today — сегодня' },
  { text: '$now', label: '$now — текущий момент' },
  { text: '$today+1d', label: '$today+1d — завтра' },
  { text: '$today-1d', label: '$today-1d — вчера' },
  { text: '$today+7d', label: '$today+7d — через неделю' },
  { text: '$today-7d', label: '$today-7d — неделю назад' },
  { text: '$today+30d', label: '$today+30d — через месяц' },
  { text: '$today-30d', label: '$today-30d — месяц назад' },
];

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
    `«${value}» — не токен периода: доступны только $today/$now ` +
    'и арифметика ±Nd (токены $thought.* требуют контекста мысли).'
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
  return `«${text}» — ожидается ГГГГ-ММ-ДД, полный ISO-инстанс или токен ($today/$now±Nd).`;
}

// ---------------------------------------------------------------------------
// Сборка контрола
// ---------------------------------------------------------------------------

/** Класс корня контрола. */
const ROOT_CLASS = 'pe-root';
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

const MODE_ITEMS = [
  { id: 'date', label: 'Дата' },
  { id: 'datetime', label: 'Дата и время' },
  { id: 'range', label: 'Диапазон' },
] as const;

/** Строит библиотечный контрол периода. */
export function buildPeriodEditor(opts: PeriodEditorOptions): PeriodEditorHandle {
  const allowTokens = opts.allowTokens !== false;
  const tokenPresets = opts.tokenOptions ?? PERIOD_TOKEN_PRESETS.map((t) => t.text);

  let mode: PeriodMode = opts.mode ?? 'date';
  let from = emptyBound();
  let to = emptyBound();

  const root = div(ROOT_CLASS);
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', opts.label ?? 'Период');

  const modes = segmentedControl({
    items: MODE_ITEMS.map((m) => ({ id: m.id, label: m.label })),
    activeId: mode,
    ariaLabel: 'Режим периода',
    size: 's',
    onChange: (id) => {
      applyMode(id as PeriodMode, true);
    },
  });
  root.append(modes.root);

  const fields = div(FIELDS_CLASS);
  root.append(fields);

  const suggestHandles: SuggestHandle[] = [];

  /** Значение из состояния. */
  const readValue = (): PeriodValue => {
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
    if (mode === 'range') {
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
    fields.replaceChildren();
    if (mode === 'range') {
      fields.append(buildBound(from, 'с', 'Начало'), buildBound(to, 'по', 'Конец'));
    } else {
      fields.append(buildBound(from, null, 'Дата'));
    }
  };

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
    modes.setActive(next);
    repaint();
    if (shouldEmit) emit();
  }

  const setMode = (next: PeriodMode): void => {
    applyMode(next, false);
  };

  const setValue = (value: PeriodValue | null): void => {
    const next = value ?? {};
    const source = next.from ?? next.to ?? next.token ?? '';
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
  setValue(opts.value ?? null);

  return {
    root,
    getMode: () => mode,
    setMode,
    getValue: readValue,
    setValue,
    errors,
    dispose,
  };
}
