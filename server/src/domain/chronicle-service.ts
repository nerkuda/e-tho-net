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
  CHRONICLE_LEGACY_KEYWORD_SCOPES,
  EtnError,
  FILTER_AST_VERSION,
  HIERARCHY_SUBTREE_MAX_NODES,
  SORT_ORDERS,
  STRUCTURE_AUTHOR_OPS,
  STRUCTURE_KEYWORD_SCOPES,
  TRAVERSAL_DEFAULTS,
  buildLikePattern,
  commentScopeEnabled,
  parseFilterKeywords,
  type ChronicleFilter,
  type ChronicleFilterDefinition,
  type ChronicleLinkScope,
  type ChronicleQueryRequest,
  type ChronicleQueryResponse,
  type ChronicleRow,
  type ChronicleTarget,
  type ChronicleTargetLink,
  type FilterAst,
  type FilterAstLeaf,
  type FilterAstListItem,
  type FilterAstNode,
  type FilterAstValue,
  type FilterDiagnostic,
  type SortOrder,
  type StructureAuthorOp,
  type StructureKeywordScope,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { makeSnippet } from './search-service.js';
import { rowToThoughtRef } from './thought-service.js';
import { buildThoughtIdSelect, compileThoughtQueryToAst, diaryKeywordClause, REF_COLUMNS, structureRequestToQuery } from './query-service.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';
import { collectHierarchySubtree } from './graph-traversal.js';
import { normaliseInstant } from './dates.js';
import { isFilterEmpty, parseStructureFilter } from './structure-service.js';
import { parseFilterAst } from './filter-ast.js';
import { assertFilterAstInProfile } from './filter-profile-validation.js';
import { diagnoseFilterAst, filterDiagnosticsError } from './filter-diagnostics.js';
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
 * `extra` несёт контекст профиля хроники (требование 0095daad, ADR 0c02ab4f):
 * первый день недели сети (иначе `$weekStart` считается от понедельника) и
 * гранулярность времени (`withTime: true` — хроника несёт время).
 */
