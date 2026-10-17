/**
 * Фасад тяжёлых чтений: «через пул reader-воркеров или синхронно» (ADR
 * bec191e6, тех.проект e29c0f00 этап 2, требование 8e2fda79).
 *
 * Здесь проходит ГРАНИЦА чтение/запись и граница «тяжёлого чтения»:
 *
 *   * в пул уходят выборки, которые могут исполняться долго и потому заморозить
 *     цикл событий сервера, — единый движок отбора `queryThoughts`/
 *     `queryThoughtIds` (он же исполняет BFS-обход поддерева, `walkSubtree`),
 *     полнотекстовый `search`, обход подграфа/`traverse`, батчи `resolve` и
 *     `find_duplicates`, `neighbors`/`countNeighbors` и чтения комментариев
 *     (задача 514dc30f, ошибка 49e05ea0);
 *   * в главном потоке остаются по-настоящему точечные чтения (карточка по id,
 *     мета) и всё, где корректность важнее латентности, — например захват
 *     блокировок `object_locks`, исполняемый в тех же соединениях записи.
 *
 * Деградация безопасна и осознанна: если процессный пул не настроен (CLI,
 * юнит-тесты), БД в памяти (`:memory:` — её нельзя открыть вторым соединением)
 * или соединение уже закрыто — операция исполняется синхронно тем же кодом.
 * Результат обязан совпадать: это DoD этапа.
 *
 * Смена слоя доезжает до воркеров автоматически: контекст берётся из
 * `ndb.layerId` того соединения, которым фасад уже пользуется для записи и
 * точечных чтений (сессионный слой), а воркер перестраивает temp-цепочку слоя
 * на каждой задаче. Версия схемы (`PRAGMA schema_version`) переоткрывает
 * соединение воркера, если схема успела измениться.
 */

import { type SearchRequest } from '@etn/shared';

import type {
  ReaderResolvePayload,
  ReaderSubgraphResult,
  ReaderTask,
  ReaderTaskContext,
  ReaderThoughtsQueryResult,
  ReaderThoughtsQueryIdsResult,
} from '../contracts.js';
import type { NetworkDb } from '../db/network-db.js';
import { getReaderPool, type ReaderPool } from '../db/reader-pool.js';
import {
  queryThoughts,
  queryThoughtIds,
  type AstTokenContext,
  type ThoughtIdsQueryResult,
  type ThoughtQueryOptions,
  type ThoughtQueryRequest,
  type ThoughtQueryResult,
} from './query-service.js';
import { findDuplicates, search } from './search-service.js';
import {
  traverse,
  subgraph,
  type TraversalBounds,
  type TraverseDirection,
} from './graph-traversal.js';
import {
  countNeighbors,
  getNeighbors,
  getThoughtsByIdsResolved,
  resolveThoughts,
  type NeighborOptions,
} from './thought-service.js';
import {
  getCommentsPreview,
  getPermanentComment,
  getVisibleComment,
  listComments,
} from './comment-service.js';
import { createBodyExpander, createBodyPresenter } from './transclusion-service.js';
import type { TokenIssue } from './thought-type-view-tokens.js';
import type {
  Comment,
  CommentOwnerType,
  CommentsPreview,
  DuplicateHit,
  FocusDir,
  FocusNeighbor,
  ResolveResult,
  SearchResponse,
  SubgraphEdge,
  ThoughtRef,
} from '@etn/shared';

/**
 * Контекст воркера из соединения главного потока, либо `null`, если операцию
 * нельзя унести в пул (`:memory:` или закрытое соединение).
 */
function contextFor(ndb: NetworkDb, pool: ReaderPool | null): ReaderTaskContext | null {
  if (pool === null || ndb.isClosed || ndb.dbPath === ':memory:') return null;
  const rows = ndb.pragma('schema_version') as Array<{ schema_version: number }>;
  return {
    dbPath: ndb.dbPath,
    networkId: ndb.networkId,
    layerId: ndb.layerId,
    schemaVersion: rows[0]?.schema_version ?? 0,
  };
}

/** Плоский результат `thoughts.query` → канонический (`depths` — снова Map). */
function toThoughtQueryResult(flat: ReaderThoughtsQueryResult): ThoughtQueryResult {
  return {
    items: flat.items,
    total: flat.total,
    has_more: flat.has_more,
    next_cursor: flat.next_cursor,
    directions: flat.directions,
    depths: flat.depths === null ? null : new Map(flat.depths.map((e) => [e.id, e.depth])),
    truncated: flat.truncated,
    reason: flat.reason,
    ...(flat.unresolved !== undefined ? { unresolved: flat.unresolved as TokenIssue[] } : {}),
    ...(flat.stats !== undefined ? { stats: flat.stats } : {}),
  };
}

