/**
 * Дерево списков — единый компонент `lib/ui` (задача d1c15a2d, требование
 * 0086037c «Единое дерево списков lib/ui», компонент 24a05c95, техпроект
 * 78398ec5, ADR 03eb2c61, инвентаризация 3fc7c54d — раздел «TreeList»).
 *
 * **Зачем.** Три независимых рендера дерева (чек-дерево пикера сущностей,
 * дерево типов мыслей, дерево типов связей) расходились по отступам, размерам
 * и поведению; в списках типов чекбоксы и иконки не совпадали по размеру
 * (ошибка 6925ffa0). Здесь — тот самый единый рендер: строки с отступом по
 * уровню, каретка раскрытия, СХЕМАТИЗИРОВАННАЯ строка «каретка → флажок →
 * значок типа → облачко-подпись» с выровненными по токену `--hit-area`
 * размерами, клавиатура, текущая строка, встроенный фильтр с авто-раскрытием
 * родителей, счётчики детей и ARIA-дерево.
 *
 * **Источник данных — параметр.** Компонент не знает ни store, ни
 * `lib/type-tree.ts`: он работает над плоским списком узлов {@link TreeItem}
 * (`id`/`parentId`/`hasChildren`), а содержимое строки рисует вызывающий
 * ({@link TreeOptions.renderContent}). Деревья типов поставляют данные
 * функциями `lib/type-tree.ts` (`orderedTypeRows`/`flattenTypeTree`) — правило
 * «деревья типов строятся только через `lib/ui/tree`» держит сторож
 * `tests/guard-ui-tree.test.ts`.
 *
 * **Строки — из словаря.** Собственные тексты компонента (пустое состояние,
 * тултип каретки, ARIA-подпись) берутся из `lib/i18n.ts` — сторож
 * `guard-ui-i18n` (в `lib/ui/*` кириллических литералов нет). Заголовки
 * колонок и тексты пустых состояний вызывающий передаёт уже локализованными.
 *
 * **Семантика клика (требование 11ddd910 «Единые правила диалогов-списков»,
 * правило 6).** Клик ВСЕГДА только делает строку текущей (правило 5 —
 * подсветка `--row--current`) и никогда не активирует её; дальше — по режиму
 * списка:
 *  • список сам по себе (не выбор): вызывающий передаёт {@link TreeOptions.onDblActivate}
 *    — двойной клик и Enter открывают редактор ({@link TreeOptions.onActivate});
 *  • выбор одиночного значения (пикер): `onDblActivate` не задан — двойной
 *    клик и Enter ПОДТВЕРЖДАЮТ выбор ({@link TreeOptions.onActivate}; эквивалент
 *    кнопки «Выбрать», пикер закрывает диалог) — ошибка d1a009fa;
 *  • выбор нескольких: {@link TreeOptions.checkbox} — клик переключает флажок
 *    (и ставит текущую строку), двойной клик — {@link TreeOptions.onDblActivate}.
 *
 * **Позиционирование и копирование (правила 7 и 2 того же требования).**
 * {@link TreeHandle.revealRow} раскрывает цепочку предков, делает строку
 * текущей и прокручивает к ней — кнопка «Добавить» после записи обязана
 * вызывать её для новой записи. {@link TreeHandle.copyCurrent} (Ctrl+C и
 * кнопка «Копировать») пишет текст текущей строки — его задаёт
 * {@link TreeOptions.copyText}.
 *
 * **Разметка, а не вендорский `wa-tree`.** По той же причине, что у
 * `choice-row.ts`/`tabs.ts`: тестируемость на общем DOM-шиме (custom elements
 * вендора в нём не исполняются) и полный контроль над клавиатурой/ARIA.
 * Вид задают токены (`./tree.css`); вендорскую реализацию можно подставить
 * позже, не трогая потребителей (ADR 03eb2c61).
 */

import { div, el, span } from '../dom.js';
import { t } from '../i18n.js';
import { showMenuAt, type MenuItem } from '../menu.js';
import { badge } from './badge.js';
import { choiceControl } from './choice-row.js';
import { emptyState, type StateAction } from './empty-state.js';

/** Корневой класс дерева (роль `tree`). */
export const TREE_CLASS = 'ui-tree';

/**
 * Атрибут-метка корня дерева: контейнер клавиатурной навигации, которому
 * каркас диалога возвращает фокус после закрытия открытого над списком
 * редактора (ошибка 28d69bc6, правило 10 требования 11ddd910). Корень дерева —
 * устойчивый якорь: он переживает перерисовку строк (`render` заменяет только
 * детей), хранит текущую строку и владеет `keydown`-навигацией.
 */
