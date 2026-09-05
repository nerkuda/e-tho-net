/**
 * Structured thought query (task N1, docs/05-mcp-server.md §4.1).
 *
 * A criteria-based list of thoughts — the MCP counterpart of full-text search
 * for cases where there is no text to search: «все мысли типа X в поддереве
 * Y», «мысли со свойством статус = активный», «ошибки, изменённые за
 * неделю». Filters combine with AND; unlike {@link search} there is no
 * mandatory FTS query.
 *
 * The subtree restriction walks **directed** links downwards (source →
 * target, active links only) with a visited-set BFS — the same semantics as
 * `traverse(…, 'children')`, but the depth of every visited node is kept so
 * hits can report their distance from the root. The walk honours
 * `max_nodes_per_subgraph`; anything beyond the bound is simply not in the
 * candidate set (reported as `truncated`).
 *
 * Property conditions address values by the **registry property** (0.6.5):
 *   * the condition carries the registry `property_id`, not the
 *     (type, key) pair — one id addresses the property on every thought
 *     type that has attached it;
 *   * the storage column (`value_text` / `value_date` / `value_number` /
 *     `value_bool` / `value_thought_ref`) is selected from the property's
 *     `value_type`, never from the runtime type of the supplied value —
 *     `eq "согласовано"` on a `text` property hits `value_text`, the same
 *     payload on a `date` property would hit `value_date` and likely match
 *     nothing;
 *   * `eq` on `thought_ref` also matches ids inside the JSON arrays of
 *     `multiple` thought_ref values (02-data-model.md §3.5), same as the
 *     structures filter.
 * An unknown `property_id` simply matches nothing for that condition — the
 * registry row may have been deleted after the filter was saved.
 */

import {
  EtnError,
  TRAVERSAL_DEFAULTS,
  buildLikePattern,
  parseFilterKeywords,
  type PropertyQueryCondition,
  type PropertyQueryOperator,
  type PropertyValueType,
  type ThoughtQueryActive,
  type ThoughtQueryHit,
  type ThoughtQueryRequest,
  type ThoughtQueryResponse,
  type ThoughtQuerySort,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';

/**
 * Title/synonym match clause of one keyword — the same shape as
 * `structure-service`'s KEYWORD_MATCH (03-server-api.md §6.10): the LIKE
 * pattern is built by {@link buildLikePattern} against the normalised
 * columns, so the match is case-insensitive and infix.
 */
const KEYWORD_MATCH =
  "(t.title_norm LIKE ? ESCAPE '\\' OR EXISTS (" +
  'SELECT 1 FROM thought_synonyms_v ts' +
  " WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'))";

/** Limits applied by the caller (MCP runtime limits, task F6). */
export interface QueryBounds {
  /** Hard cap on nodes collected by the subtree walk. */
  maxNodes: number;
}

/** Result of the downward subtree walk. */
interface WalkResult {
  /** thought id → depth from the seed (0 = the seed itself). */
  depths: Map<string, number> | null;
  truncated: boolean;
  reason: 'max_nodes' | null;
}

/** Clamp limit/offset to the same window as the search service. */
function clampPaging(limit: number | undefined, offset: number | undefined): {
  limit: number;
  offset: number;
} {
  return {
    limit: Math.min(Math.max(limit ?? 50, 1), 200),
    offset: Math.max(offset ?? 0, 0),
  };
}

/**
 * Walk the directed subtree of `seedId` (source → target edges, active only)
 * breadth-first, keeping each node's depth. `null` when no seed is given
 * (meaning «no subtree restriction»).
 */
function walkSubtree(ndb: NetworkDb, seedId: string | undefined, opts: {
  maxDepth: number;
  maxNodes: number;
}): WalkResult {
  if (seedId === undefined) {
    return { depths: null, truncated: false, reason: null };
  }
  const { maxDepth, maxNodes } = opts;
  const visited = new Set<string>();
  const depths = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];
  let truncated = false;
  let reason: WalkResult['reason'] = null;

  const childrenOf = ndb.prepare(
    'SELECT target_id AS nid FROM links_v WHERE source_id = ? AND active = 1',
  );

  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (visited.has(id)) continue;
    if (depths.size >= maxNodes) {
      truncated = true;
      reason = 'max_nodes';
      break;
    }
    visited.add(id);
    depths.set(id, depth);
    if (depth >= maxDepth) continue;
    const rows = childrenOf.all(id) as Array<{ nid: string }>;
    for (const { nid } of rows) {
      if (!visited.has(nid)) {
        queue.push({ id: nid, depth: depth + 1 });
      }
    }
  }
  return { depths, truncated, reason };
}

