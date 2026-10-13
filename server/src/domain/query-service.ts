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
 *     потолком глубины и лимитом узлов; корни входят в результат у обоих
 *     фасадов (REST `parent_ids`, MCP `in_subtree_of` — ошибка ad1551ea),
 *     MCP дополнительно сообщает обрезку `truncated`/`reason`;
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
  FILTER_AST_VERSION,
  HIERARCHY_SUBTREE_MAX_NODES,
  STRUCTURES_PARENT_SCOPE_MAX_DEPTH,
  STRUCTURES_QUERY_MAX_LIMIT,
  TRAVERSAL_DEFAULTS,
  buildLikePattern,
  isLinkTypeFilterActive,
  parseFilterKeywords,
  type FilterAst,
  type FilterAstEntity,
  type FilterAstHierarchyMode,
  type FilterAstLeaf,
  type FilterAstListItem,
  type FilterAstNode,
  type FilterAstOperator,
  type FilterAstScalar,
  type FilterAstSortKey,
  type FilterAstSubqueryValue,
  type FilterAstValue,
  type FilterProfileId,
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
import { diagnoseFilterAst, filterDiagnosticsError } from './filter-diagnostics.js';
import { assertFilterAstInProfile } from './filter-profile-validation.js';
import { collectHierarchySubtree } from './graph-traversal.js';
import { getLinkDirections } from './link-service.js';
import {
  getNetworkProperty,
  isStructuralLinkProperty,
  linkPropertyDirection,
  linkPropertyLinkTypeId,
  listEffectiveTypeProperties,
  resolveConditionPropertyRef,
} from './property-service.js';
import { nameTrigramMatch } from './search-service.js';
import { rowToThoughtRef } from './thought-service.js';
import { expandTypeIdsToSubtree, linkTypeFilterClause, listTypeNodes } from './type-hierarchy.js';
import { resolveGlobalDateTokens, type TokenIssue } from './thought-type-view-tokens.js';

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
 * Ограничение поддерева. Оба фасада включают корни (перечисленные мысли) в
 * набор кандидатов: REST `parent_ids` — с `depth ≥ 0` (ошибка ad1551ea,
 * 0.12.1), MCP `in_subtree_of` — с `depth 0`. Отличия фасадов только в
 * деталях обхода: REST включает неактивные рёбра при `show_inactive`, MCP
 * ходит только по активным связям и сообщает обрезку по лимиту узлов.
 */
export interface ThoughtQuerySubtree {
  /** Корни обхода (REST — несколько, OR; MCP — один). */
  roots: string[];
  /** `true` — корни входят в набор кандидатов; в 0.12.1 у обоих фасадов. */
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
  /**
   * Дерево условий AST (задача 9c156b8c). Задано — критерии берутся только из
   * него (единый исполнитель {@link filterAstClause}), плоские поля-критерии
   * игнорируются, неявные дефолты `active`/`trashed` не применяются: отбор
   * выражен деревом целиком. Сортировка/пагинация/курсор действуют как обычно.
   */
  ast?: FilterAst;
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
  /**
   * Контекст разрешения токенов AST-листьев (0.13.1, задача 0f1b9892):
   * настройка сети «первый день недели», профиль со временем, часы для тестов.
   * Не задан — токены раскрываются с дефолтами (понедельник, датовый профиль,
   * реальные часы). `$thought.*` в сетевом запросе контекста мысли не имеет и
   * даёт неразрешимость.
   */
  tokenContext?: AstTokenContext;
  /**
   * Собирать статистику исполнения (требование 0f34a5ff «Статистика
   * исполнения отборов при серверном логировании»). Флаг включается фасадом
   * ТОЛЬКО когда серверное журналирование включено: при выключенном
   * логировании счётчики не собираются — накладных расходов нет.
   */
  collectStats?: boolean;
  /**
   * Профиль контекста точки применения отбора (требование 0095daad, ADR
   * 0c02ab4f; задача 7a798b17). Задан — явное AST-тело проверяется на видимость
   * операндов/операторов в этом профиле (невидимый операнд →
   * `VALIDATION_ERROR`). Не задан — проверки по профилю нет (обратная
   * совместимость внутренних вызовов движка).
   */
  profile?: FilterProfileId;
}

/**
 * Статистика одного исполнения отбора (требование 0f34a5ff). Наружу (в
 * API-ответ) не выводится — пользователь фасада пишет её в серверный журнал.
 */
export interface QueryStats {
  /** Время исполнения запроса, мс. */
  duration_ms: number;
  /** Число условий-листьев, попавших в план обхода. */
  conditions: number;
  /** Число обойдённых узлов (иерархия/под-выборки). */
  nodes_walked: number;
  /** Число обращений к обходу иерархии («в иерархии»). */
  hierarchy_calls: number;
  /** Сработавшие ресурсные предохранители (имена), без ошибки. */
  limits_hit: string[];
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
  /**
   * Неразрешимые токены AST (требование b7fdab20). Непусто — отбор не выполнен:
   * `items` пуст, пояснения — здесь. Отсутствует/пусто — всё разрешилось.
   */
  unresolved?: TokenIssue[];
  /** Статистика исполнения (только при `collectStats`, требование 0f34a5ff). */
  stats?: QueryStats;
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
  /** Неразрешимые токены AST (непусто — `ids` пуст, см. {@link ThoughtQueryResult.unresolved}). */
  unresolved?: TokenIssue[];
  /** Статистика исполнения (только при `collectStats`, требование 0f34a5ff). */
  stats?: QueryStats;
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
 * `parent_ids` превращаются в поддерево REST-режима: корни (перечисленные
 * мысли) входят в результат (ошибка ad1551ea, 0.12.1 — выравнивание с MCP
 * `in_subtree_of`), глубина {@link STRUCTURES_PARENT_SCOPE_MAX_DEPTH},
 * неактивные рёбра — по `show_inactive`.
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
            include_roots: true,
            max_depth: STRUCTURES_PARENT_SCOPE_MAX_DEPTH,
            include_inactive_links: req.show_inactive === true,
            link_filter: req.link_filter,
          }
        : undefined,
    // `sort`/`order` необязательны у запроса-фасада: тело-дерево (`ast`) несёт
    // порядок в `ast.sort`, и плоская пара тогда не передаётся (задача
    // 213bd2d2). Дефолты — те же, что у роута (`parseQueryBody`).
    sort: req.sort ?? 'created',
    order: req.order ?? 'asc',
    limit: req.limit,
    offset: req.offset,
    count: req.count,
    cursor: req.cursor,
  };
}

/**
 * Граница пользовательского ввода (ошибки 090d0242, 4f17cb73 и f4580fff,
 * 0.12.1): убедиться, что каждая ссылка на свойство в условиях отбора
 * разрешается в реестре сети, иначе — `NOT_FOUND` с указанием поля. Код
 * выровнен по конвенции резолва реестровых сущностей (как у типа:
 * `resolveThoughtTypeIdByName` — несуществующее имя → `NOT_FOUND`,
 * неоднозначность → `VALIDATION_ERROR` с `details.candidates`; см.
 * `etn.guide { topic: "thoughts.query" }`): ссылка на несуществующую
 * реестровую сущность → `NOT_FOUND` — и по имени, и по id. Движок выборки
 * (`propertyClauses`) на такую ссылку даёт «нет совпадений» (`NO_MATCH_CLAUSE`),
 * а не ошибку (он тотален и обслуживает сохранённые рецепты/веер); фасады,
 * принимающие ввод от пользователя (`POST /thoughts/query`,
 * `etn.thoughts.query`), обязаны отвергнуть неразрешимую ссылку явно, чтобы
 * отбор не выглядел пустым молча.
 */
export function assertPropertyConditionsResolvable(
  ndb: NetworkDb,
  conditions: ReadonlyArray<{ property_id: string }> | undefined,
  requestId?: string,
): void {
  for (const cond of conditions ?? []) {
    if (getNetworkProperty(ndb, cond.property_id) === null) {
      throw new EtnError(
        'NOT_FOUND',
        `Свойство «${cond.property_id}» не найдено в реестре сети.`,
        { field: 'property_id', property_id: cond.property_id },
        requestId,
      );
    }
  }
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
 * `properties[].property_id`). Условие без адреса свойства больше НЕ
 * отбрасывается молча (ошибка 090d0242, 0.12.1): это `VALIDATION_ERROR` —
 * иначе отбор незаметно расширяется. Дефолты MCP-контракта: лимит 50,
 * смещение 0, `active` `'true'`, `trashed` `'false'`, сортировка `title`
 * (= `alpha`) `asc`.
 */
export function mcpRequestToQuery(
  req: McpThoughtQueryRequest & { readonly ast?: FilterAst },
  bounds: { maxNodes: number },
): ThoughtQueryRequest {
  const maxDepth = Math.min(
    Math.max(req.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH, 1),
    TRAVERSAL_DEFAULTS.MAX_DEPTH,
  );
  assertAstSortNotConflicting(req);
  return {
    type_ids: req.type_id,
    ast: req.ast,
    properties: (req.properties ?? []).map((c) => {
      if (typeof c.property_id !== 'string' || c.property_id === '') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Условие свойства не адресует свойство: укажите property_id или property.',
          { field: 'property_id' },
        );
      }
      return {
        property_id: c.property_id,
        operator: c.operator,
        value: c.value,
      };
    }),
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

/**
 * Проверка сортировки MCP-запроса с AST-телом (задача cb78315b, расширено
 * задачей 3a157e66). Wire-формат AST несёт многоуровневый `sort: [{ key, order }]`
 * — он принимается целиком и исполняется единым движком (требование 3e47f52a);
 * ограничение «ровно один ключ» снято. Внешние `sort`/`order` инструмента и
 * `ast.sort` — два источника одного порядка: одновременная передача —
 * `VALIDATION_ERROR` (конвенция cb78315b «оставьте один источник»).
 */
function assertAstSortNotConflicting(
  req: McpThoughtQueryRequest & { readonly ast?: FilterAst },
): void {
  const keys = req.ast?.sort;
  if (keys === undefined || keys.length === 0) return;
  if (req.sort !== undefined || req.order !== undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Сортировка задана дважды: в теле ast (sort) и в полях sort/order инструмента — оставьте один источник.',
      { field: 'sort' },
    );
  }
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
  't.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id, t.icon_color,' +
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
 *
 * Экспортируется для сторожа паритета с декларацией профилей
 * (`PROPERTY_OPERATOR_SETS` в `@etn/shared`, требование 9bdddad6): гейт плоской
 * формы — подмножество AST-набора (тест `filter-profiles.test.ts`).
 */
