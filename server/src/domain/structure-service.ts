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
  STRUCTURES_QUERY_MAX_LIMIT,
  STRUCTURE_PROPERTY_OPS,
  STRUCTURE_SORTS,
  SORT_ORDERS,
  buildLikePattern,
  parseFilterKeywords,
  type PropertyValueType,
  type SavedFilter,
  type SavedFilterDefinition,
  type SortOrder,
  type StructureFilter,
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

/** Display columns every thought-ref SELECT must carry (see `resolveThoughts`). */
const REF_COLUMNS =
  't.id, t.title, t.type_id, t.icon, t.icon_kind, t.active, t.fg_color, t.bg_color,' +
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

/**
 * Title/synonym match clause of one keyword. The LIKE pattern is built by
 * {@link buildLikePattern} (escaping `%`/`_`/`\`, `*` → `%`) against the
 * normalised columns, so the match is case-insensitive and infix.
 */
const KEYWORD_MATCH =
  "(t.title_norm LIKE ? ESCAPE '\\' OR EXISTS (" +
  'SELECT 1 FROM thought_synonyms ts' +
  " WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'))";

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

/** True when the filter carries no criteria at all (empty filter → HOME only). */
export function isFilterEmpty(filter: StructureFilter): boolean {
  return (
    (filter.keywords ?? '').trim() === '' &&
    (filter.type_ids ?? []).length === 0 &&
    (filter.link_type_ids ?? []).length === 0 &&
    (filter.properties ?? []).length === 0
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

/** Reads the link-direction flags of the given thoughts as a plain record. */
function directionsOf(ndb: NetworkDb, ids: string[]): StructureDirectionFlags {
  const out: StructureDirectionFlags = {};
  for (const [id, d] of getLinkDirections(ndb, ids)) {
    out[id] = { has_incoming: d.has_in, has_outgoing: d.has_out };
  }
  return out;
}

/**
 * Filter thoughts by the structure criteria (docs/03-server-api.md §6.10).
 *
 * An empty filter returns only the HOME thought (`is_root=1`). Conditions with
 * an unknown `property_id` are ignored — the property definition may have been
 * deleted after the filter was saved; the remaining conditions still apply.
 */
export function queryThoughts(
  ndb: NetworkDb,
  userId: string,
  req: StructureQueryRequest,
  requestId?: string,
): StructureQueryResult {
  if (isFilterEmpty(req)) {
    const row = ndb
      .prepare(`SELECT ${REF_COLUMNS} FROM thoughts t WHERE t.is_root = 1 LIMIT 1`)
      .get() as ThoughtRefRow | undefined;
    if (!row) return { items: [], total: 0, directions: {} };
    const home = rowToThoughtRef(row);
    return { items: [home], total: 1, directions: directionsOf(ndb, [home.id]) };
  }

  const showInactive = req.show_inactive === true ? 1 : 0;
  const where: string[] = [];
  const params: unknown[] = [];

  if (showInactive !== 1) where.push('t.active = 1');

  const keywords = parseFilterKeywords(req.keywords ?? '');
  for (const word of keywords.include) {
    // title_norm/synonym_norm are stored lowercase — fold the word too.
    const pattern = buildLikePattern(word.toLowerCase());
    where.push(KEYWORD_MATCH);
    params.push(pattern, pattern);
  }
  for (const word of keywords.exclude) {
    const pattern = buildLikePattern(word.toLowerCase());
    where.push(`NOT ${KEYWORD_MATCH}`);
    params.push(pattern, pattern);
  }

  if (req.type_ids !== undefined && req.type_ids.length > 0) {
    where.push(`t.type_id IN (${req.type_ids.map(() => '?').join(',')})`);
    params.push(...req.type_ids);
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
      const listSql = `SELECT 1 FROM property_values pv
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND ${column} IN (${values.map(() => '?').join(',')})`;
      where.push(cond.op === 'in' ? `EXISTS (${listSql})` : `NOT EXISTS (${listSql})`);
      params.push(cond.property_id, ...values);
      continue;
    }
    if (cond.op === 'contains') {
      const pattern = buildLikePattern(String(cond.value));
      where.push(
        `EXISTS (SELECT 1 FROM property_values pv
           WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
             AND ${column} LIKE ? ESCAPE '\\')`,
      );
      params.push(cond.property_id, pattern);
      continue;
    }
    const value = sqlScalar(def, cond.value as StructurePropertyValue, requestId);
    const opSql = cond.op === 'eq' ? '=' : cond.op === 'gt' ? '>' : '<';
    where.push(
      `EXISTS (SELECT 1 FROM property_values pv
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND ${column} ${opSql} ?)`,
    );
    params.push(cond.property_id, value);
  }

  if (req.link_type_ids !== undefined && req.link_type_ids.length > 0) {
    where.push(
      `EXISTS (SELECT 1 FROM links l WHERE l.active = 1
         AND l.type_id IN (${req.link_type_ids.map(() => '?').join(',')})
         AND (l.source_id = t.id OR l.target_id = t.id))`,
    );
    params.push(...req.link_type_ids);
  }

  // Sort: enum members validated by the route layer, interpolated as fixed
  // fragments only. `viewed` needs the per-user view-mark join.
  const dirKeyword = req.order === 'desc' ? 'DESC' : 'ASC';
  const nullsLast = req.order === 'desc' ? 'DESC' : 'ASC';
  let orderBy: string;
  switch (req.sort) {
    case 'alpha':
      orderBy = `ORDER BY t.title COLLATE NOCASE ${dirKeyword}`;
      break;
    case 'created':
      orderBy = `ORDER BY t.created_at ${dirKeyword}`;
      break;
    case 'viewed':
      orderBy = `ORDER BY (tv.last_viewed_at IS NULL) ${nullsLast}, tv.last_viewed_at ${dirKeyword}`;
      break;
  }
  const useViewedJoin = req.sort === 'viewed';
  const joinSql = useViewedJoin
    ? 'LEFT JOIN thought_views tv ON tv.user_id = ? AND tv.thought_id = t.id'
    : '';
  const joinParams: unknown[] = useViewedJoin ? [userId] : [];

  const baseSql = `FROM thoughts t ${joinSql} WHERE ${where.join(' AND ')}`;
  const total = (
    ndb.prepare(`SELECT COUNT(*) AS c ${baseSql}`).get(...joinParams, ...params) as {
      c: number;
    }
  ).c;
  const limit = Math.min(Math.max(req.limit, 1), STRUCTURES_QUERY_MAX_LIMIT);
  const offset = Math.max(req.offset, 0);
  const rows = ndb
    .prepare(`SELECT ${REF_COLUMNS} ${baseSql} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...joinParams, ...params, limit, offset) as Array<ThoughtRefRow>;
  const items = rows.map(rowToThoughtRef);
  // The tree fills the root ellipses from these flags right after the query —
  // without them the fill would only appear after the first expansion.
  return { items, total, directions: directionsOf(ndb, items.map((i) => i.id)) };
}

// ---------------------------------------------------------------------------
// Hierarchy expansion
// ---------------------------------------------------------------------------

/** Options of {@link getHierarchy}. */
export interface HierarchyOptions {
  showInactive?: boolean;
  /** Thoughts already shown in the same root branch — excluded before the limit. */
  excludeIds?: string[];
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
       FROM links l
       JOIN thoughts t ON t.id = ${neighbourJoin}
       WHERE ${focusSide} = ? AND (l.active = 1 OR ?) AND (t.active = 1 OR ?)
       ORDER BY t.title COLLATE NOCASE ASC`,
    )
    .all(thoughtId, showInactive, showInactive) as Array<ThoughtRefRow>;
  const fresh = rows.filter((row) => !exclude.has(row.id));
  const truncated = fresh.length > STRUCTURES_NODE_NEIGHBORS_LIMIT;
  const neighbors = fresh.slice(0, STRUCTURES_NODE_NEIGHBORS_LIMIT).map(rowToThoughtRef);

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
  return { neighbors, edges, truncated, directions: directionsOf(ndb, visibleIds) };
}

// ---------------------------------------------------------------------------
// Saved filters (L3)
// ---------------------------------------------------------------------------

/** Raw `saved_filters` row. */
interface SavedFilterRow {
  id: string;
  user_id: string;
  name: string;
  definition: string;
  created_at: string;
  updated_at: string;
}

/** Convert a raw row into a {@link SavedFilter} (definition JSON is trusted). */
function rowToSavedFilter(row: SavedFilterRow): SavedFilter {
  return {
    id: row.id,
    name: row.name,
    definition: JSON.parse(row.definition) as SavedFilterDefinition,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** List the user's saved filters, alphabetically by name (03-server-api.md §18). */
export function listSavedFilters(ndb: NetworkDb, userId: string): SavedFilter[] {
  const rows = ndb
    .prepare(
      'SELECT id, user_id, name, definition, created_at, updated_at FROM saved_filters' +
        ' WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC',
    )
    .all(userId) as SavedFilterRow[];
  return rows.map(rowToSavedFilter);
}

/** Read one saved filter of the user or throw `NOT_FOUND` (foreign ids included). */
function getSavedFilterOrThrow(ndb: NetworkDb, userId: string, filterId: string): SavedFilter {
  const row = ndb
    .prepare(
      'SELECT id, user_id, name, definition, created_at, updated_at FROM saved_filters' +
        ' WHERE id = ? AND user_id = ? LIMIT 1',
    )
    .get(filterId, userId) as SavedFilterRow | undefined;
  if (!row) {
    throw new EtnError('NOT_FOUND', 'Отбор не найден.', { entity: 'saved_filter', id: filterId });
  }
  return rowToSavedFilter(row);
}

/** Case-insensitive duplicate-name guard (SQLite NOCASE is ASCII-only). */
function assertNameAvailable(
  ndb: NetworkDb,
  userId: string,
  name: string,
  exceptId?: string,
): void {
  const rows = ndb
    .prepare('SELECT id, name FROM saved_filters WHERE user_id = ?')
    .all(userId) as Array<{ id: string; name: string }>;
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

/** Create a saved filter; a repeated name → `DUPLICATE` (409). */
export function createSavedFilter(
  ndb: NetworkDb,
  userId: string,
  name: string,
  definition: SavedFilterDefinition,
): SavedFilter {
  const trimmed = validateFilterName(name);
  assertNameAvailable(ndb, userId, trimmed);
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb.prepare(
    `INSERT INTO saved_filters (id, user_id, name, definition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, trimmed, JSON.stringify(definition), now, now);
  return getSavedFilterOrThrow(ndb, userId, id);
}

/** Rename and/or redefine a saved filter (03-server-api.md §18). */
export function updateSavedFilter(
  ndb: NetworkDb,
  userId: string,
  filterId: string,
  patch: { name?: string; definition?: SavedFilterDefinition },
): SavedFilter {
  const existing = getSavedFilterOrThrow(ndb, userId, filterId);
  const name = patch.name !== undefined ? validateFilterName(patch.name) : existing.name;
  if (name !== existing.name) {
    assertNameAvailable(ndb, userId, name, filterId);
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
