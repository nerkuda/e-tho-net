/**
 * Демо-стенд компоненты `lib/row-reorder.ts` — прототип списка для раннего
 * визуального среза заказчику (0.14.1, задача 223f7d50).
 *
 * **Когда виден.** Только при `location.hash === '#row-reorder-demo'`.
 * Модуль подключается из `main.ts` и в обычной работе приложения ничего не
 * делает: ни разметки, ни слушателей, пока хэш не выставлен. Потребители
 * (таблица свойств, редактор типа) сюда НЕ подключены — это задачи Z7/Z8.
 *
 * **Что показывает.** Список-прототип из шести строк: перетаскивание за имя
 * (ячейка значения — не зона захвата), маркер вставки, авто-прокрутка, Esc,
 * `Alt+↑/↓` через общее ядро и контекстное меню «Переместить выше/ниже».
 * Порядок — только в памяти страницы; сервер не вызывается.
 */

import { div, el, span } from './dom.js';
import { showMenuAt } from './menu.js';
import { createRowReorder, rowReorderMenuItems } from './row-reorder.js';
import { createListNav, type ListNavHandle } from './ui/list.js';

/** Хэш, включающий демо-стенд. */
export const ROW_REORDER_DEMO_HASH = '#row-reorder-demo';

const DEMO_CLASS = 'row-reorder-demo';
const ROW_CLASS = 'row-reorder-demo-row';
const NAME_CLASS = 'row-reorder-demo-name';
const VALUE_CLASS = 'row-reorder-demo-value';
const CURRENT_CLASS = 'row-reorder-demo-current';

interface DemoRow {
  key: string;
  title: string;
  value: string;
  element: HTMLElement;
  nameElement: HTMLElement;
  valueElement: HTMLElement;
}

let mounted: { destroy(): void } | null = null;

/** Стили стенда — только токены темы; вид не входит в каталог `lib/ui`. */
function demoStyles(): string {
  return `
.${DEMO_CLASS} {
  position: fixed;
  inset: 0;
  z-index: 10000;
  box-sizing: border-box;
  padding: var(--space-6, 12px);
  overflow: auto;
  background: var(--bg, #fff);
  color: var(--text, #1b1b1b);
  font: var(--font-size-m, 13px) var(--user-font-ui, system-ui, sans-serif);
}
.${DEMO_CLASS} h1 { margin: 0 0 var(--space-2, 4px); font-size: var(--font-size-l, 16px); }
.${DEMO_CLASS} p { margin: 0 0 var(--space-4, 8px); color: var(--text-dim, #666); }
.${DEMO_CLASS}-list {
  max-width: 42rem;
  max-height: 60vh;
  overflow: auto;
  border: 1px solid var(--border, #ccc);
  border-radius: var(--radius-m, 6px);
  background: var(--surface, #fff);
}
.${ROW_CLASS} {
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 1.4fr);
  gap: var(--space-3, 6px);
  align-items: center;
  padding: var(--space-2, 4px) var(--space-3, 6px);
  border-bottom: 1px solid var(--border-weak, #e5e5e5);
  outline: none;
  background: var(--surface, #fff);
}
.${ROW_CLASS}:last-child { border-bottom: none; }
.${ROW_CLASS}.${CURRENT_CLASS} {
  box-shadow: inset 0 0 0 2px var(--focus, #3b82f6);
  background: var(--surface-hover, #f5f7ff);
}
.${NAME_CLASS} { cursor: grab; font-weight: var(--font-weight-medium, 500); }
.${NAME_CLASS}:active { cursor: grabbing; }
.${VALUE_CLASS} { color: var(--text-dim, #666); }
.${DEMO_CLASS}-status { margin-top: var(--space-4, 8px); color: var(--text-dim, #666); }
.${DEMO_CLASS}-foot { margin-top: var(--space-3, 6px); color: var(--text-dim, #666); }
`;
}

