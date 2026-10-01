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
  type PublicationAssembly,
  type PublicationAssemblyExtraGroup,
  type PublicationAssemblySection,
  type PublicationOrderItem,
  type PublicationSort,
  type Shelf,
  type ShelfItem,
} from '@etn/shared';

import type { EntityOption } from '../../lib/entity-picker.js';

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

// ---------------------------------------------------------------------------
// Перестановка публикации внутри полки (вкладка «Полки и статус», c3e44cab)
// ---------------------------------------------------------------------------

/** Целевая позиция одной публикации в составе полки после перестановки. */
export interface ShelfPositionUpdate {
  publication_id: string;
  position: number;
}

/**
 * Обмен позициями перемещаемой публикации и соседа в составе полки.
 *
 * Возвращает ДВЕ записи с обменянными позициями (уникальный состав полки —
 * `(shelf_id, publication_id)`, апдейт идёт по ключу, поэтому обмен позициями
 * двух строк эквивалентен их перестановке). Состав сервер отдаёт
 * `ORDER BY position ASC` без второго ключа, поэтому одной записи недостаточно:
 * равные позиции порядок не меняют — меняем обе. `null` — переставлять нечего
 * (крайние границы, неизвестная публикация). Сортировка — по `position`
 * (порядок отображения состава), при равенстве — по исходному порядку массива.
 */
export function shelfSwapUpdates(
  items: readonly ShelfItem[],
  publicationId: string,
  direction: -1 | 1,
): ShelfPositionUpdate[] | null {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      a.item.position === b.item.position ? a.index - b.index : a.item.position - b.item.position,
    )
    .map((entry) => entry.item);
  const index = ordered.findIndex((item) => item.publication_id === publicationId);
  if (index === -1) return null;
  const swap = index + direction;
  if (swap < 0 || swap >= ordered.length) return null;
  const moved = ordered[index]!;
  const neighbor = ordered[swap]!;
  return [
    { publication_id: moved.publication_id, position: neighbor.position },
    { publication_id: neighbor.publication_id, position: moved.position },
  ];
}

// ---------------------------------------------------------------------------
// Варианты свойств-связей для пикера (без дублей)
// ---------------------------------------------------------------------------

/**
 * Сводит варианты свойств-связей к ОДНОМУ на реестровое свойство.
 *
 * `linkPropertyEntityOptions` даёт строку на каждую сторону связи
 * (`prop:source`, `prop:target`), а источники текстов публикации адресуются
 * id реестрового свойства — поэтому варианты дедуплицируются по `propertyId`.
 * При двух сторонах выбирается сторона `source` (прямое имя свойства — та же
 * семантика, что у прежнего выбора по реестру). Порядок первых вхождений
 * сохраняется.
 */
export function dedupePropertyOptions(options: readonly EntityOption[]): EntityOption[] {
  const byProperty = new Map<string, EntityOption>();
  for (const option of options) {
    const propertyId = option.linkProperty?.propertyId ?? option.id;
    const existing = byProperty.get(propertyId);
    if (existing === undefined) {
      byProperty.set(propertyId, { ...option, id: propertyId });
      continue;
    }
    if (existing.linkProperty?.side !== 'source' && option.linkProperty?.side === 'source') {
      byProperty.set(propertyId, { ...option, id: propertyId });
    }
  }
  return [...byProperty.values()];
}

// ---------------------------------------------------------------------------
// Рабочая область открытой публикации (0.11.1, задача 4f03b9d5; элемент
// интерфейса 2ebacd12). Чистые преобразования дерева сборки и порядка узлов —
// проверяются юнит-тестами; DOM и сеть держит `workspace.ts`.
// ---------------------------------------------------------------------------

/** Раздел дерева сборки, развёрнутый в плоский список (для оглавления). */
export interface FlatSection {
  section: PublicationAssemblySection;
  /** Уровень в дереве, 0 — корневой раздел. */
  depth: number;
  /** id мысли раздела-родителя; `null` — корневой. */
  parentThoughtId: string | null;
}

/** Разворачивает дерево разделов в плоский список в порядке документа (DFS). */
export function flattenSections(
  sections: readonly PublicationAssemblySection[],
  depth = 0,
  parentThoughtId: string | null = null,
): FlatSection[] {
  const out: FlatSection[] = [];
  for (const section of sections) {
    out.push({ section, depth, parentThoughtId });
    out.push(...flattenSections(section.children, depth + 1, section.thought_id));
  }
  return out;
}

/**
 * Ключ локального порядка раздела (`node_key` операции f6b242fe).
 *
 * Приходит из DTO сборки (`PublicationAssemblySection.node_key`): для корня —
 * id мысли, для вложенного раздела — id родительского ребра вхождения. Клиент
 * переставляет разделы любого уровня, не зная рёбер графа.
 */
