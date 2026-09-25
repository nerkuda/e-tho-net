/**
 * Таблица списков `lib/ui` — единый фасад над Vaadin Grid (задача dad2b029,
 * требование 93115633 «Единый табличный компонент списков», техпроект
 * 78398ec5, ADR 03eb2c61, компонент 88111458, инвентаризация 3fc7c54d).
 *
 * **Зачем.** Навигация стрелками в списочных экранах продублирована вручную
 * примерно в десяти модулях и расходится; текущей строки, единых контекстных
 * меню и сортировки нет. Этот модуль — тот самый единый список: им обязаны
 * пользоваться все списочные экраны вместо самодельных `<table>` (сторож
 * `tests/guard-ui-tables.test.ts`).
 *
 * **Что наше, что вендорское.** Вендорскому Grid отданы виртуализация и
 * отрисовка строк. Всё поведение — наше и живёт здесь: сортировка (цикл
 * asc → desc → нет), текущая строка, клавиатурная навигация, контекстное
 * меню, копирование, подписка на селектор store. Общение с элементом Grid
 * изолировано тонким адаптером {@link GridTableAdapter} (`./table-grid.ts`).
 *
 * **Тестируемость (ключевое решение).** `vaadin-grid` — custom element: на
 * используемом в тестах DOM-шиме он не исполняется. Поэтому фасад разделён на
 *  • чистые функции — {@link cycleSort}, {@link sortRows},
 *    {@link nextRowIndex}, {@link rowsToTsv} (сортировка, навигационная
 *    математика, формат копирования);
 *  • обёртку на обычных элементах — контейнер `.ui-table`, клавиатура, меню,
 *    копирование, пустое состояние;
 *  • адаптер сетки, который в тестах заменяется стабом (опция `adapter`).
 * Тесты проверяют поведение через стаб и чистые функции — без настоящего Grid.
 *
 * **Источник данных.** `rows` — массив ИЛИ селектор `lib/ui/state.ts`. Во
 * втором случае таблица подписывается сама (`select`, структурное сравнение
 * среза) и перерисовывается на каждое изменение store, куда realtime-канал
 * фан-аутит события. Ручные `invalidate`-хуки вызывающего не нужны
 * (требование 628d33ee) — это и есть реактивная основа списков.
 *
 * **Строки.** Заголовки колонок и тексты (в т.ч. пустого состояния и ячеек)
 * задаёт вызывающий уже локализованными (`t('…')` из `lib/i18n.ts`): словарь
 * ключей расширяется вызывающим, фасад ключей не придумывает. Пустое
 * состояние рисует общий компонент `./empty-state.js` (заголовок `emptyText` +
 * подсказка `emptyHint` + необязательное действие `emptyAction`, задача
 * d7b7c367): значение по умолчанию для заголовка — `t('table.empty')`,
 * для подсказки — `t('table.emptyHint')`.
 *
 * **Навигация (`nav`).** По умолчанию `'row'` — стрелки ↑/↓ двигают текущую
 * строку (поведение всех потребителей Z4/Z5 неизменно). Режим `'cell'` (для
 * «Хроники», §17) добавляет уровень ячейки: ←/→ и Tab ходят по колонкам, а
 * внутри колонки — по её фокусируемым элементам (`.ui-table-focusable`,
 * например чипы), ↑/↓ по строкам, Enter активирует выбранный элемент (клик)
 * или, если элементов нет, строку (`onActivate`). Текущая ячейка и элемент
 * подсвечиваются классами {@link TABLE_CELL_CURRENT_CLASS}/
 * {@link TABLE_FOCUSABLE_CURRENT_CLASS}; каждая ячейка обёрнута в
 * {@link TABLE_CELL_CLASS} с ключом строки в `data-row-key` (по нему DnD
 * находит строку). Состав ячеек читается из DOM — вендорская виртуализация
 * отрисовывает видимые строки, текущая строка всегда видима.
 *
 * **Управляемая сортировка.** Колонка задаёт `sortValue` и (при
 * `sortMode: 'toggle'`) `defaultSortDir` — направление, с которого колонка
 * начинает сортировку. `sortMode` по умолчанию `'cycle'` (asc → desc → нет,
 * как было); `'toggle'` — двунаправленный цикл desc↔asc без «нет», как в
 * таблице хроники. `defaultSort` задаёт начальное состояние, `setSort`/
 * `getSort` — внешнее управление (например, подписка на изменение отбора).
 *
 * **Копирование (Ctrl+C).** Формат — TSV (значения, разделённые табуляцией):
 * первая строка — заголовки колонок, далее строки. Это машинно-читаемый и
 * «вставляемый» формат по умолчанию для табличных процессоров (Excel,
 * LibreOffice, Google Sheets); при вставке в них TSV разбивается на ячейки
 * без диалога импорта. Ячейки с табуляцией, переводом строки или кавычкой
 * оборачиваются в двойные кавычки (удвоение внутренних кавычек) — так же, как
 * это делает Excel при копировании.
 */