/** Порядок строк демо — только память страницы. */
function buildRows(): DemoRow[] {
  const seeds: Array<[string, string]> = [
    ['Альфа', 'значение 1'],
    ['Бета', 'значение 2'],
    ['Гамма', 'значение 3'],
    ['Дельта', 'значение 4'],
    ['Эпсилон', 'значение 5'],
    ['Дзета', 'значение 6'],
  ];
  return seeds.map(([title, value], index) => {
    const element = div(ROW_CLASS);
    element.tabIndex = 0;
    const nameElement = span(title, NAME_CLASS);
    const valueElement = span(value, VALUE_CLASS);
    element.append(nameElement, valueElement);
    return { key: `demo-${index}`, title, value, element, nameElement, valueElement };
  });
}

function mountDemo(): void {
  if (mounted !== null) return;
  const style = el('style');
  style.textContent = demoStyles();
  document.head.append(style);

  const screen = div(DEMO_CLASS);
  screen.append(
    el('h1', '', 'row-reorder — прототип компоненты'),
    el(
      'p',
      '',
      'Перетащите строку за имя, используйте Alt+↑/↓ или контекстное меню имени. Esc отменяет перетаскивание.',
    ),
  );

  const list = div(`${DEMO_CLASS}-list`);
  list.tabIndex = 0;
  const status = el('div', `${DEMO_CLASS}-status`, 'Порядок: исходный.');
  const foot = el(
    'div',
    `${DEMO_CLASS}-foot`,
    'Демо-стенд: порядок хранится только на странице, сервер не вызывается.',
  );
  screen.append(list, status, foot);
  document.body.append(screen);

  const rows = buildRows();
  let nav: ListNavHandle<DemoRow> | null = null;

  const describeOrder = (): string =>
    `Порядок: ${rows.map((row) => row.title).join(' · ')}.`;

  /** Единый колбэк перестановки — тот же, что у потребителей компоненты. */
  const moveRow = (from: number, to: number): void => {
    if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
    const [moved] = rows.splice(from, 1);
    if (moved === undefined) return;
    rows.splice(to, 0, moved);
    // Демо перерисовывает порядок целиком: строки — обычные div, не keyed-список.
    for (const row of rows) list.append(row.element);
    nav?.refresh();
    status.textContent = describeOrder();
  };

  const renderRows = (): void => {
    list.replaceChildren(...rows.map((row) => row.element));
  };
  renderRows();

  nav = createListNav<DemoRow>(list, {
    entries: () => rows,
    tokenOf: (row) => row.key,
    elementOf: (row) => row.element,
    applyHighlight: (row) => {
      for (const candidate of rows) {
        candidate.element.classList.toggle(CURRENT_CLASS, candidate === row);
      }
    },
    onClick: (target) => {
      const row = rows.find((candidate) => candidate.element.contains(target));
      if (row === undefined) return;
      nav?.setCurrent(row, { reveal: true, focus: true });
    },
  });

  const reorder = createRowReorder<DemoRow>(
    list,
    {
      rows: () => rows.map((row) => ({ entry: row, key: row.key, element: row.element })),
      onMove: moveRow,
    },
    {
      // Зона захвата — имя: ячейка значения не запускает DnD (как в таблице свойств).
      captureOf: (row) => row.entry.nameElement,
      currentKey: () => nav?.token() ?? null,
      scrollHost: () => list,
    },
  );

  for (const row of rows) {
    row.nameElement.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      nav?.setCurrent(row, { reveal: true });
      showMenuAt(
        event.clientX,
        event.clientY,
        rowReorderMenuItems({
          index: rows.indexOf(row),
          count: rows.length,
          onMove: moveRow,
        }),
      );
    });
  }

  nav.setCurrent(rows[0] ?? null, { activate: true });
  status.textContent = describeOrder();

  mounted = {
    destroy(): void {
      reorder.destroy();
      nav?.destroy();
      screen.remove();
      style.remove();
    },
  };
}

function unmountDemo(): void {
  mounted?.destroy();
  mounted = null;
}

/**
 * Подключить демо-стенд к смене хэша. Вызывается из `main.ts` один раз;
 * в обычной работе приложения не делает ничего.
 */
export function installRowReorderDemo(): void {
  const sync = (): void => {
    if (location.hash === ROW_REORDER_DEMO_HASH) mountDemo();
    else unmountDemo();
  };
  window.addEventListener('hashchange', sync);
  sync();
}