function resolvePeriodField(
  value: string | null | undefined,
  field: 'date_from' | 'date_to',
  now?: () => Date,
  extra?: { firstDayOfWeek?: number; withTime?: boolean },
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const { known, unknown } = scanStringForTokens(value);
  if (known.length === 0 && unknown.length === 0) return value;
  const { value: resolved, unresolved } = resolveGlobalDateTokens(value, {
    ...(now === undefined ? {} : { now }),
    ...(extra?.firstDayOfWeek !== undefined ? { firstDayOfWeek: extra.firstDayOfWeek } : {}),
    ...(extra?.withTime !== undefined ? { withTime: extra.withTime } : {}),
  });
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

  // AST-тело профиля «хроника» (задача 4752b065): XOR с плоскими критериями —
  // либо AST, либо плоские поля. Пагинация/`order`/`date_mode` (режим полей
  // панели, на выборку не влияет) допустимы с обеими формами.
  const astRaw = body['ast'];
  if (astRaw !== undefined && astRaw !== null) {
    const flatPresent = CHRONICLE_FLAT_FIELDS.filter((f) => body[f] !== undefined);
    if (flatPresent.length > 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'AST-тело (`ast`) несовместимо с плоскими критериями отбора.',
        { field: 'ast', conflicts: flatPresent },
        requestId,
      );
    }
    filter.ast = parseChronicleAst(astRaw, requestId);
  }

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
  // «наименование/синонимы/комментарий» + «дневники» (0.13.1, ошибка 2bc251de).
  // Пустой набор/отсутствие — ИСТОРИЧЕСКОЕ множество областей (title, synonyms,
  // comment), поведение до 0.10.1; новые области включаются только явно.
  // Словарь — ОДИН: shared-константа (требование 9e9d14dc — словарь закрытый),
  // локальная копия списка разъехалась бы с ней по составу областей.
  const keywordScope = body['keyword_scope'];
  if (keywordScope !== undefined) {
    if (
      !Array.isArray(keywordScope) ||
      keywordScope.some(
        (v) => typeof v !== 'string' || !(STRUCTURE_KEYWORD_SCOPES as readonly string[]).includes(v),
      )
    ) {
      throw new EtnError('VALIDATION_ERROR', 'Недопустимый keyword_scope.', {
        field: 'keyword_scope',
        allowed: STRUCTURE_KEYWORD_SCOPES,
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
  // привязанная мысль удовлетворяет (см. операнд «Цели» в {@link compileChronicleToAst}).
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

/** Поля плоской формы хроники — несовместимы с AST-телом (XOR). */
const CHRONICLE_FLAT_FIELDS = [
  'keywords',
  'keyword_scope',
  'thought_ids',
  'include_subtree',
  'type_ids',
  'link_type_ids',
  'link_scope',
  'targets',
  'date_from',
  'date_to',
  'created_by',
  'updated_by',
  'created_by_op',
  'updated_by_op',
] as const;

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
  const limit = parseChronicleLimit(body, requestId);
  const offset = parseChronicleOffset(body, requestId);
  return { ...filter, order, limit, offset };
}

/** Parse `limit` of a chronicle query (default {@link CHRONICLE_PAGE_SIZE}). */
function parseChronicleLimit(body: Record<string, unknown>, requestId: string): number {
  const limitRaw = body['limit'];
  const limit =
    typeof limitRaw === 'number' && Number.isInteger(limitRaw)
      ? limitRaw
      : CHRONICLE_PAGE_SIZE;
  if (limit < 1 || limit > CHRONICLE_QUERY_MAX_LIMIT) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `limit должен быть целым числом 1..${CHRONICLE_QUERY_MAX_LIMIT}.`,
      { field: 'limit' },
      requestId,
    );
  }
  return limit;
}

/** Parse `offset` of a chronicle query (default 0). */
function parseChronicleOffset(body: Record<string, unknown>, requestId: string): number {
  const offsetRaw = body['offset'];
  const offset =
    typeof offsetRaw === 'number' && Number.isInteger(offsetRaw) ? offsetRaw : 0;
  if (offset < 0) {
    throw new EtnError('VALIDATION_ERROR', 'offset должен быть целым числом ≥ 0.', {
      field: 'offset',
    }, requestId);
  }
  return offset;
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
 * его записи. Поиск по телам/заголовкам записей делает {@link recordMatchesClause}
 * через операнды `record_body`/`record_title`.
 *
 * Область (`keyword_scope`) сужает набор сравнений (0.10.1): `comment` —
 * постоянный комментарий мысли и комментарии её связей; `diary` — дневниковые
 * записи самой мысли (тело/заголовок её хроно-записи, 0.13.1, ошибка 2bc251de).
 * Отсутствие области — ИСТОРИЧЕСКОЕ множество областей
 * ({@link CHRONICLE_LEGACY_KEYWORD_SCOPES} — title/synonyms/comment, поведение
 * до 0.10.1): новые области включаются только явным набором, иначе старый отбор
 * молча расширил бы выборку.
 */
function thoughtKeywordCond(scope: StructureKeywordScope[] | undefined): {
  sql: string;
  argCount: number;
} {
  const legacyAll = scope === undefined || scope.length === 0;
  const enabled = (name: StructureKeywordScope): boolean =>
    legacyAll
      ? (CHRONICLE_LEGACY_KEYWORD_SCOPES as readonly string[]).includes(name)
      : scope.includes(name);
  const parts: string[] = [];
  let argCount = 0;
  if (enabled('title')) {
    parts.push(`t.title_norm LIKE ? ESCAPE '\\'`);
    argCount += 1;
  }
  if (enabled('synonyms')) {
    parts.push(`EXISTS (
  SELECT 1 FROM thought_synonyms_v ts
  WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'
)`);
    argCount += 1;
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
    argCount += 2;
  }
  if (enabled('diary')) {
    // Дневниковые записи мысли (ошибка 2bc251de, требование 0882f8d5): предикат —
    // ОБЩИЙ с листом AST «Есть слова» (`diaryKeywordClause`), иначе области
    // разъехались бы между плоским телом и AST-путём.
    const diary = diaryKeywordClause('t');
    parts.push(diary.sql);
    argCount += diary.paramCount;
  }
  if (parts.length === 0) {
    parts.push(`t.title_norm LIKE ? ESCAPE '\\'`);
    argCount += 1;
  }
  return { sql: `(${parts.join(' OR ')})`, argCount };
}

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
 * Одна точка правды для гейта пути Б (текст/заголовок записи) — предикат живёт
 * в `@etn/shared` (chronicle-keywords.ts) вместе с конструктором группы панели
 * «Дневника»; ре-экспорт сохранён ради прежней поверхности домена.
 */
export { commentScopeEnabled };

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
 * Run the two-phase chronicle query (docs/03-server-api.md §20).
 *
 * Phase 1 selects thoughts; phase 2 lists chronological comments attached to
 * them or to their links. Returns the paged rows with the total count.
 *
 * Сортировка (требование c6ddc1ea): ТОЛЬКО по дате/времени записи —
 * `valid_from` → `valid_to` → тайбрейкеры `created_at` → `id`, все в
 * направлении `order`. Класс записи (близость к HOME) в сортировке НЕ
 * участвует (ревизия 2026-10-09, задача 5a002590): он заставлял запись
 * «прыгать» при добавлении/снятии мыслей. Порядок детерминирован уникальным
 * `id`, поэтому не зависит от состава привязок и времени изменения.
 *
 * `opts.userId` — контекст исполнения критериев целей (движок выборки мыслей);
 * `opts.now` — часы для раскрытия токенов периода (тесты).
 */
// ---------------------------------------------------------------------------
// AST хроники: исполнитель записи и компилятор плоской формы (задача 4752b065;
// требования 62475a6e «операнды профиля», 0c83819c «REST/MCP компилируется в
// общий AST»; ADR 06a15c16 двухфазность, ADR 3301223f keyword_scope).
//
// Единый AST-путь: операнды записи (record_*) дают условия по alias `c`,
// «Цели» (targets) — под-выборка мыслей, исполняемая общим движком
// (`buildThoughtIdSelect`); двухфазность = EXISTS по целям (in «хотя бы одна»,
// all_of «все цели»). Плоское тело компилируется этим же модулем; второй
// SQL-путь не вводится.
// ---------------------------------------------------------------------------

/** Условие над alias `c` (запись) + параметры. */
interface ChronicleClause {
  sql: string;
  args: unknown[];
}

/** Контекст раскрытия токенов и настроек профиля хроники. */
interface ChronicleAstOpts {
  userId: string;
  now?: () => Date;
  firstDayOfWeek?: number;
  withTime?: boolean;
  requestId?: string;
}

const RECORD_TITLE_COND = `unicode_lower(IFNULL(c.title, '')) LIKE ? ESCAPE '\\'`;
const RECORD_BODY_COND = `unicode_lower(c.body_md) LIKE ? ESCAPE '\\'`;

const astUnsupported = (message: string, requestId?: string): never => {
  throw new EtnError('VALIDATION_ERROR', message, { field: 'ast' }, requestId);
};

/** Разбор `version`-AST хроники (строгая форма). */
function parseChronicleAst(raw: unknown, requestId?: string): FilterAst {
  return parseFilterAst(raw, requestId);
}

/** Строковое значение токена/скаляра AST. */
function astTokenOrString(raw: unknown, field: string, requestId?: string): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'token' in raw) {
    const t = (raw as { token?: unknown }).token;
    if (typeof t === 'string') return t;
  }
  throw new EtnError('VALIDATION_ERROR', `${field}: ожидается дата или токен.`, { field }, requestId);
}