export const TREE_FOCUS_ANCHOR_ATTR = 'data-focus-anchor';

/** Класс строки дерева (роль `treeitem`). */
export const TREE_ROW_CLASS = 'ui-tree-row';

/** Класс текущей (выделенной клавиатурой) строки. */
export const TREE_ROW_CURRENT_CLASS = 'ui-tree-row--current';

/** Класс каретки раскрытия (кнопка) и её пустой колонки у листа. */
export const TREE_CARET_CLASS = 'ui-tree-caret';

/** Класс флажка строки (множественный выбор). */
export const TREE_CHECK_CLASS = 'ui-tree-check';

/** Класс контейнера содержимого (значок + облачко/подпись). */
export const TREE_CONTENT_CLASS = 'ui-tree-content';

/** Класс текстовой подписи строки (одна строка с многоточием, `title` — полный текст). */
export const TREE_LABEL_CLASS = 'ui-tree-label';

/** Класс дополнительной колонки строки. */
export const TREE_CELL_CLASS = 'ui-tree-cell';

/** Класс строки заголовков колонок. */
export const TREE_HEAD_CLASS = 'ui-tree-head';

/** Класс пустого состояния дерева. */
export const TREE_EMPTY_CLASS = 'ui-tree-empty';

/** Класс бейджа-счётчика детей. */
export const TREE_COUNT_CLASS = 'ui-tree-count';

/** Глифы каретки (раскрыто/свёрнуто) — те же, что у выпадашки-подсказчика. */
export const TREE_CARET_OPEN = '▾';
export const TREE_CARET_CLOSED = '▸';

/** Узел дерева, каким его видит компонент: только структура, без содержимого. */
export interface TreeItem {
  /** Уникальный идентификатор узла. */
  id: string;
  /** Идентификатор родителя; `null`/не задан — верхний уровень. */
  parentId?: string | null;
  /** У узла есть потомки (каретка и `aria-expanded`). */
  hasChildren?: boolean;
  /** Текст, по которому матчит встроенный фильтр (подпись + синонимы). */
  filterText?: string;
}

/** Контекст строки для {@link TreeOptions.renderContent}. */
export interface TreeRowContext {
  /** Уровень в дереве, начиная с 1. */
  depth: number;
  /** Ветвь раскрыта. */
  expanded: boolean;
  /** Строка текущая (выделена клавиатурой). */
  current: boolean;
  /** У узла есть потомки. */
  hasChildren: boolean;
  /** Число прямых потомков. */
  childCount: number;
}

/** Дополнительная (не древовидная) колонка строки. */
export interface TreeColumn<T extends TreeItem> {
  /** Ключ колонки (попадает в `data-col`). */
  key: string;
  /** Локализованный заголовок; пусто — колонки нет в строке заголовков. */
  header?: string;
  /** CSS-ширина трека (например, `12rem`); нет — по содержимому. */
  width?: string;
  /** Выравнивание содержимого. */
  align?: 'start' | 'center' | 'end';
  /** Содержимое ячейки (узел или текст). */
  render: (item: T) => Node | string;
}