/** Escape `%`/`_` so a keyword cannot widen a LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** LIKE pattern matching a stored id inside a JSON array of ids. */
function refLikePattern(id: string): string {
  return `%"${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`;
}

/** A WHERE clause fragment plus its bind parameters, in order. */
interface Clause {
  sql: string;
  params: unknown[];
}

/** `(col IN (?, …))` or `null` when the list is empty. */
function inListClause(column: string, ids: string[] | null): Clause | null {
  if (!ids || ids.length === 0) return null;
  const placeholders = ids.map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: [...ids] };
}

/** `(col IN (?, …))` over a collected subtree, or `null` without restriction. */
function subtreeClause(column: string, depths: Map<string, number> | null): Clause | null {
  if (depths === null) return null;
  if (depths.size === 0) return { sql: '0', params: [] }; // guaranteed-false
  const ids = [...depths.keys()];
  const placeholders = ids.map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: ids };
}

/**
 * Join clause fragments into `c1 AND c2 AND …`. When no clause applies (e.g.
 * `active: "any"` with no other filter) fall back to `1=1` so the caller
 * never builds a dangling `WHERE ` with nothing after it.
 */
function joinClauses(clauses: Array<Clause | null>): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const c of clauses) {
    if (!c) continue;
    parts.push(c.sql);
    params.push(...c.params);
  }
  return { where: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
}

/** Keyword filter — the §6.10 mini-syntax (03-server-api.md), shared with the
 * structures filter: whitespace-separated words, all required (AND), `*`
 * infix wildcard, `-слово` exclusion. Every word matches the title or a
 * synonym, case-insensitive; `title_norm`/`synonym_norm` are stored
 * lowercase, so the word is folded the same way (NFC at write time).
 *
 * Bug 0.5.4: the previous `keywordsClause` searched the whole input as one
 * literal substring — `*`/`-слово`/multi-word AND never worked here, while
 * the shared {@link parseFilterKeywords}/{@link buildLikePattern} pair already
 * powers the structures filter and the attachments search. An input of only
 * exclusions is a valid «everything except» filter (same as
 * `structure-service`, §6.10 clarification).
 */
function keywordsClauses(keywords: string | undefined): Clause[] {
  if (keywords === undefined || keywords.trim() === '') return [];
  const { include, exclude } = parseFilterKeywords(keywords);
  const clauses: Clause[] = [];
  for (const word of include) {
    const pattern = buildLikePattern(word.toLowerCase());
    clauses.push({ sql: KEYWORD_MATCH, params: [pattern, pattern] });
  }
  for (const word of exclude) {
    const pattern = buildLikePattern(word.toLowerCase());
    clauses.push({ sql: `NOT ${KEYWORD_MATCH}`, params: [pattern, pattern] });
  }
  return clauses;
}

/** Date-range clause for a column holding ISO-8601 timestamps. */
function dateRangeClause(
  column: 'created_at' | 'updated_at',
  after: string | undefined,
  before: string | undefined,
): Clause | null {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (after !== undefined) {
    parts.push(`t.${column} >= ?`);
    params.push(after);
  }
  if (before !== undefined) {
    parts.push(`t.${column} <= ?`);
    params.push(before);
  }
  if (parts.length === 0) return null;
  return { sql: parts.join(' AND '), params };
}

/** SQL comparison for each supported operator (no string interpolation of user input). */
const SQL_OPS: Record<Exclude<PropertyQueryOperator, 'contains'>, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** Storage column of `property_values` per registry property `value_type` —
 *  the same mapping as `structure-service.VALUE_COLUMN` (§6.10). */
