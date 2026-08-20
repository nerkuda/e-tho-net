/**
 * «Хроника» domain service (L20, docs/03-server-api.md §20).
 *
 * Two-phase query for the chronicle workspace view:
 *   1. select **thoughts** — roots from the «мысли» field, optionally expanded
 *      with their undirected subordinates up to {@link TRAVERSAL_DEFAULTS.MAX_DEPTH}
 *      levels, then filtered by thought types and the keywords mini-syntax
 *      (`*`/`-`, searched in titles, synonyms, and the texts of the thoughts'
 *      comments and of their incident links' comments on both sides);
 *   2. list **chronological comments** attached to the selected thoughts or to
 *      their links (link types / link scope filter), intersected with the
 *      requested date range, sorted by (valid_from, valid_to, title) and paged.
 *
 * Row snippets reuse {@link makeSnippet} from the search service (same
 * `<mark>` highlight convention); targets are resolved to `ThoughtRef`s /
 * display-ready links.
 */

import {
  CHRONICLE_LINK_SCOPES,
  CHRONICLE_PAGE_SIZE,
  CHRONICLE_QUERY_MAX_LIMIT,
  CHRONICLE_THOUGHT_IDS_MAX,
  EtnError,
  SORT_ORDERS,
  TRAVERSAL_DEFAULTS,
  buildLikePattern,
  parseFilterKeywords,
  type ChronicleFilter,
  type ChronicleFilterDefinition,
  type ChronicleLinkScope,
  type ChronicleQueryRequest,
  type ChronicleQueryResponse,
  type ChronicleRow,
  type ChronicleTarget,
  type ChronicleTargetLink,
  type SortOrder,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { makeSnippet } from './search-service.js';
import { rowToThoughtRef } from './thought-service.js';
import { REF_COLUMNS } from './structure-service.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';

/** Row shape accepted by {@link rowToThoughtRef}. */
type ThoughtRefRow = Parameters<typeof rowToThoughtRef>[0];

/** Build a `placeholders` string of `n` `?`. */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** Parse the `date_from`/`date_to` fields (empty/absent → `undefined`). */
function parseDateField(
  body: Record<string, unknown>,
  field: 'date_from' | 'date_to',
  requestId?: string,
): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', `${field} должен быть непустой строкой даты.`, {
      field,
    }, requestId);
  }
  return raw.trim();
}

/** Read a `ChronicleFilter` from an untrusted object (request body or saved JSON). */
export function parseChronicleFilter(
  body: Record<string, unknown>,
  requestId?: string,
): ChronicleFilter {
  const filter: ChronicleFilter = {};

  const keywords = body['keywords'];
  if (keywords !== undefined) {
    if (typeof keywords !== 'string') {
      throw new EtnError('VALIDATION_ERROR', 'keywords должен быть строкой.', {
        field: 'keywords',
      }, requestId);
    }
    if (keywords.trim() !== '') filter.keywords = keywords;
  }

  const thoughtIds = body['thought_ids'];
  if (thoughtIds !== undefined) {
    if (!Array.isArray(thoughtIds) || thoughtIds.some((v) => typeof v !== 'string')) {
      throw new EtnError('VALIDATION_ERROR', 'thought_ids должен быть массивом строк.', {
        field: 'thought_ids',
      }, requestId);
    }
    if (thoughtIds.length > CHRONICLE_THOUGHT_IDS_MAX) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `thought_ids — не более ${CHRONICLE_THOUGHT_IDS_MAX} мыслей.`,
        { field: 'thought_ids' },
        requestId,
      );
    }
    if (thoughtIds.length > 0) filter.thought_ids = thoughtIds as string[];
  }

  const includeSubtree = body['include_subtree'];
  if (includeSubtree !== undefined) {
    if (typeof includeSubtree !== 'boolean') {
      throw new EtnError('VALIDATION_ERROR', 'include_subtree должен быть boolean.', {
        field: 'include_subtree',
      }, requestId);
    }
    filter.include_subtree = includeSubtree;
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

  const linkScope = body['link_scope'];
  if (linkScope !== undefined) {
    if (
      typeof linkScope !== 'string' ||
      !(CHRONICLE_LINK_SCOPES as readonly string[]).includes(linkScope)
    ) {
      throw new EtnError('VALIDATION_ERROR', 'Недопустимый link_scope.', {
        field: 'link_scope',
        allowed: CHRONICLE_LINK_SCOPES,
      }, requestId);
    }
    filter.link_scope = linkScope as ChronicleLinkScope;
  }

  const dateFrom = parseDateField(body, 'date_from', requestId);
  if (dateFrom !== undefined) filter.date_from = dateFrom;
  const dateTo = parseDateField(body, 'date_to', requestId);
  if (dateTo !== undefined) filter.date_to = dateTo;

  return filter;
}

