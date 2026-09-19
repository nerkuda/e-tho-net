/**
 * «Структуры мыслей» domain service (L15, docs/03-server-api.md §6.10, §6.11, §18).
 *
 *   * фильтры и определения отборов — разбор wire-формата REST
 *     (`parseStructureFilter`, `parseSavedFilterDefinition`);
 *   * `getHierarchy` — one-level parents/children expansion of the result tree,
 *     with per-branch dedup (`exclude_ids`) applied before the node limit;
 *   * saved-filter CRUD — named per-user filter definitions stored in
 *     `saved_filters` (L3, docs/02-data-model.md §3.10.5).
 *
 * Сам движок выборки мыслей живёт в `query-service.ts` (задача c5265deb):
 * REST-роут переводит разобранный фильтр в канонический запрос адаптером
 * `structureRequestToQuery` и исполняет единой функцией `queryThoughts`.
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
  STRUCTURE_AUTHOR_OPS,
  STRUCTURE_KEYWORD_SCOPES,
  STRUCTURE_PROPERTY_OPS,
  STRUCTURE_SORTS,
  SORT_ORDERS,
  isLinkTypeFilterActive,
  parseLinkTypeFilterValue,
  type ChronicleFilterDefinition,
  type ChronicleSavedFilter,
  type SavedFilter,
  type SavedFilterDefinition,
  type SavedFilterView,
  type SortOrder,
  type StructureAuthorOp,
  type StructureFilter,
  type StructureKeywordScope,
  type StructurePropertyCondition,
  type StructurePropertyOp,
  type StructurePropertyValue,
  type StructureSort,
  type HierarchyResponse,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getEdgesAmong } from './link-service.js';
import { directionsOf, REF_COLUMNS } from './query-service.js';
import { getThoughtOrThrow, rowToThoughtRef } from './thought-service.js';
import { linkTypeFilterClause } from './type-hierarchy.js';

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

  // Фильтр обхода по типам связей (задача c965ad03): ограничивает рёбра, по
  // которым `parent_ids` раскрывается в поддерево и разворачивается дерево
  // «Структур». Валидация формы — в `parseLinkTypeFilterValue` (shared).
  const linkFilter = parseLinkTypeFilterValue(body['link_filter'], requestId);
  if (linkFilter !== undefined) filter.link_filter = linkFilter;

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

  // Фильтры авторства (задача 59119797 «Фильтры Автор/Редактор»): id
  // пользователя и оператор (эволюция — eq/ne/in/not_in). Пустая строка и
  // отсутствие равнозначны — фильтр не применяется.
  for (const field of ['created_by', 'updated_by'] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    const op = parseAuthorOp(body[`${field}_op`], requestId);
    const parsed = parseAuthorValue(raw, op, requestId);
    if (parsed === undefined) continue; // empty value + not empty/not_empty op → drop
    filter[field] = parsed;
    if (op !== 'eq') filter[`${field}_op`] = op;
  }

  // Фильтры по датам создания/изменения (задача 7032e55a, паритет с MCP
  // `etn.thoughts.query.created_after/created_before/updated_after/updated_before`
  // и панелью «Структур» §15.3). Любая граница может быть опущена; обе
  // включающие (`>=`/`<=`); валидация формата — ISO-8601.
  for (const field of ['created_after', 'created_before', 'updated_after', 'updated_before'] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') {
      throw new EtnError('VALIDATION_ERROR', `${field} должен быть строкой ISO-8601.`, {
        field,
      }, requestId);
    }
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (!isIso8601(trimmed)) {
      throw new EtnError('VALIDATION_ERROR', `${field} должен быть ISO-8601 (например, 2024-01-02 или 2024-01-02T15:04:05Z).`, {
        field,
      }, requestId);
    }
    filter[field] = trimmed;
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

/**
 * Lax ISO-8601 check (задача 7032e55a). Accepts both date-only `YYYY-MM-DD`
 * and full timestamps `YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]` — the same
 * formats that `chronicle/query` (`date_from`/`date_to`, §20) accepts.
 */
function isIso8601(value: string): boolean {
  if (value.length < 10) return false;
  // YYYY-MM-DD prefix.
  if (
    value[4] !== '-' ||
    value[7] !== '-' ||
    !/^\d{4}-\d{2}-\d{2}/.test(value)
  ) {
    return false;
  }
  // Date-only: nothing else to check.
  if (value.length === 10) {
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  // Full timestamp: 'T' separator and at least HH:MM.
  if (value[10] !== 'T' && value[10] !== ' ') return false;
  if (!/^\d{2}:\d{2}/.test(value.slice(11))) return false;
  return true;
}

/** Parse the `*_op` field of an author filter; defaults to `eq` when absent. */
function parseAuthorOp(raw: unknown, requestId?: string): StructureAuthorOp {
  if (raw === undefined) return 'eq';
  if (typeof raw !== 'string' || !(STRUCTURE_AUTHOR_OPS as readonly string[]).includes(raw)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимая операция фильтра авторства.', {
      field: 'op',
      allowed: STRUCTURE_AUTHOR_OPS,
    }, requestId);
  }
  return raw as StructureAuthorOp;
}

