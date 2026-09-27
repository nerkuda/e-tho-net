/**
 * Всплывающая панель — общий компонент `lib/ui` (задача dd1f47d4, требование
 * f74f1aae «Всплывающий предпросмотр — общий компонент lib/ui», ADR 03eb2c61,
 * инвентаризация 3fc7c54d — «Popover (закрываемый кликом вне)»).
 *
 * **За что отвечает.** Единственная механика всплывающих панелей поверх
 * контента: сборка панели (единое оформление — `./popover.css`), позиционирование
 * у якоря (элемента) или у точки (курсора) с переворотом и прижатием к краям
 * окна, закрытие кликом вне / `Escape` / прокруткой / потерей фокуса окна.
 * «Задержка» и «поведение при прокрутке» тоже здесь: панель не закрывается,
 * пока прокрутка идёт внутри неё самой (курсор можно переводить внутрь — панель
 * интерактивна, `pointer-events: auto`).
 *
 * **Движки — потребители.** Ctrl+hover-предпросмотр (`../hover-preview.ts`)
 * строит каждый попап через {@link openPopover} (своя остаётся только логика
 * цепочки и таймеров); лупа изображений (`../image-zoom.ts`) берёт общее
 * позиционирование у курсора ({@link placeAtCursor}). Новая панель обязана
 * идти через этот компонент — сторож `guard-ui-popover.test.ts`.
 *
 * **Геометрия — чистые функции.** {@link placeUnderAnchor} и
 * {@link placeAtCursor} не трогают DOM: на вход прямоугольники, на выход
 * координаты. Это делает проверяемыми и позиционирование, и поведение у края
 * окна без движка раскладки (`tests/lib-ui-popover.test.ts`).
 *
 * Модуль намеренно не импортирует CSS (стили подключает `./register.ts`) —
 * тогда тесты импортируют его без CSS-загрузчика, как остальные фасады.
 */

import { div, el } from '../dom.js';

/** Класс панели. Объявлен только здесь — прямой разметкой панели занимается компонент. */
export const POPOVER_CLASS = 'ui-popover';

/** Класс заголовка панели. */
export const POPOVER_HEAD_CLASS = 'ui-popover-head';

/** Класс прокручиваемого тела панели. */
export const POPOVER_BODY_CLASS = 'ui-popover-body';

/** Отступ панели от края окна по умолчанию, px. */
export const POPOVER_MARGIN = 8;

/** Зазор между якорем и панелью по умолчанию, px. */
export const POPOVER_GAP = 10;

/** Зазор между курсором и панелью (режим точки), px. */
export const POPOVER_CURSOR_GAP = 14;

/** Минимальный отступ хвостика-стрелки от угла панели, px. */
const ARROW_INSET = 14;

/** Прямоугольник якоря/панели в координатах окна. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Размер панели или окна. */
export interface SizeLike {
  width: number;
  height: number;
}

/** Точка в координатах окна (позиция курсора). */
export interface PointLike {
  x: number;
  y: number;
}

/** Результат позиционирования у якоря-элемента. */
export interface AnchorPlacement {
  left: number;
  top: number;
  /** Сторона панели, на которой стоит хвостик: `top` — панель под якорем, `bottom` — над ним. */
  side: 'top' | 'bottom';
  /** Смещение хвостика от левого края панели, px. */
  arrowLeft: number;
}

/** Результат позиционирования у точки (курсора). */
export interface PointPlacement {
  left: number;
  top: number;
}

/**
 * Панель по центру под якорем-элементом; при нехватке места снизу —
 * переворачивается наверх, при нехватке и там — прижимается к нижнему краю;
 * по горизонтали прижимается к краям окна. Хвостик едет за якорем и не
 * выходит за углы панели.
 */
export function placeUnderAnchor(
  anchor: RectLike,
  panel: SizeLike,
  viewport: SizeLike,
  gap = POPOVER_GAP,
  margin = POPOVER_MARGIN,
): AnchorPlacement {
  const anchorX = anchor.left + anchor.width / 2;
  const left = Math.max(
    margin,
    Math.min(anchorX - panel.width / 2, viewport.width - panel.width - margin),
  );

  let top = anchor.top + anchor.height + gap;
  let side: 'top' | 'bottom' = 'top';
  if (top + panel.height > viewport.height - margin) {
    const above = anchor.top - gap - panel.height;
    if (above >= margin) {
      top = above;
      side = 'bottom';
    } else {
      top = Math.max(margin, viewport.height - panel.height - margin);
    }
  }

  const arrowLeft = Math.max(ARROW_INSET, Math.min(panel.width - ARROW_INSET, anchorX - left));
  return { left: Math.round(left), top: Math.round(top), side, arrowLeft: Math.round(arrowLeft) };
}