const VALUE_COLUMN: Record<PropertyValueType, string> = {
  text: 'value_text',
  url: 'value_text',
  date: 'value_date',
  number: 'value_number',
  bool: 'value_bool',
  thought_ref: 'value_thought_ref',
};

/** SQL operator per `value_type` × `PropertyQueryOperator` (the query subset of
 *  `structure-service.OPS_BY_VALUE_TYPE` — `in`/`not_in`/`is_empty`/`not_empty`
 *  belong only to the structures filter). `null` means the operator is not
 *  meaningful for the value type. */
const SUPPORTED_OPS: Record<PropertyValueType, ReadonlySet<PropertyQueryOperator>> = {
  text: new Set(['eq', 'ne', 'contains']),
  url: new Set(['eq', 'ne', 'contains']),
  date: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
  number: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
  bool: new Set(['eq', 'ne']),
  thought_ref: new Set(['eq', 'ne']),
};

/** Minimal registry row read in one batched lookup of all conditions. */
interface RegistryPropertyRow {
  id: string;
  name: string;
  value_type: string;
}

/**
 * Build one property-condition clause for a batch of conditions.
 *
 * All addressed registry properties are read in one `SELECT … IN (…)` call —
 * a missing property (deleted after the filter was saved) skips the
 * condition. The storage column is fixed by the property's `value_type`; the
 * supplied value's runtime type is only used to coerce it to the right SQL
 * scalar form.
 */