export function sectionNodeKey(flat: FlatSection): string {
  return flat.section.node_key;
}

/**
 * Ключи `node_key` одной группы соседей — прямых детей `parentThoughtId`
 * (`null` — корневые разделы) в порядке отображения. Батч PUT order
 * переставляет узлы внутри группы.
 */
export function siblingNodeKeys(
  flat: readonly FlatSection[],
  parentThoughtId: string | null,
): string[] {
  return flat
    .filter((item) => item.parentThoughtId === parentThoughtId)
    .map((item) => item.section.node_key);
}

/**
 * Новый порядок ключей после переноса `movedId` перед `beforeId`
 * (`beforeId === null` — в конец). Неизвестный `movedId` возвращает исходный
 * список без изменений; неизвестный `beforeId` трактуется как «в конец».
 */
export function reorderIds(
  ids: readonly string[],
  movedId: string,
  beforeId: string | null,
): string[] {
  const without = ids.filter((id) => id !== movedId);
  if (without.length === ids.length) return [...ids];
  const at = beforeId === null ? -1 : without.indexOf(beforeId);
  const insertAt = at === -1 ? without.length : at;
  const next = [...without];
  next.splice(insertAt, 0, movedId);
  return next;
}

/** Позиции 1..N для списка ключей узлов (батч PUT order). */
export function positionsFor(ids: readonly string[]): PublicationOrderItem[] {
  return ids.map((node_key, index) => ({ node_key, position: index + 1 }));
}

// ---------------------------------------------------------------------------
// Плоские блоки документа для keyed-рендера (задача 4f03b9d5). Чистые данные:
// разметку строит `workspace.ts`, но состав блоков и их подписи сравнения
// живут здесь — их проверяют юнит-тесты (в т.ч. realtime-пересборка).
// ---------------------------------------------------------------------------

/** Блок документа — плоская единица keyed-сверки. */
export type DocBlock =
  | { kind: 'title'; key: 'title'; sig: string }
  | {
      kind: 'section';
      key: string;
      thoughtId: string;
      level: number;
      heading: string;
      preambleHtml: string;
      repeat: boolean;
      cycle: boolean;
    }
  | { kind: 'text'; key: string; thoughtId: string; anchor: string; html: string }
  | { kind: 'extra'; key: string; groups: PublicationAssemblyExtraGroup[] };

/** Подпись титульного блока: меняется при любой правке настроек публикации. */
function titleSignature(publication: Publication | null, summaryHtml: string): string {
  if (publication === null) return `title|||||${summaryHtml}`;
  return [
    publication.title,
    publication.subtitle ?? '',
    publication.authorship ?? '',
    publication.created_by,
    publication.assembly_date ?? '',
    publication.cover_kind,
    publication.cover_attachment_id ?? '',
    publication.cover_url ?? '',
    summaryHtml,
  ].join('|');
}

/**
 * Разворачивает дерево разделов в плоские блоки документа в порядке чтения.
 * Титульный блок несёт подпись, зависящую от карточки публикации и резюме
 * сборки, — иначе правка настроек не пересобирала бы титул (realtime).
 */
export function documentBlocks(
  assembly: PublicationAssembly | null,
  publication: Publication | null,
): DocBlock[] {
  if (assembly === null) return [];
  const out: DocBlock[] = [
    { kind: 'title', key: 'title', sig: titleSignature(publication, assembly.publication.summary_html) },
  ];
  const walk = (sections: readonly PublicationAssemblySection[]): void => {
    for (const section of sections) {
      out.push({
        kind: 'section',
        key: section.anchor,
        thoughtId: section.thought_id,
        level: section.level,
        heading: section.heading,
        preambleHtml: section.preamble_html,
        repeat: section.flags.repeat_of !== null,
        cycle: section.flags.cycle_cut,
      });
      for (const text of section.texts) {
        out.push({
          kind: 'text',
          key: text.anchor,
          thoughtId: text.thought_id,
          anchor: text.anchor,
          html: text.body_html,
        });
      }
      if (section.extra.length > 0) {
        out.push({ kind: 'extra', key: `${section.anchor}#extra`, groups: section.extra });
      }
      walk(section.children);
    }
  };
  walk(assembly.sections);
  return out;
}

/** Подпись блока документа для сравнения при keyed-сверке. */
export function blockSignature(block: DocBlock): string {
  switch (block.kind) {
    case 'title':
      return block.sig;
    case 'section':
      return `s:${block.heading}:${block.level}:${block.preambleHtml}:${block.repeat}:${block.cycle}`;
    case 'text':
      return `t:${block.html}`;
    case 'extra':
      return `e:${block.groups
        .map(
          (group) =>
            `${group.property}=${group.targets.map((target) => `${target.id}:${target.title}`).join(',')}`,
        )
        .join('|')}`;
  }
}
