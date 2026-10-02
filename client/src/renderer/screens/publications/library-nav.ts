/**
 * Единая клавиатурная навигация библиотеки публикаций — адаптер общего
 * компонента списка `lib/ui/list.ts` (0.11.1, задача 55ee3c85; элемент
 * интерфейса 1eecd988; ADR «Списки и таблицы: два компонента над общим ядром
 * навигации» fadf99e0, задача 7893e429). Обслуживает ОБА представления —
 * «Полки» и «Список»: они отличаются только разметкой (секция-полка с
 * карточками против секции-группы со строками), а ход по видимой
 * последовательности сущностей общий.
 *
 * Правил навигации здесь БОЛЬШЕ НЕТ: клавиши, границы, Home/End и хранение
 * выделения по ключу — в ядре `lib/ui/nav-core.ts` и компоненте
 * `lib/ui/list.ts`. Этот модуль — представление: собирает видимые сущности из
 * разметки, отдаёт узлы, рисует класс выделения и сообщает экрану о
 * сворачивании полки / открытии публикации.
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
 */

import { createListNav, type ListNavAdapter } from '../../lib/ui/list.js';
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

/** Сущность видимого списка: сама сущность и её DOM-узел. */
interface LibraryEntry {
  entity: LibraryEntity;
  el: HTMLElement | null;
}

/**
 * Подключить контроллер навигации к корню библиотеки. `root` — общий контейнер
 * обоих видов (`.publications`).
 */
export function attachLibraryNav(root: HTMLElement, opts: LibraryNavOptions): LibraryNavHandle {
  /** Текущая сущность (зеркало состояния компонента списка). */
  let current: LibraryEntity | null = null;

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

  /** Узел DOM сущности (null — сущность не видна). */
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
  function renderHighlight(): void {
    clearHighlight();
    findEntityEl(current)?.classList.add(LIB_NAV_CURRENT_CLASS);
  }

  const nav = createListNav<LibraryEntry>(root, {
    entries: () =>
      visibleLibraryEntities(readGroups()).map((entity): LibraryEntry => ({ entity, el: null })),
    tokenOf: (entry) => `${entry.entity.kind}\u0000${entry.entity.key}`,
    elementOf: (entry) => findEntityEl(entry.entity),
    applyHighlight: () => renderHighlight(),
    onSelectionChange: (entry) => {
      current = entry?.entity ?? null;
    },
    onCollapse: (entry, collapsed) => {
      if (entry.entity.kind === 'shelf') opts.onToggleShelf(entry.entity.key, collapsed);
    },
    onActivate: (entry) => {
      if (entry.entity.kind === 'shelf') opts.onEditShelf(entry.entity.key);
      else opts.onOpenPublication(entry.entity.key);
    },
    onClick: (target) => {
      let cursor: HTMLElement | null = target;
      while (cursor !== null && cursor !== root) {
        const pubKey = cursor.dataset?.['pubKey'] ?? cursor.getAttribute?.(LIB_PUB_ATTR) ?? '';
        if (pubKey !== '') {
          nav.setCurrent({ entity: { kind: 'publication', key: pubKey }, el: cursor });
          return;
        }
        if (cursor.classList?.contains(LIB_HEAD_CLASS) === true) {
          // Ключ полки — у секции-группы (заголовок может быть кнопкой внутри неё).
          let section: HTMLElement | null = parentOf(cursor);
          while (section !== null && section !== root && shelfKeyOf(section) === '') {
            section = parentOf(section);
          }
          const shelfId = section !== null && section !== root ? shelfKeyOf(section) : '';
          if (shelfId !== '') nav.setCurrent({ entity: { kind: 'shelf', key: shelfId }, el: null });
          return;
        }
        cursor = parentOf(cursor);
      }
    },
  } satisfies ListNavAdapter<LibraryEntry>);

  return {
    refresh(): void {
      nav.refresh();
    },
    focusNavigation(): void {
      nav.focusNavigation();
    },
    current(): LibraryEntity | null {
      return current;
    },
    destroy(): void {
      nav.destroy();
    },
  };
}