/** Опции {@link createTree}. */
export interface TreeOptions<T extends TreeItem> {
  /** Узлы дерева: массив или поставщик (перечитывается на каждом рендере). */
  items: readonly T[] | (() => readonly T[]);
  /** Содержимое древовидной колонки после каретки/отступа (значок + подпись). */
  renderContent: (item: T, ctx: TreeRowContext) => Node | readonly Node[];
  /** Дополнительные колонки после древовидной. */
  columns?: readonly TreeColumn<T>[];
  /** Заголовок древовидной колонки; задан — рисуется строка заголовков. */
  treeColumnHeader?: string;
  /** Локализованный текст пустого состояния; по умолчанию — `t('tree.empty')`. */
  emptyText?: string;
  /**
   * Подсказка пустого состояния — что сделать, чтобы строки появились
   * (локализована); по умолчанию `t('tree.emptyHint')`.
   */
  emptyHint?: string;
  /** Точка входа к действию из пустого состояния (необязательна). */
  emptyAction?: StateAction;
  /** ARIA-подпись дерева. */
  ariaLabel?: string;
  /** Множественный выбор: флажок в каждой строке. */
  checkbox?: boolean;
  /** Состояние флажка строки. */
  isChecked?: (item: T) => boolean;
  /** Переключение флажка (клик по строке или Space). */
  onCheck?: (item: T, checked: boolean) => void;
  /** Активация строки: Enter, а без {@link TreeOptions.onDblActivate} — и
   *  двойной клик (пикер подтверждает выбор; эквивалент «Выбрать»). */
  onActivate?: (item: T) => void;
  /**
   * Двойной клик по строке — редактор (правило 6 требования 11ddd910).
   * Задан — двойной клик и Enter открывают редактор ({@link TreeOptions.onActivate}),
   * а клик по строке без флажка только ставит её текущей; в режиме флажка клик
   * по-прежнему переключает флажок. Не задан — список считается ПИКЕРОМ:
   * двойной клик и Enter подтверждают выбор ({@link TreeOptions.onActivate}),
   * клик только делает строку текущей (ошибка d1a009fa).
   */
  onDblActivate?: (item: T) => void;
  /** Текущая строка сменилась (клик, клавиатура, `setCurrentId`/`revealRow`). */
  onCurrentChange?: (id: string | null) => void;
  /** Текст текущей строки для копирования; не задан — копирования нет. */
  copyText?: (item: T) => string;
  /**
   * Пункты контекстного меню строки (общий словарь `../menu.ts`). Каждая
   * строка списка-диалога получает меню действий над собой (требование
   * 11ddd910, правило 8): «Изменить», «Удалить», «Копировать», «Развернуть/
   * Свернуть» — в зависимости от допустимости. Пусто — меню не показывается.
   */
  rowMenu?: (item: T) => MenuItem[];
  /** Запись в буфер обмена; по умолчанию `navigator.clipboard.writeText`. */
  clipboard?: (text: string) => void;
  /** Вызывается после формирования текста копирования (для тестов/логов). */
  onCopy?: (text: string) => void;
  /** Начальный набор раскрытых узлов. */
  expandedIds?: Iterable<string>;
  /** Раскрыть всё дерево при создании. */
  expandAll?: boolean;
  /** Уведомление о переключении ветви. */
  onExpand?: (item: T, expanded: boolean) => void;
  /** Начальный запрос фильтра. */
  filter?: string;
  /** Текст узла для фильтра; сильнее `item.filterText`. */
  filterText?: (item: T) => string | undefined;
  /** Показывать бейдж с числом прямых потомков. */
  showChildCount?: boolean;
  /** Дополнительный класс строки (модификатор владельца). */
  rowClass?: (item: T) => string | undefined;
  /** Дополнительный класс корня. */
  class?: string;
}

/** Управление построенным деревом. */
export interface TreeHandle<T extends TreeItem> {
  /** Корневой узел (роль `tree`). */
  root: HTMLElement;
  /** Перерисовать дерево по текущим данным/состоянию. */
  render(): void;
  /** Заменить узлы и перерисовать. */
  setItems(items: readonly T[]): void;
  /** Задать запрос фильтра и перерисовать. */
  setFilter(query: string): void;
  /** Текущий запрос фильтра. */
  getFilter(): string;
  /** Идентификаторы видимых строк в порядке отображения. */
  getVisibleIds(): string[];
  /** Текущая (выделенная) строка. */
  getCurrentId(): string | null;
  /** Сделать строку текущей. */
  setCurrentId(id: string | null): void;
  /** Идентификатор узла раскрыт. */
  isExpanded(id: string): boolean;
  /** Раскрыть/свернуть узел. */
  setExpanded(id: string, open: boolean): void;
  /**
   * Позиционирует список на строке (правило 7 требования 11ddd910): раскрывает
   * цепочку её предков, делает строку текущей и прокручивает к ней. После
   * записи нового элемента («Добавить» → редактор → «Применить») вызывающий
   * обязан вызвать её для новой записи.
   */
  revealRow(id: string): void;
  /**
   * Копирует текст текущей строки ({@link TreeOptions.copyText}) в буфер —
   * кнопка «Копировать» строки управления и Ctrl+C. `false` — строки нет или
   * копирование не задано.
   */
  copyCurrent(): boolean;
  /** Раскрыть перечисленные узлы (цепочка предков) и перерисовать один раз. */
  expand(ids: Iterable<string>): void;
  /** Раскрыть всё дерево. */
  expandAll(): void;
  /** Свернуть всё (кроме `keepExpanded`). */
  collapseAll(keepExpanded?: Iterable<string>): void;
}

