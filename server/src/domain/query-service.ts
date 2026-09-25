/**
 * Единый движок выборки мыслей по критериям (задача c5265deb, веха 7 версии
 * 0.8.2, ADR 8c93f03a, стандарт S5, требование a995045f).
 *
 * Одна реализация операции для обоих фасадов:
 *
 *   * REST `POST /thoughts/query` (03-server-api.md §6.10) — «Структуры
 *     мыслей» и сохранённые отборы;
 *   * MCP `etn.thoughts.query` (05-mcp-server.md §4.1);
 *   * исполнение отборов типов (`thought-type-views-service.runViewForThought`).
 *
 * Роут и MCP-инструмент разбирают вход своего формата, переводят его в
 * канонический {@link ThoughtQueryRequest} адаптерами {@link
 * structureRequestToQuery} / {@link mcpRequestToQuery} и формируют ответ
 * своего формата из {@link ThoughtQueryResult}. SQL живёт только здесь.
 *
 * Семантика — объединение прежних `structure-service` и `query-service`:
 *
 *   * keywords — мини-синтаксис §6.10 (AND слов, `*` инфикс, `-` исключение,
 *     эскейпинг LIKE) с настраиваемой областью (`keyword_scope`: title /
 *     synonyms / постоянный комментарий; дефолт — title+synonyms);
 *   * типы — L21: выбранный родительский тип соответствует всему своему
 *     поддереву (OR внутри списка);
 *   * свойства — адресуются registry `property_id`; колонка хранения
 *     выбирается по `value_type` свойства, а не по runtime-типу значения;
 *     операторы объединены из обоих фасадов (см. OPS_BY_VALUE_TYPE);
 *   * поддерево — направленный BFS вниз по активным связям с visited-set,
 *     потолком глубины и лимитом узлов; REST-режим исключает корни,
 *     MCP-режим включает (depth 0) и сообщает обрезку `truncated`/`reason`;
 *   * актуальность/пометка на удаление — трёхсостояния `true`/`false`/`any`;
 *   * авторы, диапазоны дат, has_*-признаки, link_type_ids — из REST;
 *   * сортировки — единый набор REST (`alpha`/`created`/`updated`/`viewed`);
 *     MCP-имена `title`/`created_at`/`updated_at` маппятся в него адаптером.
 *
 * Пустой фильтр: REST-контракт (`emptyFilterMode: 'home_orphans'`) возвращает
 * HOME + мысли-сироты с HOME первой; MCP-контракт (`'all'`) — обычный
 * критериальный запрос без критериев.
 */

import {
  EtnError,
  STRUCTURES_PARENT_SCOPE_MAX_DEPTH,
  STRUCTURES_QUERY_MAX_LIMIT,
  TRAVERSAL_DEFAULTS,
  buildLikePattern,
  isLinkTypeFilterActive,
  parseFilterKeywords,
  type LinkPropertyDirection,
  type LinkTypeFilterInput,
  type PropertyConfig,
  type PropertyValueType,
  type SortOrder,
  type StructureAuthorOp,
  type StructureDirectionFlags,
  type StructureKeywordScope,
  type StructureQueryRequest,
  type StructureSort,
  type ThoughtQueryActive,
  type ThoughtQueryRequest as McpThoughtQueryRequest,
  type ThoughtQuerySort,
  type ThoughtQueryTrashed,
  type ThoughtRef,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getLinkDirections } from './link-service.js';
import {
  isStructuralLinkProperty,
  linkPropertyDirection,
  linkPropertyLinkTypeId,
  resolveConditionPropertyRef,
} from './property-service.js';
import { nameTrigramMatch } from './search-service.js';
import { rowToThoughtRef } from './thought-service.js';
import { expandTypeIdsToSubtree, linkTypeFilterClause } from './type-hierarchy.js';

// ---------------------------------------------------------------------------
// Канонические типы запроса/ответа
// ---------------------------------------------------------------------------

/**
 * Оператор условия по значению свойства — объединение наборов обоих фасадов:
 * `in`/`not_in`/`is_empty`/`not_empty` — из REST-фильтра «Структур»,
 * `ne`/`gte`/`lte`/`any_of`/`all_of`/`none_of` — из `etn.thoughts.query`.
 */
export type ThoughtQueryPropertyOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'is_empty'
  | 'not_empty'
  | 'any_of'
  | 'all_of'
  | 'none_of';

/** Одно условие канонического фильтра: свойство адресуется registry id. */
export interface ThoughtQueryPropertyCondition {
  property_id: string;
  operator: ThoughtQueryPropertyOperator;
  value: string | number | boolean | Array<string | number | boolean>;
}

/**
 * Ограничение поддерева. REST-фасад (`parent_ids`) исключает корни из
 * набора кандидатов и включает неактивные рёбра при `show_inactive`;
 * MCP-фасад (`in_subtree_of`) включает корень (depth 0), ходит только по
 * активным связям и сообщает обрезку по лимиту узлов.
 */
export interface ThoughtQuerySubtree {
  /** Корни обхода (REST — несколько, OR; MCP — один). */
  roots: string[];
  /** `true` (MCP) — корни входят в набор кандидатов (depth 0). */
  include_roots: boolean;
  /** Потолок глубины обхода (REST — {@link STRUCTURES_PARENT_SCOPE_MAX_DEPTH}). */
  max_depth: number;
  /** `true` (REST `show_inactive`) — спускаться и по неактивным рёбрам. */
  include_inactive_links: boolean;
  /** Потолок узлов BFS (MCP `max_nodes_per_subgraph`); без лимита — `undefined`. */
  max_nodes?: number;
  /** Фильтр обхода по типам связей (задача c965ad03). */
  link_filter?: LinkTypeFilterInput;
}

/** Канонический запрос выборки: критерии + сортировка + пагинация. */
export interface ThoughtQueryRequest {
  /** Keywords мини-синтаксис §6.10. */
  keywords?: string;
  /** Область поиска keywords; отсутствует/пуст — title+synonyms. */
  keyword_scope?: StructureKeywordScope[];
  /** Типы мыслей (id, L21-поддерево; OR внутри списка). */
  type_ids?: string[];
  /** Мысль имеет активную связь перечисленных типов (OR; L21). */
  link_type_ids?: string[];
  /** Условия по значениям свойств (AND между условиями). */
  properties?: ThoughtQueryPropertyCondition[];
  has_properties?: boolean;
  has_comment?: boolean;
  has_attachments?: boolean;
  has_chronology?: boolean;
  /** `'true'` (дефолт) — только активные; `'false'` — только неактивные;
   * `'any'` — без фильтра. `undefined` равнозначен `'true'`. */
  active?: ThoughtQueryActive;
  /** `'false'` (дефолт) — без пометки на удаление; `'true'` — только
   * помеченные; `'any'` — без фильтра. */
  trashed?: ThoughtQueryTrashed;
  /** Автор (id пользователя) + оператор; операторы — как у REST. */
  created_by?: string | string[];
  created_by_op?: StructureAuthorOp;
  updated_by?: string | string[];
  updated_by_op?: StructureAuthorOp;
  /** ISO-8601 границы дат (включительно). */
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
  /** Фильтр обхода поддерева по типам связей (передаётся и в subtree). */
  link_filter?: LinkTypeFilterInput;
  /** Ограничение поддерева (REST `parent_ids` / MCP `in_subtree_of`). */
  subtree?: ThoughtQuerySubtree;
  /** Сортировка — единый набор REST; MCP-имена маппятся адаптером. */
  sort: StructureSort;
  order: SortOrder;
  limit: number;
  offset: number;
  /**
   * Явно запросить полное число совпадений (требование 5adebf61): без флага
   * COUNT не выполняется, `total` = `null`, хвост сообщает `has_more`.
   */
  count?: boolean;
  /**
   * Keyset-курсор следующей страницы (требование 3f2fdc41, ADR 5f6cb775):
   * непрозрачная строка из `next_cursor` предыдущего ответа. Передан — вместо
   * OFFSET применяется предикат по ключу сортировки + `id`; обязан
   * соответствовать `sort`/`order`/режиму пустого фильтра запроса.
   */
  cursor?: string;
}

