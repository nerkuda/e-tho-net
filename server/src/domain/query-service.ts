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
 *     `value_bool`) is selected from the property's
 *     `value_type`, never from the runtime type of the supplied value —
 *     `eq "согласовано"` on a `text` property hits `value_text`, the same
 *     payload on a `date` property would hit `value_date` and likely match
 *     nothing;
 * An unknown `property_id` simply matches nothing for that condition — the
 * registry row may have been deleted after the filter was saved.
 */

import {
  EtnError,
  TRAVERSAL_DEFAULTS,
  buildLikePattern,
  parseFilterKeywords,
  type LinkPropertyDirection,
  type PropertyConfig,
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
import {
  isStructuralLinkProperty,
  linkPropertyDirection,
  linkPropertyLinkTypeId,
  resolvePropertyIdByName,
} from './property-service.js';
import { resolveThoughtTypeIdByName } from './thought-type-service.js';
import { expandTypeIdsToSubtree, linkTypeFilterClause } from './type-hierarchy.js';

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
 *
 * Задача c965ad03: `linkFilter` ограничивает рёбра, по которым спуск
 * происходит (типы с потомками + опционально структурные); без фильтра —
 * все рёбра, как раньше.
 */
function walkSubtree(ndb: NetworkDb, seedId: string | undefined, opts: {
  maxDepth: number;
  maxNodes: number;
  linkFilter?: ThoughtQueryRequest['link_filter'];
}): WalkResult {
  if (seedId === undefined) {
    return { depths: null, truncated: false, reason: null };
  }
  const { maxDepth, maxNodes } = opts;
  const typeClause = linkTypeFilterClause(ndb, opts.linkFilter, 'l');
  const typeSql = typeClause === null ? '' : ` AND ${typeClause.sql}`;
  const typeParams = typeClause === null ? [] : typeClause.params;
  const visited = new Set<string>();
  const depths = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];
  let truncated = false;
  let reason: WalkResult['reason'] = null;

  const childrenOf = ndb.prepare(
    `SELECT l.target_id AS nid FROM links_v l WHERE l.source_id = ? AND l.active = 1${typeSql}`,
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
    const rows = childrenOf.all(id, ...typeParams) as Array<{ nid: string }>;
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
const SQL_OPS: Record<
  Exclude<PropertyQueryOperator, 'contains' | 'any_of' | 'all_of' | 'none_of'>,
  string
> = {
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
  // Свойство-связь значений в property_values не хранит (ADR «проекция
  // ребра»); значение недостижимо — условие уходит в linkPropertyClause.
  link: 'value_text',
  // Legacy thought_ref (миграция 040): в живой БД таких свойств быть не
  // должно; для не призрачных строк читаем из value_thought_ref, но в query
  // тип не используется — пустая колонка-пылесос для удовлетворения типа.
  thought_ref: 'value_text',
};

/**
 * SQL operator per `value_type` × `PropertyQueryOperator` (the query subset of
 * `structure-service.OPS_BY_VALUE_TYPE` — `in`/`not_in`/`is_empty`/`not_empty`
 * belong only to the structures filter, not to `etn.thoughts.query`).
 *
 * Задача 20effcbd (0.8.1): `link` получает `eq`/`ne` (конкретная цель id
 * строкой, либо наличие/отсутствие связи такого типа boolean-значением —
 * {@link linkPropertyClause}) и три оператора для наборов. Те же три
 * оператора доступны `url` — обычному множественному свойству
 * (`config.multiple`, требование 92b9c55b): выразить «значение — одно из
 * списка» или «значение — все из списка».
 */
const SUPPORTED_OPS: Record<PropertyValueType, ReadonlySet<PropertyQueryOperator>> = {
  text: new Set(['eq', 'ne', 'contains']),
  url: new Set(['eq', 'ne', 'contains', 'any_of', 'all_of', 'none_of']),
  date: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
  number: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
  bool: new Set(['eq', 'ne']),
  link: new Set(['eq', 'ne', 'any_of', 'all_of', 'none_of']),
  // Legacy thought_ref (миграция 040): свойств этого типа в живой БД не
  // остаётся; в query не должно приходить, но тип-маркер требует ключ.
  thought_ref: new Set<PropertyQueryOperator>(),
};

/** Minimal registry row read in one batched lookup of all conditions. */
interface RegistryPropertyRow {
  id: string;
  name: string;
  value_type: string;
  /** Raw JSON `config` (§3.4a) — parsed lazily, only for `value_type: 'link'`. */
  config: string | null;
}

/** Parse a registry property's stored `config` JSON; malformed/absent → `null`. */
function parsePropertyConfig(raw: string | null): PropertyConfig | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PropertyConfig;
  } catch {
    return null;
  }
}