import { div, span } from '../dom.js';
import { t } from '../i18n.js';
import { showMenuAt, type MenuItem } from '../menu.js';
import { emptyState, type EmptyStateOptions, type StateAction } from './empty-state.js';
import { FOCUS_ANCHOR_ATTR } from './focus-anchor.js';
import { select, type StateSelector } from './state.js';
import {
  vaadinGridAdapter,
  type GridColumnSpec,
  type GridPoint,
  type GridTableAdapter,
} from './table-grid.js';

/** Корневой класс обёртки таблицы. */
export const TABLE_CLASS = 'ui-table';

/** Класс обёртки пустого состояния таблицы (внутри — общий `emptyState`). */
export const TABLE_EMPTY_CLASS = 'ui-table-empty';

/** Класс ячейки с «пустым» значением (нет данных у строки). */
export const TABLE_CELL_EMPTY_CLASS = 'ui-table-cell-empty';

/** Обёртка ячейки в режиме `nav: 'cell'` (несёт `data-row-key`/`data-col-key`). */
export const TABLE_CELL_CLASS = 'ui-table-cell';

/** Класс текущей (подсвеченной клавиатурой) ячейки в режиме `nav: 'cell'`. */
export const TABLE_CELL_CURRENT_CLASS = 'ui-table-cell-current';

/**
 * Класс фокусируемого элемента ячейки (чип и т. п.). Ячейка задаёт его сама
 * в `render`; фасад по нему ходит ←/→ и активирует Enter.
 */
export const TABLE_FOCUSABLE_CLASS = 'ui-table-focusable';

/** Класс выбранного (подсвеченного клавиатурой) фокусируемого элемента ячейки. */
export const TABLE_FOCUSABLE_CURRENT_CLASS = 'ui-table-focusable-current';

/**
 * Атрибут обёртки ячейки с ключом строки (`rowKey`). По нему DnD находит
 * строку под курсором (canvas/drag-cloud.ts, §17).
 */
export const TABLE_ROW_KEY_ATTR = 'data-row-key';

/** Значение ячейки по умолчанию, когда данных нет. */
export const TABLE_EMPTY_CELL = '—';

/** Направление сортировки. */
export type SortDir = 'asc' | 'desc';

/** Состояние сортировки таблицы: колонка и направление. */
export interface SortState {
  /** Ключ колонки-сортировки; `null` — сортировки нет. */
  key: string | null;
  /** Направление; `null` — сортировки нет. */
  dir: SortDir | null;
}

/** Исходное состояние: данные в порядке источника. */
export const NO_SORT: SortState = { key: null, dir: null };

/** Режим навигации: по строкам (`row`, по умолчанию) или по ячейкам (`cell`). */
export type NavMode = 'row' | 'cell';

/** Цикл сортировки по клику заголовка: трёхсостоянийный или двунаправленный. */
export type SortMode = 'cycle' | 'toggle';

/** Курсор режима `nav: 'cell'`: строка (индекс отображения), колонка, элемент ячейки. */
export interface CellCursor {
  /** Индекс строки в текущем порядке отображения; `-1` — строка не выбрана. */
  row: number;
  /** Индекс колонки. */
  col: number;
  /** Индекс фокусируемого элемента внутри ячейки (0 — если их нет). */
  item: number;
}

/** Клавиша навигации, обрабатываемая таблицей. */
export type NavKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

/** Является ли имя клавиши навигационной. */
export function isNavKey(key: string): key is NavKey {
  return (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Home' ||
    key === 'End' ||
    key === 'PageUp' ||
    key === 'PageDown'
  );
}

/** Контекст ячейки для пользовательского рендера. */
export interface CellContext<T> {
  /** Индекс строки в текущем порядке отображения. */
  index: number;
  /** Стабильный ключ строки (`rowKey`) — для разметки, адресующей строку (DnD). */
  key: string;
  /** Колонка. */
  column: TableColumn<T>;
  /** Ячейка принадлежит текущей строке. */
  isCurrent: boolean;
}