/** Параметры исполнения, которые задаёт фасад (не критерий выборки). */
export interface ThoughtQueryOptions {
  /** Потолок лимита фасада (REST 100/2000, MCP 200). Дефолт — {@link STRUCTURES_QUERY_MAX_LIMIT}. */
  maxLimit?: number;
  /**
   * Поведение пустого фильтра: `'home_orphans'` (REST) — HOME + сироты с
   * HOME первой; `'all'` (MCP, дефолт) — обычный запрос без критериев.
   */
  emptyFilterMode?: 'home_orphans' | 'all';
  /** Собирать ли флаги направлений связей страницы (REST `meta.directions`). */
  includeDirections?: boolean;
  /**
   * Видимость помеченных на удаление рёбер при сборке `directions` (задача
   * 77923b49, ошибка 331ffb94, 0.8.2). Дефолт `true` — как у остальных
   * витрин после 355319d4. `false` обязан приходить из того же резолва
   * `resolveShowTrash`, что и раскрытие дерева (`getHierarchy`), иначе эллипс
   * раскрываемости обещает уровень, которого соседи не отдают.
   */
  showTrash?: boolean;
}

/** Результат канонической выборки. */
export interface ThoughtQueryResult {
  /** Страница мыслей (REST отдаёт как есть, MCP проецирует в hits). */
  items: ThoughtRef[];
  /**
   * Полное число совпадений без пагинации; `null`, когда COUNT не запрошен
   * явным флагом (`count: true`), — требование 5adebf61.
   */
  total: number | null;
  /** true — за текущей страницей есть ещё строки (без полного COUNT). */
  has_more: boolean;
  /** Keyset-курсор следующей страницы; `null` — страниц больше нет. */
  next_cursor: string | null;
  /** Флаги направлений связей страницы (пусто при `includeDirections: false`). */
  directions: StructureDirectionFlags;
  /** depth каждого id из {@link items} (null — поддерева не было; MCP hits). */
  depths: Map<string, number> | null;
  /** Обход поддерева остановился по лимиту узлов (MCP). */
  truncated: boolean;
  /** Причина обрезки (`max_nodes`) или null. */
  reason: 'max_nodes' | null;
}