export const OPS_BY_VALUE_TYPE: Record<PropertyValueType, readonly ThoughtQueryPropertyOperator[]> = {
  // `text` с `config.multiple` — множественное скалярное свойство (02-data-model
  // §3.4–3.5); наборные операторы для него предусмотрены требованием 92b9c55b,
  // матчинг поэлементный (ошибка 7489e4d9).
  text: [
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
  // Ссылка на публикацию сети (0.7.1… 0.11.1, задача f37b468d, требование
  // 9ce84a2b): та же матрица, что у cross_network_ref — отбор по id.
  publication: ['eq', 'ne', 'any_of', 'all_of', 'none_of'],
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
  // Ссылка на публикацию: id в value_text (single или JSON-массив) — как
  // cross_network_ref, отдельной колонки нет.
  publication: 'value_text',
};

/**
 * Виды значений, для которых текстовое сравнение регистронезависимо
 * (ADR 9779dd21 «равно — строгое, текст регистронезависимо»; требование
 * f14e48ab для «содержит»). SQLite `COLLATE NOCASE` кириллицу не покрывает —
 * регистр сворачивается функцией `unicode_lower` с обеих сторон.
 */
const CASE_FOLDED_VALUE_TYPES: ReadonlySet<PropertyValueType> = new Set<PropertyValueType>(['text', 'url']);

/** Нужно ли сворачивать регистр текстового сравнения для этого вида значения. */
function foldsCase(def: { value_type: PropertyValueType }): boolean {
  return CASE_FOLDED_VALUE_TYPES.has(def.value_type);
}

/** Default keyword scope: title + synonyms only (the original behaviour). */
const DEFAULT_KEYWORD_SCOPE: readonly StructureKeywordScope[] = ['title', 'synonyms'];

function resolveKeywordScope(scope: StructureKeywordScope[] | undefined): Set<StructureKeywordScope> {
  return new Set(scope !== undefined && scope.length > 0 ? scope : DEFAULT_KEYWORD_SCOPE);
}

/** Клауза совпадения «Есть слова»: SQL-предикат и число LIKE-параметров в нём. */
interface KeywordMatchClause {
  sql: string;
  paramCount: number;
}

/**
 * Условие области «в дневниках» (`diary`, ошибка 2bc251de, требование 0882f8d5)
 * для мысли-кандидата: её хронологическая запись содержит слово. Текст записи —
 * тело И заголовок — ровно так, как путь «текст самой записи» компилирует
 * хроника (`record_body`/`record_title`, задача 608ecb79).
 *
 * Одна точка правды: этот же предикат использует плоский компилятор хроники
 * (`chronicle-service.thoughtKeywordCond`), иначе AST-лист и `keyword_scope`
 * разъехались бы (тот же класс дефекта, что fc97548d).
 *
 * @param alias алиас `thoughts_v` в объемлющем SQL (у обоих вызывающих — `t`).
 */
export function diaryKeywordClause(alias = 't'): KeywordMatchClause {
  return {
    sql:
      `EXISTS (SELECT 1 FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = ${alias}.id` +
      " AND c.kind = 'chronological'" +
      " AND (unicode_lower(c.body_md) LIKE ? ESCAPE '\\'" +
      " OR unicode_lower(IFNULL(c.title, '')) LIKE ? ESCAPE '\\'))",
    paramCount: 2,
  };
}

/**
 * Одна клауза совпадения по словам для эффективного набора областей: `title`,
 * `synonyms`, `comment` (постоянный комментарий мысли) и/или `diary`
 * (хронологические записи мысли) — OR между выбранными источниками. LIKE-образец
 * строит {@link buildLikePattern} (экранирование `%`/`_`/`\`, `*` → `%`),
 * поэтому совпадение инфиксное и регистронезависимое.
 *
 * `opts.commentIncludesLinkComments` (требование ce111b0d, ошибка fc97548d) —
 * контекст ФАЗЫ 1 ОТБОРА ХРОНИКИ: область `comment` ищет и комментарии
 * инцидентных связей мысли с обеих сторон. Опцию ставит только исполнитель
 * хроники (`chronicle-service.targetsLeafClause`); семантика отбора мыслей
 * (требование b363cad1 — только постоянный комментарий самой мысли) не меняется.
 */
function buildKeywordClause(
  scope: Set<StructureKeywordScope>,
  opts?: { commentIncludesLinkComments?: boolean },
): KeywordMatchClause {
  const parts: KeywordMatchClause[] = [];
  if (scope.has('title')) parts.push({ sql: "t.title_norm LIKE ? ESCAPE '\\'", paramCount: 1 });
  if (scope.has('synonyms')) {
    parts.push({
      sql:
        'EXISTS (SELECT 1 FROM thought_synonyms_v ts' +
        " WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\')",
      paramCount: 1,
    });
  }
  if (scope.has('comment')) {
    parts.push({
      sql:
        "EXISTS (SELECT 1 FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = t.id" +
        " AND c.kind = 'permanent' AND unicode_lower(c.body_md) LIKE ? ESCAPE '\\')",
      paramCount: 1,
    });
    if (opts?.commentIncludesLinkComments === true) {
      // Комментарии инцидентных связей с обеих сторон — как в плоском
      // `thoughtKeywordCond` (тип комментария не сужается: и постоянные, и
      // записи дневника связи), требование ce111b0d.
      parts.push({
        sql:
          'EXISTS (SELECT 1 FROM comments_v c2' +
          " JOIN comment_targets_v ct2 ON ct2.comment_id = c2.id AND ct2.owner_type = 'link'" +
          ' JOIN links_v l2 ON l2.id = ct2.owner_id AND (l2.source_id = t.id OR l2.target_id = t.id)' +
          " WHERE unicode_lower(c2.body_md) LIKE ? ESCAPE '\\')",
        paramCount: 1,
      });
    }
  }
  if (scope.has('diary')) parts.push(diaryKeywordClause('t'));
  return {
    sql: `(${parts.map((p) => p.sql).join(' OR ')})`,
    paramCount: parts.reduce((sum, p) => sum + p.paramCount, 0),
  };
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
 *   представлением или в области есть комментарий либо дневниковые записи).
 */
function buildKeywordFtsJoin(
  include: string[],
  scope: Set<StructureKeywordScope>,
): Clause | null {
  if (include.length === 0 || scope.has('comment') || scope.has('diary')) return null;
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
    // Корни (depth 0) входят в набор кандидатов, когда `include_roots`
    // (в 0.12.1 — у обоих фасадов, ошибка ad1551ea).
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
 *
 * `tag` — идентичность ключа для подписи курсора ({@link sortSignature}). Для
 * ключей-свойств `expr` ссылается на псевдоним (`psv<индекс>`), который НЕ
 * различает свойства одного вида на одном индексе («Срок» и «Дедлайн» дали бы
 * одинаковый `psv0.value_date`) — поэтому в подпись входит `property_id`.
 */
interface SortKey {
  expr: string;
  dir: 'ASC' | 'DESC';
  /** Тег идентичности ключа (у ключей-свойств — `property:<id>`). */
  tag?: string;
}

/**
 * Ключи AST-сортировки (`FilterAstSortKey[]`) в ключи SQL-движка.
 *
 * Многоуровневая (порядок ключей = порядок объявления), направление на каждый
 * ключ (требование 3e47f52a). Фиксированные ключи — `title`/`created_at`/
 * `updated_at`; прочие — свойства реестра (по id, каноническому имени либо
 * ИМЕНИ СТОРОНЫ свойства-связи). По булевым ложь раньше истины при возрастании
 * (SQLite хранит `bool` как 0/1). Пустые значения свойства — в конце списка при
 * любом направлении (ведущий ключ `(expr IS NULL)`), чтобы заполненные строки
 * шли первыми. Уникальный добор `t.id` добавляется в {@link orderClause} —
 * стабильная пагинация.
 *
 * Свойства-связи поддержаны (требование 8334b54a, ADR 23fab347: исполнитель
 * принимает всё, что позволил сохранить конструктор; ошибка 335b23cb). Значение
 * свойства-связи — мысль (цель ребра своего типа связи), поэтому ключ сортирует
 * по НАЗВАНИЮ связанной мысли: коррелированный агрегат `MIN(название)` по живым
 * рёбрам нужной стороны. Агрегат берётся один раз на мысль (подзапрос в JOIN с
 * `GROUP BY`), а не размножает строки страницы, как джойн значений; при
 * нескольких связях ключ детерминирован (минимальное название), пустая сторона —
 * в конце, как у скалярных свойств. Сторона адресуется тем же резолвером, что и
 * условия ({@link resolveConditionPropertyRef}): обратное имя свойства-связи
 * сортирует по связывающим мыслям, а не по целям.
 */
function astSortClause(
  ndb: NetworkDb,
  sortKeys: readonly FilterAstSortKey[],
  requestId?: string,
): { keys: SortKey[]; joinSql: string; joinParams: unknown[] } {
  const keys: SortKey[] = [];
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  sortKeys.forEach((key, i) => {
    const dir: 'ASC' | 'DESC' = key.order === 'desc' ? 'DESC' : 'ASC';
    switch (key.key) {
      case 'title':
      case 'alpha':
        keys.push({ expr: 't.title COLLATE NOCASE', dir });
        return;
      case 'created_at':
      case 'created':
        keys.push({ expr: 't.created_at', dir });
        return;
      case 'updated_at':
      case 'updated':
        keys.push({ expr: 't.updated_at', dir });
        return;
      default:
        break;
    }
    // Ключ-свойство: адресация registry `property_id`, каноническим именем
    // свойства либо именем стороны свойства-связи — тем же резолвером, что у
    // условий (`resolveConditionPropertyRef`), иначе конструктор и исполнитель
    // разошлись бы в толковании одного ключа.
    const ref = resolveConditionPropertyRef(ndb, key.key, requestId);
    const def = ref === null ? null : lookupPropertyRow(ndb, ref.propertyId);
    if (ref === null || def === null) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Ключ сортировки «${key.key}» не найден: это не фиксированный ключ (title/created_at/updated_at) и не свойство сети.`,
        { field: 'ast.sort', key: key.key },
        requestId,
      );
    }
    if (def.value_type === 'link') {
      const edges = linkPropertyEdges(def, ref.direction);
      if (edges === null) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `Сортировка по свойству-связи «${key.key}» не поддержана: у свойства нет типа связи.`,
          { field: 'ast.sort', key: key.key },
          requestId,
        );
      }
      // Один агрегат на мысль: страница не размножается по числу связей, а
      // keyset сравнивает то же выражение `lsv<i>.val` (подзапросы — свои
      // области видимости, поэтому внутренние алиасы `l`/`t2` у каждого ключа
      // свои и не конфликтуют).
      const alias = `lsv${i}`;
      joins.push(
        `LEFT JOIN (
           SELECT l.${edges.ownerCol} AS owner_id, MIN(t2.title COLLATE NOCASE) AS val
             FROM links_v l
             JOIN thoughts_v t2 ON t2.id = l.${edges.targetCol}
            WHERE ${edges.typeSql} AND l.active = 1 AND l.marked_for_deletion = 0
            GROUP BY l.${edges.ownerCol}
         ) ${alias} ON ${alias}.owner_id = t.id`,
      );
      joinParams.push(...edges.typeParams);
      const expr = `${alias}.val`;
      // Тег отличает прямую сторону от обратной и от скалярного свойства с тем
      // же id: курсор, снятый по чужому порядку, не должен продолжать страницу.
      const tag = `link:${def.id}|${edges.direction}`;
      keys.push({ expr: `(${expr} IS NULL)`, dir: 'ASC', tag });
      keys.push({ expr, dir, tag });
      return;
    }
    const alias = `psv${i}`;
    joins.push(
      `LEFT JOIN property_values_v ${alias} ON ${alias}.owner_type = 'thought'` +
        ` AND ${alias}.owner_id = t.id AND ${alias}.property_id = ?`,
    );
    joinParams.push(def.id);
    const expr = `${alias}.${VALUE_COLUMN[def.value_type]}`;
    const tag = `property:${def.id}`;
    keys.push({ expr: `(${expr} IS NULL)`, dir: 'ASC', tag });
    keys.push({ expr, dir, tag });
  });
  return { keys, joinSql: joins.join(' '), joinParams };
}

/**
 * Ключи сортировки запроса плюс `thought_views`-джойн для `viewed`.
 *
 * `homeFirst` (пустой REST-фильтр) добавляет ведущий ключ «HOME — первой».
 * Непустой `req.ast.sort` (требование 3e47f52a) задаёт многоуровневый порядок
 * целиком и перекрывает `req.sort`/`req.order` (конфликт двух источников
 * отвергается фасадами до вызова движка). `viewed` — два ключа: флаг
 * NULL-метки (NULL последними при `asc`, как в §6.10) и сама метка. Значения
 * ключей совпадают с прежним `ORDER BY`, но теперь дополняются `t.id` в
 * {@link orderClause} — порядок детерминирован.
 */
function sortKeysFor(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  homeFirst: boolean,
): { keys: SortKey[]; joinSql: string; joinParams: unknown[] } {
  const keys: SortKey[] = [];
  if (homeFirst) keys.push({ expr: '(t.is_root = 1)', dir: 'DESC' });

  const astSort = req.ast?.sort;
  if (astSort !== undefined && astSort.length > 0) {
    const ast = astSortClause(ndb, astSort);
    return { keys: [...keys, ...ast.keys], joinSql: ast.joinSql, joinParams: ast.joinParams };
  }

  const dir: 'ASC' | 'DESC' = req.order === 'desc' ? 'DESC' : 'ASC';
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

/**
 * `true`, когда свойство указанного типа множественное (`config.multiple = true`).
 * Формат хранения множественного значения зависит от типа: `text` — одна
 * comma-joined строка (напр. `"Москва, Питер"`, 02-data-model §3.4–3.5), `url`
 * — JSON-массив строк. Поэтому `text` раскрывается собственным элементом (см.
 * {@link textListClause}), а `url` — через {@link multipleValueElementsSql}.
 */
function isMultipleProperty(def: RegistryPropertyRow, valueType: PropertyValueType): boolean {
  if (def.value_type !== valueType || def.config === null) return false;
  try {
    return (JSON.parse(def.config) as PropertyConfig).multiple === true;
  } catch {
    return false;
  }
}

/**
 * Клауза оператора со списком значений (`in`/`not_in`/`any_of`/`all_of`/
 * `none_of`) по `text`-свойству с ПОЭЛЕМЕНТНЫМ совпадением (ошибка 7489e4d9).
 *
 * Множественное `text` хранится comma-joined строкой: элемент сравнивается с
 * границами разделителя `", "` (`"a, b"` матчит `a` и `b`, но не `ab`).
 * Одиночное `text` — точное сравнение строки (элемент один; поведение
 * скалярных операций не меняется, требование 92b9c55b). Семантика операторов:
 * `in`/`any_of` — совпал хотя бы один элемент; `all_of` — совпали все
 * перечисленные; `not_in`/`none_of` — не совпал ни один.
 */
function textListClause(
  propertyId: string,
  column: string,
  multiple: boolean,
  operator: ThoughtQueryPropertyOperator,
  value: ThoughtQueryPropertyCondition['value'],
  requestId?: string,
): Clause {
  const values = coerceValueList(value, operator, requestId);
  // `text`-сравнение регистронезависимо (ADR 9779dd21): регистр сворачивается
  // `unicode_lower` с обеих сторон — `COLLATE NOCASE` кириллицу не покрывает.
  const elementSql = `EXISTS (
    SELECT 1 FROM property_values_v pv
    WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
      AND pv.${column} IS NOT NULL AND ${
        multiple
          ? `instr(', ' || unicode_lower(pv.${column}) || ', ', ', ' || unicode_lower(?) || ', ') > 0`
          : `unicode_lower(pv.${column}) = unicode_lower(?)`
      })`;
  const one = (v: string): Clause => ({ sql: elementSql, params: [propertyId, v] });
  if (operator === 'all_of') {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const v of values) {
      const clause = one(v);
      parts.push(clause.sql);
      params.push(...clause.params);
    }
    return { sql: parts.join(' AND '), params };
  }
  const any: Clause = {
    // Внешние скобки обязательны: клаузы условий объединяются через AND
    // (`where.push(clause.sql)`), а приоритет AND выше OR — без обёртки
    // `in`/`any_of` с 2+ значениями разрывает WHERE и пропускает лишние
    // мысли в комбинации с другим условием (ошибка 7489e4d9, верификация).
    sql: `(${values.map(() => `(${elementSql})`).join(' OR ')})`,
    params: values.flatMap((v) => one(v).params),
  };
  return operator === 'any_of' || operator === 'in'
    ? any
    : { sql: `NOT (${any.sql})`, params: any.params };
}

/**
 * Клауза оператора со списком значений (`in`/`not_in`) по `url`-свойству с
 * ПОЭЛЕМЕНТНЫМ совпадением для множественного значения (ошибка 55cb51f8).
 *
 * Множественное `url` (`config.multiple`) хранится JSON-массивом строк в
 * `value_text` (напр. `["https://a","https://b"]`, 02-data-model §3.4–3.5):
 * элементы раскрываются через `json_each` — тем же хелпером, что и наборные
 * операторы ({@link multipleValueSetClause}). Одиночное `url` — точное
 * сравнение хранимой строки (элемент один; поведение скалярных операций не
 * меняется, требование 00eb824b). Семантика: `in` — совпал хотя бы один
 * элемент; `not_in` — не совпал ни один.
 */
function urlListClause(
  propertyId: string,
  column: string,
  multiple: boolean,
  operator: 'in' | 'not_in',
  value: ThoughtQueryPropertyCondition['value'],
  requestId?: string,
): Clause {
  const values = coerceValueList(value, operator, requestId);
  // `url` — текстовое значение: сравнение регистронезависимо (unicode_lower).
  const placeholders = values.map(() => 'unicode_lower(?)').join(',');
  const matchSql = multiple
    ? `SELECT 1 FROM property_values_v pv, ${multipleValueElementsSql(column)} je
       WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
         AND pv.${column} IS NOT NULL AND unicode_lower(je.value) IN (${placeholders})`
    : `SELECT 1 FROM property_values_v pv
       WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
         AND unicode_lower(pv.${column}) IN (${placeholders})`;
  const match: Clause = { sql: `EXISTS (${matchSql})`, params: [propertyId, ...values] };
  return operator === 'in' ? match : { sql: `NOT (${match.sql})`, params: match.params };
}

/**
 * Клауза `any_of`/`all_of`/`none_of` по множественному свойству. `fold` —
 * регистронезависимое сравнение элементов (текстовые виды значений, ADR 9779dd21).
 */
function multipleValueSetClause(
  propertyId: string,
  column: string,
  operator: 'any_of' | 'all_of' | 'none_of',
  value: ThoughtQueryPropertyCondition['value'],
  requestId?: string,
  fold = false,
): Clause {
  const values = coerceValueList(value, operator, requestId);
  const elementsSql = multipleValueElementsSql(column);
  const elemExpr = fold ? 'unicode_lower(je.value)' : 'je.value';
  const valExpr = fold ? 'unicode_lower(?)' : '?';
  const existsOne = (v: string): Clause => ({
    sql: `EXISTS (
      SELECT 1 FROM property_values_v pv, ${elementsSql} je
      WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
        AND pv.${column} IS NOT NULL AND ${elemExpr} = ${valExpr})`,
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
  const placeholders = values.map(() => valExpr).join(',');
  const any: Clause = {
    sql: `EXISTS (
      SELECT 1 FROM property_values_v pv, ${elementsSql} je
      WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
        AND pv.${column} IS NOT NULL AND ${elemExpr} IN (${placeholders}))`,
    params: [propertyId, ...values],
  };
  return operator === 'any_of' ? any : { sql: `NOT ${any.sql}`, params: any.params };
}

// ---------------------------------------------------------------------------
// Единый исполнитель AST отбора (задача 9c156b8c)
// ---------------------------------------------------------------------------

/**
 * Единый исполнитель дерева AST (тех.проект «Ядро AST и операторы», требование
 * «Один исполнитель AST для REST, MCP и UI» 76e30d9a). Второго движка нет:
 * группы сворачиваются булево (И/ИЛИ/НЕ), а каждый лист транслируется в SQL
 * тем же набором помощников, что и плоские критерии `definition v1`
 * ({@link propertyClauses}, раскрытие типов, авторские/датовые/предикатные
 * клаузы). Поэтому одинаковый отбор даёт одинаковый результат во всех контурах.
 *
 * Семантика групп:
 *   * `and` — конъюнкция детей; пустая группа нейтральна (`1=1`);
 *   * `or` — дизъюнкция детей; пустая группа нейтральна (`0` — вклада не даёт);
 *   * `not` — отрицание ровно одного ребёнка (гарантировано валидатором формы).
 */

/** Константа-клауза «истина» (нейтральный элемент `and` и отключённых условий). */
const AST_TRUE: Clause = { sql: '1=1', params: [] };
/** Константа-клауза «ложь» (нейтральный элемент `or`). */
const AST_FALSE: Clause = { sql: '0', params: [] };

/** Операторы сравнения значения/количества с одной границей. */
const AST_COMPARE_OPS = new Set<FilterAstOperator>(['gt', 'gte', 'lt', 'lte']);
/** Операторы «между»/«не между» — две границы, включительно. */
const AST_RANGE_OPS = new Set<FilterAstOperator>(['between', 'not_between']);

/**
 * Операторы-листья, совместимые со значением-под-выборкой: наборные/ссылочные.
 * Несовместимые (предикаты количества, «Есть слова», булевы, вхождение в
 * иерархию) отвергаются {@link astSubqueryLeafClause} — значение-под-выборка
 * доступно только на релевантных левых операндах (требование c088f9e1).
 */
const AST_SUBQUERY_LEAF_OPS = new Set<FilterAstOperator>([
  'in',
  'not_in',
  'any_of',
  'all_of',
  'none_of',
  'eq',
  'ne',
]);

/**
 * Ресурсные предохранители исполнения под-выборок (требование 64c90b05, ADR
 * 58b501d8). Глубина вложенности моделью НЕ ограничена — это не семантический
 * лимит, а защита ресурса: при исчерпании — явная ошибка исполнения
 * (`VALIDATION_ERROR` с `reason`), а не молчаливое усечение. Ширина согласована
 * с бюджетом обхода иерархии T4 ({@link HIERARCHY_SUBTREE_MAX_NODES}).
 */
export const AST_SUBQUERY_MAX_NODES = HIERARCHY_SUBTREE_MAX_NODES;
/** Предохранитель глубины вложенности под-выборок (стек/SQL-выражение). */
export const AST_SUBQUERY_MAX_DEPTH = 100;

/** Ошибка «оператор/значение распознаны, но исполнение — отдельная задача ТП». */
function astUnsupported(what: string, field: string, requestId?: string): never {
  throw new EtnError(
    'VALIDATION_ERROR',
    `${what} пока не поддержано доменным исполнителем отбора.`,
    { field, unsupported: true },
    requestId,
  );
}

/** Операнды, поддерживающие значение-под-выборку (релевантные, требование c088f9e1). */
const AST_SUBQUERY_SUPPORTED = new Set<FilterAstEntity['kind']>([
  'property',
  'parents',
  'children',
  'type',
]);

/** Релевантные операнды, ждущие под-проекта сущностей (честный unsupported). */
const AST_SUBQUERY_DEFERRED = new Set<FilterAstEntity['kind']>([
  'attachments',
  'chronology',
  'targets',
  'link_type',
]);

// ---------------------------------------------------------------------------
// Значения-под-выборки: «в (выборке)»/«не в (выборке)»/«все в (выборке)»
// (задача 8914ac36; требования 485ff29e/c088f9e1/64c90b05, ADR b0cf5433/58b501d8)
// ---------------------------------------------------------------------------

/** Значение-под-выборка (`{ query, operator }`) в позиции значения листа. */
function isSubqueryValue(value: FilterAstValue | undefined): value is FilterAstSubqueryValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'query' in value;
}

/** Операторы под-выборки как значения: квантификация над набором значений операнда. */
type SubqueryQuantifier = FilterAstSubqueryValue['operator'];

/**
 * Материализовать результат под-выборки: под-дерево AST компилируется тем же
 * {@link filterAstNodeClause} (та же валидация/исполнение, рекурсивно) и
 * исполняется над `thoughts_v` с предохранителями ресурса. Токены внутри
 * под-выборки резолвит тот же `tokenContext` (собираются в общий `unresolved`).
 *
 * `mode`:
 *   * `ids` — id выбранных мыслей (свойства-ссылки, «Родители»/«Потомки»);
 *   * `types` — типы выбранных мыслей (операнд «Тип»: «под-выборка по типам»).
 *
 * Предохранители (требование 64c90b05): глубина вложенности и ширина набора
 * (на одну под-выборку и суммарно за запрос). Исчерпание — явная ошибка, не
 * молчаливое усечение (ADR 58b501d8).
 */
function astSubqueryIdSet(
  ndb: NetworkDb,
  subquery: FilterAstSubqueryValue,
  astOpts: AstExecOptions | undefined,
  path: string,
  requestId?: string,
  mode: 'ids' | 'types' = 'ids',
): string[] {
  const depth = astOpts?.subqueryDepth ?? 0;
  if (depth >= AST_SUBQUERY_MAX_DEPTH) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Глубина вложенности под-выборок превысила предохранитель ресурса (${AST_SUBQUERY_MAX_DEPTH}); упростите отбор.`,
      { field: `${path}.query`, reason: 'subquery_depth', limit: AST_SUBQUERY_MAX_DEPTH },
      requestId,
    );
  }
  const childOpts: AstExecOptions = { ...astOpts, subqueryDepth: depth + 1 };
  const clause = filterAstNodeClause(ndb, subquery.query, `${path}.query`, requestId, childOpts);
  const select =
    mode === 'types'
      ? `SELECT DISTINCT t.type_id AS v FROM thoughts_v t WHERE (${clause.sql}) AND t.type_id IS NOT NULL`
      : `SELECT t.id AS v FROM thoughts_v t WHERE ${clause.sql}`;
  const rows = ndb
    .prepare(`${select} LIMIT ?`)
    .all(...clause.params, AST_SUBQUERY_MAX_NODES + 1) as Array<{ v: string }>;
  if (astOpts?.stats !== undefined) astOpts.stats.nodes_walked += rows.length;
  if (rows.length > AST_SUBQUERY_MAX_NODES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Под-выборка вернула больше ${AST_SUBQUERY_MAX_NODES} элементов — превышен ресурсный бюджет; сузьте под-выборку.`,
      { field: `${path}.query`, reason: 'subquery_budget', limit: AST_SUBQUERY_MAX_NODES },
      requestId,
    );
  }
  const budget = astOpts?.subqueryBudget;
  if (budget !== undefined) {
    budget.ids += rows.length;
    if (budget.ids > AST_SUBQUERY_MAX_NODES) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Суммарный размер под-выборок отбора превысил ресурсный бюджет (${AST_SUBQUERY_MAX_NODES}); упростите отбор.`,
        { field: `${path}.query`, reason: 'subquery_budget', limit: AST_SUBQUERY_MAX_NODES },
        requestId,
      );
    }
  }
  return rows.map((r) => r.v);
}

