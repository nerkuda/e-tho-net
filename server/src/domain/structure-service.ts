/**
 * «Структуры мыслей» domain service (L15, docs/03-server-api.md §6.10, §6.11, §18).
 *
 *  * `queryThoughts` — filter thoughts by keywords / thought types / property
 *    values / link types and page through the matches;
 *  * `getHierarchy` — one-level parents/children expansion of the result tree,
 *    with per-branch dedup (`exclude_ids`) applied before the node limit;
 *  * saved-filter CRUD — named per-user filter definitions stored in
 *    `saved_filters` (L3, docs/02-data-model.md §3.10.5).
 *
 * The wire format is parsed by the route layer; here the input is already
 * shape-checked except for the property conditions, whose operator/value
 * compatibility depends on the property definition stored in the network DB.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  HIERARCHY_EXCLUDE_MAX_IDS,
  SAVED_FILTER_NAME_MAX,
  STRUCTURES_NODE_NEIGHBORS_LIMIT,
  STRUCTURES_PARENT_SCOPE_MAX_DEPTH,
  STRUCTURES_QUERY_IDS_MAX_LIMIT,
  STRUCTURES_QUERY_MAX_LIMIT,
  STRUCTURE_KEYWORD_SCOPES,
  STRUCTURE_PROPERTY_OPS,
  STRUCTURE_SORTS,
  SORT_ORDERS,
  buildLikePattern,
  parseFilterKeywords,
  type ChronicleFilterDefinition,
  type ChronicleSavedFilter,
  type PropertyValueType,
  type SavedFilter,
  type SavedFilterDefinition,
  type SavedFilterView,
  type SortOrder,
  type StructureFilter,
  type StructureKeywordScope,
  type StructurePropertyCondition,
  type StructurePropertyOp,
  type StructurePropertyValue,
  type StructureQueryRequest,
  type StructureDirectionFlags,
  type StructureSort,
  type ThoughtRef,
  type HierarchyResponse,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getTypeProperty } from './property-service.js';
import { getEdgesAmong, getLinkDirections } from './link-service.js';
import { getThoughtOrThrow, rowToThoughtRef } from './thought-service.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';

/** Display columns every thought-ref SELECT must carry (see `resolveThoughts`). */
export const REF_COLUMNS =
  't.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id,' +
  ' t.active, t.fg_color, t.bg_color,' +
  ' t.font_bold, t.font_italic, t.font_underline, t.font_strike, t.font_manual';

/** Row shape accepted by {@link rowToThoughtRef}. */
type ThoughtRefRow = Parameters<typeof rowToThoughtRef>[0];

/** Operators allowed per property `value_type` (03-server-api.md §6.10). */
const OPS_BY_VALUE_TYPE: Record<PropertyValueType, readonly StructurePropertyOp[]> = {
  text: ['contains', 'eq', 'in', 'not_in'],
  url: ['contains', 'eq', 'in', 'not_in'],
  date: ['eq', 'gt', 'lt'],
  number: ['eq', 'gt', 'lt'],
  bool: ['eq'],
  thought_ref: ['eq', 'in', 'not_in'],
};

/** Storage column of `property_values` per property `value_type`. */
const VALUE_COLUMN: Record<PropertyValueType, string> = {
  text: 'value_text',
  url: 'value_text',
  date: 'value_date',
  number: 'value_number',
  bool: 'value_bool',
  thought_ref: 'value_thought_ref',
};

/** Default keyword scope (03-server-api.md §6.10): title + synonyms only —
 *  the original behaviour before the «комментарий» scope existed. */
const DEFAULT_KEYWORD_SCOPE: readonly StructureKeywordScope[] = ['title', 'synonyms'];

/**
 * Resolves the effective keyword scope: an absent/empty `keyword_scope`
 * falls back to {@link DEFAULT_KEYWORD_SCOPE} (bug fix 0.5.5 — the panel
 * auto-reverts to the same default when the user unchecks all three boxes,
 * this is the server-side mirror of that rule for saved filters / MCP
 * callers that omit the field or send an empty array).
 */
function resolveKeywordScope(scope: StructureKeywordScope[] | undefined): Set<StructureKeywordScope> {
  return new Set(scope !== undefined && scope.length > 0 ? scope : DEFAULT_KEYWORD_SCOPE);
}

