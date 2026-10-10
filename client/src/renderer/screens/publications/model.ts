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

/** Вид библиотеки: горизонтальные полки или плоский список (полки — группы). */
export type PublicationsViewMode = 'shelves' | 'list';

/**
 * Ключ reconcile блока-полки для вида «полки». Плоский вид (фильтр по
 * конкретной полке, 5de0332d п.8) входит в КЛЮЧ: смена flat-ности обязана
 * пересобрать узел (шапка/пустое состояние добавляются/убираются), а `update`
 * этого не умеет — `reconcileKeyed` строит заново только при отсутствии ключа.
 */
export function shelfBlockKey(block: { shelf: { id: string }; flat?: boolean }): string {
  return block.flat === true ? `${block.shelf.id}|flat` : block.shelf.id;
}

/** Ключ reconcile группы списка — аналог {@link shelfBlockKey} для вида «список». */
export function listGroupKey(group: { id: string; flat?: boolean }): string {
  return group.flat === true ? `${group.id}|flat` : group.id;
}

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
  /**
   * Ширина колонки текста документа, % доступного пространства (50–100;
   * дополнение пользователя 2026-10-02, ползунок в шапке рабочей области).
   */
  textWidth: number;
}

/** Границы ползунка ширины текста документа (%, дополнение 2026-10-02). */
export const TEXT_WIDTH_MIN = 50;
export const TEXT_WIDTH_MAX = 100;
/** Ширина по умолчанию: документ занимает доступное пространство целиком. */
export const TEXT_WIDTH_DEFAULT = 100;

/** Приводит значение ширины к допустимому диапазону (мусор → умолчание). */
export function clampTextWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TEXT_WIDTH_DEFAULT;
  return Math.min(TEXT_WIDTH_MAX, Math.max(TEXT_WIDTH_MIN, Math.round(value)));
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
    textWidth: TEXT_WIDTH_DEFAULT,
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
    textWidth: clampTextWidth(obj['textWidth']),
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
    textWidth: clampTextWidth(state.textWidth),
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
 *
 * `sort` сортирует публикации ВНУТРИ полок и остатка (элемент интерфейса
 * 1eecd988 v3: «сортировка сортирует публикации внутри полок/групп; порядок
 * самих полок — своим порядком»). `manual` сохраняет порядок состава полки
 * (позиции) — это серверный порядок отображения; остальные ключи совпадают с
 * серверной сортировкой списка публикаций, чтобы оба вида показывали один и
 * тот же порядок внутри полок/групп.
 */
export function groupByShelves(
  publications: readonly Publication[],
  shelves: readonly Shelf[],
  sort: PublicationSort = 'manual',
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
    return { shelf, items: sortPublications(items, sort) };
  });
  const unshelved = sortPublications(
    publications.filter((p) => !assigned.has(p.id)),
    sort,
  );
  return { byShelf, unshelved, shelfIdsOf };
}

/**
 * Порядок публикаций внутри полки/группы по выбранной сортировке. Повторяет
 * семантику серверной сортировки списка публикаций
 * (`publication-service.ts#listPublications`): `title` — по названию (без учёта
 * регистра), `date` — по дате создания (убывание), `author` — по
 * `authorship`, иначе по создателю. `manual` — исходный порядок (позиции
 * состава полки / серверный порядок остатка) без изменений.
 */
export function sortPublications(
  items: readonly Publication[],
  sort: PublicationSort,
): Publication[] {
  if (sort === 'manual') return [...items];
  const copy = [...items];
  if (sort === 'title') {
    copy.sort((a, b) => compareText(a.title, b.title));
  } else if (sort === 'date') {
    copy.sort((a, b) => compareText(b.created_at, a.created_at));
  } else {
    copy.sort((a, b) =>
      compareText(a.authorship ?? a.created_by, b.authorship ?? b.created_by),
    );
  }
  return copy;
}

/** Сравнение строк без учёта регистра (локаль `ru`), стабильное при равенстве. */
function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'ru', { sensitivity: 'base' });
}

/** Вид глобального пустого состояния экрана (элемент интерфейса 1eecd988 v3). */
export type PublicationsEmptyKind = 'none' | 'noData' | 'noResults';

/**
 * Нужно ли глобальное пустое состояние — и какое (спека 1eecd988 v3).
 *
 * Полки отображаются всегда, в том числе в сети без публикаций, поэтому
 * пустая библиотека НЕ показывает глобальное состояние, пока есть живые полки:
 * содержимым экрана становятся сами (пустые) секции полок. Глобальное пустое
 * состояние появляется, только когда нет ни публикаций, ни живых полок.
 * Отдельно различается состояние поиска/фильтра: когда запрос не дал ничего,
 * показывается «Ничего не найдено» (это состояние запроса, а не библиотеки).
 */