/** Результат id-only выборки ({@link queryThoughtIds}). */
export interface ThoughtIdsQueryResult {
  ids: string[];
  /** Полное число совпадений; `null` — COUNT не запрашивался. */
  total: number | null;
  /** true — за текущей страницей есть ещё строки. */
  has_more: boolean;
  /** Keyset-курсор следующей страницы; `null` — страниц больше нет. */
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Адаптеры wire-форматов → канон
// ---------------------------------------------------------------------------

/**
 * REST → канон: `StructureQueryRequest` (03-server-api.md §6.10) переводится
 * в {@link ThoughtQueryRequest}. Трёхсостояния собираются из булевых полей
 * REST-контракта:
 *
 *   * `active: true/false` — явный критерий; отсутствует + `show_inactive`
 *     — `'any'`; отсутствует без флага — `undefined` (дефолт `'true'`);
 *   * `trashed: true` — «включать помеченные наравне с обычными» → `'any'`;
 *     `false`/отсутствует — `'false'`.
 *
 * `parent_ids` превращаются в поддерево REST-режима: корни исключены,
 * глубина {@link STRUCTURES_PARENT_SCOPE_MAX_DEPTH}, неактивные рёбра — по
 * `show_inactive`.
 */
export function structureRequestToQuery(req: StructureQueryRequest): ThoughtQueryRequest {
  const active: ThoughtQueryActive | undefined =
    req.active === true ? 'true' : req.active === false ? 'false' : req.show_inactive === true ? 'any' : undefined;
  return {
    keywords: req.keywords,
    keyword_scope: req.keyword_scope,
    type_ids: req.type_ids,
    link_type_ids: req.link_type_ids,
    properties: (req.properties ?? []).map((c) => ({
      property_id: c.property_id,
      operator: c.op,
      value: c.value,
    })),
    has_properties: req.has_properties,
    has_comment: req.has_comment,
    has_attachments: req.has_attachments,
    has_chronology: req.has_chronology,
    active,
    trashed: req.trashed === true ? 'any' : 'false',
    created_by: req.created_by,
    created_by_op: req.created_by_op,
    updated_by: req.updated_by,
    updated_by_op: req.updated_by_op,
    created_after: req.created_after,
    created_before: req.created_before,
    updated_after: req.updated_after,
    updated_before: req.updated_before,
    link_filter: req.link_filter,
    subtree:
      req.parent_ids !== undefined && req.parent_ids.length > 0
        ? {
            roots: req.parent_ids,
            include_roots: false,
            max_depth: STRUCTURES_PARENT_SCOPE_MAX_DEPTH,
            include_inactive_links: req.show_inactive === true,
            link_filter: req.link_filter,
          }
        : undefined,
    sort: req.sort,
    order: req.order,
    limit: req.limit,
    offset: req.offset,
    count: req.count,
    cursor: req.cursor,
  };
}

const MCP_SORT_TO_CANONICAL: Record<ThoughtQuerySort, StructureSort> = {
  title: 'alpha',
  created_at: 'created',
  updated_at: 'updated',
};

/**
 * MCP → канон: wire-`ThoughtQueryRequest` (05-mcp-server.md §4.1) переводится
 * в {@link ThoughtQueryRequest}. Имена типов и свойств резолвит MCP-фасад до
 * вызова адаптера — здесь принимаются только id (`type_id[]`,
 * `properties[].property_id`; условия без `property_id` отбрасываются как
 * «нет совпадения»). Дефолты MCP-контракта: лимит 50, смещение 0, `active`
 * `'true'`, `trashed` `'false'`, сортировка `title` (= `alpha`) `asc`.
 */
export function mcpRequestToQuery(
  req: McpThoughtQueryRequest,
  bounds: { maxNodes: number },
): ThoughtQueryRequest {
  const maxDepth = Math.min(
    Math.max(req.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH, 1),
    TRAVERSAL_DEFAULTS.MAX_DEPTH,
  );
  return {
    type_ids: req.type_id,
    properties: (req.properties ?? [])
      .filter((c): c is typeof c & { property_id: string } => typeof c.property_id === 'string')
      .map((c) => ({
        property_id: c.property_id,
        operator: c.operator,
        value: c.value,
      })),
    active: req.active,
    trashed: req.trashed,
    keywords: req.keywords,
    created_after: req.created_after,
    created_before: req.created_before,
    updated_after: req.updated_after,
    updated_before: req.updated_before,
    created_by:
      typeof req.author_id === 'string' && req.author_id.trim() !== '' ? req.author_id : undefined,
    updated_by:
      typeof req.editor_id === 'string' && req.editor_id.trim() !== '' ? req.editor_id : undefined,
    link_filter: req.link_filter,
    subtree:
      req.in_subtree_of !== undefined
        ? {
            roots: [req.in_subtree_of],
            include_roots: true,
            max_depth: maxDepth,
            include_inactive_links: false,
            max_nodes: bounds.maxNodes,
            link_filter: req.link_filter,
          }
        : undefined,
    sort: MCP_SORT_TO_CANONICAL[req.sort ?? 'title'],
    order: req.order ?? 'asc',
    limit: Math.min(Math.max(req.limit ?? 50, 1), 200),
    offset: Math.max(req.offset ?? 0, 0),
    count: req.count,
    cursor: req.cursor,
  };
}

// ---------------------------------------------------------------------------
// SQL-движок
// ---------------------------------------------------------------------------

/**
 * Display columns every thought-ref SELECT must carry (see `resolveThoughts`).
 *
 * `marked_for_deletion` входит в канон отображения (ошибка 8bbc9542, 0.8.2):
 * без него соседи иерархии «Структур» приезжали клиенту без признака корзины
 * и рисовались обычной строкой, хотя помеченная мысль видна (дефолт
 * `show_trash`). Флаг — такая же часть внешнего вида, как `active`.
 */
export const REF_COLUMNS =
  't.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id,' +
  ' t.active, t.marked_for_deletion, t.fg_color, t.bg_color,' +
  ' t.font_bold, t.font_italic, t.font_underline, t.font_strike, t.font_manual';

/** Row shape accepted by {@link rowToThoughtRef}. */
type ThoughtRefRow = Parameters<typeof rowToThoughtRef>[0];

/**
 * Операторы, допустимые для каждого `value_type` свойства (объединение
 * наборов REST §6.10 и MCP §4.1). `is_empty`/`not_empty` тестируют наличие
 * значения и запрещены для `bool` — там тот же смысл несут `eq true`/
 * `eq false`. Свойство-связь (`link`) хранит значение в рёбрах (links_v),
 * а не в property_values (ADR «проекция ребра»).
 */
const OPS_BY_VALUE_TYPE: Record<PropertyValueType, readonly ThoughtQueryPropertyOperator[]> = {
  text: ['contains', 'eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty'],
  url: [
    'contains',
    'eq',
    'ne',
    'in',
    'not_in',
    'is_empty',
    'not_empty',
    'any_of',
    'all_of',
    'none_of',
  ],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'],
  bool: ['eq', 'ne'],
  link: ['eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty', 'any_of', 'all_of', 'none_of'],
  // Legacy thought_ref (миграция 040): одиночный id или JSON-массив id в
  // `value_thought_ref`; eq/in/not_in ищут обе формы, is_empty/not_empty —
  // наличие хоть какого-то id, наборы — по элементам массива.
  thought_ref: ['eq', 'ne', 'in', 'not_in', 'is_empty', 'not_empty', 'any_of', 'all_of', 'none_of'],
  // Кросс-сетевая ссылка (задача 7849008a, требование 586ebe81): отбор по
  // адресу. eq/ne — точное совпадение; any_of/all_of/none_of — для набора.
  // is_empty/not_empty не нужны (адрес либо точно совпал, либо нет).
  cross_network_ref: ['eq', 'ne', 'any_of', 'all_of', 'none_of'],
};

/** Storage column of `property_values` per property `value_type`. */
const VALUE_COLUMN: Record<PropertyValueType, string> = {
  text: 'value_text',
  url: 'value_text',
  date: 'value_date',
  number: 'value_number',
  bool: 'value_bool',
  // Свойство-связь значений в property_values не хранит (ADR «проекция
  // ребра»); условие транслируется в `links_v`.
  link: 'value_text',
  thought_ref: 'value_thought_ref',
  // Кросс-сетевая ссылка: адрес в value_text (single или JSON-массив).
  cross_network_ref: 'value_text',
};

/** Default keyword scope: title + synonyms only (the original behaviour). */
const DEFAULT_KEYWORD_SCOPE: readonly StructureKeywordScope[] = ['title', 'synonyms'];

function resolveKeywordScope(scope: StructureKeywordScope[] | undefined): Set<StructureKeywordScope> {
  return new Set(scope !== undefined && scope.length > 0 ? scope : DEFAULT_KEYWORD_SCOPE);
}

/**
 * One keyword match clause built for the effective scope: title and/or
 * synonyms and/or the permanent comment (OR between the selected sources).
 * The LIKE pattern is built by {@link buildLikePattern} (escaping `%`/`_`/`\`,
 * `*` → `%`), so the match is infix and case-insensitive.
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

/**
 * Индексный сужатель отбора по `keywords` — `JOIN` на существующий FTS5-индекс
 * `fts_thought_names` (требование 314cbb8d, ADR 5f6cb775).
 *
 * Индекс построен по триграммам названий и синонимов, поэтому FTS-условие
 * «слово встречается как подстрока» совпадает по смыслу с LIKE-клаузой, но
 * исполняется индексом. Точную семантику мини-языка §6.10 (`*`, `-слово`,
 * экранирование) по-прежнему гарантирует {@link buildKeywordClause}: FTS —
 * обязательный конъюнкт, LIKE — остаточный фильтр, поэтому расхождение
 * (например, слово, найденное только в комментарии) исключить нельзя, и
 * сужатель ставится лишь когда область поиска — только название/синонимы.
 *
 * Видимость слоя: `fts_thought_names` синхронизируется триггерами по физическим
 * строкам, джойн идёт по `rowid` победившей версии из представления
 * `thoughts_v` (`t.rowid`) — ровно как в `search-service`. Строки проигравших
 * версий в выборку не попадают.
 *
 * @returns `null`, когда сужатель неприменим (нет include-слов с индексным
 *   представлением или в области есть комментарий).
 */
function buildKeywordFtsJoin(
  include: string[],
  scope: Set<StructureKeywordScope>,
): Clause | null {
  if (include.length === 0 || scope.has('comment')) return null;
  const match = nameTrigramMatch(include);
  if (match === null) return null;
  return {
    sql: `JOIN (SELECT rowid FROM fts_thought_names WHERE fts_thought_names MATCH ?) __kw ON __kw.rowid = t.rowid`,
    params: [match],
  };
}

/** Результат обхода поддерева: depth каждого узла (включая/исключая корни по
 * {@link ThoughtQuerySubtree.include_roots}) + диагностика обрезки. */
interface WalkResult {
  depths: Map<string, number>;
  truncated: boolean;
  reason: 'max_nodes' | null;
}

/**
 * Depth-bounded subtree walk from {@link ThoughtQuerySubtree.roots} via
 * `source_id → target_id` links — breadth-first with a visited-set (cycles
 * terminate regardless of the depth cap). `include_inactive_links` (REST
 * `show_inactive`) widens the walk to inactive edges; `max_nodes` (MCP) cuts
 * the walk and reports `truncated`/`reason`.
 */
function walkSubtree(ndb: NetworkDb, subtree: ThoughtQuerySubtree): WalkResult {
  const { roots, max_depth, max_nodes } = subtree;
  const typeClause = linkTypeFilterClause(ndb, subtree.link_filter, 'l');
  const typeSql = typeClause === null ? '' : ` AND ${typeClause.sql}`;
  const typeParams = typeClause === null ? [] : typeClause.params;
  const activeFlag = subtree.include_inactive_links ? 1 : 0;
  const childrenOf = ndb.prepare(
    `SELECT l.target_id AS nid FROM links_v l WHERE l.source_id = ? AND (l.active = 1 OR ?)${typeSql}`,
  );

  const visited = new Set<string>();
  const depths = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = roots.map((id) => ({ id, depth: 0 }));
  let truncated = false;
  let reason: WalkResult['reason'] = null;

  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (visited.has(id)) continue;
    if (max_nodes !== undefined && visited.size >= max_nodes) {
      truncated = true;
      reason = 'max_nodes';
      break;
    }
    visited.add(id);
    // REST-режим исключает корни из набора кандидатов (их потомки — depth ≥ 1).
    if (subtree.include_roots || depth > 0) depths.set(id, depth);
    if (depth >= max_depth) continue;
    const rows = childrenOf.all(id, activeFlag, ...typeParams) as Array<{ nid: string }>;
    for (const { nid } of rows) {
      if (!visited.has(nid)) queue.push({ id: nid, depth: depth + 1 });
    }
  }
  return { depths, truncated, reason };
}

