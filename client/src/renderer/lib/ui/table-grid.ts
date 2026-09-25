/**
 * Тонкий адаптер табличного фасада к Vaadin Grid (задача dad2b029,
 * требование 93115633, ADR 03eb2c61).
 *
 * Ваддинг «наши данные/состояние ↔ вендорский элемент» — единственное место,
 * где фасад `./table.ts` касается вендорского Grid. Задача адаптера узкая:
 *  • получить/создать элемент `<vaadin-grid>`;
 *  • отдать ему готовое описание колонок и массив строк;
 *  • подсветить текущую (`activeItem`) и выделенные (`selectedItems`) строки;
 *  • прокрутить к строке (`scrollToIndex`);
 *  • перевести DOM-события сетки в индексы строк (`getEventContext`);
 *  • попросить фасад пересчитать сортировку (`sort-changed`).
 *
 * Вся логика (цикл сортировки, порядок строк, навигационная математика, TSV,
 * меню) живёт в `./table.ts` и чистых функциях — поэтому она тестируется без
 * настоящего Grid. Этот модуль НЕ импортирует пакет `@vaadin/grid`: custom
 * element регистрирует `./register.ts` (единственная точка подключения
 * вендора), а здесь элемент создаётся по имени. Благодаря этому `./table.ts`
 * импортируется тестами на DOM-шиме без загрузки lit и вендорских модулей, а
 * сам Grid в тестах замещается стабом, реализующим {@link GridTableAdapter}.
 *
 * Вендорскому отдаются только те задачи, где он силён: виртуализация и
 * отрисовка строк. Сортировку фасад считает сам (см. шапку `./table.ts`),
 * `sort-changed` используется лишь как сигнал «кликнули заголовок».
 */

/** Точка вьюпорта для контекстного меню и кликов. */
export interface GridPoint {
  x: number;
  y: number;
}

/** Готовое описание одной колонки для адаптера. */
export interface GridColumnSpec {
  /** Ключ колонки (он же `path` для `sort-changed`). */
  key: string;
  /** Готовый заголовок (локализован вызывающим). */
  header: string;
  /** Ширина CSS (например, `12rem`); не задана — колонка тянется. */
  width?: string;
  /** Выравнивание содержимого ячейки. */
  align?: 'start' | 'center' | 'end';
  /** Сортируемая ли колонка. */
  sortable: boolean;
  /** Текущее направление сортировки этой колонки (`null` — не сортируется). */
  sortDir: 'asc' | 'desc' | null;
  /** Содержимое ячейки — готовый DOM-узел. */
  render: (row: unknown, index: number) => Node;
}

/**
 * Контракт адаптера сетки. Фасад владеет данными и состоянием, адаптер —
 * только отрисовкой строк вендорским элементом и трансляцией событий.
 * Тесты подставляют стаб, реализующий этот интерфейс, и наблюдают вызовы.
 */
export interface GridTableAdapter {
  /** Корневой элемент сетки (монтируется в обёртку фасада). */
  readonly element: HTMLElement;
  /** Заменяет описание колонок (вызывается при смене сортировки/языка). */
  setColumns(columns: readonly GridColumnSpec[]): void;
  /** Заменяет строки (уже в порядке отображения). */
  setItems(rows: readonly unknown[]): void;
  /** Подсвечивает текущую строку (`null` — снять подсветку). */
  setActive(row: unknown | null): void;
  /** Помечает выделенные строки. */
  setSelected(rows: readonly unknown[]): void;
  /** Прокручивает сетку к строке. */
  scrollToRow(row: unknown): void;
  /** Подписка на клик по заголовку сортируемой колонки (ключ колонки). */
  onSortRequest(cb: (key: string) => void): void;
  /** Подписка на клик по строке (индекс в текущем порядке + координаты). */
  onRowClick(cb: (index: number, at: GridPoint) => void): void;
  /** Подписка на двойной клик по строке. */
  onRowDblClick(cb: (index: number) => void): void;
  /** Подписка на контекстное меню строки (индекс + координаты). */
  onRowContextMenu(cb: (index: number, at: GridPoint) => void): void;
  /** Снимает слушатели и удаляет элемент. */
  destroy(): void;
}

/** Минимальная проекция вендорского `<vaadin-grid>` (без импорта типов пакета). */
interface VaadinGridElement extends HTMLElement {
  items: unknown[] | undefined;
  activeItem: unknown;
  selectedItems: unknown[] | undefined;
  /**
   * Генератор `part`-имён ячеек (Vaadin StylingMixin). Фасад помечает им ячейки
   * ТЕКУЩЕЙ строки (`row-current`) — единственная строка с подсветкой
   * (ошибка 4f27f85c: подсветка всех строк).
   */
  cellPartNameGenerator:
    | ((column: unknown, model: { item: unknown; index: number }) => string | null)
    | null;
  clearCache(): void;
  scrollToIndex(index: number): void;
  getEventContext(event: Event): { index?: number; item?: unknown } | null;
}