/** Раскрыть дату/токен границы периода записи в полный UTC-инстанс. */
function resolveRecordBound(raw: unknown, bound: 'lower' | 'upper', opts: ChronicleAstOpts): string {
  const field = bound === 'lower' ? 'date_from' : 'date_to';
  const rawStr = astTokenOrString(raw, field, opts.requestId).trim();
  const { known, unknown } = scanStringForTokens(rawStr);
  if (unknown.length > 0) {
    throw new EtnError('VALIDATION_ERROR', `${field}: неизвестный токен «${unknown[0]!.raw}».`, { field, token: unknown[0]!.raw }, opts.requestId);
  }
  const bad = known.find((t) => t.kind !== 'global');
  if (bad !== undefined) {
    throw new EtnError('VALIDATION_ERROR', `${field}: токен «${bad.raw}» требует контекста мысли и в периоде недопустим.`, { field, token: bad.raw }, opts.requestId);
  }
  if (known.length === 0) {
    const normalised = normaliseInstant(rawStr, field, bound === 'lower' ? 'start' : 'end');
    if (normalised != null) return normalised;
  }
  const resolved = resolvePeriodField(rawStr, field, opts.now, {
    ...(opts.firstDayOfWeek !== undefined ? { firstDayOfWeek: opts.firstDayOfWeek } : {}),
    ...(opts.withTime !== undefined ? { withTime: opts.withTime } : {}),
  });
  if (resolved === undefined) {
    throw new EtnError('VALIDATION_ERROR', `${field}: не удалось раскрыть значение периода.`, { field }, opts.requestId);
  }
  return resolved;
}

/** «Время записи» — пересечение интервала записи [valid_from, valid_to] с условием. */
function recordTimeLeafClause(leaf: FilterAstLeaf, opts: ChronicleAstOpts): ChronicleClause {
  const lower = (value: unknown, strict: boolean): ChronicleClause => {
    const [, args] = validToLowerCond(resolveRecordBound(value, 'lower', opts));
    return { sql: `(c.valid_to IS NULL OR c.valid_to ${strict ? '>' : '>='} ?)`, args };
  };
  const upper = (value: unknown, strict: boolean): ChronicleClause => {
    const [, args] = validFromUpperCond(resolveRecordBound(value, 'upper', opts));
    return { sql: `c.valid_from ${strict ? '<' : '<='} ?`, args };
  };
  const between = (value: unknown): ChronicleClause => {
    if (!Array.isArray(value) || value.length !== 2) {
      astUnsupported('«Время записи»: оператор «между» требует две границы.', opts.requestId);
    }
    const bounds = value as FilterAstListItem[];
    const a = lower(bounds[0], false);
    const b = upper(bounds[1], false);
    return { sql: `(${a.sql} AND ${b.sql})`, args: [...a.args, ...b.args] };
  };
  switch (leaf.operator) {
    case 'gte':
      return lower(leaf.value, false);
    case 'gt':
      return lower(leaf.value, true);
    case 'lte':
      return upper(leaf.value, false);
    case 'lt':
      return upper(leaf.value, true);
    case 'between':
      return between(leaf.value);
    case 'not_between': {
      const inner = between(leaf.value);
      return { sql: `NOT ${inner.sql}`, args: inner.args };
    }
    default:
      return astUnsupported(`Оператор «${leaf.operator}» недопустим для «Времени записи».`, opts.requestId);
  }
}