/** Reads the link-direction flags of the given thoughts as a plain record. */
export function directionsOf(
  ndb: NetworkDb,
  ids: string[],
  linkFilter?: LinkTypeFilterInput,
  showTrash = true,
): StructureDirectionFlags {
  const out: StructureDirectionFlags = {};
  for (const [id, d] of getLinkDirections(ndb, ids, linkFilter, showTrash)) {
    out[id] = { has_incoming: d.has_in, has_outgoing: d.has_out };
  }
  return out;
}

/**
 * Одна ключевая часть детерминированного порядка: SQL-выражение и направление.
 * Порядок строится из них + уникального `id` (ADR 5f6cb775: сортировка обязана
 * иметь уникальный добор ключа, иначе keyset теряет и дублирует строки).
 */
interface SortKey {
  expr: string;
  dir: 'ASC' | 'DESC';
}

/**
 * Ключи сортировки запроса плюс `thought_views`-джойн для `viewed`.
 *
 * `homeFirst` (пустой REST-фильтр) добавляет ведущий ключ «HOME — первой»;
 * `viewed` — два ключа: флаг NULL-метки (NULL последними при `asc`, как в
 * §6.10) и сама метка. Значения ключей совпадают с прежним `ORDER BY`, но
 * теперь дополняются `t.id` в {@link orderClause} — порядок детерминирован.
 */
function sortKeysFor(
  userId: string,
  req: ThoughtQueryRequest,
  homeFirst: boolean,
): { keys: SortKey[]; joinSql: string; joinParams: unknown[] } {
  const dir: 'ASC' | 'DESC' = req.order === 'desc' ? 'DESC' : 'ASC';
  const keys: SortKey[] = [];
  if (homeFirst) keys.push({ expr: '(t.is_root = 1)', dir: 'DESC' });
  switch (req.sort) {
    case 'alpha':
      keys.push({ expr: 't.title COLLATE NOCASE', dir });
      return { keys, joinSql: '', joinParams: [] };
    case 'created':
      keys.push({ expr: 't.created_at', dir });
      return { keys, joinSql: '', joinParams: [] };
    case 'updated':
      // ISO-8601 текстовая колонка — лексикографический порядок совпадает с
      // хронологическим (ошибка 4dd14aa3, 0.8.2).
      keys.push({ expr: 't.updated_at', dir });
      return { keys, joinSql: '', joinParams: [] };
    case 'viewed':
      // NULL-метка: последними при `asc` (прежний `nullsLast`).
      keys.push({ expr: '(tv.last_viewed_at IS NULL)', dir });
      keys.push({ expr: 'tv.last_viewed_at', dir });
      return {
        keys,
        joinSql: 'LEFT JOIN thought_views tv ON tv.user_id = ? AND tv.thought_id = t.id',
        joinParams: [userId],
      };
  }
}

/** Appends an author-condition WHERE clause + params for one column. */
function appendAuthorCondition(
  where: string[],
  params: unknown[],
  column: string,
  value: string | string[] | undefined,
  op: StructureAuthorOp | undefined,
): void {
  const effective = op ?? 'eq';
  if (effective === 'empty') {
    where.push(`${column} IS NULL`);
    return;
  }
  if (effective === 'not_empty') {
    where.push(`${column} IS NOT NULL`);
    return;
  }
  if (value === undefined) return;
  if (effective === 'in' || effective === 'not_in') {
    const ids = Array.isArray(value) ? value : [value];
    const placeholders = ids.map(() => '?').join(',');
    where.push(effective === 'in' ? `${column} IN (${placeholders})` : `${column} NOT IN (${placeholders})`);
    params.push(...ids);
    return;
  }
  if (effective === 'ne') {
    where.push(`${column} IS NULL OR ${column} <> ?`);
    params.push(value);
    return;
  }
  // `eq` (default) — exact match.
  where.push(`${column} = ?`);
  params.push(value);
}

/** Appends inclusive date-bound WHERE clauses (`>=`/`<=`) for one column. */
function appendDateBound(
  where: string[],
  params: unknown[],
  column: string,
  after: string | undefined,
  before: string | undefined,
): void {
  if (typeof after === 'string' && after.trim() !== '') {
    where.push(`${column} >= ?`);
    params.push(after.trim());
  }
  if (typeof before === 'string' && before.trim() !== '') {
    where.push(`${column} <= ?`);
    params.push(before.trim());
  }
}

