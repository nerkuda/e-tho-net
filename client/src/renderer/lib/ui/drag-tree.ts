/**
 * Кросс-групповой pointer-фасад `lib/ui` для перетаскивания узлов дерева
 * (задача 31b228f0, этап 1; ADR `442e7ff5` — drag-логика только в `lib/ui`,
 * ADR `e538090f` — единый pointer-канал).
 *
 * **Зачем отдельный фасад, а не расширение `drag-list`.** Контракт
 * {@link DragListAdapter.onReorder} — «новый порядок ключей ОДНОЙ группы»:
 * переносить узел между контейнерами он не умеет по определению, а добавление
 * в него `targetGroup/index` сломало бы существующих потребителей (оглавление и
 * холст публикации) и размыло модель «соседи одного родителя». Поэтому канал
 * кросс-группового переноса живёт отдельным фасадом с тем же визуальным
 * словарём `drag-list.css` (порог, призрак, линии вставки) и тем же pointer-
 * каналом; вид списка не дублируется.
 *
 * **Что делает фасад.** Только жест: захват за переданный handle-селектор,
 * порог, клон-призрак, авто-скролл, подсветка цели, `Shift`-признак,
 * `Escape`-отмена, очистка на `pointerup`/`pointercancel`/потере захвата.
 * Что именно тащат и куда бросают — знает вызывающий:
 * {@link DragTreeAdapter.items} отдаёт узлы (ключ + элемент), а
 * {@link DragTreeAdapter.resolveTarget} — цель броска (`groupId`, `index`,
 * позиция подсветки). Ни путей, ни ключей групп, ни модели фильтра фасад не
 * знает: фильтр-специфичной логики здесь нет (сторож `guard-drag-channel`).
 *
 * **Контракт индекса.** `index` — позиция ВСТАВКИ в группе-приёмнике в
 * координатах ДО операции (`0…children.length`, `N` — перед текущим элементом
 * N). Ошибку сдвига при переносе внутри той же группы исправляет модель
 * (`filterTreeMoveNode`), а не фасад. Для вертикального списка строк индекс
 * считает {@link resolveDragTreeRowTarget}: выше середины строки — `before`,
 * ниже — следующая позиция, пустой список — `empty` с индексом `0`.
 */

import { defineKeyContext, pushKeyContext, undefineKeyContext } from '../keymap.js';

import {
  AUTO_SCROLL_EDGE,
  AUTO_SCROLL_STEP,
  DRAG_ACTIVE_CLASS,
  DRAG_GHOST_CLASS,
  DRAG_ITEM_CLASS,
  DRAG_OVER_AFTER_CLASS,
  DRAG_OVER_BEFORE_CLASS,
  DRAG_THRESHOLD,
} from './drag-list.js';

/** Счётчик фасадов: у каждого свой клавиатурный контекст (Escape). */
let dragTreeContextSeq = 0;

/** Класс подсветки ПУСТОЙ группы-приёмника. */
export const DRAG_TREE_OVER_EMPTY_CLASS = 'ui-drag-over-empty';

/** Модификаторы указателя на момент события (Shift — копирование). */
export interface DragTreeModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/** Узел, доступный перетаскиванию: стабильный ключ и его DOM-элемент. */
export interface DragTreeItem {
  /** Ключ узла (у фильтров — путь модели; фасад его не разбирает). */
  key: string;
  /** Элемент узла: цель подсветки и образец для клона-призрака. */
  element: HTMLElement;
  /**
   * Точная ручка захвата узла. Не задана — фасад ищет её селектором
   * {@link DragTreeOptions.handleSelector} внутри `element`. Для дерева точная
   * ручка предпочтительна: `querySelector` внешнего узла может найти ручку
   * вложенного.
   */
  handle?: HTMLElement;
  /** Произвольные данные вызывающего (фасад возвращает их как есть). */
  data?: unknown;
}

/** Позиция подсветки цели броска. */
export type DragTreeDropPosition = 'before' | 'after' | 'empty';