/** Read a full chronicle saved-filter definition (filter + order) from an untrusted object. */
export function parseChronicleFilterDefinition(
  body: Record<string, unknown>,
  requestId?: string,
): ChronicleFilterDefinition {
  const filter = parseChronicleFilter(body, requestId);
  const orderRaw = body['order'];
  if (typeof orderRaw !== 'string' || !(SORT_ORDERS as readonly string[]).includes(orderRaw)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимый order.', {
      field: 'order',
      allowed: SORT_ORDERS,
    }, requestId);
  }
  return { ...filter, order: orderRaw as SortOrder };
}

/** Parse the body of `POST /chronicle/query` into a typed request. */
export function parseChronicleQueryBody(
  body: Record<string, unknown>,
  requestId: string,
): ChronicleQueryRequest {
  const filter = parseChronicleFilter(body, requestId);
  const orderRaw = body['order'];
  const order =
    typeof orderRaw === 'string' && (SORT_ORDERS as readonly string[]).includes(orderRaw)
      ? (orderRaw as SortOrder)
      : 'asc';
  const limitRaw = body['limit'];
  const limit =
    typeof limitRaw === 'number' && Number.isInteger(limitRaw)
      ? limitRaw
      : CHRONICLE_PAGE_SIZE;
  const offsetRaw = body['offset'];
  const offset =
    typeof offsetRaw === 'number' && Number.isInteger(offsetRaw) ? offsetRaw : 0;
  if (limit < 1 || limit > CHRONICLE_QUERY_MAX_LIMIT) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `limit должен быть целым числом 1..${CHRONICLE_QUERY_MAX_LIMIT}.`,
      { field: 'limit' },
      requestId,
    );
  }
  if (offset < 0) {
    throw new EtnError('VALIDATION_ERROR', 'offset должен быть целым числом ≥ 0.', {
      field: 'offset',
    }, requestId);
  }
  return { ...filter, order, limit, offset };
}

/**
 * Phase 1 — collect the selected thought ids.
 *
 * Roots come from `thought_ids` (missing ids are dropped); with
 * `include_subtree` their **subordinates** (children, `source → target`
 * direction, per docs/11-settings-and-state.md §5.2) up to
 * {@link TRAVERSAL_DEFAULTS.MAX_DEPTH} levels are added via a recursive CTE
 * whose cycle safety is `UNION` row deduplication (one row per
 * `(id, depth)` — bounded by `|thoughts| × max_depth`; the old `path`-string
 * guard enumerated simple paths and exploded exponentially on cyclic graphs,
 * freezing the synchronous SQLite loop). Returns `null` when the filter has
 * no roots at all — «all thoughts».
 */