/** Convert a condition scalar to the SQL parameter of its value column. */
function sqlScalar(
  def: { value_type: PropertyValueType },
  value: string | number | boolean,
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

/** Непустой список непустых строк для операторов наборов (MCP §4.1). */
function coerceValueList(
  value: ThoughtQueryPropertyCondition['value'],
  operator: ThoughtQueryPropertyOperator,
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
  // Проверка выше гарантирует строковый состав массива.
  return [...new Set(value as string[])];
}

/** Раскрыть значение множественного свойства в набор элементов JSON-массива. */
function multipleValueElementsSql(column: string): string {
  return `json_each(CASE WHEN pv.${column} LIKE '[%' THEN pv.${column} ELSE '[' || json_quote(pv.${column}) || ']' END)`;
}

/** Клауза `any_of`/`all_of`/`none_of` по множественному свойству. */
function multipleValueSetClause(
  propertyId: string,
  column: string,
  operator: 'any_of' | 'all_of' | 'none_of',
  value: ThoughtQueryPropertyCondition['value'],
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

/** Минимальная строка реестра свойств для батч-чтения условий. */
interface RegistryPropertyRow {
  id: string;
  value_type: PropertyValueType;
  /** Raw JSON `config` — только для `value_type: 'link'`. */
  config: string | null;
}

/** A WHERE clause fragment plus its bind parameters, in order. */
interface Clause {
  sql: string;
  params: unknown[];
}

/**
 * Клауза условия по свойству-связи (`value_type: 'link'`) — транслируется в
 * запрос по рёбрам (`links_v`), а не по `property_values` (ADR «проекция
 * ребра»). Операторы:
 *
 *   * `eq`/`ne` со строкой — «связь с конкретной целью» (id мысли);
 *   * `eq`/`ne` с boolean — «связь такого типа есть/отсутствует» независимо
 *     от цели (`eq true` / `ne false` — есть; `eq false` / `ne true` — нет);
 *   * `in`/`not_in` (REST) — цель из списка / не из списка;
 *   * `is_empty`/`not_empty` (REST) — наличие/отсутствие любого живого ребра
 *     этого типа;
 *   * `any_of`/`all_of`/`none_of` (MCP) — набор целей рёбер.
 *
 * Направление (`out`/`in`) и тип связи/структурность читаются из `config`
 * теми же хелперами, что использует чтение карточки мысли. `directionRef`
 * (задача df992826) переопределяет направление, когда условие адресовано
 * именем стороны свойства-связи: обратное имя адресует противоположную
 * сторону — клауза смотрит на рёбра со стороны цели.
 */
function linkPropertyClause(
  def: RegistryPropertyRow,
  cond: ThoughtQueryPropertyCondition,
  requestId?: string,
  directionRef: LinkPropertyDirection | null = null,
): Clause {
  let config: PropertyConfig | null = null;
  if (def.config !== null) {
    try {
      config = JSON.parse(def.config) as PropertyConfig;
    } catch {
      config = null;
    }
  }
  const structural = isStructuralLinkProperty(config);
  const linkTypeId = structural ? null : linkPropertyLinkTypeId(config);
  if (!structural && linkTypeId === null) {
    // Некорректный config (валидируется при правке онтологии) — не матчит ничего.
    return { sql: '0', params: [] };
  }
  const direction = directionRef ?? linkPropertyDirection(config);
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
      return cond.operator === 'eq' ? specific : { sql: `NOT ${specific.sql}`, params: specific.params };
    }
    case 'in':
    case 'not_in': {
      if (!Array.isArray(cond.value) || cond.value.length === 0) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Для операции "в списке"/"не в списке" value должен быть непустым массивом.',
          { field: 'value' },
          requestId,
        );
      }
      const values = cond.value.map((v) => sqlScalar(def, v, requestId) as string);
      const placeholders = values.map(() => '?').join(',');
      const match = existsSql(` AND l.${targetCol} IN (${placeholders})`, values);
      return cond.operator === 'in' ? match : { sql: `NOT ${match.sql}`, params: match.params };
    }
    case 'is_empty':
    case 'not_empty': {
      const presence = existsSql('', []);
      return cond.operator === 'not_empty' ? presence : { sql: `NOT ${presence.sql}`, params: presence.params };
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
      // Недостижимо — OPS_BY_VALUE_TYPE['link'] ограничивает набор выше.
      throw new EtnError(
        'VALIDATION_ERROR',
        `Операция ${cond.operator} недопустима для свойства-связи.`,
        { field: 'operator' },
        requestId,
      );
  }
}

/**
 * Build one property-condition clause for a batch of conditions. Addressed
 * registry properties are read in one `SELECT … IN (…)` call; a missing
 * property (deleted after the filter was saved) drops the condition — «нет
 * совпадения», как в обоих прежних движках.
 */