// ---------------------------------------------------------------------------
// Чистые помощники над плоским списком узлов (проверяются юнит-тестами)
// ---------------------------------------------------------------------------

/** Выделенный текст узла для фильтра. */
function itemTextOf<T extends TreeItem>(item: T, textOf?: (item: T) => string | undefined): string {
  return textOf?.(item) ?? item.filterText ?? '';
}

/** Прямые потомки узла: `parentId` → список id (в порядке списка). */
export function treeChildIds<T extends TreeItem>(items: readonly T[], id: string): string[] {
  const out: string[] = [];
  for (const item of items) {
    const parent = item.parentId ?? null;
    if (parent !== null && parent !== item.id && parent === id) out.push(item.id);
  }
  return out;
}

/** Карта «id узла → число прямых потомков». */
export function treeChildCounts<T extends TreeItem>(items: readonly T[]): Map<string, number> {
  const known = new Set(items.map((item) => item.id));
  const counts = new Map<string, number>();
  for (const item of items) {
    const parent = item.parentId ?? null;
    if (parent === null || parent === item.id || !known.has(parent)) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

/** Уровень узла в дереве (верхний = 1); цикл/неизвестный родитель обрывают путь. */
export function treeDepthOf<T extends TreeItem>(items: readonly T[], id: string): number {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let depth = 1;
  let current = byId.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const parent: string | null = current.parentId ?? null;
    if (parent === null || parent === current.id) break;
    const parentItem = byId.get(parent);
    if (parentItem === undefined || seen.has(parentItem.id)) break;
    depth += 1;
    current = parentItem;
  }
  return depth;
}

/**
 * Цепочка предков узла от родителя к корню (сам узел не входит). Циклы и
 * неизвестные родители обрывают путь. Чистая — юнит-тест; на ней стоит
 * {@link TreeHandle.revealRow} (правило 7 требования 11ddd910).
 */
export function treeAncestorIds<T extends TreeItem>(items: readonly T[], id: string): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id);
  while (current !== undefined) {
    const parent: string | null = current.parentId ?? null;
    if (parent === null || parent === current.id || seen.has(parent)) break;
    const parentItem = byId.get(parent);
    if (parentItem === undefined) break;
    chain.push(parent);
    seen.add(parent);
    current = parentItem;
  }
  return chain;
}

/**
 * Узлы, которые фильтр оставляет видимыми: совпадения и вся цепочка их предков
 * (совпадение не теряет ветвь). Пустой запрос — `null` («фильтра нет»).
 */
export function treeFilterKeepIds<T extends TreeItem>(
  items: readonly T[],
  query: string,
  textOf?: (item: T) => string | undefined,
): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  const keep = new Set<string>();
  for (const item of items) {
    if (!itemTextOf(item, textOf).toLowerCase().includes(needle)) continue;
    let current: T | undefined = item;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      keep.add(current.id);
      const parent: string | null = current.parentId ?? null;
      current = parent === null ? undefined : byId.get(parent);
    }
  }
  return keep;
}

/**
 * Идентификаторы видимых строк в порядке списка: скрыты потомки свёрнутых
 * ветвей и (при фильтре) всё, кроме совпадений с цепочкой предков. Под
 * фильтром цепочки предков раскрыты принудительно — совпадение всегда видно.
 */