/** Клауза `NOT EXISTS (SELECT 1 <fromAndWhere…>)`. */
function notExistsClause(fromAndWhere: string, params: unknown[]): Clause {
  return { sql: `NOT EXISTS (SELECT 1 ${fromAndWhere})`, params };
}

/**
 * Квантификация набора значений множественного операнда относительно набора
 * под-выборки: `in` — хотя бы одно значение входит; `not_in` — ни одно; `all_in`
 * — каждое (вакуумно истинно при отсутствии значений). `base` — фрагмент
 * `FROM … WHERE owner = t.id …`, `otherCol` — колонка значения (цели рёбер).
 */
function subqueryEdgeQuantClause(
  base: string,
  typeParams: unknown[],
  otherCol: string,
  ids: readonly string[],
  quant: SubqueryQuantifier,
): Clause {
  const membership = astIdInClause(`l.${otherCol}`, ids);
  const match: Clause = {
    sql: `EXISTS (SELECT 1 ${base} AND ${membership.sql})`,
    params: [...typeParams, ...membership.params],
  };
  if (quant === 'in') return match;
  if (quant === 'not_in') return astNegate(match);
  // all_in: ни одного значения вне набора. Пустой набор — ни одного ребра.
  if (ids.length === 0) return notExistsClause(base, [...typeParams]);
  const notIn: Clause = {
    sql: `l.${otherCol} NOT IN (${ids.map(() => '?').join(',')})`,
    params: [...ids],
  };
  return notExistsClause(`${base} AND ${notIn.sql}`, [...typeParams, ...notIn.params]);
}

/** Клауза под-выборки по свойству-ссылке (обе стороны, включая обратное имя). */
function subqueryLinkPropertyClause(
  def: RegistryPropertyRow,
  directionRef: LinkPropertyDirection | null,
  ids: readonly string[],
  quant: SubqueryQuantifier,
): Clause {
  const edges = linkPropertyEdges(def, directionRef);
  if (edges === null) return quant === 'in' ? AST_FALSE : AST_TRUE;
  const base = `FROM links_v l
      WHERE l.${edges.ownerCol} = t.id AND ${edges.typeSql}
        AND l.active = 1 AND l.marked_for_deletion = 0`;
  return subqueryEdgeQuantClause(base, edges.typeParams, edges.targetCol, ids, quant);
}

/** Клауза под-выборки по структурным «Родители»/«Потомки» (живые нетипизированные рёбра). */
function subqueryStructuralClause(
  kind: 'parents' | 'children',
  ids: readonly string[],
  quant: SubqueryQuantifier,
): Clause {
  const ownCol = kind === 'parents' ? 'target_id' : 'source_id';
  const otherCol = kind === 'parents' ? 'source_id' : 'target_id';
  const base = `FROM links_v l
      WHERE l.${ownCol} = t.id AND l.active = 1 AND l.marked_for_deletion = 0 AND l.type_id IS NULL`;
  return subqueryEdgeQuantClause(base, [], otherCol, ids, quant);
}

/** Клауза под-выборки по одиночному операнду «Тип» (тип мысли против id-набора). */
function subqueryTypeClause(ids: readonly string[], quant: SubqueryQuantifier): Clause {
  if (ids.length === 0) return quant === 'in' ? AST_FALSE : AST_TRUE;
  const placeholders = ids.map(() => '?').join(',');
  if (quant === 'in') return { sql: `t.type_id IN (${placeholders})`, params: [...ids] };
  // not_in: тип не задан либо не входит в набор (NULL не «входит»).
  return {
    sql: `(t.type_id IS NULL OR t.type_id NOT IN (${placeholders}))`,
    params: [...ids],
  };
}

/**
 * Лист со значением-под-выборкой. Сначала проверяется релевантность левого
 * операнда (требование c088f9e1): нерелевантные — явная ошибка; релевантные, но
 * ждущие под-проекта сущностей (вложения/дневник/цели/тип связи) — честный
 * `unsupported`. Затем квантификация `value.operator` (`in`/`not_in`/`all_in`);
 * `all_in` применим только к множественным операндам («Тип» — одиночный).
 */
function astSubqueryLeafClause(
  ndb: NetworkDb,
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
  astOpts?: AstExecOptions,
): Clause {
  const entity = leaf.entity;
  // 1. Релевантность левого операнда (требование c088f9e1).
  if (AST_SUBQUERY_DEFERRED.has(entity.kind)) {
    astUnsupported(`Исполнение под-выборки на операнде «${entity.kind}»`, `${path}.value`, requestId);
  }
  if (!AST_SUBQUERY_SUPPORTED.has(entity.kind)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Значение-под-выборка недоступно на операнде «${entity.kind}».`,
      { field: `${path}.value`, operand: entity.kind, relevant: false },
      requestId,
    );
  }
  // 2. Совместимость оператора-листа (наборные/ссылочные, не предикаты).
  if (!AST_SUBQUERY_LEAF_OPS.has(leaf.operator)) {
    astUnsupported(`Оператор «${leaf.operator}» со значением-под-выборкой`, `${path}.operator`, requestId);
  }
  const subquery = leaf.value as FilterAstSubqueryValue;
  const quant = subquery.operator;

  switch (entity.kind) {
    case 'property': {
      const propertyRef = entity.property_id ?? entity.property;
      const ref = propertyRef === undefined ? null : resolveConditionPropertyRef(ndb, propertyRef, requestId);
      if (ref === null) return NO_MATCH_CLAUSE;
      const def = lookupPropertyRow(ndb, ref.propertyId);
      if (def === null) return NO_MATCH_CLAUSE;
      if (def.value_type !== 'link') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `Значение-под-выборка доступно только на ссылочных операндах; свойство типа ${def.value_type} — не ссылка.`,
          { field: `${path}.value`, operand: 'property', value_type: def.value_type },
          requestId,
        );
      }
      const ids = astSubqueryIdSet(ndb, subquery, astOpts, path, requestId);
      const directionRef = entity.direction ?? ref.direction;
      return subqueryLinkPropertyClause(def, directionRef, ids, quant);
    }
    case 'parents':
    case 'children': {
      const ids = astSubqueryIdSet(ndb, subquery, astOpts, path, requestId);
      return subqueryStructuralClause(entity.kind, ids, quant);
    }
    case 'type': {
      if (quant === 'all_in') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'Оператор «все в (выборке)» применим только к множественным операндам; «Тип» — одиночный.',
          { field: `${path}.value.operator`, operand: 'type' },
          requestId,
        );
      }
      // «Тип» — одиночный операнд: под-выборка по типам (типы выбранных мыслей).
      const typeIds = astSubqueryIdSet(ndb, subquery, astOpts, path, requestId, 'types');
      return subqueryTypeClause(typeIds, quant);
    }
    default:
      throw new EtnError(
        'VALIDATION_ERROR',
        'Неизвестный операнд значения-под-выборки.',
        { field: `${path}.entity` },
        requestId,
      );
  }
}

// ---------------------------------------------------------------------------
// Операторы «в иерархии»/«не в иерархии» (задача e62aa4db)
// ---------------------------------------------------------------------------

/** Режим обхода листа «в иерархии»: явный `mode` либо структурный по умолчанию. */
function astHierarchyMode(leaf: FilterAstLeaf): FilterAstHierarchyMode {
  return leaf.mode ?? 'structural';
}

/**
 * Поддерево «в иерархии» от корней `roots` в заданном режиме, с кэшем в
 * пределах одного исполнения запроса (ADR 588be3f3, п. 4). Превышение
 * ресурсного бюджета — явная ошибка исполнения: молча усекать отбор запрещено
 * (ADR 58b501d8 «неограниченная глубина вложенности»).
 */
function astHierarchySubtree(
  ndb: NetworkDb,
  mode: FilterAstHierarchyMode,
  roots: string[],
  astOpts: AstExecOptions | undefined,
  path: string,
  requestId?: string,
): string[] {
  const cache = astOpts?.hierarchyCache;
  const key = `${mode}|${roots.join('\u0000')}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  if (astOpts?.stats !== undefined) astOpts.stats.hierarchy_calls += 1;
  const res = collectHierarchySubtree(ndb, roots, mode, {
    maxDepth: TRAVERSAL_DEFAULTS.MAX_DEPTH,
    maxNodes: HIERARCHY_SUBTREE_MAX_NODES,
    timeoutMs: TRAVERSAL_DEFAULTS.QUERY_TIMEOUT_MS,
  });
  if (astOpts?.stats !== undefined) astOpts.stats.nodes_walked += res.ids.length;
  if (res.truncated) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Обход «в иерархии» прерван: превышен ресурсный бюджет ' +
        (res.reason === 'timeout' ? '(время)' : '(число узлов)') +
        '; сузьте набор корней или глубину отбора.',
      {
        field: path,
        reason: 'hierarchy_budget',
        limit: res.reason === 'timeout' ? TRAVERSAL_DEFAULTS.QUERY_TIMEOUT_MS : HIERARCHY_SUBTREE_MAX_NODES,
      },
      requestId,
    );
  }
  if (cache !== undefined) cache.set(key, res.ids);
  return res.ids;
}