/**
 * Validates the value payload against the operator (задача 59119797). Returns
 * `undefined` when the filter must be dropped (`empty`/`not_empty` with an
 * explicit empty value, or list ops with no ids).
 */
function parseAuthorValue(
  raw: unknown,
  op: StructureAuthorOp,
  requestId?: string,
): string | string[] | undefined {
  if (op === 'empty' || op === 'not_empty') {
    // Значение игнорируется — фильтр проверяет только NULL.
    return undefined;
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new EtnError('VALIDATION_ERROR', 'Для операции in/not_in нужен непустой массив id.', {
        field: 'value',
      }, requestId);
    }
    const ids: string[] = [];
    for (const v of raw) {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new EtnError('VALIDATION_ERROR', 'Каждый id должен быть непустой строкой.', {
          field: 'value',
        }, requestId);
      }
      ids.push(v);
    }
    return ids;
  }
  if (typeof raw !== 'string') {
    throw new EtnError('VALIDATION_ERROR', 'Значение должно быть строкой (id пользователя).', {
      field: 'value',
    }, requestId);
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
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
  // `is_empty` / `not_empty` ignore the value payload — the server decides
  // presence from the row + value column alone.
  if (op === 'is_empty' || op === 'not_empty') {
    const rawValue = obj['value'];
    const placeholder: StructurePropertyValue =
      typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean'
        ? rawValue
        : '';
    return { property_id: propertyId, op: op as StructurePropertyOp, value: placeholder };
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
    !isLinkTypeFilterActive(filter.link_filter) &&
    (filter.type_ids ?? []).length === 0 &&
    (filter.link_type_ids ?? []).length === 0 &&
    (filter.properties ?? []).length === 0 &&
    filter.has_properties === undefined &&
    filter.has_comment === undefined &&
    filter.has_attachments === undefined &&
    filter.has_chronology === undefined &&
    filter.active === undefined &&
    authorFilterIsEmpty(filter.created_by, filter.created_by_op) &&
    authorFilterIsEmpty(filter.updated_by, filter.updated_by_op) &&
    !dateBoundIsSet(filter.created_after) &&
    !dateBoundIsSet(filter.created_before) &&
    !dateBoundIsSet(filter.updated_after) &&
    !dateBoundIsSet(filter.updated_before)
  );
}

/** True when a date bound carries a non-empty value worth applying. */
function dateBoundIsSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** True when the author condition carries no useful clause (задача 59119797). */
function authorFilterIsEmpty(
  value: string | string[] | undefined,
  op: StructureAuthorOp | undefined,
): boolean {
  if (op === 'empty' || op === 'not_empty') return false;
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value === '';
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
// Hierarchy expansion
// ---------------------------------------------------------------------------

/** Options of {@link getHierarchy}. */
export interface HierarchyOptions {
  showInactive?: boolean;
  /** Thoughts already shown in the same root branch — excluded before paging. */
  excludeIds?: string[];
  /** Page offset into the post-exclude neighbor list (§15.5 per-node pagination). */
  offset?: number;
  /**
   * Фильтр обхода по типам связей (задача c965ad03, 0.8.1): с фильтром узел
   * дерева разворачивается только по рёбрам выбранных типов (+структурные при
   * `include_structural`), эллипсы и рёбра ответа — те же типы. Держит
   * раскрытие дерева «Структур» согласованным с отбором `parent_ids` +
   * `link_filter` запроса выборки.
   */
  linkFilter?: StructureFilter['link_filter'];
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
  const typeClause = linkTypeFilterClause(ndb, opts.linkFilter, 'l');
  const typeSql = typeClause === null ? '' : ` AND ${typeClause.sql}`;
  const typeParams = typeClause === null ? [] : typeClause.params;

  const neighbourJoin = dir === 'children' ? 'l.target_id' : 'l.source_id';
  const focusSide = dir === 'children' ? 'l.source_id' : 'l.target_id';
  const rows = ndb
    .prepare(
      `SELECT DISTINCT ${REF_COLUMNS}
       FROM links_v l
       JOIN thoughts_v t ON t.id = ${neighbourJoin}
       WHERE ${focusSide} = ? AND (l.active = 1 OR ?) AND (t.active = 1 OR ?)${typeSql}
       ORDER BY t.title COLLATE NOCASE ASC`,
    )
    .all(thoughtId, showInactive, showInactive, ...typeParams) as Array<
    Parameters<typeof rowToThoughtRef>[0]
  >;
  const fresh = rows.filter((row) => !exclude.has(row.id));
  const offset = Math.max(opts.offset ?? 0, 0);
  const page = fresh.slice(offset, offset + STRUCTURES_NODE_NEIGHBORS_LIMIT);
  const hasMore = offset + page.length < fresh.length;
  const neighbors = page.map(rowToThoughtRef);

  const visibleIds = [thoughtId, ...neighbors.map((n) => n.id)];
  const edges = getEdgesAmong(ndb, visibleIds, opts.showInactive === true, opts.linkFilter).map((l) => ({
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
    directions: directionsOf(ndb, visibleIds, opts.linkFilter),
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