/**
 * Выборка мыслей: в пуле, когда он есть; иначе — синхронно тем же движком.
 * Контракт идентичен {@link queryThoughts}, отличие — асинхронность.
 */
export async function queryThoughtsAsync(
  ndb: NetworkDb,
  userId: string,
  request: ThoughtQueryRequest,
  options: ThoughtQueryOptions = {},
): Promise<ThoughtQueryResult> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    return queryThoughts(ndb, userId, request, options);
  }
  const task: ReaderTask = {
    context,
    op: 'thoughts.query',
    payload: { userId, request, options },
  };
  const flat = (await pool.run(task)) as ReaderThoughtsQueryResult;
  return toThoughtQueryResult(flat);
}

/** Id-only вариант выборки (см. {@link queryThoughtIds}) через пул. */
export async function queryThoughtIdsAsync(
  ndb: NetworkDb,
  userId: string,
  request: ThoughtQueryRequest,
  options: ThoughtQueryOptions = {},
): Promise<ThoughtIdsQueryResult> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    return queryThoughtIds(ndb, userId, request, options);
  }
  const task: ReaderTask = {
    context,
    op: 'thoughts.queryIds',
    payload: { userId, request, options },
  };
  const flat = (await pool.run(task)) as ReaderThoughtsQueryIdsResult;
  return {
    ids: flat.ids,
    total: flat.total,
    has_more: flat.has_more,
    next_cursor: flat.next_cursor,
    ...(flat.unresolved !== undefined ? { unresolved: flat.unresolved as TokenIssue[] } : {}),
    ...(flat.stats !== undefined ? { stats: flat.stats } : {}),
  };
}

/** Полнотекстовый поиск (см. {@link search}) через пул. */
export async function searchAsync(
  ndb: NetworkDb,
  request: SearchRequest,
  showInactiveDefault = false,
  tokenContext?: AstTokenContext,
): Promise<SearchResponse> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    return search(ndb, request, showInactiveDefault, tokenContext);
  }
  const task: ReaderTask = {
    context,
    op: 'search.query',
    // `AstTokenContext` сериализуем (плоские числа/строки) — переживает
    // structured clone до reader-воркера, поэтому разрешение календарных
    // токенов одинаково в обоих режимах (задача 56a143ff).
    payload: { request, showInactiveDefault, ...(tokenContext !== undefined ? { tokenContext } : {}) },
  };
  return (await pool.run(task)) as SearchResponse;
}

/**
 * Радиус-ограниченный подграф вокруг семян (см. {@link subgraph}) через пул.
 * Обход BFS по рёбрам — тяжёлое чтение, поэтому тоже уходит в reader-воркер.
 */
export async function subgraphAsync(
  ndb: NetworkDb,
  seedIds: string[],
  radius: number,
  bounds: TraversalBounds = {},
): Promise<{ nodes: string[]; edges: SubgraphEdge[]; truncated: boolean }> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    return subgraph(ndb, seedIds, radius, bounds);
  }
  const task: ReaderTask = { context, op: 'graph.subgraph', payload: { seedIds, radius, bounds } };
  return (await pool.run(task)) as ReaderSubgraphResult;
}

/**
 * Точечный `resolve` лёгких ссылок (`POST /thoughts/resolve`, см.
 * {@link resolveThoughts}) через пул. Батч до {@link THOUGHT_RESOLVE_MAX_IDS}
 * id: каждый короткий id резолвится отдельным lookup, поэтому на большой сети
 * вызов заметно занимает event loop (ошибка 49e05ea0).
 */
export async function resolveThoughtRefsAsync(
  ndb: NetworkDb,
  ids: string[],
): Promise<ThoughtRef[]> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) return resolveThoughts(ndb, ids);
  const task: ReaderTask = {
    context,
    op: 'thoughts.resolve',
    payload: { ids } satisfies ReaderResolvePayload,
  };
  return (await pool.run(task)) as ThoughtRef[];
}

/** Карточный батч `etn.thoughts.resolve` (см. {@link getThoughtsByIdsResolved}) через пул. */
export async function resolveThoughtCardsAsync(
  ndb: NetworkDb,
  ids: string[],
): Promise<ResolveResult> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) return getThoughtsByIdsResolved(ndb, ids);
  const task: ReaderTask = {
    context,
    op: 'thoughts.resolveCards',
    payload: { ids } satisfies ReaderResolvePayload,
  };
  return (await pool.run(task)) as ResolveResult;
}

/**
 * Страница соседей + честный `total` одним заданием пула (см. {@link getNeighbors}
 * и {@link countNeighbors}). `limit`/`offset` — только для страницы; `total`
 * считается тем же WHERE без них, поэтому REST и MCP видят одинаковые числа.
 */
