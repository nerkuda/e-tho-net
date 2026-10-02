/**
 * Сборка документа публикации (0.11.1, задача 34119c67; тех.проект c5261d02).
 *
 * Собирает DTO документа ([[#8b849dfc]]) из живой мыслесети в контексте слоя
 * соединения: дерево разделов по правилам [[#599414b6]], тексты и предисловия
 * по [[#620aa285]], нумерация [[#a33f7b0e]], титул [[#745fdc48]], единый рендер
 * фрагментов из `@etn/markdown` (`renderPublicationFragment`, задача d8ad884e).
 *
 * Дополнительно — членство: новые кандидаты (`GET /{id}/candidates`,
 * [[#f9a20c3f]]) и использование мысли (`GET /thoughts/{id}/publications`,
 * [[#f49c6420]]). Членство считает сервер исполнением рецептов (ADR 7adf7778,
 * требование 6e8bc3f0): клиент семантику отбора не реплицирует. Вызовы
 * ленивые, с лимитами и серверным кешем с дебаунсом.
 *
 * **Переиспользование.** Отбор заголовков исполняется движком выборки мыслей
 * (`selectRecipeIds`, domain/publication-recipe.ts) — формат рецепта тот же,
 * что у панели «Структуры мыслей»; локальных реализаций SQL-отбора здесь нет.
 * Чтение рёбер свойств-связей идёт существующим резолвом направления
 * (`resolveOwnerBindingSide`, `linkPropertyDirection`,
 * `linkPropertyLinkTypeId`). Строение документа рендерится единым
 * markdown-рендерером, поэтому превью и экспорт не расходятся (требование
 * [[#9969e586]]).
 *
 * **Детерминизм.** Обход всегда даёт одно дерево на одном графе: рёбра
 * сортируются `links.position ASC, id ASC`, локальный порядок публикации
 * ([[#18f3bebf]]) перекрывает сетевой по ключу узла. Якоря `pub-<shortid>`
 * выводятся из id мысли и не зависят от пагинации (стабильны между страницами).
 * Построение дерева итеративное — глубина алгоритмически не ограничена.
 *
 * **Семантика «кандидата» (временная, задача e754527d; спека f9a20c3f).**
 * Кандидат — мысль, подошедшая под рецепт заголовков и вошедшая в отбор ПОЗЖЕ
 * последнего принятого состояния публикации, за вычетом исключений. Принятое
 * состояние — срез id (`publications.accepted_ids`), фиксируемый созданием
 * публикации и каждым явным действием расстановки (`PUT …/order` принимает все
 * текущие узлы; `POST …/candidates/accept` гасит одного кандидата и фиксирует
 * его позицию в конец). Срез не инициализирован (`NULL`) — кандидатов нет.
 * Отличается от прежней буквальной трактовки «дифф отбора с деревом»: при
 * живой сборке в дерево попадают все достижимые отобранные разделы, поэтому
 * буквальный дифф почти всегда пуст и плашка «+N новых» не появлялась.
 */

import {
  EtnError,
  type PropertyConfig,
  type Publication,
  type PublicationAssembly,
  type PublicationAssemblyCover,
  type PublicationAssemblyExcluded,
  type PublicationAssemblyExtraGroup,
  type PublicationAssemblySection,
  type PublicationAssemblyText,
  type PublicationCandidate,
  type PublicationCandidatesResult,
  type PublicationListQuery,
  type PublicationOrderItem,
  type PublicationSectionFlags,
  type PublicationUsageItem,
  type PublicationUsageResult,
} from '@etn/shared';
import {
  formatSectionNumber,
  publicationAnchor,
  renderPublicationFragment,
  type PublicationHeading,
  type WikiLinkRef,
  type WikiLinkResolution,
} from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import { selectRecipeIds } from './publication-recipe.js';
import {
  isStructuralLinkProperty,
  linkPropertyDirection,
  linkPropertyLinkTypeId,
  linkPropertySideFromConfig,
  resolveOwnerBindingSide,
} from './property-service.js';
import { resolveThoughts } from './thought-service.js';
import {
  appendPublicationOrderItem,
  getPublication,
  getPublicationAcceptedIds,
  listPublicationExclusions,
  listPublicationOrder,
  listPublications,
  resolvePublicationRefs,
  setPublicationAcceptedIds,
} from './publication-service.js';

// ---------------------------------------------------------------------------
// Константы и лимиты
// ---------------------------------------------------------------------------

/** Размер страницы сборки по разделам верхнего уровня. */
export const PUBLICATION_ASSEMBLY_PAGE_SIZE = 20;

/** Лимит кандидатов по умолчанию и потолок (`GET /candidates`). */
export const PUBLICATION_CANDIDATES_DEFAULT_LIMIT = 50;
export const PUBLICATION_CANDIDATES_MAX_LIMIT = 200;

/** Лимит использований по умолчанию и потолок (`GET /thoughts/{id}/publications`). */
export const PUBLICATION_USAGE_DEFAULT_LIMIT = 20;
export const PUBLICATION_USAGE_MAX_LIMIT = 100;

/** Сколько публикаций слоя просматривается для расчёта использования мысли. */
export const PUBLICATION_USAGE_MAX_PUBLICATIONS = 100;

// ---------------------------------------------------------------------------
// Внутренние типы
// ---------------------------------------------------------------------------

/** Ребро-связь с одним концом-мыслью (`otherId` — противоположный конец). */
interface StructuralEdge {
  edgeId: string;
  otherId: string;
  position: number;
}

/** Строка значения свойства-связи: ребро + цель. */
interface PropertyEdge {
  edge_id: string;
  thought_id: string;
  title: string;
  type_id: string | null;
  position: number;
}

/** Реестровое свойство (прочитанное из `properties_v`). */
interface PropertyRow {
  id: string;
  name: string;
  value_type: string;
  config: PropertyConfig | null;
}

/** Ближайший отобранный предок с ребром-ветвью (первым шагом вниз от предка). */
interface Attachment {
  parentId: string;
  branchPosition: number;
}

/** Промежуточный узел дерева (без рендера). */
interface RawNode {
  thoughtId: string;
  /** Ключ локального порядка (`node_key`, операция f6b242fe): id мысли для
   *  корня, id ребра вхождения — для подраздела ([[#18f3bebf]]). */
  nodeKey: string;
  repeat: boolean;
  cycleCut: boolean;
  children: RawNode[];
}

/** Узел дерева с уровнем и сквозными счётчиками нумерации. */
export interface PublicationContentNode {
  thoughtId: string;
  /** Ключ локального порядка; совпадает с `node_key` батча PUT order. */
  nodeKey: string;
  level: number;
  counters: number[];
  repeatOf: string | null;
  cycleCut: boolean;
  children: PublicationContentNode[];
}