function propertyClauses(
  ndb: NetworkDb,
  conds: PropertyQueryCondition[],
  requestId?: string,
): Clause[] {
  if (conds.length === 0) return [];
  // One batched registry read (N conditions → 1 query).
  const ids = [...new Set(conds.map((c) => c.property_id))];
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(
      `SELECT id, name, value_type FROM properties_v WHERE id IN (${placeholders})`,
    )
    .all(...ids) as RegistryPropertyRow[];
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  const out: Clause[] = [];
  for (const cond of conds) {
    const def = byId.get(cond.property_id);
    // Unknown property_id — drop the condition (matches nothing), same
    // semantics as `structure-service` (the saved filter survives the
    // registry row deletion).
    if (def === undefined) continue;
    const valueType = def.value_type as PropertyValueType;
    const allowed = SUPPORTED_OPS[valueType];
    if (!allowed.has(cond.operator)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Операция ${cond.operator} недопустима для свойства типа ${valueType}.`,
        { field: 'operator', allowed: [...allowed] },
        requestId,
      );
    }
    const column = VALUE_COLUMN[valueType];
    const refMultiple = valueType === 'thought_ref';

    if (cond.operator === 'contains') {
      // Only `text`/`url` allow `contains` per SUPPORTED_OPS — `value_text`
      // holds them both.
      const pattern = `%${escapeLike(String(cond.value))}%`;
      out.push({
        sql: `EXISTS (
          SELECT 1 FROM property_values_v pv
          WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
            AND pv.${column} LIKE ? ESCAPE '\\')`,
        params: [def.id, pattern],
      });
      continue;
    }

    const cmp = SQL_OPS[cond.operator];
    const scalar = coerceScalar(valueType, cond.value, requestId);

    if (refMultiple && cond.operator === 'eq') {
      // thought_ref single id + ids inside the JSON arrays of multiple
      // thought_ref values (§3.5).
      out.push({
        sql: `EXISTS (
          SELECT 1 FROM property_values_v pv
          WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
            AND (pv.${column} = ? OR pv.${column} LIKE ? ESCAPE '\\'))`,
        params: [def.id, scalar, refLikePattern(String(scalar))],
      });
      continue;
    }
    if (refMultiple && cond.operator === 'ne') {
      // `ne` only excludes the exact single id; ids inside JSON arrays are
      // matched only by `eq`. A «не равно» semantic over multiple-ref values
      // would require scanning JSON, which we deliberately do not do — the
      // accepted behaviour mirrors the structures filter's `eq` arm.
      out.push({
        sql: `EXISTS (
          SELECT 1 FROM property_values_v pv
          WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
            AND pv.${column} ${cmp} ?)`,
        params: [def.id, scalar],
      });
      continue;
    }
    out.push({
      sql: `EXISTS (
        SELECT 1 FROM property_values_v pv
        WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
          AND pv.${column} ${cmp} ?)`,
      params: [def.id, scalar],
    });
  }
  return out;
}

/** Coerce a wire value to the SQL scalar form its `value_*` column expects. */
function coerceScalar(
  valueType: PropertyValueType,
  value: string | number | boolean,
  requestId?: string,
): string | number {
  switch (valueType) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Значение свойства number должно быть числом.',
          { field: 'value' },
          requestId,
        );
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Значение свойства bool должно быть boolean.',
          { field: 'value' },
          requestId,
        );
      }
      return value ? 1 : 0;
    case 'text':
    case 'url':
    case 'date':
    case 'thought_ref':
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `Значение свойства ${valueType} должно быть строкой.`,
          { field: 'value' },
          requestId,
        );
      }
      return value;
  }
}

/** Whitelisted ORDER BY columns (no string interpolation of user input). */
const SORT_COLUMNS: Record<ThoughtQuerySort, string> = {
  title: 't.title COLLATE NOCASE',
  created_at: 't.created_at',
  updated_at: 't.updated_at',
};

/**
 * Run a structured thought query (docs/05-mcp-server.md §4.1).
 *
 * @param ndb - open network database.
 * @param request - criteria; all filters combine with AND.
 * @param bounds - traversal limits from the caller (MCP limits).
 */
export function queryThoughts(
  ndb: NetworkDb,
  request: ThoughtQueryRequest,
  bounds: QueryBounds,
): ThoughtQueryResponse {
  const paging = clampPaging(request.limit, request.offset);
  const maxDepth = Math.min(
    Math.max(request.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH, 1),
    TRAVERSAL_DEFAULTS.MAX_DEPTH,
  );

  const walk = walkSubtree(ndb, request.in_subtree_of, {
    maxDepth,
    maxNodes: bounds.maxNodes,
  });

  const active: ThoughtQueryActive = request.active ?? 'true';
  const trashed = request.trashed ?? 'false';
  const clauses: Array<Clause | null> = [
    // L21: a selected parent type matches its whole subtree (OR semantics).
    inListClause('t.type_id', expandTypeIdsToSubtree(ndb, 'thought_types', request.type_id ?? [])),
    active === 'true' ? { sql: 't.active = 1', params: [] }
      : active === 'false'
        ? { sql: 't.active = 0', params: [] }
        : null,
    // Пометка на удаление (S13, 05-mcp-server.md §5.1a): default `false` —
    // only unmarked; `any` disables the filter entirely.
    trashed === 'true' ? { sql: 't.marked_for_deletion = 1', params: [] }
      : trashed === 'false'
        ? { sql: 't.marked_for_deletion = 0', params: [] }
        : null,
    ...keywordsClauses(request.keywords),
    dateRangeClause('created_at', request.created_after, request.created_before),
    dateRangeClause('updated_at', request.updated_after, request.updated_before),
    subtreeClause('t.id', walk.depths),
  ];
  if (request.properties !== undefined) {
    for (const c of propertyClauses(ndb, request.properties)) clauses.push(c);
  }
  const { where, params } = joinClauses(clauses);

  const sort = request.sort ?? 'title';
  const direction = request.order === 'desc' ? 'DESC' : 'ASC';
  const orderBy = `${SORT_COLUMNS[sort]} ${direction}`;

  const total = (
    ndb
      .prepare(`SELECT COUNT(*) AS c FROM thoughts_v t WHERE ${where}`)
      .get(...params) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT t.id AS id, t.title AS title, t.type_id AS type_id, t.active AS active
       FROM thoughts_v t WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, paging.limit, paging.offset) as Array<{
    id: string;
    title: string;
    type_id: string | null;
    active: number;
  }>;

  const hits: ThoughtQueryHit[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    type_id: r.type_id,
    active: r.active === 1,
    depth: walk.depths === null ? null : (walk.depths.get(r.id) ?? null),
  }));

  return {
    total,
    hits,
    truncated: walk.truncated,
    reason: walk.reason,
  };
}
