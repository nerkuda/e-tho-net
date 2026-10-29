/**
 * Библиотечная компонента переупорядочивания строк `lib/row-reorder.ts`
 * (0.14.1, задача 223f7d50; ADR cce0ce7c; требование fdb872ee).
 *
 * **Роль.** Один способ менять порядок строк в любом списке/таблице клиента:
 * перетаскивание, `Alt+↑/↓` и пункты контекстного меню. Все три способа
 * сводятся к ОДНОМУ колбэку потребителя {@link RowReorderAdapter.onMove}
 * (`from`, `to` — индексы в видимом списке), применение мгновенное.
 *
 * **Механика — не здесь.** Жест перетаскивания (порог, клон-призрак,
 * маркер-линия вставки, авто-прокрутка, `Escape`) и клавиатурный сдвиг живут в
 * общем drag-фасаде `lib/ui/drag-list.ts`; разбор `Alt+↑/↓` — в общем ядре
 * `lib/ui/nav-core.ts`. Своих pointer- или keydown-обработчиков компонента НЕ
 * заводит (сторож `guard-row-reorder`), поэтому второй DnD-механики и второго
 * диспетчера стрелок в клиенте не появляется.
 *
 * **Захват.** По умолчанию перетаскивается вся строка. Потребитель может
 * сузить зону захвата через {@link RowReorderOptions.captureOf} — в таблице
 * свойств это имя свойства: ячейки значений остаются редакторами и не
 * конфликтуют с DnD.
 *
 * **Клавиатура.** `Alt+↑/↓` двигает ТЕКУЩУЮ строку навигации. Ключ текущей
 * строки отдаёт {@link RowReorderOptions.currentKey} — обычно
 * `createListNav(...).token`. Без него клавиатурный сдвиг молчит, DnD и меню
 * работают.
 *
 * **Меню.** {@link rowReorderMenuItems} собирает пункты «Переместить выше/ниже»
 * через общий словарь `lib/menu.ts`; на краях списка пункт `disabled`.
 */

import { t } from './i18n.js';
import { menuAction, type MenuItem } from './menu.js';
import {
  createDragList,
  type DragListHandle,
  type DragListItem,
} from './ui/drag-list.js';

/** Одна строка, доступная переупорядочиванию. */
export interface RowReorderRow<E> {
  /** Сущность модели (та же, что видит клавиатурная навигация). */
  entry: E;
  /** Стабильный ключ строки (совпадает с `tokenOf` навигации, уникален). */
  key: string;
  /** DOM-узел строки — цель дропа и (по умолчанию) зона захвата. */
  element: HTMLElement;
}

/** Что компонента просит у потребителя. */
export interface RowReorderAdapter<E> {
  /** Видимые строки в порядке отображения (одна переупорядочиваемая группа). */
  rows(): readonly RowReorderRow<E>[];
  /** Переставить строку `from` на место `to` (индексы видимого списка). */
  onMove(from: number, to: number): void;
}

/** Настройки компоненты. */
export interface RowReorderOptions<E> {
  /**
   * Зона захвата строки. По умолчанию — вся строка; потребитель может отдать
   * конкретную ячейку (в таблице свойств — имя), чтобы редакторы значений не
   * запускали перетаскивание.
   */
  captureOf?: (row: RowReorderRow<E>) => HTMLElement | null;
  /** Ключ текущей строки навигации (для `Alt+↑/↓`); обычно `nav.token`. */
  currentKey?: () => string | null;
  /** Прокручиваемый контейнер для авто-прокрутки у краёв. */
  scrollHost?: () => HTMLElement | null;
  /** Порог начала перетаскивания, px. */
  threshold?: number;
  /** Шаг авто-прокрутки, px. */
  autoScrollStep?: number;
  /** Полоса у края, с которой начинается авто-прокрутка, px. */
  autoScrollEdge?: number;
}

/** Публичный дескриптор компоненты. */
export interface RowReorderHandle {
  /** Перепривязать поведение после перерисовки списка. */
  refresh(): void;
  /** Сдвинуть текущую строку на соседа (±1); `false` — некуда. */
  moveCurrent(delta: -1 | 1): boolean;
  /** Снять слушатели (размонтирование вида). */
  destroy(): void;
}

/** Единственная группа: строки переставляются между собой, без вложенности. */
const ROW_GROUP = 'row';

/**
 * Пункты контекстного меню «Переместить выше/ниже».
 */
export interface RowReorderMenuOptions {
  /** Индекс строки в видимом списке. */
  index: number;
  /** Всего строк в списке. */
  count: number;
  /** Единый колбэк перестановки (тот же, что у компоненты). */
  onMove: (from: number, to: number) => void;
  /** Подписи пунктов (по умолчанию — словарь `rowReorder.*`). */
  labels?: { moveUp?: string; moveDown?: string };
}

/**
 * Пункты меню порядка для строки: «Переместить выше» и «Переместить ниже».
 * На краях списка пункт недоступен (`disabled`), обработчик не срабатывает.
 */
export function rowReorderMenuItems(options: RowReorderMenuOptions): MenuItem[] {
  const { index, count, onMove } = options;
  const canUp = index > 0 && index < count;
  const canDown = index >= 0 && index < count - 1;
  return [
    menuAction(
      options.labels?.moveUp ?? t('rowReorder.moveUp'),
      canUp ? () => onMove(index, index - 1) : undefined,
      { disabled: !canUp },
    ),
    menuAction(
      options.labels?.moveDown ?? t('rowReorder.moveDown'),
      canDown ? () => onMove(index, index + 1) : undefined,
      { disabled: !canDown },
    ),
  ];
}

/**
 * Подключить переупорядочивание к готовому списку строк. `root` — контейнер
 * списка (на нём же слушает навигацию `createListNav`); разметку строк рисует
 * потребитель, компонента лишь навешивает поведение.
 */
export function createRowReorder<E>(
  root: HTMLElement,
  adapter: RowReorderAdapter<E>,
  options: RowReorderOptions<E> = {},
): RowReorderHandle {
  const rows = (): readonly RowReorderRow<E>[] => adapter.rows();

  const items = (): DragListItem<E>[] =>
    rows().map((row) => ({
      entry: row.entry,
      key: row.key,
      groupKey: ROW_GROUP,
      element: row.element,
      handle: options.captureOf?.(row) ?? row.element,
    }));

  const drag: DragListHandle = createDragList<E>(
    root,
    { token: () => options.currentKey?.() ?? null },
    {
      items,
      onReorder: (_group, orderedKeys, movedKey) => {
        const from = rows().findIndex((row) => row.key === movedKey);
        const to = orderedKeys.indexOf(movedKey);
        if (from >= 0 && to >= 0 && from !== to) adapter.onMove(from, to);
      },
    },
    {
      // Escape отменяет жест — строка возвращается на прежнее место.
      cancelOnEscape: true,
      ...(options.scrollHost !== undefined ? { scrollHost: options.scrollHost } : {}),
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      ...(options.autoScrollStep !== undefined
        ? { autoScrollStep: options.autoScrollStep }
        : {}),
      ...(options.autoScrollEdge !== undefined ? { autoScrollEdge: options.autoScrollEdge } : {}),
    },
  );

  // Первичная привязка к уже отрисованным строкам: потребитель не обязан
  // звать refresh сразу после создания (дальше — после каждой перерисовки).
  drag.refresh();

  return {
    refresh(): void {
      drag.refresh();
    },
    moveCurrent(delta: -1 | 1): boolean {
      return drag.moveCurrent(delta);
    },
    destroy(): void {
      drag.destroy();
    },
  };
}