/** Текст раздела до рендера: мысль и ребро-источник. */
interface SectionText {
  thoughtId: string;
  edgeId: string;
}

/** Собранная (ещё не отрендеренная) структура документа. */
interface BuiltDocument {
  /** Отобранные мысли (результат рецепта), в порядке движка. */
  selectedIds: string[];
  tree: PublicationContentNode[];
  /** id показанных мыслей-разделов (содержательные + повторные). */
  shownIds: Set<string>;
  /** id содержательных разделов (не повторов). */
  contentIds: Set<string>;
  /** id мыслей-текстов, попавших в документ. */
  textIds: Set<string>;
  /** Кандидаты: отбор минус принятый срез минус исключения (временная семантика). */
  candidateIds: string[];
  /** Тексты по каждому содержательному разделу. */
  textsBySection: Map<string, SectionText[]>;
  excluded: PublicationAssemblyExcluded[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Модель экспорта документа (задача 6d87f1f2, операция 1f161c74)
// ---------------------------------------------------------------------------

/** Титульный блок экспортного документа (резолвленное авторство). */
export interface PublicationExportTitle {
  title: string;
  subtitle: string | null;
  /** Авторство; пусто — подставлен создатель (`creator`). */
  authorship: string | null;
  /** Создатель публикации (резолвленное отображаемое имя) — фолбэк авторства. */
  creator: string;
  assembly_date: string | null;
  /** Резюме — исходный markdown без заголовков (валидация это гарантирует). */
  summary_md: string;
  cover: PublicationAssemblyCover;
}

/** Текст раздела в экспортной модели: markdown-источник и HTML. */
export interface PublicationExportText {
  thought_id: string;
  anchor: string;
  body_md: string;
  body_html: string;
}

/** Узел дерева разделов в экспортной модели (markdown + HTML одной сборкой). */
export interface PublicationExportSection {
  thought_id: string;
  anchor: string;
  level: number;
  heading: string;
  preamble_md: string;
  preamble_html: string;
  texts: PublicationExportText[];
  extra: PublicationAssemblyExtraGroup[];
  flags: PublicationSectionFlags;
  children: PublicationExportSection[];
}

/** Готовая модель документа для экспорта в Markdown/HTML. */
export interface PublicationExportDocument {
  publication_id: string;
  title: PublicationExportTitle;
  sections: PublicationExportSection[];
  /** Плоский список заголовков в порядке документа — для оглавления. */
  headings: PublicationHeading[];
  warnings: string[];
  /** Резолвер wiki-ссылок той же сборки (используется markdown-экспортом). */
  resolveLink: (ref: WikiLinkRef) => WikiLinkResolution | undefined;
}

/** Накопитель экспортной модели во время общего рендера секций. */
interface ExportSink {
  sections: Map<PublicationContentNode, PublicationExportSection>;
  headings: PublicationHeading[];
}

// ---------------------------------------------------------------------------
// Чтение примитивов (в контексте слоя соединения)
// ---------------------------------------------------------------------------

/** Устойчиво разобрать JSON-массив строк. */
function parseStringArray(text: string | null): string[] {
  if (text === null || text === '') return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Прочитать реестровое свойство по id в контексте слоя. */
function getPropertyRow(ndb: NetworkDb, id: string): PropertyRow | null {
  const row = ndb
    .prepare('SELECT id, name, value_type, config FROM properties_v WHERE id = ? LIMIT 1')
    .get(id) as { id: string; name: string; value_type: string; config: string | null } | undefined;
  if (row === undefined) return null;
  let config: PropertyConfig | null = null;
  if (row.config !== null && row.config !== '') {
    try {
      const parsed = JSON.parse(row.config) as unknown;
      if (parsed !== null && typeof parsed === 'object') config = parsed as PropertyConfig;
    } catch {
      config = null;
    }
  }
  return { id: row.id, name: row.name, value_type: row.value_type, config };
}

/**
 * Входящие нетипизированные рёбра (структурные родители) мысли.
 *
 * **Почему локальный SQL, а не `traverse` из graph-traversal.** Восходящему
 * поиску «ближайшего отобранного предка» нужны три вещи, которых обходчик не
 * отдаёт: (1) `links.position` каждого ребра — именно им детерминируется обход
 * ([[#599414b6]]); (2) `edge_id` ребра — это ключ локального порядка публикации
 * (`node_key`, [[#18f3bebf]]); (3) отсутствие `maxDepth`/`maxNodes` —
 * требование «глубина дерева без лимита». `traverse` возвращает только id
 * узлов и ограничен потолком — на роли транспорта поддерева он и рассчитан.
 * Гарантия этой выборки: рёбра отдаются в сетевом порядке `position ASC, id ASC`
 * и несут свой `edge_id` — вызывающий строит на них детерминированный обход.
 * Фильтры активности и корзины совпадают с обходчиком (`active=1`,
 * `marked_for_deletion=0`).
 */
function untypedParents(ndb: NetworkDb, thoughtId: string): StructuralEdge[] {
  return (
    ndb
      .prepare(
        `SELECT l.id AS edge_id, l.source_id AS other_id, l.position AS position
           FROM links_v l
          WHERE l.target_id = ? AND l.type_id IS NULL
            AND l.active = 1 AND l.marked_for_deletion = 0
          ORDER BY l.position ASC, l.id ASC`,
      )
      .all(thoughtId) as Array<{ edge_id: string; other_id: string; position: number }>
  ).map((r) => ({ edgeId: r.edge_id, otherId: r.other_id, position: r.position }));
}

/**
 * Рёбра свойства-связи, направленные от владельца к цели.
 *
 * **Почему не `getLinkPropertyValues` (property-service.ts).** Та функция почти
 * совпадает по SELECT, но сортирует ТИПИЗИРОВАННЫЕ рёбра `created_at DESC`,
 * тогда как требование текстов [[#620aa285]] задаёт порядок «сетевой порядок
 * рёбер (`links.position`), перекрытый локальным порядком публикации (по
 * `edge_id`)». Кроме того, вызывающему нужны `edge_id` и `position` каждой
 * цели — для локального порядка и детерминированной сортировки; DTO
 * `getLinkPropertyValues` отдаёт лишь `link_id`/цель/комментарий без
 * `position`. Поэтому чтение локальное, но с ПЕРЕИСПОЛЬЗОВАНИЕМ резолва
 * направления и типа связи (`resolveOwnerBindingSide` /
 * `linkPropertySideFromConfig` / `linkPropertyDirection` /
 * `linkPropertyLinkTypeId`) — логика интерпретации свойства здесь не
 * дублируется. Гарантия: `links.position ASC, l.id ASC`, обе формы владения
 * (типизированная и структурная), фильтры `active=1`, `marked_for_deletion=0`.
 */
function readPropertyEdges(ndb: NetworkDb, ownerId: string, prop: PropertyRow): PropertyEdge[] {
  const structural = isStructuralLinkProperty(prop.config);
  const side = structural
    ? null
    : resolveOwnerBindingSide(ndb, ownerId, prop.id) ??
      linkPropertySideFromConfig('link', prop.config);
  const direction = structural
    ? prop.config?.direction === 'in'
      ? 'in'
      : 'out'
    : linkPropertyDirection(prop.config, side);
  const linkTypeId = linkPropertyLinkTypeId(prop.config);

  const ownerCol = direction === 'out' ? 'l.source_id' : 'l.target_id';
  const targetJoin =
    direction === 'out'
      ? 'JOIN thoughts_v t ON t.id = l.target_id'
      : 'JOIN thoughts_v t ON t.id = l.source_id';
  const typeClause = linkTypeId === null ? 'l.type_id IS NULL' : 'l.type_id = ?';
  const params: unknown[] = linkTypeId === null ? [ownerId] : [ownerId, linkTypeId];

  return (
    ndb
      .prepare(
        `SELECT l.id AS edge_id, t.id AS thought_id, t.title AS title, t.type_id AS type_id,
                l.position AS position
           FROM links_v l ${targetJoin}
          WHERE ${ownerCol} = ? AND ${typeClause} AND l.active = 1 AND l.marked_for_deletion = 0
          ORDER BY l.position ASC, l.id ASC`,
      )
      .all(...params) as Array<{
      edge_id: string;
      thought_id: string;
      title: string | null;
      type_id: string | null;
      position: number;
    }>
  ).map((r) => ({
    edge_id: r.edge_id,
    thought_id: r.thought_id,
    title: r.title ?? '',
    type_id: r.type_id,
    position: r.position,
  }));
}

/** Размер порции для `IN (…)`: не упираться в лимит переменных SQLite. */
const SQL_PARAM_CHUNK = 400;

/** Разбить список id на порции для `IN (…)`. */
function chunkIds(ids: readonly string[]): string[][] {
  if (ids.length <= SQL_PARAM_CHUNK) return [ids as string[]];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += SQL_PARAM_CHUNK) {
    out.push(ids.slice(i, i + SQL_PARAM_CHUNK));
  }
  return out;
}

/** Заголовки и типы мыслей (порциями, чтобы держать деревья в тысячи узлов). */
function loadThoughtMeta(
  ndb: NetworkDb,
  ids: readonly string[],
): Map<string, { title: string; type_id: string | null }> {
  const out = new Map<string, { title: string; type_id: string | null }>();
  for (const chunk of chunkIds(ids)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = ndb
      .prepare(`SELECT id, title, type_id FROM thoughts_v WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; title: string | null; type_id: string | null }>;
    for (const r of rows) out.set(r.id, { title: r.title ?? '', type_id: r.type_id });
  }
  return out;
}

/** Постоянные комментарии мыслей (`body_md`), порциями по id. */
function loadPermanentComments(ndb: NetworkDb, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of chunkIds(ids)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = ndb
      .prepare(
        `SELECT owner_id, body_md FROM comments_v
          WHERE owner_type = 'thought' AND kind = 'permanent' AND owner_id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ owner_id: string; body_md: string }>;
    for (const r of rows) out.set(r.owner_id, r.body_md);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Построение дерева разделов ([[#599414b6]])
// ---------------------------------------------------------------------------

/**
 * Построить дерево разделов из отобранных мыслей:
 *   * ближайший отобранный предок (сквозь неотобранные узлы) даёт привязку;
 *   * нет отобранных предков → корень;
 *   * несколько родителей → первое достижение, повторные места — `repeat_of`
 *     (якорь первого вхождения), заход в текущую ветку — `cycle_cut`.
 *
 * Обход итеративный: глубина дерева не ограничена.
 */
export function buildSectionTree(
  ndb: NetworkDb,
  selectedIds: readonly string[],
  localOrder: Map<string, number>,
): { tree: PublicationContentNode[]; shownIds: Set<string> } {
  const selected = new Set(selectedIds);
  const parentsCache = new Map<string, StructuralEdge[]>();
  const parentsOf = (id: string): StructuralEdge[] => {
    let value = parentsCache.get(id);
    if (value === undefined) {
      value = untypedParents(ndb, id);
      parentsCache.set(id, value);
    }
    return value;
  };

  // Ближайшие отобранные предки (BFS вверх сквозь неотобранные узлы).
  const attachCache = new Map<string, Attachment[]>();
  const nearestAncestors = (id: string): Attachment[] => {
    const cached = attachCache.get(id);
    if (cached !== undefined) return cached;
    const out: Attachment[] = [];
    const seen = new Set<string>();
    const queue: Array<{ node: string; position: number }> = parentsOf(id).map((e) => ({
      node: e.otherId,
      position: e.position,
    }));
    for (let i = 0; i < queue.length; i += 1) {
      const cur = queue[i]!;
      if (selected.has(cur.node)) {
        if (!out.some((a) => a.parentId === cur.node)) {
          out.push({ parentId: cur.node, branchPosition: cur.position });
        }
        continue;
      }
      if (seen.has(cur.node)) continue;
      seen.add(cur.node);
      for (const e of parentsOf(cur.node)) queue.push({ node: e.otherId, position: e.position });
    }
    attachCache.set(id, out);
    return out;
  };

  const placementKeyOf = (id: string): string => parentsOf(id)[0]?.edgeId ?? id;
  const localOf = (key: string): number | null => localOrder.get(key) ?? null;

  const childrenMap = new Map<
    string,
    Array<{ childId: string; orderKey: number; tie: string }>
  >();
  const roots: string[] = [];
  const rootOrder = new Map<string, number>();
  const selectionIndex = new Map<string, number>();
  // Порядок корней: локальный порядок по id мысли; иначе — минимальная позиция
  // входящего ребра; у корня без родителей ребра нет — берём порядок рецепта.
  // Ничья разрешается порядком отбора (детерминированно).
  for (const [index, id] of selectedIds.entries()) {
    const ancestors = nearestAncestors(id);
    if (ancestors.length === 0) {
      const minParent = parentsOf(id).reduce(
        (min, e) => Math.min(min, e.position),
        Number.POSITIVE_INFINITY,
      );
      roots.push(id);
      rootOrder.set(id, localOf(id) ?? (minParent === Number.POSITIVE_INFINITY ? index : minParent));
      selectionIndex.set(id, index);
      continue;
    }
    selectionIndex.set(id, index);
    const placementKey = placementKeyOf(id);
    for (const a of ancestors) {
      const bucket = childrenMap.get(a.parentId) ?? [];
      bucket.push({
        childId: id,
        orderKey: localOf(placementKey) ?? a.branchPosition,
        tie: placementKey,
      });
      childrenMap.set(a.parentId, bucket);
    }
  }
  const orderedRoots = [...roots].sort((a, b) => {
    const ka = rootOrder.get(a) ?? Number.POSITIVE_INFINITY;
    const kb = rootOrder.get(b) ?? Number.POSITIVE_INFINITY;
    return (
      ka - kb ||
      (selectionIndex.get(a) ?? 0) - (selectionIndex.get(b) ?? 0) ||
      (a < b ? -1 : a > b ? 1 : 0)
    );
  });

  const orderedChildren = (id: string): string[] => {
    const bucket = childrenMap.get(id);
    if (bucket === undefined) return [];
    bucket.sort(
      (a, b) =>
        a.orderKey - b.orderKey ||
        (selectionIndex.get(a.childId) ?? 0) - (selectionIndex.get(b.childId) ?? 0) ||
        (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0),
    );
    return bucket.map((b) => b.childId);
  };

  // Итеративный DFS с отслеживанием ветки (кольца) и множеством показанных.
  type Action =
    | { type: 'enter'; id: string; parent: RawNode | null }
    | { type: 'exit'; id: string };
  const emitted = new Set<string>();
  const inPath = new Set<string>();
  const rootNodes: RawNode[] = [];
  const stack: Action[] = [];
  for (let i = orderedRoots.length - 1; i >= 0; i -= 1) {
    stack.push({ type: 'enter', id: orderedRoots[i]!, parent: null });
  }
  while (stack.length > 0) {
    const action = stack.pop()!;
    if (action.type === 'exit') {
      inPath.delete(action.id);
      continue;
    }
    const { id, parent } = action;
    if (emitted.has(id)) {
      const repeat: RawNode = {
        thoughtId: id,
        nodeKey: parent === null ? id : placementKeyOf(id),
        repeat: true,
        cycleCut: inPath.has(id),
        children: [],
      };
      if (parent === null) rootNodes.push(repeat);
      else parent.children.push(repeat);
      continue;
    }
    emitted.add(id);
    const node: RawNode = {
      thoughtId: id,
      nodeKey: parent === null ? id : placementKeyOf(id),
      repeat: false,
      cycleCut: false,
      children: [],
    };
    if (parent === null) rootNodes.push(node);
    else parent.children.push(node);
    inPath.add(id);
    stack.push({ type: 'exit', id });
    const kids = orderedChildren(id);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ type: 'enter', id: kids[i]!, parent: node });
    }
  }

  // Уровни и сквозные счётчики нумерации (повторы номер не получают).
  const tree: PublicationContentNode[] = [];
  type LevelAction = {
    raw: RawNode;
    level: number;
    counters: number[];
    parent: PublicationContentNode | null;
  };
  const levelStack: LevelAction[] = [];
  const initial: LevelAction[] = [];
  let rootIndex = 1;
  for (const raw of rootNodes) {
    const counters = raw.repeat ? [] : [rootIndex];
    if (!raw.repeat) rootIndex += 1;
    initial.push({ raw, level: 1, counters, parent: null });
  }
  for (let i = initial.length - 1; i >= 0; i -= 1) levelStack.push(initial[i]!);
  while (levelStack.length > 0) {
    const { raw, level, counters, parent } = levelStack.pop()!;
    const node: PublicationContentNode = {
      thoughtId: raw.thoughtId,
      nodeKey: raw.nodeKey,
      level,
      counters,
      repeatOf: raw.repeat ? publicationAnchor(raw.thoughtId) : null,
      cycleCut: raw.cycleCut,
      children: [],
    };
    if (parent === null) tree.push(node);
    else parent.children.push(node);
    const childEntries: LevelAction[] = [];
    let index = 1;
    for (const child of raw.children) {
      const childCounters = child.repeat ? [] : [...counters, index];
      if (!child.repeat) index += 1;
      childEntries.push({ raw: child, level: level + 1, counters: childCounters, parent: node });
    }
    for (let i = childEntries.length - 1; i >= 0; i -= 1) levelStack.push(childEntries[i]!);
  }

  return { tree, shownIds: emitted };
}

/** Плоский список узлов дерева (pre-order). */
function flattenTree(tree: readonly PublicationContentNode[]): PublicationContentNode[] {
  const out: PublicationContentNode[] = [];
  const stack: PublicationContentNode[] = [...tree].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Подготовка структуры документа
// ---------------------------------------------------------------------------

/** Исключения публикации с названиями (для пометок редактора). */
function loadExcluded(
  ndb: NetworkDb,
  publicationId: string,
): { set: Set<string>; list: PublicationAssemblyExcluded[] } {
  const exclusions = listPublicationExclusions(ndb, publicationId);
  const set = new Set(exclusions.map((e) => e.thought_id));
  const list: PublicationAssemblyExcluded[] = [];
  if (exclusions.length > 0) {
    const meta = loadThoughtMeta(ndb, exclusions.map((e) => e.thought_id));
    for (const e of exclusions) {
      const m = meta.get(e.thought_id);
      if (m !== undefined) list.push({ thought_id: e.thought_id, title: m.title });
    }
  }
  return { set, list };
}

/**
 * Собрать структуру документа без рендера: отбор, дерево, тексты по разделам,
 * исключения, кандидаты, предупреждения. Общая база для сборки, кандидатов и
 * использования.
 */
function buildDocument(
  ndb: NetworkDb,
  pub: Publication,
  userId: string,
  includeExcluded: boolean,
  warnings: string[],
): BuiltDocument {
  const excluded = loadExcluded(ndb, pub.id);
  const selectedIds =
    pub.title_recipe === null ? [] : selectRecipeIds(ndb, userId, pub.title_recipe, warnings);
  const structSelected = includeExcluded
    ? selectedIds
    : selectedIds.filter((id) => !excluded.set.has(id));

  const localOrder = new Map(
    listPublicationOrder(ndb, pub.id).map((item) => [item.node_key, item.position] as const),
  );
  const { tree, shownIds } = buildSectionTree(ndb, structSelected, localOrder);

  const contentNodes = flattenTree(tree).filter((n) => n.repeatOf === null);
  const contentIds = new Set(contentNodes.map((n) => n.thoughtId));

  const propertyCache = new Map<string, PropertyRow | null>();
  const propertyRow = (id: string): PropertyRow | null => {
    let row = propertyCache.get(id);
    if (row === undefined) {
      row = getPropertyRow(ndb, id);
      propertyCache.set(id, row);
    }
    return row;
  };

  const textsBySection = new Map<string, SectionText[]>();
  const textIds = new Set<string>();
  for (const section of contentNodes) {
    const texts: SectionText[] = [];
    for (const propId of pub.text_sources) {
      const prop = propertyRow(propId);
      if (prop === null) {
        warnings.push(`свойство текстов ${propId} не найдено`);
        continue;
      }
      if (prop.value_type !== 'link') {
        warnings.push(`свойство текстов «${prop.name}» не является свойством-связью`);
        continue;
      }
      const edges = readPropertyEdges(ndb, section.thoughtId, prop);
      edges.sort(
        (a, b) =>
          (localOrder.get(a.edge_id) ?? a.position) - (localOrder.get(b.edge_id) ?? b.position) ||
          (a.edge_id < b.edge_id ? -1 : a.edge_id > b.edge_id ? 1 : 0),
      );
      for (const edge of edges) {
        if (contentIds.has(edge.thought_id)) continue; // роль раздела приоритетна
        if (!includeExcluded && excluded.set.has(edge.thought_id)) continue;
        texts.push({ thoughtId: edge.thought_id, edgeId: edge.edge_id });
        textIds.add(edge.thought_id);
      }
    }
    textsBySection.set(section.thoughtId, texts);
  }

  // Временная семантика (задача e754527d): кандидат — отобранная мысль, которой
  // нет в принятом срезе. `NULL`-срез (импорт/legacy) — кандидатов нет: считаем
  // принятым всё текущее состояние. `shownIds` в отборе кандидатов больше не
  // участвует: живые отобранные разделы все попадают в дерево, но «новыми» от
  // этого быть не перестают.
  const acceptedIds = getPublicationAcceptedIds(ndb, pub.id);
  const accepted = acceptedIds === null ? null : new Set(acceptedIds);
  const candidateIds =
    accepted === null
      ? []
      : selectedIds.filter((id) => !accepted.has(id) && !excluded.set.has(id));

  return {
    selectedIds,
    tree,
    shownIds,
    contentIds,
    textIds,
    candidateIds,
    textsBySection,
    excluded: excluded.list,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Рендер документа
// ---------------------------------------------------------------------------

/** Резолвер wiki-ссылок сборки: якорь внутри документа, иначе — название. */
function makeLinkResolver(
  ndb: NetworkDb,
  docAnchors: Map<string, string>,
): (ref: WikiLinkRef) => WikiLinkResolution | undefined {
  const titleCache = new Map<string, string | null>();
  const titleOf = (id: string): string | null => {
    let title = titleCache.get(id);
    if (title === undefined) {
      title = resolveThoughts(ndb, [id])[0]?.title ?? null;
      titleCache.set(id, title);
    }
    return title;
  };
  return (ref) => {
    if (ref.kind === 'pub') {
      if (ref.id === null) return { kind: 'missing' };
      const resolved = resolvePublicationRefs(ndb, [ref.id])[0];
      if (resolved === undefined) return { kind: 'missing' };
      return { kind: 'text', text: ref.alias ?? resolved.title };
    }
    if (ref.kind === 'id') {
      if (ref.id === null) return { kind: 'missing' };
      const anchor = docAnchors.get(ref.id);
      const title = titleOf(ref.id);
      if (anchor !== undefined) return { kind: 'anchor', anchor, text: ref.alias ?? title ?? '' };
      if (title !== null) return { kind: 'text', text: ref.alias ?? title };
      return { kind: 'missing' };
    }
    // Обезличенные (name) и кросс-сетевые ссылки — как в экспорте подграфа:
    // решение не даём, рендерер подставит алиас/название.
    return undefined;
  };
}

/** Провайдер якорей внутренних заголовков блока (`pub-<shortid>-<n>`). */
function headingAnchorFor(
  thoughtId: string,
): (ctx: { index: number; decapitated: boolean }) => string | undefined {
  const base = publicationAnchor(thoughtId);
  return (ctx) => (ctx.decapitated ? undefined : `${base}-${ctx.index + 1}`);
}

/** «Доп. материалы» раздела: имена свойств и названия целей. */
function extraGroupsFor(
  ndb: NetworkDb,
  pub: Publication,
  thoughtId: string,
): PublicationAssemblyExtraGroup[] {
  const groups: PublicationAssemblyExtraGroup[] = [];
  for (const propId of pub.extra_properties) {
    const prop = getPropertyRow(ndb, propId);
    if (prop === null || prop.value_type !== 'link') continue;
    const edges = readPropertyEdges(ndb, thoughtId, prop);
    if (edges.length === 0) continue;
    groups.push({
      property: prop.name,
      targets: edges.map((e) => ({ id: e.thought_id, title: e.title })),
    });
  }
  return groups;
}

/** Контекст рендера раздела (общий для всего документа). */
interface RenderContext {
  pub: Publication;
  comments: Map<string, string>;
  titles: Map<string, { title: string }>;
  textsBySection: Map<string, SectionText[]>;
  resolver: (ref: WikiLinkRef) => WikiLinkResolution | undefined;
  /** Кеш «доп. материалов» по мысли (раздел рендерится один раз, но защищаемся). */
  extraCache: Map<string, PublicationAssemblyExtraGroup[]>;
  /** Накопитель экспортной модели; отсутствует при обычной сборке страницы. */
  exportSink?: ExportSink;
}

/**
 * Отрендерить один раздел БЕЗ поддерева (shallow). `children` заполняет
 * {@link renderSections} после обхода — итеративно, чтобы не упираться в стек
 * на легальном дереве большой глубины (требование «глубина без лимита»).
 */
function renderSection(
  ndb: NetworkDb,
  node: PublicationContentNode,
  ctx: RenderContext,
): PublicationAssemblySection {
  const title = ctx.titles.get(node.thoughtId)?.title ?? '';
  const headingNumber = node.level + 1;
  const number =
    node.repeatOf === null
      ? formatSectionNumber(node.counters, { from: ctx.pub.numbering_from, to: ctx.pub.numbering_to })
      : null;
  const heading = number !== null ? `${number}. ${title}` : title;

  const preambleSource = ctx.comments.get(node.thoughtId) ?? '';
  const preambleResult =
    preambleSource.trim() === ''
      ? { html: '', headings: [] as PublicationHeading[] }
      : renderPublicationFragment(preambleSource, {
          baseLevel: headingNumber,
          headingAnchor: headingAnchorFor(node.thoughtId),
          resolveLink: ctx.resolver,
        });

  const sectionTexts = node.repeatOf === null ? (ctx.textsBySection.get(node.thoughtId) ?? []) : [];
  const textRenders = sectionTexts.map((t) => {
    const body = ctx.comments.get(t.thoughtId) ?? '';
    const result =
      body.trim() === ''
        ? { html: '', headings: [] as PublicationHeading[] }
        : renderPublicationFragment(body, {
            baseLevel: headingNumber,
            headingAnchor: headingAnchorFor(t.thoughtId),
            resolveLink: ctx.resolver,
          });
    return { text: t, body, result };
  });

  const texts: PublicationAssemblyText[] = textRenders.map(({ text, result }) => ({
    thought_id: text.thoughtId,
    anchor: publicationAnchor(text.thoughtId),
    edge_id: text.edgeId,
    body_html: result.html,
  }));

  let extra = ctx.extraCache.get(node.thoughtId);
  if (extra === undefined) {
    extra = node.repeatOf === null ? extraGroupsFor(ndb, ctx.pub, node.thoughtId) : [];
    ctx.extraCache.set(node.thoughtId, extra);
  }

  const dto: PublicationAssemblySection = {
    thought_id: node.thoughtId,
    node_key: node.nodeKey,
    anchor: publicationAnchor(node.thoughtId),
    level: node.level,
    heading,
    preamble_html: preambleResult.html,
    texts,
    extra: node.repeatOf === null ? extra : [],
    flags: { repeat_of: node.repeatOf, cycle_cut: node.cycleCut },
    children: [],
  };

  if (ctx.exportSink !== undefined) {
    // Оглавление собирается в порядке документа: заголовок раздела, затем
    // заголовки предисловия и текстов (дети добавляются обходом следом).
    ctx.exportSink.headings.push({
      level: headingNumber,
      text: heading,
      anchor: dto.anchor,
      decapitated: false,
    });
    ctx.exportSink.headings.push(...preambleResult.headings);
    for (const { result } of textRenders) ctx.exportSink.headings.push(...result.headings);
    ctx.exportSink.sections.set(node, {
      thought_id: node.thoughtId,
      anchor: dto.anchor,
      level: node.level,
      heading,
      preamble_md: preambleSource,
      preamble_html: preambleResult.html,
      texts: textRenders.map(({ text, body, result }) => ({
        thought_id: text.thoughtId,
        anchor: publicationAnchor(text.thoughtId),
        body_md: body,
        body_html: result.html,
      })),
      extra: dto.extra,
      flags: dto.flags,
      children: [],
    });
  }

  return dto;
}

/**
 * Собрать DTO страницы раздела: shallow-рендер всех узлов поддерева итеративным
 * обходом, затем связывание детей ссылками. Рекурсии нет — глубина не
 * ограничена (блокер независимой проверки: `Maximum call stack size exceeded`
 * на цепочке ≳2000).
 */
function renderSections(
  ndb: NetworkDb,
  roots: readonly PublicationContentNode[],
  ctx: RenderContext,
): PublicationAssemblySection[] {
  const byNode = new Map<PublicationContentNode, PublicationAssemblySection>();
  const stack: PublicationContentNode[] = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (byNode.has(node)) continue;
    byNode.set(node, renderSection(ndb, node, ctx));
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
  }
  for (const [node, dto] of byNode) {
    dto.children = node.children.map((child) => byNode.get(child)!);
  }
  return roots.map((root) => byNode.get(root)!);
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/** Публикация по id в контексте слоя или `NOT_FOUND`. */
function getPublicationOrThrow(ndb: NetworkDb, id: string): Publication {
  const pub = getPublication(ndb, id);
  if (pub === null) {
    throw new EtnError('NOT_FOUND', `publication ${id} not found`, { entity: 'publication', id });
  }
  return pub;
}

/**
 * Собрать страницу документа (`GET /publications/{id}/assembly`). Пагинация —
 * по разделам верхнего уровня; нумерация и якоря считаются по всему дереву,
 * поэтому стабильны между страницами.
 */
/** Обложка титула по настройкам публикации (общая для сборки и экспорта). */
function coverFor(pub: Publication): PublicationAssemblyCover {
  return pub.cover_kind === 'attachment'
    ? { kind: 'attachment', ref: pub.cover_attachment_id }
    : pub.cover_kind === 'url'
      ? { kind: 'url', ref: pub.cover_url }
      : { kind: 'placeholder', ref: null };
}

/**
 * Общая подготовка документа: структура, якоря блоков, резолвер ссылок и
 * контекст рендера. Используется сборкой страницы и экспортом — обе стороны
 * видят одно дерево, одни якоря и одну резолюцию ссылок ([[#888453b6]]).
 */
function prepareDocument(
  ndb: NetworkDb,
  pub: Publication,
  userId: string,
  includeExcluded: boolean,
  warnings: string[],
  exportSink?: ExportSink,
): { doc: BuiltDocument; ctx: RenderContext } {
  const doc = buildDocument(ndb, pub, userId, includeExcluded, warnings);

  // Якоря всех блоков документа (разделы + тексты): ссылка на мысль внутри
  // публикации становится якорем даже с другой страницы ([[#888453b6]]).
  const docAnchors = new Map<string, string>();
  for (const node of flattenTree(doc.tree)) {
    docAnchors.set(node.thoughtId, publicationAnchor(node.thoughtId));
  }
  for (const textId of doc.textIds) docAnchors.set(textId, publicationAnchor(textId));

  const blockIds = new Set<string>([
    ...flattenTree(doc.tree).map((n) => n.thoughtId),
    ...doc.textIds,
  ]);
  const resolver = makeLinkResolver(ndb, docAnchors);
  const ctx: RenderContext = {
    pub,
    comments: loadPermanentComments(ndb, [...blockIds]),
    titles: loadThoughtMeta(ndb, [...blockIds]),
    textsBySection: doc.textsBySection,
    resolver,
    extraCache: new Map(),
    ...(exportSink === undefined ? {} : { exportSink }),
  };
  return { doc, ctx };
}

/**
 * Собрать страницу документа (`GET /publications/{id}/assembly`). Пагинация —
 * по разделам верхнего уровня; нумерация и якоря считаются по всему дереву,
 * поэтому стабильны между страницами.
 */
export function assemblePublication(
  ndb: NetworkDb,
  publicationId: string,
  userId: string,
  query: { page?: number; include_excluded?: boolean } = {},
): PublicationAssembly {
  const pub = getPublicationOrThrow(ndb, publicationId);
  const includeExcluded = query.include_excluded === true;
  const warnings: string[] = [];
  const { doc, ctx } = prepareDocument(ndb, pub, userId, includeExcluded, warnings);

  const perPage = PUBLICATION_ASSEMBLY_PAGE_SIZE;
  const totalRoots = doc.tree.length;
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const start = (page - 1) * perPage;
  const pageRoots = doc.tree.slice(start, start + perPage);
  const sections = renderSections(ndb, pageRoots, ctx);

  const summary = pub.summary_md ?? '';
  const summaryHtml =
    summary.trim() === ''
      ? ''
      : renderPublicationFragment(summary, { resolveLink: ctx.resolver }).html;

  return {
    publication: {
      title: pub.title,
      subtitle: pub.subtitle,
      authorship: pub.authorship,
      assembly_date: pub.assembly_date,
      summary_html: summaryHtml,
      cover: coverFor(pub),
      new_candidates: doc.candidateIds.length,
    },
    sections,
    excluded: doc.excluded,
    warnings,
    meta: {
      page,
      per_page: perPage,
      total_roots: totalRoots,
      has_more: start + pageRoots.length < totalRoots,
    },
  };
}

/**
 * Собрать полную модель документа для экспорта (задача 6d87f1f2, операция
 * 1f161c74): все разделы без пагинации, markdown-источники и HTML-фрагменты
 * одной сборкой, плоское оглавление и резолвер ссылок. Той же сборкой, что
 * `/assembly` (требование «превью и файл не расходятся»), в контексте слоя
 * соединения; исключённые не попадают.
 *
 * @param resolveUserName отображаемое имя пользователя (для авторства-фолбэка
 *   «пусто → создатель»); домен не знает системной БД.
 */
export function buildPublicationExportDocument(
  ndb: NetworkDb,
  publicationId: string,
  userId: string,
  resolveUserName: (userId: string) => string | null,
): PublicationExportDocument {
  const pub = getPublicationOrThrow(ndb, publicationId);
  const warnings: string[] = [];
  const sink: ExportSink = { sections: new Map(), headings: [] };
  const { doc, ctx } = prepareDocument(ndb, pub, userId, false, warnings, sink);
  renderSections(ndb, doc.tree, ctx); // заполняет sink по всему дереву

  const byNode = new Map<PublicationContentNode, PublicationExportSection>();
  for (const node of flattenTree(doc.tree)) {
    const section = sink.sections.get(node);
    if (section !== undefined) byNode.set(node, section);
  }
  for (const node of flattenTree(doc.tree)) {
    const section = byNode.get(node);
    if (section === undefined) continue;
    section.children = node.children
      .map((child) => byNode.get(child))
      .filter((c): c is PublicationExportSection => c !== undefined);
  }
  const sections = doc.tree
    .map((root) => byNode.get(root))
    .filter((s): s is PublicationExportSection => s !== undefined);

  const creator = resolveUserName(pub.created_by) ?? pub.created_by;
  const authorship = pub.authorship !== null && pub.authorship.trim() !== '' ? pub.authorship : creator;

  return {
    publication_id: pub.id,
    title: {
      title: pub.title,
      subtitle: pub.subtitle,
      authorship,
      creator,
      assembly_date: pub.assembly_date,
      summary_md: pub.summary_md ?? '',
      cover: coverFor(pub),
    },
    sections,
    headings: sink.headings,
    warnings,
    resolveLink: ctx.resolver,
  };
}

/**
 * Новые кандидаты публикации (`GET /publications/{id}/candidates`): отбор минус
 * принятый срез минус исключения (временная семантика, задача e754527d), с
 * лимитом и пагинацией (усечение — не ошибка).
 */
export function listPublicationCandidates(
  ndb: NetworkDb,
  publicationId: string,
  userId: string,
  query: {
    limit?: number;
    offset?: number;
    include_excluded?: boolean;
    /** Кеш членства с дебаунсом (ленивый фасад); без него — прямой расчёт. */
    cache?: PublicationMembershipCache;
  } = {},
): PublicationCandidatesResult {
  const pub = getPublicationOrThrow(ndb, publicationId);
  const includeExcluded = query.include_excluded === true;
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? PUBLICATION_CANDIDATES_DEFAULT_LIMIT), 0),
    PUBLICATION_CANDIDATES_MAX_LIMIT,
  );
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const compute = (): PublicationCandidatesResult => {
    const warnings: string[] = [];
    const doc = buildDocument(ndb, pub, userId, includeExcluded, warnings);
    const ids = doc.candidateIds;
    const pageIds = ids.slice(offset, offset + limit);
    const meta = loadThoughtMeta(ndb, pageIds);
    // «Путь в дереве после вставки» (элемент интерфейса 43ec961f): заголовки
    // разделов от корня до кандидата. Кандидат живёт в дереве живой сборки;
    // недостижимый (кольцо) пути не имеет — пустой список.
    const pathByCandidate = new Map<string, string[]>();
    const pathIds = new Set<string>();
    for (const id of pageIds) {
      const path = findSectionPath(doc.tree, id) ?? [];
      pathByCandidate.set(id, path);
      for (const pid of path) pathIds.add(pid);
    }
    const pathMeta = pathIds.size > 0 ? loadThoughtMeta(ndb, [...pathIds]) : meta;
    const items: PublicationCandidate[] = pageIds.map((id) => ({
      thought_id: id,
      title: meta.get(id)?.title ?? '',
      type_id: meta.get(id)?.type_id ?? null,
      breadcrumbs: (pathByCandidate.get(id) ?? []).map((pid) => pathMeta.get(pid)?.title ?? ''),
    }));
    return {
      items,
      total: ids.length,
      limit,
      offset,
      has_more: offset + items.length < ids.length,
    };
  };
  return query.cache === undefined
    ? compute()
    : query.cache.getCandidates(
        candidatesCacheKey(publicationId, ndb.layerId, includeExcluded, limit, offset),
        compute,
      );
}

/**
 * «Расставить» кандидата (задача e754527d; элемент интерфейса 43ec961f):
 * погасить его индивидуально — добавить id в принятый срез (другие кандидаты
 * остаются) и зафиксировать позицию в конец локального порядка.
 *
 * Узел локального порядка — id ребра первого вхождения (родительского ребра)
 * либо id мысли для корня: та же адресация, что у сборки (`placementKeyOf` в
 * `buildSectionTree`) и у `PUT …/order`. Срез `NULL` (импорт) инициализируется
 * текущим отбором, чтобы «расставить» не превращал остальные узлы в кандидатов.
 * Операция идемпотентна: повторный вызов для уже расставленного узла позицию не
 * двигает (`appendPublicationOrderItem` — no-op, если ключ есть в порядке).
 */
export function acceptPublicationCandidate(
  ndb: NetworkDb,
  publicationId: string,
  thoughtId: string,
  actorUserId: string,
): PublicationOrderItem[] {
  return ndb.transaction(() => {
    const pub = getPublicationOrThrow(ndb, publicationId);
    const visible = ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ? LIMIT 1').get(thoughtId);
    if (visible === undefined) {
      throw new EtnError('NOT_FOUND', `Мысль ${thoughtId} не найдена.`, {
        entity: 'thought',
        id: thoughtId,
      });
    }

    const current = getPublicationAcceptedIds(ndb, publicationId);
    const accepted = new Set<string>(current ?? []);
    if (current === null && pub.title_recipe !== null) {
      const warnings: string[] = [];
      for (const id of selectRecipeIds(ndb, actorUserId, pub.title_recipe, warnings)) {
        accepted.add(id);
      }
    }
    accepted.add(thoughtId);
    setPublicationAcceptedIds(ndb, publicationId, [...accepted]);

    const nodeKey = untypedParents(ndb, thoughtId)[0]?.edgeId ?? thoughtId;
    return appendPublicationOrderItem(ndb, publicationId, nodeKey, actorUserId);
  });
}

/** Прочитать прямые значения свойств типа «Публикация» у мысли. */
function directPublicationUsages(ndb: NetworkDb, thoughtId: string): PublicationUsageItem[] {
  const rows = ndb
    .prepare(
      `SELECT pv.value_text AS value_text, p.name AS property_name
         FROM property_values_v pv
         JOIN properties_v p ON p.id = pv.property_id
        WHERE pv.owner_type = 'thought' AND pv.owner_id = ? AND p.value_type = 'publication'`,
    )
    .all(thoughtId) as Array<{ value_text: string | null; property_name: string }>;
  const ids: string[] = [];
  const propByPub = new Map<string, string>();
  for (const row of rows) {
    if (row.value_text === null) continue;
    const values = parseStringArray(row.value_text);
    const list = values.length > 0 ? values : [row.value_text];
    for (const pubId of list) {
      const key = pubId.toLowerCase();
      if (!propByPub.has(key)) {
        propByPub.set(key, row.property_name);
        ids.push(key);
      }
    }
  }
  return resolvePublicationRefs(ndb, ids).map((ref) => ({
    publication_id: ref.id,
    title: ref.title,
    role: 'direct' as const,
    property: propByPub.get(ref.id.toLowerCase()),
  }));
}

/** Путь (id разделов от корня) до содержательного узла или `null`. */
function findSectionPath(
  tree: readonly PublicationContentNode[],
  thoughtId: string,
): string[] | null {
  type Frame = { node: PublicationContentNode; path: string[] };
  const stack: Frame[] = [...tree].reverse().map((node) => ({ node, path: [node.thoughtId] }));
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node.thoughtId === thoughtId && node.repeatOf === null) return path;
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i]!;
      stack.push({ node: child, path: [...path, child.thoughtId] });
    }
  }
  return null;
}