/**
 * Панель у точки (курсора): справа-снизу от неё; если справа/снизу места нет —
 * разворачивается влево/вверх, не выходя за края окна.
 */
export function placeAtCursor(
  point: PointLike,
  panel: SizeLike,
  viewport: SizeLike,
  gap = POPOVER_CURSOR_GAP,
  margin = POPOVER_MARGIN,
): PointPlacement {
  let left = point.x + gap;
  if (left + panel.width > viewport.width - margin) {
    left = Math.max(margin, point.x - panel.width - gap);
  }
  let top = point.y + gap;
  if (top + panel.height > viewport.height - margin) {
    top = Math.max(margin, point.y - panel.height - gap);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

/** Содержимое панели: заголовок и готовое тело. */
export interface PopoverContent {
  title: string;
  body: HTMLElement;
  /** Переопределение `max-width` панели (по умолчанию 420px, см. `popover.css`), px. */
  maxWidthPx?: number;
  /** Переопределение `max-height` тела (`min(420px, 60vh)`), px. */
  maxHeightPx?: number;
}

/** Якорь позиционирования: элемент (панель под ним, со стрелкой) или точка курсора. */
export type PopoverAnchor = { element: HTMLElement; arrow?: boolean } | PointLike;

/** Опции {@link openPopover}. */
export interface PopoverOptions {
  anchor: PopoverAnchor;
  content: PopoverContent;
  /** Дополнительные классы-МОДИФИКАТОРЫ прикладного слоя (роли панели — нет). */
  extraClass?: string;
  /** Атрибуты `data-*` на панели (например, `depth` движка предпросмотра). */
  dataset?: Record<string, string>;
  /** Закрывать панель кликом вне неё; по умолчанию `true`. */
  closeOnOutsideClick?: boolean;
  /** Закрывать панель по `Escape` (верхнюю из открытых); по умолчанию `true`. */
  closeOnEsc?: boolean;
  /** Закрывать панель при прокрутке вне её самой; по умолчанию `true`. */
  closeOnScroll?: boolean;
  /** Закрывать панель при потере фокуса окном; по умолчанию `true`. */
  closeOnBlur?: boolean;
  /** Вызывается один раз после закрытия панели (сама панель уже удалена). */
  onClose?: () => void;
}

/** Дескриптор открытой панели. */
export interface PopoverHandle {
  /** Корневой элемент панели (`.ui-popover`). */
  readonly element: HTMLElement;
  /** Лежит ли узел внутри панели (для решений «свой/чужой узел»). */
  contains(node: Node | null): boolean;
  /** Пересчитывает позицию (после смены содержимого/размера окна). */
  reposition(): void;
  /** Закрывает панель; повторный вызов — no-op. */
  close(): void;
}

/** Открытая панель во внутреннем реестре компонента. */
interface ActivePopover {
  element: HTMLElement;
  closeOnOutsideClick: boolean;
  closeOnEsc: boolean;
  closeOnScroll: boolean;
  closeOnBlur: boolean;
  onClose?: (() => void) | undefined;
  close(): void;
}

/** Реестр открытых панелей (порядок открытия — от старых к новым). */
const active: ActivePopover[] = [];
let listenersReady = false;

/** Ставит делегированные слушатели (один раз за сессию рендерера). */
function ensureListeners(): void {
  if (listenersReady) return;
  listenersReady = true;

  // Клик вне панели. Привязка к `pointerdown` — закрываем до обработчиков
  // самой цели (как у прежней механики search-settings).
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Node | null;
      for (const popover of [...active]) {
        if (!popover.closeOnOutsideClick) continue;
        if (target !== null && popover.element.contains(target)) continue;
        popover.close();
      }
    },
    true,
  );

  // `Escape` закрывает только самую верхнюю (последнюю открытую) панель.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (let i = active.length - 1; i >= 0; i--) {
      const popover = active[i]!;
      if (!popover.closeOnEsc) continue;
      popover.close();
      return;
    }
  });

  // Прокрутка ВНУТРИ любой нашей панели не закрывает ничего (панель сама
  // прокручивается в `.ui-popover-body`); прокрутка вне всего слоя отрывает
  // привязанные панели от якорей — закрываем.
  document.addEventListener(
    'scroll',
    (event) => {
      const target = event.target as Node | null;
      if (target !== null && active.some((popover) => popover.element.contains(target))) return;
      for (const popover of [...active]) {
        if (popover.closeOnScroll) popover.close();
      }
    },
    true,
  );

  window.addEventListener('blur', () => {
    for (const popover of [...active]) {
      if (popover.closeOnBlur) popover.close();
    }
  });
}