/** «Есть слова» мини-синтаксисом по одному столбцу записи (include — AND, exclude — NOT). */
function recordMatchesClause(columnCond: string, value: FilterAstValue | undefined): ChronicleClause {
  const { include, exclude } = parseFilterKeywords(typeof value === 'string' ? value : '');
  const parts: string[] = [];
  const args: unknown[] = [];
  for (const word of include) {
    parts.push(columnCond);
    args.push(buildLikePattern(word.toLowerCase()));
  }
  for (const word of exclude) {
    parts.push(`NOT ${columnCond}`);
    args.push(buildLikePattern(word.toLowerCase()));
  }
  if (parts.length === 0) return { sql: '1=1', args: [] };
  return { sql: `(${parts.join(' AND ')})`, args };
}

/** Условие по столбцу-строке записи (равно/содержит/Есть слова). */
function recordTextLeafClause(
  leaf: FilterAstLeaf,
  column: 'c.title' | 'c.body_md',
  matchesCond: string,
  opts: ChronicleAstOpts,
): ChronicleClause {
  const op = leaf.operator;
  if (op === 'matches') return recordMatchesClause(matchesCond, leaf.value);
  const raw = typeof leaf.value === 'string' ? leaf.value : undefined;
  if (raw === undefined) {
    return astUnsupported(`Оператор «${op}» требует строковое значение.`, opts.requestId);
  }
  switch (op) {
    case 'eq':
      return { sql: `${column} = ?`, args: [raw] };
    case 'ne':
      return { sql: `(${column} IS NULL OR ${column} <> ?)`, args: [raw] };
    case 'contains':
      return { sql: `unicode_lower(IFNULL(${column}, '')) LIKE ? ESCAPE '\\'`, args: [buildLikePattern(raw.toLowerCase())] };
    case 'not_contains': {
      const inner = { sql: `unicode_lower(IFNULL(${column}, '')) LIKE ? ESCAPE '\\'`, args: [buildLikePattern(raw.toLowerCase())] };
      return { sql: `NOT (${inner.sql})`, args: inner.args };
    }
    default:
      return astUnsupported(`Оператор «${op}» недопустим для строкового операнда записи.`, opts.requestId);
  }
}

/**
 * Подпись колонки авторства записи для диагностики («Автор записи» /
 * «Редактор записи») — одна точка на все сообщения этой пары колонок.
 */
function recordAuthorColumnLabel(column: 'c.created_by' | 'c.updated_by'): string {
  return column === 'c.created_by' ? 'Автор записи' : 'Редактор записи';
}

/**
 * Значение авторства записи из значения листа: литеральные строки — как есть,
 * значения-ТОКЕНЫ (`$user` у «Автора записи» предопределённого набора «Мои
 * записи за неделю») раскрываются ГЛОБАЛЬНЫМИ токенами — по образцу границ
 * {@link recordTimeLeafClause}. Нераскрытый/недопустимый токен — ЯВНАЯ ошибка,
 * а не молчаливое `1=1`: прежнее поведение теряло условие и показывало ВСЕ
 * записи (арбитраж оркестратора 2026-10-14).
 *
 * Токен `$user` без пользователя запроса — тоже ЯВНАЯ ошибка (ошибка 1936c70e):
 * `resolveGlobalDateTokens` подставляет для него ПУСТУЮ строку, и путь исполнения
 * без `opts.userId` (например, прямой вызов домена / parity-прогон сохранённых
 * тел) сообщал невнятное «не задано значение условия», хотя авторство задано
 * ТОКЕНОМ. Диагностика называет настоящую причину и одинакова у всех входов:
 * фасады (REST/MCP) передают `userId` — токен раскрывается; вход без него —
 * явная ошибка, а не пустой автор.
 */
function resolveRecordAuthorValue(
  raw: FilterAstValue | undefined,
  column: 'c.created_by' | 'c.updated_by',
  opts: ChronicleAstOpts,
): string | string[] | undefined {
  if (raw === undefined) return undefined;
  const resolveItem = (item: unknown): string => {
    // Строковая форма токена (плоское определение `definition v1`) раскрывается,
    // только если строка ЦЕЛИКОМ — один известный токен; иная строка остаётся
    // литералом-id. Паритет с объектной формой `{ token }` и с листом
    // «Автор»/«Редактор» профиля мыслей (ошибка cc3d: строковый токен авторства
    // не раскрывался и молча терял условие до явной диагностики).
    let text: string;
    if (typeof item === 'string') {
      const scanned = scanStringForTokens(item);
      const pureToken =
        scanned.unknown.length === 0 && scanned.known.length === 1 && item === scanned.known[0]!.raw;
      if (!pureToken) return item;
      text = item;
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item) && 'token' in item) {
      const t = (item as { token?: unknown }).token;
      if (typeof t !== 'string') return '';
      text = t;
    } else {
      return '';
    }
    const { known, unknown } = scanStringForTokens(text);
    if (unknown.length > 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `${column}: неизвестный токен «${unknown[0]!.raw}».`,
        { field: 'value', token: unknown[0]!.raw },
        opts.requestId,
      );
    }
    const bad = known.find((t) => t.kind !== 'global');
    if (bad !== undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `${column}: токен «${bad.raw}» требует контекста мысли и в условии авторства недопустим.`,
        { field: 'value', token: bad.raw },
        opts.requestId,
      );
    }
    // `$user` без пользователя запроса: пустая подстановка — это НЕ «условие
    // без значения», а неразрешённый токен; называем причину (ошибка 1936c70e).
    if (
      opts.userId === '' &&
      known.some((t) => t.raw === '$user' || t.raw.startsWith('$user.'))
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `${recordAuthorColumnLabel(column)}: токен «$user» не разрешён — не задан пользователь запроса.`,
        { field: 'value', token: '$user' },
        opts.requestId,
      );
    }
    const resolved = resolveGlobalDateTokens(text, {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      userId: opts.userId,
    });
    if (resolved.unresolved.length > 0) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `${column}: не удалось раскрыть токен «${text}».`,
        { field: 'value', token: text },
        opts.requestId,
      );
    }
    return resolved.value;
  };
  return Array.isArray(raw) ? raw.map(resolveItem) : resolveItem(raw);
}