/** Декларативное описание колонки. */
export interface TableColumn<T> {
  /** Ключ колонки: идентификатор, путь сортировки и доступ к полю строки. */
  key: string;
  /** Заголовок (локализован вызывающим через `t('…')`). */
  header: string;
  /** Ширина CSS (например, `12rem`); не задана — колонка тянется. */
  width?: string;
  /** Выравнивание содержимого. */
  align?: 'start' | 'center' | 'end';
  /** Сортируема ли колонка по клику заголовка. */
  sortable?: boolean;
  /** Значение для сортировки; по умолчанию — поле `row[key]`. */
  sortValue?: (row: T, index: number) => string | number | boolean | null | undefined;
  /**
   * Направление, с которого колонка начинает сортировку при `sortMode:
   * 'toggle'` (по умолчанию `'desc'`). На цикл `'cycle'` не влияет — там
   * первая сортировка всегда `asc`.
   */
  defaultSortDir?: SortDir;
  /** Значение для копирования (TSV); по умолчанию — текстовое представление `sortValue`/поля. */
  text?: (row: T, index: number) => string;
  /** Пользовательский рендер ячейки (узел или строка). */
  render?: (row: T, context: CellContext<T>) => Node | string | null | undefined;
  /**
   * Разрешить перенос текста в ячейке. По умолчанию текст колонки
   * показывается одной строкой с обрезанием многоточием (полный — в
   * подсказке `title`), колонки не наезжают друг на друга (ошибка d866bc65).
   * Ставь `true` там, где перенос осознанно нужен (длинный многострочный текст).
   */
  wrap?: boolean;
  /** Текст «пустой» ячейки (нет данных); по умолчанию {@link TABLE_EMPTY_CELL}. */
  empty?: string;
}

/** Настройки таблицы. */
export interface TableSpec<T> {
  /** Колонки в порядке отображения. */
  columns: TableColumn<T>[];
  /** Источник строк: массив или селектор среза store (реактивная подписка). */
  rows: readonly T[] | StateSelector<readonly T[]>;
  /**
   * Стабильный ключ строки (идентификатор сущности). Обязан НЕ зависеть от
   * порядка строк — им адресуются текущая строка и выделение.
   */
  rowKey: (row: T, index: number) => string;
  /** Текст пустого состояния (локализован); по умолчанию `t('table.empty')`. */
  emptyText?: string;
  /**
   * Подсказка пустого состояния — что сделать, чтобы строки появились
   * (локализована). По умолчанию `t('table.emptyHint')`; для списков с
   * поиском владелец меняет состояние через {@link TableHandle.setEmpty}.
   */
  emptyHint?: string;
  /** Точка входа к действию из пустого состояния (необязательна). */
  emptyAction?: StateAction;
  /** ARIA-подпись таблицы. */
  ariaLabel?: string;
  /** Начальная текущая строка (ключ). */
  current?: string | null;
  /** Режим навигации: `row` (по умолчанию) или `cell` (по ячейкам/чипам). */
  nav?: NavMode;
  /**
   * Цикл сортировки: `cycle` (по умолчанию, asc → desc → нет) или `toggle`
   * (desc↔asc без «нет» — таблица хроники).
   */
  sortMode?: SortMode;
  /** Начальное состояние сортировки (иначе — порядок источника). */
  defaultSort?: SortState;
  /** Смена текущей строки (клавиатура, клик, внешняя установка). */
  onCurrentChange?: (key: string | null, row: T | null, index: number) => void;
  /** Активация строки: Enter или двойной клик (если нет {@link onDblActivate}). */
  onActivate?: (row: T, index: number) => void;
  /**
   * Двойной клик по строке. Задан — фасад зовёт его вместо {@link onActivate}
   * (правило 6 требования 11ddd910: у списка одиночный клик делает строку
   * текущей, двойной и Enter открывают редактор). Не задан — список считается
   * пикером: двойной клик и Enter подтверждают выбор (`onActivate`, эквивалент
   * кнопки «Выбрать»), ошибка d1a009fa.
   */
  onDblActivate?: (row: T, index: number) => void;
  /** Одиночный клик по строке. */
  onRowClick?: (row: T, index: number) => void;
  /** Пункты контекстного меню строки (пусто — меню не показывается). */
  rowMenu?: (row: T, index: number) => MenuItem[];
  /** Режим выделения: `single` (только текущая) или `multi` (Space переключает). */
  selection?: 'single' | 'multi';
  /** Копирование по Ctrl+C (по умолчанию включено). */
  copy?: boolean;
  /** Шаг PgUp/PgDn в строках (по умолчанию 10). */
  pageStep?: number;
  /** Запись в буфер обмена; по умолчанию `navigator.clipboard.writeText`. */
  clipboard?: (text: string) => void;
  /** Вызывается после формирования текста копирования (для тестов/логов). */
  onCopy?: (text: string) => void;
  /** Замена адаптера сетки (тесты подставляют стаб). */
  adapter?: GridTableAdapter;
}