function propertyClauses(
  ndb: NetworkDb,
  conds: ThoughtQueryPropertyCondition[],
  requestId?: string,
): Clause[] {
  if (conds.length === 0) return [];
  // Резолвинг ссылки условия (задача df992826): registry id ИЛИ имя — прямое/
  // обратное имя свойства-связи. Обратное имя даёт клаузу с противоположным
  // направлением рёбер; коллизия имён отвергается с пояснением внутри
  // `resolveConditionPropertyRef`. Неизвестная ссылка — условие отбрасывается
  // («нет совпадения», как и раньше для чужого `property_id`).
  const refs = conds.map((c) => resolveConditionPropertyRef(ndb, c.property_id, requestId));
  const ids = [...new Set(refs.filter((r) => r !== null).map((r) => r.propertyId))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(`SELECT id, value_type, config FROM properties_v WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; value_type: string; config: string | null }>;
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  const out: Clause[] = [];
  for (let i = 0; i < conds.length; i += 1) {
    const cond = conds[i]!;
    const ref = refs[i]!;
    if (ref === null) continue;
    const raw = byId.get(ref.propertyId);
    if (raw === undefined) continue;
    const def: RegistryPropertyRow = { id: raw.id, value_type: raw.value_type as PropertyValueType, config: raw.config };
    const allowed = OPS_BY_VALUE_TYPE[def.value_type];
    if (!allowed.includes(cond.operator)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Операция ${cond.operator} недопустима для свойства типа ${def.value_type}.`,
        { field: 'operator', allowed: [...allowed] },
        requestId,
      );
    }

    if (def.value_type === 'link') {
      out.push(linkPropertyClause(def, cond, requestId, ref.direction));
      continue;
    }

    const column = VALUE_COLUMN[def.value_type];

    // Операторы наборов (задача 20effcbd) — `url` и legacy `thought_ref`.
    if (cond.operator === 'any_of' || cond.operator === 'all_of' || cond.operator === 'none_of') {
      out.push(multipleValueSetClause(def.id, column, cond.operator, cond.value, requestId));
      continue;
    }

    if (cond.operator === 'contains') {
      const pattern = buildLikePattern(String(cond.value));
      out.push({
        sql: `EXISTS (
          SELECT 1 FROM property_values_v pv
          WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
            AND pv.${column} LIKE ? ESCAPE '\\')`,
        params: [def.id, pattern],
      });
      continue;
    }

    // Legacy thought_ref: одиночный id или JSON-массив id — eq/ne/in/not_in
    // раскрывают обе формы через json_each.
    if (def.value_type === 'thought_ref') {
      const elementsSql = multipleValueElementsSql(column);
      if (cond.operator === 'in' || cond.operator === 'not_in') {
        if (!Array.isArray(cond.value) || cond.value.length === 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Для операции "в списке"/"не в списке" value должен быть непустым массивом.',
            { field: 'value' },
            requestId,
          );
        }
        const values = cond.value.map((v) => sqlScalar(def, v, requestId) as string);
        const placeholders = values.map(() => '?').join(',');
        const matchSql = `SELECT 1 FROM property_values_v pv, ${elementsSql} je
           WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
             AND pv.${column} IS NOT NULL AND je.value IN (${placeholders})`;
        out.push(cond.operator === 'in' ? { sql: `EXISTS (${matchSql})`, params: [def.id, ...values] } : { sql: `NOT EXISTS (${matchSql})`, params: [def.id, ...values] });
        continue;
      }
      if (cond.operator === 'is_empty' || cond.operator === 'not_empty') {
        // Заполнено = значение не NULL, не пустая строка, не '[]' и не 'null'.
        const filledExpr = `pv.${column} IS NOT NULL AND pv.${column} != '' AND pv.${column} != '[]' AND pv.${column} != 'null'`;
        const filledSql = `SELECT 1 FROM property_values_v pv
           WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
             AND ${filledExpr}`;
        out.push(
          cond.operator === 'not_empty'
            ? { sql: `EXISTS (${filledSql})`, params: [def.id] }
            : { sql: `NOT EXISTS (${filledSql})`, params: [def.id] },
        );
        continue;
      }
      const value = sqlScalar(def, cond.value as string | number | boolean, requestId) as string;
      const cmp = cond.operator === 'ne' ? '<>' : '=';
      const matchSql = `SELECT 1 FROM property_values_v pv, ${elementsSql} je
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND pv.${column} IS NOT NULL AND je.value ${cmp} ?`;
      out.push({ sql: `EXISTS (${matchSql})`, params: [def.id, value] });
      continue;
    }

    if (cond.operator === 'in' || cond.operator === 'not_in') {
      if (!Array.isArray(cond.value) || cond.value.length === 0) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Для операции "в списке"/"не в списке" value должен быть непустым массивом.',
          { field: 'value' },
          requestId,
        );
      }
      const values = cond.value.map((v) => sqlScalar(def, v, requestId));
      const listSql = `SELECT 1 FROM property_values_v pv
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND pv.${column} IN (${values.map(() => '?').join(',')})`;
      out.push(cond.operator === 'in' ? { sql: `EXISTS (${listSql})`, params: [def.id, ...values] } : { sql: `NOT EXISTS (${listSql})`, params: [def.id, ...values] });
      continue;
    }

    if (cond.operator === 'is_empty' || cond.operator === 'not_empty') {
      // Присутствие значения решает строка + колонка; пустая строка — «пусто».
      const filledExpr = `pv.${column} IS NOT NULL AND pv.${column} != ''`;
      const filledSql = `SELECT 1 FROM property_values_v pv
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND ${filledExpr}`;
      out.push(
        cond.operator === 'not_empty'
          ? { sql: `EXISTS (${filledSql})`, params: [def.id] }
          : { sql: `NOT EXISTS (${filledSql})`, params: [def.id] },
      );
      continue;
    }

    const value = sqlScalar(def, cond.value as string | number | boolean, requestId);
    const opSql =
      cond.operator === 'eq' ? '=' :
      cond.operator === 'ne' ? '<>' :
      cond.operator === 'gt' ? '>' :
      cond.operator === 'gte' ? '>=' :
      cond.operator === 'lt' ? '<' : '<=';
    out.push({
      sql: `EXISTS (
        SELECT 1 FROM property_values_v pv
        WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
          AND pv.${column} ${opSql} ?)`,
      params: [def.id, value],
    });
  }
  return out;
}

/**
 * True when the filter carries no criteria at all (REST-контракт «пустой
 * фильтр → HOME + сироты»). `active` считается критерием только в явном
 * значении `'true'`/`'false'` — REST-адаптер сворачивает «active не задан +
 * show_inactive» в `'any'`, которое на пустой фильтр не влияет (так было в
 * прежнем REST-движке: `isFilterEmpty` не смотрел `show_inactive`).
 * `trashed` на пустоту не влияет — тоже наследие REST-движка.
 */
function isFilterEmpty(req: ThoughtQueryRequest): boolean {
  return (
    (req.keywords ?? '').trim() === '' &&
    !isLinkTypeFilterActive(req.link_filter) &&
    (req.type_ids ?? []).length === 0 &&
    (req.link_type_ids ?? []).length === 0 &&
    (req.properties ?? []).length === 0 &&
    req.has_properties === undefined &&
    req.has_comment === undefined &&
    req.has_attachments === undefined &&
    req.has_chronology === undefined &&
    (req.active === undefined || req.active === 'any') &&
    authorFilterIsEmpty(req.created_by, req.created_by_op) &&
    authorFilterIsEmpty(req.updated_by, req.updated_by_op) &&
    !dateBoundIsSet(req.created_after) &&
    !dateBoundIsSet(req.created_before) &&
    !dateBoundIsSet(req.updated_after) &&
    !dateBoundIsSet(req.updated_before) &&
    req.subtree === undefined
  );
}

/** True when a date bound carries a non-empty value worth applying. */
function dateBoundIsSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** True when the author condition carries no useful clause. */
function authorFilterIsEmpty(
  value: string | string[] | undefined,
  op: StructureAuthorOp | undefined,
): boolean {
  if (op === 'empty' || op === 'not_empty') return false;
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value === '';
}

/**
 * Shared WHERE/ORDER BY of the filter query: the paged ref query and the
 * id-only query must run over exactly the same candidate set.
 */
interface FilterQuerySql {
  /** `FROM thoughts_v t … WHERE …` with `?` placeholders (join params first). */
  baseSql: string;
  /** JOIN parameters, bound before the WHERE parameters. */
  joinParams: unknown[];
  /** WHERE parameters (без keyset-параметров). */
  params: unknown[];
  /** Детерминированный порядок: ключи сортировки + завершающий `t.id`. */
  keys: SortKey[];
  /** Направление завершающего ключа `t.id` (совпадает с направлением сортировки). */
  idDir: 'ASC' | 'DESC';
  /** Предикат продолжения страницы по курсору (`null` — пагинация по OFFSET). */
  keyset: Clause | null;
  /** Empty filter pins HOME first with an extra leading sort key. */
  homeFirst: boolean;
}

const CURSOR_VERSION = 1;

/** Разобранный keyset-курсор: ключ сортировки последней строки страницы. */
interface QueryCursor {
  v: number;
  s: StructureSort;
  o: SortOrder;
  /** `1` — режим «пустой фильтр» (HOME первой); иначе `0`. */
  h: 0 | 1;
  /** Значения ключей сортировки последней строки (в порядке {@link SortKey}). */
  k: Array<string | number | null>;
  /** id последней строки (уникальный добор ключа, ADR 5f6cb775). */
  id: string;
}

