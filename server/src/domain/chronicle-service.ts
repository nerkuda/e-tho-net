/**
 * «Хроника» domain service (L20, docs/03-server-api.md §20).
 *
 * Two-phase query for the chronicle workspace view:
 *   1. select **thoughts** — roots from the «мысли» field, optionally expanded
 *      with their undirected subordinates up to {@link TRAVERSAL_DEFAULTS.MAX_DEPTH}
 *      levels, then filtered by thought types and the keywords mini-syntax
 *      (`*`/`-`, searched in titles, synonyms, and the texts of the thoughts'
 *      permanent comments and of their incident links' comments on both sides);
 *   2. list **chronological comments** attached to the selected thoughts or to
 *      their links (link types / link scope filter) OR matching the keywords in
 *      their OWN body/title (0.10.1, T7 — так сужаются и записи дня на HOME),
 *      intersected with the requested date range, sorted by record class,
 *      `valid_from`, `valid_to`, `created_at`, `id` and paged.
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
  STRUCTURE_AUTHOR_OPS,
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
  type StructureAuthorOp,
  type StructureKeywordScope,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { makeSnippet } from './search-service.js';
import { rowToThoughtRef } from './thought-service.js';
import { buildThoughtIdSelect, REF_COLUMNS, structureRequestToQuery } from './query-service.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';
import { normaliseInstant } from './dates.js';
import { isFilterEmpty, parseStructureFilter } from './structure-service.js';
import { resolveGlobalDateTokens, scanStringForTokens } from './thought-type-view-tokens.js';

/** Row shape accepted by {@link rowToThoughtRef}. */
type ThoughtRefRow = Parameters<typeof rowToThoughtRef>[0];

/** Build a `placeholders` string of `n` `?`. */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Parse the `date_from`/`date_to` fields (empty/absent → `undefined`).
 *
 * Значение — полный UTC-инстанс, «голая дата» (= сутки UTC) или динамический
 * токен дат (`$today`/`$now`, арифметика `±Nd`; требование 91f8d8dd).
 * «Голая дата» приводится к полному UTC-инстансу сразу (0.10.1, требование
 * 469d8d69): `date_from` берёт начало дня (`00:00:00.000Z`), `date_to` — конец
 * (`23:59:59.999Z`), границы включительные. Токен СОХРАНЯЕТСЯ как есть
 * (не раскрывается при сохранении отбора) и раскрывается в момент применения
 * в {@link resolvePeriodField}; в периоде допустимы только глобальные токены
 * (контекста мысли у периода нет) — остальные отвергаются `VALIDATION_ERROR`.
 */
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
  const trimmed = raw.trim();
  const { known, unknown } = scanStringForTokens(trimmed);
  if (unknown.length > 0) {
    throw new EtnError('VALIDATION_ERROR', `${field}: неизвестный токен «${unknown[0]!.raw}».`, {
      field,
      token: unknown[0]!.raw,
    }, requestId);
  }
  if (known.length > 0) {
    const bad = known.find((t) => t.kind !== 'global');
    if (bad !== undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `${field}: токен «${bad.raw}» требует контекста мысли и в периоде недопустим.`,
        { field, token: bad.raw },
        requestId,
      );
    }
    return trimmed;
  }
  return normaliseInstant(trimmed, field, field === 'date_from' ? 'start' : 'end') ?? undefined;
}

/**
 * Раскрыть токены периода (`$today`/`$now`, арифметика) в момент применения
 * отбора и привести результат к полному UTC-инстансу (требование 91f8d8dd).
 * Значение без токенов уже нормализовано на разборе — возвращается как есть.
 */