/**
 * Условие авторства записи (`created_by`/`updated_by`). Значение раскрывается
 * токенами ({@link resolveRecordAuthorValue}); пустое/нераскрытое значение в
 * операторе, требующем значения, — ошибка, а не `1=1`.
 */
function recordAuthorLeafClause(
  leaf: FilterAstLeaf,
  column: 'c.created_by' | 'c.updated_by',
  opts: ChronicleAstOpts,
): ChronicleClause {
  const conds: string[] = [];
  const args: unknown[] = [];
  // Wire-модель называет пустоту `is_empty`/`not_empty`, домен-условие — `empty`/
  // `not_empty` (легаси `StructureAuthorOp`): отображаем явно.
  const op: StructureAuthorOp =
    leaf.operator === 'is_empty' ? 'empty' : (leaf.operator as StructureAuthorOp);
  if (op === 'empty' || op === 'not_empty') {
    appendChronicleAuthorCondition(conds, args, column, undefined, op);
    return { sql: conds.join(' AND '), args };
  }
  const value = resolveRecordAuthorValue(leaf.value, column, opts);
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return astUnsupported(`«${recordAuthorColumnLabel(column)}»: не задано значение условия.`, opts.requestId);
  }
  appendChronicleAuthorCondition(conds, args, column, value, op);
  if (conds.length === 0) return { sql: '1=1', args: [] };
  return { sql: conds.join(' AND '), args };
}

/**
 * Условие «Цели»: привязка записи к мысли-цели ИЛИ к связи, конец которой ∈
 * подвыборки (семантика плоского `attachmentCond`, `link_scope = 'both'`;
 * решение оркестратора 2026-10-12). Семантику задаёт оператор ЛИСТА профиля
 * (`in`/`not_in`/`all_of`/`is_empty`/`not_empty`); значение — под-выборка мыслей
 * либо её отсутствие для быстрых форм.
 *
 * Под-выборка исполняется с контекстом ФАЗЫ 1 ХРОНИКИ
 * (`keywordCommentIncludesLinkComments`): область `comment` листа «Есть слова»
 * ищет и комментарии инцидентных связей мысли (требование ce111b0d; ошибка
 * fc97548d — паритет с плоским `keyword_scope`, который эти комментарии видел).
 * Иначе панельное AST-тело и прежнее плоское тело давали разные наборы целей.
 */