/** Минимальная проекция колонки Vaadin. */
interface VaadinGridColumnElement extends HTMLElement {
  header: string;
  path: string;
  width: string | null;
  flexGrow: number;
  direction: string | null;
  renderer:
    | ((root: HTMLElement, column: unknown, model: { item: unknown; index: number }) => void)
    | null;
}

/** Строит колонку-`vaadin-grid-column` (сортируемую — `-sort-column`). */
function buildColumn(spec: GridColumnSpec): VaadinGridColumnElement {
  const tag = spec.sortable ? 'vaadin-grid-sort-column' : 'vaadin-grid-column';
  const column = document.createElement(tag) as unknown as VaadinGridColumnElement;
  column.header = spec.header;
  column.path = spec.key;
  if (spec.width !== undefined) {
    column.width = spec.width;
    column.flexGrow = 0;
  }
  if (spec.sortable) column.direction = spec.sortDir;
  column.renderer = (root, _column, model): void => {
    root.textContent = '';
    root.append(spec.render(model.item, model.index));
    if (spec.align !== undefined) root.style.textAlign = spec.align;
  };
  return column;
}

/**
 * Адаптер поверх настоящего Vaadin Grid. Компонент создаётся по имени
 * (`document.createElement('vaadin-grid')`): пакет подключает `./register.ts`,
 * поэтому до регистрации элемент останется «неапгрейженным» — но фасад
 * создаётся после `import './register.js'` (см. `lib/ui/index.ts`).
 */
export function vaadinGridAdapter(): GridTableAdapter {
  const grid = document.createElement('vaadin-grid') as unknown as VaadinGridElement;
  grid.className = 'ui-table-grid';

  /**
   * Текущая строка (для `cellPartNameGenerator`). Подсветка — НЕ глобальным
   * токеном `--vaadin-grid-row-highlight-background-color` (он красил бы все
   * строки), а `part`-именем `row-current` только у ячеек текущей строки
   * (ошибка 4f27f85c). Смена активной строки заставляет сетку перегенерировать
   * части ячеек через {@link VaadinGridElement.clearCache}.
   */
  let activeRow: unknown = null;
  grid.cellPartNameGenerator = (_column, model): string | null =>
    activeRow !== null && model.item === activeRow ? 'row-current' : null;

  let sortCb: ((key: string) => void) | null = null;
  let clickCb: ((index: number, at: GridPoint) => void) | null = null;
  let dblCb: ((index: number) => void) | null = null;
  let ctxCb: ((index: number, at: GridPoint) => void) | null = null;

  const indexOfEvent = (event: Event): number | null => {
    const context = grid.getEventContext(event);
    return typeof context?.index === 'number' ? context.index : null;
  };

  grid.addEventListener('sort-changed', (event: Event) => {
    // `detail.path` — ключ колонки (мы задаём его в `buildColumn`); фолбэк —
    // сам элемент колонки, если деталь не пришла.
    const detail = (event as CustomEvent<{ path?: string }>).detail;
    const target = event.target as VaadinGridColumnElement | null;
    const key = detail?.path ?? target?.path;
    if (typeof key === 'string' && key !== '') sortCb?.(key);
  });
  grid.addEventListener('click', (event: MouseEvent) => {
    const index = indexOfEvent(event);
    if (index !== null) clickCb?.(index, { x: event.clientX, y: event.clientY });
  });
  grid.addEventListener('dblclick', (event: MouseEvent) => {
    const index = indexOfEvent(event);
    if (index !== null) dblCb?.(index);
  });
  grid.addEventListener('contextmenu', (event: MouseEvent) => {
    const index = indexOfEvent(event);
    if (index === null) return;
    event.preventDefault();
    ctxCb?.(index, { x: event.clientX, y: event.clientY });
  });

  return {
    element: grid,
    setColumns(columns: readonly GridColumnSpec[]): void {
      grid.replaceChildren(...columns.map(buildColumn));
    },
    setItems(rows: readonly unknown[]): void {
      grid.items = [...rows];
      grid.clearCache();
    },
    setActive(row: unknown | null): void {
      activeRow = row;
      grid.activeItem = row;
      // Перерисовать видимые строки — перегенерировать part-имена ячеек под
      // новую текущую строку (иначе подсветка осталась бы на прежней).
      grid.clearCache();
    },
    setSelected(rows: readonly unknown[]): void {
      grid.selectedItems = [...rows];
    },
    scrollToRow(row: unknown): void {
      const index = (grid.items ?? []).indexOf(row);
      if (index >= 0) grid.scrollToIndex(index);
    },
    onSortRequest(cb): void {
      sortCb = cb;
    },
    onRowClick(cb): void {
      clickCb = cb;
    },
    onRowDblClick(cb): void {
      dblCb = cb;
    },
    onRowContextMenu(cb): void {
      ctxCb = cb;
    },
    destroy(): void {
      grid.remove();
    },
  };
}
