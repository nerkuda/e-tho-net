/**
 * Фасад тяжёлых чтений: «через пул reader-воркеров или синхронно» (ADR
 * bec191e6, тех.проект e29c0f00 этап 2, требование 8e2fda79).
 *
 * Здесь проходит ГРАНИЦА чтение/запись и граница «тяжёлого чтения»:
 *
 *   * в пул уходят выборки, которые могут исполняться долго и потому заморозить
 *     цикл событий сервера, — единый движок отбора `queryThoughts`/
 *     `queryThoughtIds` (он же исполняет BFS-обход поддерева, `walkSubtree`),
 *     полнотекстовый `search` и обход подграфа `subgraph`;
 *   * в главном потоке остаются точечные чтения (карточка, соседи, комментарии,
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

import { type SearchRequest, type SearchResponse } from '@etn/shared';

import type {
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
  type ThoughtQueryOptions,
  type ThoughtQueryRequest,
  type ThoughtQueryResult,
} from './query-service.js';
import { search } from './search-service.js';
import { subgraph, type TraversalBounds } from './graph-traversal.js';
import type { SubgraphEdge } from '@etn/shared';

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
    directions: flat.directions,
    depths: flat.depths === null ? null : new Map(flat.depths.map((e) => [e.id, e.depth])),
    truncated: flat.truncated,
    reason: flat.reason,
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
): Promise<{ ids: string[]; total: number }> {
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
  return (await pool.run(task)) as ReaderThoughtsQueryIdsResult;
}

/** Полнотекстовый поиск (см. {@link search}) через пул. */
export async function searchAsync(
  ndb: NetworkDb,
  request: SearchRequest,
  showInactiveDefault = false,
): Promise<SearchResponse> {
  const pool = getReaderPool();
  const context = contextFor(ndb, pool);
  if (pool === null || context === null) {
    return search(ndb, request, showInactiveDefault);
  }
  const task: ReaderTask = {
    context,
    op: 'search.query',
    payload: { request, showInactiveDefault },
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