function resolvePeriodField(
  value: string | null | undefined,
  field: 'date_from' | 'date_to',
  now?: () => Date,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const { known, unknown } = scanStringForTokens(value);
  if (known.length === 0 && unknown.length === 0) return value;
  const { value: resolved, unresolved } = resolveGlobalDateTokens(
    value,
    now === undefined ? {} : { now },
  );
  if (unresolved.length > 0) {
    throw new EtnError('VALIDATION_ERROR', `${field}: ${unresolved[0]!.message}`, {
      field,
      token: unresolved[0]!.token,
    });
  }
  return (
    normaliseInstant(resolved, field, field === 'date_from' ? 'start' : 'end') ?? undefined
  );
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

  // Область поиска ключевых слов (0.10.1, элемент 2f14de06/91f8d8dd): чекбоксы
  // «наименование/синонимы/комментарий». Пустой набор/отсутствие — поиск по
  // всем областям (поведение до 0.10.1).
  const keywordScope = body['keyword_scope'];
  if (keywordScope !== undefined) {
    if (
      !Array.isArray(keywordScope) ||
      keywordScope.some((v) => v !== 'title' && v !== 'synonyms' && v !== 'comment')
    ) {
      throw new EtnError('VALIDATION_ERROR', 'Недопустимый keyword_scope.', {
        field: 'keyword_scope',
        allowed: ['title', 'synonyms', 'comment'],
      }, requestId);
    }
    if (keywordScope.length > 0) {
      filter.keyword_scope = [...new Set(keywordScope)] as StructureKeywordScope[];
    }
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

  // Критерии целей записи (0.10.1, требование 306f74cc) — тот же набор, что у
  // панели «Структур»: разбираем общим доменным парсером, чтобы модель
  // критериев не дублировалась. Запись проходит, если хотя бы одна её
  // привязанная мысль удовлетворяет (см. `buildRowsWhere`).
  const targets = body['targets'];
  if (targets !== undefined) {
    if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) {
      throw new EtnError('VALIDATION_ERROR', 'targets должен быть объектом критериев.', {
        field: 'targets',
      }, requestId);
    }
    const parsedTargets = parseStructureFilter(targets as Record<string, unknown>, requestId);
    if (!isFilterEmpty(parsedTargets)) filter.targets = parsedTargets;
  }

  const dateFrom = parseDateField(body, 'date_from', requestId);
  if (dateFrom !== undefined) filter.date_from = dateFrom;
  const dateTo = parseDateField(body, 'date_to', requestId);
  if (dateTo !== undefined) filter.date_to = dateTo;

  // Режим полей периода панели «Дневника» (0.10.1, приёмка №2). На выборку не
  // влияет — хранится в определении сохранённого отбора, чтобы применение
  // восстановило «Пресеты»/«Даты»; значения-токены раскрываются отдельно.
  const dateMode = body['date_mode'];
  if (dateMode !== undefined) {
    if (dateMode !== 'presets' && dateMode !== 'dates') {
      throw new EtnError('VALIDATION_ERROR', 'Недопустимый date_mode.', {
        field: 'date_mode',
        allowed: ['presets', 'dates'],
      }, requestId);
    }
    filter.date_mode = dateMode;
  }

  // Фильтры авторства (задача 59119797, эволюция операторов): id
  // пользователя и оператор, применяется к колонкам `comments.created_by` /
  // `comments.updated_by` (миграция 033). Пустая строка и отсутствие
  // равнозначны — фильтр не применяется.
  for (const field of ['created_by', 'updated_by'] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    const op = parseChronicleAuthorOp(body[`${field}_op`], requestId);
    const parsed = parseChronicleAuthorValue(raw, op, requestId);
    if (parsed === undefined) continue;
    filter[field] = parsed;
    if (op !== 'eq') filter[`${field}_op`] = op;
  }

  return filter;
}