/** Клауза вхождения в список id (`IN`); пустой список — «нет совпадений». */
function astIdInClause(columnExpr: string, ids: readonly string[]): Clause {
  if (ids.length === 0) return AST_FALSE;
  return { sql: `${columnExpr} IN (${ids.map(() => '?').join(',')})`, params: [...ids] };
}

/**
 * Лист «в иерархии» по структурным «Родители»/«Потомки»: значение операнда
 * (родитель/потомок мысли) входит в поддерево указанных корней (требование
 * aa7a2aea). Режим обхода — `leaf.mode`: `structural` — только живые
 * нетипизированные рёбра, `all_links` — любая живая связь считается
 * родительской (ADR df23db45).
 */
function hierarchyStructuralLeafClause(
  ndb: NetworkDb,
  kind: 'parents' | 'children',
  leaf: FilterAstLeaf,
  astOpts: AstExecOptions | undefined,
  path: string,
  requestId?: string,
): Clause {
  const roots = astStringList(leaf.value, leaf.operator, path, requestId);
  if (roots.length === 0) return leaf.operator === 'in_hierarchy' ? AST_FALSE : AST_TRUE;
  const mode = astHierarchyMode(leaf);
  const subtree = astHierarchySubtree(ndb, mode, roots, astOpts, path, requestId);
  const ownCol = kind === 'parents' ? 'target_id' : 'source_id';
  const otherCol = kind === 'parents' ? 'source_id' : 'target_id';
  const edge =
    mode === 'structural'
      ? 'l.active = 1 AND l.marked_for_deletion = 0 AND l.type_id IS NULL'
      : 'l.active = 1 AND l.marked_for_deletion = 0';
  const membership = astIdInClause(`l.${otherCol}`, subtree);
  const match: Clause = {
    sql: `EXISTS (SELECT 1 FROM links_v l WHERE l.${ownCol} = t.id AND ${edge} AND ${membership.sql})`,
    params: membership.params,
  };
  return leaf.operator === 'in_hierarchy' ? match : astNegate(match);
}

/**
 * Лист «в иерархии» по операнду «Тип»: тип мысли входит в поддерево указанных
 * типов-корней (сам тип и его подтипы, ADR 9a356460); режим связей неприменим.
 */
function hierarchyTypeLeafClause(
  ndb: NetworkDb,
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
): Clause {
  const roots = astStringList(leaf.value, leaf.operator, path, requestId);
  const expanded = roots.length === 0 ? [] : expandTypeIdsToSubtree(ndb, 'thought_types', roots);
  const match = astIdInClause('t.type_id', expanded);
  return leaf.operator === 'in_hierarchy' ? match : astNegate(match);
}

/**
 * Контекст разрешения токенов AST-листа (требование 1b77decd / ADR 0c02ab4f).
 * `nowMs` — часы в миллисекундах (сериализуемо: тот же объект уходит в
 * читающий пул, функция-часы через границу воркера не проходит). `userId` —
 * владелец ключа для `$user`. `firstDayOfWeek` — настройка сети «первый день
 * недели» (ISO 1=пн … 7=вс) для `$weekStart`/`$weekEnd`. `withTime` — профиль
 * со временем (разрешает `$now`/`$hourStart`/`$hourEnd` и `h`/`mi`).
 */
export interface AstTokenContext {
  nowMs?: number;
  userId?: string;
  firstDayOfWeek?: number;
  withTime?: boolean;
}

/** Собрать опции резолвера из {@link AstTokenContext}. */
function astResolveOptions(ctx: AstTokenContext | undefined): {
  now?: () => Date;
  userId?: string;
  firstDayOfWeek?: number;
  withTime?: boolean;
} {
  const out: { now?: () => Date; userId?: string; firstDayOfWeek?: number; withTime?: boolean } = {};
  if (ctx?.nowMs !== undefined) out.now = () => new Date(ctx.nowMs!);
  if (ctx?.userId !== undefined) out.userId = ctx.userId;
  if (ctx?.firstDayOfWeek !== undefined) out.firstDayOfWeek = ctx.firstDayOfWeek;
  if (ctx?.withTime !== undefined) out.withTime = ctx.withTime;
  return out;
}

/**
 * Разрешить одно значение-токен (`{ token: "$today+7d" }`) в скаляр. Возврат
 * `{ ok: false }` — токен неразрешим (`unresolved` уже собран в `sink`).
 */
function astResolveToken(
  token: string,
  ctx: AstTokenContext | undefined,
  sink: TokenIssue[] | undefined,
  path: string,
): { ok: boolean; value?: FilterAstScalar } {
  const res = resolveGlobalDateTokens(token, astResolveOptions(ctx));
  if (res.unresolved.length > 0) {
    if (sink !== undefined) {
      for (const issue of res.unresolved) sink.push({ ...issue, path });
    }
    return { ok: false };
  }
  return { ok: true, value: res.value };
}

/**
 * Разрешить токены в значении листа. Скаляр/список литералов — как есть;
 * одиночный токен и токены-элементы СПИСКА (границы «между») — раскрываются.
 * Возврат `{ ok: false }` — хоть один токен неразрешим (`unresolved` собран в
 * `sink`), лист даёт `false`. Требование 84b52caa (каждая граница — токен).
 */
function astResolveLeafValue(
  value: FilterAstValue | undefined,
  ctx: AstTokenContext | undefined,
  sink: TokenIssue[] | undefined,
  path: string,
): { ok: boolean; value?: FilterAstValue } {
  if (Array.isArray(value)) {
    const out: FilterAstListItem[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const el = value[i]!;
      if (typeof el === 'object' && el !== null && 'token' in el) {
        const r = astResolveToken(el.token, ctx, sink, `${path}.value[${i}]`);
        if (!r.ok) return { ok: false };
        out.push(r.value!);
      } else {
        out.push(el);
      }
    }
    return { ok: true, value: out };
  }
  if (typeof value === 'object' && value !== null && 'token' in value) {
    const r = astResolveToken(value.token, ctx, sink, `${path}.value`);
    if (!r.ok) return { ok: false };
    return { ok: true, value: r.value };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Операторы AST: предикаты количества, сравнения, «имеет свойство» (aee021c8)
// ---------------------------------------------------------------------------

/** Отрицание клаузы (общий помощник «не»-операторов и предикатов). */
function astNegate(clause: Clause): Clause {
  return { sql: `NOT (${clause.sql})`, params: clause.params };
}

/**
 * Числовая граница предиката «количество» — число либо числовая строка
 * (поля-счётчики приходят числами; строковая форма допускается как щадящая).
 */
function astCountNumber(value: FilterAstValue | undefined, path: string, requestId?: string): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Оператор «количество» требует числового значения.',
      { field: path },
      requestId,
    );
  }
  return n;
}

/** Две числовые границы «между» (включительно). */
function astCountRange(value: FilterAstValue | undefined, path: string, requestId?: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Оператор «между» требует ровно две границы.',
      { field: path },
      requestId,
    );
  }
  return [astCountNumber(value[0], path, requestId), astCountNumber(value[1], path, requestId)];
}

/**
 * Предикат «количество»: сравнение числа значений операнда (скалярный
 * подзапрос `countSql`, параметры — `countParams`) с числовой границей
 * {@link FilterAstLeaf.value}. Числовые операторы ядра (равно/не равно,
 * больше/меньше/…, «между»); `is_empty`/`not_empty` выражают «количество = 0» /
 * «количество > 0». Ноль допустим.
 */
function countLeafClause(
  countSql: string,
  countParams: unknown[],
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
): Clause {
  const expr = `(${countSql})`;
  const op = leaf.operator;
  if (op === 'between' || op === 'not_between') {
    const [lo, hi] = astCountRange(leaf.value, `${path}.value`, requestId);
    const low: Clause = { sql: `${expr} >= ?`, params: [...countParams, lo] };
    const high: Clause = { sql: `${expr} <= ?`, params: [...countParams, hi] };
    const between: Clause = { sql: `(${low.sql} AND ${high.sql})`, params: [...low.params, ...high.params] };
    return op === 'between' ? between : astNegate(between);
  }
  if (op === 'is_empty' || op === 'not_empty') {
    return op === 'is_empty'
      ? { sql: `${expr} = 0`, params: [...countParams] }
      : { sql: `${expr} > 0`, params: [...countParams] };
  }
  const cmp =
    op === 'eq' ? '=' :
    op === 'ne' ? '<>' :
    op === 'gt' ? '>' :
    op === 'gte' ? '>=' :
    op === 'lt' ? '<' :
    op === 'lte' ? '<=' :
    null;
  if (cmp === null) astUnsupported(`Оператор «${op}» для количества`, path, requestId);
  const n = astCountNumber(leaf.value, `${path}.value`, requestId);
  return { sql: `${expr} ${cmp} ?`, params: [...countParams, n] };
}

/**
 * Скалярный подзапрос `COUNT(*)` по коллекции мысли. Структурные
 * «Родители»/«Потомки» считают только живые нетипизированные рёбра — ровно как
 * {@link structuralLeafClause} (типизированные рёбра — режим «все типы связей»,
 * отдельная задача e62aa4db).
 */
function collectionCountSql(kind: 'parents' | 'children' | 'attachments' | 'chronology'): string {
  switch (kind) {
    case 'parents':
      return `SELECT COUNT(*) FROM links_v l WHERE l.target_id = t.id AND l.active = 1 AND l.marked_for_deletion = 0 AND l.type_id IS NULL`;
    case 'children':
      return `SELECT COUNT(*) FROM links_v l WHERE l.source_id = t.id AND l.active = 1 AND l.marked_for_deletion = 0 AND l.type_id IS NULL`;
    case 'attachments':
      return `SELECT COUNT(*) FROM attachments_v a WHERE a.owner_type = 'thought' AND a.owner_id = t.id`;
    case 'chronology':
      return `SELECT COUNT(*) FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = t.id AND c.kind = 'chronological'`;
  }
}

/**
 * Лист коллекции: bool-предикаты наличия (`да/нет/не важно`,
 * `заполнено/не заполнено`) либо предикат количества, когда оператор числовой
 * или значение — число (требование bd0348b3, «количество»).
 */
function collectionLeafClause(
  kind: 'parents' | 'children' | 'attachments' | 'chronology',
  existsSql: string,
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
): Clause {
  const op = leaf.operator;
  const isCount =
    AST_RANGE_OPS.has(op) ||
    AST_COMPARE_OPS.has(op) ||
    (typeof leaf.value === 'number' && (op === 'eq' || op === 'ne'));
  if (isCount) return countLeafClause(collectionCountSql(kind), [], leaf, path, requestId);
  return boolPresenceClause(existsSql, leaf, path, requestId);
}

/**
 * Сравнение скалярного значения свойства (числа, даты, строки — лексикографически)
 * и «между» (обе границы включительны): EXISTS по колонке значения. Требование
 * 25324388.
 */
function scalarCompareClause(
  def: RegistryPropertyRow,
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
): Clause {
  const column = VALUE_COLUMN[def.value_type];
  // Текст — регистронезависимо, включая строковые «больше/меньше» (ADR 9779dd21).
  const fold = foldsCase(def);
  const lhs = fold ? `unicode_lower(pv.${column})` : `pv.${column}`;
  const rhs = fold ? 'unicode_lower(?)' : '?';
  const one = (op: 'gte' | 'lte' | 'gt' | 'lt' | 'eq', value: FilterAstScalar): Clause => {
    const cmp = op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : op === 'lte' ? '<=' : '=';
    return {
      sql: `EXISTS (
        SELECT 1 FROM property_values_v pv
        WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
          AND ${lhs} ${cmp} ${rhs})`,
      params: [def.id, sqlScalar(def, value, requestId)],
    };
  };
  const op = leaf.operator;
  if (op === 'between' || op === 'not_between') {
    if (!Array.isArray(leaf.value) || leaf.value.length !== 2) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'Оператор «между» требует ровно две границы.',
        { field: `${path}.value` },
        requestId,
      );
    }
    const low = one('gte', leaf.value[0] as FilterAstScalar);
    const high = one('lte', leaf.value[1] as FilterAstScalar);
    const between: Clause = { sql: `(${low.sql} AND ${high.sql})`, params: [...low.params, ...high.params] };
    return op === 'between' ? between : astNegate(between);
  }
  return one(op as 'gt' | 'gte' | 'lt' | 'lte', leaf.value as FilterAstScalar);
}

/**
 * Предикат «количество» по свойству-связи — число живых рёбер заданной стороны
 * (обе стороны свойства, требование bd0348b3). Направление — переопределение
 * операнда, затем имя стороны, затем `config` (единая точка —
 * {@link linkPropertyDirection}).
 */
function linkPropertyCountClause(
  def: RegistryPropertyRow,
  directionRef: LinkPropertyDirection | null,
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
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
  if (!structural && linkTypeId === null) return AST_FALSE;
  const direction = directionRef ?? linkPropertyDirection(config);
  const ownerCol = direction === 'out' ? 'source_id' : 'target_id';
  const typeSql = linkTypeId === null ? 'l.type_id IS NULL' : 'l.type_id = ?';
  const typeParams = linkTypeId === null ? [] : [linkTypeId];
  const countSql = `SELECT COUNT(*) FROM links_v l WHERE l.${ownerCol} = t.id AND ${typeSql}
    AND l.active = 1 AND l.marked_for_deletion = 0`;
  return countLeafClause(countSql, [...typeParams], leaf, path, requestId);
}

/**
 * Предикат «количество» по множественному скалярному свойству: число элементов
 * значения (JSON-массив `["a","b"]` — `json_array_length`; comma-joined
 * `"a, b"` — по разделителю `", "`). Требование bd0348b3.
 */