function collectRootAndSubtreeIds(
  ndb: NetworkDb,
  request: ChronicleQueryRequest,
): string[] | null {
  const roots = request.thought_ids ?? [];
  if (roots.length === 0) return null;
  const rootRows = ndb
    .prepare(`SELECT id FROM thoughts WHERE id IN (${placeholders(roots.length)})`)
    .all(...roots) as Array<{ id: string }>;
  const ids = new Set(rootRows.map((r) => r.id));
  if (ids.size === 0) return [];
  if (request.include_subtree !== true) return [...ids];

  const rows = ndb
    .prepare(
      `WITH RECURSIVE
        descend(id, depth) AS (
          SELECT t.id, 0
          FROM thoughts t
          WHERE t.id IN (${placeholders(ids.size)})
          UNION
          SELECT l.target_id, d.depth + 1
          FROM descend d
          JOIN links l ON l.source_id = d.id AND l.active = 1
          WHERE d.depth < ?
        )
       SELECT DISTINCT id FROM descend`,
    )
    .all(...ids, TRAVERSAL_DEFAULTS.MAX_DEPTH) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Keywords condition for one word against a thought (titles, synonyms, comment
 *  texts of the thought and of its incident links on both sides). */
const THOUGHT_KEYWORD_COND = `(t.title_norm LIKE ? ESCAPE '\\' OR EXISTS (
  SELECT 1 FROM thought_synonyms ts
  WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'
) OR EXISTS (
  SELECT 1 FROM comments c1
  JOIN comment_targets ct1 ON ct1.comment_id = c1.id AND ct1.owner_type = 'thought'
  WHERE ct1.owner_id = t.id AND c1.body_md LIKE ? ESCAPE '\\'
) OR EXISTS (
  SELECT 1 FROM comments c2
  JOIN comment_targets ct2 ON ct2.comment_id = c2.id AND ct2.owner_type = 'link'
  JOIN links l2 ON l2.id = ct2.owner_id AND (l2.source_id = t.id OR l2.target_id = t.id)
  WHERE c2.body_md LIKE ? ESCAPE '\\'
))`;

/**
 * Phase 1 SQL — filter the (possibly subtree-expanded) thought set by type and
 * keywords. `baseIds === null` means no root restriction (all thoughts).
 */
function selectThoughts(
  ndb: NetworkDb,
  baseIds: string[] | null,
  typeIds: string[],
  includeWords: string[],
  excludeWords: string[],
): string[] {
  // An empty root set short-circuits: `IN ()` is invalid SQL and there is
  // nothing left to filter anyway.
  if (baseIds !== null && baseIds.length === 0) return [];
  const where: string[] = [];
  const args: unknown[] = [];
  if (baseIds !== null) {
    where.push(`t.id IN (${placeholders(baseIds.length)})`);
    args.push(...baseIds);
  }
  if (typeIds.length > 0) {
    // L21: a selected parent type matches its whole subtree (OR semantics).
    const expanded = expandTypeIdsToSubtree(ndb, 'thought_types', typeIds);
    if (expanded.length > 0) {
      where.push(`t.type_id IN (${placeholders(expanded.length)})`);
      args.push(...expanded);
    }
  }
  for (const word of includeWords) {
    const pattern = buildLikePattern(word);
    where.push(THOUGHT_KEYWORD_COND);
    args.push(pattern, pattern, pattern, pattern);
  }
  for (const word of excludeWords) {
    const pattern = buildLikePattern(word);
    where.push(`NOT ${THOUGHT_KEYWORD_COND}`);
    args.push(pattern, pattern, pattern, pattern);
  }
  const sql = `SELECT t.id FROM thoughts t ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`;
  const rows = ndb.prepare(sql).all(...args) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Period-intersection SQL for `valid_from` (upper bound of the requested period). */
function validFromUpperCond(dateTo: string): [string, string[]] {
  // A calendar date (YYYY-MM-DD) must also admit full timestamps of that day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return ['(c.valid_from <= ? OR c.valid_from LIKE ? ESCAPE \'\\\')', [dateTo, `${dateTo}%`]];
  }
  return ['c.valid_from <= ?', [dateTo]];
}

/** Period-intersection SQL for `valid_to` (lower bound of the requested period). */
function validToLowerCond(dateFrom: string): [string, string[]] {
  const cond = '(c.valid_to IS NULL OR c.valid_to >= ?';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    return [`${cond} OR c.valid_to LIKE ? ESCAPE '\\')`, [dateFrom, `${dateFrom}%`]];
  }
  return [`${cond})`, [dateFrom]];
}