function targetsLeafClause(ndb: NetworkDb, leaf: FilterAstLeaf, opts: ChronicleAstOpts): ChronicleClause {
  const op = leaf.operator;
  if (op === 'is_empty') return { sql: `NOT EXISTS (${ATTACH_ANY_SQL})`, args: [] };
  if (op === 'not_empty') return { sql: `EXISTS (${ATTACH_ANY_SQL})`, args: [] };
  const value = leaf.value;
  const isSubquery =
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'query' in value;
  // Значение — под-выборка мыслей ЛИБО список id («Список», ошибка 609deba0 п.1),
  // зеркало операнда «Мысль».
  const ids = (): string[] => {
    if (isSubquery) {
      const { query } = value as { query: FilterAstNode };
      const sel = buildThoughtIdSelect(
        ndb,
        opts.userId,
        {
          sort: 'alpha', order: 'asc', limit: 1, offset: 0,
          ast: { version: FILTER_AST_VERSION, filter: query },
        },
        opts.requestId,
        { keywordCommentIncludesLinkComments: true },
      );
      return (ndb.prepare(sel.sql).all(...sel.params) as Array<{ id: string }>).map((r) => r.id);
    }
    if (Array.isArray(value)) return (value as FilterAstListItem[]).filter((v): v is string => typeof v === 'string');
    return [];
  };
  const idsArgs = (set: string[]): unknown[] => (set.length === 0 ? [] : [...set, ...set, ...set]);

  // «В иерархии»/«не в иерархии»: выбранные цели и их СТРУКТУРНЫЕ потомки
  // (зеркало «Мысли» в иерархии, задача a577875b; «Цели» — ошибка 609deba0 п.1).
  if (op === 'in_hierarchy' || op === 'not_in_hierarchy') {
    const roots = ids();
    let subtree: string[] = [];
    if (roots.length > 0) {
      const res = collectHierarchySubtree(ndb, roots, 'structural', {
        maxDepth: TRAVERSAL_DEFAULTS.MAX_DEPTH,
        maxNodes: HIERARCHY_SUBTREE_MAX_NODES,
        timeoutMs: TRAVERSAL_DEFAULTS.QUERY_TIMEOUT_MS,
      });
      // Бюджет обхода не усекаем молча (ADR 58b501d8): превышение — явная ошибка.
      if (res.truncated) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Обход «Целей в иерархии» прерван: превышен ресурсный бюджет; сузьте набор целей.',
          { field: 'targets', reason: 'hierarchy_budget' },
          opts.requestId,
        );
      }
      subtree = res.ids;
    }
    const matchArgs = idsArgs(subtree);
    if (op === 'in_hierarchy') return { sql: `EXISTS (${attachToIdsSql(subtree)})`, args: matchArgs };
    // Запись без целей характеристикой не обладает — «не в иерархии» не
    // удовлетворяет (строгость как у `not_in`).
    return { sql: `(EXISTS (${ATTACH_ANY_SQL}) AND NOT EXISTS (${attachToIdsSql(subtree)}))`, args: matchArgs };
  }

  if (!isSubquery && !Array.isArray(value)) {
    return astUnsupported('«Цели»: оператор требует значения — списка мыслей либо под-выборки.', opts.requestId);
  }
  const set = ids();
  const attachArgs = idsArgs(set);
  switch (op) {
    case 'in':
      return { sql: `EXISTS (${attachToIdsSql(set)})`, args: attachArgs };
    case 'not_in':
      // Запись БЕЗ целей характеристикой не обладает и условию не удовлетворяет
      // (сценарий 31b6425b): сперва требуем хотя бы одну цель.
      return { sql: `(EXISTS (${ATTACH_ANY_SQL}) AND NOT EXISTS (${attachToIdsSql(set)}))`, args: attachArgs };
    case 'all_of': {
      // «Все цели удовлетворяют» — цель есть и нет привязки вне подвыборки
      // (пустой набор целей не удовлетворяет, сценарий 31b6425b).
      return { sql: `(EXISTS (${ATTACH_ANY_SQL}) AND NOT EXISTS (${attachToIdsSql(set, true)}))`, args: attachArgs };
    }
    default:
      return astUnsupported(`Оператор «${op}» недопустим для «Целей».`, opts.requestId);
  }
}

const ATTACH_ANY_SQL = `SELECT 1 FROM comment_targets_v cta WHERE cta.comment_id = c.id`;

/**
 * SQL привязки записи к цели: мысль ∈ подвыборки ИЛИ связь, чей конец ∈
 * подвыборки (семантика плоского `attachmentCond`, `link_scope = 'both'`).
 * Плейсхолдеры: сначала мысль, затем source, затем target (по три блока ids).
 */
function attachToIdsSql(ids: string[], negate = false): string {
  const inList = ids.length === 0 ? 'NULL' : placeholders(ids.length);
  const inner = `(
    (ct.owner_type = 'thought' AND ct.owner_id IN (${inList}))
    OR (ct.owner_type = 'link' AND (l.source_id IN (${inList}) OR l.target_id IN (${inList})))
  )`;
  const where = `ct.comment_id = c.id AND ${negate ? `NOT ${inner}` : inner}`;
  return `SELECT 1 FROM comment_targets_v ct
    LEFT JOIN links_v l ON ct.owner_type = 'link' AND l.id = ct.owner_id
    WHERE ${where}`;
}

/** Условие узла AST хроники по alias `c`. */
function chronicleAstNodeClause(ndb: NetworkDb, node: FilterAstNode, opts: ChronicleAstOpts): ChronicleClause {
  if ('op' in node) {
    if (node.op === 'not') {
      const child = chronicleAstNodeClause(ndb, node.children[0]!, opts);
      return { sql: `NOT (${child.sql})`, args: child.args };
    }
    const parts = node.children.map((c) => chronicleAstNodeClause(ndb, c, opts));
    if (node.op === 'and') {
      return parts.length === 0
        ? { sql: '1=1', args: [] }
        : { sql: `(${parts.map((p) => p.sql).join(' AND ')})`, args: parts.flatMap((p) => p.args) };
    }
    return parts.length === 0
      ? { sql: '0', args: [] }
      : { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, args: parts.flatMap((p) => p.args) };
  }
  switch (node.entity.kind) {
    case 'record_time':
      return recordTimeLeafClause(node, opts);
    case 'record_title':
      return recordTextLeafClause(node, 'c.title', RECORD_TITLE_COND, opts);
    case 'record_body':
      // «Текст записи» — те же операторы, что у заголовка (ошибка 609deba0 п.5):
      // равно/не равно/содержит/не содержит + «Есть слова» (путь Б ключевых слов).
      return recordTextLeafClause(node, 'c.body_md', RECORD_BODY_COND, opts);
    case 'record_author':
      return recordAuthorLeafClause(node, 'c.created_by', opts);
    case 'record_editor':
      return recordAuthorLeafClause(node, 'c.updated_by', opts);
    case 'targets':
      return targetsLeafClause(ndb, node, opts);
    default:
      return astUnsupported(`Операнд «${node.entity.kind}» не виден в профиле хроники.`, opts.requestId);
  }
}