export async function neighborsWithTotalAsync(
  ndb: NetworkDb,
  thoughtId: string,
  dir: FocusDir,
  opts: NeighborOptions = {},
  page: { limit?: number; offset?: number } = {},
): Promise<{ neighbors: FocusNeighbor[]; total: number }> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    return {
      neighbors: getNeighbors(ndb, thoughtId, dir, { ...opts, ...page }),
      total: countNeighbors(ndb, thoughtId, dir, opts),
    };
  }
  const task: ReaderTask = {
    context,
    op: 'thoughts.neighbors',
    payload: { thoughtId, dir, opts, ...page },
  };
  return (await pool.run(task)) as { neighbors: FocusNeighbor[]; total: number };
}

/** Ограниченный BFS-обход (см. {@link traverse}) через пул. */
export async function traverseAsync(
  ndb: NetworkDb,
  seedIds: string[],
  direction: TraverseDirection,
  bounds: TraversalBounds = {},
): Promise<{ ids: string[]; truncated: boolean; reason?: 'max_depth' | 'max_nodes' }> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) return traverse(ndb, seedIds, direction, bounds);
  const task: ReaderTask = {
    context,
    op: 'graph.traverse',
    payload: { seedIds, direction, bounds },
  };
  return (await pool.run(task)) as { ids: string[]; truncated: boolean; reason?: 'max_depth' | 'max_nodes' };
}

/** Кандидаты дублей (см. {@link findDuplicates}) через пул. */
export async function findDuplicatesAsync(
  ndb: NetworkDb,
  title: string,
  synonyms: string[] = [],
  typeIds: string[] = [],
): Promise<DuplicateHit[]> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) return findDuplicates(ndb, title, synonyms, typeIds);
  const task: ReaderTask = {
    context,
    op: 'thoughts.findDuplicates',
    payload: { title, synonyms, typeIds },
  };
  return (await pool.run(task)) as DuplicateHit[];
}

/** Комментарии владельца (см. {@link listComments}) через пул. */
export async function listCommentsAsync(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
): Promise<Comment[]> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) return listComments(ndb, ownerType, ownerId);
  const task: ReaderTask = {
    context,
    op: 'comments.list',
    payload: { ownerType, ownerId },
  };
  return (await pool.run(task)) as Comment[];
}

/** Видимая редакция комментария по id (см. {@link getVisibleComment}) через пул. */
export async function getVisibleCommentAsync(
  ndb: NetworkDb,
  commentId: string,
): Promise<Comment | null> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) return getVisibleComment(ndb, commentId);
  const task: ReaderTask = {
    context,
    op: 'comments.visible',
    payload: { commentId },
  };
  return (await pool.run(task)) as Comment | null;
}

/**
 * Видимый комментарий по id с развёрнутыми трансклюзиями — ровно та форма,
 * которую отдаёт MCP `etn.comments.get` (см. {@link createBodyPresenter}).
 * Разворот делает воркер: он тоже читает источники из БД.
 */
export async function getPresentedCommentAsync(
  ndb: NetworkDb,
  commentId: string,
): Promise<Comment | null> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    const comment = getVisibleComment(ndb, commentId);
    if (comment === null) return null;
    return { ...comment, ...createBodyPresenter(ndb)(comment.body_md) };
  }
  const task: ReaderTask = {
    context,
    op: 'comments.presented',
    payload: { commentId },
  };
  return (await pool.run(task)) as Comment | null;
}

/** Постоянный комментарий владельца в presented-форме (MCP `etn.comments.get`). */
export async function getPermanentPresentedAsync(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
): Promise<Comment | null> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    const comment = getPermanentComment(ndb, ownerType, ownerId);
    if (comment === null) return null;
    return { ...comment, ...createBodyPresenter(ndb)(comment.body_md) };
  }
  const task: ReaderTask = {
    context,
    op: 'comments.permanentPresented',
    payload: { ownerType, ownerId },
  };
  return (await pool.run(task)) as Comment | null;
}

/**
 * Превью комментариев для набора владельцев (MCP `subgraph` c
 * `include_comments`). Один воркер-обход на всю пачку: expander трансклюзий
 * создаётся там же и переиспользует кэш источников между владельцами.
 */
export async function commentsPreviewBatchAsync(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerIds: string[],
  previewChars: { permanent?: number; chronological?: number } = {},
  expandTransclusions = true,
): Promise<CommentsPreview[]> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    const expand = expandTransclusions ? createBodyExpander(ndb) : undefined;
    return ownerIds.map((ownerId) =>
      getCommentsPreview(ndb, ownerType, ownerId, previewChars, expand),
    );
  }
  const task: ReaderTask = {
    context,
    op: 'comments.previewBatch',
    payload: { ownerType, ownerIds, previewChars, expandTransclusions },
  };
  return (await pool.run(task)) as CommentsPreview[];
}