/**
 * One keyword match clause built for the effective scope: title and/or
 * synonyms and/or the permanent comment (OR between the selected sources).
 * The LIKE pattern is built by {@link buildLikePattern} (escaping
 * `%`/`_`/`\`, `*` → `%`), so the match is infix; case-insensitivity comes
 * from `title_norm`/`synonym_norm` being stored lower-cased and from the
 * `unicode_lower()` SQL helper for the comment body (SQLite's built-in
 * `LOWER()` is ASCII-only, `network-db.ts`). Returns the parenthesised SQL
 * fragment plus how many `?` placeholders it needs (same pattern value
 * repeated for each selected source).
 */
function buildKeywordClause(scope: Set<StructureKeywordScope>): { sql: string; paramCount: number } {
  const parts: string[] = [];
  if (scope.has('title')) parts.push("t.title_norm LIKE ? ESCAPE '\\'");
  if (scope.has('synonyms')) {
    parts.push(
      'EXISTS (SELECT 1 FROM thought_synonyms_v ts' +
        " WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\')",
    );
  }
  if (scope.has('comment')) {
    parts.push(
      "EXISTS (SELECT 1 FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = t.id" +
        " AND c.kind = 'permanent' AND unicode_lower(c.body_md) LIKE ? ESCAPE '\\')",
    );
  }
  return { sql: `(${parts.join(' OR ')})`, paramCount: parts.length };
}

// ---------------------------------------------------------------------------
// Filter parsing / validation
// ---------------------------------------------------------------------------

/** Read a `StructureFilter` from an untrusted object (request body or saved JSON). */
export function parseStructureFilter(
  body: Record<string, unknown>,
  requestId?: string,
): StructureFilter {
  const filter: StructureFilter = {};

  const keywords = body['keywords'];
  if (keywords !== undefined) {
    if (typeof keywords !== 'string') {
      throw new EtnError('VALIDATION_ERROR', 'keywords должен быть строкой.', {
        field: 'keywords',
      }, requestId);
    }
    if (keywords.trim() !== '') filter.keywords = keywords;
  }

  const keywordScope = body['keyword_scope'];
  if (keywordScope !== undefined) {
    if (
      !Array.isArray(keywordScope) ||
      keywordScope.some(
        (v) => typeof v !== 'string' || !(STRUCTURE_KEYWORD_SCOPES as readonly string[]).includes(v),
      )
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'keyword_scope должен быть массивом из "title"/"synonyms"/"comment".',
        { field: 'keyword_scope', allowed: STRUCTURE_KEYWORD_SCOPES },
        requestId,
      );
    }
    if (keywordScope.length > 0) filter.keyword_scope = [...new Set(keywordScope as StructureKeywordScope[])];
  }

  const parentIds = body['parent_ids'];
  if (parentIds !== undefined) {
    if (!Array.isArray(parentIds) || parentIds.some((v) => typeof v !== 'string')) {
      throw new EtnError('VALIDATION_ERROR', 'parent_ids должен быть массивом строк.', {
        field: 'parent_ids',
      }, requestId);
    }
    if (parentIds.length > 0) filter.parent_ids = parentIds as string[];
  }

  const typeIds = body['type_ids'];
  if (typeIds !== undefined) {
    if (!Array.isArray(typeIds) || typeIds.some((v) => typeof v !== 'string')) {
      throw new EtnError('VALIDATION_ERROR', 'type_ids должен быть массивом строк.', {
        field: 'type_ids',
      }, requestId);
    }
    if (typeIds.length > 0) filter.type_ids = typeIds as string[];
  }

  const linkTypeIds = body['link_type_ids'];
  if (linkTypeIds !== undefined) {
    if (
      !Array.isArray(linkTypeIds) ||
      linkTypeIds.some((v) => typeof v !== 'string')
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'link_type_ids должен быть массивом строк.',
        { field: 'link_type_ids' },
        requestId,
      );
    }
    if (linkTypeIds.length > 0) filter.link_type_ids = linkTypeIds as string[];
  }

  const showInactive = body['show_inactive'];
  if (showInactive !== undefined) {
    if (typeof showInactive !== 'boolean') {
      throw new EtnError('VALIDATION_ERROR', 'show_inactive должен быть boolean.', {
        field: 'show_inactive',
      }, requestId);
    }
    filter.show_inactive = showInactive;
  }

  for (const field of ['has_properties', 'has_comment', 'has_attachments', 'has_chronology', 'active', 'trashed'] as const) {
    const raw = body[field];
    if (raw !== undefined) {
      if (typeof raw !== 'boolean') {
        throw new EtnError('VALIDATION_ERROR', `${field} должен быть boolean.`, { field }, requestId);
      }
      filter[field] = raw;
    }
  }

  const properties = body['properties'];
  if (properties !== undefined) {
    if (!Array.isArray(properties)) {
      throw new EtnError('VALIDATION_ERROR', 'properties должен быть массивом условий.', {
        field: 'properties',
      }, requestId);
    }
    const conditions: StructurePropertyCondition[] = [];
    for (const raw of properties) {
      conditions.push(parsePropertyCondition(raw, requestId));
    }
    if (conditions.length > 0) filter.properties = conditions;
  }

  return filter;
}

