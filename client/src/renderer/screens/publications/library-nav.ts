/**
 * Единая клавиатурная навигация библиотеки публикаций (0.11.1, задача
 * 55ee3c85; элемент интерфейса 1eecd988). Обслуживает ОБА представления —
 * «Полки» и «Список»: они отличаются только разметкой (секция-полка с
 * карточками против секции-группы со строками), а ход по видимой
 * последовательности сущностей общий.
 *
 * Контроллер по образцу ленты «Дневника» (`screens/chronicle/feed-nav.ts`,
 * требование 165323a7): выделяет текущую сущность по КЛЮЧУ (полка/публикация),
 * ведёт ↑/↓ по видимому порядку, Home/End — к границам, ←/→ сворачивает и
 * разворачивает полку-группу, Enter на полке запускает правку имени по месту,
 * Enter на публикации открывает её в панели редактора.
 *
 * **Почему отдельный модуль.** Он не тянет Electron/сеть и проверяется
 * DOM-тестами на шиме (`tests/publications-library-nav.test.ts`): симуляция
 * keydown, проверка выделения и колбэков. Разметку и данные держит
 * `publications.ts`.
 *
 * **Контракт DOM (общий для обоих видов).** Секция группы — `pub-group` с
 * `data-shelf-key`; свёрнутая — класс `pub-group-collapsed`; заголовок —
 * `pub-group-head`; публикации — узлы с `data-pub-key`. Видимая
 * последовательность собирается чистой функцией
 * `visibleLibraryEntities` (см. `model.ts`), поэтому правила порядка и
 * свёрнутости живут в модели и покрыты юнит-тестами.
 *
 * **Устойчивость.** Выделение хранится ключом, а не ссылкой на узел: после
 * перерисовки (real-time, смена вида, сверка списков) {@link LibraryNavHandle.refresh}
 * переприменяет выделение, если сущность ещё видима, и снимает его, если
 * сущность пропала или попала в свёрнутую группу. Там же возвращается фокус,
 * если навигация была активна и пользователь не правит текст (правка имени
 * полки — поле ввода, её стрелки не перехватываются).
 */

import { visibleLibraryEntities, type LibraryEntity, type LibraryGroupLike } from './model.js';

/** Класс секции группы (полки) — общий для обоих видов. */
export const LIB_GROUP_CLASS = 'pub-group';
/** Класс свёрнутой секции группы. */
export const LIB_GROUP_COLLAPSED_CLASS = 'pub-group-collapsed';
/** Класс заголовка группы (по нему ходит выделение полки). */
export const LIB_HEAD_CLASS = 'pub-group-head';
/** Класс выделения текущей сущности (полка/публикация). */
export const LIB_NAV_CURRENT_CLASS = 'pub-current';
/** Атрибут секции с ключом полки. */
export const LIB_SHELF_ATTR = 'data-shelf-key';
/** Атрибут узла публикации с её id. */
export const LIB_PUB_ATTR = 'data-pub-key';

/** Параметры подключения контроллера. */
export interface LibraryNavOptions {
  /** Свернуть (`collapsed: true`) или развернуть полку-группу. */
  onToggleShelf: (shelfId: string, collapsed: boolean) => void;
  /** Enter на полке — inline-правка имени. */
  onEditShelf: (shelfId: string) => void;
  /** Enter на публикации — открыть в панели редактора. */
  onOpenPublication: (publicationId: string) => void;
}

/** Публичный дескриптор контроллера. */
export interface LibraryNavHandle {
  /** Переприменить выделение/фокус после перерисовки списков. */
  refresh(): void;
  /** Вернуть фокус в навигацию. */
  focusNavigation(): void;
  /** Текущая сущность или `null`. */
  current(): LibraryEntity | null;
  /** Снять слушатели (размонтирование вида). */
  destroy(): void;
}

/** Родительский узел: реальный DOM (`parentElement`) или DOM-шим (`parent`). */
function parentOf(node: HTMLElement): HTMLElement | null {
  const carrier = node as unknown as {
    parentElement?: HTMLElement | null;
    parent?: HTMLElement | null;
  };
  return carrier.parentElement ?? carrier.parent ?? null;
}

/** Фокус в поле правки текста (inline-правка имени полки)? Навигация молчит. */
function isEditingTarget(target: HTMLElement | null): boolean {
  if (target === null) return false;
  const tag = (target.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return (
    target.isContentEditable === true ||
    (target.getAttribute?.('contenteditable') !== null &&
      target.getAttribute?.('contenteditable') !== undefined)
  );
}

/** Может ли узел принять программный фокус (иначе фокус ставится на корень). */
function canReceiveFocus(el: HTMLElement): boolean {
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a') {
    return true;
  }
  const tabIndex = el.tabIndex;
  return typeof tabIndex === 'number' && tabIndex >= 0;
}