/** Публичный дескриптор таблицы. */
export interface TableHandle<T> {
  /** Обёртка для монтирования (`<div class="ui-table">`). */
  readonly element: HTMLElement;
  /** Текущий порядок строк (с учётом сортировки). */
  getRows(): T[];
  /** Заменяет источник строк (режим массива; селектор игнорируется). */
  setRows(rows: readonly T[]): void;
  /** Устанавливает текущую строку по ключу (без уведомления `onCurrentChange`). */
  setCurrent(key: string | null): void;
  /** Текущая строка. */
  getCurrent(): { key: string; row: T; index: number } | null;
  /** Пересчитывает сортировку по клику заголовка (используется адаптером и тестами). */
  requestSort(key: string): void;
  /** Текущее состояние сортировки. */
  getSort(): SortState;
  /** Устанавливает сортировку извне (без уведомления). */
  setSort(state: SortState): void;
  /** Курсор режима `nav: 'cell'` (в режиме `row` — `null`). */
  getCellCursor(): CellCursor | null;
  /** Заменяет выделение (в режиме `multi`). */
  setSelection(keys: readonly string[]): void;
  /** Ключи выделенных строк. */
  getSelection(): string[];
  /**
   * Заменяет пустое состояние (заголовок/подсказка/действие) — для списков,
   * чей текст зависит от фильтра (например, «ничего не найдено»).
   */
  setEmpty(options: EmptyStateOptions): void;
  /** Текст копирования текущего выделения/строки (TSV с заголовками). */
  buildCopyText(): string;
  /** Перерисовывает колонки и строки (например, после смены языка). */
  refresh(): void;
  /** Переводит клавиатурный фокус на таблицу. */
  focus(): void;
  /** Отписывается от селектора и удаляет узел. */
  destroy(): void;
}

// --- Чистые функции: сортировка, навигация, копирование -------------------

/**
 * Цикл сортировки по клику заголовка.
 *
 * `mode: 'cycle'` (по умолчанию) — другая колонка → `asc`; та же →
 * `asc` → `desc` → нет сортировки. `mode: 'toggle'` (таблица хроники) —
 * двунаправленный цикл без «нет»: другая колонка → направление `opts.dir`
 * (по умолчанию `desc`), та же → `desc↔asc`.
 */
export function cycleSort(
  current: SortState,
  key: string,
  opts?: { mode?: SortMode; dir?: SortDir },
): SortState {
  const mode = opts?.mode ?? 'cycle';
  if (current.key !== key) {
    return { key, dir: mode === 'toggle' ? opts?.dir ?? 'desc' : 'asc' };
  }
  if (mode === 'toggle') {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return { key: null, dir: null };
}

/** Сравнение значений колонки: числа — численно, строки — по-русски; `null` в конце. */
function compareValues(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'ru');
}

/** Значение строки по колонке (для сортировки/копирования). */
function columnValue<T>(column: TableColumn<T>, row: T, index: number): unknown {
  if (column.sortValue !== undefined) return column.sortValue(row, index);
  return (row as Record<string, unknown>)[column.key];
}

/**
 * Сортирует строки по состоянию. Сортировка СТАБИЛЬНА: равные значения
 * сохраняют исходный порядок. Без сортировки (`key`/`dir` пусты) возвращает
 * копию входного массива.
 */
export function sortRows<T>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  sort: SortState,
): T[] {
  if (sort.key === null || sort.dir === null) return [...rows];
  const column = columns.find((c) => c.key === sort.key);
  if (column === undefined) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const diff = compareValues(
        columnValue(column, a.row, a.index),
        columnValue(column, b.row, b.index),
      );
      return diff !== 0 ? diff * sign : a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * Целевой индекс строки для клавиши навигации. Без текущей строки
 * (`current < 0`) первое нажатие встаёт: `End` — на последнюю, `PageDown` —
 * на последнюю строку первой страницы, остальные — на первую. Возвращает
 * `-1`, если строк нет.
 */
export function nextRowIndex(
  key: NavKey,
  current: number,
  count: number,
  pageStep: number,
): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const step = pageStep >= 1 ? pageStep : 1;
  if (current < 0) {
    if (key === 'End') return last;
    if (key === 'PageDown') return Math.min(last, step - 1);
    return 0;
  }
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, current + 1);
    case 'ArrowUp':
      return Math.max(0, current - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageDown':
      return Math.min(last, current + step);
    case 'PageUp':
      return Math.max(0, current - step);
  }
}