/** Цели-подвыборка «id in [список]» (для компиляции scope/пути А). */
function targetsIdSubqueryNode(ids: string[], operator: 'in' | 'not_in' = 'in'): FilterAstNode {
  return {
    entity: { kind: 'targets' },
    operator,
    value: { query: { entity: { kind: 'id' }, operator: 'in', value: [...ids] }, operator: operator === 'in' ? 'in' : 'not_in' },
  };
}

function targetsNotEmptyNode(): FilterAstNode {
  return { entity: { kind: 'targets' }, operator: 'not_empty' };
}

/** Группа текста записи (путь Б): include — OR(тело, заголовок), exclude — NOT(OR). */
function recordTextGroupNode(includeWords: string[], excludeWords: string[]): FilterAstNode | null {
  const children: FilterAstNode[] = [];
  for (const word of includeWords) {
    children.push({
      op: 'or',
      children: [
        { entity: { kind: 'record_body' }, operator: 'matches', value: word },
        { entity: { kind: 'record_title' }, operator: 'matches', value: word },
      ],
    });
  }
  for (const word of excludeWords) {
    children.push({
      op: 'not',
      children: [
        {
          op: 'or',
          children: [
            { entity: { kind: 'record_body' }, operator: 'matches', value: word },
            { entity: { kind: 'record_title' }, operator: 'matches', value: word },
          ],
        },
      ],
    });
  }
  if (children.length === 0) return null;
  return children.length === 1 ? children[0]! : { op: 'and', children };
}

const AST_FALSE: FilterAstNode = { op: 'or', children: [] };

/**
 * Скомпилировать плоское тело хроники в общий AST (требование 0c83819c).
 * Семантика воспроизводит прежний SQL-путь хроники один-в-один; неподдержанные
 * плоские особенности (`link_scope != both`, `link_type_ids`) — явная ошибка, а
 * не молчаливая подмена.
 */
export function compileChronicleToAst(
  ndb: NetworkDb,
  request: ChronicleQueryRequest,
  opts: ChronicleAstOpts,
): FilterAst {
  const linkScope = request.link_scope ?? 'both';
  if (linkScope !== 'both') {
    throw new EtnError(
      'VALIDATION_ERROR',
      `AST 0.13.1 выражает только link_scope = 'both'; значение «${linkScope}» не поддержано — отказ вместо подмены.`,
      { field: 'link_scope' },
      opts.requestId,
    );
  }
  if ((request.link_type_ids ?? []).length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'AST 0.13.1 не выражает фильтр типов связей (link_type_ids) — отказ вместо подмены.',
      { field: 'link_type_ids' },
      opts.requestId,
    );
  }

  const { include: includeWords, exclude: excludeWords } = parseFilterKeywords(request.keywords ?? '');
  const baseIds = collectRootAndSubtreeIds(ndb, request);
  const typeIds = request.type_ids ?? [];
  const scopeIds = selectThoughts(ndb, baseIds, typeIds, [], []);
  let keywordIds: string[] = scopeIds;
  if (includeWords.length > 0 || excludeWords.length > 0) {
    keywordIds = selectThoughts(ndb, baseIds, typeIds, includeWords, [], request.keyword_scope);
    if (excludeWords.length > 0) {
      const excluded = new Set(selectThoughts(ndb, baseIds, typeIds, excludeWords, [], request.keyword_scope));
      keywordIds = keywordIds.filter((id) => !excluded.has(id));
    }
  }
  const scopeRestricted = baseIds !== null || typeIds.length > 0;

  const parts: FilterAstNode[] = [];
  if (includeWords.length > 0 && keywordIds.length > 0) parts.push(targetsIdSubqueryNode(keywordIds));
  if (commentScopeEnabled(request.keyword_scope) && (includeWords.length > 0 || excludeWords.length > 0)) {
    const text = recordTextGroupNode(includeWords, excludeWords);
    if (text !== null) {
      const attach = scopeRestricted ? targetsIdSubqueryNode(scopeIds) : targetsNotEmptyNode();
      parts.push({ op: 'and', children: [text, attach] });
    }
  }
  let overall: FilterAstNode;
  if (parts.length > 0) overall = parts.length === 1 ? parts[0]! : { op: 'or', children: parts };
  else if (includeWords.length > 0) overall = AST_FALSE;
  else if (scopeIds.length > 0) overall = scopeRestricted ? targetsIdSubqueryNode(scopeIds) : targetsNotEmptyNode();
  else overall = AST_FALSE;

  const andParts: FilterAstNode[] = [overall];
  if (request.targets !== undefined) {
    const compiled = compileThoughtQueryToAst(
      ndb,
      structureRequestToQuery({ ...request.targets, sort: 'alpha', order: 'asc', limit: 1, offset: 0 }),
      opts.requestId,
    );
    if (compiled !== undefined) {
      andParts.push({
        entity: { kind: 'targets' },
        operator: 'in',
        value: { query: compiled.filter, operator: 'in' },
      });
    }
  }
  if (request.date_from !== undefined && request.date_from !== null) {
    andParts.push({ entity: { kind: 'record_time' }, operator: 'gte', value: request.date_from });
  }
  if (request.date_to !== undefined && request.date_to !== null) {
    andParts.push({ entity: { kind: 'record_time' }, operator: 'lte', value: request.date_to });
  }
  // Авторство: плоский парсер отбрасывает пустые значения (empty/not_empty без
  // значения не доходят до запроса), поэтому в AST попадает только реальное
  // значение с оператором профиля (eq/ne/in/not_in) — набор `record_author`/
  // `record_editor` пустых операторов не несёт (профиль 62475a6e).
  const authorNode = (kind: 'record_author' | 'record_editor', value: string | string[] | undefined, op: StructureAuthorOp | undefined): FilterAstNode | null => {
    if (value === undefined) return null;
    return { entity: { kind }, operator: (op ?? 'eq') as FilterAstLeaf['operator'], value };
  };
  const created = authorNode('record_author', request.created_by, request.created_by_op);
  if (created !== null) andParts.push(created);
  const updated = authorNode('record_editor', request.updated_by, request.updated_by_op);
  if (updated !== null) andParts.push(updated);

  const filter: FilterAstNode =
    andParts.length === 1 ? andParts[0]! : { op: 'and', children: andParts };
  return { version: FILTER_AST_VERSION, filter };
}

