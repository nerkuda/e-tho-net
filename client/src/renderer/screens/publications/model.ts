/**
 * Чистая модель экрана «Публикации» (0.11.1, задача a3cfc018; элемент
 * интерфейса 1eecd988, требование 1b39206e).
 *
 * Здесь только вычисления без DOM и обращений к серверу: разбор/сериализация
 * персональных настроек вида, заглушка обложки («цвет + инициалы»), разбиение
 * публикаций по полкам и подписи. Модуль намеренно чистый — его проверяют
 * юнит-тесты; сеть и разметку держат `publications.ts` и соседние модули.
 */

import {
  PUBLICATION_ACTIVE_FILTERS,
  PUBLICATION_SORTS,
  type Publication,
  type PublicationActiveFilter,
  type PublicationSort,
  type Shelf,
} from '@etn/shared';

/** Вид библиотеки: горизонтальные полки или плоский список (полки — группы). */
export type PublicationsViewMode = 'shelves' | 'list';

/** Персональные настройки вида экрана «Публикации» (L4 `ui_state`, требование
 *  1b39206e). Уровень «пользователь × сеть», со слоями не ветвятся. */
export interface PublicationsViewState {
  viewMode: PublicationsViewMode;
  sort: PublicationSort;
  /** Фильтр актуальности: `true` — только актуальные (по умолчанию). */
  activeFilter: PublicationActiveFilter;
  /** Полка-фильтр (id) или `null` — все полки. */
  shelfFilter: string | null;
  /** Текст поиска (по названию/подзаголовку/автору). */
  query: string;
  /** Развёрнута ли панель дополнительных фильтров. */
  filtersOpen: boolean;
}

/** Значения по умолчанию. */
export function defaultPublicationsViewState(): PublicationsViewState {
  return {
    viewMode: 'shelves',
    sort: 'manual',
    activeFilter: 'true',
    shelfFilter: null,
    query: '',
    filtersOpen: false,
  };
}

const VIEW_MODES: readonly PublicationsViewMode[] = ['shelves', 'list'];

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Разбирает сохранённый JSON настроек; мусор заменяется значениями по
 *  умолчанию, а не бросает исключение (значение L4 — недоверенный вход). */
export function parsePublicationsViewState(raw: unknown): PublicationsViewState {
  const fallback = defaultPublicationsViewState();
  if (typeof raw !== 'string' || raw === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback;
  const obj = parsed as Record<string, unknown>;
  const viewMode = asString(obj['viewMode']);
  const sort = asString(obj['sort']);
  const activeFilter = asString(obj['activeFilter']);
  const shelfFilter = asString(obj['shelfFilter']);
  return {
    viewMode:
      viewMode !== null && (VIEW_MODES as readonly string[]).includes(viewMode)
        ? (viewMode as PublicationsViewMode)
        : fallback.viewMode,
    sort:
      sort !== null && (PUBLICATION_SORTS as readonly string[]).includes(sort)
        ? (sort as PublicationSort)
        : fallback.sort,
    activeFilter:
      activeFilter !== null && (PUBLICATION_ACTIVE_FILTERS as readonly string[]).includes(activeFilter)
        ? (activeFilter as PublicationActiveFilter)
        : fallback.activeFilter,
    shelfFilter,
    query: asString(obj['query']) ?? fallback.query,
    filtersOpen: obj['filtersOpen'] === true,
  };
}

/** Сериализует настройки для L4 (стабильный порядок ключей). */
export function serializePublicationsViewState(state: PublicationsViewState): string {
  return JSON.stringify({
    viewMode: state.viewMode,
    sort: state.sort,
    activeFilter: state.activeFilter,
    shelfFilter: state.shelfFilter,
    query: state.query,
    filtersOpen: state.filtersOpen,
  });
}

/**
 * Палитра заглушки обложки. Намеренно в модели, а не в CSS: цвет выбирается
 * детерминированно по id публикации, чтобы одна и та же публикация всегда
 * выглядела одинаково у всех пользователей. Тон задаётся парой «фон/текст».
 */
export const COVER_TONES: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#5b8def', fg: '#ffffff' },
  { bg: '#3fb27f', fg: '#ffffff' },
  { bg: '#e0902f', fg: '#ffffff' },
  { bg: '#c85b7a', fg: '#ffffff' },
  { bg: '#7a6ff0', fg: '#ffffff' },
  { bg: '#2fa5b5', fg: '#ffffff' },
  { bg: '#9a6b3f', fg: '#ffffff' },
  { bg: '#6f7b8a', fg: '#ffffff' },
];

/** Простая 32-битная свёртка строки (FNV-1a-подобная) — детерминированный тон. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Тон заглушки обложки для публикации. */
export function coverTone(id: string): { bg: string; fg: string } {
  const tone = COVER_TONES[hashString(id) % COVER_TONES.length];
  return tone ?? COVER_TONES[0]!;
}

/**
 * Инициалы для заглушки обложки: первые буквы до двух значимых слов названия.
 * Пустое/пунктуационное название даёт «?».
 */
export function coverInitials(title: string): string {
  const words = title
    .split(/[\s\-_/\\.,;:!?()[\]{}"'`]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0) return '?';
  const letters = words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('');
  return letters.toLocaleUpperCase('ru-RU');
}

/** Отображаемое авторство: переопределённый текст или создатель. */
export function displayAuthorship(publication: Publication, creatorName: string | null): string {
  const authored = publication.authorship?.trim();
  if (authored !== undefined && authored !== '') return authored;
  return creatorName ?? '';
}

/** Публикация вместе с её полками (id) — для полок/списка и меню. */
export interface PublicationWithShelves {
  publication: Publication;
  shelfIds: string[];
}

/**
 * Разбиение публикаций по полкам с сохранением порядка.
 *
 * Возвращает:
 *  - `byShelf` — для каждой полки (в её порядке) список публикаций в порядке
 *    состава полки; публикации, отфильтрованные поиском, в список не попадают;
 *  - `unshelved` — публикации, не входящие ни в одну полку (порядок — входной,
 *    то есть порядок ответа списка: `manual` — серверный порядок, иначе сортировка);
 *  - `shelfIdsOf` — карта «публикация → полки» для бейджей и меню.
 */
export function groupByShelves(
  publications: readonly Publication[],
  shelves: readonly Shelf[],
): {
  byShelf: Array<{ shelf: Shelf; items: Publication[] }>;
  unshelved: Publication[];
  shelfIdsOf: Map<string, string[]>;
} {
  const byId = new Map(publications.map((p) => [p.id, p]));
  const shelfIdsOf = new Map<string, string[]>();
  const assigned = new Set<string>();
  const byShelf = shelves.map((shelf) => {
    const items: Publication[] = [];
    for (const item of [...shelf.items].sort((a, b) => a.position - b.position)) {
      const publication = byId.get(item.publication_id);
      if (publication === undefined) continue;
      items.push(publication);
      assigned.add(publication.id);
      const list = shelfIdsOf.get(publication.id) ?? [];
      list.push(shelf.id);
      shelfIdsOf.set(publication.id, list);
    }
    return { shelf, items };
  });
  const unshelved = publications.filter((p) => !assigned.has(p.id));
  return { byShelf, unshelved, shelfIdsOf };
}

/** Строковое представление «даты сборки» публикации (ISO → локальная дата). */
export function assemblyDateLabel(iso: string | null): string {
  if (iso === null || iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('ru-RU');
}