/**
 * Делегированный слушатель «нажатие вне» для поисковых выпадашек с ОСОБЫМИ
 * исключениями (общая выпадашка подсказок, модальный диалог): закрывает слой,
 * когда нажатие не удержано предикатом. Механика «клика вне» живёт только в
 * `lib/ui` (сторож `guard-ui-popover.test.ts`): потребитель описывает лишь
 * условие «этот узел панель удерживает», а сам `pointerdown`-слушатель ставит
 * компонент. Возвращает функцию снятия слушателя.
 */
export function watchOutsideTap(
  holds: (target: Node) => boolean,
  onOutside: () => void,
): () => void {
  const handler = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (holds(target)) return;
    onOutside();
  };
  document.addEventListener(
    'pointerdown',
    handler,
    true,
  );
  return () => document.removeEventListener('pointerdown', handler, true);
}

/**
 * Показывает панель с контентом у якоря. Панель монтируется в `document.body`
 * (fixed-позиционирование — не режется `overflow` контейнеров) и сразу
 * ставится по месту.
 */
export function openPopover(options: PopoverOptions): PopoverHandle {
  const content = options.content;
  const element = div(POPOVER_CLASS);
  if (options.extraClass !== undefined && options.extraClass.trim() !== '') {
    element.classList.add(...options.extraClass.trim().split(/\s+/));
  }
  if (options.dataset !== undefined) {
    for (const [key, value] of Object.entries(options.dataset)) element.dataset[key] = value;
  }
  if (content.maxWidthPx !== undefined) element.style.maxWidth = `${content.maxWidthPx}px`;

  const body = div(POPOVER_BODY_CLASS);
  if (content.maxHeightPx !== undefined) body.style.maxHeight = `${content.maxHeightPx}px`;
  body.append(content.body);
  element.append(el('div', POPOVER_HEAD_CLASS, content.title), body);

  const anchor = options.anchor;
  const position = (): void => {
    const rect = element.getBoundingClientRect();
    const panel = { width: rect.width, height: rect.height };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if ('element' in anchor) {
      const anchorRect = anchor.element.getBoundingClientRect();
      const placed = placeUnderAnchor(
        {
          left: anchorRect.left,
          top: anchorRect.top,
          width: anchorRect.width,
          height: anchorRect.height,
        },
        panel,
        viewport,
      );
      element.style.left = `${placed.left}px`;
      element.style.top = `${placed.top}px`;
      if (anchor.arrow !== false) {
        element.dataset['arrow'] = placed.side;
        element.style.setProperty('--ui-popover-arrow-left', `${placed.arrowLeft}px`);
      }
    } else {
      const placed = placeAtCursor(anchor, panel, viewport);
      element.style.left = `${placed.left}px`;
      element.style.top = `${placed.top}px`;
    }
  };

  const record: ActivePopover = {
    element,
    closeOnOutsideClick: options.closeOnOutsideClick ?? true,
    closeOnEsc: options.closeOnEsc ?? true,
    closeOnScroll: options.closeOnScroll ?? true,
    closeOnBlur: options.closeOnBlur ?? true,
    onClose: options.onClose,
    close: () => undefined,
  };
  record.close = (): void => {
    const index = active.indexOf(record);
    if (index === -1) return; // уже закрыта
    active.splice(index, 1);
    element.remove();
    record.onClose?.();
  };

  document.body.append(element);
  position();
  active.push(record);
  ensureListeners();

  return {
    element,
    contains: (node) => element.contains(node),
    reposition: position,
    close: () => record.close(),
  };
}