/** Parse one `{ property_id, op, value }` condition from an untrusted object. */
function parsePropertyCondition(raw: unknown, requestId?: string): StructurePropertyCondition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EtnError('VALIDATION_ERROR', 'Условие свойства должно быть объектом.', {
      field: 'properties',
    }, requestId);
  }
  const obj = raw as Record<string, unknown>;
  const propertyId = obj['property_id'];
  if (typeof propertyId !== 'string' || propertyId === '') {
    throw new EtnError('VALIDATION_ERROR', 'property_id должен быть непустой строкой.', {
      field: 'property_id',
    }, requestId);
  }
  const op = obj['op'];
  if (typeof op !== 'string' || !(STRUCTURE_PROPERTY_OPS as readonly string[]).includes(op)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимая операция условия свойства.', {
      field: 'op',
      allowed: STRUCTURE_PROPERTY_OPS,
    }, requestId);
  }
  const value = obj['value'];
  const isScalar =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  const isList =
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
  if (!isScalar && !isList) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'value должен быть скаляром (строка/число/логическое) или массивом скаляров.',
      { field: 'value' },
      requestId,
    );
  }
  return { property_id: propertyId, op: op as StructurePropertyOp, value };
}

/** Read a full saved-filter definition (filter + sort/order) from an untrusted object. */
export function parseSavedFilterDefinition(
  body: Record<string, unknown>,
  requestId?: string,
): SavedFilterDefinition {
  const filter = parseStructureFilter(body, requestId);
  const sortRaw = body['sort'];
  if (typeof sortRaw !== 'string' || !(STRUCTURE_SORTS as readonly string[]).includes(sortRaw)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимый sort.', {
      field: 'sort',
      allowed: STRUCTURE_SORTS,
    }, requestId);
  }
  const orderRaw = body['order'];
  if (typeof orderRaw !== 'string' || !(SORT_ORDERS as readonly string[]).includes(orderRaw)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимый order.', {
      field: 'order',
      allowed: SORT_ORDERS,
    }, requestId);
  }
  return { ...filter, sort: sortRaw as StructureSort, order: orderRaw as SortOrder };
}

/** True when the filter carries no criteria at all (empty filter → HOME + orphans). */
export function isFilterEmpty(filter: StructureFilter): boolean {
  return (
    (filter.keywords ?? '').trim() === '' &&
    (filter.parent_ids ?? []).length === 0 &&
    (filter.type_ids ?? []).length === 0 &&
    (filter.link_type_ids ?? []).length === 0 &&
    (filter.properties ?? []).length === 0 &&
    filter.has_properties === undefined &&
    filter.has_comment === undefined &&
    filter.has_attachments === undefined &&
    filter.has_chronology === undefined &&
    filter.active === undefined
  );
}

