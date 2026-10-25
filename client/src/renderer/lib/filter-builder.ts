/**
 * Единый конструктор условий отбора (задача 48b59d00, веха 5 версии 0.8.2;
 * ADR «условия отбора строит один конструктор с одной моделью состояния»,
 * стандарт S4 «Клиент: условия отбора — только через общий конструктор»).
 *
 * Всё, из чего состоит отбор, живёт в одном экземпляре ЗДЕСЬ:
 *   - одна модель состояния отбора (`FilterCriteriaState`);
 *   - один словарь операторов по виду значения (`OPS_BY_TYPE`);
 *   - один набор сортировок (`FILTER_SORTS`, он же — множество, которое
 *     принимает исполнитель) и один набор направлений (`FILTER_ORDERS`);
 *   - один конвертер состояния в wire-формат (`buildWireFilter`);
 *   - один словарь операторов авторства (`AUTHOR_OP_LABELS`) и одна строка
 *     условия «автор/редактор» (`buildAuthorConditionRow`);
 *   - одна точка адресации сторон свойства-связи в условиях
 *     (`withReverseLinkPropertySides`, задача df992826) — обе стороны каждой
 *     связи реестра, а не только цепочки редактируемого типа.
 *
 * Панель отбора «Структур» (`screens/structures/filter-panel.ts`) и диалог
 * отбора типа мысли (`screens/thought-type/filter-dialog.ts`) — два
 * применения этого конструктора; исполнитель отбора
 * (`canvas/focus-filter-strip.ts`) сверяет допустимые сортировки с этим же
 * модулем и не имеет собственного мнения о наборе.
 *
 * Набор сортировок намеренно совпадает с серверным `STRUCTURE_SORTS`
 * (`alpha`/`created`/`viewed`/`updated`): конструктор сохраняет только то,
 * что исполнитель в состоянии исполнить. Сохранённые ранее значения вне
 * набора исполнитель принимает с явным сообщением, а не отбрасывает молча
 * — требование «Сортировки отбора: единый набор…» и ошибки 33a3e285 /
 * 4dd14aa3 (`updated` поддержан сервером в 0.8.2 и входит в набор).
 */

import {
  FILTER_AST_ENTITY_KINDS,
  FILTER_AST_GROUP_OPS,
  FILTER_AST_OPERATORS,
  FILTER_AST_VERSION,
  FILTER_LINK_EDGE_STATES,
  SORT_ORDERS,
  STRUCTURE_AUTHOR_OPS,
  STRUCTURE_SORTS,
  filterProfileOperandOperators,
  getFilterProfile,
  typeNameKey,
  type ActivityEntityType,
  type ChronicleFilterDefinition,
  type FilterAst,
  type FilterAstEntity,
  type FilterAstEntityKind,
  type FilterAstGroupOp,
  type FilterAstGroup,
  type FilterAstHierarchyMode,
  type FilterAstLabels,
  type FilterAstLeaf,
  type FilterAstListItem,
  type FilterAstNode,
  type FilterAstOperator,
  type FilterAstScalar,
  type FilterAstSortKey,
  type FilterAstSubqueryValue,
  type FilterAstValue,
  type FilterLinkEdgeState,
  type FilterProfileId,
  type FilterTokenFamily,
  type LinkType,
  type NetworkProperty,
  type PropertyValueType,
  type SortOrder,
  type StructureAuthorOp,
  type StructureKeywordScope,
  type StructurePropertyCondition,
  type StructurePropertyOp,
  type StructureSort,
  type ThoughtTypeViewDefinition,
} from '@etn/shared';

import { div, el } from './dom.js';
import { buildUserMultiSelectWidget, buildUserSelectWidget } from './users.js';

// ---------------------------------------------------------------------------
// Словарь операторов по виду значения (03-server-api.md §6.10)
// ---------------------------------------------------------------------------

/**
 * Operators per property value type (03-server-api.md §6.10).
 *
 * `is_empty` / `not_empty` test for the presence of a value at all (the
 * `value` payload is ignored). Available for every type EXCEPT `bool`: for
 * booleans, `eq true` / `eq false` already cover the same intent, so an
 * extra toggle would be redundant noise on a small list.
 *
 * Единственный экземпляр на весь клиент; паритет с серверным
 * `OPS_BY_VALUE_TYPE` (`server/src/domain/structure-service.ts`) обязателен,
 * иначе UI предложит операцию, которую сервер отвергнет (ошибка 31a05292).
 */
