/**
 * Сортируемый список `lib/ui` — общий drag-фасад для ручного порядка
 * (задача d13fd645, элемент интерфейса 2ebacd12, ADR fadf99e0).
 *
 * **Роль.** Один переиспользуемый механизм ручного порядка над уже
 * существующим списком `./list.ts` (ядро `./nav-core.ts`): drag-логика
 * (pointer-события, порог, клон-призрак, линии вставки, авто-скролл у краёв) и
 * клавиатурный сдвиг `Alt+↑/↓` живут ЗДЕСЬ, а не в экранах. Потребители —
 * оглавление и холст просмотра публикации.
 *
 * **Модель.** Потребитель отдаёт {@link DragListAdapter.items} — видимые
 * сортируемые сущности в порядке отображения. `groupKey` задаёт группу
 * «соседи одного родителя»: переставлять можно только внутри группы (иначе
 * изменилась бы структура, а не порядок); `key` — стабильный ключ узла
 * (переживает перерисовку). На дроп переносится один узел перед соседом той же
 * группы; {@link DragListAdapter.onReorder} получает НОВЫЙ полный порядок
 * ключей группы.
 *
 * **Клавиатура.** `Alt+↑/↓` сдвигает ТЕКУЩУЮ сущность навигации
 * ({@link ListNavHandle}) на одного соседа в её группе. Разбор клавиши — в ядре
 * (`nav-core.ts`, действия `moveUp`/`moveDown`), поэтому обычные стрелки без Alt
 * продолжают двигать курсор.
 *
 * **Разметку делает потребитель** (keyed-сверка): фасад лишь навешивает
 * поведение на готовые узлы. Ключ группы и элементы перечитываются на каждом
 * {@link DragListHandle.refresh} — после перерисовки списка его надо звать.
 *
 * Вид грипа, призрака и линий вставки — `./drag-list.css`.
 */

import { span } from '../dom.js';

import { isReorderAction, resolveNavAction } from './nav-core.js';

/** Класс грипа-аффорданса перетаскивания. */
export const DRAG_HANDLE_CLASS = 'ui-drag-handle';

/** Класс сортируемого узла (строка/блок) — источник и цель дропа. */
export const DRAG_ITEM_CLASS = 'ui-drag-item';

/** Класс узла в момент активного перетаскивания. */
export const DRAG_ACTIVE_CLASS = 'ui-drag-active';

/** Линия вставки ПЕРЕД узлом-целью. */
export const DRAG_OVER_BEFORE_CLASS = 'ui-drag-over-before';

/** Линия вставки ПОСЛЕ узла-цели. */
export const DRAG_OVER_AFTER_CLASS = 'ui-drag-over-after';

/** Класс клона-призрака, следующего за указателем. */
export const DRAG_GHOST_CLASS = 'ui-drag-ghost';

/** Глиф грипа по умолчанию (шесть точек). */
export const DRAG_HANDLE_GLYPH = '⠿';

/** Сущность, доступная перетаскиванию: узел, его грип и группа соседей. */
export interface DragListItem<E> {
  /** Сущность модели (та же, что видит навигация). */
  entry: E;
  /** Стабильный ключ строки (совпадает с `tokenOf` навигации, уникален). */
  key: string;
  /**
   * Ключ локального порядка узла (`node_key`) — им адресуется перестановка.
   * По умолчанию равен {@link key}. Нужен там, где идентичность строки и
   * `node_key` расходятся (повторные вхождения одного раздела/текста).
   */
  orderKey?: string;
  /** Группа «соседи одного родителя»: перестановка только внутри группы. */
  groupKey: string;
  /** Узел-строка/блок: цель дропа и визуальный источник. */
  element: HTMLElement;
  /** Грип, с которого начинается перетаскивание. */
  handle: HTMLElement;
}

/** Адаптер представления: что и в каком порядке сортируется. */
export interface DragListAdapter<E> {
  /** Сортируемые сущности в порядке отображения (по группам). */
  items(): readonly DragListItem<E>[];
  /** Дроп/клавиатура: новый полный порядок ключей ОДНОЙ группы. */
  onReorder(groupKey: string, orderedKeys: readonly string[]): void;
}

/**
 * Минимум, нужный фасаду от навигации: ключ текущей сущности. Подходит любой
 * {@link ListNavHandle}, в т.ч. с другим opaque-типом сущности (ключи строк
 * совпадают с {@link DragListItem.key}).
 */
export interface DragListNav {
  /** Ключ текущей сущности навигации или `null`. */
  token(): string | null;
}

/** Настройки сортируемого списка. */
export interface DragListOptions {
  /** Порог начала перетаскивания, px (по умолчанию {@link DRAG_THRESHOLD}). */
  threshold?: number;
  /** Прокручиваемый контейнер для авто-скролла у краёв (по умолчанию — нет). */
  scrollHost?: () => HTMLElement | null;
  /** Шаг авто-скролла, px (по умолчанию {@link AUTO_SCROLL_STEP}). */
  autoScrollStep?: number;
  /** Полоса у края, с которой начинается авто-скролл, px. */
  autoScrollEdge?: number;
}