function multiplePropertyCountClause(
  def: RegistryPropertyRow,
  column: string,
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
): Clause {
  // COALESCE → 0: отсутствие значения = пустой набор (требование bd0348b3),
  // иначе скалярный подзапрос без строк давал NULL, и «количество = 0» /
  // «не заполнено» не срабатывали для мысли без значения.
  const countSql = `SELECT COALESCE((
      SELECT CASE
        WHEN pv.${column} IS NULL OR pv.${column} = '' THEN 0
        WHEN pv.${column} LIKE '[%' THEN json_array_length(pv.${column})
        ELSE (length(pv.${column}) - length(replace(pv.${column}, ', ', ''))) / 2 + 1
      END
      FROM property_values_v pv
      WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
    ), 0)`;
  return countLeafClause(countSql, [def.id], leaf, path, requestId);
}

/**
 * Множество типов мыслей, в эффективном наборе свойств которых (по цепочке типа
 * с наследованием, включая зеркала) есть хотя бы одно из `propertyIds`.
 * Требование bd0348b3 («имеет свойство» для операнда «Тип»).
 */
function typeIdsWithEffectiveProperty(ndb: NetworkDb, propertyIds: readonly string[]): string[] {
  const wanted = new Set(propertyIds);
  const out: string[] = [];
  for (const node of listTypeNodes(ndb, 'thought_types')) {
    const effective = listEffectiveTypeProperties(ndb, 'thought_type', node.id);
    if (effective.some((d) => wanted.has(d.property_id))) out.push(node.id);
  }
  return out;
}

/** Минимальная строка реестра свойства (id + природа) для листа AST. */
function lookupPropertyRow(ndb: NetworkDb, propertyId: string): RegistryPropertyRow | null {
  const raw = ndb
    .prepare('SELECT id, value_type, config FROM properties_v WHERE id = ?')
    .get(propertyId) as { id: string; value_type: string; config: string | null } | undefined;
  if (raw === undefined) return null;
  return { id: raw.id, value_type: raw.value_type as PropertyValueType, config: raw.config };
}

/**
 * Опции исполнения AST, задаваемые ВСТРАИВАЮЩИМ вызовом (не критерий выборки).
 * Живут отдельно от {@link AstExecOptions}, чтобы передаваться в
 * {@link buildThoughtIdSelect} от чужого исполнителя (хроника).
 */
export interface AstExecContextOptions {
  /**
   * Область `comment` листа «Есть слова» ищет и комментарии инцидентных связей
   * мысли с обеих сторон — семантика ФАЗЫ 1 отбора хроники (требование
   * ce111b0d «Двухфазный отбор хроники…»; ошибка fc97548d — паритет AST-листа с
   * плоским `keyword_scope`). Ставит исполнитель хроники; отбор мыслей
   * (`POST /thoughts/query`, требование b363cad1) опцию не ставит.
   */
  keywordCommentIncludesLinkComments?: boolean;
}

/** Опции исполнения AST-листьев: контекст токенов и коллектор неразрешимых. */
interface AstExecOptions extends AstExecContextOptions {
  ctx?: AstTokenContext;
  unresolved?: TokenIssue[];
  /**
   * Кэш поддерева «в иерархии» в пределах одного исполнения запроса
   * (ключ — режим + список корней). Поддерево не зависит от мысли-кандидата и
   * считается один раз на условие (ADR 588be3f3, п. 4).
   */
  hierarchyCache?: Map<string, string[]>;
  /** Текущая глубина вложенности под-выборок (ресурсный предохранитель, 64c90b05). */
  subqueryDepth?: number;
  /** Общий на запрос счётчик материализованных id под-выборок (бюджет ширины). */
  subqueryBudget?: { ids: number };
  /**
   * Мутируемые счётчики статистики исполнения (требование 0f34a5ff). Присутствует
   * ТОЛЬКО когда фасад запросил `collectStats` — тогда счётчики доступны во всех
   * ветках обхода; иначе `undefined`, и инкременты пропускаются (нет накладных
   * расходов при выключенном логировании).
   */
  stats?: {
    conditions: number;
    nodes_walked: number;
    hierarchy_calls: number;
    limits_hit: Set<string>;
  };
}

/** Свернуть дерево AST в один SQL-предикат над `thoughts_v t`. */
export function filterAstClause(
  ndb: NetworkDb,
  ast: FilterAst,
  requestId?: string,
  astOpts?: AstExecOptions,
): Clause {
  return filterAstNodeClause(ndb, ast.filter, 'filter', requestId, astOpts);
}

function filterAstNodeClause(
  ndb: NetworkDb,
  node: FilterAstNode,
  path: string,
  requestId?: string,
  astOpts?: AstExecOptions,
): Clause {
  if ('op' in node) {
    if (node.op === 'not') {
      const child = filterAstNodeClause(ndb, node.children[0]!, `${path}.children[0]`, requestId, astOpts);
      return { sql: `NOT (${child.sql})`, params: child.params };
    }
    if (node.children.length === 0) return node.op === 'and' ? AST_TRUE : AST_FALSE;
    const parts = node.children.map((child, i) =>
      filterAstNodeClause(ndb, child, `${path}.children[${i}]`, requestId, astOpts),
    );
    const sql = parts.map((p) => `(${p.sql})`).join(node.op === 'and' ? ' AND ' : ' OR ');
    return { sql: `(${sql})`, params: parts.flatMap((p) => p.params) };
  }
  return filterAstLeafClause(ndb, node, path, requestId, astOpts);
}

function filterAstLeafClause(
  ndb: NetworkDb,
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
  astOpts?: AstExecOptions,
): Clause {
  // Условие попало в план обхода — считаем его (только при сборе статистики).
  if (astOpts?.stats !== undefined) astOpts.stats.conditions += 1;
  // Токен-значение раскрывается сервером; неразрешимый — лист даёт false и
  // уходит в коллектор (требование b7fdab20 «пустой результат с пояснением»).
  const resolved = astResolveLeafValue(leaf.value, astOpts?.ctx, astOpts?.unresolved, path);
  if (!resolved.ok) return AST_FALSE;
  if (resolved.value !== leaf.value) leaf = { ...leaf, value: resolved.value };
  // «Между» с обеими совпавшими границами (одиночный скаляр, в т.ч. раскрытый
  // токен) — эквивалент равенства (сценарий cbc22d19, шаг 3, границы включительны).
  if (
    (leaf.operator === 'between' || leaf.operator === 'not_between') &&
    (typeof leaf.value === 'string' || typeof leaf.value === 'number')
  ) {
    leaf = { ...leaf, value: [leaf.value, leaf.value] };
  }
  if (isSubqueryValue(leaf.value)) {
    return astSubqueryLeafClause(ndb, leaf, path, requestId, astOpts);
  }
  const { entity, operator } = leaf;
  const opPath = `${path}.operator`;

  switch (entity.kind) {
    case 'id': {
      // Тождественность мысли: явный список id (операторы eq/ne/in/not_in).
      const ids = astStringList(leaf.value, operator, `${path}.value`, requestId);
      if (operator !== 'in' && operator !== 'not_in' && operator !== 'eq' && operator !== 'ne') {
        astUnsupported(`Оператор «${operator}» для операнда «Тождественность»`, opPath, requestId);
      }
      const list = operator === 'eq' || operator === 'ne' ? (ids.length > 0 ? [ids[0]!] : []) : ids;
      if (list.length === 0) return operator === 'in' || operator === 'eq' ? AST_FALSE : AST_TRUE;
      const match: Clause = {
        sql: `t.id IN (${list.map(() => '?').join(',')})`,
        params: [...list],
      };
      return operator === 'in' || operator === 'eq' ? match : astNegate(match);
    }

    case 'property':
      return propertyLeafClause(ndb, leaf, `${path}.entity`, requestId, astOpts);

    case 'type': {
      // «В иерархии» по типу: тип и его подтипы (ADR 9a356460).
      if (operator === 'in_hierarchy' || operator === 'not_in_hierarchy') {
        return hierarchyTypeLeafClause(ndb, leaf, `${path}.value`, requestId);
      }
      // «Имеет свойство»/«не имеет» для операнда «Тип» (требование bd0348b3):
      // эффективный набор свойств самого типа с наследованием.
      if (operator === 'has' || operator === 'not_has') {
        const propIds = astStringList(leaf.value, operator, `${path}.value`, requestId);
        if (propIds.length === 0) return operator === 'has' ? AST_FALSE : AST_TRUE;
        const typeIds = typeIdsWithEffectiveProperty(ndb, propIds);
        if (typeIds.length === 0) return operator === 'has' ? AST_FALSE : AST_TRUE;
        const match: Clause = {
          sql: `t.type_id IN (${typeIds.map(() => '?').join(',')})`,
          params: typeIds,
        };
        return operator === 'has' ? match : astNegate(match);
      }
      const ids = astStringList(leaf.value, operator, `${path}.value`, requestId);
      if (operator !== 'in' && operator !== 'not_in' && operator !== 'eq' && operator !== 'ne') {
        astUnsupported(`Оператор «${operator}» для операнда «Тип»`, opPath, requestId);
      }
      const list = operator === 'eq' || operator === 'ne' ? (ids.length > 0 ? [ids[0]!] : []) : ids;
      const expanded = list.length === 0 ? [] : expandTypeIdsToSubtree(ndb, 'thought_types', list);
      if (expanded.length === 0) return operator === 'in' || operator === 'eq' ? AST_FALSE : AST_TRUE;
      const match: Clause = {
        sql: `t.type_id IN (${expanded.map(() => '?').join(',')})`,
        params: [...expanded],
      };
      return operator === 'in' || operator === 'eq' ? match : { sql: `NOT (${match.sql})`, params: match.params };
    }

    case 'link_type': {
      // Единый операнд «Тип связи» (задача f7da04d6, требование 8c131cff) в
      // контексте МЫСЛИ: «у мысли есть инцидентная связь указанного типа».
      // `in`/`in_hierarchy` (и `eq`) раскрывают тип вместе с потомками
      // `link_types` (L21) — общий AST-лист фильтра типов связей; `is_empty`/
      // `not_empty` — «нет/есть ТИПИЗИРОВАННЫХ инцидентных связей» (семантика
      // подтверждена оркестратором для контекста мысли, задача f7da04d6).
      const ids = astStringList(leaf.value, operator, `${path}.value`, requestId);
      if (operator === 'is_empty' || operator === 'not_empty') {
        const typed: Clause = {
          sql: `EXISTS (SELECT 1 FROM links_v l WHERE l.active = 1
            AND l.type_id IS NOT NULL
            AND (l.source_id = t.id OR l.target_id = t.id))`,
          params: [],
        };
        return operator === 'not_empty' ? typed : { sql: `NOT (${typed.sql})`, params: [] };
      }
      if (
        operator !== 'in' &&
        operator !== 'not_in' &&
        operator !== 'eq' &&
        operator !== 'ne' &&
        operator !== 'in_hierarchy' &&
        operator !== 'not_in_hierarchy'
      ) {
        astUnsupported(`Оператор «${operator}» для операнда «Тип связи»`, opPath, requestId);
      }
      const list =
        operator === 'eq' || operator === 'ne' ? (ids.length > 0 ? [ids[0]!] : []) : ids;
      const expanded = list.length === 0 ? [] : expandTypeIdsToSubtree(ndb, 'link_types', list);
      const positive = operator === 'in' || operator === 'eq' || operator === 'in_hierarchy';
      if (expanded.length === 0) return positive ? AST_FALSE : AST_TRUE;
      const match: Clause = {
        sql: `EXISTS (SELECT 1 FROM links_v l WHERE l.active = 1
          AND l.type_id IN (${expanded.map(() => '?').join(',')})
          AND (l.source_id = t.id OR l.target_id = t.id))`,
        params: [...expanded],
      };
      return positive ? match : { sql: `NOT (${match.sql})`, params: match.params };
    }

    case 'parents':
    case 'children':
      // «В иерархии» по структурным «Родители»/«Потомки» — обход от корней,
      // режим structural/all_links (задача e62aa4db).
      if (operator === 'in_hierarchy' || operator === 'not_in_hierarchy') {
        return hierarchyStructuralLeafClause(ndb, entity.kind, leaf, astOpts, `${path}.value`, requestId);
      }
      return structuralLeafClause(entity.kind, leaf, `${path}.value`, requestId);

    case 'attachments':
      return collectionLeafClause(
        'attachments',
        'EXISTS (SELECT 1 FROM attachments_v a WHERE a.owner_type = \'thought\' AND a.owner_id = t.id)',
        leaf,
        path,
        requestId,
      );

    case 'chronology':
      return collectionLeafClause(
        'chronology',
        "EXISTS (SELECT 1 FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = t.id AND c.kind = 'chronological')",
        leaf,
        path,
        requestId,
      );

    case 'comment':
      return boolPresenceClause(
        "EXISTS (SELECT 1 FROM comments_v c WHERE c.owner_type = 'thought' AND c.owner_id = t.id AND c.kind = 'permanent')",
        leaf,
        path,
        requestId,
      );

    case 'active':
      return boolColumnClause('t.active', leaf, path, requestId);

    case 'trashed':
      return boolColumnClause('t.marked_for_deletion', leaf, path, requestId);

    case 'keywords':
      return keywordsLeafClause(entity, leaf, path, requestId, astOpts);

    case 'author':
      return authorLeafClause('t.created_by', leaf, path, requestId);

    case 'editor':
      return authorLeafClause('t.updated_by', leaf, path, requestId);

    case 'created_at':
      return dateLeafClause('t.created_at', leaf, path, requestId);

    case 'updated_at':
      return dateLeafClause('t.updated_at', leaf, path, requestId);

    case 'properties':
      return hasPropertiesLeafClause(ndb, leaf, path, requestId);

    case 'targets':
      astUnsupported('Операнд «Цели» (отбор хроники)', `${path}.entity`, requestId);
  }
  // Недостижимо: все виды операндов обработаны выше.
  throw new EtnError('VALIDATION_ERROR', 'Неизвестный операнд условия отбора.', { field: `${path}.entity` }, requestId);
}

/** Значение-лист как непустой список строк (ид/имена) для наборных операторов. */
function astStringList(
  value: FilterAstValue | undefined,
  operator: string,
  path: string,
  requestId?: string,
): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (raw.some((v) => typeof v !== 'string')) {
    throw new EtnError('VALIDATION_ERROR', `Значение оператора «${operator}» должно быть строкой или списком строк.`, {
      field: path,
    }, requestId);
  }
  return [...new Set(raw as string[])];
}

/**
 * Лист по свойству. Семантика — по природе левого операнда (требования
 * 1e19504b/7f0e3f8c/f14e48ab/25324388/bd0348b3):
 *
 *   * сравнения (`gt/gte/lt/lte`, `between/not_between`) — по значению скаляра
 *     (число/дата/строка лексикографически) либо, для свойства-связи и
 *     множественного свойства, — по количеству значений («количество»);
 *   * `eq`/`ne` числом на коллекции/связи — тоже количество;
 *   * `is_empty`/`not_empty` множественного свойства — «количество = 0 / > 0»
 *     (пустой набор — не заполнено);
 *   * остальные (`eq/ne/contains/not_contains/in/not_in/any_of/all_of/none_of`)
 *     транслируются в {@link propertyClauses} — единый словарь движка.
 *
 * Неадресуемое/удалённое свойство даёт клаузу «нет совпадений»
 * ({@link NO_MATCH_CLAUSE}), а не расширение отбора (ошибки 090d0242/4f17cb73).
 */