export const OPS_BY_TYPE: Record<PropertyValueType, Array<{ op: StructurePropertyOp; label: string }>> = {
  text: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  url: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  date: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  number: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  bool: [{ op: 'eq', label: 'равно' }],
  // Свойство-связь (0.8.1): значение хранится в рёбрах, не в property_values.
  // На сервере поддержан тот же набор, что у legacy `thought_ref` ниже.
  link: [
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  // Legacy (миграция 040): таких свойств в живой БД не остаётся;
  // присутствие проверяется теми же кнопками «заполнено»/«не заполнено».
  thought_ref: [
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  // Кросс-сетевая ссылка (задача 7849008a, требование 586ebe81):
  // отбор по хранимому адресу. eq/ne — точное совпадение; для наборов —
  // any_of/all_of/none_of (как у `url`). is_empty/not_empty не нужны:
  // адрес либо точно совпал, либо нет.
  cross_network_ref: [
    { op: 'eq', label: 'равно' },
    { op: 'ne', label: 'не равно' },
    { op: 'any_of', label: 'содержит любой из' },
    { op: 'all_of', label: 'содержит все из' },
    { op: 'none_of', label: 'не содержит ни одного из' },
  ],
  // Ссылка на публикацию (0.11.1, задача f37b468d): отбор по id — та же
  // матрица, что у cross_network_ref.
  publication: [
    { op: 'eq', label: 'равно' },
    { op: 'ne', label: 'не равно' },
    { op: 'any_of', label: 'содержит любой из' },
    { op: 'all_of', label: 'содержит все из' },
    { op: 'none_of', label: 'не содержит ни одного из' },
  ],
};

// ---------------------------------------------------------------------------
// Наборы сортировок и направлений
// ---------------------------------------------------------------------------

/** Одна строка набора сортировок: wire-значение + подпись в `<select>`. */
export interface FilterSortOption {
  v: StructureSort;
  label: string;
}

/**
 * Единый набор сортировок отбора (требование «Сортировки отбора: единый
 * набор…»). Совпадает с серверным `STRUCTURE_SORTS` — конструктор сохраняет
 * только исполнимое; исполнитель принимает всё, что здесь перечислено.
 */
export const FILTER_SORTS: ReadonlyArray<FilterSortOption> = [
  { v: 'alpha', label: 'по названию' },
  { v: 'created', label: 'по дате создания' },
  { v: 'viewed', label: 'по просмотру' },
  { v: 'updated', label: 'по дате изменения' },
];

/** Единый набор направлений сортировки. */
export const FILTER_ORDERS: ReadonlyArray<{ v: SortOrder; label: string }> = [
  { v: 'asc', label: 'возрастание' },
  { v: 'desc', label: 'убывание' },
];

/** True — значение входит в единый набор сортировок конструктора. */
export function isFilterSort(value: unknown): value is StructureSort {
  return typeof value === 'string' && (STRUCTURE_SORTS as readonly string[]).includes(value);
}

/** True — значение входит в единый набор направлений. */
export function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}

/** Подпись сортировки из единого набора. */
export function filterSortLabel(sort: StructureSort): string {
  return FILTER_SORTS.find((o) => o.v === sort)?.label ?? sort;
}

/**
 * Человекочитаемое имя сохранённого значения сортировки — в том числе
 * легаси-значений, которых больше нет в едином наборе (исполнитель
 * показывает его в сообщении о неподдерживаемой сортировке).
 */
export function sortValueLabel(raw: string): string {
  if (isFilterSort(raw)) return filterSortLabel(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// Словарь операторов авторства
// ---------------------------------------------------------------------------

/**
 * Russian labels for the author-op dropdown (задача 59119797).
 * Не используем «содержит»/«не содержит» — у id нет смысла частичного
 * совпадения, поэтому «равен»/«не равен» чище.
 *
 * Единственный экземпляр на весь клиент: панель «Структур», диалог отбора
 * типа, панель «Хроники» и панель «Журнала активности» читают отсюда.
 */
export const AUTHOR_OP_LABELS: Record<StructureAuthorOp, string> = {
  eq: 'равен',
  ne: 'не равен',
  in: 'в списке',
  not_in: 'не в списке',
  empty: 'не заполнено',
  not_empty: 'заполнено',
};

// ---------------------------------------------------------------------------
// Модель состояния отбора
// ---------------------------------------------------------------------------

/** One property condition row (values kept as strings; typed on the wire). */
export interface PropertyConditionState {
  propertyId: string;
  op: StructurePropertyOp;
  values: string[];
}

/** Tri-state UI value of a «Дополнительно» field: `null` — «не важно». */
export type TriState = boolean | null;

/**
 * Единая модель состояния отбора: то, что пользователь набрал в критериях.
 * Панель «Структур» расширяет её своими полями (обход по связям, ширина
 * панели, id сохранённого отбора) — см. `FilterState` в
 * `screens/structures/filter-panel.ts`.
 */
export interface FilterCriteriaState {
  keywords: string;
  /**
   * Where `keywords` searches (§15.3, bug fix 0.5.5): «наименование» /
   * «синонимы» / «комментарий» checkboxes under the keywords field. The
   * builder enforces at least one of «наименование»/«синонимы» checked —
   * unchecking the last one auto-reverts to the default pair.
   */
  keywordInTitle: boolean;
  keywordInSynonyms: boolean;
  keywordInComment: boolean;
  /** Restrict the candidate set to the subtrees of these thoughts (§15.3). */
  parentIds: string[];
  typeIds: string[];
  linkTypeIds: string[];
  properties: PropertyConditionState[];
  hasProperties: TriState;
  hasComment: TriState;
  hasAttachments: TriState;
  hasChronology: TriState;
  /** «Актуальность»: true/false; null — «не важно» (§15.3 «Дополнительно»). */
  active: TriState;
  /** S13: показывать помеченные на удаление (по умолчанию выключено). */
  trashed: boolean;
  /**
   * Задача 59119797 «Фильтры Автор/Редактор»: оператор условия по автору.
   * По умолчанию `eq`. Для `in`/`not_in` используется `authorIds`.
   */
  authorOp: StructureAuthorOp;
  /** Id пользователя-автора для `eq`/`ne` (пустая строка — фильтр не применяется). */
  authorId: string;
  /** Список id для операторов `in`/`not_in` авторства. */
  authorIds: string[];
  /** Оператор условия по редактору (см. `authorOp`). */
  editorOp: StructureAuthorOp;
  /** Id пользователя-редактора для `eq`/`ne`. */
  editorId: string;
  /** Список id редакторов для `in`/`not_in`. */
  editorIds: string[];
  /**
   * Задача 7032e55a «Фильтры по датам создания и изменения»: ISO-8601;
   * пустая строка — граница не выставляется.
   */
  createdAfter: string;
  createdBefore: string;
  updatedAfter: string;
  updatedBefore: string;
  /** Сортировка — из единого набора {@link FILTER_SORTS}. */
  sort: StructureSort;
  order: SortOrder;
  /**
   * Дерево условий редактора (группы И/ИЛИ/НЕ + листья) — модель задачи
   * 6ae062a9, ADR «дерево — развитие одного конструктора». `null`/`undefined` —
   * отбор выражается плоскими полями выше (панели до редактора дерева); задано
   * — проводником служит {@link buildFilterAst}, а не плоский `buildWireFilter`.
   *
   * Поле необязательно на время перехода: `defaultFilterCriteriaState`/
   * `parseFilterDefinition` всегда возвращают его заданным, но плоские панели и
   * их сохранённые отборы дерева не ведут.
   */
  tree?: FilterTreeNode | null;
  /**
   * Многоуровневая сортировка редактора (требование 5ce18fcf: «сортировка —
   * многоуровневая с направлением на ключ»). Пусто/отсутствует — действует пара
   * `sort`/`order` выше.
   */
  sortKeys?: FilterAstSortKey[];
}

/** Default filter state: empty filter → HOME only (§15.3). */
export function defaultFilterCriteriaState(): FilterCriteriaState {
  return {
    keywords: '',
    keywordInTitle: true,
    keywordInSynonyms: true,
    keywordInComment: false,
    parentIds: [],
    typeIds: [],
    linkTypeIds: [],
    properties: [],
    hasProperties: null,
    hasComment: null,
    hasAttachments: null,
    hasChronology: null,
    active: null,
    trashed: false,
    authorOp: 'eq',
    authorId: '',
    authorIds: [],
    editorOp: 'eq',
    editorId: '',
    editorIds: [],
    createdAfter: '',
    createdBefore: '',
    updatedAfter: '',
    updatedBefore: '',
    sort: 'created',
    order: 'asc',
    tree: null,
    sortKeys: [],
  };
}

/**
 * Восстанавливает состояние отбора из wire-определения (сохранённый отбор
 * панели или `definition` отбора типа мысли). Понимает обе формы:
 *
 *   * AST (`{ version, filter, sort? }`) — читается единственным конвертером
 *     {@link parseFilterAstState}: условия ложатся в `tree`/`sortKeys`;
 *   * плоское `definition v1` (историческая форма панелей) — разбирается ниже
 *     по полям; так читаются отборы, записанные до редактора дерева.
 *
 * Незнакомые поля игнорируются; сортировка/направление вне единых наборов
 * заменяются значениями по умолчанию — конструктор не сохраняет то, что
 * исполнитель не исполнит.
 */
export function parseFilterDefinition(def: unknown): FilterCriteriaState {
  const next = defaultFilterCriteriaState();
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return next;
  if (isFilterAstWire(def)) return parseFilterAstState(def);
  const parsed = def as Record<string, unknown>;
  if (typeof parsed['keywords'] === 'string') next.keywords = parsed['keywords'];
  if (Array.isArray(parsed['keyword_scope'])) {
    const scope = new Set<StructureKeywordScope>(parsed['keyword_scope'] as StructureKeywordScope[]);
    next.keywordInTitle = scope.has('title');
    next.keywordInSynonyms = scope.has('synonyms');
    next.keywordInComment = scope.has('comment');
    if (scope.size === 0) {
      next.keywordInTitle = true;
      next.keywordInSynonyms = true;
    }
  }
  if (Array.isArray(parsed['parent_ids'])) next.parentIds = (parsed['parent_ids'] as string[]).slice();
  if (Array.isArray(parsed['type_ids'])) next.typeIds = (parsed['type_ids'] as string[]).slice();
  if (Array.isArray(parsed['link_type_ids'])) next.linkTypeIds = (parsed['link_type_ids'] as string[]).slice();
  if (Array.isArray(parsed['properties'])) {
    next.properties = (parsed['properties'] as Array<Partial<StructurePropertyCondition>>)
      .filter(
        (c): c is StructurePropertyCondition =>
          c !== null &&
          typeof c === 'object' &&
          typeof c.property_id === 'string' &&
          typeof c.op === 'string',
      )
      .map((c) => ({
        propertyId: c.property_id,
        op: c.op,
        values: Array.isArray(c.value) ? c.value.map((v) => String(v)) : [String(c.value)],
      }));
  }
  if (typeof parsed['has_properties'] === 'boolean') next.hasProperties = parsed['has_properties'];
  if (typeof parsed['has_comment'] === 'boolean') next.hasComment = parsed['has_comment'];
  if (typeof parsed['has_attachments'] === 'boolean') next.hasAttachments = parsed['has_attachments'];
  if (typeof parsed['has_chronology'] === 'boolean') next.hasChronology = parsed['has_chronology'];
  if (typeof parsed['active'] === 'boolean') next.active = parsed['active'];
  if (parsed['trashed'] === true) next.trashed = true;
  if (typeof parsed['created_by'] === 'string') {
    next.authorId = parsed['created_by'];
    if (typeof parsed['created_by_op'] === 'string') next.authorOp = parsed['created_by_op'] as StructureAuthorOp;
  } else if (Array.isArray(parsed['created_by'])) {
    next.authorIds = (parsed['created_by'] as string[]).slice();
    next.authorOp = (parsed['created_by_op'] as StructureAuthorOp | undefined) ?? 'in';
  } else if (parsed['created_by_op'] === 'empty' || parsed['created_by_op'] === 'not_empty') {
    // Условие «не заполнено»/«заполнено» едет одним оператором, без значения.
    next.authorOp = parsed['created_by_op'];
  }
  if (typeof parsed['updated_by'] === 'string') {
    next.editorId = parsed['updated_by'];
    if (typeof parsed['updated_by_op'] === 'string') next.editorOp = parsed['updated_by_op'] as StructureAuthorOp;
  } else if (Array.isArray(parsed['updated_by'])) {
    next.editorIds = (parsed['updated_by'] as string[]).slice();
    next.editorOp = (parsed['updated_by_op'] as StructureAuthorOp | undefined) ?? 'in';
  } else if (parsed['updated_by_op'] === 'empty' || parsed['updated_by_op'] === 'not_empty') {
    next.editorOp = parsed['updated_by_op'];
  }
  if (typeof parsed['created_after'] === 'string') next.createdAfter = parsed['created_after'];
  if (typeof parsed['created_before'] === 'string') next.createdBefore = parsed['created_before'];
  if (typeof parsed['updated_after'] === 'string') next.updatedAfter = parsed['updated_after'];
  if (typeof parsed['updated_before'] === 'string') next.updatedBefore = parsed['updated_before'];
  if (isFilterSort(parsed['sort'])) next.sort = parsed['sort'];
  if (isSortOrder(parsed['order'])) next.order = parsed['order'];
  return next;
}

// ---------------------------------------------------------------------------
// Конвертер состояния в wire-формат
// ---------------------------------------------------------------------------

/**
 * Как трёхзначное «Актуальность» ложится в wire: у панели «Структур» и у
 * отбора типа мысли семантика разная (панель фильтрует `active` только при
 * включённой настройке «Показывать неактуальное»; отбор типа выражает «не
 * важно» через `show_inactive`). Сам конвертер один.
 */
export interface WireFilterOptions {
  activeMode: 'structures' | 'view';
  /** Для `activeMode: 'structures'` — настройка «Показывать неактуальное». */
  showInactive?: boolean;
  /**
   * Для `activeMode: 'structures'` — настройка «Показывать содержимое
   * корзины» (задача 77923b49). `false` — критерий «Помечено на удаление» не проходит в
   * wire: помеченные на удаление скрыты, как их прячет сервер в графовых
   * выборках. `undefined` (отбор типа мысли) — критерий едет как раньше.
   */
  showTrash?: boolean;
}

/**
 * Единственный конвертер состояния отбора в wire-определение
 * (`ThoughtTypeViewDefinition` = `SavedFilterDefinition`). Выбрасывает пустые
 * критерии, нормализует область поиска ключевых слов и всегда отдаёт пару
 * `sort`/`order`. Отличия двух применений — только в {@link WireFilterOptions}.
 */
export function buildWireFilter(
  state: FilterCriteriaState,
  registry: ReadonlyMap<string, NetworkProperty>,
  opts: WireFilterOptions,
): ThoughtTypeViewDefinition {
  // `sort`/`order` обязательны в определении; отдаём их всегда.
  const out: ThoughtTypeViewDefinition = { sort: state.sort, order: state.order };
  if (state.keywords.trim() !== '') {
    out.keywords = state.keywords.trim();
    // Default scope = title+synonyms — omit the array to keep the wire lean.
    const scope = buildKeywordScope(state);
    if (scope !== undefined) out.keyword_scope = scope;
  }
  if (state.parentIds.length > 0) out.parent_ids = state.parentIds.slice();
  if (state.typeIds.length > 0) out.type_ids = state.typeIds.slice();
  if (state.linkTypeIds.length > 0) out.link_type_ids = state.linkTypeIds.slice();

  const conditions = buildConditionsWire(state, registry);
  if (conditions.length > 0) out.properties = conditions;

  if (state.hasProperties !== null) out.has_properties = state.hasProperties;
  if (state.hasComment !== null) out.has_comment = state.hasComment;
  if (state.hasAttachments !== null) out.has_attachments = state.hasAttachments;
  if (state.hasChronology !== null) out.has_chronology = state.hasChronology;
  if (opts.activeMode === 'structures') {
    // Панель «Структур»: «актуальность» участвует, только когда неактуальные
    // вообще в кандидатах (§15.3), а `show_inactive` едет рядом с настройкой.
    if (state.active !== null && opts.showInactive === true) out.active = state.active;
    if (opts.showInactive === true) out.show_inactive = true;
  } else {
    // Отбор типа: «не важно» (null) нельзя выразить опусканием `active` —
    // нужен явный `show_inactive` (баг 56fdf252).
    if (state.active === null) {
      out.show_inactive = true;
    } else if (state.active) {
      out.active = true;
    } else {
      out.active = false;
      out.show_inactive = true;
    }
  }
  // S13: marked-for-deletion participates as an independent on/off flag —
  // но в панели «Структур» только когда содержимое корзины вообще доступно
  // (задача 77923b49): при выключенной настройке «Показывать содержимое
  // корзины» критерий не проходит, помеченные скрыты — та же дисциплина, что
  // у `active` с `show_inactive` выше.
  if (state.trashed && opts.showTrash !== false) out.trashed = true;

  // Задача 59119797: оператор + значение (id или массив id).
  // `empty`/`not_empty` несут только оператор: значение не выставляется
  // (иначе выбранное «не заполнено» молча терялось бы — ошибка, найденная
  // тестом единого конвертера, задача 3742dd59).
  const authorWire = buildAuthorWireValue(state.authorOp, state.authorId, state.authorIds);
  if (authorWire !== undefined) out.created_by = authorWire;
  if (
    state.authorOp !== 'eq' &&
    authorFilterActive(state.authorOp, state.authorId, state.authorIds)
  ) {
    out.created_by_op = state.authorOp;
  }
  const editorWire = buildAuthorWireValue(state.editorOp, state.editorId, state.editorIds);
  if (editorWire !== undefined) out.updated_by = editorWire;
  if (
    state.editorOp !== 'eq' &&
    authorFilterActive(state.editorOp, state.editorId, state.editorIds)
  ) {
    out.updated_by_op = state.editorOp;
  }

  // Задача 7032e55a: пустая строка → граница не выставляется.
  if (state.createdAfter.trim() !== '') out.created_after = state.createdAfter.trim();
  if (state.createdBefore.trim() !== '') out.created_before = state.createdBefore.trim();
  if (state.updatedAfter.trim() !== '') out.updated_after = state.updatedAfter.trim();
  if (state.updatedBefore.trim() !== '') out.updated_before = state.updatedBefore.trim();

  return out;
}

/**
 * Wire `keyword_scope` from the state checkboxes (bug fix 0.5.5). Returns
 * `undefined` when it matches the server default (title+synonyms).
 */
export function buildKeywordScope(state: FilterCriteriaState): StructureKeywordScope[] | undefined {
  const scope: StructureKeywordScope[] = [];
  if (state.keywordInTitle) scope.push('title');
  if (state.keywordInSynonyms) scope.push('synonyms');
  if (state.keywordInComment) scope.push('comment');
  if (scope.length === 2 && scope.includes('title') && scope.includes('synonyms')) return undefined;
  return scope;
}

/** Wire property conditions built from the state rows (typed conversion). */
export function buildConditionsWire(
  state: FilterCriteriaState,
  registry: ReadonlyMap<string, NetworkProperty>,
): StructurePropertyCondition[] {
  const out: StructurePropertyCondition[] = [];
  for (const cond of state.properties) {
    const def = registry.get(cond.propertyId);
    if (def === undefined) continue; // property deleted — server skips it too
    // `is_empty` / `not_empty` carry no value at all — emit the condition as
    // soon as the row names a property (§6.10 presence test, bug fix 0.6.3).
    if (cond.op === 'is_empty' || cond.op === 'not_empty') {
      out.push({ property_id: cond.propertyId, op: cond.op, value: '' });
      continue;
    }
    const list = cond.op === 'in' || cond.op === 'not_in';
    const rawValues = list ? cond.values : cond.values.slice(0, 1);
    const values: Array<string | number | boolean> = [];
    for (const raw of rawValues) {
      if (raw === '') continue;
      if (def.value_type === 'number') {
        const num = Number(raw);
        if (!Number.isFinite(num)) continue;
        values.push(num);
      } else if (def.value_type === 'bool') {
        values.push(raw === 'true');
      } else {
        values.push(raw);
      }
    }
    if (values.length === 0) continue; // row not filled in yet
    out.push({ property_id: cond.propertyId, op: cond.op, value: list ? values : values[0]! });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Адресация обеих сторон свойства-связи в условиях отбора
// ---------------------------------------------------------------------------

/**
 * Дополнить реестр свойств ОБРАТНОЙ стороной каждого свойства-связи (задача
 * df992826, доработка по замечаниям приёмки). В реестре у свойства-связи одно
 * имя — сторона, вычисленная при создании/правке свойства из `config.direction`
 * (у `out`/по умолчанию — `name_forward`, у `in` — `name_reverse`); в отборе
 * же адресуемы ОБЕ стороны (сервер, `resolveConditionPropertyRef`, резолвит
 * имя как прямое/обратное имя связи). Поэтому каждая связь РЕЕСТРА (не только
 * цепочка редактируемого типа) даёт в списке имён условий обе записи:
 *
 *   * прямую — прежняя запись по registry id (сохранённые отборы не меняются);
 *   * обратную — синтетическая запись, `id` = имя обратной стороны, а `name` —
 *     ТО ЖЕ чистое имя свойства, без служебных суффиксов.
 *
 * Направление рёбер условия сервер выводит из имени стороны, поэтому `id` и
 * `name` совпадают. Входной реестр не мутируется.
 *
 * Пропускаются: скалярные и структурные свойства («Родители»/«Потомки» уже
 * двусторонние — миграция 039), связи без видимого типа связи, совпадающие
 * имена сторон (в том числе пустые) и имя, уже занятое другой записью — своим
 * id или именем: чужое не подменяем и не предлагаем коллизию, которую сервер
 * отвергнет как неоднозначную.
 */
export function withReverseLinkPropertySides(
  registry: ReadonlyMap<string, NetworkProperty>,
  linkTypes: readonly LinkType[],
): Map<string, NetworkProperty> {
  const out = new Map(registry);
  const byLinkTypeId = new Map(linkTypes.map((lt) => [lt.id, lt] as const));
  // Нормализованные имена, уже занятые записями реестра и добавленными сторонами.
  const usedNameKeys = new Set<string>();
  for (const entry of registry.values()) usedNameKeys.add(typeNameKey(entry.name));
  for (const entry of registry.values()) {
    if (entry.value_type !== 'link') continue;
    const cfg = entry.config ?? {};
    if (cfg.structural === true) continue;
    const linkTypeId = typeof cfg.link_type_id === 'string' ? cfg.link_type_id : '';
    if (linkTypeId === '') continue;
    const lt = byLinkTypeId.get(linkTypeId);
    if (lt === undefined) continue;
    const ownKey = typeNameKey(entry.name);
    const reverseName =
      ownKey === typeNameKey(lt.name_forward)
        ? lt.name_reverse
        : ownKey === typeNameKey(lt.name_reverse)
          ? lt.name_forward
          : null;
    if (reverseName === null) continue;
    const name = reverseName.trim();
    if (name === '') continue;
    const nameKey = typeNameKey(name);
    if (nameKey === ownKey) continue; // совпадающие имена сторон
    if (usedNameKeys.has(nameKey)) continue; // имя занято другой записью
    usedNameKeys.add(nameKey);
    out.set(name, {
      id: name,
      name,
      value_type: 'link',
      config: entry.config ?? null,
      description: null,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Подписи строк: операнд листа (единый словарь для дерева и композера фразы)
// ---------------------------------------------------------------------------

/** Подписи операндов, у которых имени в реестре нет (служебные виды условий). */
export const OPERAND_KIND_LABELS: Readonly<Record<string, string>> = {
  // «Ссылка на мысль по id» — служебная подпись вида условия, просочившаяся в
  // UI; значение пользователь указывает чип-полем мыслей, ID не видит
  // (решение заказчика 2026-10-14, задача a577875b).
  id: 'Мысль',
  type: 'Тип мысли',
  link_type: 'Тип связи',
  parents: 'Родители',
  children: 'Потомки',
  incoming_links: 'Есть входящие связи',
  outgoing_links: 'Есть исходящие связи',
  attachments: 'Есть вложения',
  chronology: 'Есть дневниковые записи',
  comment: 'Есть комментарий',
  active: 'Актуальность',
  trashed: 'Помечено на удаление',
  keywords: 'Найти слова',
  author: 'Автор',
  editor: 'Редактор',
  created_at: 'Дата создания',
  updated_at: 'Дата изменения',
  properties: 'Есть свойства',
  targets: 'Цели записи',
  record_time: 'Период записи',
  record_title: 'Заголовок записи',
  record_body: 'Текст записи',
  record_author: 'Автор записи',
  record_editor: 'Редактор записи',
  occurred_at: 'Время события',
  action: 'Тип действия',
  entity_type: 'Вид сущности',
  entity_title: 'Заголовок сущности',
  entity_id: 'Сущность',
  user: 'Автор события',
  name: 'Имя вложения',
  kind: 'Вид вложения',
  mime_type: 'MIME-подтип',
  owner: 'Владельцы',
  size: 'Размер',
};

/** Данные сети, нужные для подписей строк (дерево отдаёт ту же структуру). */
export interface FilterLabelData {
  /** Реестр свойств сети: id или имя обратной стороны → строка реестра. */
  registry: ReadonlyMap<string, NetworkProperty>;
  /** Типы связей сети — для обратных сторон свойств-связей. */
  linkTypes?: readonly LinkType[];
}

/**
 * Подпись операнда листа: свойство — имя из реестра (или снапшот `labels.entity`),
 * служебный вид условия — словарь {@link OPERAND_KIND_LABELS}. Единый источник
 * подписей для строки дерева (`lib/filter-tree.ts`) и фразы-превью
 * (`lib/filter-phrase.ts`) — словарь не дублируется.
 */
export function filterOperandLabel(leaf: FilterTreeLeaf, data: FilterLabelData): string {
  const entity = leaf.entity;
  if (entity.kind === 'property') {
    const ref = entity.property_id ?? entity.property ?? '';
    const entry = data.registry.get(ref);
    if (entry !== undefined) return entry.name;
    return leaf.labels?.entity ?? ref;
  }
  return OPERAND_KIND_LABELS[entity.kind] ?? leaf.labels?.entity ?? entity.kind;
}

/**
 * Builds the wire value+op for one author filter (задача 59119797).
 * `empty`/`not_empty` carry no value; `in`/`not_in` use the list; the
 * single-id ops use the scalar string.
 */
export function buildAuthorWireValue(
  op: StructureAuthorOp,
  single: string,
  list: string[],
): string | string[] | undefined {
  if (op === 'empty' || op === 'not_empty') return undefined;
  if (op === 'in' || op === 'not_in') {
    if (list.length === 0) return undefined;
    return list;
  }
  if (single === '') return undefined;
  return single;
}

/** True when the author condition carries a value worth applying. */
export function authorFilterActive(op: StructureAuthorOp, single: string, list: string[]): boolean {
  if (op === 'empty' || op === 'not_empty') return true;
  if (op === 'in' || op === 'not_in') return list.length > 0;
  return single !== '';
}

/** True when at least one date bound is filled (задача 7032e55a). */
export function datesActive(s: FilterCriteriaState): boolean {
  return (
    s.createdAfter.trim() !== '' ||
    s.createdBefore.trim() !== '' ||
    s.updatedAfter.trim() !== '' ||
    s.updatedBefore.trim() !== ''
  );
}

/**
 * Есть ли в состоянии хоть одно отличие от дефолта — т.е. задано ли хотя бы
 * одно условие отбора (ошибка e8365d29: запрет сохранения пустого отбора).
 * `sort`/`order` не учитываются — они всегда имеют значение.
 */
export function hasAnyFilterCriteria(state: FilterCriteriaState): boolean {
  return (
    filterTreeHasAnyCriteria(state.tree ?? null) ||
    state.keywords.trim() !== '' ||
    state.parentIds.length > 0 ||
    state.typeIds.length > 0 ||
    state.linkTypeIds.length > 0 ||
    state.properties.length > 0 ||
    state.hasProperties !== null ||
    state.hasComment !== null ||
    state.hasAttachments !== null ||
    state.hasChronology !== null ||
    state.active !== null ||
    state.trashed ||
    state.authorOp !== 'eq' ||
    state.authorId !== '' ||
    state.authorIds.length > 0 ||
    state.editorOp !== 'eq' ||
    state.editorId !== '' ||
    state.editorIds.length > 0 ||
    state.createdAfter !== '' ||
    state.createdBefore !== '' ||
    state.updatedAfter !== '' ||
    state.updatedBefore !== ''
  );
}

// ---------------------------------------------------------------------------
// Строка условия «автор/редактор»
// ---------------------------------------------------------------------------

/** Редакторы значения строки авторства (у каждого применения свои). */
export interface AuthorRowEditors {
  /** Редактор одиночного значения; по умолчанию — виджет выбора пользователя. */
  buildSingle?: (opts: { currentId: string; onChange: (id: string) => void }) => HTMLElement;
  /** Редактор списка; по умолчанию — мульти-виджет выбора пользователей. */
  buildList?: (opts: { currentIds: string[]; onChange: (ids: string[]) => void }) => HTMLElement;
}

/**
 * Строит одну строку условия авторства: «подпись / оператор / значение».
 * Единственная реализация на весь клиент: панель «Структур», диалог отбора
 * типа мысли и панель «Хроники». Состав редакторов значения различается
 * (живой поиск с токенами у диалога, виджеты выбора пользователя у панелей)
 * и передаётся через {@link AuthorRowEditors}.
 */
export function buildAuthorConditionRow(opts: {
  label: string;
  op: StructureAuthorOp;
  singleId: string;
  listIds: string[];
  onOpChange: (op: StructureAuthorOp) => void;
  onSingleChange: (id: string) => void;
  onListChange: (ids: string[]) => void;
  editors?: AuthorRowEditors;
}): HTMLElement {
  const row = div('author-cond-row');
  row.append(el('span', 'author-cond-label', opts.label));
  const opSelect = el('select', 'select-input author-cond-op') as HTMLSelectElement;
  for (const op of STRUCTURE_AUTHOR_OPS) {
    const opt = el('option', '', AUTHOR_OP_LABELS[op]) as HTMLOptionElement;
    opt.value = op;
    opSelect.append(opt);
  }
  opSelect.value = opts.op;
  opSelect.addEventListener('change', () => {
    opts.onOpChange(opSelect.value as StructureAuthorOp);
  });
  row.append(opSelect);

  if (opts.op === 'empty' || opts.op === 'not_empty') {
    row.append(el('span', 'author-cond-hint', 'значение не требуется'));
    return row;
  }
  if (opts.op === 'in' || opts.op === 'not_in') {
    row.append(
      (opts.editors?.buildList ?? buildDefaultAuthorListEditor)({
        currentIds: opts.listIds,
        onChange: opts.onListChange,
      }),
    );
    return row;
  }
  row.append(
    (opts.editors?.buildSingle ?? buildDefaultAuthorSingleEditor)({
      currentId: opts.singleId,
      onChange: opts.onSingleChange,
    }),
  );
  return row;
}

function buildDefaultAuthorSingleEditor(opts: {
  currentId: string;
  onChange: (id: string) => void;
}): HTMLElement {
  return buildUserSelectWidget({
    label: '',
    currentId: opts.currentId,
    onChange: opts.onChange,
  });
}

function buildDefaultAuthorListEditor(opts: {
  currentIds: string[];
  onChange: (ids: string[]) => void;
}): HTMLElement {
  return buildUserMultiSelectWidget({
    label: '',
    currentIds: opts.currentIds,
    onChange: opts.onChange,
  });
}

// ---------------------------------------------------------------------------
// Общие парсеры и клиентский мини-синтаксис ключевых слов
// ---------------------------------------------------------------------------

/** Приводит неизвестное значение оператора авторства к союзу (по умолчанию `eq`). */
export function coerceAuthorOp(value: unknown): StructureAuthorOp {
  return typeof value === 'string' && (STRUCTURE_AUTHOR_OPS as readonly string[]).includes(value)
    ? (value as StructureAuthorOp)
    : 'eq';
}

/** Разобранный мини-синтаксис ключевых слов: обязательные и исключаемые слова. */
export interface ParsedKeywords {
  include: string[];
  exclude: string[];
}

/**
 * Мини-синтаксис ключевых слов (`*` — любые символы, `-слово` — исключение).
 * Единственная реализация на клиент: панель «Событий» применяет её к снимку
 * `entity_title` (у сервера там нет полнотекстового отбора).
 */
export function parseKeywords(raw: string): ParsedKeywords {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const token of raw.split(/\s+/).filter((t) => t !== '')) {
    if (token.startsWith('-') && token.length > 1) exclude.push(token.slice(1));
    else include.push(token);
  }
  return { include, exclude };
}

/** True — текст удовлетворяет разобранному мини-синтаксису ключевых слов. */
export function matchesKeywords(text: string, parsed: ParsedKeywords): boolean {
  const haystack = text.toLowerCase();
  const match = (word: string): boolean => {
    const needle = word.toLowerCase();
    if (!needle.includes('*')) return haystack.includes(needle);
    const parts = needle.split('*').filter((p) => p !== '');
    let from = 0;
    for (const part of parts) {
      const at = haystack.indexOf(part, from);
      if (at === -1) return false;
      from = at + part.length;
    }
    return true;
  };
  for (const word of parsed.include) if (!match(word)) return false;
  for (const word of parsed.exclude) if (match(word)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Отбор «Хроники» (L20): общая модель + её wire-конвертер
// ---------------------------------------------------------------------------

/**
 * Отбор «Дневника»: общая модель критериев + поля записи этого экрана.
 * Собственной модели панель не держит — тип, парсер и конвертер живут здесь,
 * в единственном модуле конструктора (задача 3742dd59).
 *
 * Состав (0.10.1, требование 306f74cc): критерии ЗАПИСИ — `keywords` (текст
 * тела/заголовка записи и мыслевый путь, T7), `keywordIn*`, `dateFrom`/`dateTo`,
 * `order`; критерии ЦЕЛЕЙ — `targets` (набор «Структур», запись проходит, если
 * хотя бы одна привязанная мысль ему удовлетворяет).
 */
export interface ChronicleCriteriaState extends FilterCriteriaState {
  /** Границы периода хроно-комментариев (`YYYY-MM-DD` или токен дат). */
  dateFrom: string;
  dateTo: string;
  /**
   * Режим полей периода панели «Дневника» (0.10.1, приёмка №2): `presets` —
   * границы заданы токенами (пресеты + арифметика), `dates` — точными датами.
   * Хранится в сохранённом отборе (`date_mode`) и восстанавливается при
   * применении; значения раскрываются в момент применения.
   */
  dateMode: 'presets' | 'dates';
  /**
   * Критерии целей записи (0.10.1, требование 306f74cc): тот же набор, что у
   * панели «Структур» (типы, родительские мысли, свойства, дополнительно).
   * Запись проходит отбор, если хотя бы одна её привязанная мысль удовлетворяет
   * этим критериям; группа едет на сервер полем `targets`
   * (`ChronicleFilter.targets`).
   */
  targets: FilterCriteriaState;
}

/** Пустой отбор «Дневника» — все записи сети. */
export function defaultChronicleCriteriaState(): ChronicleCriteriaState {
  return {
    ...defaultFilterCriteriaState(),
    // Область ключевых слов по умолчанию — все три: наименование, синонимы,
    // комментарий (мыслевый путь сохраняет поведение до 0.10.1; путь по телу
    // записи от области не зависит).
    keywordInComment: true,
    dateFrom: '',
    dateTo: '',
    dateMode: 'presets',
    targets: defaultFilterCriteriaState(),
  };
}

/**
 * Читает сохранённое определение отбора «Дневника» (`ChronicleFilterDefinition`,
 * в т.ч. записанное до 0.8.2) в общую модель. Незнакомые поля игнорируются;
 * старые определения читаются теми же ключами. Поля прежних версий
 * (`thought_ids`, `include_subtree`, `link_scope`) не участвуют в новой панели
 * и молча пропускаются.
 */
export function parseChronicleCriteria(def: unknown): ChronicleCriteriaState {
  const next = defaultChronicleCriteriaState();
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return next;
  const parsed = def as Record<string, unknown>;
  const common = parseFilterDefinition(parsed);
  Object.assign(next, common);
  if (typeof parsed['date_from'] === 'string') next.dateFrom = parsed['date_from'];
  if (typeof parsed['date_to'] === 'string') next.dateTo = parsed['date_to'];
  // Режим периода (0.10.1, приёмка №2): старые определения без него читаются
  // как «Пресеты» — границы-токены прежнего поведения.
  if (parsed['date_mode'] === 'dates' || parsed['date_mode'] === 'presets') {
    next.dateMode = parsed['date_mode'];
  }
  // Определение без `keyword_scope` читается как прежнее поведение — поиск по
  // всем областям (тело записи к области не относится).
  if (!Array.isArray(parsed['keyword_scope'])) {
    next.keywordInTitle = true;
    next.keywordInSynonyms = true;
    next.keywordInComment = true;
  }
  // Критерии целей — вложенное определение «Структур» (0.10.1, 306f74cc).
  if (parsed['targets'] !== undefined && parsed['targets'] !== null) {
    next.targets = parseFilterDefinition(parsed['targets']);
  }
  // `parseFilterDefinition` читает только общие границы; у «Дневника» период —
  // свои поля, а `created_after`/`updated_*` в её определении не участвуют.
  next.createdAfter = '';
  next.createdBefore = '';
  next.updatedAfter = '';
  next.updatedBefore = '';
  if (typeof parsed['order'] === 'string' && isSortOrder(parsed['order'])) next.order = parsed['order'];
  return next;
}

/**
 * Конвертер отбора «Дневника» в wire-определение `ChronicleFilterDefinition`.
 * Ключи совпадают с форматом сохранённых отборов — ранее сохранённое
 * читается и перезаписывается без потерь.
 *
 * Критерии записи (`keywords` + область, период, авторство) едут на верхнем
 * уровне; критерии целей — в `targets` (0.10.1, требование 306f74cc).
 */
export function buildChronicleWire(
  state: ChronicleCriteriaState,
  registry: ReadonlyMap<string, NetworkProperty> = new Map(),
): ChronicleFilterDefinition {
  const out: ChronicleFilterDefinition = { order: state.order };
  if (state.keywords.trim() !== '') {
    out.keywords = state.keywords.trim();
    const scope = buildChronicleKeywordScope(state);
    if (scope !== undefined) out.keyword_scope = scope;
  }
  if (state.dateFrom.trim() !== '') out.date_from = state.dateFrom.trim();
  if (state.dateTo.trim() !== '') out.date_to = state.dateTo.trim();
  // Режим периода хранится как есть (0.10.1, приёмка №2); сами значения-токены
  // раскрываются в момент применения отбора (требование 91f8d8dd).
  out.date_mode = state.dateMode;
  // Критерии целей — тот же конвертер «Структур» (0.10.1, 306f74cc):
  // пустая группа не отдаётся, иначе сервер отберёт записи без целей.
  if (hasAnyFilterCriteria(state.targets)) {
    out.targets = buildWireFilter(state.targets, registry, { activeMode: 'structures' });
  }
  Object.assign(out, buildAuthorPair('created_by', state.authorOp, state.authorId, state.authorIds));
  Object.assign(out, buildAuthorPair('updated_by', state.editorOp, state.editorId, state.editorIds));
  return out;
}

/**
 * Область поиска ключевых слов «Дневника»: серверное поведение по умолчанию —
 * все области (наименование, синонимы, комментарий), поэтому `keyword_scope`
 * не отдаётся, когда выбраны все три. Иначе — явный список выбранных областей
 * (в т.ч. пара «наименование+синонимы» сужает поиск — в отличие от панели
 * «Структур», где эта пара сама является серверным значением по умолчанию).
 */
function buildChronicleKeywordScope(
  state: FilterCriteriaState,
): StructureKeywordScope[] | undefined {
  const scope: StructureKeywordScope[] = [];
  if (state.keywordInTitle) scope.push('title');
  if (state.keywordInSynonyms) scope.push('synonyms');
  if (state.keywordInComment) scope.push('comment');
  if (scope.length === 3) return undefined;
  return scope;
}

/** Пара `{ <field>, <field>_op }` одного условия авторства (§59119797). */function buildAuthorPair(
  field: 'created_by' | 'updated_by',
  op: StructureAuthorOp,
  single: string,
  list: string[],
): Partial<ChronicleFilterDefinition> {
  if (op === 'empty' || op === 'not_empty') {
    return { [`${field}_op`]: op } as Partial<ChronicleFilterDefinition>;
  }
  if (op === 'in' || op === 'not_in') {
    if (list.length === 0) return {};
    return { [field]: list, [`${field}_op`]: op } as Partial<ChronicleFilterDefinition>;
  }
  if (single === '') return {};
  return { [field]: single, ...(op !== 'eq' ? { [`${field}_op`]: op } : {}) } as Partial<ChronicleFilterDefinition>;
}

// ---------------------------------------------------------------------------
// Отбор «Событий» (§18): общая модель + её план запроса
// ---------------------------------------------------------------------------

/** Код действия в журнале активности (совпадает с wire-словарём сервера). */
export type ActivityActionFilter = 'created' | 'updated' | 'deleted' | 'trashed' | 'restored';

/** Все коды действий — порядок и состав списка задаёт серверный словарь. */
export const ACTIVITY_ACTION_FILTERS: readonly ActivityActionFilter[] = [
  'created',
  'updated',
  'deleted',
  'trashed',
  'restored',
];

/**
 * Отбор «Событий»: общая модель критериев + поля этого экрана. Период лежит
 * в общих `createdAfter`/`createdBefore` (строки `YYYY-MM-DD`), пользователь —
 * в общих `authorOp`/`authorId`/`authorIds`.
 */
export interface ActivityCriteriaState extends FilterCriteriaState {
  /** Типы сущностей (пусто = любой). */
  entityTypes: ActivityEntityType[];
  /** Коды действий (пусто = любое). */
  actions: ActivityActionFilter[];
}

/** Пустой отбор «Событий» — вся лента. */
export function defaultActivityCriteriaState(): ActivityCriteriaState {
  return { ...defaultFilterCriteriaState(), entityTypes: [], actions: [] };
}

/**
 * Читает сохранённый L4-отбор «Событий» (старый формат `ActivityFilterState`
 * с `fromMs`/`toMs`/`userOp`/`userId`/`userIds` и новый с общими ключами).
 */
export function parseActivityCriteria(raw: unknown): ActivityCriteriaState {
  const next = defaultActivityCriteriaState();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return next;
  const f = raw as Record<string, unknown>;
  // Общие критерии: новый формат читается напрямую, старый — по своим ключам.
  const common = parseFilterDefinition(f);
  Object.assign(next, common);
  if (typeof f['fromMs'] === 'string') next.createdAfter = f['fromMs'];
  if (typeof f['toMs'] === 'string') next.createdBefore = f['toMs'];
  if (typeof f['userOp'] === 'string') next.authorOp = coerceAuthorOp(f['userOp']);
  if (typeof f['userId'] === 'string') next.authorId = f['userId'];
  if (Array.isArray(f['userIds'])) {
    next.authorIds = (f['userIds'] as string[]).filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(f['entityTypes'])) {
    next.entityTypes = (f['entityTypes'] as ActivityEntityType[]).filter(
      (v): v is ActivityEntityType => typeof v === 'string',
    );
  }
  if (Array.isArray(f['actions'])) {
    next.actions = (f['actions'] as ActivityActionFilter[]).filter(
      (v): v is ActivityActionFilter => (ACTIVITY_ACTION_FILTERS as readonly string[]).includes(v),
    );
  }
  return next;
}

/**
 * Общее правило миграции плоского пресета в дерево профиля (задача 16899243,
 * доработка по вердикту верификатора): в дерево проходит ЛИШЬ лист-кандидат,
 * чей операнд видим в профиле точки применения И чей оператор этому операнду
 * в профиле разрешён. Невыразимые условия отбрасываются — ровно тем же
 * способом, каким уже отброшено условие прежнего пресета по снимку
 * `entity_title` (у профиля «события» нет текстового операнда). Общее правило,
 * а не точечная заплатка: любой будущий операнд/оператор вне профиля так же
 * не дойдёт до сервера, а значит прежний сохранённый отбор не породит
 * `VALIDATION_ERROR` (сервер проверяет видимость ДО исполнения —
 * `assertFilterAstInProfile`).
 *
 * Возвращает разбиение кандидатов: `kept` — листья дерева, `dropped` —
 * отброшенные (для диагностики и отчёта о потерях миграции, порядок сохранён).
 */
function splitLeavesByProfile(
  candidates: readonly FilterAstLeaf[],
  profile: FilterProfileId,
): { kept: FilterAstLeaf[]; dropped: FilterAstLeaf[] } {
  const operands = new Set<string>(filterProfileOperands(profile));
  const kept: FilterAstLeaf[] = [];
  const dropped: FilterAstLeaf[] = [];
  for (const leaf of candidates) {
    const kind = leaf.entity.kind;
    const allowed =
      operands.has(kind) && filterProfileOperators(profile, kind).includes(leaf.operator);
    (allowed ? kept : dropped).push(leaf);
  }
  return { kept, dropped };
}

/** Результат сборки AST прежнего пресета «Событий»: тело + отброшенные условия. */
export interface ActivityCriteriaAst {
  /** Тело отбора; `undefined` — критериев не осталось («вся лента»). */
  ast: FilterAst | undefined;
  /** Листья-кандидаты, не выразимые профилем «события» (потеря миграции). */
  dropped: readonly FilterAstLeaf[];
}

/**
 * Компилятор ПЛОСКИХ критериев «Событий» в AST профиля «события» — перевод
 * прежних пресетов ленты (L4-снимок `activity_state`: плоские `fromMs`/`toMs`/
 * `userOp`/`userId`/`userIds`/`entityTypes`/`actions`) в единое дерево редактора
 * (задача 16899243, ADR fc23f9c1). Зеркало серверного `compileActivityToAst`
 * (`server/src/domain/activity-service.ts`) плюс выражения, которых серверный
 * ПЛОСКИЙ API не умел (действие, списки/отрицания пользователя) — теперь они
 * выражаются AST и исполняются общим движком.
 *
 * Соответствие:
 *   * `createdAfter`/`createdBefore` → `occurred_at gte`/`lte` (период ленты
 *     хранился в общих границах дат);
 *   * `authorOp`/`authorId`/`authorIds` → `user eq|in|ne|not_in`; прежние
 *     `empty`/`not_empty` («не заполнено»/«заполнено») профиль «события» автору
 *     НЕ разрешает (требование 1765e659: автор — «равно», «в списке»,
 *     под-выборка), поэтому такое условие отбрасывается общим правилом
 *     {@link splitLeavesByProfile} — как ключевые слова, без `VALIDATION_ERROR`;
 *   * `actions` → `action in [...]`;
 *   * `entityTypes` → `entity_type in [...]`;
 *   * ключевые слова по снимку `entity_title` профилем «события» НЕ выражаются
 *     (у него нет текстового операнда) — лист-кандидат `keywords matches` тоже
 *     отбрасывается тем же правилом (зафиксировано в отчёте задачи).
 * `undefined` — критериев не осталось.
 */
function compileActivityCriteria(state: ActivityCriteriaState): ActivityCriteriaAst {
  const candidates: FilterAstLeaf[] = [];
  if (state.createdAfter.trim() !== '') {
    candidates.push(flatAstLeaf({ kind: 'occurred_at' }, 'gte', state.createdAfter.trim()));
  }
  if (state.createdBefore.trim() !== '') {
    candidates.push(flatAstLeaf({ kind: 'occurred_at' }, 'lte', state.createdBefore.trim()));
  }
  const user = flatAuthorLeaf('user', state.authorOp, state.authorId, state.authorIds);
  if (user !== null) candidates.push(user);
  if (state.actions.length > 0) {
    candidates.push(flatAstLeaf({ kind: 'action' }, 'in', [...state.actions]));
  }
  if (state.entityTypes.length > 0) {
    candidates.push(flatAstLeaf({ kind: 'entity_type' }, 'in', [...state.entityTypes]));
  }
  const keywords = flatKeywordLeaf(state);
  if (keywords !== null) candidates.push(keywords);

  const { kept, dropped } = splitLeavesByProfile(candidates, 'events');
  if (kept.length === 0) return { ast: undefined, dropped };
  return {
    ast: {
      version: FILTER_AST_VERSION,
      filter: kept.length === 1 ? kept[0]! : ({ op: 'and', children: kept } as FilterAstGroup),
    },
    dropped,
  };
}

/**
 * Перевести прежний плоский пресет «Событий» в тело AST профиля «события»
 * (задача 16899243). Невыразимые профилем условия отбрасываются (см.
 * {@link splitLeavesByProfile}); подробности потерь — у
 * {@link compileActivityCriteriaToAstDetailed}. `undefined` — критериев нет.
 */
export function compileActivityCriteriaToAst(state: ActivityCriteriaState): FilterAst | undefined {
  return compileActivityCriteria(state).ast;
}

/**
 * Как {@link compileActivityCriteriaToAst}, но отдаёт ещё и перечень
 * отброшенных профилем условий — для диагностики и отчёта о потерях миграции
 * (лента «События» показывает потерю мягко: отбор исполняется без нарушений).
 */
export function compileActivityCriteriaToAstDetailed(
  state: ActivityCriteriaState,
): ActivityCriteriaAst {
  return compileActivityCriteria(state);
}

/**
 * Прочитать сохранённый отбор «Событий» в единую модель с ЗАПОЛНЕННЫМ деревом:
 * AST-снимок читается единым читателем ({@link parseFilterDefinitionTree}), а
 * плоский прежний снимок (`activity_state` старого формата) компилируется в
 * дерево ({@link compileActivityCriteriaToAst}). Второй точки чтения нет.
 */
export function parseActivityCriteriaTree(raw: unknown): FilterCriteriaState {
  return parseActivityCriteriaTreeDetailed(raw).state;
}

/**
 * Как {@link parseActivityCriteriaTree}, но отдаёт ещё и условия прежнего
 * плоского пресета, отброшенные при миграции профилем «события» (см.
 * {@link splitLeavesByProfile}) — экран показывает их жёлтой диагностикой, чтобы
 * потеря была видна пользователю, а не молчала. У AST-снимка потерь нет.
 */
export function parseActivityCriteriaTreeDetailed(raw: unknown): {
  state: FilterCriteriaState;
  dropped: readonly FilterAstLeaf[];
} {
  if (isFilterAstWire(raw)) return { state: parseFilterDefinitionTree(raw), dropped: [] };
  const state = parseActivityCriteria(raw);
  const { ast, dropped } = compileActivityCriteria(state);
  const tree = ast === undefined ? null : filterAstToTree(ast.filter);
  state.tree = tree ?? defaultFilterTreeGroup('and');
  return { state, dropped };
}

// ---------------------------------------------------------------------------
// Настройки отбора строки поиска карты (§3.2): общая модель + её wire
// ---------------------------------------------------------------------------

/**
 * Отбор строки поиска карты: общая модель критериев + поля этого экрана.
 *
 * МЫСЛЕВЫЕ настройки — подкорень, типы мыслей, «показывать неактуальные»,
 * «корзина» — выражаются ДЕРЕВОМ единого редактора (`tree`, профиль
 * `thoughts`; требование db84b5e1/«Поиск карты: настройки отбора компилируются
 * в общий AST…», ADR 7581ac14) и уходят на сервер телом `ast`. КОРПУСНЫЕ
 * настройки полнотекстового поиска остаются плоскими: области поиска
 * (`onlyThoughts`/`onlyLinks`/`onlyChrono` → `scope`), тип связи
 * (`linkTypeIds` → `link_type_id`), автор/редактор (`authorId`/`editorId`) —
 * они фильтруют ХИТЫ FTS, а не мысль, и в AST не компилируются.
 */
export interface SearchCriteriaState extends FilterCriteriaState {
  onlyThoughts: boolean;
  onlyLinks: boolean;
  onlyChrono: boolean;
}

/**
 * Дерево мыслевых настроек поиска по умолчанию: только актуальные и без
 * корзины — прежние дефолты плоских флагов `showInactive=false`/`trashed=false`
 * (сервер при явном `ast` дефолтов видимости НЕ добавляет — они обязаны быть в
 * дереве; требование b91336e7).
 */
function defaultSearchVisibilityTree(): FilterTreeNode {
  return {
    kind: 'group',
    op: 'and',
    children: [
      { kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } },
      { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } },
    ],
  };
}

/** Пустые настройки поиска (мыслевые настройки — дерево видимости). */
export function defaultSearchCriteriaState(): SearchCriteriaState {
  return {
    ...defaultFilterCriteriaState(),
    onlyThoughts: false,
    onlyLinks: false,
    onlyChrono: false,
    tree: defaultSearchVisibilityTree(),
  };
}

/** Признак плоского (прежнего) снимка: в нём есть хоть один мыслевой ключ. */
function hasLegacySearchThoughtKeys(o: Record<string, unknown>): boolean {
  return (
    o['subtree'] === true ||
    Array.isArray(o['subrootIds']) ||
    typeof o['subrootId'] === 'string' ||
    Array.isArray(o['typeIds']) ||
    o['showInactive'] === true ||
    o['trashed'] === true
  );
}

/**
 * Перенести ПРЕЖНИЙ плоский снимок мыслевых настроек поиска в дерево редактора
 * (профиль `thoughts`): `showInactive`/`trashed` → строки видимости,
 * `typeIds` → строка «Тип в иерархии», `subtree`+`subrootIds` → строка
 * «Родители в иерархии» (подкорень; корень добавит {@link buildSearchAst}).
 * Одиночный `subrootId` прошлых версий читается набором из одной мысли.
 *
 * Строка подкорня ставится при `subtree === true` и ПУСТОМ наборе корней — со
 * значением `none`: ограничение подкорня включено, мысль не выбрана. Так
 * сохраняется прежнее поведение «текущий фокус по умолчанию»
 * ({@link expandSearchSubtreeRoots} подставит `focusId`). Пропуск строки молча
 * РАСШИРИЛ бы выдачу до всего дерева — ошибка, найденная при проверке.
 */
function legacySearchThoughtTree(o: Record<string, unknown>): FilterTreeNode {
  const children: FilterTreeNode[] = [];
  if (o['showInactive'] !== true) {
    children.push({ kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } });
  }
  if (o['trashed'] !== true) {
    children.push({ kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } });
  }
  const typeIds = Array.isArray(o['typeIds'])
    ? (o['typeIds'] as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
    : [];
  if (typeIds.length > 0) {
    children.push({
      kind: 'leaf',
      entity: { kind: 'type' },
      operator: 'in_hierarchy',
      value: { kind: 'list', items: [...typeIds] },
    });
  }
  const subroots = Array.isArray(o['subrootIds'])
    ? (o['subrootIds'] as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
    : typeof o['subrootId'] === 'string' && o['subrootId'] !== ''
      ? [o['subrootId']]
      : [];
  if (o['subtree'] === true) {
    children.push({
      kind: 'leaf',
      entity: { kind: 'parents' },
      operator: 'in_hierarchy',
      mode: 'all_links',
      value: subroots.length > 0 ? { kind: 'list', items: [...subroots] } : { kind: 'none' },
    });
  }
  return { kind: 'group', op: 'and', children };
}

/**
 * Читает сохранённые настройки поиска (`search_state`): корпусные ключи —
 * прежними плоскими (`onlyThoughts`/`onlyLinks`/`onlyChrono`, `linkTypeIds`,
 * `authorId`, `editorId`); мыслевые — из нового AST-снимка (`ast`) либо, для
 * записей прежних версий, миграцией плоских ключей в дерево
 * ({@link legacySearchThoughtTree}). Сеть без своей записи получает дефолт.
 */
export function parseSearchCriteria(raw: unknown): SearchCriteriaState {
  const next = defaultSearchCriteriaState();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return next;
  const o = raw as Record<string, unknown>;
  if (o['onlyThoughts'] === true) next.onlyThoughts = true;
  if (o['onlyLinks'] === true) next.onlyLinks = true;
  if (o['onlyChrono'] === true) next.onlyChrono = true;
  if (Array.isArray(o['linkTypeIds'])) next.linkTypeIds = (o['linkTypeIds'] as string[]).slice();
  if (typeof o['authorId'] === 'string') next.authorId = o['authorId'];
  if (typeof o['editorId'] === 'string') next.editorId = o['editorId'];
  if (isFilterAstWire(o['ast'])) {
    const parsed = parseFilterAstState(o['ast'], {});
    next.tree = parsed.tree ?? defaultFilterTreeGroup('and');
  } else if (hasLegacySearchThoughtKeys(o)) {
    next.tree = legacySearchThoughtTree(o);
  }
  return next;
}

/**
 * Собрать AST МЫСЛЕВЫХ настроек строки поиска карты из дерева редактора
 * (профиль `thoughts`). Строка «Родители в иерархии» (подкорень) расширяется
 * до «ИЛИ(id в [корни], `parents` in_hierarchy [корни] режим `all_links`)» —
 * так в подкорень входит САМ корень (паритет с прежним `from_thought_id`;
 * лист `parents`+`in_hierarchy` матчит только потомков; требование b91336e7,
 * ADR 7581ac14). Пустое значение строки подкорня при заданном `focusId` —
 * прежнее поведение «ограничение включено, мысль не выбрана → текущий фокус».
 *
 * `undefined` — мыслевых условий нет (пустое дерево): вызывающий не передаёт
 * `ast`, и сервер применяет дефолты видимости сам.
 */
export function buildSearchAst(state: FilterCriteriaState, focusId: string | null): FilterAst | undefined {
  const tree = state.tree ?? null;
  if (!filterTreeHasAnyCriteria(tree)) return undefined;
  const expanded = expandSearchSubtreeRoots(tree as FilterTreeNode, focusId);
  // `null` — все строки выпали (единственная строка — пустой подкорень без
  // ограничения и без фокуса): мыслевых условий НЕ осталось, `ast` не отдаём,
  // сервер применит дефолты видимости (ошибка 46047836). Раньше здесь был
  // фолбэк `?? tree`, возвращавший исходное дерево и сохранявший баг.
  if (expanded === null || !filterTreeHasAnyCriteria(expanded)) return undefined;
  return {
    version: FILTER_AST_VERSION,
    filter: filterTreeToAst(expanded),
  };
}

/**
 * Расширить строки-подкорни («Родители в иерархии») до «ИЛИ(id в [корни],
 * parents in_hierarchy [корни] режим `all_links`)». Значение-скаляр читается
 * как корень из одной мысли; пустой список при `focusId` берёт текущий фокус.
 *
 * Пустой набор корней И отсутствие фокуса — СТРОКА НЕ СОЗДАЁТСЯ (`null`):
 * ограничение подкорня не задано → поиск идёт «без ограничения» (ошибка
 * 46047836). Иначе лист `parents in_hierarchy` без значения сервер трактует как
 * `AST_FALSE` и выдача сужается до нуля.
 */
function expandSearchSubtreeRoots(node: FilterTreeNode, focusId: string | null): FilterTreeNode | null {
  if (node.kind === 'group') {
    const children = node.children
      .map((c) => expandSearchSubtreeRoots(c, focusId))
      .filter((c): c is FilterTreeNode => c !== null);
    // Группа, чьи дети были и все выпали (строка-подкорень без ограничения), не
    // нужна; изначально пустая группа остаётся (её диагностирует конструктор).
    if (node.children.length > 0 && children.length === 0) return null;
    return { ...node, children };
  }
  if (node.entity.kind !== 'parents' || node.operator !== 'in_hierarchy') return node;
  const items =
    node.value.kind === 'list'
      ? node.value.items
      : node.value.kind === 'scalar'
        ? [node.value.value]
        : [];
  const ids = items.filter((it): it is string => typeof it === 'string' && it !== '');
  const roots = ids.length > 0 ? ids : focusId !== null ? [focusId] : [];
  // Нет корней и нет фокуса — ограничение не задано: строку не создаём.
  if (roots.length === 0) return null;
  return {
    kind: 'group',
    op: 'or',
    children: [
      { kind: 'leaf', entity: { kind: 'id' }, operator: 'in', value: { kind: 'list', items: [...roots] } },
      {
        kind: 'leaf',
        entity: { kind: 'parents' },
        operator: 'in_hierarchy',
        mode: 'all_links',
        value: { kind: 'list', items: [...roots] },
      },
    ],
  };
}

/**
 * Часть параметров серверного поиска, вырастающая из КОРПУСНЫХ настроек
 * строки поиска: тип связи и автор/редактор (фильтруют ХИТЫ FTS, а не мысль).
 * Мыслевые настройки уходят в `ast` ({@link buildSearchAst}), НЕ в плоские
 * параметры (требование b91336e7: `ast` XOR плоские мыслевые параметры).
 */
export interface SearchCriteriaWire {
  link_type_id?: string[];
  author_id?: string;
  editor_id?: string;
}

/** Конвертер корпусных настроек поиска в параметры запроса (без `q`/`scope`). */
export function buildSearchCriteriaWire(state: SearchCriteriaState): SearchCriteriaWire {
  const out: SearchCriteriaWire = {};
  if (state.linkTypeIds.length > 0) out.link_type_id = state.linkTypeIds.slice();
  if (state.authorId.trim() !== '') out.author_id = state.authorId;
  if (state.editorId.trim() !== '') out.editor_id = state.editorId;
  return out;
}

/**
 * Снять с модели корпусные поля, которых БОЛЬШЕ НЕТ на панели поиска: тип связи
 * (`linkTypeIds`), автор/редактор (`authorId`/`editorId`). Панель отдаёт их
 * плоскими параметрами запроса и невидимо фильтрует ХИТЫ, поэтому снятый с UI
 * корпусный фильтр нельзя оставлять в состоянии: иначе старый L4-снимок
 * (`search_state`) вернул бы НЕВИДИМЫЙ фильтр — поля на панели нет, а параметр
 * уезжает в запрос (класс ошибок ca864656/32fd6125). Вызывается при сборке зоны
 * настроек (в т.ч. после `parseSearchCriteria`), так что очищенные поля не
 * попадают ни в `buildSearchCriteriaWire`, ни в сохраняемый снимок.
 */
export function clearSearchCorpusFields(state: SearchCriteriaState): void {
  state.linkTypeIds = [];
  state.authorId = '';
  state.editorId = '';
}

/**
 * Конвертер настроек поиска в сохраняемый L4-набор `search_state`: корпусные
 * ключи — прежними плоскими именами, мыслевые — AST-снимком дерева (`ast`).
 * Запись читается тем же {@link parseSearchCriteria} без потерь; снимок
 * прежних версий (без `ast`) мигрирует плоские мыслевые ключи в дерево.
 */
export function searchCriteriaToStored(state: SearchCriteriaState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    onlyThoughts: state.onlyThoughts,
    onlyLinks: state.onlyLinks,
    onlyChrono: state.onlyChrono,
    linkTypeIds: state.linkTypeIds.slice(),
    authorId: state.authorId,
    editorId: state.editorId,
  };
  const tree = state.tree ?? null;
  if (filterTreeHasAnyCriteria(tree)) {
    out['ast'] = { version: FILTER_AST_VERSION, filter: filterTreeToAst(tree as FilterTreeNode) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Быстрые команды отбора строки поиска карты («Добавить отбор…», задача
// 4b1cc3d4): заранее заданные условия основной (корневой) группы. Условия и
// идемпотентное добавление объявлены ЧИСТОЙ моделью здесь, а не в разметке:
// повторный клик, уже имеющееся условие и разный режим связей проверяются
// юнит-тестами без DOM.
// ---------------------------------------------------------------------------

/** Команды отбора строки поиска — каждая строит лист дерева (профиль `thoughts`). */
export interface SearchQuickConditions {
  /**
   * «По родителю в фокусе»: мысль в иерархии мысли-фокуса карты. Значение —
   * литерал-токен `$thought`: сервер подставляет мысль-фокус запроса поиска
   * (`focus_thought_id`), без него токен неразрешим — штатная диагностика
   * неразрешённого токена (`unresolved`), а не тихая пустота.
   */
  parentInFocus: () => FilterTreeLeaf;
  /** «Только актуальные»: актуальность равна «да». */
  onlyActive: () => FilterTreeLeaf;
  /** «Только не помеченные»: пометка удаления равна «нет». */
  onlyNotTrashed: () => FilterTreeLeaf;
}

/** Условия быстрых команд строки поиска (задача 4b1cc3d4). */
export const SEARCH_QUICK_CONDITIONS: SearchQuickConditions = {
  parentInFocus: () => ({
    kind: 'leaf',
    entity: { kind: 'id' },
    operator: 'in_hierarchy',
    value: { kind: 'token', token: '$thought' },
  }),
  onlyActive: () => ({
    kind: 'leaf',
    entity: { kind: 'active' },
    operator: 'eq',
    value: { kind: 'scalar', value: true },
  }),
  onlyNotTrashed: () => ({
    kind: 'leaf',
    entity: { kind: 'trashed' },
    operator: 'eq',
    value: { kind: 'scalar', value: false },
  }),
};

/**
 * Канонический вид значения для ЛИТЕРАЛЬНОГО сравнения: ключи каждого объекта
 * сортируются, поэтому порядок ключей (модель ↔ прочитанный AST) на совпадение
 * не влияет.
 */
function canonicalFilterValue(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[key] = (val as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return val;
  });
}

/**
 * Литеральное совпадение двух условий дерева: операнд, оператор, значение и
 * РЕЖИМ обхода «в иерархии» (структурный ↔ «по всем связям» — разные условия,
 * задача 4b1cc3d4). Токен `$thought` сравнивается как литерал.
 */
export function filterTreeLeavesEqual(a: FilterTreeLeaf, b: FilterTreeLeaf): boolean {
  if (a.operator !== b.operator) return false;
  if ((a.mode ?? 'structural') !== (b.mode ?? 'structural')) return false;
  if (canonicalFilterValue(a.entity) !== canonicalFilterValue(b.entity)) return false;
  return canonicalFilterValue(a.value) === canonicalFilterValue(b.value);
}

/** Есть ли в поддереве условие, литерально равное заданному. */
function filterTreeContainsLeaf(node: FilterTreeNode, leaf: FilterTreeLeaf): boolean {
  if (node.kind === 'leaf') return filterTreeLeavesEqual(node, leaf);
  return node.children.some((child) => filterTreeContainsLeaf(child, leaf));
}

/**
 * Добавить условие быстрой команды в ОСНОВНУЮ (корневую) группу отбора
 * строки поиска. Идемпотентно: если такое условие уже есть в поддереве
 * корневой группы (литеральное совпадение операнда, оператора, значения и
 * режима), дерево не меняется (`added: false`) — повторный клик не плодит
 * дубли. Корень не группа (одиночный лист) — он оборачивается группой `И`
 * (`normalizeFilterTreeRoot`), корень всегда остаётся группой.
 */
export function addSearchQuickCondition(
  tree: FilterTreeNode | null,
  leaf: FilterTreeLeaf,
): { tree: FilterTreeGroup; added: boolean } {
  const root = tree === null ? defaultFilterTreeGroup('and') : normalizeFilterTreeRoot(tree);
  if (filterTreeContainsLeaf(root, leaf)) return { tree: root, added: false };
  return { tree: { ...root, children: [...root.children, leaf] }, added: true };
}

// ---------------------------------------------------------------------------
// Модель дерева отбора и её конвертер в wire-AST
// (требование 5ce18fcf «Редактор выражает всё ядро AST одной моделью
// состояния», ADR 30ff83bb «дерево — развитие одного конструктора»;
// задача 6ae062a9, версия 0.13.1)
// ---------------------------------------------------------------------------

/**
 * Операнд листа дерева — левый операнд «Что» в объёме wire-модели
 * (`FilterAstEntity`: вид + адрес свойства/область ключевых слов/направление).
 * Модель хранит его как есть, чтобы любой узел ядра AST выражался без потерь.
 */
export type FilterTreeOperand = FilterAstEntity;

/** Значение-токен редактора: `$today`, `$weekStart-1d`, `$thought.[Свойство]`. */
export interface FilterTreeTokenValue {
  token: string;
}

/** Элемент списка значений: скаляр или токен (границы «между», наборы id). */
export type FilterTreeListItem = FilterAstScalar | FilterTreeTokenValue;

/** Оператор значения-подвыборки (совпадает с wire `FilterAstSubqueryValue`). */
export type FilterTreeSubqueryOperator = FilterAstSubqueryValue['operator'];

/**
 * Значение условия-листа. Вид задан дискриминантом: в wire одиночный литерал и
 * список из одного элемента неотличимы (`"a"` против `["a"]`), а «нет значения»
 * выражается отсутствием поля — модель хранит выбор пользователя явно, поэтому
 * `модель → AST → модель` не теряет ни список, ни пустое значение.
 */
export type FilterTreeValue =
  /** Значение не требуется (`is_empty`/`not_empty` и т.п.). */
  | { kind: 'none' }
  /** Одиночный литерал (строка/число/дата/bool). */
  | { kind: 'scalar'; value: FilterAstScalar }
  /** Список литералов и/или токенов. */
  | { kind: 'list'; items: FilterTreeListItem[] }
  /** Единственный токен. */
  | { kind: 'token'; token: string }
  /** Под-выборка: полноценное под-дерево AST + её оператор. */
  | { kind: 'subquery'; operator: FilterTreeSubqueryOperator; node: FilterTreeNode };

/** Условие-лист дерева: `[Что][Оператор][Значение]` + снапшоты подписей. */
export interface FilterTreeLeaf {
  kind: 'leaf';
  entity: FilterTreeOperand;
  operator: FilterAstOperator;
  value: FilterTreeValue;
  /** Снапшоты подписей на момент сохранения (диагностика удалённой сущности). */
  labels?: FilterAstLabels;
  /** Режим обхода «в иерархии» (`structural` по умолчанию). */
  mode?: FilterAstHierarchyMode;
  /**
   * Служебный лист МЕСТА применения (wire `FilterAstLeaf.service`): впечён
   * редактором при сохранении, а не набран пользователем (дефолт «Помечено на
   * удаление = нет» у отбора типа мысли). Читатель AST снимает помеченные
   * листья с КОРНЯ — в редакторе они не показываются условиями и не
   * удовлетворяют запрету пустого отбора (ошибка 9ddc488e). Исполнение отбора
   * учитывает лист как обычное условие.
   */
  service?: true;
}

/** Группа дерева: `И`/`ИЛИ` (один и более детей) / `НЕ` (ровно один ребёнок). */
export interface FilterTreeGroup {
  kind: 'group';
  op: FilterAstGroupOp;
  children: FilterTreeNode[];
}

/** Узел дерева отбора: группа или условие-лист. Глубина не ограничена. */
export type FilterTreeNode = FilterTreeGroup | FilterTreeLeaf;

/** Замечание редактора к узлу дерева (проверка по профилю контекста). */
export interface FilterTreeIssue {
  /** Путь узла от корня: `filter.children[0].children[1]`. */
  path: string;
  message: string;
}

/** Опции сборки/чтения AST: профиль контекста точки применения. */
export interface FilterAstProfileOptions {
  /**
   * Профиль контекста (реестр `@etn/shared`): по нему проверяется состав
   * операндов и операторов дерева. Не задан — проверок нет (чистая сборка).
   */
  profile?: FilterProfileId;
  /** Бросить `Error` при нарушении профиля (иначе вернуть/собрать как есть). */
  strict?: boolean;
  /**
   * Включать сортировку в wire (по умолчанию да). `false` — у места нет грани
   * «сортировка»: порядок строк задаёт сервер (лента «События» — `occurred_at_ms
   * DESC`), и дефолтная пара `sort`/`order` не должна попадать в тело отбора.
   */
  sort?: boolean;
}

/**
 * Соответствие кодов ключей AST сортировкам панели (`FILTER_SORTS`). Обратное
 * соответствие нужно, чтобы сохранённый AST-отбор открывался плоскими панелями
 * с осмысленной сортировкой. У `viewed` ключа в AST нет (движок знает
 * `title`/`alpha`, `created_at`/`created` и `updated_at`/`updated`) — плоская
 * сортировка «по просмотру» в AST не выражается.
 */
const FILTER_SORT_TO_AST_KEY: Partial<Record<StructureSort, string>> = {
  alpha: 'title',
  created: 'created_at',
  updated: 'updated_at',
};

const AST_KEY_TO_FILTER_SORT: Readonly<Record<string, StructureSort>> = {
  title: 'alpha',
  alpha: 'alpha',
  created_at: 'created',
  created: 'created',
  updated_at: 'updated',
  updated: 'updated',
};

/**
 * Плоская сортировка панели по коду ключа AST; `null` — ключ плоской парой
 * `sort`/`order` НЕ выражается (ключ-свойство, имя стороны свойства-связи,
 * «по просмотру»). Единственная точка этого соответствия
 * ({@link AST_KEY_TO_FILTER_SORT}) для мест применения: по ней панель решает,
 * несёт ли отбор сортировку плоской парой или её обязан нести `ast.sort` —
 * иначе ключ пользователя молча терялся бы при единственном ключе (ошибка
 * ca864656).
 */
export function filterSortFromAstKey(key: string): StructureSort | null {
  if (!Object.prototype.hasOwnProperty.call(AST_KEY_TO_FILTER_SORT, key)) return null;
  return AST_KEY_TO_FILTER_SORT[key] ?? null;
}

/** Пустая группа дерева (по умолчанию `И`) — корень нового отбора. */
export function defaultFilterTreeGroup(op: FilterAstGroupOp = 'and'): FilterTreeGroup {
  return { kind: 'group', op, children: [] };
}

/**
 * Корень модели отбора — всегда ГРУППА: одиночный лист оборачивается в группу
 * `И`. Сохранённое определение с РОВНО ОДНИМ условием даёт в AST лист-фильтр
 * (`filter` без `op`); читатель отдаёт его как корень дерева, а каркас редактора
 * работает только с корнем-группой — без обёртки такое условие молча пропадало
 * (например, легаси-рецепт `{trashed: true, keywords: '…'}`: дефолтный лист
 * «только непомеченные» не добавляется, остается один лист слов).
 */
export function normalizeFilterTreeRoot(node: FilterTreeNode): FilterTreeGroup {
  return node.kind === 'group' ? node : { kind: 'group', op: 'and', children: [node] };
}

/**
 * Лист ровно служебного дефолта места «Помечено на удаление = нет» (`trashed eq false`):
 * так помеченные на удаление скрыты, пока пользователь не решил про них сам.
 * Компилятор плоской формы добавляет этот лист, когда определения его не
 * задавало, — в модели редактирования он условием не показывается; та же проба и
 * та же дисциплина, что у места «Отбор типа мысли» (`stripViewDefaults`,
 * ADR 30ff83bb). Проба описывает только ФОРМУ листа: решение «это дефолт МЕСТА, а
 * не пользователя» принимает место применения (читатель определения снимает
 * такой лист лишь с КОРНЯ одиночным — лист рядом с настоящими условиями в группе
 * остаётся, иначе определение расширилось бы молча: в AST неявных дефолтов нет —
 * `query-service`, поле `ast`).
 *
 * `options.unmarked` — требовать ОТСУТСТВИЕ метки `service: true`: такую форму
 * дописывает компилятор плоской формы, и её снимает плоский путь чтения
 * (`stripViewDefaults`, отбор типа мысли). Помеченный лист AST снимает общий
 * читатель (`stripServiceLeavesAtRoot`), непомеченный AST-лист — условие
 * пользователя (ошибка 9ddc488e). Один предикат на оба случая — близнецы
 * `isServiceTrashedDefaultLeaf`/`isTrashedDefaultLeaf` с разным поведением
 * удалены как ловушка переиспользования (задача d3a30c3e).
 */
export function isTrashedDefaultLeaf(
  node: FilterTreeNode,
  options: { unmarked?: boolean } = {},
): boolean {
  const shape =
    node.kind === 'leaf' &&
    node.entity.kind === 'trashed' &&
    node.operator === 'eq' &&
    node.value.kind === 'scalar' &&
    node.value.value === false &&
    node.mode === undefined;
  if (!shape) return false;
  return options.unmarked !== true || node.service === undefined;
}

/**
 * Снять с КОРНЕВОГО уровня дерева листья, помеченные местом применения как
 * служебные (`service: true`, wire `FilterAstLeaf.service`): это дефолт МЕСТА,
 * а не условие пользователя — в редакторе он строкой не показывается и не
 * должен удовлетворять запрету пустого отбора (ошибка 9ddc488e). Метку ставит
 * место применения при СОХРАНЕНИИ (у отбора типа мысли — `withViewDefaults`),
 * поэтому порядок «впечь → сохранить → переоткрыть» служебную строку не
 * показывает. Лист, вложенный в группу, не трогаем: пользователь собрал его
 * осознанно, а метку туда никто не ставит. Метка — единственный признак:
 * непомеченный лист «Помечено на удаление = нет» остаётся условием пользователя
 * ({@link isTrashedDefaultLeaf} с `unmarked: true` описывает такую ФОРМУ и
 * применяется исключительно к плоскому пути чтения).
 *
 * Вместе с листом снимается и ОБЁРТКА места: при корне пользователя не-«И»
 * `withViewDefaults` печатает `(корень) И живые`, и после снятия листа группа
 * «И» с единственным ребёнком-группой разворачивается обратно — редактор
 * показывает исходный корень «ИЛИ»/«НЕ», а не лишний уровень (ошибка a65d27d9).
 *
 * Разворачивается ТОЛЬКО обёртка — группа «И» ровно из двух детей
 * `[группа, служебный лист]`, и лист стоит ВТОРЫМ (так его печатает
 * `withViewDefaults`: `children: [корень, лист]`). Группу «И» с единственной
 * подгруппой, но без служебного листа на втором месте НЕ разворачиваем:
 * пользователь выбрал корень «И» осознанно, и показывать ему «ИЛИ» подгруппы
 * нельзя (ошибка ff11075a). Запись «И»-корня с единственной подгруппой
 * `withViewDefaults` поэтому оборачивает (см. `filter-dialog-pure.ts`) — иначе
 * обёртка и пользовательский корень неотличимы.
 */
export function stripServiceLeavesAtRoot(tree: FilterTreeNode): FilterTreeNode {
  if (tree.kind !== 'group') return tree;
  const children = tree.children.filter(
    (child) => !(child.kind === 'leaf' && child.service === true),
  );
  if (children.length === tree.children.length) return tree;
  // Обёртка места применения: `(корень пользователя) И живые` (ошибка
  // a65d27d9). Форма обёртки строгая — ровно два ребёнка, служебный лист
  // вторым; любая другая группа со служебным листом остаётся группой «И» со
  // снятым листом (ошибка ff11075a).
  const [first, second] = tree.children;
  const isWrapper =
    tree.op === 'and' &&
    tree.children.length === 2 &&
    first!.kind === 'group' &&
    second!.kind === 'leaf' &&
    second!.service === true;
  if (isWrapper) return first!;
  return { ...tree, children };
}

/**
 * Пустой лист дерева по операнду — заготовка строки `[Что][Оператор][Значение]`.
 * Оператор по умолчанию — `eq`; редактор подменяет его первым допустимым в
 * профиле ({@link filterProfileOperators}).
 */
export function defaultFilterTreeLeaf(entity: FilterTreeOperand): FilterTreeLeaf {
  return { kind: 'leaf', entity, operator: 'eq', value: { kind: 'none' } };
}

/**
 * НЕЯВНОЕ значение листа, которое виджет показывает, но в модели не пишет
 * (ошибка 609deba0 п.3). Булевы предикаты «Актуальность»/«Помечено на удаление»
 * рисуются триадой «да/нет» с видимым по умолчанию «да»: значение обязано
 * попасть в модель, иначе проверка «условие без значения» продолжала бы
 * подсвечивать строку, хотя пользователь видит «= да» (и AST ушёл бы без
 * значения). `null` — у листа неявного значения нет.
 *
 * {@link buildFilterTree} зовёт помощник на любой правке (смена операнда,
 * оператора) перед перерисовкой строки.
 */
export function filterLeafImplicitValue(leaf: FilterTreeLeaf): FilterTreeValue | null {
  const kind = leaf.entity.kind;
  if (kind !== 'active' && kind !== 'trashed') return null;
  if (leaf.operator !== 'eq' && leaf.operator !== 'ne') return null;
  return { kind: 'scalar', value: true };
}

/**
 * Оператор по умолчанию при выборе операнда: первый из набора профиля, кроме
 * предикатов наличия рёбер — у них видимое по умолчанию «да» (`not_empty`),
 * а не «нет» (требование 60db9614).
 */
export function filterOperandDefaultOperator(
  kind: FilterAstEntityKind,
  operators: readonly FilterAstOperator[],
): FilterAstOperator | undefined {
  if (
    (kind === 'incoming_links' || kind === 'outgoing_links') &&
    operators.includes('not_empty')
  ) {
    return 'not_empty';
  }
  return operators[0];
}

/**
 * Операнды «наличие коллекции»: «Есть вложения», «Есть дневниковые записи»,
 * «Есть комментарий». Ячейка значения у них — «(да) (нет)», оператор в строке
 * не показывается (`is_empty`/`not_empty` перезаписывает сам виджет). Один
 * словарь на модули редактора: по нему и вид ячейки (`lib/filter-value.ts`), и
 * скрытие кнопки оператора в строке (`lib/filter-tree.ts`), и автоподстановка
 * оператора ниже — второй копии перечня нет.
 */
export const FILTER_COLLECTION_PREDICATE_KINDS: ReadonlySet<string> = new Set([
  'comment',
  'attachments',
  'chronology',
  // Наличие рёбер любого типа (требование 60db9614): «да/нет» — это оператор
  // `not_empty`/`is_empty`, плюс полоса состояний ребра под строкой.
  'incoming_links',
  'outgoing_links',
]);

/**
 * НЕЯВНЫЙ оператор листа наличия коллекции (ошибка 23c7d3e9 п. D1, возврат A3
 * части 6). Вид «(да) (нет)» и ЕСТЬ оператор условия (`not_empty` — «да»,
 * `is_empty` — «нет»); значения у такого условия нет. Пока лист несёт оператор,
 * требующий значение (`eq`/`ne`), модель расходится с видимым «да»: проверка
 * «условие без значения» висит при видимом значении, а `eq` без значения
 * сервер отверг бы. Помощник возвращает оператор, который виджет показывает
 * по умолчанию; `null` — операнд не этого вида или оператор уже выражает выбор.
 *
 * {@link buildFilterTree} зовёт его на любой правке условия (смена операнда,
 * оператора) перед перерисовкой — рядом с {@link filterLeafDefaultValue}.
 */
export function filterLeafImplicitOperator(leaf: FilterTreeLeaf): FilterAstOperator | null {
  if (!FILTER_COLLECTION_PREDICATE_KINDS.has(leaf.entity.kind)) return null;
  if (!operatorNeedsValue(leaf.operator)) return null;
  return 'not_empty';
}

/**
 * Значение листа, которое виджет показывает по умолчанию при ПУСТОМ значении
 * модели (`value.kind === 'none'`), но сам в модель не пишет. Обобщает
 * {@link filterLeafImplicitValue} двумя автоподстановками (ошибка 609deba0,
 * пункт A3 в редакции части 5):
 *
 *   • булевы триады «Актуальность»/«Помечено на удаление» — «да» (скаляр true);
 *   • датовые операнды (дата создания/изменения, время записи/события) и
 *     свойства с `value_type = 'date'` — опора «$today» с нулевым сдвигом:
 *     ячейка даты показывает «$today», и автоподстановка обязана попасть в
 *     модель, иначе проверка «условие без значения» висит при видимой дате.
 *
 * `valueType` — природа свойства листа (реестр), `undefined` у датовых
 * ОПЕРАНДОВ (их вид виден по `entity.kind`). Возвращает `null`, если виджет
 * значения по умолчанию не подставляет (ссылочные операнды, числа, слова).
 * Значения вне «none» не подменяются: явно выбранную дату/значение обобщение
 * не трогает — его задача закрыть именно пустое условие.
 *
 * {@link buildFilterTree} зовёт помощник на любой правке условия (смена
 * операнда/оператора) до перерисовки — признак «условие без значения»
 * снимается/ставится по факту видимого значения.
 */
export function filterLeafDefaultValue(
  leaf: FilterTreeLeaf,
  valueType?: PropertyValueType,
): FilterTreeValue | null {
  if (leaf.value.kind !== 'none') return null;
  const implicit = filterLeafImplicitValue(leaf);
  if (implicit !== null) return implicit;
  if (!operatorNeedsValue(leaf.operator)) return null;
  if (valueType !== 'date' && !isDateOperandKind(leaf.entity.kind)) return null;
  // Две границы («между»/«не между») — пара опор верхней/нижней границы.
  if (leaf.operator === 'between' || leaf.operator === 'not_between') {
    return { kind: 'list', items: [{ token: '$today' }, { token: '$today' }] };
  }
  return { kind: 'token', token: '$today' };
}

/** Операторы, которым значение не требуется (наличие/заполненность). */
function operatorNeedsValue(operator: FilterAstOperator): boolean {
  return operator !== 'is_empty' && operator !== 'not_empty' && operator !== 'has' && operator !== 'not_has';
}

/** Датовые ОПЕРАНДЫ листа — вид значения которых «дата» без реестра свойств. */
function isDateOperandKind(kind: FilterAstEntityKind): boolean {
  return kind === 'created_at' || kind === 'updated_at' || kind === 'record_time' || kind === 'occurred_at';
}

/** True — у дерева есть хотя бы одно условие (пустые группы не считаются). */
export function filterTreeHasAnyCriteria(node: FilterTreeNode | null): boolean {
  if (node === null) return false;
  if (node.kind === 'group') return node.children.some(filterTreeHasAnyCriteria);
  return true;
}

/**
 * Идентификаторы листьев дерева указанного вида операнда: значения скаляров и
 * списков, во всех группах любой вложенности. Значения-токены (`$today`,
 * `$thought.[Свойство]`) идентификатором не являются — пропускаются.
 *
 * Читателям сохранённого определения, которым нужны не условия целиком, а адреса,
 * второй формы чтения заводить не нужно: дерево уже даёт единый читатель
 * ({@link readFilterDefinitionDetailed}) и для AST-тела, и для плоской записи —
 * компилятор плоской формы переводит `type_ids` в лист «Тип в иерархии», а
 * `parent_ids` в «`ИЛИ(id в [корни], родители в иерархии [корни])`», где корневые
 * мысли стоят значением листа «Родители» (`screens/publications/workspace.ts` —
 * предзаполнение типа и родителя создаваемого раздела).
 */
export function filterTreeIdsByKind(
  node: FilterTreeNode | null,
  kind: FilterAstEntityKind,
): string[] {
  const out: string[] = [];
  const walk = (current: FilterTreeNode | null): void => {
    if (current === null) return;
    if (current.kind === 'group') {
      for (const child of current.children) walk(child);
      return;
    }
    if (current.entity.kind !== kind) return;
    const value = current.value;
    if (value.kind === 'scalar') out.push(String(value.value));
    else if (value.kind === 'list') {
      for (const item of value.items) if (typeof item !== 'object') out.push(String(item));
    }
  };
  walk(node);
  return out;
}

/** Операнды, доступные в профиле контекста (виды AST точки применения). */
export function filterProfileOperands(profile: FilterProfileId): readonly FilterAstEntityKind[] {
  return getFilterProfile(profile).operands;
}

/**
 * Операторы, доступные для операнда в профиле контекста: у точек, отбирающих
 * не-мысли (хроника, события, вложения), и у отбора мыслей набор задан по
 * операнду (требование c088f9e1); у полиморфного операнда «Свойство» состав
 * уточняется природой свойства — `propertyValueType` (требование 9bdddad6).
 * Состав берётся из общего реестра `@etn/shared` — второго словаря нет.
 */
export function filterProfileOperators(
  profile: FilterProfileId,
  kind: FilterAstEntityKind,
  propertyValueType?: PropertyValueType,
): readonly FilterAstOperator[] {
  return filterProfileOperandOperators(profile, kind, propertyValueType);
}

/**
 * Семейства токенов профиля (`calendar` — везде, `time` — только у профилей со
 * временем). Состав самих токенов и их арифметику знает серверный резолвер —
 * клиентская модель хранит токен строкой и предлагает редактору те семейства,
 * что вернул профиль.
 */
export function filterProfileTokenFamilies(profile: FilterProfileId): readonly FilterTokenFamily[] {
  return getFilterProfile(profile).tokens;
}

/** Подпись ключа сортировки: известный ключ — из единого набора, иначе как есть. */
export function filterAstSortKeyLabel(key: string): string {
  const sort = AST_KEY_TO_FILTER_SORT[key];
  return sort !== undefined ? filterSortLabel(sort) : key;
}

/**
 * Движковые ключи AST единого набора сортировок — с подписями конструктора.
 * Секция сортировки редактора строит свой словарь полей из ЭТОГО списка плюс
 * свойства реестра сети: второго набора сортировок нет (сторож
 * `guard-filter-builder`). «По просмотру» (`viewed`) ключа AST не имеет —
 * плоская сортировка в AST не выражается и в список не входит.
 */
export function filterSortAstKeys(): ReadonlyArray<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  for (const option of FILTER_SORTS) {
    const key = FILTER_SORT_TO_AST_KEY[option.v];
    if (key !== undefined) out.push({ key, label: option.label });
  }
  return out;
}

/** True — значение является wire-AST отбора (`{ version, filter }`). */
export function isFilterAstWire(def: unknown): def is FilterAst {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return false;
  const rec = def as Record<string, unknown>;
  return typeof rec['version'] === 'number' && rec['filter'] !== undefined && rec['filter'] !== null;
}

/** True — код оператора входит в словарь ядра. */
export function isFilterAstOperator(value: unknown): value is FilterAstOperator {
  return (
    typeof value === 'string' && (FILTER_AST_OPERATORS as readonly string[]).includes(value)
  );
}

/** True — код группы дерева (`and`/`or`/`not`). */
export function isFilterAstGroupOp(value: unknown): value is FilterAstGroupOp {
  return typeof value === 'string' && (FILTER_AST_GROUP_OPS as readonly string[]).includes(value);
}

/** True — режим обхода «в иерархии». */
function isFilterAstHierarchyMode(value: unknown): value is FilterAstHierarchyMode {
  return value === 'structural' || value === 'all_links';
}

/** True — ключ AST-сортировки (`{ key, order }`). */
function isFilterAstSortKey(value: unknown): value is FilterAstSortKey {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec['key'] === 'string' && isSortOrder(rec['order']);
}

/** Операнд wire-листа, очищенный до известного вида AST (иначе `null`). */
function parseFilterAstEntity(raw: unknown): FilterAstEntity | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const kind = rec['kind'];
  if (typeof kind !== 'string' || !(FILTER_AST_ENTITY_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  // Операнды наличия рёбер: `states` — замкнутый словарь. При чтении
  // отсутствующий/пустой набор нормализуется в ПОЛНЫЙ (все флаги отмечены):
  // wire-дефолт «нет поля» означает «все состояния», а модель редактора держит
  // выбор явно и при пересохранении пишет массив (требование 60db9614).
  // Неизвестное значение — лист не читаем (строгость чтения AST сохранена).
  if (kind === 'incoming_links' || kind === 'outgoing_links') {
    const rawStates = rec['states'];
    if (rawStates === undefined) {
      return { kind, states: [...FILTER_LINK_EDGE_STATES] };
    }
    if (!Array.isArray(rawStates)) return null;
    const states: FilterLinkEdgeState[] = [];
    for (const state of rawStates) {
      if (
        typeof state !== 'string' ||
        !(FILTER_LINK_EDGE_STATES as readonly string[]).includes(state)
      ) {
        return null;
      }
      const typed = state as FilterLinkEdgeState;
      if (!states.includes(typed)) states.push(typed);
    }
    return states.length === 0
      ? { kind, states: [...FILTER_LINK_EDGE_STATES] }
      : { kind, states };
  }
  // Операнд хранится как есть (вид + адрес свойства/область/направление) —
  // незнакомые поля не выдумываем и не теряем: модель обязана быть без потерь.
  return { ...rec, kind } as FilterAstEntity;
}

/** Снапшоты подписей wire-листа (пустые — `undefined`). */
function parseFilterAstLabels(raw: unknown): FilterAstLabels | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const labels: FilterAstLabels = {};
  if (typeof rec['entity'] === 'string') labels.entity = rec['entity'];
  if (typeof rec['value'] === 'string') labels.value = rec['value'];
  const values = rec['values'];
  if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
    const map: Record<string, string> = {};
    for (const [id, name] of Object.entries(values as Record<string, unknown>)) {
      if (typeof name === 'string') map[id] = name;
    }
    if (Object.keys(map).length > 0) labels.values = map;
  }
  return labels.entity === undefined && labels.value === undefined && labels.values === undefined
    ? undefined
    : labels;
}

/**
 * Значение wire-листа → значение модели. `null` — значение ПРИСУТСТВУЕТ, но не
 * распознано (битая под-выборка: нечитаемое под-дерево `query` или оператор вне
 * словаря) — такой лист отклоняется целиком вместе с содержащей группой, чтобы
 * условие не исчезло молча при пересохранении (та же ось строгости, что у
 * нераспознанного ребёнка группы). Отсутствующее значение (нет поля `value`) —
 * это «нет значения» (`{kind:'none'}`), а не ошибка чтения.
 */
function filterAstValueToTree(raw: unknown): FilterTreeValue | null {
  if (raw === undefined || raw === null) return { kind: 'none' };
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { kind: 'scalar', value: raw };
  }
  if (Array.isArray(raw)) {
    const items: FilterTreeListItem[] = [];
    for (const item of raw) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        items.push(item);
      } else if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>)['token'] === 'string'
      ) {
        items.push({ token: (item as Record<string, unknown>)['token'] as string });
      }
    }
    return { kind: 'list', items };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['token'] === 'string') return { kind: 'token', token: rec['token'] };
  if (rec['query'] !== undefined) {
    const node = filterAstToTree(rec['query']);
    const operator = rec['operator'];
    if (node === null) return null; // битое под-дерево под-выборки — отклоняем лист
    if (operator !== 'in' && operator !== 'not_in' && operator !== 'all_in') return null;
    return { kind: 'subquery', operator, node };
  }
  return { kind: 'none' };
}

/** Значение модели → значение wire-листа (`none` — поле не выставляется). */
function filterTreeValueToAst(value: FilterTreeValue): FilterAstValue | undefined {
  switch (value.kind) {
    case 'none':
      return undefined;
    case 'scalar':
      return value.value;
    case 'token':
      return { token: value.token };
    case 'list':
      return value.items.map((item) =>
        typeof item === 'object' ? { token: item.token } : item,
      );
    case 'subquery':
      return { query: filterTreeToAst(value.node), operator: value.operator };
    default:
      return undefined;
  }
}

/**
 * Узел дерева модели → узел wire-AST. Единственная реализация сериализации
 * дерева: редактор обязан собирать состояние в этом виде, второго конвертера
 * нет (ADR 30ff83bb).
 */
export function filterTreeToAst(node: FilterTreeNode): FilterAstNode {
  if (node.kind === 'group') {
    return { op: node.op, children: node.children.map(filterTreeToAst) };
  }
  const leaf: FilterAstLeaf = { entity: node.entity, operator: node.operator };
  const value = filterTreeValueToAst(node.value);
  if (value !== undefined) leaf.value = value;
  if (node.labels !== undefined) leaf.labels = node.labels;
  if (node.mode !== undefined) leaf.mode = node.mode;
  if (node.service === true) leaf.service = true;
  return leaf;
}

/**
 * Узел wire-AST → узел дерева модели. `null` — узел не распознан (нет вида
 * операнда или код оператора вне словаря ядра): читаем строго, выдумывать
 * условие нельзя — молча искажённый отбор хуже пустого.
 *
 * Строгость симметрична на любой глубине: нераспознанный РЕБЁНОК отклоняет всю
 * группу, а нечитаемое значение-под-выборка — лист (обязательство f07cf978,
 * замечание приёмки 6ae062a9). Отфильтровать неизвестного ребёнка и сохранить
 * группу нельзя — `and[неизвестный, keywords]` стал бы `and[keywords]`, то есть
 * отбор молча РАСШИРИЛСЯ бы при пересохранении; потерянная под-выборка молча
 * ИСКАЗИЛА бы условие (достижимо при рассинхроне словаря клиент↔сервер). Так же
 * читается и корень: весь отбор — пустой.
 */
export function filterAstToTree(node: unknown): FilterTreeNode | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const rec = node as Record<string, unknown>;
  if (rec['op'] !== undefined) {
    if (!isFilterAstGroupOp(rec['op'])) return null;
    const rawChildren = Array.isArray(rec['children']) ? rec['children'] : [];
    const children: FilterTreeNode[] = [];
    for (const rawChild of rawChildren) {
      const child = filterAstToTree(rawChild);
      if (child === null) return null; // нераспознанный ребёнок — отклоняем всю группу
      children.push(child);
    }
    return { kind: 'group', op: rec['op'], children };
  }
  const entity = parseFilterAstEntity(rec['entity']);
  if (entity === null || !isFilterAstOperator(rec['operator'])) return null;
  const value = filterAstValueToTree(rec['value']);
  if (value === null) return null; // битая под-выборка — лист не читаем
  const leaf: FilterTreeLeaf = {
    kind: 'leaf',
    entity,
    operator: rec['operator'],
    value,
  };
  const labels = parseFilterAstLabels(rec['labels']);
  if (labels !== undefined) leaf.labels = labels;
  if (isFilterAstHierarchyMode(rec['mode'])) leaf.mode = rec['mode'];
  // Метка служебного листа читается строго как `true`: любое другое значение
  // меткой не является (сервер такую форму отвергает, читатель сохранённого
  // определения не должен на ней падать).
  if (rec['service'] === true) leaf.service = true;
  return leaf;
}

/**
 * Проверка дерева по профилю контекста (требование aed27eb8: состав операндов
 * по видимым характеристикам; реестр — `@etn/shared`). Возвращает замечания
 * редактора: недоступный операнд, недоступный оператор, у `НЕ` не один ребёнок.
 *
 * Семантику оператора и его сосуществование со значением (под-выборка, токены,
 * `is_empty`) проверяет серверный `diagnoseFilterAst` — здесь второго словаря
 * семантики не заводим.
 */
export function validateFilterTree(
  node: FilterTreeNode,
  profile: FilterProfileId,
): FilterTreeIssue[] {
  const operands = new Set<string>(filterProfileOperands(profile));
  const issues: FilterTreeIssue[] = [];
  const walk = (current: FilterTreeNode, path: string): void => {
    if (current.kind === 'group') {
      if (current.op === 'not' && current.children.length !== 1) {
        issues.push({
          path,
          message: `группа «не» обязана иметь ровно одного ребёнка (сейчас ${current.children.length})`,
        });
      }
      current.children.forEach((child, index) => {
        walk(child, `${path}.children[${index}]`);
      });
      return;
    }
    const kind = current.entity.kind;
    if (!operands.has(kind)) {
      issues.push({
        path,
        message: `операнд «${kind}» недоступен в профиле «${profile}»`,
      });
    } else if (!filterProfileOperators(profile, kind).includes(current.operator)) {
      issues.push({
        path,
        message: `оператор «${current.operator}» недоступен для операнда «${kind}» в профиле «${profile}»`,
      });
    }
    if (current.value.kind === 'subquery') {
      walk(current.value.node, `${path}.value.query`);
    }
  };
  walk(node, 'filter');
  return issues;
}

/** Многоуровневая сортировка состояния: явные `sortKeys` либо пара `sort`/`order`. */
function buildFilterAstSort(state: FilterCriteriaState): FilterAstSortKey[] {
  const sortKeys = state.sortKeys ?? [];
  if (sortKeys.length > 0) {
    return sortKeys.map((key) => ({ key: key.key, order: key.order }));
  }
  const key = FILTER_SORT_TO_AST_KEY[state.sort];
  return key === undefined ? [] : [{ key, order: state.order }];
}

/** Пути замечаний профиля — для сообщения об отказе сборки. */
function profileIssuesMessage(issues: FilterTreeIssue[], profile: FilterProfileId): string {
  return `Отбор не соответствует профилю «${profile}»: ${issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ')}`;
}

/**
 * Единственный конвертер состояния в wire-AST (задачи 6ae062a9, ADR 30ff83bb):
 * дерево модели → `FilterAst` и многоуровневая сортировка. Корень пустого
 * дерева — пустая группа `И` (валидный «отбор без условий»).
 *
 * `opts.profile` включает проверку по профилю контекста; `opts.strict` —
 * бросает `Error` при нарушении (сборка отбора для сохранения обязана быть
 * принята исполнителем того же профиля).
 */
export function buildFilterAst(
  state: FilterCriteriaState,
  opts: FilterAstProfileOptions = {},
): FilterAst {
  const root: FilterTreeNode = state.tree ?? defaultFilterTreeGroup('and');
  if (opts.profile !== undefined && opts.strict === true) {
    const issues = validateFilterTree(root, opts.profile);
    if (issues.length > 0) throw new Error(profileIssuesMessage(issues, opts.profile));
  }
  const ast: FilterAst = { version: FILTER_AST_VERSION, filter: filterTreeToAst(root) };
  const sort = opts.sort === false ? [] : buildFilterAstSort(state);
  if (sort.length > 0) ast.sort = sort;
  return ast;
}

/**
 * Десериализация сохранённого AST в единую модель: условия ложатся в `tree`,
 * многоуровневая сортировка — в `sortKeys` (первый ключ дополнительно даёт
 * плоскую пару `sort`/`order` для панелей). Плоские поля критериев не
 * заполняются: их выражает дерево, и подменять одно другим нельзя — иначе
 * сохранённый отбор открывался бы в панели искажённо.
 *
 * `opts.profile`/`opts.strict` — те же, что у {@link buildFilterAst}.
 */
export function parseFilterAstState(
  def: unknown,
  opts: FilterAstProfileOptions = {},
): FilterCriteriaState {
  const next = defaultFilterCriteriaState();
  if (!isFilterAstWire(def)) return next;
  const node = filterAstToTree(def.filter);
  if (node === null) return next;
  next.tree = node;
  if (Array.isArray(def.sort)) {
    next.sortKeys = def.sort.filter(isFilterAstSortKey).map((key) => ({
      key: key.key,
      order: key.order,
    }));
    const first = next.sortKeys[0];
    const sort = first === undefined ? undefined : AST_KEY_TO_FILTER_SORT[first.key];
    if (first !== undefined && sort !== undefined) {
      next.sort = sort;
      next.order = first.order;
    }
  }
  if (opts.profile !== undefined && opts.strict === true) {
    const issues = validateFilterTree(node, opts.profile);
    if (issues.length > 0) throw new Error(profileIssuesMessage(issues, opts.profile));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Компиляция плоских критериев `definition v1` в AST (чтение старых отборов)
// ---------------------------------------------------------------------------

/** Опции компиляции плоских критериев в AST ({@link compileFlatCriteriaToAst}). */
export interface CompileFlatCriteriaOptions {
  /**
   * Трактовка трёхзначной «Актуальности» — как у {@link buildWireFilter}:
   *
   *   * `view` (по умолчанию) — отбор типа мысли: `null` («не важно») означает
   *     «показать и актуальные, и неактуальные» (плоский `show_inactive`),
   *     условия по `active` не появляется;
   *   * `structures` — панель «Структур»: `null` — дефолт «только актуальные»
   *     (`active eq true`).
   */
  activeMode?: 'view' | 'structures';
}

/** Лист AST из операнда/оператора/значения (значение не задано — поле опущено). */
function flatAstLeaf(
  entity: FilterAstEntity,
  operator: FilterAstOperator,
  value?: FilterAstValue,
): FilterAstLeaf {
  const leaf: FilterAstLeaf = { entity, operator };
  if (value !== undefined) leaf.value = value;
  return leaf;
}

/**
 * Плоское значение (`definition v1` хранит токен СТРОКОЙ `$…`) → значение AST.
 * В AST токен — отдельная форма `{ token }`, иначе исполнитель прочитал бы
 * `$thought.[версия]` литералом и подстановки не произошло бы.
 */
function flatAstValue(value: FilterAstScalar): FilterAstValue {
  return typeof value === 'string' && value.startsWith('$') ? { token: value } : value;
}

/** Список плоских значений со токенами → список значений AST. */
function flatAstList(values: readonly FilterAstScalar[]): FilterAstListItem[] {
  return values.map((value) => flatAstValue(value) as FilterAstListItem);
}

/**
 * Лист «Найти слова» из состояния (область поиска + мини-язык ключевых слов) —
 * общий для плоских компиляторов (мыслей и «Событий»). `null` — ключевых слов
 * нет. Мини-язык «Найти слова» — строка; одиночный токен (`$thought.title`)
 * адресуем формой AST-токена, составную строку отдаём листу как есть. Области:
 * плоская форма опускает дефолт title+synonyms — в AST пустой набор означал бы
 * ОТКЛЮЧЁННОЕ условие, поэтому дефолт выписываем явно.
 */
function flatKeywordLeaf(state: FilterCriteriaState): FilterAstLeaf | null {
  const keywords = state.keywords.trim();
  if (keywords === '') return null;
  const scope = buildKeywordScope(state) ?? ['title', 'synonyms'];
  const value: FilterAstValue =
    keywords.startsWith('$') && !/\s/.test(keywords) ? { token: keywords } : keywords;
  return flatAstLeaf({ kind: 'keywords', scope }, 'matches', value);
}

/** Лист авторства/редактора/автора события из плоского оператора и значения. */
function flatAuthorLeaf(
  kind: 'author' | 'editor' | 'user',
  op: StructureAuthorOp,
  single: string,
  list: readonly string[],
): FilterAstLeaf | null {
  if (op === 'empty' || op === 'not_empty') {
    return flatAstLeaf({ kind }, op === 'empty' ? 'is_empty' : 'not_empty');
  }
  if (op === 'in' || op === 'not_in') {
    const values = list.filter((id) => id.trim() !== '');
    return values.length === 0 ? null : flatAstLeaf({ kind }, op, flatAstList(values));
  }
  // `eq` / `ne`: значение — одиночный id или токен; пусто — условия нет.
  const value = single.trim();
  return value === '' ? null : flatAstLeaf({ kind }, op, flatAstValue(value));
}

/**
 * Компилятор ПЛОСКИХ критериев (`definition v1`) в AST — клиентское зеркало
 * серверного `compileThoughtQueryToAst` (`server/src/domain/query-service.ts`,
 * задача 4be62d42 «Миграция definition v1 → AST»). Нужен ровно затем, чтобы
 * редактор открывал СТАРЫЙ плоский отбор деревом с тем же результатом: сервер
 * исполняет `req.ast` без неявных дефолтов `active`/`trashed`, поэтому дефолты
 * плоской формы (`trashed eq false`, «только актуальные») впекаются сюда
 * ЯВНЫМИ листьями — иначе конвертированный отбор расширился бы.
 *
 * Конвертер ОДИН и живёт в едином конструкторе (ADR fc23f9c1 запрещает вторую
 * точку чтения сохранённого отбора в экранах): место применения зовёт его, а не
 * разбирает плоские поля само. `undefined` — критериев нет (пустой отбор).
 *
 * Соответствие плоских полей листьям (совпадает с серверным компилятором):
 *   * `active` → `active eq true|false` (в `view`-режиме `null` — условия нет);
 *   * `trashed` → `trashed eq false`, если флаг не выставлен (плоский дефолт);
 *   * `author`/`editor` → `author`/`editor` c `eq`/`ne`/`in`/`not_in`/`is_empty`/
 *     `not_empty`;
 *   * границы дат → `created_at`/`updated_at` c `gte`/`lte` (включительно);
 *   * `has_*` → `properties`/`comment`/`attachments`/`chronology` c
 *     `not_empty`/`is_empty`;
 *   * `keywords` → `keywords` (области в операнде) c `matches`;
 *   * `type_ids` → `type in_hierarchy` (подтипы раскрывает исполнитель);
 *   * `link_type_ids` → `link_type in` (поддерево типов связей раскрывает движок
 *     на момент запроса — как серверная плоская форма);
 *   * `parent_ids` → ГРУППА `ИЛИ(id в [корни], parents in_hierarchy [корни])`
 *     (ADR fc23f9c1: обход по связям → «в иерархии»; фасадный обход включал
 *     корни — их добавляет лист `id в [корни]`);
 *   * `properties` → `property` c оператором строки (типизация значения — общая,
 *     {@link buildConditionsWire}).
 */
export function compileFlatCriteriaToAst(
  state: FilterCriteriaState,
  registry: ReadonlyMap<string, NetworkProperty>,
  opts: CompileFlatCriteriaOptions = {},
): FilterAst | undefined {
  const activeMode = opts.activeMode ?? 'view';
  const children: FilterAstNode[] = [];

  // Актуальность: явное значение — лист; `null` в `view`-режиме — обе
  // актуальности (плоский `show_inactive`), в «Структурах» — дефолт «только
  // актуальные».
  if (state.active === true) children.push(flatAstLeaf({ kind: 'active' }, 'eq', true));
  else if (state.active === false) children.push(flatAstLeaf({ kind: 'active' }, 'eq', false));
  else if (activeMode === 'structures') children.push(flatAstLeaf({ kind: 'active' }, 'eq', true));

  // Пометка на удаление: `true` — «включать помеченные» (условия нет); иначе
  // плоский дефолт — только непомеченные.
  if (!state.trashed) children.push(flatAstLeaf({ kind: 'trashed' }, 'eq', false));

  const author = flatAuthorLeaf('author', state.authorOp, state.authorId, state.authorIds);
  if (author !== null) children.push(author);
  const editor = flatAuthorLeaf('editor', state.editorOp, state.editorId, state.editorIds);
  if (editor !== null) children.push(editor);

  // Датовые границы — через {@link flatAstValue}: плоская форма хранит токен
  // СТРОКОЙ (`updatedAfter: '$weekStart'` — поле периода принимает опоры), а в
  // AST токен — форма `{ token }`. Сырая строка уезжала исполнителю литералом и
  // сравнивалась с колонкой как текст: отбор «исполнялся, но с неверными датами»
  // (ошибка 99e7889d).
  if (state.createdAfter.trim() !== '') children.push(flatAstLeaf({ kind: 'created_at' }, 'gte', flatAstValue(state.createdAfter.trim())));
  if (state.createdBefore.trim() !== '') children.push(flatAstLeaf({ kind: 'created_at' }, 'lte', flatAstValue(state.createdBefore.trim())));
  if (state.updatedAfter.trim() !== '') children.push(flatAstLeaf({ kind: 'updated_at' }, 'gte', flatAstValue(state.updatedAfter.trim())));
  if (state.updatedBefore.trim() !== '') children.push(flatAstLeaf({ kind: 'updated_at' }, 'lte', flatAstValue(state.updatedBefore.trim())));

  if (state.hasProperties !== null) children.push(flatAstLeaf({ kind: 'properties' }, state.hasProperties ? 'not_empty' : 'is_empty'));
  if (state.hasComment !== null) children.push(flatAstLeaf({ kind: 'comment' }, state.hasComment ? 'not_empty' : 'is_empty'));
  if (state.hasAttachments !== null) children.push(flatAstLeaf({ kind: 'attachments' }, state.hasAttachments ? 'not_empty' : 'is_empty'));
  if (state.hasChronology !== null) children.push(flatAstLeaf({ kind: 'chronology' }, state.hasChronology ? 'not_empty' : 'is_empty'));

  const keywords = flatKeywordLeaf(state);
  if (keywords !== null) children.push(keywords);

  if (state.typeIds.length > 0) children.push(flatAstLeaf({ kind: 'type' }, 'in_hierarchy', flatAstList(state.typeIds)));
  // Тип связи: серверный компилятор плоской формы раскрывает `link_type_ids` в
  // поддерево типов связей и отдаёт `link_type in [раскрытые]`; движок AST для
  // этого операнда раскрывает поддерево САМ и для `in`, и для `in_hierarchy`
  // (`expandTypeIdsToSubtree`, query-service) — поэтому `in` с исходными корнями
  // даёт тот же набор, что и серверная форма (раскрытие на момент запроса).
  if (state.linkTypeIds.length > 0) children.push(flatAstLeaf({ kind: 'link_type' }, 'in', flatAstList(state.linkTypeIds)));
  // Прежние «родительские мысли» — фасадный обход поддерева с `include_roots`
  // (корни ВХОДЯТ в результат). Лист «Родители в иерархии» матчит только
  // ПОТОМКОВ, поэтому фасад переводится честно: `ИЛИ(id в [корни], родители в
  // иерархии [корни])` — так результат совпадает с прежним (решение
  // оркестратора, итерация 2 задачи cfbe8c74). Режим обхода ставит
  // {@link applyLegacyHierarchyTraversal}.
  if (state.parentIds.length > 0) {
    const rootsForId = flatAstList(state.parentIds);
    const rootsForHierarchy = flatAstList(state.parentIds);
    const group: FilterAstGroup = {
      op: 'or',
      children: [
        flatAstLeaf({ kind: 'id' }, 'in', rootsForId),
        flatAstLeaf({ kind: 'parents' }, 'in_hierarchy', rootsForHierarchy),
      ],
    };
    children.push(group);
  }

  for (const cond of buildConditionsWire(state, registry)) {
    const op = cond.op as FilterAstOperator;
    // `is_empty`/`not_empty` значения не несут (плоская форма писала туда '').
    if (op === 'is_empty' || op === 'not_empty') {
      children.push(flatAstLeaf({ kind: 'property', property_id: cond.property_id }, op));
    } else if (Array.isArray(cond.value)) {
      children.push(flatAstLeaf({ kind: 'property', property_id: cond.property_id }, op, flatAstList(cond.value)));
    } else {
      children.push(flatAstLeaf({ kind: 'property', property_id: cond.property_id }, op, flatAstValue(cond.value)));
    }
  }

  if (children.length === 0) return undefined;
  const ast: FilterAst = {
    version: FILTER_AST_VERSION,
    filter: children.length === 1 ? (children[0] as FilterAstNode) : { op: 'and', children },
  };
  const sort = buildFilterAstSort(state);
  if (sort.length > 0) ast.sort = sort;
  return ast;
}

/**
 * Прежний плоский «обход по связям» (`parent_ids` + `link_filter`) ограничивал
 * рёбра списком типов, а режима обхода не нёс; в модели AST это тот же оператор
 * «в иерархии», но по ВСЕМ связям (решение оркестратора 2026-10-12, ADR
 * fc23f9c1: «обход по связям → „в иерархии“»). Функция доводит режим связей
 * листьев «Родители»/«Потомки», пришедших из плоской формы, до `all_links` —
 * значения прежней пары «корни + фильтр обхода» не сохраняются осознанно.
 * Листья с уже заданным режимом не трогаются (AST-определения самодостаточны).
 */
export function applyLegacyHierarchyTraversal(tree: FilterTreeNode): void {
  if (tree.kind === 'group') {
    for (const child of tree.children) applyLegacyHierarchyTraversal(child);
    return;
  }
  const kind = tree.entity.kind;
  if (
    (kind === 'parents' || kind === 'children') &&
    (tree.operator === 'in_hierarchy' || tree.operator === 'not_in_hierarchy') &&
    tree.mode === undefined
  ) {
    tree.mode = 'all_links';
  }
}

/**
 * Сообщение о нечитаемом AST-теле определения (потеря при чтении).
 */
const AST_UNREADABLE_MESSAGE =
  'сохранённое определение отбора не читается (неизвестный операнд или оператор) — условия не показаны';

/**
 * Описания условий ПЛОСКОГО определения (`definition v1`), которые модель НЕ
 * выразила при чтении: условия-свойства с отсутствующим в реестре свойством
 * (их отбрасывает {@link buildConditionsWire}), нераспознанные записи условий и
 * сортировка «по просмотру», у которой нет ключа AST ({@link FILTER_SORT_TO_AST_KEY}).
 *
 * Функция только ОПИСЫВАЕТ потерю — место применения показывает её жёлтой
 * диагностикой (требование «битый отбор не теряется молча»), решение о
 * перезаписи определения остаётся за хостом. Разбор ведёт тот же модуль, что и
 * само чтение (второй точки чтения сохранённого отбора нет — ADR fc23f9c1).
 */
function flatDefinitionLosses(
  def: unknown,
  registry: ReadonlyMap<string, NetworkProperty>,
): string[] {
  const lost: string[] = [];
  if (def === null || def === undefined) return lost;
  if (typeof def !== 'object' || Array.isArray(def)) {
    return ['сохранённое определение отбора повреждено и не читается'];
  }
  const rec = def as Record<string, unknown>;
  const conditions = rec['properties'];
  if (Array.isArray(conditions)) {
    for (const raw of conditions) {
      const entry =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const propertyId = entry?.['property_id'];
      const op = entry?.['op'];
      if (entry === null || typeof propertyId !== 'string' || typeof op !== 'string') {
        lost.push('условие по свойству не распознано и отброшено');
        continue;
      }
      if (!registry.has(propertyId)) {
        lost.push(`условие по свойству «${propertyId}» отброшено: свойства больше нет в сети`);
      }
    }
  }
  // Сортировка «по просмотру» ключа AST не имеет (см. FILTER_SORT_TO_AST_KEY) —
  // в редакторе не выражается. Сообщаем, чтобы ключ не терялся молча.
  if (rec['sort'] === 'viewed') {
    lost.push('сортировка «по просмотру» в редакторе не выражается — ключ не показан');
  }
  return lost;
}

/** Результат чтения сохранённого отбора в единую модель: состояние + потери. */
export interface FilterDefinitionReadResult {
  /** Состояние модели: `tree` заполнен всегда (пустая группа `И` — условий нет). */
  state: FilterCriteriaState;
  /**
   * Человекочитаемые описания условий, которые модель НЕ выразила при чтении
   * (отброшены или нечитаемы). Пусто — чтение без потерь. Место применения
   * показывает их жёлтой диагностикой; перезапись определения — только после
   * осознанной правки пользователем (требование «битый отбор не теряется молча»).
   */
  lost: readonly string[];
}

/**
 * Прочитать определение отбора в единую модель так, чтобы `tree` был ЗАПОЛНЕН
 * всегда: AST-форма читается {@link parseFilterAstState} (дерево уже есть), а
 * плоская `definition v1` компилируется в дерево на входе
 * ({@link compileFlatCriteriaToAst} + {@link filterAstToTree}) — работа
 * «Миграция definition v1 → AST» на стороне клиента. Плоский обход по связям
 * доводится до режима «по всем связям» ({@link applyLegacyHierarchyTraversal}).
 * Многоуровневая сортировка AST (или пара `sort`/`order` плоской формы) ложится
 * в `sortKeys`.
 *
 * Пустой/нечитаемый отбор получает пустую корневую группу `И` — редактор
 * открывается на чистом дереве. Помимо состояния отдаёт список отброшенных при
 * чтении условий ({@link FilterDefinitionReadResult.lost}) — единая точка чтения
 * сохранённого отбора, второго разбора в местах применения нет (ADR fc23f9c1).
 */
export function readFilterDefinitionDetailed(
  def: unknown,
  opts: CompileFlatCriteriaOptions & { registry?: ReadonlyMap<string, NetworkProperty> } = {},
): FilterDefinitionReadResult {
  const state = parseFilterDefinition(def);
  // AST-форма: читается целиком либо нечитается вовсе — строгость
  // `filterAstToTree` (нераспознанный узел отклоняет тело). `tree === null`
  // после `parseFilterDefinition` означает именно нечитаемое AST-тело.
  if (isFilterAstWire(def)) {
    const readTree = state.tree;
    if (readTree !== null && readTree !== undefined) {
      // Служебные листья места применения (`service: true`), впечённые при
      // сохранении, — не условия пользователя: снимаем их с корня, иначе
      // служебный дефолт показывался бы строкой и удовлетворял запрету пустого
      // отбора (ошибка 9ddc488e). Непомеченный лист «Помечено на удаление = нет»
      // остаётся условием пользователя — именно его сохранение чинил коммит
      // 46befcd4 (roundtrip условия).
      state.tree = stripServiceLeavesAtRoot(normalizeFilterTreeRoot(readTree));
      return { state, lost: [] };
    }
    state.tree = defaultFilterTreeGroup('and');
    return { state, lost: [AST_UNREADABLE_MESSAGE] };
  }
  const registry = opts.registry ?? new Map<string, NetworkProperty>();
  const lost = flatDefinitionLosses(def, registry);
  const ast = compileFlatCriteriaToAst(state, registry, opts);
  // Служебный дефолт места («Помечено на удаление = нет»), добавленный компилятором
  // плоской формы на КОРНЕВОЙ уровень, — не условие пользователя: снимаем его,
  // как это делает место «Отбор типа мысли» ({@link isTrashedDefaultLeaf},
  // ADR 30ff83bb). Иначе определение без критериев (пара `sort`/`order` и
  // видимость) читалось бы «с условием» и панель «Структур» ушла бы с контракта
  // «нет критериев → HOME + сироты» (§15.3) на ветку `ast` (ошибка ca864656).
  const compiled = ast === undefined ? null : filterAstToTree(ast.filter);
  const tree = compiled !== null && isTrashedDefaultLeaf(compiled) ? null : compiled;
  state.tree = tree === null ? defaultFilterTreeGroup('and') : normalizeFilterTreeRoot(tree);
  if (tree !== null) applyLegacyHierarchyTraversal(tree);
  if (ast?.sort !== undefined && (state.sortKeys ?? []).length === 0) {
    state.sortKeys = ast.sort.map((key) => ({ key: key.key, order: key.order }));
  }
  return { state, lost };
}

/**
 * Прочитать определение отбора в единую модель с заполненным деревом (без
 * перечня потерь) — см. {@link readFilterDefinitionDetailed}.
 */
export function parseFilterDefinitionTree(
  def: unknown,
  opts: CompileFlatCriteriaOptions & { registry?: ReadonlyMap<string, NetworkProperty> } = {},
): FilterCriteriaState {
  return readFilterDefinitionDetailed(def, opts).state;
}

// ---------------------------------------------------------------------------
// Подписи кодов операторов AST (задача ТП «Редактор: базовый компонент»,
// требование 502f1922 «сгруппированные списки операторов»; ADR 23fab347 «один
// словарь операторов», ADR 30ff83bb «дерево — развитие одного конструктора»)
// ---------------------------------------------------------------------------

/**
 * Русские подписи КОДОВ операторов AST — словарь спецификации
 * (`shared/src/types/filter-ast.ts`, шапка {@link FILTER_AST_OPERATORS}:
 * «равно», «не в списке», «в иерархии», «Найти слова»…).
 *
 * Живёт рядом с {@link OPS_BY_TYPE} и `AUTHOR_OP_LABELS` по ADR «условия отбора
 * строит один конструктор с одной моделью состояния»: подписи операторов не
 * размножаются по местам применения, редактор дерева (`lib/filter-tree.ts`)
 * берёт их отсюда.
 *
 * Здесь НЕ объявлено, КАКИЕ операторы доступны операнду — состав задаёт реестр
 * профилей `@etn/shared` ({@link filterProfileOperators}), второго словаря
 * состава нет.
 */
export const AST_OPERATOR_LABELS: Record<FilterAstOperator, string> = {
  // Краткие знаки сравнения (требование заказчика 2026-10-14, ошибка 696b3c3b
  // п.10): «равно» → «=», «не равно» → «≠», «в списке» → «в», «не в списке» →
  // «не в» — фраза-превью собирается этими подписями и становится короче.
  // Тултипы операторов остаются полными словами (`AST_OPERATOR_DESCRIPTIONS`).
  eq: '=',
  ne: '≠',
  contains: 'содержит',
  not_contains: 'не содержит',
  gt: 'больше',
  gte: 'больше или равно',
  lt: 'меньше',
  lte: 'меньше или равно',
  between: 'между',
  not_between: 'не между',
  in: 'в',
  not_in: 'не в',
  // Формулировки заказчика 2026-10-14 (ошибка 4258e694, п.7б).
  any_of: 'любой из',
  all_of: 'все из',
  none_of: 'ни одного из',
  is_empty: 'не заполнено',
  not_empty: 'заполнено',
  matches: 'есть слова',
  in_hierarchy: 'в иерархии',
  not_in_hierarchy: 'не в иерархии',
  has: 'имеет свойство',
  not_has: 'не имеет свойство',
};

/** Подпись кода оператора AST (имя из словаря спецификации). */
export function astOperatorLabel(op: FilterAstOperator): string {
  return AST_OPERATOR_LABELS[op];
}