/** Validate a saved-filter name (trimmed, 1..SAVED_FILTER_NAME_MAX characters). */
function validateFilterName(name: string, requestId?: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new EtnError('VALIDATION_ERROR', 'Имя отбора не может быть пустым.', {
      field: 'name',
    }, requestId);
  }
  if ([...trimmed].length > SAVED_FILTER_NAME_MAX) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Имя отбора должно быть не длиннее ${SAVED_FILTER_NAME_MAX} символов.`,
      { field: 'name', limit: SAVED_FILTER_NAME_MAX },
      requestId,
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Result of {@link queryThoughts}: the page, the unrestricted match count and
 * the link-direction flags of the page (ellipse fill in the tree). */
export interface StructureQueryResult {
  items: ThoughtRef[];
  total: number;
  directions: StructureDirectionFlags;
}

/** Convert a condition scalar to the SQL parameter of its value column. */
function sqlScalar(
  def: { value_type: PropertyValueType },
  value: StructurePropertyValue,
  requestId?: string,
): string | number {
  switch (def.value_type) {
    case 'number':
      if (typeof value !== 'number') {
        throw new EtnError('VALIDATION_ERROR', 'Значение свойства должно быть числом.', {
          field: 'value',
        }, requestId);
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new EtnError('VALIDATION_ERROR', 'Значение свойства должно быть boolean.', {
          field: 'value',
        }, requestId);
      }
      return value ? 1 : 0;
    default:
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', 'Значение свойства должно быть строкой.', {
          field: 'value',
        }, requestId);
      }
      return value;
  }
}

/**
 * Depth-bounded subtree walk from `rootIds` via active `source_id → target_id`
 * links (parent_ids scoping, 03-server-api.md §6.10). The graph may contain
 * cycles (docs/AGENTS.md §7) — the depth cap terminates the walk without a
 * separate visited-set; the final `DISTINCT id` dedups the output.
 */
function expandParentIdsToSubtree(ndb: NetworkDb, rootIds: string[], showInactive: boolean): string[] {
  if (rootIds.length === 0) return [];
  const placeholders = rootIds.map(() => '?').join(',');
  const activeFlag = showInactive ? 1 : 0;
  const rows = ndb
    .prepare(
      `WITH RECURSIVE subtree(id, depth) AS (
         SELECT l.target_id, 1
         FROM links_v l
         WHERE l.source_id IN (${placeholders}) AND (l.active = 1 OR ?)
         UNION
         SELECT l.target_id, s.depth + 1
         FROM links_v l
         JOIN subtree s ON l.source_id = s.id
         WHERE (l.active = 1 OR ?) AND s.depth < ?
       )
       SELECT DISTINCT id FROM subtree`,
    )
    .all(...rootIds, activeFlag, activeFlag, STRUCTURES_PARENT_SCOPE_MAX_DEPTH) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Reads the link-direction flags of the given thoughts as a plain record. */
function directionsOf(ndb: NetworkDb, ids: string[]): StructureDirectionFlags {
  const out: StructureDirectionFlags = {};
  for (const [id, d] of getLinkDirections(ndb, ids)) {
    out[id] = { has_incoming: d.has_in, has_outgoing: d.has_out };
  }
  return out;
}

/**
 * Sort columns of the requested sort plus the per-user `thought_views` join it
 * needs (enum members are validated by the route layer and interpolated as
 * fixed fragments only). Returned without the `ORDER BY` keyword so callers
 * can prepend their own leading keys.
 */
function sortClause(
  userId: string,
  req: StructureQueryRequest,
): { sortSql: string; joinSql: string; joinParams: unknown[] } {
  const dirKeyword = req.order === 'desc' ? 'DESC' : 'ASC';
  const nullsLast = req.order === 'desc' ? 'DESC' : 'ASC';
  switch (req.sort) {
    case 'alpha':
      return { sortSql: `t.title COLLATE NOCASE ${dirKeyword}`, joinSql: '', joinParams: [] };
    case 'created':
      return { sortSql: `t.created_at ${dirKeyword}`, joinSql: '', joinParams: [] };
    case 'viewed':
      return {
        sortSql: `(tv.last_viewed_at IS NULL) ${nullsLast}, tv.last_viewed_at ${dirKeyword}`,
        joinSql: 'LEFT JOIN thought_views tv ON tv.user_id = ? AND tv.thought_id = t.id',
        joinParams: [userId],
      };
  }
}

/**
 * Shared WHERE/ORDER BY of the structures filter (03-server-api.md §6.10):
 * the paged ref query and the id-only query of the bulk commands (L22) must
 * run over exactly the same candidate set. `null` — the filter degenerated to
 * an empty result (unknown `parent_ids` scope roots).
 */
interface FilterQuerySql {
  /** `FROM thoughts_v t … WHERE …` with `?` placeholders (join params first). */
  baseSql: string;
  /** JOIN parameters, bound before the WHERE parameters. */
  joinParams: unknown[];
  /** WHERE parameters. */
  params: unknown[];
  /** ORDER BY columns without the keyword. */
  sortSql: string;
  /** Empty filter pins HOME first with an extra leading sort key. */
  homeFirst: boolean;
}

function buildFilterQuerySql(
  ndb: NetworkDb,
  userId: string,
  req: StructureQueryRequest,
  requestId?: string,
): FilterQuerySql | null {
  if (isFilterEmpty(req)) {
    const showInactive = req.show_inactive === true ? 1 : 0;
    const { sortSql, joinSql, joinParams } = sortClause(userId, req);
    return {
      baseSql: `FROM thoughts_v t ${joinSql}
       WHERE t.is_root = 1 OR (
         t.is_root = 0 AND (t.active = 1 OR ?) AND NOT EXISTS (
           SELECT 1 FROM links_v l WHERE l.target_id = t.id AND l.active = 1))`,
      joinParams,
      params: [showInactive],
      sortSql,
      homeFirst: true,
    };
  }

  const showInactive = req.show_inactive === true ? 1 : 0;
  const where: string[] = [];
  const params: unknown[] = [];

  // «Актуальность» (§15.3 «Дополнительно»): an explicit value overrides the
  // show_inactive default — `false` selects only inactive thoughts.
  if (req.active !== undefined) {
    where.push(req.active ? 't.active = 1' : 't.active = 0');
  } else if (showInactive !== 1) {
    where.push('t.active = 1');
  }

  // Пометка на удаление (S13, 03-server-api.md §6.10): default `false` hides
  // marked thoughts; `true` includes them on equal footing with ordinary ones.
  if (req.trashed !== true) {
    where.push('t.marked_for_deletion = 0');
  }

  if (req.parent_ids !== undefined && req.parent_ids.length > 0) {
    const scoped = expandParentIdsToSubtree(ndb, req.parent_ids, showInactive === 1);
    if (scoped.length === 0) return null;
    where.push(`t.id IN (${scoped.map(() => '?').join(',')})`);
    params.push(...scoped);
  }

  if (req.has_properties !== undefined) {
    const sql = "EXISTS (SELECT 1 FROM property_values_v pv WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id)";
    where.push(req.has_properties ? sql : `NOT ${sql}`);
  }
  if (req.has_comment !== undefined) {
    const sql =
      "EXISTS (SELECT 1 FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = t.id AND c.kind = 'permanent')";
    where.push(req.has_comment ? sql : `NOT ${sql}`);
  }
  if (req.has_attachments !== undefined) {
    const sql = "EXISTS (SELECT 1 FROM attachments_v a WHERE a.owner_type = 'thought' AND a.owner_id = t.id)";
    where.push(req.has_attachments ? sql : `NOT ${sql}`);
  }
  if (req.has_chronology !== undefined) {
    const sql =
      "EXISTS (SELECT 1 FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = t.id AND c.kind = 'chronological')";
    where.push(req.has_chronology ? sql : `NOT ${sql}`);
  }

  const keywords = parseFilterKeywords(req.keywords ?? '');
  const keywordScope = resolveKeywordScope(req.keyword_scope);
  const keywordClause = buildKeywordClause(keywordScope);
  for (const word of keywords.include) {
    // title_norm/synonym_norm are stored lowercase, comment body is folded by
    // unicode_lower() at query time — fold the word the same way.
    const pattern = buildLikePattern(word.toLowerCase());
    where.push(keywordClause.sql);
    for (let i = 0; i < keywordClause.paramCount; i += 1) params.push(pattern);
  }
  for (const word of keywords.exclude) {
    const pattern = buildLikePattern(word.toLowerCase());
    where.push(`NOT ${keywordClause.sql}`);
    for (let i = 0; i < keywordClause.paramCount; i += 1) params.push(pattern);
  }

  if (req.type_ids !== undefined && req.type_ids.length > 0) {
    // L21: a selected parent type matches its whole subtree (OR semantics).
    const expanded = expandTypeIdsToSubtree(ndb, 'thought_types', req.type_ids);
    if (expanded.length > 0) {
      where.push(`t.type_id IN (${expanded.map(() => '?').join(',')})`);
      params.push(...expanded);
    }
  }

  for (const cond of req.properties ?? []) {
    const def = getTypeProperty(ndb, cond.property_id);
    if (def === null) continue; // definition deleted after the filter was saved
    const allowed = OPS_BY_VALUE_TYPE[def.value_type];
    if (!allowed.includes(cond.op)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Операция ${cond.op} недопустима для свойства типа ${def.value_type}.`,
        { field: 'op', allowed },
        requestId,
      );
    }
    const column = `pv.${VALUE_COLUMN[def.value_type]}`;
    // thought_ref values may be stored as a JSON array of ids (config.multiple,
    // 02-data-model.md §3.5): exact arms match single ids, LIKE arms match ids
    // inside arrays. Quotes in the pattern make the id match exact.
    const refLike = def.value_type === 'thought_ref';
    const likePattern = (v: string): string => `%"${v.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`;
    if (cond.op === 'in' || cond.op === 'not_in') {
      if (!Array.isArray(cond.value) || cond.value.length === 0) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Для операции "в списке"/"не в списке" value должен быть непустым массивом.',
          { field: 'value' },
          requestId,
        );
      }
      const values = cond.value.map((v) => sqlScalar(def, v, requestId));
      const likeFrags = refLike ? values.map(() => `${column} LIKE ? ESCAPE '\\'`) : [];
      const listSql = `SELECT 1 FROM property_values_v pv
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND (${column} IN (${values.map(() => '?').join(',')})${likeFrags.length > 0 ? ` OR ${likeFrags.join(' OR ')}` : ''})`;
      where.push(cond.op === 'in' ? `EXISTS (${listSql})` : `NOT EXISTS (${listSql})`);
      params.push(
        cond.property_id,
        ...values,
        ...(refLike ? values.map((v) => likePattern(String(v))) : []),
      );
      continue;
    }
    if (cond.op === 'contains') {
      const pattern = buildLikePattern(String(cond.value));
      where.push(
        `EXISTS (SELECT 1 FROM property_values_v pv
           WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
             AND ${column} LIKE ? ESCAPE '\\')`,
      );
      params.push(cond.property_id, pattern);
      continue;
    }
    const value = sqlScalar(def, cond.value as StructurePropertyValue, requestId);
    const opSql = cond.op === 'eq' ? '=' : cond.op === 'gt' ? '>' : '<';
    // thought_ref allows eq only (see OPS_BY_VALUE_TYPE) — the LIKE arm there
    // covers multiple-ref arrays.
    const eqLike = refLike && cond.op === 'eq' ? ` OR ${column} LIKE ? ESCAPE '\\'` : '';
    where.push(
      `EXISTS (SELECT 1 FROM property_values_v pv
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND (${column} ${opSql} ?${eqLike}))`,
    );
    params.push(cond.property_id, value, ...(eqLike !== '' ? [likePattern(String(value))] : []));
  }

  if (req.link_type_ids !== undefined && req.link_type_ids.length > 0) {
    // L21: subtree expansion, same as the thought-type filter above.
    const expandedLinks = expandTypeIdsToSubtree(ndb, 'link_types', req.link_type_ids);
    if (expandedLinks.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM links_v l WHERE l.active = 1
           AND l.type_id IN (${expandedLinks.map(() => '?').join(',')})
           AND (l.source_id = t.id OR l.target_id = t.id))`,
      );
      params.push(...expandedLinks);
    }
  }

  // Sort: enum members validated by the route layer, interpolated as fixed
  // fragments only. `viewed` needs the per-user view-mark join.
  const { sortSql, joinSql, joinParams } = sortClause(userId, req);
  return {
    baseSql: `FROM thoughts_v t ${joinSql} WHERE ${where.join(' AND ')}`,
    joinParams,
    params,
    sortSql,
    homeFirst: false,
  };
}

/** Count the unrestricted matches of a built filter query. */
function countFilterMatches(ndb: NetworkDb, sql: FilterQuerySql): number {
  return (
    ndb.prepare(`SELECT COUNT(*) AS c ${sql.baseSql}`).get(...sql.joinParams, ...sql.params) as {
      c: number;
    }
  ).c;
}

/** ORDER BY clause of a built filter query (empty filter pins HOME first). */
function orderClause(sql: FilterQuerySql): string {
  return sql.homeFirst ? `(t.is_root = 1) DESC, ${sql.sortSql}` : sql.sortSql;
}

/**
 * Filter thoughts by the structure criteria (docs/03-server-api.md §6.10).
 *
 * An empty filter returns HOME (`is_root=1`, always first) plus the orphans —
 * thoughts with no active parent link — so every disconnected island of the
 * network stays reachable from the empty tree. Conditions with an unknown
 * `property_id` are ignored — the property definition may have been deleted
 * after the filter was saved; the remaining conditions still apply.
 */
export function queryThoughts(
  ndb: NetworkDb,
  userId: string,
  req: StructureQueryRequest,
  requestId?: string,
): StructureQueryResult {
  const sql = buildFilterQuerySql(ndb, userId, req, requestId);
  if (sql === null) return { items: [], total: 0, directions: {} };
  const total = countFilterMatches(ndb, sql);
  const limit = Math.min(Math.max(req.limit, 1), STRUCTURES_QUERY_MAX_LIMIT);
  const offset = Math.max(req.offset, 0);
  const rows = ndb
    .prepare(
      `SELECT ${REF_COLUMNS} ${sql.baseSql}
       ORDER BY ${orderClause(sql)}
       LIMIT ? OFFSET ?`,
    )
    .all(...sql.joinParams, ...sql.params, limit, offset) as Array<ThoughtRefRow>;
  const items = rows.map(rowToThoughtRef);
  // The page carries its own direction flags — the root ellipses are filled
  // right after the query, without waiting for the first expansion.
  return { items, total, directions: directionsOf(ndb, items.map((i) => i.id)) };
}

/** Result of {@link queryThoughtIds} (L22 ids-only filter query, §6.10). */
export interface StructureIdsResult {
  ids: string[];
  total: number;
}

/**
 * Id-only variant of the structures filter query (03-server-api.md §6.10,
 * `ids_only: true`): the same candidate set and ordering as
 * {@link queryThoughts}, but the page carries bare ids — the bulk filter
 * commands (08-ui-spec.md §15.3) collect the whole result this way. The route
 * layer raises the limit ceiling for this mode.
 */
export function queryThoughtIds(
  ndb: NetworkDb,
  userId: string,
  req: StructureQueryRequest,
  requestId?: string,
): StructureIdsResult {
  const sql = buildFilterQuerySql(ndb, userId, req, requestId);
  if (sql === null) return { ids: [], total: 0 };
  const total = countFilterMatches(ndb, sql);
  const limit = Math.min(Math.max(req.limit, 1), STRUCTURES_QUERY_IDS_MAX_LIMIT);
  const offset = Math.max(req.offset, 0);
  const rows = ndb
    .prepare(`SELECT t.id ${sql.baseSql} ORDER BY ${orderClause(sql)} LIMIT ? OFFSET ?`)
    .all(...sql.joinParams, ...sql.params, limit, offset) as Array<{ id: string }>;
  return { ids: rows.map((r) => r.id), total };
}

// ---------------------------------------------------------------------------
// Hierarchy expansion
// ---------------------------------------------------------------------------

/** Options of {@link getHierarchy}. */
export interface HierarchyOptions {
  showInactive?: boolean;
  /** Thoughts already shown in the same root branch — excluded before paging. */
  excludeIds?: string[];
  /** Page offset into the post-exclude neighbor list (§15.5 per-node pagination). */
  offset?: number;
}

/**
 * One-level hierarchy expansion for the structures tree
 * (docs/03-server-api.md §6.11): parents (link sources) or children (link
 * targets) of `thoughtId`, alphabetically ordered, plus the active links
 * between the node and the returned neighbours.
 *
 * `excludeIds` implements the per-branch dedup: the client sends every thought
 * id already visible in the branch, the server drops them from the neighbour
 * list **before** applying {@link STRUCTURES_NODE_NEIGHBORS_LIMIT}, so the
 * limit is spent on fresh neighbours only.
 */
export function getHierarchy(
  ndb: NetworkDb,
  thoughtId: string,
  dir: 'parents' | 'children',
  opts: HierarchyOptions = {},
): HierarchyResponse {
  getThoughtOrThrow(ndb, thoughtId);
  const showInactive = opts.showInactive === true ? 1 : 0;
  const exclude = new Set((opts.excludeIds ?? []).slice(0, HIERARCHY_EXCLUDE_MAX_IDS));

  const neighbourJoin = dir === 'children' ? 'l.target_id' : 'l.source_id';
  const focusSide = dir === 'children' ? 'l.source_id' : 'l.target_id';
  const rows = ndb
    .prepare(
      `SELECT DISTINCT ${REF_COLUMNS}
       FROM links_v l
       JOIN thoughts_v t ON t.id = ${neighbourJoin}
       WHERE ${focusSide} = ? AND (l.active = 1 OR ?) AND (t.active = 1 OR ?)
       ORDER BY t.title COLLATE NOCASE ASC`,
    )
    .all(thoughtId, showInactive, showInactive) as Array<ThoughtRefRow>;
  const fresh = rows.filter((row) => !exclude.has(row.id));
  const offset = Math.max(opts.offset ?? 0, 0);
  const page = fresh.slice(offset, offset + STRUCTURES_NODE_NEIGHBORS_LIMIT);
  const hasMore = offset + page.length < fresh.length;
  const neighbors = page.map(rowToThoughtRef);

  const visibleIds = [thoughtId, ...neighbors.map((n) => n.id)];
  const edges = getEdgesAmong(ndb, visibleIds, opts.showInactive === true).map((l) => ({
    id: l.id,
    source_id: l.source_id,
    target_id: l.target_id,
    type_id: l.type_id,
    color: l.color,
    style: l.style,
    width: l.width,
  }));
  // Whether each visible thought has active incoming/outgoing links at all —
  // in the tree these mean "has parents/children to expand", so the ellipses
  // can be filled exactly like on the canvas.
  return {
    neighbors,
    edges,
    truncated: hasMore,
    has_more: hasMore,
    directions: directionsOf(ndb, visibleIds),
  };
}

// ---------------------------------------------------------------------------
// Saved filters (L3)
// ---------------------------------------------------------------------------

/** Raw `saved_filters` row. */
interface SavedFilterRow {
  id: string;
  user_id: string;
  view: string;
  name: string;
  definition: string;
  created_at: string;
  updated_at: string;
}

const SAVED_FILTER_COLUMNS =
  'id, user_id, view, name, definition, created_at, updated_at FROM saved_filters';

/** Convert a raw row into a saved filter of its view (definition JSON is trusted). */
function rowToSavedFilterView(row: SavedFilterRow): SavedFilter | ChronicleSavedFilter {
  const definition = JSON.parse(row.definition) as
    | SavedFilterDefinition
    | ChronicleFilterDefinition;
  const base = {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.view === 'chronicle') {
    return { ...base, view: 'chronicle', definition: definition as ChronicleFilterDefinition };
  }
  return { ...base, view: 'structures', definition: definition as SavedFilterDefinition };
}

/** List the user's saved filters of one view, alphabetically by name (§18). */
export function listSavedFilters(
  ndb: NetworkDb,
  userId: string,
  view: SavedFilterView = 'structures',
): Array<SavedFilter | ChronicleSavedFilter> {
  const rows = ndb
    .prepare(
      `SELECT ${SAVED_FILTER_COLUMNS}
       WHERE user_id = ? AND view = ? ORDER BY name COLLATE NOCASE ASC`,
    )
    .all(userId, view) as SavedFilterRow[];
  return rows.map(rowToSavedFilterView);
}

/** Read one saved filter of the user or throw `NOT_FOUND` (foreign ids included). */
function getSavedFilterOrThrow(
  ndb: NetworkDb,
  userId: string,
  filterId: string,
): SavedFilter | ChronicleSavedFilter {
  const row = ndb
    .prepare(`SELECT ${SAVED_FILTER_COLUMNS} WHERE id = ? AND user_id = ? LIMIT 1`)
    .get(filterId, userId) as SavedFilterRow | undefined;
  if (!row) {
    throw new EtnError('NOT_FOUND', 'Отбор не найден.', { entity: 'saved_filter', id: filterId });
  }
  return rowToSavedFilterView(row);
}

/** Case-insensitive duplicate-name guard within one view (SQLite NOCASE is ASCII-only). */
function assertNameAvailable(
  ndb: NetworkDb,
  userId: string,
  view: SavedFilterView,
  name: string,
  exceptId?: string,
): void {
  const rows = ndb
    .prepare('SELECT id, name FROM saved_filters WHERE user_id = ? AND view = ?')
    .all(userId, view) as Array<{ id: string; name: string }>;
  const clash = rows.find(
    (row) => row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    throw new EtnError('DUPLICATE', 'Отбор с таким именем уже существует.', {
      field: 'name',
      name,
    });
  }
}

/** Create a saved filter of the given view; a repeated name → `DUPLICATE` (409). */
export function createSavedFilter(
  ndb: NetworkDb,
  userId: string,
  view: SavedFilterView,
  name: string,
  definition: SavedFilterDefinition | ChronicleFilterDefinition,
): SavedFilter | ChronicleSavedFilter {
  const trimmed = validateFilterName(name);
  assertNameAvailable(ndb, userId, view, trimmed);
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb.prepare(
    `INSERT INTO saved_filters (id, user_id, view, name, definition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, view, trimmed, JSON.stringify(definition), now, now);
  return getSavedFilterOrThrow(ndb, userId, id);
}

/** Rename and/or redefine a saved filter (03-server-api.md §18). */
export function updateSavedFilter(
  ndb: NetworkDb,
  userId: string,
  filterId: string,
  patch: { name?: string; definition?: SavedFilterDefinition | ChronicleFilterDefinition },
): SavedFilter | ChronicleSavedFilter {
  const existing = getSavedFilterOrThrow(ndb, userId, filterId);
  const name = patch.name !== undefined ? validateFilterName(patch.name) : existing.name;
  if (name !== existing.name) {
    assertNameAvailable(ndb, userId, existing.view, name, filterId);
  }
  const definition = patch.definition ?? existing.definition;
  ndb.prepare(
    'UPDATE saved_filters SET name = ?, definition = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(name, JSON.stringify(definition), new Date().toISOString(), filterId, userId);
  return getSavedFilterOrThrow(ndb, userId, filterId);
}

/** Delete a saved filter; unknown/foreign ids → `NOT_FOUND`. */
export function deleteSavedFilter(ndb: NetworkDb, userId: string, filterId: string): void {
  getSavedFilterOrThrow(ndb, userId, filterId);
  ndb.prepare('DELETE FROM saved_filters WHERE id = ? AND user_id = ?').run(filterId, userId);
}