/** Phase 2 WHERE shared by the count and the page queries. */
function buildRowsWhere(
  ndb: NetworkDb,
  selectedIds: string[],
  request: ChronicleQueryRequest,
): { cond: string; args: unknown[] } {
  const conds: string[] = ["c.kind = 'chronological'"];
  const args: unknown[] = [];

  // Attachment to a selected thought…
  const thoughtConds: string[] = [];
  thoughtConds.push(
    `EXISTS (SELECT 1 FROM comment_targets ct
             WHERE ct.comment_id = c.id AND ct.owner_type = 'thought'
               AND ct.owner_id IN (${placeholders(selectedIds.length)}))`,
  );
  args.push(...selectedIds);

  // …or to a link whose source/target is selected (per the link scope).
  const scope = request.link_scope ?? 'both';
  const endpointConds: string[] = [];
  if (scope === 'sources' || scope === 'both') {
    endpointConds.push(`l.source_id IN (${placeholders(selectedIds.length)})`);
    args.push(...selectedIds);
  }
  if (scope === 'targets' || scope === 'both') {
    endpointConds.push(`l.target_id IN (${placeholders(selectedIds.length)})`);
    args.push(...selectedIds);
  }
  let linkCond = `EXISTS (SELECT 1 FROM comment_targets ctl
    JOIN links l ON l.id = ctl.owner_id AND ctl.owner_type = 'link'
    WHERE ctl.comment_id = c.id AND (${endpointConds.join(' OR ')})`;
  if ((request.link_type_ids ?? []).length > 0) {
    // L21: subtree expansion, same as the thought-type filter above.
    const expandedLinks = expandTypeIdsToSubtree(ndb, 'link_types', request.link_type_ids!);
    if (expandedLinks.length > 0) {
      linkCond += ` AND l.type_id IN (${placeholders(expandedLinks.length)})`;
      args.push(...expandedLinks);
    }
  }
  linkCond += ')';
  thoughtConds.push(linkCond);

  conds.push(`(${thoughtConds.join(' OR ')})`);

  if (request.date_from !== undefined && request.date_from !== null) {
    const [cond, more] = validToLowerCond(request.date_from);
    conds.push(cond);
    args.push(...more);
  }
  if (request.date_to !== undefined && request.date_to !== null) {
    const [cond, more] = validFromUpperCond(request.date_to);
    conds.push(cond);
    args.push(...more);
  }

  return { cond: conds.join(' AND '), args };
}

/** Resolve one comment row with all its targets into a {@link ChronicleRow}. */
function buildRows(
  ndb: NetworkDb,
  rows: Row[],
  refs: Map<string, ThoughtRefRow>,
  linkTargets: Map<string, ChronicleTargetLink>,
): ChronicleRow[] {
  return rows.map((row) => {
    const targetRows = ndb
      .prepare(
        `SELECT owner_type, owner_id FROM comment_targets WHERE comment_id = ?
         ORDER BY owner_type ASC, owner_id ASC`,
      )
      .all(row.id) as Array<{ owner_type: string; owner_id: string }>;
    const targets: ChronicleTarget[] = [];
    for (const t of targetRows) {
      if (t.owner_type === 'thought') {
        const ref = refs.get(t.owner_id);
        if (ref !== undefined) targets.push({ kind: 'thought', thought: rowToThoughtRef(ref) });
      } else {
        const link = linkTargets.get(t.owner_id);
        if (link !== undefined) targets.push({ kind: 'link', link });
      }
    }
    // Stable order: the primary owner first (matches the DTO convention).
    targets.sort((a, b) => {
      const aId = a.kind === 'thought' ? a.thought.id : a.link.id;
      const bId = b.kind === 'thought' ? b.thought.id : b.link.id;
      const aPrimary = a.kind === 'thought' ? row.owner_type === 'thought' && row.owner_id === aId : row.owner_type === 'link' && row.owner_id === aId;
      const bPrimary = b.kind === 'thought' ? row.owner_type === 'thought' && row.owner_id === bId : row.owner_type === 'link' && row.owner_id === bId;
      if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
      return 0;
    });
    return {
      id: row.id,
      title: row.title,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      snippet: row.snippet,
      targets,
    };
  });
}

/** Raw phase-2 row (comment columns + precomputed snippet). */
interface Row {
  id: string;
  owner_type: string;
  owner_id: string;
  title: string | null;
  body_md: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  snippet: string;
}

/**
 * Run the two-phase chronicle query (docs/03-server-api.md §20).
 *
 * Phase 1 selects thoughts; phase 2 lists chronological comments attached to
 * them or to their links. Returns the paged rows with the total count.
 */