/**
 * Non-empty array of non-empty strings required by `any_of`/`all_of`/`none_of`
 * (задача 20effcbd) — mirrors the `in`/`not_in` validation of the structures
 * filter (`structure-service.ts`).
 */
function coerceValueList(
  value: PropertyQueryCondition['value'],
  operator: PropertyQueryOperator,
  requestId?: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Для операции ${operator} нужен непустой массив значений.`,
      { field: 'value', operator },
      requestId,
    );
  }
  if (value.some((v) => typeof v !== 'string' || v === '')) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Массив значений операции ${operator} должен состоять из непустых строк.`,
      { field: 'value', operator },
      requestId,
    );
  }
  return [...new Set(value)];
}

/**
 * Раскрыть значение множественного свойства (`property_values.<column>`) в
 * набор элементов (задача 20effcbd). Множественное значение хранится JSON-
 * массивом строк (`["a","b"]`, 02-data-model.md §3.5), одиночное — обычным
 * скаляром — «форма хранения важнее флага `multiple`» (та же оговорка, что у
 * `readValue` в `property-service.ts`). `json_each` требует валидный JSON-
 * массив на входе, поэтому скаляр оборачивается в массив из одного элемента;
 * `json_quote` корректно эскейпит кавычки/спецсимволы при оборачивании.
 */
function multipleValueElementsSql(column: string): string {
  return `json_each(CASE WHEN pv.${column} LIKE '[%' THEN pv.${column} ELSE '[' || json_quote(pv.${column}) || ']' END)`;
}

/**
 * Клауза `any_of`/`all_of`/`none_of` по множественному свойству `url`
 * (`config.multiple`, задача 20effcbd). `any_of`/`none_of` — один `EXISTS`/`NOT EXISTS` с
 * `IN (...)`; `all_of` — конъюнкция по одному `EXISTS` на каждое искомое
 * значение (пересечение не выразить одним `IN`).
 */
function multipleValueSetClause(
  propertyId: string,
  column: string,
  operator: 'any_of' | 'all_of' | 'none_of',
  value: PropertyQueryCondition['value'],
  requestId?: string,
): Clause {
  const values = coerceValueList(value, operator, requestId);
  const elementsSql = multipleValueElementsSql(column);
  const existsOne = (v: string): Clause => ({
    sql: `EXISTS (
      SELECT 1 FROM property_values_v pv, ${elementsSql} je
      WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
        AND pv.${column} IS NOT NULL AND je.value = ?)`,
    params: [propertyId, v],
  });
  if (operator === 'all_of') {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const v of values) {
      const one = existsOne(v);
      parts.push(one.sql);
      params.push(...one.params);
    }
    return { sql: parts.join(' AND '), params };
  }
  const placeholders = values.map(() => '?').join(',');
  const any: Clause = {
    sql: `EXISTS (
      SELECT 1 FROM property_values_v pv, ${elementsSql} je
      WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
        AND pv.${column} IS NOT NULL AND je.value IN (${placeholders}))`,
    params: [propertyId, ...values],
  };
  return operator === 'any_of' ? any : { sql: `NOT ${any.sql}`, params: any.params };
}

/**
 * Клауза условия по свойству-связи (`value_type: 'link'`, задача 20effcbd,
 * требование 9f42fc25) — транслируется в запрос по рёбрам (`links_v`), а не
 * по `property_values`: значения свойства-связи там не хранятся (ADR
 * «свойство-связь — проекция ребра»). Направление свойства (`out`/`in`) и
 * тип связи/структурность читаются из `config` тем же кодом, что использует
 * чтение карточки (`property-service.linkPropertyDirection` и соседи) —
 * единая точка интерпретации.
 *
 * Операторы:
 *   * `eq`/`ne` со строкой — «связь с конкретной целью» (id мысли);
 *   * `eq`/`ne` с boolean — «связь такого типа есть/отсутствует» независимо
 *     от цели (`eq true` / `ne false` — есть; `eq false` / `ne true` — нет);
 *   * `any_of`/`all_of`/`none_of` — набор целей рёбер против перечисленных id.
 *
 * Работает в обе стороны: `direction: 'in'` считает рёбра, где владелец —
 * цель (`l.target_id = t.id`), сравнение идёт по `l.source_id`.
 */