/** Loose view of `KeyboardEvent` fields (test-friendly). */
interface LibKeyEvent {
  key?: string;
  target?: unknown | null;
  preventDefault?: () => void;
}

/**
 * Подключить контроллер навигации к корню библиотеки. `root` — общий контейнер
 * обоих видов (`.publications`).
 */
export function attachLibraryNav(root: HTMLElement, opts: LibraryNavOptions): LibraryNavHandle {
  let current: LibraryEntity | null = null;
  /** Навигация «жива»: пользователь ходил стрелками/кликал и не уводил фокус. */
  let navActive = false;
  const ownerDocument = (globalThis as { document?: Document }).document;

  /** Секции групп, видимые в активном виде (в DOM-порядке). */
  function sections(): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(`.${LIB_GROUP_CLASS}`)).filter(
      (section) => !isHidden(section),
    );
  }

  /** Узел скрыт (`hidden`-атрибут или класс `hidden`) сам либо его предок до root. */
  function isHidden(node: HTMLElement): boolean {
    let cursor: HTMLElement | null = node;
    while (cursor !== null && cursor !== root) {
      if (cursor.classList?.contains('hidden') === true) return true;
      if ((cursor as unknown as { hidden?: boolean }).hidden === true) return true;
      cursor = parentOf(cursor);
    }
    return false;
  }

  /** Ключ полки секции (пусто — секция без ключа, навигацией не берётся). */
  function shelfKeyOf(section: HTMLElement): string {
    return section.dataset?.['shelfKey'] ?? section.getAttribute?.(LIB_SHELF_ATTR) ?? '';
  }

  /** DOM-порядок публикаций внутри секции. */
  function publicationNodes(section: HTMLElement): HTMLElement[] {
    return Array.from(section.querySelectorAll<HTMLElement>(`[${LIB_PUB_ATTR}]`));
  }

  /** Группы библиотеки для чистой функции видимой последовательности. */
  function readGroups(): LibraryGroupLike[] {
    const out: LibraryGroupLike[] = [];
    for (const section of sections()) {
      const shelfId = shelfKeyOf(section);
      if (shelfId === '') continue;
      out.push({
        shelfId,
        collapsed: section.classList.contains(LIB_GROUP_COLLAPSED_CLASS),
        publicationIds: publicationNodes(section).map(
          (node) => node.dataset?.['pubKey'] ?? node.getAttribute?.(LIB_PUB_ATTR) ?? '',
        ),
      });
    }
    return out;
  }

  /** Видимые сущности в порядке ↑/↓. */
  function visibleEntities(): LibraryEntity[] {
    return visibleLibraryEntities(readGroups());
  }

  /** Узел DOM текущей сущности (null — сущность не видна). */
  function findEntityEl(entity: LibraryEntity | null): HTMLElement | null {
    if (entity === null) return null;
    if (entity.kind === 'shelf') {
      const section = sections().find((candidate) => shelfKeyOf(candidate) === entity.key);
      return section?.querySelector<HTMLElement>(`.${LIB_HEAD_CLASS}`) ?? section ?? null;
    }
    for (const section of sections()) {
      const found = publicationNodes(section).find(
        (node) => (node.dataset?.['pubKey'] ?? node.getAttribute?.(LIB_PUB_ATTR) ?? '') === entity.key,
      );
      if (found !== undefined) return found;
    }
    return null;
  }

  /** Снять выделение со всех сущностей. */
  function clearHighlight(): void {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${LIB_NAV_CURRENT_CLASS}`))) {
      el.classList.remove(LIB_NAV_CURRENT_CLASS);
    }
  }

  /** Перерисовать выделение по текущей сущности. */
  function applyHighlight(): void {
    clearHighlight();
    findEntityEl(current)?.classList.add(LIB_NAV_CURRENT_CLASS);
  }

  /** Сделать сущность текущей. */
  function setCurrent(entity: LibraryEntity | null): void {
    current = entity;
    applyHighlight();
  }

  /** Индекс сущности в видимом списке (-1 — не видна). */
  function indexOfCurrent(list: readonly LibraryEntity[]): number {
    if (current === null) return -1;
    return list.findIndex((item) => item.kind === current?.kind && item.key === current?.key);
  }

  /** Фокус на текущей сущности, иначе — на корне библиотеки. */
  function focusNav(): void {
    navActive = true;
    const el = findEntityEl(current);
    const candidate = el !== null && canReceiveFocus(el) ? el : root;
    candidate.focus?.();
  }

  /** Переместить выделение на `delta` видимых сущностей. */
  function move(delta: number): void {
    const list = visibleEntities();
    if (list.length === 0) {
      setCurrent(null);
      return;
    }
    const index = indexOfCurrent(list);
    let next: number;
    if (index < 0) next = delta > 0 ? 0 : list.length - 1;
    else next = index + delta;
    if (next < 0 || next >= list.length) return; // граница — ничего не меняем
    const item = list[next]!;
    setCurrent(item);
    findEntityEl(item)?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Home/End — к первой/последней видимой сущности. */
  function moveToEdge(last: boolean): void {
    const list = visibleEntities();
    if (list.length === 0) {
      setCurrent(null);
      return;
    }
    const item = last ? list[list.length - 1]! : list[0]!;
    setCurrent(item);
    findEntityEl(item)?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Свернуть/развернуть полку текущей сущности. */
  function toggleShelf(collapsed: boolean): void {
    if (current?.kind !== 'shelf') return;
    opts.onToggleShelf(current.key, collapsed);
  }

  function onKeyDown(event: LibKeyEvent): void {
    const key = event.key ?? '';
    const target = (event.target ?? null) as HTMLElement | null;
    if (isEditingTarget(target)) return; // поле правки имени — клавиши ему
    navActive = true;
    switch (key) {
      case 'ArrowDown':
        event.preventDefault?.();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault?.();
        move(-1);
        break;
      case 'Home':
        event.preventDefault?.();
        moveToEdge(false);
        break;
      case 'End':
        event.preventDefault?.();
        moveToEdge(true);
        break;
      case 'ArrowLeft':
        if (current?.kind === 'shelf') {
          event.preventDefault?.();
          toggleShelf(true);
        }
        break;
      case 'ArrowRight':
        if (current?.kind === 'shelf') {
          event.preventDefault?.();
          toggleShelf(false);
        }
        break;
      case 'Enter':
        event.preventDefault?.();
        if (current?.kind === 'shelf') opts.onEditShelf(current.key);
        else if (current?.kind === 'publication') opts.onOpenPublication(current.key);
        break;
      default:
        break;
    }
  }

  function onClick(event: { target?: unknown | null }): void {
    const target = (event.target ?? null) as HTMLElement | null;
    if (target === null) return;
    navActive = true;
    let cursor: HTMLElement | null = target;
    while (cursor !== null && cursor !== root) {
      const pubKey = cursor.dataset?.['pubKey'] ?? cursor.getAttribute?.(LIB_PUB_ATTR) ?? '';
      if (pubKey !== '') {
        setCurrent({ kind: 'publication', key: pubKey });
        return;
      }
      if (cursor.classList?.contains(LIB_HEAD_CLASS) === true) {
        // Ключ полки — у секции-группы (заголовок может быть кнопкой внутри неё).
        let section: HTMLElement | null = parentOf(cursor);
        while (section !== null && section !== root && shelfKeyOf(section) === '') {
          section = parentOf(section);
        }
        const shelfId = section !== null && section !== root ? shelfKeyOf(section) : '';
        if (shelfId !== '') setCurrent({ kind: 'shelf', key: shelfId });
        return;
      }
      cursor = parentOf(cursor);
    }
  }

  /** Клик вне библиотеки гасит навигацию (перерисовка не тянет фокус назад). */
  function onDocumentClick(event: { target?: unknown | null }): void {
    const target = (event.target ?? null) as HTMLElement | null;
    if (target !== null && root.contains?.(target) === true) return;
    navActive = false;
  }

  root.addEventListener('keydown', onKeyDown as EventListener);
  root.addEventListener('click', onClick as EventListener);
  ownerDocument?.addEventListener('click', onDocumentClick as EventListener, true);

  return {
    refresh(): void {
      const list = visibleEntities();
      if (current !== null && indexOfCurrent(list) < 0) current = null;
      applyHighlight();
      const active = (ownerDocument?.activeElement ?? null) as HTMLElement | null;
      if (current !== null && navActive && !isEditingTarget(active)) focusNav();
    },
    focusNavigation(): void {
      focusNav();
    },
    current(): LibraryEntity | null {
      return current;
    },
    destroy(): void {
      root.removeEventListener('keydown', onKeyDown as EventListener);
      root.removeEventListener('click', onClick as EventListener);
      ownerDocument?.removeEventListener('click', onDocumentClick as EventListener, true);
    },
  };
}