function propertyLeafClause(
  ndb: NetworkDb,
  leaf: FilterAstLeaf,
  entityPath: string,
  requestId?: string,
  astOpts?: AstExecOptions,
): Clause {
  const { entity, operator } = leaf;
  if (entity.kind !== 'property') throw new Error('propertyLeafClause вызван не для свойства');
  const propertyRef = entity.property_id ?? entity.property;
  if (propertyRef === undefined) {
    throw new EtnError('VALIDATION_ERROR', 'Операнд «свойство» не адресует свойство.', { field: entityPath }, requestId);
  }
  const ref = resolveConditionPropertyRef(ndb, propertyRef, requestId);
  if (ref === null) return NO_MATCH_CLAUSE;
  const def = lookupPropertyRow(ndb, ref.propertyId);
  if (def === null) return NO_MATCH_CLAUSE;
  const directionRef = entity.direction ?? ref.direction;
  // Делегат передаёт ИСХОДНУЮ ссылку (id или имя): разрешение имени и сторону
  // свойства-связи по обратному имени выполняет {@link propertyClauses} — как в
  // T1, без потери направления (задача df992826).
  const delegate = (): Clause =>
    propertyClauses(
      ndb,
      [{ property_id: propertyRef, operator: operator as ThoughtQueryPropertyOperator, value: leaf.value as ThoughtQueryPropertyCondition['value'] }],
      requestId,
    )[0] ?? AST_FALSE;

  // «В иерархии» по свойству-ссылке: хотя бы одно значение (цель рёбер)
  // входит в поддерево корней (требование aa7a2aea, задача e62aa4db).
  if (operator === 'in_hierarchy' || operator === 'not_in_hierarchy') {
    if (def.value_type !== 'link') {
      astUnsupported(`Оператор «${operator}» для свойства типа ${def.value_type}`, entityPath, requestId);
    }
    return hierarchyLinkPropertyClause(ndb, def, directionRef, leaf, astOpts, entityPath, requestId);
  }

  const numericValue = typeof leaf.value === 'number';
  const countShaped = AST_RANGE_OPS.has(operator) || AST_COMPARE_OPS.has(operator) || (numericValue && (operator === 'eq' || operator === 'ne'));

  // Свойство-связь: числовые операторы — количество живых рёбер стороны;
  // остальные — напрямую через {@link linkPropertyClause}, чтобы учесть явный
  // `entity.direction` (делегат `propertyClauses` сторону-переопределение не
  // принимает — задача aee021c8, итерация 2).
  if (def.value_type === 'link') {
    if (countShaped) return linkPropertyCountClause(def, directionRef, leaf, entityPath, requestId);
    return linkPropertyClause(
      def,
      { property_id: def.id, operator: operator as ThoughtQueryPropertyOperator, value: leaf.value as ThoughtQueryPropertyCondition['value'] },
      requestId,
      directionRef,
    );
  }

  // Множественное скалярное свойство: количество значений (+ пустой набор).
  if (isMultipleProperty(def, def.value_type)) {
    if (countShaped || operator === 'is_empty' || operator === 'not_empty') {
      return multiplePropertyCountClause(def, VALUE_COLUMN[def.value_type], leaf, entityPath, requestId);
    }
    return delegate();
  }

  // Скалярные сравнения и «между» (числа, даты, строки лексикографически).
  if (AST_RANGE_OPS.has(operator) || AST_COMPARE_OPS.has(operator)) {
    if (
      def.value_type === 'text' ||
      def.value_type === 'url' ||
      def.value_type === 'date' ||
      def.value_type === 'number'
    ) {
      return scalarCompareClause(def, leaf, entityPath, requestId);
    }
    astUnsupported(`Оператор «${operator}» для свойства типа ${def.value_type}`, entityPath, requestId);
  }

  if (operator === 'not_contains') {
    const inner = propertyClauses(ndb, [{ property_id: def.id, operator: 'contains', value: leaf.value as string }], requestId)[0] ?? AST_FALSE;
    return astNegate(inner);
  }
  return delegate();
}

/**
 * Лист по структурным «Родители»/«Потомки»: наличие/отсутствие, «в списке» и
 * «количество» (числовые операторы — требование bd0348b3).
 */
function structuralLeafClause(
  kind: 'parents' | 'children',
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
): Clause {
  const ownCol = kind === 'parents' ? 'target_id' : 'source_id';
  const otherCol = kind === 'parents' ? 'source_id' : 'target_id';
  const { operator } = leaf;
  // «Количество» структурных связей — скалярный COUNT(*) по тем же живым
  // нетипизированным рёбрам.
  if (
    AST_RANGE_OPS.has(operator) ||
    AST_COMPARE_OPS.has(operator) ||
    (typeof leaf.value === 'number' && (operator === 'eq' || operator === 'ne'))
  ) {
    return countLeafClause(collectionCountSql(kind), [], leaf, path, requestId);
  }
  // Структурное ребро — живое НЕТИПИЗИРОВАННОЕ ребро (эталон: property-service
  // `structuralEdgeCounts`; ADR/требование «структурные связи»). Типизированные
  // рёбра относятся к режиму «по всем типам связей» (задача e62aa4db) и здесь
  // НЕ учитываются — иначе смешивались бы два режима (сущность 489c394f).
  const edge = `l.${ownCol} = t.id AND l.active = 1 AND l.marked_for_deletion = 0 AND l.type_id IS NULL`;
  const presence: Clause = {
    sql: `EXISTS (SELECT 1 FROM links_v l WHERE ${edge})`,
    params: [],
  };
  if (operator === 'is_empty') return { sql: `NOT (${presence.sql})`, params: presence.params };
  if (operator === 'not_empty') return presence;
  if (operator === 'in' || operator === 'not_in' || operator === 'eq' || operator === 'ne') {
    const ids = astStringList(leaf.value, operator, path, requestId);
    const list = operator === 'eq' || operator === 'ne' ? (ids.length > 0 ? [ids[0]!] : []) : ids;
    if (list.length === 0) return operator === 'in' || operator === 'eq' ? AST_FALSE : AST_TRUE;
    const match: Clause = {
      sql: `EXISTS (SELECT 1 FROM links_v l WHERE ${edge}
        AND l.${otherCol} IN (${list.map(() => '?').join(',')}))`,
      params: [...list],
    };
    return operator === 'in' || operator === 'eq' ? match : { sql: `NOT (${match.sql})`, params: match.params };
  }
  astUnsupported(`Оператор «${operator}» для структурного операнда`, path, requestId);
}

/** Булев предикат по колонке-флагу (`active`/`marked_for_deletion`). */
function boolColumnClause(column: string, leaf: FilterAstLeaf, path: string, requestId?: string): Clause {
  if (leaf.operator !== 'eq' && leaf.operator !== 'ne') {
    astUnsupported(`Оператор «${leaf.operator}» для булева предиката`, path, requestId);
  }
  if (typeof leaf.value !== 'boolean') {
    throw new EtnError('VALIDATION_ERROR', 'Булев предикат требует значения boolean.', { field: path }, requestId);
  }
  const want = leaf.operator === 'eq' ? leaf.value : !leaf.value;
  return { sql: `${column} = ${want ? 1 : 0}`, params: [] };
}

/** Наличие/отсутствие коллекции (вложения, дневниковые записи, комментарий). */
function boolPresenceClause(existsSql: string, leaf: FilterAstLeaf, path: string, requestId?: string): Clause {
  let want: boolean;
  if (leaf.operator === 'not_empty') want = true;
  else if (leaf.operator === 'is_empty') want = false;
  else if ((leaf.operator === 'eq' || leaf.operator === 'ne') && typeof leaf.value === 'boolean') {
    want = leaf.operator === 'eq' ? leaf.value : !leaf.value;
  } else {
    astUnsupported(`Оператор «${leaf.operator}» для предиката наличия`, path, requestId);
  }
  return want ? { sql: existsSql, params: [] } : { sql: `NOT (${existsSql})`, params: [] };
}

/**
 * «Есть слова»: LIKE-фильтр по выбранным областям (мини-синтаксис §6.10).
 *
 * `astOpts.keywordCommentIncludesLinkComments` — контекст фазы 1 отбора хроники:
 * область `comment` ищет и комментарии инцидентных связей (см.
 * {@link buildKeywordClause}); ставит только исполнитель хроники.
 */
function keywordsLeafClause(
  entity: { kind: 'keywords'; scope?: StructureKeywordScope[] },
  leaf: FilterAstLeaf,
  path: string,
  requestId?: string,
  astOpts?: AstExecOptions,
): Clause {
  if (leaf.operator !== 'matches') {
    astUnsupported(`Оператор «${leaf.operator}» для операнда «Есть слова»`, path, requestId);
  }
  // Ни одной отмеченной области (в т.ч. `scope` не задан) — условие отключено;
  // режима «искать везде» нет (требование 0882f8d5). Дефолт title+synonyms —
  // поведение плоского движка (`keyword_scope`), к операнду AST не применяется.
  const scope = new Set<StructureKeywordScope>(entity.scope ?? []);
  if (scope.size === 0) return AST_TRUE;
  const text = typeof leaf.value === 'string' ? leaf.value : '';
  const { include, exclude } = parseFilterKeywords(text);
  if (include.length === 0 && exclude.length === 0) return AST_TRUE;
  const clause = buildKeywordClause(scope, {
    ...(astOpts?.keywordCommentIncludesLinkComments === true
      ? { commentIncludesLinkComments: true }
      : {}),
  });
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const word of include) {
    parts.push(clause.sql);
    for (let i = 0; i < clause.paramCount; i += 1) params.push(buildLikePattern(word.toLowerCase()));
  }
  for (const word of exclude) {
    parts.push(`NOT ${clause.sql}`);
    for (let i = 0; i < clause.paramCount; i += 1) params.push(buildLikePattern(word.toLowerCase()));
  }
  return { sql: `(${parts.join(' AND ')})`, params };
}

/** Лист авторства/редактора — та же семантика, что у авторских фильтров. */
function authorLeafClause(column: string, leaf: FilterAstLeaf, path: string, requestId?: string): Clause {
  const map: Record<string, StructureAuthorOp> = {
    eq: 'eq',
    ne: 'ne',
    in: 'in',
    not_in: 'not_in',
    is_empty: 'empty',
    not_empty: 'not_empty',
  };
  const op = map[leaf.operator];
  if (op === undefined) astUnsupported(`Оператор «${leaf.operator}» для авторского операнда`, path, requestId);
  const value: string | string[] | undefined =
    leaf.value === undefined ? undefined : Array.isArray(leaf.value) ? (leaf.value as string[]) : (leaf.value as string);
  const where: string[] = [];
  const params: unknown[] = [];
  appendAuthorCondition(where, params, column, value, op);
  return { sql: where.length > 0 ? `(${where.join(' AND ')})` : AST_TRUE.sql, params };
}

/** Лист по дате создания/изменения: сравнения и «между» (границы включительны). */
function dateLeafClause(column: string, leaf: FilterAstLeaf, path: string, requestId?: string): Clause {
  const one = (op: string, value: unknown): Clause => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new EtnError('VALIDATION_ERROR', 'Граница даты должна быть непустой строкой ISO-8601.', { field: path }, requestId);
    }
    const sql = op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : '<=';
    return { sql: `${column} ${sql} ?`, params: [value.trim()] };
  };
  if (leaf.operator === 'gt' || leaf.operator === 'gte' || leaf.operator === 'lt' || leaf.operator === 'lte') {
    return one(leaf.operator, leaf.value);
  }
  if (leaf.operator === 'between' || leaf.operator === 'not_between') {
    if (!Array.isArray(leaf.value) || leaf.value.length !== 2) {
      throw new EtnError('VALIDATION_ERROR', 'Оператор «между» требует ровно две границы.', { field: path }, requestId);
    }
    const low = one('gte', leaf.value[0]);
    const high = one('lte', leaf.value[1]);
    const between: Clause = { sql: `(${low.sql} AND ${high.sql})`, params: [...low.params, ...high.params] };
    return leaf.operator === 'between' ? between : { sql: `NOT (${between.sql})`, params: between.params };
  }
  astUnsupported(`Оператор «${leaf.operator}» для даты`, path, requestId);
}

/**
 * «Имеет свойство»/«не имеет свойство» для мысли: фактический набор = свойства,
 * эффективные по цепочке типов мысли (с наследованием), ПЛЮС индивидуально
 * заданные значения (требование bd0348b3). «Имеет» истинно, если хотя бы одно
 * из списка в наборе.
 */