/** Parse the `*_op` of a chronicle author filter; defaults to `eq` when absent. */
function parseChronicleAuthorOp(raw: unknown, requestId?: string): StructureAuthorOp {
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
 * Same as the structure-service parser but local — chronicle has its own
 * module-private copy to avoid a cross-module export (задача 59119797).
 */
function parseChronicleAuthorValue(
  raw: unknown,
  op: StructureAuthorOp,
  requestId?: string,
): string | string[] | undefined {
  if (op === 'empty' || op === 'not_empty') return undefined;
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

/** Appends a chronicle author-condition WHERE clause (задача 59119797). */
function appendChronicleAuthorCondition(
  conds: string[],
  args: unknown[],
  column: string,
  value: string | string[] | undefined,
  op: StructureAuthorOp | undefined,
): void {
  const effective = op ?? 'eq';
  if (effective === 'empty') {
    conds.push(`${column} IS NULL`);
    return;
  }
  if (effective === 'not_empty') {
    conds.push(`${column} IS NOT NULL`);
    return;
  }
  if (value === undefined) return;
  if (effective === 'in' || effective === 'not_in') {
    const ids = Array.isArray(value) ? value : [value];
    const placeholders = ids.map(() => '?').join(',');
    conds.push(
      effective === 'in'
        ? `${column} IN (${placeholders})`
        : `${column} NOT IN (${placeholders})`,
    );
    args.push(...ids);
    return;
  }
  if (effective === 'ne') {
    conds.push(`(${column} IS NULL OR ${column} <> ?)`);
    args.push(value);
    return;
  }
  conds.push(`${column} = ?`);
  args.push(value);
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
    .prepare(`SELECT id FROM thoughts_v WHERE id IN (${placeholders(roots.length)})`)
    .all(...roots) as Array<{ id: string }>;
  const ids = new Set(rootRows.map((r) => r.id));
  if (ids.size === 0) return [];
  if (request.include_subtree !== true) return [...ids];

  const rows = ndb
    .prepare(
      `WITH RECURSIVE
        descend(id, depth) AS (
          SELECT t.id, 0
          FROM thoughts_v t
          WHERE t.id IN (${placeholders(ids.size)})
          UNION
          SELECT l.target_id, d.depth + 1
          FROM descend d
          JOIN links_v l ON l.source_id = d.id AND l.active = 1
          WHERE d.depth < ?
        )
       SELECT DISTINCT id FROM descend`,
    )
    .all(...ids, TRAVERSAL_DEFAULTS.MAX_DEPTH) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Keywords condition for one word against a thought: the thought's own title,
 * its synonyms, its **permanent** comment and the comment texts of its incident
 * links on both sides.
 *
 * Хронологические комментарии мысли здесь НЕ ищутся (0.10.1, T7): совпадение в
 * теле записи должно отбирать саму запись, а не её цель. Иначе для записи дня
 * (единственная цель — HOME) слово в теле выбирало бы корень и возвращало все
 * его записи. Поиск по телам/заголовкам записей делает {@link RECORD_KEYWORD_COND}
 * в фазе 2.
 *
 * Область (`keyword_scope`) сужает набор сравнений (0.10.1): `comment` —
 * постоянный комментарий мысли и комментарии её связей. Отсутствие области —
 * все сравнения (поведение до 0.10.1).
 */
function thoughtKeywordCond(scope: StructureKeywordScope[] | undefined): {
  sql: string;
  argCount: number;
} {
  const enabled = (name: StructureKeywordScope): boolean =>
    scope === undefined || scope.length === 0 || scope.includes(name);
  const parts: string[] = [];
  if (enabled('title')) parts.push(`t.title_norm LIKE ? ESCAPE '\\'`);
  if (enabled('synonyms')) {
    parts.push(`EXISTS (
  SELECT 1 FROM thought_synonyms_v ts
  WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'
)`);
  }
  if (enabled('comment')) {
    parts.push(`EXISTS (
  SELECT 1 FROM comments_v c1
  JOIN comment_targets_v ct1 ON ct1.comment_id = c1.id AND ct1.owner_type = 'thought'
  WHERE ct1.owner_id = t.id AND c1.kind = 'permanent' AND unicode_lower(c1.body_md) LIKE ? ESCAPE '\\'
)`);
    parts.push(`EXISTS (
  SELECT 1 FROM comments_v c2
  JOIN comment_targets_v ct2 ON ct2.comment_id = c2.id AND ct2.owner_type = 'link'
  JOIN links_v l2 ON l2.id = ct2.owner_id AND (l2.source_id = t.id OR l2.target_id = t.id)
  WHERE unicode_lower(c2.body_md) LIKE ? ESCAPE '\\'
)`);
  }
  if (parts.length === 0) parts.push(`t.title_norm LIKE ? ESCAPE '\\'`);
  return { sql: `(${parts.join(' OR ')})`, argCount: parts.length };
}

/**
 * Keywords condition for one word against the RECORD itself (0.10.1, T7):
 * тело и заголовок хроно-комментария. Это и есть «поиск фильтрует ленту» —
 * запись проходит по собственному тексту независимо от того, попала ли в
 * отбор её мысль-цель (иначе записи дня на HOME не сужались бы).
 */
const RECORD_KEYWORD_COND = `(unicode_lower(c.body_md) LIKE ? ESCAPE '\\' OR unicode_lower(IFNULL(c.title, '')) LIKE ? ESCAPE '\\')`;

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
  scope?: StructureKeywordScope[],
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
  const cond = thoughtKeywordCond(scope);
  for (const word of includeWords) {
    // `toLowerCase()` — LIKE в SQLite регистронезависим только для ASCII, а
    // `title_norm`/`synonym_norm`/`unicode_lower(body_md)` уже в нижнем
    // регистре: без нормализации слова кириллица в другом регистре не
    // матчилась (ошибка 2f27f244). Тот же приём, что в query-service.
    const pattern = buildLikePattern(word.toLowerCase());
    where.push(cond.sql);
    for (let i = 0; i < cond.argCount; i += 1) args.push(pattern);
  }
  for (const word of excludeWords) {
    const pattern = buildLikePattern(word.toLowerCase());
    where.push(`NOT ${cond.sql}`);
    for (let i = 0; i < cond.argCount; i += 1) args.push(pattern);
  }
  const sql = `SELECT t.id FROM thoughts_v t ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`;
  const rows = ndb.prepare(sql).all(...args) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Period-intersection SQL for `valid_from` (upper bound of the requested
 * period). Границы уже приведены к полным UTC-инстансам (`date_to` — конец
 * суток для «голой даты»), поэтому достаточно прямого сравнения — прежний
 * LIKE-костыль под date-only не нужен (0.10.1).
 */
function validFromUpperCond(dateTo: string): [string, string[]] {
  return ['c.valid_from <= ?', [dateTo]];
}

/** Period-intersection SQL for `valid_to` (lower bound of the requested period). */
function validToLowerCond(dateFrom: string): [string, string[]] {
  // `valid_to IS NULL` оставлен страховкой для постоянных/наследных строк;
  // у хронологических после 0.10.1 окончание всегда заполнено.
  return ['(c.valid_to IS NULL OR c.valid_to >= ?)', [dateFrom]];
}

/**
 * Attachment condition for a set of selected thought ids: the comment is
 * attached to one of them, or to a link whose endpoint (per `link_scope`) is.
 */
function attachmentCond(
  ndb: NetworkDb,
  ids: string[],
  request: ChronicleQueryRequest,
  args: unknown[],
): string {
  const parts: string[] = [
    `EXISTS (SELECT 1 FROM comment_targets_v ct
             WHERE ct.comment_id = c.id AND ct.owner_type = 'thought'
               AND ct.owner_id IN (${placeholders(ids.length)}))`,
  ];
  args.push(...ids);

  const scope = request.link_scope ?? 'both';
  const endpointConds: string[] = [];
  if (scope === 'sources' || scope === 'both') {
    endpointConds.push(`l.source_id IN (${placeholders(ids.length)})`);
    args.push(...ids);
  }
  if (scope === 'targets' || scope === 'both') {
    endpointConds.push(`l.target_id IN (${placeholders(ids.length)})`);
    args.push(...ids);
  }
  let linkCond = `EXISTS (SELECT 1 FROM comment_targets_v ctl
    JOIN links_v l ON l.id = ctl.owner_id AND ctl.owner_type = 'link'
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
  parts.push(linkCond);
  return `(${parts.join(' OR ')})`;
}

/**
 * «У записи есть хоть одна привязка» — дешёвая замена перебора всех id, когда
 * структурный отбор мыслей не сужен (нет `thought_ids`/`type_ids`): тот же
 * результат, но без огромного `IN (…)` в списке параметров.
 */
function anyAttachmentCond(): string {
  return `EXISTS (SELECT 1 FROM comment_targets_v cta WHERE cta.comment_id = c.id)`;
}

/**
 * Текстовое условие по телу и заголовку САМОЙ записи (0.10.1, T7): каждое
 * включающее слово обязано встретиться, ни одно исключающее — нет.
 * `null` — слов нет.
 */
function recordTextCond(
  includeWords: string[],
  excludeWords: string[],
  args: unknown[],
): string | null {
  const parts: string[] = [];
  for (const word of includeWords) {
    const pattern = buildLikePattern(word.toLowerCase());
    parts.push(RECORD_KEYWORD_COND);
    args.push(pattern, pattern);
  }
  for (const word of excludeWords) {
    const pattern = buildLikePattern(word.toLowerCase());
    parts.push(`NOT ${RECORD_KEYWORD_COND}`);
    args.push(pattern, pattern);
  }
  return parts.length > 0 ? parts.join(' AND ') : null;
}

/**
 * Phase 2 WHERE shared by the count and the page queries.
 *
 * `scopeIds` — мысли структурного отбора (без ключевых слов); `keywordIds` —
 * мысли, прошедшие мыслевой путь ключевых слов (пусто, если ни одна не
 * прошла). Записи отбираются как объединение: (путь А, только при включающих
 * словах) привязанные к `keywordIds`, ИЛИ (путь Б) привязанные к области
 * отбора И совпавшие по собственному тексту (включающие есть / исключающих
 * нет). Чисто исключающие слова работают только путём Б — по тексту записи.
 */
function buildRowsWhere(
  ndb: NetworkDb,
  userId: string,
  scopeIds: string[],
  keywordIds: string[],
  scopeRestricted: boolean,
  includeWords: string[],
  excludeWords: string[],
  request: ChronicleQueryRequest,
): { cond: string; args: unknown[] } {
  const conds: string[] = ["c.kind = 'chronological'"];
  const args: unknown[] = [];

  // Порядок вызовов = порядок `?` в итоговом SQL. Мыслевой путь (А) — только
  // при включающих словах: чисто исключающие слова работают по тексту записи
  // (путь Б), иначе прежнее «вычитание мыслей» возвращало бы записи их соседей.
  const parts: string[] = [];
  if (includeWords.length > 0 && keywordIds.length > 0) {
    parts.push(attachmentCond(ndb, keywordIds, request, args));
  }
  if (includeWords.length > 0 || excludeWords.length > 0) {
    const text = recordTextCond(includeWords, excludeWords, args);
    if (text !== null) {
      const attach = scopeRestricted
        ? attachmentCond(ndb, scopeIds, request, args)
        : anyAttachmentCond();
      parts.push(`(${text} AND ${attach})`);
    }
  }
  if (parts.length > 0) {
    // Скобки обязательны: без них `kind='chronological' AND A OR B` разбирается
    // как `(kind AND A) OR B`, и путь Б (текст записи) вернул бы в ленту
    // постоянные комментарии (дефект приёмки 0.10.1).
    conds.push(`(${parts.join(' OR ')})`);
  } else if (scopeIds.length > 0) {
    conds.push(
      scopeRestricted ? attachmentCond(ndb, scopeIds, request, args) : anyAttachmentCond(),
    );
  } else {
    conds.push('0');
  }

  // Критерии целей (0.10.1, требование 306f74cc): запись проходит, если ХОТЯ
  // БЫ ОДНА её привязанная мысль (`comment_targets`, включая вторичные)
  // удовлетворяет критериям набора «Структур». Критерии строит единый движок
  // выборки мыслей (`buildThoughtIdSelect`) — модель не дублируется; здесь
  // подзапрос встраивается в `IN`, поэтому обход индексный по
  // `comment_targets.comment_id`, без N+1 по записям.
  if (request.targets !== undefined) {
    const targetSelect = buildThoughtIdSelect(
      ndb,
      userId,
      structureRequestToQuery({
        ...request.targets,
        sort: 'alpha',
        order: 'asc',
        limit: 1,
        offset: 0,
      }),
    );
    conds.push(
      `EXISTS (SELECT 1 FROM comment_targets_v cttg
         WHERE cttg.comment_id = c.id AND cttg.owner_type = 'thought'
           AND cttg.owner_id IN (${targetSelect.sql}))`,
    );
    args.push(...targetSelect.params);
  }

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

  // Фильтры авторства (задача 59119797, эволюция операторов): колонки
  // `comments.created_by` / `comments.updated_by`. Парсер отбрасывает
  // пустые значения, здесь же формируется WHERE по оператору.
  appendChronicleAuthorCondition(conds, args, 'c.created_by', request.created_by, request.created_by_op);
  appendChronicleAuthorCondition(conds, args, 'c.updated_by', request.updated_by, request.updated_by_op);

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
        `SELECT owner_type, owner_id FROM comment_targets_v WHERE comment_id = ?
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
      use_time: row.use_time === 1,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      snippet: row.snippet,
      body_html: row.body_html,
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
  /**
   * Полный HTML тела записи (0.10.1, приёмка №3): лента показывает запись
   * целиком, а не `snippet`.
   */
  body_html: string;
  valid_from: string;
  valid_to: string | null;
  /** 0/1 — флаг «учитывать время» (миграция 046). */
  use_time: number;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  snippet: string;
}

/**
 * Класс записи (0.10.1, требование c6ddc1ea): `0` — привязка только к HOME
 * («запись дня», все цели — корень сети), `1` — все прочие. Считается по
 * `comment_targets`: запись класса 0 не имеет ни одной цели, отличной от
 * корневой мысли (ни чужой мысли, ни связи).
 */
const RECORD_CLASS_SQL = `CASE WHEN EXISTS (
  SELECT 1 FROM comment_targets_v ct_class
  LEFT JOIN thoughts_v ht ON ht.id = ct_class.owner_id AND ct_class.owner_type = 'thought'
  WHERE ct_class.comment_id = c.id
    AND (ct_class.owner_type <> 'thought' OR ht.is_root <> 1)
) THEN 1 ELSE 0 END`;

/**
 * Run the two-phase chronicle query (docs/03-server-api.md §20).
 *
 * Phase 1 selects thoughts; phase 2 lists chronological comments attached to
 * them or to their links. Returns the paged rows with the total count.
 *
 * Сортировка (0.10.1, требование c6ddc1ea): класс записи → `valid_from` →
 * `valid_to` → `created_at` → `id`, все ключи в направлении `order`. Прежние
 * тайбрейкеры (NULL-обработка `valid_to`, `title`) отменены — порядок
 * детерминирован уникальным `id`.
 *
 * `opts.userId` — контекст исполнения критериев целей (движок выборки мыслей);
 * `opts.now` — часы для раскрытия токенов периода (тесты).
 */
export function queryChronicle(
  ndb: NetworkDb,
  request: ChronicleQueryRequest,
  opts: { userId?: string; now?: () => Date } = {},
): ChronicleQueryResponse {
  const userId = opts.userId ?? '';
  // Токены периода раскрываются в момент применения отбора (требование
  // 91f8d8dd), затем значения сравниваются как полные UTC-инстансы.
  const dateFrom = resolvePeriodField(request.date_from, 'date_from', opts.now);
  const dateTo = resolvePeriodField(request.date_to, 'date_to', opts.now);
  const resolved: ChronicleQueryRequest = { ...request };
  if (dateFrom !== undefined) resolved.date_from = dateFrom;
  if (dateTo !== undefined) resolved.date_to = dateTo;

  const { include: includeWords, exclude: excludeWords } = parseFilterKeywords(
    resolved.keywords ?? '',
  );
  const baseIds = collectRootAndSubtreeIds(ndb, resolved);
  const typeIds = resolved.type_ids ?? [];
  // Область структурного отбора (мысли без ключевых слов) — в неё обязан
  // попасть путь Б: «запись совпала по своему тексту».
  const scopeIds = selectThoughts(ndb, baseIds, typeIds, [], []);
  if (scopeIds.length === 0) {
    return { rows: [], total: 0 };
  }
  // Путь А: мысли, прошедшие мыслевой поиск (название, синонимы, постоянный
  // комментарий, комментарии связей), минус исключающие слова.
  let keywordIds = scopeIds;
  if (includeWords.length > 0 || excludeWords.length > 0) {
    keywordIds = selectThoughts(ndb, baseIds, typeIds, includeWords, [], resolved.keyword_scope);
    if (excludeWords.length > 0) {
      const excluded = new Set(
        selectThoughts(ndb, baseIds, typeIds, excludeWords, [], resolved.keyword_scope),
      );
      keywordIds = keywordIds.filter((id) => !excluded.has(id));
    }
  }
  const scopeRestricted = baseIds !== null || typeIds.length > 0;

  const { cond, args } = buildRowsWhere(
    ndb,
    userId,
    scopeIds,
    keywordIds,
    scopeRestricted,
    includeWords,
    excludeWords,
    resolved,
  );
  const dir = resolved.order === 'desc' ? 'DESC' : 'ASC';
  const totalRow = ndb
    .prepare(`SELECT COUNT(*) AS c FROM comments_v c WHERE ${cond}`)
    .get(...args) as { c: number };
  const total = totalRow.c;

  const rows = ndb
    .prepare(
      `SELECT c.id, c.owner_type, c.owner_id, c.title, c.body_md, c.valid_from, c.valid_to,
              c.body_html,
              c.use_time, c.version, c.created_at, c.updated_at, c.created_by, c.updated_by
       FROM comments_v c
       WHERE ${cond}
       ORDER BY ${RECORD_CLASS_SQL} ${dir},
                c.valid_from ${dir},
                c.valid_to ${dir},
                c.created_at ${dir},
                c.id ${dir}
       LIMIT ? OFFSET ?`,
    )
    .all(...args, resolved.limit, resolved.offset) as Row[];

  // Resolve targets: collect all thought ids and link ids of the page.
  const thoughtIds = new Set<string>();
  const linkIds = new Set<string>();
  for (const row of rows) {
    const targetRows = ndb
      .prepare('SELECT owner_type, owner_id FROM comment_targets_v WHERE comment_id = ?')
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
           FROM links_v l
           LEFT JOIN link_types_v lt ON lt.id = l.type_id
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
      .prepare(`SELECT ${REF_COLUMNS} FROM thoughts_v t WHERE t.id IN (${placeholders(uniqueRefIds.length)})`)
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