/**
 * Номер страницы сборки (1-based) для корневого раздела: рабочая область
 * постранично грузит корневые разделы по {@link PUBLICATION_ASSEMBLY_PAGE_SIZE}
 * (0.11.1, задача 3275fd8d). Не найден (нет в дереве/повтор) — первая
 * страница.
 */
function rootPageOf(tree: readonly PublicationContentNode[], rootThoughtId: string): number {
  const index = tree.findIndex((node) => node.thoughtId === rootThoughtId && node.repeatOf === null);
  if (index < 0) return 1;
  return Math.floor(index / PUBLICATION_ASSEMBLY_PAGE_SIZE) + 1;
}

/**
 * Использование мысли в публикациях слоя (`GET /thoughts/{id}/publications`):
 * роли «раздел» (хлебные крошки имён разделов) и «текст» по рецептам, плюс
 * прямые значения свойств типа «Публикация». Ленивый расчёт с лимитом публикаций.
 */
export function listPublicationUsage(
  ndb: NetworkDb,
  thoughtId: string,
  userId: string,
  query: {
    limit?: number;
    offset?: number;
    publication_limit?: number;
    /** Кеш членства с дебаунсом (ленивый фасад); без него — прямой расчёт. */
    cache?: PublicationMembershipCache;
  } = {},
): PublicationUsageResult {
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? PUBLICATION_USAGE_DEFAULT_LIMIT), 0),
    PUBLICATION_USAGE_MAX_LIMIT,
  );
  const pubLimit = Math.max(
    Math.trunc(query.publication_limit ?? PUBLICATION_USAGE_MAX_PUBLICATIONS),
    0,
  );
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const compute = (): PublicationUsageResult => {
    const items: PublicationUsageItem[] = directPublicationUsages(ndb, thoughtId);

    const listQuery: PublicationListQuery = { active: 'true', limit: pubLimit, offset: 0 };
    const publications = listPublications(ndb, listQuery);
    const scanTruncated = publications.total > publications.items.length;

    for (const pub of publications.items) {
      const warnings: string[] = [];
      const doc = buildDocument(ndb, pub, userId, false, warnings);

      const path = findSectionPath(doc.tree, thoughtId);
      if (path !== null) {
        const titles = loadThoughtMeta(ndb, path);
        items.push({
          publication_id: pub.id,
          title: pub.title,
          role: 'section',
          breadcrumbs: path.map((id) => titles.get(id)?.title ?? ''),
          // Цель перехода: якорь первого вхождения и страница его корневого
          // раздела (0.11.1, задача 3275fd8d, элемент интерфейса 928fb3fc).
          anchor: publicationAnchor(thoughtId),
          page: rootPageOf(doc.tree, path[0]!),
        });
        continue;
      }
      for (const [sectionId, texts] of doc.textsBySection) {
        if (texts.some((t) => t.thoughtId === thoughtId)) {
          const titles = loadThoughtMeta(ndb, [sectionId]);
          // Страница — по содержащему разделу (его первое вхождение).
          const sectionPath = findSectionPath(doc.tree, sectionId);
          items.push({
            publication_id: pub.id,
            title: pub.title,
            role: 'text',
            section_title: titles.get(sectionId)?.title ?? '',
            section_thought_id: sectionId,
            anchor: publicationAnchor(thoughtId),
            page: sectionPath === null ? 1 : rootPageOf(doc.tree, sectionPath[0]!),
          });
          break;
        }
      }
    }

    const page = items.slice(offset, offset + limit);
    return {
      items: page,
      total: items.length,
      limit,
      offset,
      has_more: scanTruncated || offset + page.length < items.length,
    };
  };
  return query.cache === undefined
    ? compute()
    : query.cache.getUsage(
        usageCacheKey(thoughtId, ndb.layerId, limit, offset, pubLimit),
        compute,
      );
}

// ---------------------------------------------------------------------------
// Кеш членства с дебаунсом (ADR 7adf7778)
// ---------------------------------------------------------------------------

// Кеш вынесен в отдельный модуль (его импортирует и CRUD публикаций ради
// инвалидации на мутации — так разорван цикл доменов). Здесь — реэкспорт,
// чтобы фасады/тесты по-прежнему брали его из сборки.
import {
  candidatesCacheKey,
  usageCacheKey,
  type PublicationMembershipCache,
} from './publication-membership-cache.js';

export {
  candidatesCacheKey,
  publicationMembershipCache,
  PUBLICATION_MEMBERSHIP_DEBOUNCE_MS,
  PublicationMembershipCache,
  resetPublicationMembershipCache,
  usageCacheKey,
} from './publication-membership-cache.js';