/** Цель броска, вычисленная вызывающим. */
export interface DragTreeTarget {
  /** Ключ группы-приёмника (пути/идентификаторы задаёт вызывающий). */
  groupId: string;
  /** Индекс вставки в координатах ДО операции (см. контракт модуля). */
  index: number;
  /** Куда рисовать линию/рамку вставки. */
  position: DragTreeDropPosition;
  /** Элемент для подсветки (строка или пустая группа). */
  element?: HTMLElement | null;
}

/** Запрос резолва цели: точка указателя, источник и живые модификаторы. */
export interface DragTreeResolveRequest {
  source: DragTreeItem;
  clientX: number;
  clientY: number;
  modifiers: DragTreeModifiers;
}

/** Событие успешного броска. */
export interface DragTreeDropEvent {
  source: DragTreeItem;
  target: DragTreeTarget;
  modifiers: DragTreeModifiers;
}

/** Адаптер вызывающего: что тащим, куда можно бросить, что делать на дропе. */
export interface DragTreeAdapter {
  /** Узлы в текущем порядке (перечитываются на `refresh`). */
  items(): readonly DragTreeItem[];
  /** Резолв цели под указателем; `null` — точка вне зон броска. */
  resolveTarget(request: DragTreeResolveRequest): DragTreeTarget | null;
  /** Успешный бросок (перенос или `Shift`-копию выполняет вызывающий). */
  onDrop(event: DragTreeDropEvent): void;
  /** Отмена жеста (Escape, `pointercancel`, потеря захвата). */
  onCancel?(source: DragTreeItem): void;
}

/** Настройки фасада. */
export interface DragTreeOptions {
  /** Селектор ручки захвата внутри элемента узла (обязателен). */
  handleSelector: string;
  /** Порог начала перетаскивания, px (по умолчанию {@link DRAG_THRESHOLD}). */
  threshold?: number;
  /** Прокручиваемый контейнер для авто-скролла у краёв. */
  scrollHost?: () => HTMLElement | null;
  /** Шаг авто-скролла, px. */
  autoScrollStep?: number;
  /** Полоса у края для авто-скролла, px. */
  autoScrollEdge?: number;
}

/** Публичный дескриптор фасада. */
export interface DragTreeHandle {
  /** Перепривязать ручки после перерисовки узлов. */
  refresh(): void;
  /** Снять слушатели и активный жест (размонтирование вида). */
  destroy(): void;
}

/** Строка вертикального списка для чистого расчёта позиции вставки. */
export interface DragTreeRow {
  /** Ключ строки (фасад его не использует — отдаёт вызывающему). */
  key: string;
  element: HTMLElement;
}

/** Результат чистого расчёта позиции по вертикали. */
export interface DragTreeRowTarget {
  /** Индекс вставки: `0…rows.length`. */
  index: number;
  position: DragTreeDropPosition;
  /** Строка, относительно которой считана позиция (`null` — список пуст). */
  row: DragTreeRow | null;
}

/**
 * Чистый расчёт позиции вставки по вертикали: `before`, если указатель выше
 * середины строки, иначе следующая позиция (после последней — `rows.length`).
 * Пустой список — `empty` с индексом `0` (бросок в пустую группу).
 */
export function resolveDragTreeRowTarget(
  rows: readonly DragTreeRow[],
  clientY: number,
): DragTreeRowTarget {
  for (const [index, row] of rows.entries()) {
    const rect = row.element.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) return { index, position: 'before', row };
  }
  if (rows.length === 0) return { index: 0, position: 'empty', row: null };
  return { index: rows.length, position: 'after', row: rows[rows.length - 1] ?? null };
}