function hasPropertiesLeafClause(ndb: NetworkDb, leaf: FilterAstLeaf, path: string, requestId?: string): Clause {
  // «Заполнено/не заполнено» без списка свойств — «мысль имеет хотя бы одно
  // значение свойства»/«ни одного». Это точный AST-эквивалент плоского
  // трёхсостоянного `has_properties` (компилятор, требования 91983c20/76e30d9a);
  // `has`/`not_has` с набором id отвечает на другой вопрос («имеет конкретные
  // свойства», с учётом наследования по типу) и потому для него не годится.
  if (leaf.operator === 'is_empty' || leaf.operator === 'not_empty') {
    const exists =
      "EXISTS (SELECT 1 FROM property_values_v pv WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id)";
    return leaf.operator === 'not_empty' ? { sql: exists, params: [] } : { sql: `NOT (${exists})`, params: [] };
  }
  if (leaf.operator !== 'has' && leaf.operator !== 'not_has') {
    astUnsupported(`Оператор «${leaf.operator}» для операнда «свойства»`, path, requestId);
  }
  const ids = astStringList(leaf.value, leaf.operator, path, requestId);
  if (ids.length === 0) return leaf.operator === 'has' ? AST_FALSE : AST_TRUE;
  const individual: Clause = {
    sql: `EXISTS (SELECT 1 FROM property_values_v pv WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id
      AND pv.property_id IN (${ids.map(() => '?').join(',')}))`,
    params: [...ids],
  };
  const byType = typeIdsWithEffectiveProperty(ndb, ids);
  const match: Clause =
    byType.length === 0
      ? individual
      : {
          sql: `(${individual.sql} OR t.type_id IN (${byType.map(() => '?').join(',')}))`,
          params: [...individual.params, ...byType],
        };
  return leaf.operator === 'has' ? match : astNegate(match);
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

/** Рёбра свойства-связи: колонки сторон + фильтр типа связи (или структурности). */
interface LinkPropertyEdges {
  ownerCol: 'source_id' | 'target_id';
  targetCol: 'source_id' | 'target_id';
  typeSql: string;
  typeParams: unknown[];
  /** Разрешённое направление стороны (`out` — источник, `in` — цель). */
  direction: LinkPropertyDirection;
}

/**
 * Разобрать `config` свойства-связи в параметры рёбер. `null` — некорректный
 * config (не структурное и без `link_type_id`): условие не матчит ничего.
 */
function linkPropertyEdges(
  def: RegistryPropertyRow,
  directionRef: LinkPropertyDirection | null,
): LinkPropertyEdges | null {
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
  if (!structural && linkTypeId === null) return null;
  const direction = directionRef ?? linkPropertyDirection(config);
  return {
    ownerCol: direction === 'out' ? 'source_id' : 'target_id',
    targetCol: direction === 'out' ? 'target_id' : 'source_id',
    typeSql: linkTypeId === null ? 'l.type_id IS NULL' : 'l.type_id = ?',
    typeParams: linkTypeId === null ? [] : [linkTypeId],
    direction,
  };
}

/**
 * Лист «в иерархии» по свойству-ссылке: истина, если хотя бы одно значение
 * (цель рёбер стороны свойства) входит в поддерево корней (требование aa7a2aea,
 * задача e62aa4db). Режим обхода поддерева — `leaf.mode` (по умолчанию
 * структурный).
 */
function hierarchyLinkPropertyClause(
  ndb: NetworkDb,
  def: RegistryPropertyRow,
  directionRef: LinkPropertyDirection | null,
  leaf: FilterAstLeaf,
  astOpts: AstExecOptions | undefined,
  path: string,
  requestId?: string,
): Clause {
  const roots = astStringList(leaf.value, leaf.operator, path, requestId);
  if (roots.length === 0) return leaf.operator === 'in_hierarchy' ? AST_FALSE : AST_TRUE;
  const edges = linkPropertyEdges(def, directionRef);
  if (edges === null) return leaf.operator === 'in_hierarchy' ? AST_FALSE : AST_TRUE;
  const subtree = astHierarchySubtree(ndb, astHierarchyMode(leaf), roots, astOpts, path, requestId);
  const membership = astIdInClause(`l.${edges.targetCol}`, subtree);
  const match: Clause = {
    sql: `EXISTS (
      SELECT 1 FROM links_v l
      WHERE l.${edges.ownerCol} = t.id AND ${edges.typeSql}
        AND l.active = 1 AND l.marked_for_deletion = 0 AND ${membership.sql})`,
    params: [...edges.typeParams, ...membership.params],
  };
  return leaf.operator === 'in_hierarchy' ? match : astNegate(match);
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
  const edges = linkPropertyEdges(def, directionRef);
  if (edges === null) {
    // Некорректный config (валидируется при правке онтологии) — не матчит ничего.
    return { sql: '0', params: [] };
  }
  const { ownerCol, targetCol, typeSql, typeParams } = edges;
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
 * Клауза «нет совпадений» для условия, ссылка на свойство которого не
 * разрешилась (чужой/несуществующий `property_id` или имя без совпадения в
 * реестре). В прежнем движке такое условие молча ВЫПАДАЛО из `WHERE`, из-за
 * чего отбор расширялся до всей сети (ошибки 090d0242 и 4f17cb73, 0.12.1).
 * Теперь условие остаётся в запросе как заведомо ложное: `AND 0` обнуляет
 * набор совпадений и НЕ ослабляет отбор. Это согласуется с контрактом
 * (`etn.guide { topic: "thoughts.query" }`: неизвестный `property_id` не
 * матчит ничего) и с кросс-сетевым веером, где свойство может отсутствовать в
 * части сетей (тогда такая сеть вносит пустой вклад, а не расширяет выборку).
 *
 * Явную ошибку `VALIDATION_ERROR` на неразрешимую ссылку дают границы
 * пользовательского ввода (MCP-фасад `etn.thoughts.query`, REST-роут
 * `POST /thoughts/query`) — движок же тотален и никогда не расширяет отбор.
 */
const NO_MATCH_CLAUSE: Clause = { sql: '0', params: [] };

/**
 * Build one property-condition clause for a batch of conditions. Addressed
 * registry properties are read in one `SELECT … IN (…)` call. A condition whose
 * property reference does not resolve (foreign/unknown id, name without a
 * registry match, or a property deleted after the filter was saved) yields
 * {@link NO_MATCH_CLAUSE} — «нет совпадения», а не ослабление отбора.
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
  // `resolveConditionPropertyRef`. Неразрешимая ссылка — клауза «нет
  // совпадений» (`NO_MATCH_CLAUSE`), а не выпадение условия из отбора.
  const refs = conds.map((c) => resolveConditionPropertyRef(ndb, c.property_id, requestId));
  const ids = [...new Set(refs.filter((r) => r !== null).map((r) => r.propertyId))];
  const rows =
    ids.length === 0
      ? []
      : (ndb
          .prepare(`SELECT id, value_type, config FROM properties_v WHERE id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids) as Array<{ id: string; value_type: string; config: string | null }>);
  const byId = new Map(rows.map((r) => [r.id, r] as const));

  const out: Clause[] = [];
  for (let i = 0; i < conds.length; i += 1) {
    const cond = conds[i]!;
    const ref = refs[i]!;
    if (ref === null) {
      out.push(NO_MATCH_CLAUSE);
      continue;
    }
    const raw = byId.get(ref.propertyId);
    if (raw === undefined) {
      out.push(NO_MATCH_CLAUSE);
      continue;
    }
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

    // Множественное `text` (`config.multiple`) хранится comma-joined строкой:
    // операторы-списки и наборы матчат ПОЭЛЕМЕНТНО (ошибка 7489e4d9). Одиночное
    // `text` — точное сравнение (элемент один), поведение не меняется.
    if (
      def.value_type === 'text' &&
      (cond.operator === 'in' ||
        cond.operator === 'not_in' ||
        cond.operator === 'any_of' ||
        cond.operator === 'all_of' ||
        cond.operator === 'none_of')
    ) {
      out.push(
        textListClause(def.id, column, isMultipleProperty(def, 'text'), cond.operator, cond.value, requestId),
      );
      continue;
    }

    // Множественное `url` (`config.multiple`, JSON-массив строк) хранит значение
    // как набор: `in`/`not_in` матчат ПОЭЛЕМЕНТНО (ошибка 55cb51f8), как у
    // `text`. Одиночное `url` — точное сравнение хранимой строки. Наборные
    // `any_of`/`all_of`/`none_of` идут общим путём по JSON-элементам ниже.
    if (
      def.value_type === 'url' &&
      (cond.operator === 'in' || cond.operator === 'not_in')
    ) {
      out.push(
        urlListClause(def.id, column, isMultipleProperty(def, 'url'), cond.operator, cond.value, requestId),
      );
      continue;
    }

    // Операторы наборов (задача 20effcbd) — `url` и legacy `thought_ref`.
    if (cond.operator === 'any_of' || cond.operator === 'all_of' || cond.operator === 'none_of') {
      out.push(multipleValueSetClause(def.id, column, cond.operator, cond.value, requestId, foldsCase(def)));
      continue;
    }

    if (cond.operator === 'contains') {
      // «Содержит» — подстрочно и регистронезависимо (требование f14e48ab):
      // регистр сворачивается unicode_lower с обеих сторон.
      const fold = foldsCase(def);
      const pattern = buildLikePattern(String(cond.value));
      const lhs = fold ? `unicode_lower(pv.${column})` : `pv.${column}`;
      const rhs = fold ? 'unicode_lower(?)' : '?';
      out.push({
        sql: `EXISTS (
          SELECT 1 FROM property_values_v pv
          WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
            AND ${lhs} LIKE ${rhs} ESCAPE '\\')`,
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
      // «В списке» — равенство по правилам типа: текст регистронезависимо
      // (требование 7f0e3f8c, ADR 9779dd21).
      const fold = foldsCase(def);
      const lhs = fold ? `unicode_lower(pv.${column})` : `pv.${column}`;
      const rhs = fold ? 'unicode_lower(?)' : '?';
      const listSql = `SELECT 1 FROM property_values_v pv
         WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
           AND ${lhs} IN (${values.map(() => rhs).join(',')})`;
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
    // «Равно/сравнения» по правилам типа: текст регистронезависимо, включая
    // строковые «больше/меньше» (ADR 9779dd21, требование 25324388).
    const fold = foldsCase(def);
    const lhs = fold ? `unicode_lower(pv.${column})` : `pv.${column}`;
    const rhs = fold ? 'unicode_lower(?)' : '?';
    out.push({
      sql: `EXISTS (
        SELECT 1 FROM property_values_v pv
        WHERE pv.owner_type = 'thought' AND pv.owner_id = t.id AND pv.property_id = ?
          AND ${lhs} ${opSql} ${rhs})`,
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
    req.ast === undefined &&
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
function dateBoundIsSet(value: string | undefined): value is string {
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
  /**
   * Подпись фактического порядка (см. {@link sortSignature}): и ключи `ast.sort`,
   * и режим «пустой фильтр», и направление добора `id`. Заменяет прежние
   * `sort`/`order` — при `ast.sort` они дефолтные и не отличали бы один
   * многоуровневый порядок от другого.
   */
  sig: string;
  /** `1` — режим «пустой фильтр» (HOME первой); иначе `0`. */
  h: 0 | 1;
  /** Значения ключей сортировки последней строки (в порядке {@link SortKey}). */
  k: Array<string | number | null>;
  /** id последней строки (уникальный добор ключа, ADR 5f6cb775). */
  id: string;
}

/**
 * Подпись фактического порядка страницы: список `(expr, dir)` ключей плюс
 * направление завершающего `t.id`. По ней курсор сверяется с текущим запросом —
 * продолжение читается только по тому же порядку (в т.ч. при `ast.sort`).
 */
function sortSignature(keys: SortKey[], idDir: 'ASC' | 'DESC'): string {
  return JSON.stringify({ idDir, keys: keys.map((k) => [k.tag ?? k.expr, k.expr, k.dir]) });
}

/** Кодировать курсор в непрозрачную строку (base64url JSON). */
function encodeCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Разобрать и провалидировать курсор. Курсор обязан соответствовать
 * фактическому порядку текущего запроса (`sig` — ключи `ast.sort` либо плоские
 * `sort`/`order`) и режиму пустого фильтра — иначе продолжение страницы
 * читалось бы по чужому порядку (потеря/дубли строк).
 */
function decodeCursor(
  raw: string,
  sig: string,
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
  if (c.sig !== sig) return invalid({ reason: 'sort' });
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

// ---------------------------------------------------------------------------
// Компилятор плоской формы отбора в AST (требования 91983c20 «Старые тела
// REST/MCP компилируются в AST» и 76e30d9a «Один исполнитель AST…», ADR
// 34f6f9d6; сущность спецификации 489c394f).
//
// Единый вход: критерии плоского тела (`ThoughtQueryRequest`) превращаются в
// дерево AST и исполняются единственным AST-путём — второго пути исполнения
// критериев нет. Компилятор живёт в движке, поэтому компиляция прозрачна для
// обоих фасадов (REST `POST /thoughts/query` и MCP `etn.thoughts.query`).
//
// Листья переиспользуют тот же исполнитель, что и явное AST-тело, поэтому
// паритет результата с прежней плоской формой достигается по построению
// (требование 91983c20). НЕ компилируются (остаются фасадными пред-сужениями,
// применяются поверх критериев): `subtree` из `parent_ids`/`in_subtree_of`
// (требование 3482a399 — корни входят в результат) и `link_filter` (вынесен из
// AST по сущности 489c394f). Сортировка/пагинация живут вне дерева (3e47f52a).
// ---------------------------------------------------------------------------

/** Оператор авторского фильтра → код оператора AST-листа («Пусто» — is_empty). */
const AUTHOR_OP_TO_AST: Record<StructureAuthorOp, FilterAstOperator> = {
  eq: 'eq',
  ne: 'ne',
  in: 'in',
  not_in: 'not_in',
  empty: 'is_empty',
  not_empty: 'not_empty',
};

/** Условие-лист AST с необязательным значением. */
function astLeaf(entity: FilterAstEntity, operator: FilterAstOperator, value?: FilterAstValue): FilterAstLeaf {
  return value === undefined ? { entity, operator } : { entity, operator, value };
}

/**
 * Лист авторского операнда (автор/редактор) с той же семантикой, что у плоского
 * {@link appendAuthorCondition}: `empty`/`not_empty` дают условие даже без
 * значения; отсутствующий оператор трактуется как `eq`.
 */
function compileAuthorLeaf(
  kind: 'author' | 'editor',
  value: string | string[] | undefined,
  op: StructureAuthorOp | undefined,
): FilterAstLeaf | null {
  if (op === 'empty') return astLeaf({ kind }, 'is_empty');
  if (op === 'not_empty') return astLeaf({ kind }, 'not_empty');
  if (value === undefined) return null;
  return astLeaf({ kind }, AUTHOR_OP_TO_AST[op ?? 'eq'], value);
}

/**
 * Скомпилировать критерии плоской формы в AST. `undefined` — плоское тело не
 * несёт ни одного критерия (тогда движок отдаёт режим пустого фильтра как
 * раньше). Все листья объединяются по AND — плоская семантика «критерии по AND».
 */
export function compileThoughtQueryToAst(
  ndb: NetworkDb,
  req: ThoughtQueryRequest,
  requestId?: string,
): FilterAst | undefined {
  const children: FilterAstNode[] = [];

  // Актуальность: явное значение переопределяет настройку; дефолт — только
  // активные; `'any'` — без условия (плоская семантика).
  if (req.active === 'true' || req.active === undefined) children.push(astLeaf({ kind: 'active' }, 'eq', true));
  else if (req.active === 'false') children.push(astLeaf({ kind: 'active' }, 'eq', false));

  // Пометка на удаление: дефолт — только непомеченные; `'any'` — без условия.
  if (req.trashed === 'true') children.push(astLeaf({ kind: 'trashed' }, 'eq', true));
  else if (req.trashed === 'false' || req.trashed === undefined) children.push(astLeaf({ kind: 'trashed' }, 'eq', false));

  const author = compileAuthorLeaf('author', req.created_by, req.created_by_op);
  if (author !== null) children.push(author);
  const editor = compileAuthorLeaf('editor', req.updated_by, req.updated_by_op);
  if (editor !== null) children.push(editor);

  // Даты: границы включительны (плоский `appendDateBound` — `>=`/`<=`).
  if (dateBoundIsSet(req.created_after)) children.push(astLeaf({ kind: 'created_at' }, 'gte', req.created_after.trim()));
  if (dateBoundIsSet(req.created_before)) children.push(astLeaf({ kind: 'created_at' }, 'lte', req.created_before.trim()));
  if (dateBoundIsSet(req.updated_after)) children.push(astLeaf({ kind: 'updated_at' }, 'gte', req.updated_after.trim()));
  if (dateBoundIsSet(req.updated_before)) children.push(astLeaf({ kind: 'updated_at' }, 'lte', req.updated_before.trim()));

  // Трёхсостоянные признаки наличия: true — только с наличием, false — только
  // без, поле не задано — критерий не участвует.
  if (req.has_properties !== undefined) children.push(astLeaf({ kind: 'properties' }, req.has_properties ? 'not_empty' : 'is_empty'));
  if (req.has_comment !== undefined) children.push(astLeaf({ kind: 'comment' }, req.has_comment ? 'not_empty' : 'is_empty'));
  if (req.has_attachments !== undefined) children.push(astLeaf({ kind: 'attachments' }, req.has_attachments ? 'not_empty' : 'is_empty'));
  if (req.has_chronology !== undefined) children.push(astLeaf({ kind: 'chronology' }, req.has_chronology ? 'not_empty' : 'is_empty'));

  // «Есть слова»: области берутся ровно как у плоского движка (отсутствие/
  // пустой набор → дефолт title+synonyms), мини-синтаксис разбирает лист.
  const keywords = req.keywords ?? '';
  if (keywords.trim() !== '') {
    children.push(astLeaf({ kind: 'keywords', scope: [...resolveKeywordScope(req.keyword_scope)] }, 'matches', keywords));
  }

  // Тип мысли: плоский `type_ids` компилируется в лист «Тип в иерархии»
  // (`entity.type` + `in_hierarchy`, режим structural по умолчанию) — требование
  // f7f93c32, ADR 9a356460. Раскрытие подтипов/потомков делает исполнитель на
  // момент запроса (`hierarchyTypeLeafClause` → `expandTypeIdsToSubtree`), а НЕ
  // компилятор: замороженный список подтипов дал бы неверный результат, если
  // после сохранения отбора в онтологии появится новый подтип (операнд «Тип»
  // в иерархии реализован задачей e62aa4db).
  if ((req.type_ids ?? []).length > 0) {
    children.push(astLeaf({ kind: 'type' }, 'in_hierarchy', [...(req.type_ids as string[])]));
  }
  // Тип связи: раскрытие по поддереву (L21) делается той же функцией, что у
  // плоской ветки; пустое раскрытие — условие не накладывается (прежнее
  // поведение плоского движка: `expanded.length === 0` → клауза не добавлялась).
  if ((req.link_type_ids ?? []).length > 0) {
    const expanded = expandTypeIdsToSubtree(ndb, 'link_types', req.link_type_ids as string[]);
    if (expanded.length > 0) children.push(astLeaf({ kind: 'link_type' }, 'in', expanded));
  }

  // Условия значений свойств: тот же словарь операторов, что у плоской формы.
  // Прежде — валидация теми же правилами плоского движка ({@link propertyClauses}):
  // AST-лист свойства шире плоского (числовые операторы на связи/коллекции —
  // «количество»), поэтому недопустимое для плоской формы значение (напр.
  // числовое `eq` по свойству-связи) должно быть отвергнуто ровно как раньше,
  // а не молча получить иную семантику. Результат проверки не нужен: исполняет
  // всё равно AST-лист, но для допустимых значений он даёт тот же ответ.
  if ((req.properties ?? []).length > 0) {
    propertyClauses(ndb, req.properties as ThoughtQueryPropertyCondition[], requestId);
  }
  for (const cond of req.properties ?? []) {
    children.push(
      astLeaf({ kind: 'property', property_id: cond.property_id }, cond.operator as FilterAstOperator, cond.value),
    );
  }

  if (children.length === 0) return undefined;
  return {
    version: FILTER_AST_VERSION,
    filter: children.length === 1 ? (children[0] as FilterAstNode) : { op: 'and', children },
  };
}

/**
 * Листья «Есть слова» в строго конъюнктивном контексте (корень и все предки —
 * только `and`; ни `or`, ни `not`). Только для них безопасно FTS-сужение
 * (`fts_thought_names MATCH`, требование 314cbb8d): под `or`/`not` сужатель
 * отсекал бы строки, удовлетворяющие другим ветвям.
 */
function conjunctiveKeywordLeaves(node: FilterAstNode, out: FilterAstLeaf[]): FilterAstLeaf[] {
  if ('op' in node) {
    if (node.op === 'and') for (const child of node.children) conjunctiveKeywordLeaves(child, out);
    return out;
  }
  if (node.entity.kind === 'keywords') out.push(node);
  return out;
}

/**
 * FTS-сужатели для конъюнктивных листьев «Есть слова» (перенесены в AST-путь,
 * чтобы сторож производительности полнотекста 314cbb8d оставался зелёным).
 * Алиасы уникальны (`__kw`, `__kw1`, …) — джойнов может быть несколько.
 */
function astKeywordFtsJoins(ast: FilterAst): Clause[] {
  const joins: Clause[] = [];
  let idx = 0;
  for (const leaf of conjunctiveKeywordLeaves(ast.filter, [])) {
    if (leaf.entity.kind !== 'keywords') continue;
    const scope = new Set<StructureKeywordScope>(leaf.entity.scope ?? []);
    // Пустая область — условие «Есть слова» отключено (лист вернёт AST_TRUE),
    // FTS-сужатель не ставим, иначе он отсекал бы строки вопреки листу.
    if (scope.size === 0) continue;
    const { include } = parseFilterKeywords(typeof leaf.value === 'string' ? leaf.value : '');
    const join = buildKeywordFtsJoin(include, scope);
    if (join === null) continue;
    const alias = idx === 0 ? '__kw' : `__kw${idx}`;
    joins.push({ sql: idx === 0 ? join.sql : join.sql.replace(/__kw\b/g, alias), params: join.params });
    idx += 1;
  }
  return joins;
}

function buildFilterQuerySql(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  walk: WalkResult | null,
  emptyFilterMode: 'home_orphans' | 'all',
  requestId?: string,
  astOpts?: AstExecOptions,
): FilterQuerySql {
  const homeFirst = emptyFilterMode === 'home_orphans' && isFilterEmpty(req);
  const { keys, joinSql, joinParams } = sortKeysFor(ndb, userId, req, homeFirst);
  const idDir: 'ASC' | 'DESC' = req.order === 'desc' ? 'DESC' : 'ASC';
  const cursor =
    typeof req.cursor === 'string' && req.cursor.trim() !== ''
      ? decodeCursor(req.cursor.trim(), sortSignature(keys, idDir), homeFirst, requestId)
      : null;
  const keyset = cursor === null ? null : keysetClause(keys, idDir, cursor.k, cursor.id);

  // Режим пустого фильтра (REST-контракт): пустой плоский фильтр → HOME
  // первой + сироты. Проверяется ДО компиляции (плоское тело без критериев).
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

  // Единый вход (ADR 34f6f9d6, требования 91983c20/76e30d9a): критерии отбора —
  // только из AST; плоское тело компилируется в AST тем же компилятором, отдельной
  // ветки исполнения критериев нет. Явное AST-тело (`req.ast`) — как передано.
  const effectiveAst = req.ast ?? compileThoughtQueryToAst(ndb, req, requestId);
  if (effectiveAst !== undefined) {
    const clause = filterAstClause(ndb, effectiveAst, requestId, astOpts);
    const parts: string[] = [`(${clause.sql === '' ? '1=1' : clause.sql})`];
    const params: unknown[] = [...clause.params];
    // Фасадное пред-сужение поддерева (REST `parent_ids` / MCP `in_subtree_of`):
    // применяется ПОВЕРХ критериев, в AST не компилируется (требование 3482a399 —
    // перечисленные мысли входят в результат; ошибка ad1551ea). `link_filter`
    // учтён обходом `walkSubtree` через `subtree.link_filter`.
    if (req.subtree !== undefined) {
      if (walk === null || walk.depths.size === 0) {
        // Поддерево пустое — кандидатов нет (REST-семантика прежнего движка).
        parts.push('0');
      } else {
        const ids = [...walk.depths.keys()];
        parts.push(`t.id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
    }
    // FTS-сужатель полнотекста (требование 314cbb8d) — для конъюнктивных
    // листьев «Есть слова»; LIKE-семантику мини-языка хранит AST-лист.
    const fts = astKeywordFtsJoins(effectiveAst);
    const fromJoinSql = fts.length === 0 ? joinSql : `${joinSql} ${fts.map((j) => j.sql).join(' ')}`;
    const fromJoinParams = fts.length === 0 ? joinParams : [...joinParams, ...fts.flatMap((j) => j.params)];
    return {
      baseSql: `FROM thoughts_v t ${fromJoinSql} WHERE ${parts.join(' AND ')}`,
      joinParams: fromJoinParams,
      params,
      keys,
      idDir,
      keyset,
      homeFirst: false,
    };
  }

  // Плоское тело без критериев вне режима HOME (`emptyFilterMode: 'all'`,
  // например встраивание критериев в чужой SQL): все мысли.
  return {
    baseSql: `FROM thoughts_v t ${joinSql} WHERE 1=1`,
    joinParams,
    params: [],
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
  /** Неразрешимые токены AST (пусто — всё разрешено). */
  unresolved: TokenIssue[];
  /** Мутируемые счётчики статистики (только при `collectStats`). */
  stats?: NonNullable<AstExecOptions['stats']>;
}

function buildQuery(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  emptyFilterMode: 'home_orphans' | 'all',
  requestId?: string,
  tokenContext?: AstTokenContext,
  collectStats?: boolean,
  profile?: FilterProfileId,
  /**
   * Опции исполнения AST от встраивающего вызова (хроника ставит
   * `keywordCommentIncludesLinkComments` — фаза 1 ищет и комментарии связей,
   * требование ce111b0d). Не критерий выборки: на прочих фасадах не заполняется.
   */
  astContext?: AstExecContextOptions,
): BuiltQuery {
  // Красная диагностика (требование 44d61c8a): явное AST-тело, ссылающееся на
  // удалённую сущность, исполнять запрещено — заведомо неисполнимый отбор не
  // запускается, пользователь видит причину со снапшотом имени. Применяется
  // только к ЯВНОМУ wire-AST (`req.ast`); плоские критерии компилируются в AST
  // внутри движка и проверяются при входе в REST/MCP отдельно (их ссылки —
  // не AST-сущности пользователя).
  if (req.ast !== undefined) {
    // Профиль точки применения (требование 0095daad, ADR 0c02ab4f): операнд,
    // невидимый в этой точке, отвергается — до исполнения.
    if (profile !== undefined) assertFilterAstInProfile(req.ast, profile, requestId);
    const diag = diagnoseFilterAst(ndb, req.ast, { requestId });
    if (diag.errors.length > 0) throw filterDiagnosticsError(diag.errors, requestId);
  }
  const walk = req.subtree === undefined ? null : walkSubtree(ndb, req.subtree);
  const unresolved: TokenIssue[] = [];
  // Кэш поддеревьев «в иерархии» живёт в пределах одного исполнения запроса.
  const astOpts: AstExecOptions = { unresolved, hierarchyCache: new Map(), subqueryBudget: { ids: 0 } };
  if (tokenContext !== undefined) astOpts.ctx = tokenContext;
  if (astContext?.keywordCommentIncludesLinkComments === true) {
    astOpts.keywordCommentIncludesLinkComments = true;
  }
  if (collectStats === true) {
    astOpts.stats = { conditions: 0, nodes_walked: 0, hierarchy_calls: 0, limits_hit: new Set() };
  }
  const sql = buildFilterQuerySql(ndb, userId, req, walk, emptyFilterMode, requestId, astOpts);
  return { sql, walk, unresolved, ...(astOpts.stats !== undefined ? { stats: astOpts.stats } : {}) };
}

/**
 * Подзапрос `SELECT t.id FROM thoughts_v t … WHERE …` по критериям выборки
 * мыслей — тот же построитель, что у {@link queryThoughts}/{@link queryThoughtIds},
 * но без сортировки, лимита и курсора. Нужен для встраивания критериев в
 * чужой SQL (`IN (<подзапрос>)`): например, критерии целей хроники (0.10.1)
 * проверяются через `comment_targets.owner_id IN (…этот подзапрос…)` — модель
 * критериев не дублируется.
 *
 * `emptyFilterMode: 'all'`: пустой фильтр — все мысли (для встраивания в
 * `IN` это корректно); `home_orphans` здесь не имеет смысла.
 *
 * `astContext` — контекст исполнения AST от встраивающего вызова: хроника ставит
 * `keywordCommentIncludesLinkComments`, иначе её фаза 1 (требование ce111b0d)
 * теряла бы мысли, отобранные по комментариям связей (ошибка fc97548d).
 */
export function buildThoughtIdSelect(
  ndb: NetworkDb,
  userId: string,
  req: ThoughtQueryRequest,
  requestId?: string,
  astContext?: AstExecContextOptions,
): { sql: string; params: unknown[] } {
  const built = buildQuery(ndb, userId, req, 'all', requestId, undefined, undefined, undefined, astContext);
  return {
    sql: `SELECT t.id ${built.sql.baseSql}`,
    params: [...built.sql.joinParams, ...built.sql.params],
  };
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
  const startedAt = opts.collectStats === true ? performance.now() : 0;
  const built = buildQuery(ndb, userId, req, emptyFilterMode, undefined, opts.tokenContext, opts.collectStats === true, opts.profile);
  // Неразрешимый токен AST — пустой результат с пояснением, а не молчаливая
  // потеря условия (требование b7fdab20).
  if (built.unresolved.length > 0) {
    return {
      items: [],
      total: req.count === true ? 0 : null,
      has_more: false,
      next_cursor: null,
      directions: {},
      depths: null,
      truncated: false,
      reason: null,
      unresolved: built.unresolved,
      ...(built.stats !== undefined
        ? { stats: finalizeStats(built.stats, startedAt, built, req, opts.maxLimit ?? STRUCTURES_QUERY_MAX_LIMIT) }
        : {}),
    };
  }
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
  const nextCursor = hasMore ? buildNextCursor(sql, pageRows) : null;
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
    ...(built.stats !== undefined
      ? { stats: finalizeStats(built.stats, startedAt, built, req, maxLimit) }
      : {}),
  };
}

/**
 * Собрать итоговую статистику исполнения (требование 0f34a5ff) из мутируемых
 * счётчиков обхода: время — от старта `queryThoughts`, плюс сработавшие
 * предохранители, не приведшие к ошибке (обрезка обхода поддерева, потолок
 * страницы). Вызывается только когда статистика собиралась.
 */
function finalizeStats(
  counters: NonNullable<AstExecOptions['stats']>,
  startedAt: number,
  built: BuiltQuery,
  req: ThoughtQueryRequest,
  maxLimit: number,
): QueryStats {
  const limits = new Set(counters.limits_hit);
  if (built.walk?.truncated === true) limits.add(`subtree_${built.walk.reason ?? 'nodes'}`);
  if (req.limit > maxLimit) limits.add('page_limit');
  return {
    duration_ms: Math.round((performance.now() - startedAt) * 100) / 100,
    conditions: counters.conditions,
    nodes_walked: counters.nodes_walked,
    hierarchy_calls: counters.hierarchy_calls,
    limits_hit: [...limits],
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
    sig: sortSignature(sql.keys, sql.idDir),
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
  const startedAt = opts.collectStats === true ? performance.now() : 0;
  const built = buildQuery(ndb, userId, req, emptyFilterMode, undefined, opts.tokenContext, opts.collectStats === true, opts.profile);
  if (built.unresolved.length > 0) {
    return {
      ids: [],
      total: req.count === true ? 0 : null,
      has_more: false,
      next_cursor: null,
      unresolved: built.unresolved,
      ...(built.stats !== undefined
        ? { stats: finalizeStats(built.stats, startedAt, built, req, opts.maxLimit ?? STRUCTURES_QUERY_MAX_LIMIT) }
        : {}),
    };
  }
  const sql = built.sql;
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
    next_cursor: hasMore ? buildNextCursor(sql, pageRows) : null,
    ...(built.stats !== undefined
      ? { stats: finalizeStats(built.stats, startedAt, built, req, maxLimit) }
      : {}),
  };
}