/** Публичный дескриптор сортируемого списка. */
export interface DragListHandle {
  /** Перепривязать поведение после перерисовки списка. */
  refresh(): void;
  /** Сдвинуть текущую сущность навигации на соседа (±1); `false` — некуда. */
  moveCurrent(delta: -1 | 1): boolean;
  /** Снять слушатели (размонтирование вида). */
  destroy(): void;
}

/** Порог начала перетаскивания по умолчанию, px. */
export const DRAG_THRESHOLD = 4;

/** Шаг авто-скролла у края по умолчанию, px. */
export const AUTO_SCROLL_STEP = 12;

/** Полоса авто-скролла у края по умолчанию, px. */
export const AUTO_SCROLL_EDGE = 24;

/** Создаёт грип-аффорданс (разметку и вид даёт `./drag-list.css`). */
export function dragHandle(title?: string): HTMLElement {
  const node = span(DRAG_HANDLE_GLYPH, DRAG_HANDLE_CLASS);
  if (title !== undefined) {
    node.title = title;
    node.setAttribute('aria-label', title);
  }
  node.setAttribute('role', 'button');
  return node;
}

/** Ключ локального порядка узла (`node_key`). */
function orderKeyOf(item: DragListItem<unknown>): string {
  return item.orderKey ?? item.key;
}

/** Уникальные `node_key` группы в порядке отображения (дубли схлопываются). */
function groupOrder(
  items: readonly DragListItem<unknown>[],
  groupKey: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item.groupKey !== groupKey) continue;
    const key = orderKeyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Новый порядок ключей: `moved` перед `before` (`before === null` — в конец). */
function reorderKeys(
  keys: readonly string[],
  moved: string,
  before: string | null,
): string[] {
  const without = keys.filter((key) => key !== moved);
  if (without.length === keys.length) return [...keys];
  const at = before === null ? -1 : without.indexOf(before);
  const insertAt = at === -1 ? without.length : at;
  const next = [...without];
  next.splice(insertAt, 0, moved);
  return next;
}

/**
 * Подключить сортировку к списку. `root` — контейнер вида (на нём же слушает
 * навигацию {@link ListNavHandle}); `nav` — дескриптор общего компонента списка.
 */