/** Экранирует ячейку TSV: табуляция/перевод строки/кавычка — в кавычки (стиль Excel). */
export function escapeTsvCell(value: string): string {
  if (/[\t\n\r"]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Текстовое представление ячейки для копирования. */
export function cellText<T>(column: TableColumn<T>, row: T, index: number): string {
  if (column.text !== undefined) return column.text(row, index);
  const value = columnValue(column, row, index);
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Строки в TSV: первая строка — заголовки колонок, далее строки. Строки
 * разделяются CRLF (как в буфере Excel), ячейки — табуляцией.
 */
export function rowsToTsv<T>(
  columns: readonly TableColumn<T>[],
  rows: readonly T[],
  indexes?: readonly number[],
): string {
  const line = (cells: string[]): string => cells.map(escapeTsvCell).join('\t');
  const header = line(columns.map((column) => column.header));
  const body = rows.map((row, i) =>
    line(columns.map((column) => cellText(column, row, indexes?.[i] ?? i))),
  );
  return [header, ...body].join('\r\n');
}

// --- Фасад -----------------------------------------------------------------

/**
 * Создаёт таблицу. Источник-массив отрисовывается сразу; источник-селектор —
 * с подпиской на store (с отпиской в {@link TableHandle.destroy}).
 */
export function createTable<T>(spec: TableSpec<T>): TableHandle<T> {
  const columns = spec.columns;
  const multi = spec.selection === 'multi';
  const pageStep = spec.pageStep ?? 10;
  const copyEnabled = spec.copy !== false;
  const emptyText = spec.emptyText ?? t('table.empty');
  const nav: NavMode = spec.nav ?? 'row';
  const sortMode: SortMode = spec.sortMode ?? 'cycle';

  let emptyOptions: EmptyStateOptions = {
    title: emptyText,
    hint: spec.emptyHint ?? t('table.emptyHint'),
    ...(spec.emptyAction !== undefined ? { action: spec.emptyAction } : {}),
  };

  const wrapper = div(TABLE_CLASS);
  wrapper.tabIndex = 0;
  // Якорь возврата клавиатурного фокуса (правило 10 требования 11ddd910,
  // ошибка 28d69bc6): каркас диалога возвращает фокус сюда после закрытия
  // открытого над списком редактора, поэтому стрелочная навигация продолжается
  // без повторного клика. Обёртка — устойчивый контейнер: переживает
  // перерисовку строк, владеет `keydown`-навигацией и имеет `tabIndex`.
  wrapper.setAttribute(FOCUS_ANCHOR_ATTR, '');
  if (spec.ariaLabel !== undefined) wrapper.setAttribute('aria-label', spec.ariaLabel);

  const adapter = spec.adapter ?? vaadinGridAdapter();
  const emptyEl = div(TABLE_EMPTY_CLASS);
  emptyEl.hidden = true;
  /** Перерисовывает содержимое пустого состояния (общий компонент `lib/ui`). */
  const renderEmpty = (): void => {
    emptyEl.replaceChildren(emptyState(emptyOptions));
  };
  renderEmpty();
  wrapper.append(adapter.element, emptyEl);
  if (spec.ariaLabel !== undefined) adapter.element.setAttribute('aria-label', spec.ariaLabel);
  if (multi) adapter.element.setAttribute('aria-multiselectable', 'true');

  let rows: readonly T[] = [];
  let sort: SortState = spec.defaultSort ?? NO_SORT;
  let currentKey: string | null = spec.current ?? null;
  let cellCursor: CellCursor = { row: -1, col: 0, item: 0 };
  const selected = new Set<string>();
  let unsubscribe: (() => void) | null = null;

  /** Строки в порядке отображения. */
  const ordered = (): T[] => sortRows(rows, columns, sort);

  const currentIndexOf = (data: readonly T[]): number => {
    if (currentKey === null) return -1;
    return data.findIndex((row, index) => spec.rowKey(row, index) === currentKey);
  };

  const isCurrentRow = (row: T, index: number): boolean =>
    currentKey !== null && spec.rowKey(row, index) === currentKey;

  // --- Ячейки (режим nav: 'cell') -----------------------------------------
  // Состав ячеек читается из DOM вендорской сетки: наши обёртки
  // `.ui-table-cell` лежат в её light-DOM. Виртуализация отрисовывает видимые
  // строки, а текущая строка всегда видима, поэтому её ячейки доступны.
  const allCells = (): HTMLElement[] =>
    Array.from(wrapper.querySelectorAll<HTMLElement>('.' + TABLE_CELL_CLASS));

  const focusables = (cell: HTMLElement): HTMLElement[] =>
    Array.from(cell.querySelectorAll<HTMLElement>('.' + TABLE_FOCUSABLE_CLASS));

  /** Обёртка ячейки строки `row` и колонки `col` (по `data-row-key`/`data-col-key`). */
  const cellAt = (row: number, col: number): HTMLElement | null => {
    const data = ordered();
    const dataRow = data[row];
    const column = columns[col];
    if (dataRow === undefined || column === undefined) return null;
    const rowKey = spec.rowKey(dataRow, row);
    const cell = allCells().find(
      (candidate) =>
        candidate.dataset['rowKey'] === rowKey && candidate.dataset['colKey'] === column.key,
    );
    return cell ?? null;
  };

  /** Снимает подсветку ячейки/элемента и ставит её по `cellCursor`. */
  const repaintCell = (): void => {
    if (nav !== 'cell') return;
    for (const cell of allCells()) {
      cell.classList.remove(TABLE_CELL_CURRENT_CLASS);
      for (const item of focusables(cell)) {
        item.classList.remove(TABLE_FOCUSABLE_CURRENT_CLASS);
      }
    }
    const current = cellAt(cellCursor.row, cellCursor.col);
    if (current === null) return;
    current.classList.add(TABLE_CELL_CURRENT_CLASS);
    const items = focusables(current);
    items[Math.min(cellCursor.item, items.length - 1)]?.classList.add(
      TABLE_FOCUSABLE_CURRENT_CLASS,
    );
  };

  /** Есть ли у ячейки `(row, col)` фокусируемые элементы. */
  const itemsAt = (row: number, col: number): HTMLElement[] => {
    const cell = cellAt(row, col);
    return cell === null ? [] : focusables(cell);
  };

  /**
   * Текстовая ячейка списка. По умолчанию — одна строка с обрезанием
   * многоточием и полной подсказкой `title` (ошибка d866bc65); перенос
   * разрешает колонка (`wrap: true`). Стили инлайновые: ячейки Vaadin Grid
   * живут в shadow DOM, документный CSS туда не доходит (тот же приём, что у
   * `cellBox` ленты).
   */
  const textCell = (text: string, wrap: boolean): HTMLSpanElement => {
    const node = span(text);
    if (wrap) {
      node.style.whiteSpace = 'normal';
    } else {
      node.style.display = 'block';
      node.style.overflow = 'hidden';
      node.style.whiteSpace = 'nowrap';
      node.style.textOverflow = 'ellipsis';
    }
    node.title = text;
    return node;
  };

  const renderCellContent = (column: TableColumn<T>, row: T, index: number): Node => {
    if (column.render !== undefined) {
      const out = column.render(row, {
        index,
        key: spec.rowKey(row, index),
        column,
        isCurrent: isCurrentRow(row, index),
      });
      if (out === null || out === undefined || out === '') {
        return span(column.empty ?? TABLE_EMPTY_CELL, TABLE_CELL_EMPTY_CLASS);
      }
      return typeof out === 'string' ? textCell(out, column.wrap === true) : out;
    }
    const text = cellText(column, row, index);
    return text === ''
      ? span(column.empty ?? TABLE_EMPTY_CELL, TABLE_CELL_EMPTY_CLASS)
      : textCell(text, column.wrap === true);
  };

  const renderCell = (column: TableColumn<T>, row: T, index: number): Node => {
    const content = renderCellContent(column, row, index);
    if (nav !== 'cell') return content;
    const box = div(TABLE_CELL_CLASS);
    box.dataset['rowKey'] = spec.rowKey(row, index);
    box.dataset['colKey'] = column.key;
    box.append(content);
    if (cellCursor.row === index && columns[cellCursor.col]?.key === column.key) {
      box.classList.add(TABLE_CELL_CURRENT_CLASS);
      const items = focusables(box);
      items[Math.min(cellCursor.item, items.length - 1)]?.classList.add(
        TABLE_FOCUSABLE_CURRENT_CLASS,
      );
    }
    return box;
  };

  // Пользовательский рендер может зависеть от «текущая ли строка»: тогда после
  // смены текущей строки освежаем видимые ячейки (переустановка строк дешевле
  // пересборки колонок и не сбрасывает позицию виртуализации).
  const hasCustomRender = columns.some((column) => column.render !== undefined);

  const renderColumns = (): void => {
    adapter.setColumns(
      columns.map(
        (column): GridColumnSpec => ({
          key: column.key,
          header: column.header,
          ...(column.width !== undefined ? { width: column.width } : {}),
          ...(column.align !== undefined ? { align: column.align } : {}),
          sortable: column.sortable === true,
          sortDir: sort.key === column.key ? sort.dir : null,
          render: (row: unknown, index: number): Node => renderCell(column, row as T, index),
        }),
      ),
    );
  };

  const renderItems = (): void => {
    const data = ordered();
    adapter.setItems(data);
    emptyEl.hidden = data.length > 0;
    const current = currentIndexOf(data);
    adapter.setActive(current >= 0 ? data[current] : null);
    if (multi) {
      adapter.setSelected(data.filter((row, index) => selected.has(spec.rowKey(row, index))));
    }
    if (nav === 'cell') {
      if (cellCursor.row >= data.length) {
        cellCursor = { row: Math.max(0, data.length - 1), col: cellCursor.col, item: 0 };
      }
      repaintCell();
    }
  };

  const applyCurrent = (index: number, notify: boolean): void => {
    const data = ordered();
    const row = data[index];
    if (row === undefined) return;
    currentKey = spec.rowKey(row, index);
    if (nav === 'cell') cellCursor = { row: index, col: cellCursor.col, item: 0 };
    adapter.setActive(row);
    adapter.scrollToRow(row);
    if (hasCustomRender) adapter.setItems(data); // освежить рендер «текущей» ячейки
    if (nav === 'cell') repaintCell();
    if (notify) spec.onCurrentChange?.(currentKey, row, index);
  };

  const activate = (index: number): void => {
    const data = ordered();
    const row = data[index];
    if (row !== undefined) spec.onActivate?.(row, index);
  };

  /**
   * Сдвиг курсора ячейки по горизонтали: внутри колонки — по фокусируемым
   * элементам, на краю — в соседнюю колонку (первый элемент). `Tab` — всегда
   * следующая колонка.
   */
  const moveCell = (step: -1 | 1 | 'tab'): void => {
    if (step === 'tab') {
      cellCursor = {
        row: cellCursor.row,
        col: Math.min(columns.length - 1, cellCursor.col + 1),
        item: 0,
      };
      repaintCell();
      return;
    }
    const items = itemsAt(cellCursor.row, cellCursor.col);
    if (step === 1 && cellCursor.item < items.length - 1) {
      cellCursor = { ...cellCursor, item: cellCursor.item + 1 };
    } else if (step === -1 && cellCursor.item > 0) {
      cellCursor = { ...cellCursor, item: cellCursor.item - 1 };
    } else {
      const col = Math.max(0, Math.min(columns.length - 1, cellCursor.col + step));
      cellCursor = { ...cellCursor, col, item: 0 };
    }
    repaintCell();
  };

  /** Enter в режиме ячеек: клик по выбранному элементу, иначе активация строки. */
  const activateCell = (): void => {
    const items = itemsAt(cellCursor.row, cellCursor.col);
    if (items.length > 0) {
      items[Math.min(cellCursor.item, items.length - 1)]?.click();
      return;
    }
    if (cellCursor.row < 0) return;
    repaintCell();
    activate(cellCursor.row);
  };

  const copy = (): void => {
    if (!copyEnabled) return;
    const data = ordered();
    let text: string;
    if (multi && selected.size > 0) {
      const picked = data
        .map((row, index) => ({ row, index }))
        .filter(({ row, index }) => selected.has(spec.rowKey(row, index)));
      text = rowsToTsv(
        columns,
        picked.map((p) => p.row),
        picked.map((p) => p.index),
      );
    } else {
      const index = currentIndexOf(data);
      if (index < 0) return;
      text = rowsToTsv(columns, [data[index] as T], [index]);
    }
    spec.onCopy?.(text);
    if (spec.clipboard !== undefined) spec.clipboard(text);
    else void navigator.clipboard?.writeText(text);
  };

  // --- Клавиатура (наша, не вендорская) ---
  // Фокус удерживается на обёртке: `mousedown` не даёт браузеру перевести его
  // внутрь теневого DOM сетки, где включена вендорская навигация (иначе обе
  // навигации сработали бы на одно нажатие).
  wrapper.addEventListener('mousedown', (event) => {
    if ((event as MouseEvent).button !== 0) return;
    event.preventDefault();
    wrapper.focus();
  });
  wrapper.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    if (key.ctrlKey || key.metaKey) {
      if (key.key === 'c' || key.key === 'C') {
        key.preventDefault();
        copy();
      }
      return; // прочие Ctrl-сочетания — глобальным обработчикам
    }
    if (nav === 'cell' && (key.key === 'ArrowRight' || key.key === 'ArrowLeft' || key.key === 'Tab')) {
      key.preventDefault();
      moveCell(key.key === 'ArrowRight' ? 1 : key.key === 'ArrowLeft' ? -1 : 'tab');
      return;
    }
    if (isNavKey(key.key)) {
      key.preventDefault();
      const data = ordered();
      const from = nav === 'cell' ? cellCursor.row : currentIndexOf(data);
      const target = nextRowIndex(key.key, from, data.length, pageStep);
      if (target >= 0) applyCurrent(target, true);
      return;
    }
    if (key.key === 'Enter') {
      key.preventDefault();
      if (nav === 'cell') {
        activateCell();
        return;
      }
      activate(currentIndexOf(ordered()));
      return;
    }
    if (key.key === ' ' && multi) {
      key.preventDefault();
      const index = currentIndexOf(ordered());
      const data = ordered();
      const row = data[index];
      if (row === undefined) return;
      const id = spec.rowKey(row, index);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      renderItems();
    }
  });

  // --- Сортировка ---
  /** Пересчёт сортировки: режим `cycle` (asc→desc→нет) или `toggle` (desc↔asc). */
  const requestSort = (key: string): void => {
    const column = columns.find((c) => c.key === key);
    if (column === undefined || column.sortable !== true) return;
    sort =
      sortMode === 'toggle'
        ? cycleSort(sort, key, {
            mode: 'toggle',
            // Первый клик по новой колонке — её направление по умолчанию.
            dir: sort.key === key ? undefined : column.defaultSortDir ?? 'desc',
          })
        : cycleSort(sort, key);
    renderColumns();
    renderItems();
    if (nav === 'cell') {
      cellCursor = { row: currentIndexOf(ordered()), col: cellCursor.col, item: 0 };
      repaintCell();
    }
  };

  // --- Адаптер: события строк ---
  adapter.onRowClick((index): void => {
    const data = ordered();
    const row = data[index];
    if (row === undefined) return;
    applyCurrent(index, true);
    spec.onRowClick?.(row, index);
  });
  adapter.onRowDblClick((index): void => {
    const data = ordered();
    const row = data[index];
    if (row === undefined) return;
    applyCurrent(index, true);
    // Правило 6 требования 11ddd910: заданный `onDblActivate` — редактор строки
    // (одиночный клик при этом лишь делает её текущей); без него двойной клик
    // подтверждает выбор в пикере (`onActivate`), эквивалент Enter и «Выбрать»
    // (ошибка d1a009fa).
    if (spec.onDblActivate !== undefined) spec.onDblActivate(row, index);
    else activate(index);
  });
  adapter.onRowContextMenu((index: number, at: GridPoint): void => {
    const data = ordered();
    const row = data[index];
    if (row === undefined) return;
    applyCurrent(index, true);
    const items = spec.rowMenu?.(row, index) ?? [];
    if (items.length > 0) showMenuAt(at.x, at.y, items);
  });
  adapter.onSortRequest((key): void => {
    requestSort(key);
  });

  // --- Первый рендер / подписка на источник ---
  if (typeof spec.rows === 'function') {
    const source = spec.rows;
    unsubscribe = select(source, (next) => {
      rows = next;
      renderItems();
    });
  } else {
    rows = spec.rows;
    renderItems();
  }
  renderColumns();

  return {
    element: wrapper,
    getRows(): T[] {
      return ordered();
    },
    setRows(next: readonly T[]): void {
      rows = next;
      renderItems();
    },
    setCurrent(key: string | null): void {
      currentKey = key;
      const data = ordered();
      const index = currentIndexOf(data);
      adapter.setActive(index >= 0 ? data[index] : null);
      if (index >= 0) adapter.scrollToRow(data[index] as T);
      if (hasCustomRender) adapter.setItems(data);
      if (nav === 'cell') {
        cellCursor = { row: index, col: cellCursor.col, item: 0 };
        repaintCell();
      }
    },
    getCurrent(): { key: string; row: T; index: number } | null {
      const data = ordered();
      const index = currentIndexOf(data);
      if (index < 0) return null;
      return { key: currentKey as string, row: data[index] as T, index };
    },
    requestSort,
    getSort(): SortState {
      return { ...sort };
    },
    setSort(state: SortState): void {
      sort = { ...state };
      renderColumns();
      renderItems();
      if (nav === 'cell') {
        cellCursor = { row: currentIndexOf(ordered()), col: cellCursor.col, item: 0 };
        repaintCell();
      }
    },
    getCellCursor(): CellCursor | null {
      return nav === 'cell' ? { ...cellCursor } : null;
    },
    setSelection(keys: readonly string[]): void {
      selected.clear();
      for (const key of keys) selected.add(key);
      renderItems();
    },
    getSelection(): string[] {
      return [...selected];
    },
    setEmpty(options: EmptyStateOptions): void {
      emptyOptions = options;
      renderEmpty();
    },
    buildCopyText(): string {
      const data = ordered();
      if (multi && selected.size > 0) {
        const picked = data
          .map((row, index) => ({ row, index }))
          .filter(({ row, index }) => selected.has(spec.rowKey(row, index)));
        return rowsToTsv(
          columns,
          picked.map((p) => p.row),
          picked.map((p) => p.index),
        );
      }
      const index = currentIndexOf(data);
      if (index < 0) return rowsToTsv(columns, []);
      return rowsToTsv(columns, [data[index] as T], [index]);
    },
    refresh(): void {
      renderColumns();
      renderItems();
    },
    focus(): void {
      wrapper.focus();
    },
    destroy(): void {
      unsubscribe?.();
      unsubscribe = null;
      adapter.destroy();
      wrapper.remove();
    },
  };
}