export function treeVisibleIds<T extends TreeItem>(
  items: readonly T[],
  expanded: ReadonlySet<string>,
  filter: string,
  textOf?: (item: T) => string | undefined,
): string[] {
  const keep = treeFilterKeepIds(items, filter, textOf);
  const byId = new Map(items.map((item) => [item.id, item]));
  const expandedForWalk = keep === null ? expanded : keep;
  const chainOpen = (item: T): boolean => {
    const seen = new Set<string>();
    let current: T | undefined = item;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent: string | null = current.parentId ?? null;
      if (parent === null || parent === current.id) return true;
      const parentItem = byId.get(parent);
      if (parentItem === undefined) return true;
      if (keep !== null && !keep.has(parent)) return false;
      if (!expandedForWalk.has(parent)) return false;
      current = parentItem;
    }
    return true;
  };
  const out: string[] = [];
  for (const item of items) {
    if (keep !== null && !keep.has(item.id)) continue;
    if (!chainOpen(item)) continue;
    out.push(item.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Компонент
// ---------------------------------------------------------------------------

/** Сквозной счётчик деревьев — для уникальных id строк (`aria-activedescendant`). */
let treeSeq = 0;

/** Дополнительные классы элемента строки (модификатор владельца). */
function rowExtraClass(name: string | undefined): string | undefined {
  return name !== undefined && name.trim() !== '' ? name.trim() : undefined;
}

/**
 * Строит дерево списков. Возвращает {@link TreeHandle}: рендер, фильтр,
 * раскрытие, текущая строка. Все строки — из словаря/параметров, размеры —
 * по токенам (`./tree.css`).
 */
export function createTree<T extends TreeItem>(options: TreeOptions<T>): TreeHandle<T> {
  treeSeq += 1;
  const prefix = `ui-tree-${treeSeq}`;
  const textOf = options.filterText;

  const itemsOf = (): readonly T[] =>
    typeof options.items === 'function' ? options.items() : options.items;

  let expanded = new Set<string>(options.expandedIds ?? []);
  let filter = options.filter ?? '';
  let currentId: string | null = null;

  const root = div(
    options.class !== undefined && options.class.trim() !== ''
      ? `${TREE_CLASS} ${options.class.trim()}`
      : TREE_CLASS,
  );
  root.setAttribute('role', 'tree');
  root.setAttribute(TREE_FOCUS_ANCHOR_ATTR, '');
  root.tabIndex = 0;
  if (options.ariaLabel !== undefined) root.setAttribute('aria-label', options.ariaLabel);
  if (options.checkbox === true) root.setAttribute('aria-multiselectable', 'true');

  // Клик мышью по дереву/строке переводит клавиатурный фокус на корень дерева:
  // стрелочная навигация работает сразу, а каркас диалога возвращает фокус сюда
  // после закрытия открытого над списком редактора (ошибка 28d69bc6). Клик по
  // флажку/каретке (кнопке) фокус не перехватывает — у них своё поведение.
  root.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target !== null && typeof target.closest === 'function' && target.closest('input, button') !== null) {
      return;
    }
    root.focus();
  });

  /** Раскрыть всё дерево: все узлы с потомками. */
  function collectExpandable(): string[] {
    const items = itemsOf();
    const counts = treeChildCounts(items);
    return items.filter((item) => (item.hasChildren ?? false) || (counts.get(item.id) ?? 0) > 0).map((item) => item.id);
  }

  if (options.expandAll === true) expanded = new Set(collectExpandable());
  else if (options.expandedIds === undefined) expanded = new Set();

  function applyExpand(id: string, open: boolean, item?: T): void {
    if (open) expanded.add(id);
    else expanded.delete(id);
    if (item !== undefined && options.onExpand !== undefined) options.onExpand(item, open);
  }

  function visible(): string[] {
    return treeVisibleIds(itemsOf(), expanded, filter, textOf);
  }

  /** Узел, если он виден; иначе — первый видимый (текущая строка не «слепнет»). */
  function normalizeCurrent(): void {
    const ids = visible();
    if (ids.length === 0) {
      currentId = null;
      return;
    }
    if (currentId === null || !ids.includes(currentId)) currentId = ids[0] ?? null;
  }

  /** Уведомить владельца о смене текущей строки (клавиатура, клик, reveal). */
  function notifyCurrent(): void {
    options.onCurrentChange?.(currentId);
  }

  /**
   * Перекрашивает подсветку текущей строки БЕЗ пересборки дерева. Клик по
   * строке обязан НЕ заменять элементы: иначе второй клик двойного клика
   * попадает в пересозданный узел и браузер не присылает `dblclick`
   * (правило 6 требования 11ddd910 — двойной клик открывает редактор).
   */
  function paintCurrent(): void {
    const currentRow =
      currentId === null ? null : root.querySelector(`#${cssId(currentId)}`);
    for (const row of root.querySelectorAll<HTMLElement>('.' + TREE_ROW_CLASS)) {
      const isCurrent = row === currentRow;
      row.classList.toggle(TREE_ROW_CURRENT_CLASS, isCurrent);
      row.setAttribute('aria-selected', String(isCurrent));
    }
    if (currentId !== null) root.setAttribute('aria-activedescendant', cssId(currentId));
    else root.removeAttribute('aria-activedescendant');
  }

  function moveCurrent(delta: number): void {
    const ids = visible();
    if (ids.length === 0) return;
    const index = currentId === null ? -1 : ids.indexOf(currentId);
    const next = Math.max(0, Math.min(ids.length - 1, (index < 0 ? 0 : index) + delta));
    currentId = ids[next] ?? currentId;
    render();
    scrollCurrentIntoView();
    notifyCurrent();
  }

  function scrollCurrentIntoView(): void {
    if (currentId === null) return;
    root.querySelector(`#${cssId(currentId)}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Безопасный id элемента строки (id узла может содержать любые символы). */
  function cssId(id: string): string {
    return `${prefix}-${id.replace(/[^\w-]/g, '_')}`;
  }

  function toggleCheck(
    item: T,
    input: HTMLInputElement,
    checked: boolean,
    row?: HTMLElement | null,
  ): void {
    input.checked = checked;
    const host = row ?? input.parentElement ?? null;
    if (host !== null) host.setAttribute('aria-checked', String(checked));
    options.onCheck?.(item, checked);
  }

  function buildCaret(item: T, hasChildren: boolean, isOpen: boolean): HTMLElement {
    if (!hasChildren) {
      const spacer = span('', `${TREE_CARET_CLASS} ${TREE_CARET_CLASS}--leaf`);
      spacer.setAttribute('aria-hidden', 'true');
      return spacer;
    }
    const caret = el('button', TREE_CARET_CLASS, isOpen ? TREE_CARET_OPEN : TREE_CARET_CLOSED) as HTMLButtonElement;
    caret.type = 'button';
    caret.tabIndex = -1;
    caret.title = t('tree.toggle');
    caret.setAttribute('aria-hidden', 'true');
    caret.addEventListener('mousedown', (event) => event.preventDefault());
    caret.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyExpand(item.id, !expanded.has(item.id), item);
      render();
    });
    return caret;
  }

  function buildRow(item: T, counts: Map<string, number>, items: readonly T[]): HTMLElement {
    const depth = treeDepthOf(items, item.id);
    const childCount = counts.get(item.id) ?? 0;
    const hasChildren = (item.hasChildren ?? false) || childCount > 0;
    const isOpen = expanded.has(item.id);
    const isCurrent = item.id === currentId;

    const row = div(TREE_ROW_CLASS);
    const extra = rowExtraClass(options.rowClass?.(item));
    if (extra !== undefined) row.classList.add(...extra.split(/\s+/));
    if (isCurrent) row.classList.add(TREE_ROW_CURRENT_CLASS);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth));
    row.id = cssId(item.id);
    row.dataset['treeId'] = item.id;
    if (hasChildren) row.setAttribute('aria-expanded', String(isOpen));
    row.setAttribute('aria-selected', String(isCurrent));
    row.style.setProperty('--tree-level', String(Math.max(0, depth - 1)));

    row.append(buildCaret(item, hasChildren, isOpen));

    let input: HTMLInputElement | null = null;
    if (options.checkbox === true) {
      const checked = options.isChecked?.(item) ?? false;
      input = choiceControl('checkbox', { checked });
      input.classList.add(TREE_CHECK_CLASS);
      input.tabIndex = -1;
      input.addEventListener('change', () => options.onCheck?.(item, input!.checked));
      row.setAttribute('aria-checked', String(checked));
      row.append(input);
    }

    const content = div(TREE_CONTENT_CLASS);
    const ctx: TreeRowContext = { depth, expanded: isOpen, current: isCurrent, hasChildren, childCount };
    const rendered = options.renderContent(item, ctx);
    if (Array.isArray(rendered)) content.append(...(rendered as Node[]));
    else content.append(rendered as Node);
    row.append(content);

    if (options.showChildCount === true && childCount > 0) {
      row.append(badge(String(childCount), { kind: 'quiet', extraClass: TREE_COUNT_CLASS }));
    }

    for (const column of options.columns ?? []) {
      const cell = div(`${TREE_CELL_CLASS} ${TREE_CELL_CLASS}--${column.key}`);
      cell.dataset['col'] = column.key;
      if (column.width !== undefined) cell.style.flexBasis = column.width;
      if (column.align === 'end') cell.classList.add(`${TREE_CELL_CLASS}--end`);
      else if (column.align === 'center') cell.classList.add(`${TREE_CELL_CLASS}--center`);
      const value = column.render(item);
      if (typeof value === 'string') {
        cell.textContent = value;
        // Колонки обрезаются многоточием (ошибка d866bc65) — полный текст
        // всегда доступен подсказкой.
        cell.title = value;
      } else {
        cell.append(value);
      }
      row.append(cell);
    }

    const checkboxInput = input;
    row.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && typeof target.closest === 'function' && target.closest('button') !== null) return;
      const wasCurrent = currentId === item.id;
      currentId = item.id;
      if (checkboxInput !== null) {
        if (target === checkboxInput) {
          if (!wasCurrent) {
            paintCurrent();
            notifyCurrent();
          }
          return; // нативный change флажка уже сработал
        }
        // Флажок и `aria-checked` синхронизирует toggleCheck; строка НЕ
        // пересобирается — иначе второй клик двойного клика придёт в новый
        // узел и `dblclick` (редактор, правило 6) не сработает.
        toggleCheck(item, checkboxInput, !checkboxInput.checked, row);
        if (!wasCurrent) {
          paintCurrent();
          notifyCurrent();
        }
        return;
      }
      // Правило 6 требования 11ddd910: одиночный клик ТОЛЬКО делает строку
      // текущей — не активирует. Активация — Enter или двойной клик: при
      // заданном `onDblActivate` это редактор строки (список), без него —
      // подтверждение выбора (пикер, эквивалент кнопки «Выбрать»), см.
      // обработчик `dblclick` ниже (ошибка d1a009fa).
      if (!wasCurrent) {
        paintCurrent();
        notifyCurrent();
      }
      return;
    });
    // Двойной клик — активация строки: редактор (задан `onDblActivate`) либо
    // подтверждение выбора в пикере (`onActivate`), правило 6 требования
    // 11ddd910. Флажковый режим переключается обычными кликами; двойной клик
    // поверх — дополнительным событием.
    row.addEventListener('dblclick', () => {
      // Двойной клик подтверждает/активирует ту строку, по которой он сделан,
      // и делает её текущей (правило 5) — как и одиночный клик.
      if (currentId !== item.id) {
        currentId = item.id;
        paintCurrent();
        notifyCurrent();
      }
      (options.onDblActivate ?? options.onActivate)?.(item);
    });
    // Контекстное меню строки (правило 8 требования 11ddd910): строка сначала
    // становится текущей, затем показывается её меню — команды действуют на ту
    // строку, из которой меню вызвано.
    row.addEventListener('contextmenu', (event) => {
      const items = options.rowMenu?.(item) ?? [];
      if (items.length === 0) return;
      event.preventDefault();
      if (currentId !== item.id) {
        currentId = item.id;
        paintCurrent();
        notifyCurrent();
      }
      const mouse = event as MouseEvent;
      showMenuAt(mouse.clientX ?? 0, mouse.clientY ?? 0, items);
    });

    return row;
  }

  function buildHead(): HTMLElement | null {
    const columns = options.columns ?? [];
    const hasHeaders = options.treeColumnHeader !== undefined || columns.some((c) => c.header !== undefined);
    if (!hasHeaders) return null;
    const head = div(TREE_HEAD_CLASS);
    head.setAttribute('role', 'presentation');
    const treeCell = div(`${TREE_CELL_CLASS} ${TREE_CELL_CLASS}--tree`);
    treeCell.textContent = options.treeColumnHeader ?? '';
    head.append(treeCell);
    for (const column of columns) {
      const cell = div(`${TREE_CELL_CLASS} ${TREE_CELL_CLASS}--${column.key}`);
      if (column.header !== undefined) cell.textContent = column.header;
      if (column.width !== undefined) cell.style.flexBasis = column.width;
      if (column.align === 'end') cell.classList.add(`${TREE_CELL_CLASS}--end`);
      head.append(cell);
    }
    return head;
  }

  function render(): void {
    const items = itemsOf();
    const counts = treeChildCounts(items);
    normalizeCurrent();
    const ids = visible();
    const byId = new Map(items.map((item) => [item.id, item]));

    const nodes: Node[] = [];
    const head = buildHead();
    if (head !== null) nodes.push(head);
    if (ids.length === 0) {
      const empty = emptyState({
        title: options.emptyText ?? t('tree.empty'),
        hint: options.emptyHint ?? t('tree.emptyHint'),
        ...(options.emptyAction !== undefined ? { action: options.emptyAction } : {}),
      });
      empty.classList.add(TREE_EMPTY_CLASS);
      nodes.push(empty);
    } else {
      for (const id of ids) {
        const item = byId.get(id);
        if (item !== undefined) nodes.push(buildRow(item, counts, items));
      }
    }
    root.replaceChildren(...nodes);
    if (currentId !== null) root.setAttribute('aria-activedescendant', cssId(currentId));
    else root.removeAttribute('aria-activedescendant');
  }

  root.addEventListener('keydown', (event) => {
    const keyEvent = event as KeyboardEvent;
    // Копирование текущей строки — Ctrl+C (правило 2 требования 11ddd910,
    // кнопка «Копировать» строки управления).
    if ((keyEvent.ctrlKey === true || keyEvent.metaKey === true) && (keyEvent.key === 'c' || keyEvent.key === 'C')) {
      keyEvent.preventDefault();
      copyCurrent();
      return;
    }
    const items = itemsOf();
    const byId = new Map(items.map((item) => [item.id, item]));
    const ids = visible();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveCurrent(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveCurrent(-1);
        return;
      case 'Home':
        event.preventDefault();
        currentId = ids[0] ?? null;
        render();
        scrollCurrentIntoView();
        notifyCurrent();
        return;
      case 'End':
        event.preventDefault();
        currentId = ids[ids.length - 1] ?? null;
        render();
        scrollCurrentIntoView();
        notifyCurrent();
        return;
      case 'ArrowRight': {
        event.preventDefault();
        if (currentId === null) return;
        const item = byId.get(currentId);
        if (item === undefined) return;
        if (expanded.has(currentId)) {
          const child = treeChildIds(items, currentId)[0];
          if (child !== undefined) {
            currentId = child;
            render();
            scrollCurrentIntoView();
            notifyCurrent();
          }
        } else {
          applyExpand(currentId, true, item);
          render();
        }
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (currentId === null) return;
        const item = byId.get(currentId);
        if (item === undefined) return;
        if (expanded.has(currentId)) {
          applyExpand(currentId, false, item);
          render();
        } else {
          const parent = item.parentId ?? null;
          if (parent !== null && ids.includes(parent)) {
            currentId = parent;
            render();
            scrollCurrentIntoView();
            notifyCurrent();
          }
        }
        return;
      }
      case ' ': {
        event.preventDefault();
        if (currentId === null) return;
        const item = byId.get(currentId);
        if (item === undefined) return;
        if (options.checkbox !== true) return;
        const row = root.querySelector(`#${cssId(currentId)}`);
        const input = row?.querySelector(`.${TREE_CHECK_CLASS}`) as HTMLInputElement | null;
        if (input !== null && input !== undefined) toggleCheck(item, input, !input.checked);
        return;
      }
      case 'Enter': {
        event.preventDefault();
        if (currentId === null) return;
        const item = byId.get(currentId);
        if (item !== undefined) options.onActivate?.(item);
        return;
      }
      default:
        return;
    }
  });

  /** Копирует текст текущей строки (см. {@link TreeHandle.copyCurrent}). */
  function copyCurrent(): boolean {
    if (currentId === null || options.copyText === undefined) return false;
    const item = itemsOf().find((candidate) => candidate.id === currentId);
    if (item === undefined) return false;
    const text = options.copyText(item);
    options.onCopy?.(text);
    if (options.clipboard !== undefined) options.clipboard(text);
    else void navigator.clipboard?.writeText(text);
    return true;
  }

  const handle: TreeHandle<T> = {
    root,
    render,
    setItems(items) {
      options.items = items;
      render();
    },
    setFilter(query) {
      filter = query;
      render();
    },
    getFilter() {
      return filter;
    },
    getVisibleIds: visible,
    getCurrentId() {
      return currentId;
    },
    setCurrentId(id) {
      currentId = id;
      render();
      scrollCurrentIntoView();
      notifyCurrent();
    },
    isExpanded(id) {
      return expanded.has(id);
    },
    setExpanded(id, open) {
      applyExpand(id, open, itemsOf().find((item) => item.id === id));
      render();
    },
    revealRow(id) {
      // Правило 7 требования 11ddd910: после записи нового элемента список
      // позиционируется на нём — раскрываем цепочку предков, ставим текущей,
      // прокручиваем.
      for (const ancestor of treeAncestorIds(itemsOf(), id)) expanded.add(ancestor);
      currentId = id;
      render();
      scrollCurrentIntoView();
      notifyCurrent();
    },
    copyCurrent,
    expand(ids) {
      for (const id of ids) expanded.add(id);
      render();
    },
    expandAll() {
      expanded = new Set(collectExpandable());
      render();
    },
    collapseAll(keepExpanded) {
      expanded = new Set(keepExpanded ?? []);
      render();
    },
  };

  render();
  return handle;
}