/** Кодировать курсор в непрозрачную строку (base64url JSON). */
function encodeCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Разобрать и провалидировать курсор. Курсор обязан соответствовать
 * `sort`/`order`/режиму пустого фильтра текущего запроса — иначе продолжение
 * страницы читалось бы по чужому порядку (потеря/дубли строк).
 */
function decodeCursor(
  raw: string,
  req: ThoughtQueryRequest,
  homeFirst: boolean,
  requestId?: string,
): QueryCursor {
  const invalid = (details: Record<string, unknown> = {}): never => {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Некорректный keyset-курсор: продолжение страницы невозможно.',
      { field: 'cursor', ...details },
      requestId,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid();
  const c = parsed as Partial<QueryCursor>;
  if (c.v !== CURSOR_VERSION) return invalid({ reason: 'version' });
  if (c.s !== req.sort || c.o !== req.order) return invalid({ reason: 'sort' });
  if (c.h !== (homeFirst ? 1 : 0)) return invalid({ reason: 'mode' });
  if (!Array.isArray(c.k) || typeof c.id !== 'string' || c.id === '') return invalid({ reason: 'shape' });
  if (c.k.some((v) => v !== null && typeof v !== 'string' && typeof v !== 'number')) {
    return invalid({ reason: 'value' });
  }
  return c as QueryCursor;
}

/**
 * Предикат «строка идёт после курсорной» по ключам `keys` + `t.id`.
 *
 * Лексикографическое сравнение раскрывается в дизъюнкцию: для каждой позиции —
 * «все предыдущие ключи равны, текущий строго больше», плюс финальная ветка
 * «все ключи равны, `id` строго больше». Значение `null` в ключе сравнимо
 * только по равенству (`IS NULL`): NULL-значение возможно лишь у последнего
 * ключа `viewed`, и он изолирован флагом NULL-метки (внутри флага значения
 * либо все NULL, либо все не-NULL), поэтому ветка «строго больше» для него
 * невозможна и пропускается — иначе строки бы дублировались/терялись.
 */
function keysetClause(
  keys: SortKey[],
  idDir: 'ASC' | 'DESC',
  values: Array<string | number | null>,
  id: string,
): Clause {
  const params: unknown[] = [];
  const branches: string[] = [];
  /** Собрать одну ветку; `null` — ветку пропустить (её параметры не копим). */
  const buildBranch = (build: (push: (value: string | number) => string) => string): void => {
    const branchParams: unknown[] = [];
    const push = (value: string | number): string => {
      branchParams.push(value);
      return '?';
    };
    const sql = build(push);
    branches.push(sql);
    params.push(...branchParams);
  };
  const eq = (push: (v: string | number) => string, key: SortKey, value: string | number | null): string =>
    value === null ? `${key.expr} IS NULL` : `${key.expr} = ${push(value)}`;
  const gt = (push: (v: string | number) => string, key: SortKey, value: string | number | null): string | null =>
    value === null ? null : `${key.expr} ${key.dir === 'ASC' ? '>' : '<'} ${push(value)}`;

  for (let i = 0; i < keys.length; i += 1) {
    const gtSql = gt(() => '?', keys[i]!, values[i] ?? null);
    if (gtSql === null) continue; // нет строк «строго после» по этому ключу
    buildBranch((push) => {
      const conds: string[] = [];
      for (let j = 0; j < i; j += 1) conds.push(eq(push, keys[j]!, values[j] ?? null));
      conds.push(gt(push, keys[i]!, values[i] ?? null) as string);
      return `(${conds.join(' AND ')})`;
    });
  }
  buildBranch((push) => {
    const conds: string[] = [];
    for (let j = 0; j < keys.length; j += 1) conds.push(eq(push, keys[j]!, values[j] ?? null));
    conds.push(`t.id ${idDir === 'ASC' ? '>' : '<'} ${push(id)}`);
    return `(${conds.join(' AND ')})`;
  });
  return { sql: `(${branches.join(' OR ')})`, params };
}

/**
 * WHERE страницы: базовый фильтр плюс (при курсоре) keyset-предикат.
 * COUNT/полный обход считаются по базовому фильтру без keyset — `total` обязан
 * быть полным числом совпадений, а не остатком от курсора.
 */
function pageWhere(sql: FilterQuerySql): { sql: string; params: unknown[] } {
  if (sql.keyset === null) return { sql: sql.baseSql, params: sql.params };
  return { sql: `${sql.baseSql} AND ${sql.keyset.sql}`, params: [...sql.params, ...sql.keyset.params] };
}

/** ORDER BY: ключи сортировки + уникальный добор `t.id` (ADR 5f6cb775). */
function orderClause(sql: FilterQuerySql): string {
  return `${sql.keys.map((k) => `${k.expr} ${k.dir}`).join(', ')}, t.id ${sql.idDir}`;
}

/** SELECT-хвост вытаскивает значения ключей сортировки для сборки курсора. */
function cursorKeyColumns(keys: SortKey[]): string {
  return keys.map((k, i) => `, ${k.expr} AS __k${i}`).join('');
}

function buildFilterQuerySql(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  walk: WalkResult | null,
  emptyFilterMode: 'home_orphans' | 'all',
  requestId?: string,
): FilterQuerySql {
  const homeFirst = emptyFilterMode === 'home_orphans' && isFilterEmpty(req);
  const { keys, joinSql, joinParams } = sortKeysFor(userId, req, homeFirst);
  const idDir: 'ASC' | 'DESC' = req.order === 'desc' ? 'DESC' : 'ASC';
  const cursor =
    typeof req.cursor === 'string' && req.cursor.trim() !== ''
      ? decodeCursor(req.cursor.trim(), req, homeFirst, requestId)
      : null;
  const keyset = cursor === null ? null : keysetClause(keys, idDir, cursor.k, cursor.id);

  if (homeFirst) {
    const showInactive = req.active === 'any' ? 1 : 0;
    return {
      baseSql: `FROM thoughts_v t ${joinSql}
       WHERE t.is_root = 1 OR (
         t.is_root = 0 AND (t.active = 1 OR ?) AND NOT EXISTS (
           SELECT 1 FROM links_v l WHERE l.target_id = t.id AND l.active = 1))`,
      joinParams,
      params: [showInactive],
      keys,
      idDir,
      keyset,
      homeFirst: true,
    };
  }

  const where: string[] = [];
  const params: unknown[] = [];

  // Актуальность: явное значение или дефолт «только активные».
  if (req.active === 'true' || req.active === undefined) {
    where.push('t.active = 1');
  } else if (req.active === 'false') {
    where.push('t.active = 0');
  }

  // Пометка на удаление (S13): дефолт — только непомеченные.
  if (req.trashed === 'true') {
    where.push('t.marked_for_deletion = 1');
  } else if (req.trashed === 'false' || req.trashed === undefined) {
    where.push('t.marked_for_deletion = 0');
  }

  appendAuthorCondition(where, params, 't.created_by', req.created_by, req.created_by_op);
  appendAuthorCondition(where, params, 't.updated_by', req.updated_by, req.updated_by_op);

  appendDateBound(where, params, 't.created_at', req.created_after, req.created_before);
  appendDateBound(where, params, 't.updated_at', req.updated_after, req.updated_before);

  if (req.subtree !== undefined && walk !== null) {
    if (walk.depths.size === 0) {
      // Поддерево пустое — кандидатов нет (REST-семантика прежнего движка).
      where.push('0');
    } else {
      const ids = [...walk.depths.keys()];
      where.push(`t.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
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
  // FTS-сужатель (требование 314cbb8d): `fts_thought_names` джойнится по rowid
  // победившей версии из представления (`t.rowid`), LIKE остаётся остаточным
  // фильтром и хранит семантику мини-языка §6.10.
  const keywordFts = buildKeywordFtsJoin(keywords.include, keywordScope);
  const fromJoinSql = keywordFts === null ? joinSql : `${joinSql} ${keywordFts.sql}`;
  const fromJoinParams = keywordFts === null ? joinParams : [...joinParams, ...keywordFts.params];
  for (const word of keywords.include) {
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

  for (const clause of propertyClauses(ndb, req.properties ?? [], requestId)) {
    where.push(clause.sql);
    params.push(...clause.params);
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

  return {
    baseSql: `FROM thoughts_v t ${fromJoinSql} WHERE ${where.length > 0 ? where.join(' AND ') : '1=1'}`,
    joinParams: fromJoinParams,
    params,
    keys,
    idDir,
    keyset,
    homeFirst: false,
  };
}

/** Count the unrestricted matches of a built filter query (без keyset). */
function countFilterMatches(ndb: NetworkDb, sql: FilterQuerySql): number {
  return (
    ndb.prepare(`SELECT COUNT(*) AS c ${sql.baseSql}`).get(...sql.joinParams, ...sql.params) as {
      c: number;
    }
  ).c;
}

/** Построенный запрос вместе с диагностикой обхода поддерева (MCP truncated/reason). */
interface BuiltQuery {
  sql: FilterQuerySql;
  walk: WalkResult | null;
}

function buildQuery(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  emptyFilterMode: 'home_orphans' | 'all',
  requestId?: string,
): BuiltQuery {
  const walk = req.subtree === undefined ? null : walkSubtree(ndb, req.subtree);
  const sql = buildFilterQuerySql(ndb, userId, req, walk, emptyFilterMode, requestId);
  return { sql, walk };
}

/**
 * Единый движок выборки мыслей по критериям — одна реализация операции для
 * REST и MCP (задача c5265deb). См. описание модуля.
 *
 * Пагинация (требование 3f2fdc41): страница читается с запасом `limit + 1`,
 * чтобы `has_more` и `next_cursor` считались без полного COUNT; при переданном
 * курсоре вместо OFFSET применяется keyset-предикат. `total` считается только
 * по явному флагу `count` (требование 5adebf61).
 */
export function queryThoughts(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  opts: ThoughtQueryOptions = {},
): ThoughtQueryResult {
  const emptyFilterMode = opts.emptyFilterMode ?? 'all';
  const built = buildQuery(ndb, userId, req, emptyFilterMode);
  const sql = built.sql;
  const walk = built.walk;
  const maxLimit = opts.maxLimit ?? STRUCTURES_QUERY_MAX_LIMIT;
  const limit = Math.min(Math.max(req.limit, 1), maxLimit);
  const offset = Math.max(req.offset, 0);
  const where = pageWhere(sql);
  const useCursor = sql.keyset !== null;
  const rows = ndb
    .prepare(
      `SELECT ${REF_COLUMNS}${cursorKeyColumns(sql.keys)} ${where.sql}
       ORDER BY ${orderClause(sql)}
       LIMIT ?${useCursor ? '' : ' OFFSET ?'}`,
    )
    .all(
      ...sql.joinParams,
      ...where.params,
      limit + 1,
      ...(useCursor ? [] : [offset]),
    ) as Array<ThoughtRefRow & Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(rowToThoughtRef);
  // Курсор отдаётся только когда за страницей есть строки: иначе клиент ходил
  // бы за пустым хвостом (требование 3f2fdc41).
  const nextCursor = hasMore ? buildNextCursor(sql, req, pageRows) : null;
  const directions = opts.includeDirections === true ? directionsOf(ndb, items.map((i) => i.id), req.link_filter, opts.showTrash !== false) : {};
  return {
    items,
    total: req.count === true ? countFilterMatches(ndb, sql) : null,
    has_more: hasMore,
    next_cursor: nextCursor,
    directions,
    depths: walk === null ? null : new Map(items.map((i) => [i.id, walk.depths.get(i.id)]).filter((e): e is [string, number] => e[1] !== undefined)),
    truncated: walk?.truncated ?? false,
    reason: walk?.reason ?? null,
  };
}

/**
 * Собрать курсор следующей страницы из последней строки текущей: значения
 * ключей сортировки (`__k<i>`) плюс уникальный `id`. `null`, когда страница
 * пуста или это последняя страница (`has_more` = false) — курсор не выдаётся
 * впустую.
 */
function buildNextCursor<T extends Record<string, unknown>>(
  sql: FilterQuerySql,
  req: ThoughtQueryRequest,
  pageRows: T[],
): string | null {
  const last = pageRows[pageRows.length - 1];
  if (last === undefined) return null;
  const keys = sql.keys.map((_, i) => {
    const value = last[`__k${i}`];
    return value === undefined ? null : (value as string | number | null);
  });
  return encodeCursor({
    v: CURSOR_VERSION,
    s: req.sort,
    o: req.order,
    h: sql.homeFirst ? 1 : 0,
    k: keys,
    id: String(last['id']),
  });
}

/**
 * Id-only variant: the same candidate set and ordering as {@link queryThoughts},
 * but the page carries bare ids (REST `ids_only: true`, bulk filter commands).
 */
export function queryThoughtIds(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  opts: ThoughtQueryOptions = {},
): ThoughtIdsQueryResult {
  const emptyFilterMode = opts.emptyFilterMode ?? 'all';
  const sql = buildQuery(ndb, userId, req, emptyFilterMode).sql;
  const maxLimit = opts.maxLimit ?? STRUCTURES_QUERY_MAX_LIMIT;
  const limit = Math.min(Math.max(req.limit, 1), maxLimit);
  const offset = Math.max(req.offset, 0);
  const where = pageWhere(sql);
  const useCursor = sql.keyset !== null;
  const rows = ndb
    .prepare(
      `SELECT t.id${cursorKeyColumns(sql.keys)} ${where.sql}
       ORDER BY ${orderClause(sql)}
       LIMIT ?${useCursor ? '' : ' OFFSET ?'}`,
    )
    .all(
      ...sql.joinParams,
      ...where.params,
      limit + 1,
      ...(useCursor ? [] : [offset]),
    ) as Array<{ id: string } & Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    ids: pageRows.map((r) => r.id),
    total: req.count === true ? countFilterMatches(ndb, sql) : null,
    has_more: hasMore,
    next_cursor: hasMore ? buildNextCursor(sql, req, pageRows) : null,
  };
}