function linkPropertyClause(
  def: RegistryPropertyRow,
  cond: PropertyQueryCondition,
  requestId?: string,
): Clause {
  const config = parsePropertyConfig(def.config);
  const structural = isStructuralLinkProperty(config);
  const linkTypeId = structural ? null : linkPropertyLinkTypeId(config);
  if (!structural && linkTypeId === null) {
    // Свойство-связь без корректного config (валидируется при правке
    // онтологии — сюда не должно доходить) — условие не матчит ничего.
    return { sql: '0', params: [] };
  }
  const direction: LinkPropertyDirection = linkPropertyDirection(config);
  const ownerCol = direction === 'out' ? 'source_id' : 'target_id';
  const targetCol = direction === 'out' ? 'target_id' : 'source_id';
  const typeSql = linkTypeId === null ? 'l.type_id IS NULL' : 'l.type_id = ?';
  const typeParams = linkTypeId === null ? [] : [linkTypeId];
  const existsSql = (extraSql: string, extraParams: unknown[]): Clause => ({
    sql: `EXISTS (
      SELECT 1 FROM links_v l
      WHERE l.${ownerCol} = t.id AND ${typeSql} AND l.active = 1 AND l.marked_for_deletion = 0${extraSql})`,
    params: [...typeParams, ...extraParams],
  });

  switch (cond.operator) {
    case 'eq':
    case 'ne': {
      const value = cond.value;
      if (typeof value === 'boolean') {
        const presence = existsSql('', []);
        const wantPresent = cond.operator === 'eq' ? value : !value;
        return wantPresent ? presence : { sql: `NOT ${presence.sql}`, params: presence.params };
      }
      if (typeof value !== 'string' || value === '') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Значение условия по свойству-связи для eq/ne должно быть id мысли (строка) или boolean.',
          { field: 'value' },
          requestId,
        );
      }
      const specific = existsSql(` AND l.${targetCol} = ?`, [value]);
      return cond.operator === 'eq'
        ? specific
        : { sql: `NOT ${specific.sql}`, params: specific.params };
    }
    case 'any_of':
    case 'none_of': {
      const ids = coerceValueList(cond.value, cond.operator, requestId);
      const placeholders = ids.map(() => '?').join(',');
      const any = existsSql(` AND l.${targetCol} IN (${placeholders})`, ids);
      return cond.operator === 'any_of' ? any : { sql: `NOT ${any.sql}`, params: any.params };
    }
    case 'all_of': {
      const ids = coerceValueList(cond.value, cond.operator, requestId);
      const parts: string[] = [];
      const params: unknown[] = [];
      for (const id of ids) {
        const one = existsSql(` AND l.${targetCol} = ?`, [id]);
        parts.push(one.sql);
        params.push(...one.params);
      }
      return { sql: parts.join(' AND '), params };
    }
    default:
      // Недостижимо — SUPPORTED_OPS['link'] ограничивает набор операторов выше.
      throw new EtnError(
        'VALIDATION_ERROR',
        `Операция ${cond.operator} недопустима для свойства-связи.`,
        { field: 'operator' },
        requestId,
      );
  }
}

/**
 * Build one property-condition clause for a batch of conditions.
 *
 * All addressed registry properties are read in one `SELECT … IN (…)` call —
 * a missing property (deleted after the filter was saved) skips the
 * condition. The storage column is fixed by the property's `value_type`; the
 * supplied value's runtime type is only used to coerce it to the right SQL
 * scalar form.
 *
 * Conditions without a resolved `property_id` (e.g. when a caller passed
 * `property` instead of `property_id` but the resolver has not yet run)
 * are skipped — this matches the "no match" semantics of an unknown id and
 * keeps {@link queryThoughts} safe under mixed-style requests.
 */