export function queryChronicle(
  ndb: NetworkDb,
  request: ChronicleQueryRequest,
  opts: {
    userId?: string;
    now?: () => Date;
    /**
     * Контекст профиля хроники (требование 0095daad, ADR 0c02ab4f): первый день
     * недели сети для `$weekStart`/`$weekEnd` и `withTime` (хроника — профиль со
     * временем). Прокидывается фасадом (REST/MCP) из настроек сети.
     */
    firstDayOfWeek?: number;
    withTime?: boolean;
    /**
     * Транспорт-агностичный transform `body_md` → `body_html` (MCP-фасад
     * передаёт пересборку из развёрнутого текста — ошибка a6da3d37; REST не
     * передаёт ничего и получает кешированный `body_html`).
     */
    bodyHtmlTransform?: (body_md: string) => string;
    /**
     * Транспорт-агностичный transform `body_md` → текст сниппета (MCP-фасад
     * передаёт развёртку трансклюзий БЕЗ маркеров границ — ошибка a3fb62b6;
     * REST не передаёт ничего и получает сниппет из исходного текста).
     */
    snippetTransform?: (body_md: string) => string;
  } = {},
): ChronicleQueryResponse {
  const userId = opts.userId ?? '';
  const astOpts: ChronicleAstOpts = {
    userId,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.firstDayOfWeek !== undefined ? { firstDayOfWeek: opts.firstDayOfWeek } : {}),
    ...(opts.withTime !== undefined ? { withTime: opts.withTime } : {}),
  };
  // Единый AST-путь (требование 0c83819c): явное ast-тело — как передано
  // (с проверкой профиля и красной диагностикой); плоское — компилируется тем
  // же модулем. Второго исполнения критериев нет.
  let ast: FilterAst;
  // Жёлтая диагностика ядра явного AST (требование 325efc13): у хроники
  // контекста типа нет, поэтому записей обычно не бывает, но контракт несёт
  // `warnings` — единый путь со «Структурами» (требование 0fd1dc5d).
  let warnings: FilterDiagnostic[] = [];
  if (request.ast !== undefined) {
    assertFilterAstInProfile(request.ast, 'chronicle');
    const diag = diagnoseFilterAst(ndb, request.ast);
    if (diag.errors.length > 0) throw filterDiagnosticsError(diag.errors);
    warnings = diag.warnings;
    ast = request.ast;
  } else {
    ast = compileChronicleToAst(ndb, request, astOpts);
  }
  const record = chronicleAstNodeClause(ndb, ast.filter, astOpts);
  const cond = `c.kind = 'chronological' AND (${record.sql})`;
  const args = record.args;
  // Подсветка сниппета — по включающим словам плоской формы. AST-тело своих
  // слов не декларирует в запросе (они внутри листьев), поэтому подсветки нет.
  const includeWords = parseFilterKeywords(request.keywords ?? '').include;
  const dir = request.order === 'desc' ? 'DESC' : 'ASC';
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
       ORDER BY c.valid_from ${dir},
                c.valid_to ${dir},
                c.created_at ${dir},
                c.id ${dir}
       LIMIT ? OFFSET ?`,
    )
    .all(...args, request.limit, request.offset) as Row[];

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

  const withSnippets = rows.map((row) => {
    // Сниппет строится из того же развёрнутого текста, что и `body_html`, если
    // фасад передал трансформ (MCP): иначе превью показывало бы литерал
    // трансклюзии при развёрнутом содержимом строки (ошибка a3fb62b6).
    const snippetSource =
      opts.snippetTransform === undefined ? row.body_md : opts.snippetTransform(row.body_md);
    return {
      ...row,
      snippet: makeSnippet(snippetSource, includeWords),
      body_html:
        opts.bodyHtmlTransform === undefined ? row.body_html : opts.bodyHtmlTransform(row.body_md),
    };
  });
  return {
    rows: buildRows(ndb, withSnippets, refs, linkTargets),
    total,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