export function createDragList<E>(
  root: HTMLElement,
  nav: DragListNav,
  adapter: DragListAdapter<E>,
  options: DragListOptions = {},
): DragListHandle {
  const ownerDocument = (globalThis as { document?: Document }).document;
  const threshold = options.threshold ?? DRAG_THRESHOLD;
  const scrollStep = options.autoScrollStep ?? AUTO_SCROLL_STEP;
  const scrollEdge = options.autoScrollEdge ?? AUTO_SCROLL_EDGE;
  /** Грипы, которым уже навешен pointerdown (переживают refresh). */
  const bound = new WeakSet<HTMLElement>();
  let ghost: HTMLElement | null = null;

  const items = (): readonly DragListItem<E>[] => adapter.items();

  const itemByKey = (key: string | null): DragListItem<E> | null => {
    if (key === null) return null;
    return items().find((item) => item.key === key) ?? null;
  };

  const clearDropMarks = (): void => {
    for (const item of items()) {
      item.element.classList?.remove?.(DRAG_OVER_BEFORE_CLASS, DRAG_OVER_AFTER_CLASS);
    }
  };

  /** Текущий порядок группы и сдвиг узла на позицию; `onReorder` при изменении. */
  const applyMove = (item: DragListItem<E>, before: string | null): boolean => {
    const keys = groupOrder(items(), item.groupKey);
    const next = reorderKeys(keys, orderKeyOf(item), before);
    if (next.join('\u0000') === keys.join('\u0000')) return false;
    adapter.onReorder(item.groupKey, next);
    return true;
  };

  /** Сдвиг сущности на соседа внутри её группы (клавиатура/меню). */
  const moveItem = (item: DragListItem<E>, delta: -1 | 1): boolean => {
    const keys = groupOrder(items(), item.groupKey);
    const index = keys.indexOf(orderKeyOf(item));
    if (index < 0) return false;
    const target = index + delta;
    if (target < 0 || target >= keys.length) return false;
    const before = delta === 1 ? (keys[target + 1] ?? null) : keys[target]!;
    return applyMove(item, before);
  };

  const moveCurrent = (delta: -1 | 1): boolean => {
    const item = itemByKey(nav.token());
    return item === null ? false : moveItem(item, delta);
  };

  // --- Клавиатура (Alt+↑/↓) -------------------------------------------------

  const onKeydown = (event: { key?: string; altKey?: boolean; preventDefault?: () => void }): void => {
    const action = resolveNavAction(event.key ?? '', { altKey: event.altKey === true });
    if (!isReorderAction(action)) return;
    if (moveCurrent(action === 'moveUp' ? -1 : 1)) event.preventDefault?.();
  };

  // --- Перетаскивание указателем -------------------------------------------

  const removeGhost = (): void => {
    if (ghost !== null) {
      ghost.remove?.();
      ghost = null;
    }
  };

  const makeGhost = (item: DragListItem<E>): void => {
    const body = ownerDocument?.body as HTMLElement | undefined;
    const clone = item.element.cloneNode?.(true) as HTMLElement | undefined;
    if (body === undefined || clone === undefined || clone.classList === undefined) return;
    clone.classList.add(DRAG_GHOST_CLASS);
    clone.style?.setProperty?.('position', 'fixed');
    clone.style?.setProperty?.('pointer-events', 'none');
    body.append(clone);
    ghost = clone;
  };

  const moveGhost = (clientX: number, clientY: number): void => {
    if (ghost === null) return;
    ghost.style?.setProperty?.('left', `${clientX}px`);
    ghost.style?.setProperty?.('top', `${clientY}px`);
  };

  /** Авто-скролл, когда указатель у верхнего/нижнего края контейнера. */
  const autoScroll = (clientY: number): void => {
    const host = options.scrollHost?.() ?? null;
    if (host === null) return;
    const rect = host.getBoundingClientRect();
    if (clientY < rect.top + scrollEdge) host.scrollTop -= scrollStep;
    else if (clientY > rect.bottom - scrollEdge) host.scrollTop += scrollStep;
  };

  /**
   * Ближайшая цель дропа в группе: узел под указателем (или ближайший по
   * вертикали). Возвращает ключ, ПЕРЕД которым встанет перемещаемый узел
   * (`null` — в конец группы). Помечает узел линией вставки.
   */
  const resolveDrop = (
    item: DragListItem<E>,
    clientY: number,
  ): string | null => {
    clearDropMarks();
    const keys = groupOrder(items(), item.groupKey);
    // Соседи — элементы ТОЙ ЖЕ группы в порядке отображения (свёртка дублей
    // `node_key`). Искать их по `orderKey` в списке нельзя: список ключован
    // ключом строки (`key`), а `orderKey` может с ним не совпадать.
    const seen = new Set<string>();
    const siblings: DragListItem<E>[] = [];
    for (const candidate of items()) {
      if (candidate.groupKey !== item.groupKey || candidate.key === item.key) continue;
      const orderKey = orderKeyOf(candidate);
      if (seen.has(orderKey)) continue;
      seen.add(orderKey);
      siblings.push(candidate);
    }
    if (siblings.length === 0) return null;

    let chosen: { item: DragListItem<E>; after: boolean } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const sibling of siblings) {
      const rect = sibling.element.getBoundingClientRect();
      const mid = (rect.top + rect.bottom) / 2;
      const distance = Math.abs(clientY - mid);
      if (distance < bestDistance) {
        bestDistance = distance;
        chosen = { item: sibling, after: clientY >= mid };
      }
    }
    if (chosen === null) return null;
    chosen.item.element.classList?.add?.(
      chosen.after ? DRAG_OVER_AFTER_CLASS : DRAG_OVER_BEFORE_CLASS,
    );
    if (!chosen.after) return orderKeyOf(chosen.item);
    const chosenIndex = keys.indexOf(orderKeyOf(chosen.item));
    return keys[chosenIndex + 1] ?? null;
  };

  const bindHandle = (item: DragListItem<E>): void => {
    item.element.classList?.add?.(DRAG_ITEM_CLASS);
    if (bound.has(item.handle)) return;
    bound.add(item.handle);
    item.handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault?.();
      const startY = event.clientY;
      const pointerId = event.pointerId;
      try {
        (item.handle as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(
          pointerId,
        );
      } catch {
        /* нет захвата — не критично */
      }
      let dragging = false;
      let before: string | null = null;

      const onMove = (moveEvent: PointerEvent): void => {
        if (!dragging) {
          if (Math.abs(moveEvent.clientY - startY) < threshold) return;
          dragging = true;
          item.element.classList?.add?.(DRAG_ACTIVE_CLASS);
          makeGhost(item);
        }
        moveGhost(moveEvent.clientX, moveEvent.clientY);
        autoScroll(moveEvent.clientY);
        before = resolveDrop(item, moveEvent.clientY);
      };
      const onUp = (): void => {
        item.handle.removeEventListener?.('pointermove', onMove as EventListener);
        item.handle.removeEventListener?.('pointerup', onUp as EventListener);
        item.handle.removeEventListener?.('pointercancel', onUp as EventListener);
        try {
          (item.handle as unknown as { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(
            pointerId,
          );
        } catch {
          /* уже отпущен */
        }
        item.element.classList?.remove?.(DRAG_ACTIVE_CLASS);
        clearDropMarks();
        removeGhost();
        if (dragging) applyMove(item, before);
        dragging = false;
      };
      item.handle.addEventListener('pointermove', onMove as EventListener);
      item.handle.addEventListener('pointerup', onUp as EventListener);
      item.handle.addEventListener('pointercancel', onUp as EventListener);
    });
  };

  root.addEventListener?.('keydown', onKeydown as EventListener);

  return {
    refresh(): void {
      for (const item of items()) bindHandle(item);
    },
    moveCurrent,
    destroy(): void {
      root.removeEventListener?.('keydown', onKeydown as EventListener);
      clearDropMarks();
      removeGhost();
    },
  };
}