function propertyClauses(
  ndb: NetworkDb,
  conds: PropertyQueryCondition[],
  requestId?: string,
): Clause[] {
  if (conds.length === 0) return [];
  // One batched registry read (N conditions → 1 query).
  const ids = [...new Set(
    conds
      .map((c) => c.property_id)
      .filter((id): id is string => typeof id === 'string'),
  )];
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(
      `SELECT id, name, value_type, config FROM properties_v WHERE id IN (${placeholders})`,
    )
    .all(...ids) as RegistryPropertyRow[];
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  const out: Clause[] = [];
  for (const cond of conds) {
    if (cond.property_id === undefined) continue;
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

    // Свойство-связь (задача 20effcbd): условие переводится в запрос по
    // рёбрам, а не по `property_values` — значения там не хранятся.
    if (valueType === 'link') {
      out.push(linkPropertyClause(def, cond, requestId));
      continue;
    }

    const column = VALUE_COLUMN[valueType];

    // Операторы наборов (задача 20effcbd) — `url` с `config.multiple`:
    // значение может быть одиночным скаляром или JSON-массивом (§3.5) —
    // {@link multipleValueSetClause} раскрывает обе формы.
    if (cond.operator === 'any_of' || cond.operator === 'all_of' || cond.operator === 'none_of') {
      out.push(multipleValueSetClause(def.id, column, cond.operator, cond.value, requestId));
      continue;
    }

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

/**
 * Coerce a wire value to the SQL scalar form its `value_*` column expects.
 * Only reached for `eq`/`ne`/`gt`/`gte`/`lt`/`lte` on non-`link` properties —
 * `any_of`/`all_of`/`none_of` (array `value`) and `link` (own clause builder)
 * are handled before this call, so `value` is always a scalar here despite
 * the wire type allowing an array too.
 */
function coerceScalar(
  valueType: PropertyValueType,
  value: PropertyQueryCondition['value'],
  requestId?: string,
): string | number {
  if (Array.isArray(value)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Значение свойства ${valueType} не может быть массивом для этого оператора.`,
      { field: 'value' },
      requestId,
    );
  }
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
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `Значение свойства ${valueType} должно быть строкой.`,
          { field: 'value' },
          requestId,
        );
      }
      return value;
    case 'link':
      // Недостижимо (SUPPORTED_OPS['link'] пуст), но для полноты.
      throw new EtnError(
        'VALIDATION_ERROR',
        'Свойство-связь не фильтруется скалярным оператором.',
        { field: 'value' },
        requestId,
      );
    case 'thought_ref':
      // Legacy (миграция 040): в живой БД таких свойств не остаётся;
      // SUPPORTED_OPS['thought_ref'] пуст, сюда попасть нельзя — но
      // для полноты switch.
      throw new EtnError(
        'VALIDATION_ERROR',
        'Свойство thought_ref упразднено (миграция 040).',
        { field: 'value' },
        requestId,
      );
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

  // Резолв имён в id (задача d5ab1630 «Типы и свойства адресуются именами
  // во всех фильтрах MCP»). Вызывающий код MCP-фасада тоже резолвит — здесь
  // мы оставляем второй проход для прямых вызовов из REST (где `type` и
  // `property` могут прийти из сохранённых фильтров). Идемпотентно: если
  // `type` не задан (MCP уже отрезолвил) — никакой работы.
  const resolvedTypeIds: string[] = [];
  if (request.type !== undefined) {
    for (const name of request.type) {
      resolvedTypeIds.push(resolveThoughtTypeIdByName(ndb, name));
    }
  }
  const allTypeIds = [...(request.type_id ?? []), ...resolvedTypeIds];

  const resolvedProperties: PropertyQueryCondition[] = [];
  if (request.properties !== undefined) {
    for (const cond of request.properties) {
      if (cond.property !== undefined) {
        if (cond.property_id !== undefined) {
          // Взаимоисключающая пара — MCP-валидация уже отклонила бы такой
          // запрос, но защищаемся и здесь. Если всё же пришло — игнорируем
          // именованную форму и оставляем id (MCP-уровень выдаст 422 раньше).
          resolvedProperties.push(cond);
          continue;
        }
        const id = resolvePropertyIdByName(ndb, cond.property);
        resolvedProperties.push({ ...cond, property_id: id });
        continue;
      }
      if (cond.property_id !== undefined) {
        resolvedProperties.push(cond);
        continue;
      }
      // Без идентификации свойства — пропускаем условие (no-match).
    }
  }

  const walk = walkSubtree(ndb, request.in_subtree_of, {
    maxDepth,
    maxNodes: bounds.maxNodes,
    linkFilter: request.link_filter,
  });

  const active: ThoughtQueryActive = request.active ?? 'true';
  const trashed = request.trashed ?? 'false';
  const clauses: Array<Clause | null> = [
    // L21: a selected parent type matches its whole subtree (OR semantics).
    inListClause('t.type_id', expandTypeIdsToSubtree(ndb, 'thought_types', allTypeIds)),
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
    // Задача 59119797 «Фильтры Автор/Редактор»: прямое сравнение по
    // колонкам `thoughts.created_by`/`thoughts.updated_by` (миграция 033).
    // Пустая строка и отсутствие равнозначны — фильтр не применяется.
    typeof request.author_id === 'string' && request.author_id.trim() !== ''
      ? { sql: 't.created_by = ?', params: [request.author_id] }
      : null,
    typeof request.editor_id === 'string' && request.editor_id.trim() !== ''
      ? { sql: 't.updated_by = ?', params: [request.editor_id] }
      : null,
  ];
  if (resolvedProperties.length > 0) {
    for (const c of propertyClauses(ndb, resolvedProperties)) clauses.push(c);
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