/** Прочитать модификаторы события указателя/клавиатуры. */
function modifiersOf(event: {
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): DragTreeModifiers {
  return {
    shift: event.shiftKey === true,
    alt: event.altKey === true,
    ctrl: event.ctrlKey === true,
    meta: event.metaKey === true,
  };
}

/** Активная сессия перетаскивания (одна на фасад). */
interface ActiveDrag {
  cancel(): void;
}

/**
 * Подключить кросс-групповой drag к дереву. `root` — контейнер вида (для
 * `destroy`), поведение навешивается на ручки внутри узлов из
 * {@link DragTreeAdapter.items}.
 */
export function createDragTree(
  root: HTMLElement,
  adapter: DragTreeAdapter,
  options: DragTreeOptions,
): DragTreeHandle {
  const ownerDocument = (globalThis as { document?: Document }).document;
  // Корень нужен для единого вида фасада (`refresh`/`destroy`), поведение —
  // на ручках узлов. Ссылку сохраняем, чтобы вид не «потерял» контейнер.
  void root;
  const threshold = options.threshold ?? DRAG_THRESHOLD;
  const scrollStep = options.autoScrollStep ?? AUTO_SCROLL_STEP;
  const scrollEdge = options.autoScrollEdge ?? AUTO_SCROLL_EDGE;
  const handleSelector = options.handleSelector;
  /** Ручки и их pointerdown-слушатели (для `refresh` и `destroy`). */
  const boundHandles = new Map<HTMLElement, (event: PointerEvent) => void>();
  let ghost: HTMLElement | null = null;
  let active: ActiveDrag | null = null;

  const items = (): readonly DragTreeItem[] => adapter.items();

  const removeGhost = (): void => {
    if (ghost !== null) {
      ghost.remove?.();
      ghost = null;
    }
  };

  const makeGhost = (item: DragTreeItem): void => {
    const body = ownerDocument?.body as HTMLElement | undefined;
    const clone = item.element.cloneNode?.(true) as HTMLElement | undefined;
    if (body === undefined || clone === undefined || clone.classList === undefined) return;
    clone.removeAttribute?.('id');
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

  const autoScroll = (clientY: number): void => {
    const host = options.scrollHost?.() ?? null;
    if (host === null) return;
    const rect = host.getBoundingClientRect();
    if (clientY < rect.top + scrollEdge) host.scrollTop -= scrollStep;
    else if (clientY > rect.bottom - scrollEdge) host.scrollTop += scrollStep;
  };

  /** Подсвеченный элемент цели (снимается на каждом шаге и на финише). */
  let marked: HTMLElement | null = null;

  const clearMarks = (): void => {
    marked?.classList?.remove?.(
      DRAG_OVER_BEFORE_CLASS,
      DRAG_OVER_AFTER_CLASS,
      DRAG_TREE_OVER_EMPTY_CLASS,
    );
    marked = null;
  };

  const paintTarget = (target: DragTreeTarget | null): void => {
    clearMarks();
    const element = target?.element ?? null;
    if (element === null || target === null) return;
    const cls =
      target.position === 'before'
        ? DRAG_OVER_BEFORE_CLASS
        : target.position === 'after'
          ? DRAG_OVER_AFTER_CLASS
          : DRAG_TREE_OVER_EMPTY_CLASS;
    element.classList?.add?.(cls);
    marked = element;
  };

  // --- Escape: отмена активного жеста через общий диспетчер клавиш ----------
  const contextId = `ui-drag-tree-${(dragTreeContextSeq += 1)}`;
  defineKeyContext({
    id: contextId,
    bindings: [
      {
        command: 'dragTree.cancel',
        chord: 'Escape',
        run: () => {
          if (active === null) return false;
          active.cancel();
          return true;
        },
      },
    ],
  });

  /** Начать жест с ручки узла. */
  const begin = (item: DragTreeItem, handle: HTMLElement, event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault?.();
    // Второй жест поверх первого — прежний отменяем (жест один).
    active?.cancel();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let lastModifiers = modifiersOf(event);
    let dragging = false;
    let target: DragTreeTarget | null = null;
    let finished = false;
    let releaseKeyContext: (() => void) | null = null;

    const onMove = (moveEvent: PointerEvent): void => {
      if (finished) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < threshold) return;
        dragging = true;
        item.element.classList?.add?.(DRAG_ACTIVE_CLASS);
        makeGhost(item);
        // Контекст Escape — только пока жест активен; нижележащие контексты
        // получают Escape после завершения (стек диспетчера).
        releaseKeyContext = pushKeyContext(contextId);
      }
      lastModifiers = modifiersOf(moveEvent);
      moveGhost(moveEvent.clientX, moveEvent.clientY);
      autoScroll(moveEvent.clientY);
      target = adapter.resolveTarget({
        source: item,
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY,
        modifiers: lastModifiers,
      });
      paintTarget(target);
    };

    const finish = (drop: boolean, cancel: boolean): void => {
      if (finished) return;
      finished = true;
      handle.removeEventListener?.('pointermove', onMove as EventListener);
      handle.removeEventListener?.('pointerup', onUp as EventListener);
      handle.removeEventListener?.('pointercancel', onCancel as EventListener);
      handle.removeEventListener?.('lostpointercapture', onCancel as EventListener);
      try {
        (handle as unknown as { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(
          pointerId,
        );
      } catch {
        /* уже отпущен */
      }
      item.element.classList?.remove?.(DRAG_ACTIVE_CLASS);
      clearMarks();
      removeGhost();
      releaseKeyContext?.();
      releaseKeyContext = null;
      if (active === session) active = null;
      if (cancel) adapter.onCancel?.(item);
      if (drop && target !== null) {
        adapter.onDrop({ source: item, target, modifiers: lastModifiers });
      }
    };

    const onUp = (upEvent: PointerEvent): void => {
      lastModifiers = modifiersOf(upEvent);
      if (!dragging) {
        finish(false, false);
        return;
      }
      // Цель — по точке ОТПУСКАНИЯ, а не по последнему `pointermove`: между
      // событиями указатель мог сместиться, а подсвеченная ранее цель —
      // исчезнуть. Точка вне зон броска отменяет жест (модель не меняется).
      target = adapter.resolveTarget({
        source: item,
        clientX: upEvent.clientX,
        clientY: upEvent.clientY,
        modifiers: lastModifiers,
      });
      if (target === null) {
        finish(false, true);
        return;
      }
      finish(true, false);
    };

    const onCancel = (): void => {
      finish(false, dragging);
    };

    const session: ActiveDrag = {
      cancel: () => finish(false, true),
    };
    active = session;

    try {
      (handle as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(
        pointerId,
      );
    } catch {
      /* нет захвата — не критично */
    }
    handle.addEventListener?.('pointermove', onMove as EventListener);
    handle.addEventListener?.('pointerup', onUp as EventListener);
    handle.addEventListener?.('pointercancel', onCancel as EventListener);
    handle.addEventListener?.('lostpointercapture', onCancel as EventListener);
  };

  /** Перепривязать ручки: новые узлы получают жест, исчезнувшие — теряют. */
  const refresh = (): void => {
    const current = new Set<HTMLElement>();
    for (const item of items()) {
      item.element.classList?.add?.(DRAG_ITEM_CLASS);
      const handle =
        item.handle ?? (item.element.querySelector?.(handleSelector) as HTMLElement | null);
      if (handle === null || handle === undefined) continue;
      current.add(handle);
      if (boundHandles.has(handle)) continue;
      // Замыкание хранит КЛЮЧ, а не снимок узла: после перерисовки с тем же
      // ключом жест берёт актуальные данные из `items()`.
      const key = item.key;
      const listener = (event: PointerEvent): void => {
        const currentItem = items().find((candidate) => candidate.key === key) ?? item;
        begin(currentItem, handle, event);
      };
      boundHandles.set(handle, listener);
      // Не optional-chaining: сторож обнаружимости ищет мышиный путь модуля
      // (`addEventListener('pointerdown'`) — хоткей Escape живёт вместе с ним.
      handle.addEventListener('pointerdown', listener as EventListener);
    }
    for (const [handle, listener] of boundHandles) {
      if (current.has(handle)) continue;
      handle.removeEventListener?.('pointerdown', listener as EventListener);
      boundHandles.delete(handle);
    }
  };

  return {
    refresh,
    destroy(): void {
      active?.cancel();
      active = null;
      for (const [handle, listener] of boundHandles) {
        handle.removeEventListener?.('pointerdown', listener as EventListener);
      }
      boundHandles.clear();
      clearMarks();
      removeGhost();
      // Объявление контекста живёт вместе с фасадом: без снятия реестр
      // `lib/keymap` накапливает записи при каждом создании/уничтожении вида.
      undefineKeyContext(contextId);
    },
  };
}