export function queryChronicle(
  ndb: NetworkDb,
  request: ChronicleQueryRequest,
): ChronicleQueryResponse {
  const { include: includeWords, exclude: excludeWords } = parseFilterKeywords(
    request.keywords ?? '',
  );
  const baseIds = collectRootAndSubtreeIds(ndb, request);
  let selectedIds = selectThoughts(ndb, baseIds, request.type_ids ?? [], includeWords, []);
  // Excluded words: drop every thought where the word occurs anywhere in the
  // same searched texts (titles, synonyms, thought/link comments).
  if (excludeWords.length > 0) {
    const excluded = new Set(
      selectThoughts(ndb, baseIds, request.type_ids ?? [], excludeWords, []),
    );
    selectedIds = selectedIds.filter((id) => !excluded.has(id));
  }
  if (selectedIds.length === 0) {
    return { rows: [], total: 0 };
  }

  const { cond, args } = buildRowsWhere(ndb, selectedIds, request);
  const dir = request.order === 'desc' ? 'DESC' : 'ASC';
  const totalRow = ndb
    .prepare(`SELECT COUNT(*) AS c FROM comments c WHERE ${cond}`)
    .get(...args) as { c: number };
  const total = totalRow.c;

  const rows = ndb
    .prepare(
      `SELECT c.id, c.owner_type, c.owner_id, c.title, c.body_md, c.valid_from, c.valid_to,
              c.version, c.created_at, c.updated_at, c.created_by, c.updated_by
       FROM comments c
       WHERE ${cond}
       ORDER BY c.valid_from ${dir},
                (c.valid_to IS NULL) ASC,
                c.valid_to ${dir},
                c.title COLLATE NOCASE ${dir},
                c.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, request.limit, request.offset) as Row[];

  // Resolve targets: collect all thought ids and link ids of the page.
  const thoughtIds = new Set<string>();
  const linkIds = new Set<string>();
  for (const row of rows) {
    const targetRows = ndb
      .prepare('SELECT owner_type, owner_id FROM comment_targets WHERE comment_id = ?')
      .all(row.id) as Array<{ owner_type: string; owner_id: string }>;
    for (const t of targetRows) {
      if (t.owner_type === 'thought') thoughtIds.add(t.owner_id);
      else linkIds.add(t.owner_id);
    }
  }
  const refs = new Map<string, ThoughtRefRow>();
  const allRefIds = [...thoughtIds];
  const linkRows = linkIds.size > 0
    ? (ndb
        .prepare(
          `SELECT l.id, l.type_id, l.active, l.source_id, l.target_id,
                  lt.name_forward, lt.name_reverse
           FROM links l
           LEFT JOIN link_types lt ON lt.id = l.type_id
           WHERE l.id IN (${placeholders(linkIds.size)})`,
        )
        .all(...linkIds) as Array<{
        id: string;
        type_id: string | null;
        active: number;
        source_id: string;
        target_id: string;
        name_forward: string | null;
        name_reverse: string | null;
      }>)
    : [];
  for (const lr of linkRows) {
    allRefIds.push(lr.source_id, lr.target_id);
  }
  const uniqueRefIds = [...new Set(allRefIds)];
  if (uniqueRefIds.length > 0) {
    const refRows = ndb
      .prepare(`SELECT ${REF_COLUMNS} FROM thoughts t WHERE t.id IN (${placeholders(uniqueRefIds.length)})`)
      .all(...uniqueRefIds) as ThoughtRefRow[];
    for (const r of refRows) refs.set(r.id, r);
  }
  const linkTargets = new Map<string, ChronicleTargetLink>();
  for (const lr of linkRows) {
    const source = refs.get(lr.source_id);
    const target = refs.get(lr.target_id);
    if (source === undefined || target === undefined) continue;
    linkTargets.set(lr.id, {
      id: lr.id,
      type_id: lr.type_id,
      active: lr.active === 1,
      type_name_forward: lr.name_forward,
      type_name_reverse: lr.name_reverse,
      source: rowToThoughtRef(source),
      target: rowToThoughtRef(target),
    });
  }

  const withSnippets = rows.map((row) => ({
    ...row,
    snippet: makeSnippet(row.body_md, includeWords),
  }));
  return { rows: buildRows(ndb, withSnippets, refs, linkTargets), total };
}