export function publicationsEmptyKind(
  publicationCount: number,
  shelfCount: number,
  searching: boolean,
): PublicationsEmptyKind {
  if (publicationCount > 0) return 'none';
  if (searching) return 'noResults';
  return shelfCount > 0 ? 'none' : 'noData';
}

/**
 * Итог inline-переименования полки (задача 00160da1): нормализованное новое
 * имя или `null`, когда сохранять нечего — пустая строка (обрезка пробелов)
 * либо имя не изменилось. Пустой результат оставляет прежнее имя.
 */
export function nextShelfTitle(current: string, raw: string): string | null {
  const title = raw.trim();
  if (title === '' || title === current) return null;
  return title;
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

/**
 * Новый порядок ОДНОЙ группы `node_key`, в котором ключи `added` уезжают в
 * КОНЕЦ (волна 8, п.1: добавленный текст раздела — последним). Взаимный порядок
 * остальных и добавленных сохраняется; при этом чужие группы не затрагиваются —
 * вызывающий (DnD/Alt) и так переставляет ровно одну группу. Ключи `added`,
 * которых нет в `keys`, игнорируются (в группе их нет).
 */
export function keysAppendedLast(
  keys: readonly string[],
  added: readonly string[],
): string[] {
  if (added.length === 0) return [...keys];
  const set = new Set(added);
  const kept = keys.filter((key) => !set.has(key));
  const tail = keys.filter((key) => set.has(key));
  return [...kept, ...tail];
}

/**
 * Применяет локальный порядок к дереву сборки (чисто, без мутации входа).
 *
 * Сервер сортирует соседей одного родителя и тексты одного раздела по позиции
 * своего `node_key` (раздел — id мысли/ребра, текст — id ребра-источника;
 * операция f6b242fe), но узел БЕЗ локальной позиции НЕ уезжает в конец: у него
 * берётся сетевое/ветковое место — `localOf(key) ?? branchPosition` (детей) и
 * `localOf(id) ?? position входящего ребра / порядок отбора` (корней), см.
 * `server/src/domain/publication-assembly-service.ts` (компаратор узлов).
 *
 * Здесь та же семантика воспроизведена без знания `branchPosition`: текущий
 * порядок модели — это и есть последний серверный порядок, поэтому узел без
 * позиции СОХРАНЯЕТ своё текущее место (свой индекс), а позиционированные
 * заполняют СОБСТВЕННЫЕ текущие слоты в порядке своих позиций. Если в группе ни
 * у кого нет позиции — группа не трогается вовсе. Так полный список из ответа
 * PUT/события применяется безопасно: нетронутые группы не пересортировываются,
 * и UI не расходится с `GET /assembly`.
 *
 * `items` — либо батч клиента, либо ПОЛНЫЙ список порядка из события
 * `publication.order.reordered`; повторное применение идемпотентно.
 */
export function applyPublicationOrder(
  assembly: PublicationAssembly | null,
  items: readonly PublicationOrderItem[],
): PublicationAssembly | null {
  if (assembly === null || items.length === 0) return assembly;
  const position = new Map(items.map((item) => [item.node_key, item.position]));

  /**
   * Переставить ТОЛЬКО позиционированные узлы, сохранив неупорядоченные на их
   * текущих слотах. Компаратор сервера для позиционированных — по `position`,
   * при равенстве по порядку отбора (стабильно по исходному индексу).
   */
  const orderByKey = <T>(list: readonly T[], keyOf: (item: T) => string): T[] => {
    const slots: number[] = [];
    const ranked: Array<{ value: T; index: number; pos: number }> = [];
    list.forEach((value, index) => {
      const pos = position.get(keyOf(value));
      if (pos === undefined) return;
      slots.push(index);
      ranked.push({ value, index, pos });
    });
    if (slots.length === 0) return [...list];
    ranked.sort((a, b) => (a.pos === b.pos ? a.index - b.index : a.pos - b.pos));
    const out = [...list];
    slots.forEach((slot, order) => {
      out[slot] = ranked[order]!.value;
    });
    return out;
  };
  const walk = (
    sections: readonly PublicationAssemblySection[],
  ): PublicationAssemblySection[] =>
    orderByKey(sections, (section) => section.node_key).map((section) => ({
      ...section,
      texts: orderByKey(section.texts, (text) => text.edge_id),
      children: walk(section.children),
    }));
  return { ...assembly, sections: walk(assembly.sections) };
}

// ---------------------------------------------------------------------------
// Плоские блоки документа для keyed-рендера (задача 4f03b9d5). Чистые данные:
// разметку строит `workspace.ts`, но состав блоков и их подписи сравнения
// живут здесь — их проверяют юнит-тесты (в т.ч. realtime-пересборка).
// ---------------------------------------------------------------------------

/**
 * Есть ли у раздела сворачиваемое содержимое (тексты, предисловие или
 * дочерние разделы). Только такие разделы получают каретку-экспандер и
 * попадают под «Свернуть все» (задача b51dbca4).
 */
export function sectionHasContent(section: PublicationAssemblySection): boolean {
  return (
    section.children.length > 0 ||
    section.texts.length > 0 ||
    section.preamble_html !== ''
  );
}

/** Блок документа — плоская единица keyed-сверки. */
export type DocBlock =
  | { kind: 'title'; key: 'title'; sig: string }
  | {
      kind: 'section';
      key: string;
      /** DOM-id блока: уникален на вхождение (`anchor` — только у первого). */
      domId: string;
      thoughtId: string;
      /** Ключ локального порядка раздела (`node_key`, PUT order). */
      nodeKey: string;
      /** id мысли раздела-родителя; `null` — корневой (группа соседей). */
      parentThoughtId: string | null;
      level: number;
      heading: string;
      preambleHtml: string;
      repeat: boolean;
      cycle: boolean;
      /** У раздела есть сворачиваемое содержимое (каретка-экспандер). */
      collapsible: boolean;
      /** Раздел свёрнут: тексты/предисловие/подразделы скрыты. */
      collapsed: boolean;
    }
  | {
      kind: 'text';
      key: string;
      domId: string;
      thoughtId: string;
      /** Ключ локального порядка текста (`node_key` = id ребра-источника). */
      nodeKey: string;
      /** id мысли раздела-владельца: группа соседей текста (внутри раздела). */
      parentThoughtId: string;
      html: string;
      /**
       * Исходный markdown текста (постоянный комментарий мысли-текста). Нужен
       * для развёртки трансклюзий в ленте: серверный `body_html` собран из
       * исходника и ссылку-трансклюзию не разворачивает (ошибка 075602b4).
       */
      md: string;
    }
  | { kind: 'extra'; key: string; groups: PublicationAssemblyExtraGroup[] };

/**
 * Ключ вхождения (DOM-key и DOM-id) для якоря мысли. Якорь
 * `publicationAnchor(thoughtId)` один на мысль, а при повторе (несколько
 * отобранных родителей/кольцо) сборка содержит её дважды — поэтому ключ
 * keyed-сверки и `id` узла обязаны нести номер вхождения, иначе
 * `reconcileKeyed` бросит `duplicate key`, а в DOM будет два одинаковых `id`.
 * Первое вхождение сохраняет чистый `anchor` (цель перехода к первому
 * вхождению — `repeat_of`), последующие получают суффикс.
 */
function occurrence(counter: Map<string, number>, anchor: string): { key: string; domId: string } {
  const index = counter.get(anchor) ?? 0;
  counter.set(anchor, index + 1);
  return { key: `${anchor}#${index}`, domId: index === 0 ? anchor : `${anchor}-r${index}` };
}

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
 * Ключи и `domId` блоков уникальны на вхождение (см. {@link occurrence}).
 *
 * `collapsed` — свёрнутые разделы (по id мысли, задача b51dbca4): тексты,
 * предисловие и подразделы свёрнутого раздела не попадают в блоки вовсе —
 * значит, скрыты и в разметке, и в навигации. Счётчик вхождений при этом
 * прокручивается по ВСЕМ разделам/текстам дерева (как в {@link tocLines}) —
 * иначе нумерация якорей разошлась бы с оглавлением и повторы получили бы
 * чужой `domId`.
 */
export function documentBlocks(
  assembly: PublicationAssembly | null,
  publication: Publication | null,
  collapsed: ReadonlySet<string> = new Set(),
): DocBlock[] {
  if (assembly === null) return [];
  const out: DocBlock[] = [
    { kind: 'title', key: 'title', sig: titleSignature(publication, assembly.publication.summary_html) },
  ];
  const counter = new Map<string, number>();
  const walk = (
    sections: readonly PublicationAssemblySection[],
    hidden: boolean,
    parentThoughtId: string | null,
  ): void => {
    for (const section of sections) {
      const occ = occurrence(counter, section.anchor);
      const textOccs = section.texts.map((text) => occurrence(counter, text.anchor));
      if (hidden) {
        walk(section.children, true, section.thought_id);
        continue;
      }
      const selfCollapsed = collapsed.has(section.thought_id);
      out.push({
        kind: 'section',
        key: occ.key,
        domId: occ.domId,
        thoughtId: section.thought_id,
        nodeKey: section.node_key,
        parentThoughtId,
        level: section.level,
        heading: section.heading,
        preambleHtml: section.preamble_html,
        repeat: section.flags.repeat_of !== null,
        cycle: section.flags.cycle_cut,
        collapsible: sectionHasContent(section),
        collapsed: selfCollapsed,
      });
      if (!selfCollapsed) {
        section.texts.forEach((text, index) => {
          const textOcc = textOccs[index]!;
          out.push({
            kind: 'text',
            key: textOcc.key,
            domId: textOcc.domId,
            thoughtId: text.thought_id,
            nodeKey: text.edge_id,
            parentThoughtId: section.thought_id,
            html: text.body_html,
            md: text.body_md,
          });
        });
        if (section.extra.length > 0) {
          out.push({ kind: 'extra', key: `${occ.key}#extra`, groups: section.extra });
        }
      }
      walk(section.children, selfCollapsed, section.thought_id);
    }
  };
  walk(assembly.sections, false, null);
  return out;
}

/** Подпись блока документа для сравнения при keyed-сверке. */
export function blockSignature(block: DocBlock): string {
  switch (block.kind) {
    case 'title':
      return block.sig;
    case 'section':
      return `s:${block.heading}:${block.level}:${block.preambleHtml}:${block.repeat}:${block.cycle}:${block.collapsible}:${block.collapsed}`;
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

// ---------------------------------------------------------------------------
// Фиттинг шрифта титульных строк (замечание 3 волны 7)
// ---------------------------------------------------------------------------

/** Границы и шаг итеративного уменьшения кегля титульной строки. */
export interface FontFit {
  /** Стартовый (максимальный) кегль, px. */
  max: number;
  /** Нижний предел, px — меньше не уменьшаем. */
  min: number;
  /** Шаг уменьшения, px. */
  step: number;
}

/**
 * Подбирает кегль титульной строки итеративным уменьшением: пробует `max`,
 * затем каждый шаг ниже, пока `overflows(size)` истинно; на нижнем пределе
 * останавливается в любом случае. Возвращает подобранный размер.
 *
 * Функция ЧИСТАЯ — измерение (перенос строки в зоне, `scrollHeight` против
 * `clientHeight`) выполняет вызывающий через `overflows`, поэтому подбор
 * тестируется без DOM (замечание 3 волны 7: без MutationObserver).
 */
export function fitFontSize(config: FontFit, overflows: (size: number) => boolean): number {
  for (let size = config.max; size > config.min; size -= config.step) {
    if (!overflows(size)) return size;
  }
  return config.min;
}

/**
 * id мыслей всех разделов сборки, которые можно свернуть (есть содержимое).
 * Для тулбара «Свернуть все» (задача b51dbca4).
 */
export function collapsibleSectionIds(assembly: PublicationAssembly | null): string[] {
  if (assembly === null) return [];
  const ids = new Set<string>();
  for (const item of flattenSections(assembly.sections)) {
    if (sectionHasContent(item.section)) ids.add(item.section.thought_id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Плоские строки оглавления (задача 4f03b9d5). Как и блоки документа, строки
// несут уникальный ключ вхождения (повтор раздела даёт две строки).
// ---------------------------------------------------------------------------

/** Строка оглавления — плоская единица keyed-сверки. */
export type TocLine =
  | {
      kind: 'section';
      key: string;
      /** DOM-id для навигации/подсветки (уникален на вхождение). */
      anchor: string;
      thoughtId: string;
      nodeKey: string;
      parentThoughtId: string | null;
      depth: number;
      label: string;
      repeat: boolean;
      /** Якорь первого вхождения (цель перехода по пометке повтора). */
      repeatOf: string | null;
      cycle: boolean;
      hasChildren: boolean;
      collapsed: boolean;
    }
  | { kind: 'text'; key: string; anchor: string; thoughtId: string; depth: number; label: string }
  | { kind: 'excluded'; key: string; thoughtId: string; title: string };

/**
 * Строит плоский список строк оглавления (разделы/исключённые). Тексты в
 * оглавление НЕ попадают (дополнение пользователя 2026-10-02, пункт 2): строки
 * «Текст N» замусоривали панель; в холсте документа тексты остаются. Счётчик
 * вхождений по-прежнему прокручивается и по текстам — иначе нумерация якорей
 * разошлась бы с `documentBlocks` при совпадении id раздела и текста.
 *
 * Свёрнутый раздел (`collapsed`) прячет всё своё поддерево — та же семантика,
 * что у тела документа (`documentBlocks`, задача b51dbca4), иначе оглавление и
 * документ расходились бы при сворачивании. Счётчик вхождений ведётся по всем
 * ветвям дерева (см. ошибку 59a17805).
 */
export function tocLines(
  assembly: PublicationAssembly | null,
  collapsed: ReadonlySet<string>,
  _textLabel: (index: number) => string,
): TocLine[] {
  if (assembly === null) return [];
  const out: TocLine[] = [];
  const flat = flattenSections(assembly.sections);
  const hidden = new Set<string>();
  const counter = new Map<string, number>();
  for (const item of flat) {
    const parent = item.parentThoughtId;
    const isHidden = parent !== null && (hidden.has(parent) || collapsed.has(parent));
    // Счётчик вхождений ведём по ВСЕМ разделам/текстам дерева — до фильтра
    // свёрнутых ветвей: иначе нумерация якорей расходится с `documentBlocks`,
    // и видимая строка-повтор, чьё первое вхождение скрыто, получает чистый
    // anchor и `repeatOf` на саму себя (ошибка 59a17805).
    const occ = occurrence(counter, item.section.anchor);
    // Прокручиваем счётчик и по текстам, хотя в оглавление они не выводятся:
    // при совпадении id раздела и текста общий счётчик якорей иначе разошёлся
    // бы с `documentBlocks`.
    for (const text of item.section.texts) occurrence(counter, text.anchor);
    if (isHidden) {
      hidden.add(item.section.thought_id);
      continue;
    }
    const selfCollapsed = collapsed.has(item.section.thought_id);
    out.push({
      kind: 'section',
      key: occ.key,
      anchor: occ.domId,
      thoughtId: item.section.thought_id,
      nodeKey: item.section.node_key,
      parentThoughtId: item.parentThoughtId,
      depth: item.depth,
      label: item.section.heading,
      repeat: item.section.flags.repeat_of !== null,
      repeatOf: item.section.flags.repeat_of,
      cycle: item.section.flags.cycle_cut,
      hasChildren: sectionHasContent(item.section),
      collapsed: selfCollapsed,
    });
  }
  for (const excluded of assembly.excluded) {
    out.push({
      kind: 'excluded',
      key: `x:${excluded.thought_id}`,
      thoughtId: excluded.thought_id,
      title: excluded.title,
    });
  }
  return out;
}

/** Подпись строки оглавления для сравнения при keyed-сверке. */
export function tocSignature(line: TocLine): string {
  switch (line.kind) {
    case 'section':
      return `s:${line.label}:${line.depth}:${line.repeat}:${line.repeatOf ?? ''}:${line.cycle}:${line.nodeKey}:${line.parentThoughtId ?? ''}:${line.hasChildren}:${line.collapsed}`;
    case 'text':
      return `t:${line.label}:${line.depth}`;
    case 'excluded':
      return `x:${line.title}`;
  }
}

// ---------------------------------------------------------------------------
// Операции с блоками документа (блокеры верификации ea1b5f14). Чистые
// предикаты вынесены сюда: их проверяют юнит-тесты без DOM.
// ---------------------------------------------------------------------------

/**
 * Совпадает ли запись значения-связи с выбранным свойством-строкой.
 *
 * Для свойства-связи ВНЕ цепочки типа владельца серверная проекция «ребро →
 * свойство» отдаёт `property_id: ''` (см. `listThoughtLinkProperties`): по
 * одному id такое значение не находится, и аддитивное добавление затирало
 * список (блокер 2/3 верификации ea1b5f14). Поэтому сверяем и по
 * отображаемому имени стороны — оно же `key` записи `properties.set`.
 */
export function linkEntryMatchesPick(
  entry: { property_id: string; property_name: string },
  pick: { propertyId: string; key: string },
): boolean {
  if (entry.property_id !== '' && entry.property_id === pick.propertyId) return true;
  return entry.property_name === pick.key;
}

/**
 * Поддерево id: сам корень и все его потомки по `parentId` (замыкание).
 * Нужно, чтобы «Переместить в раздел…» не предлагал и не принимал
 * собственного потомка — иначе `set_only_parents` создаёт цикл (блокер 1
 * верификации ea1b5f14).
 */
export function subtreeIds(
  rootId: string,
  items: readonly { id: string; parentId?: string | null }[],
): Set<string> {
  const out = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parentId != null && out.has(item.parentId) && !out.has(item.id)) {
        out.add(item.id);
        changed = true;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Единая навигация представлений «Полки»/«Список» (задача 55ee3c85). Чистые
// вычисления видимой последовательности сущностей и свёрнутости групп — ими
// пользуется DOM-контроллер `library-nav.ts`; проверяются юнит-тестами.
// ---------------------------------------------------------------------------

/** Сущность единой навигации библиотеки: полка-группа либо публикация. */
export type LibraryEntityKind = 'shelf' | 'publication';

/** Сущность в видимой последовательности навигации. */
export interface LibraryEntity {
  kind: LibraryEntityKind;
  /** Ключ: `data-shelf-key` полки либо `data-pub-key` публикации (её id). */
  key: string;
}

/** Группа библиотеки, как её видит навигация (одна для обоих видов). */
export interface LibraryGroupLike {
  /** Ключ полки (`data-shelf-key` секции). */
  shelfId: string;
  /** Публикации группы В ПОРЯДКЕ ОТОБРАЖЕНИЯ. */
  publicationIds: readonly string[];
  /** Группа свёрнута — её публикации в последовательность не попадают. */
  collapsed: boolean;
}

/**
 * Видимая последовательность сущностей навигации: для каждой группы — сперва
 * её заголовок (`shelf`), затем публикации, если группа не свёрнута. Это
 * единый порядок обоих представлений (задача 55ee3c85): «Полки» и «Список»
 * отличаются только разметкой, а ход ↑/↓/Home/End общий.
 */
export function visibleLibraryEntities(groups: readonly LibraryGroupLike[]): LibraryEntity[] {
  const out: LibraryEntity[] = [];
  for (const group of groups) {
    out.push({ kind: 'shelf', key: group.shelfId });
    if (group.collapsed) continue;
    for (const publicationId of group.publicationIds) {
      out.push({ kind: 'publication', key: publicationId });
    }
  }
  return out;
}

/**
 * Свёрнута ли полка при данном множестве свёрнутых. По умолчанию полки
 * развёрнуты; свёрнутость — персональный рантайм-набор (переживает keyed-
 * перерисовку, но не сохраняется в `ui_state`).
 */
export function isShelfCollapsed(shelfId: string, collapsed: ReadonlySet<string>): boolean {
  return collapsed.has(shelfId);
}

/** Команда контекстного меню публикации (единая для обоих представлений). */
export type PublicationMenuCommand =
  | 'open'
  | 'delete'
  | 'read'
  | 'exportMd'
  | 'exportHtml'
  | 'exportPdf';

/**
 * Состав контекстного меню публикации (задачи 55ee3c85, b51dbca4): «Открыть»
 * (карточка в панели редактора), «Удалить», «Читать» (рабочая область) и
 * «Экспортировать» (подменю md/html/pdf). Управление полками переехало в
 * настройки публикации, актуальность — признак в редакторе, поэтому пунктов
 * «На полки» и «Неактуальна/Актуальна» здесь больше нет. Возвращает КОМАНДЫ без
 * сепараторов — их расставляет построитель меню, а состав и порядок закреплены
 * тестом.
 */
export function publicationMenuCommands(): PublicationMenuCommand[] {
  return ['open', 'delete', 'read', 'exportMd', 'exportHtml', 'exportPdf'];
}

/** Команда контекстного меню полки/группы. */
export type ShelfMenuCommand = 'addPublication' | 'delete';

/**
 * Состав контекстного меню полки: «Добавить публикацию» (мастер с предвыбранной
 * полкой, задача 55ee3c85) и «Удалить».
 */
export function shelfMenuCommands(): ShelfMenuCommand[] {
  return ['addPublication', 'delete'];
}

/**
 * Полка, предвыбранная в мастере: явно переданная (если она ещё жива) либо
 * `null` — «без полки». Мастер не выбирает несуществующую полку.
 */
export function wizardShelfChoice(
  shelves: readonly { id: string }[],
  initial: string | null,
): string | null {
  if (initial !== null && shelves.some((shelf) => shelf.id === initial)) return initial;
  return null;
}
