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
 *     условия «автор/редактор» (`buildAuthorConditionRow`).
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
  SORT_ORDERS,
  STRUCTURE_AUTHOR_OPS,
  STRUCTURE_SORTS,
  type ActivityEntityType,
  type ChronicleFilterDefinition,
  type ChronicleLinkScope,
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
  };
}

/**
 * Восстанавливает состояние отбора из wire-определения (сохранённый отбор
 * панели или `definition` отбора типа мысли). Незнакомые поля игнорируются;
 * сортировка/направление вне единых наборов заменяются значениями по
 * умолчанию — конструктор не сохраняет то, что исполнитель не исполнит.
 */
export function parseFilterDefinition(def: unknown): FilterCriteriaState {
  const next = defaultFilterCriteriaState();
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return next;
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
  // S13: marked-for-deletion participates as an independent on/off flag.
  if (state.trashed) out.trashed = true;

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
 * Отбор «Хроники»: общая модель критериев + поля этого экрана. Собственной
 * модели панель не держит — тип, парсер и конвертер живут здесь, в единственном
 * модуле конструктора (задача 3742dd59).
 */
export interface ChronicleCriteriaState extends FilterCriteriaState {
  /** Корневые мысли отбора («мысли»). */
  thoughtIds: string[];
  /** Включать подчинённые корневых мыслей. */
  includeSubtree: boolean;
  /** Сторона связи, на которой должна быть выбранная мысль. */
  linkScope: ChronicleLinkScope;
  /** Границы периода хроно-комментариев (`YYYY-MM-DD`). */
  dateFrom: string;
  dateTo: string;
}

/** Пустой отбор «Хроники» — все мысли сети. */
export function defaultChronicleCriteriaState(): ChronicleCriteriaState {
  return {
    ...defaultFilterCriteriaState(),
    thoughtIds: [],
    includeSubtree: false,
    linkScope: 'both',
    dateFrom: '',
    dateTo: '',
  };
}

/**
 * Читает сохранённое определение отбора «Хроники» (`ChronicleFilterDefinition`,
 * в т.ч. записанное до 0.8.2) в общую модель. Незнакомые поля игнорируются;
 * старые определения читаются теми же ключами — формат хранения не меняется.
 */
export function parseChronicleCriteria(def: unknown): ChronicleCriteriaState {
  const next = defaultChronicleCriteriaState();
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return next;
  const parsed = def as Record<string, unknown>;
  const common = parseFilterDefinition(parsed);
  Object.assign(next, common);
  if (Array.isArray(parsed['thought_ids'])) {
    next.thoughtIds = (parsed['thought_ids'] as string[]).slice();
  }
  if (parsed['include_subtree'] === true) next.includeSubtree = true;
  const scope = parsed['link_scope'];
  if (scope === 'sources' || scope === 'targets' || scope === 'both') next.linkScope = scope;
  if (typeof parsed['date_from'] === 'string') next.dateFrom = parsed['date_from'];
  if (typeof parsed['date_to'] === 'string') next.dateTo = parsed['date_to'];
  // `parseFilterDefinition` читает только общие границы; у «Хроники» период —
  // свои поля, а `created_after`/`updated_*` в её определении не участвуют.
  next.createdAfter = '';
  next.createdBefore = '';
  next.updatedAfter = '';
  next.updatedBefore = '';
  if (typeof parsed['order'] === 'string' && isSortOrder(parsed['order'])) next.order = parsed['order'];
  return next;
}

/**
 * Конвертер отбора «Хроники» в wire-определение `ChronicleFilterDefinition`.
 * Ключи совпадают с форматом сохранённых отборов — ранее сохранённое
 * читается и перезаписывается без потерь.
 */
export function buildChronicleWire(state: ChronicleCriteriaState): ChronicleFilterDefinition {
  const out: ChronicleFilterDefinition = { order: state.order };
  if (state.keywords.trim() !== '') out.keywords = state.keywords.trim();
  if (state.thoughtIds.length > 0) out.thought_ids = state.thoughtIds.slice();
  if (state.includeSubtree) out.include_subtree = true;
  if (state.typeIds.length > 0) out.type_ids = state.typeIds.slice();
  if (state.linkTypeIds.length > 0) out.link_type_ids = state.linkTypeIds.slice();
  // `link_scope` отдаём всегда (как прежний конвертер «Хроники»): сервер
  // принимает и «both», а сохранённые определения читаются одинаково.
  out.link_scope = state.linkScope;
  if (state.dateFrom.trim() !== '') out.date_from = state.dateFrom.trim();
  if (state.dateTo.trim() !== '') out.date_to = state.dateTo.trim();
  Object.assign(out, buildAuthorPair('created_by', state.authorOp, state.authorId, state.authorIds));
  Object.assign(out, buildAuthorPair('updated_by', state.editorOp, state.editorId, state.editorIds));
  return out;
}

/** Пара `{ <field>, <field>_op }` одного условия авторства (§59119797). */
function buildAuthorPair(
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

/** План запроса «Событий»: что спросить у сервера, а что дофильтровать клиентом. */
export interface ActivityQueryPlan {
  /** Типы сущностей: пустой выбор — все известные типы. */
  entityTypes: ActivityEntityType[];
  /**
   * `user_id` для веера запросов: `null` — без фильтра по пользователю.
   * `eq`/`ne`/`in`/`not_in` дают список; у `ne` и `not_in` фильтр сервер не
   * умеет, он дофильтровывается клиентом (см. {@link ActivityQueryPlan.clientFilter}).
   */
  userIds: Array<string | null>;
  /** Коды действий (`null` — без фильтра). Серверного `action` нет — фильтр клиентский. */
  actions: Set<ActivityActionFilter> | null;
  /** Мини-синтаксис ключевых слов (`null` — без фильтра). Фильтр клиентский. */
  keywords: ParsedKeywords | null;
  /** Какие условия применяются на клиенте (серверный API их не выражает). */
  clientFilter: {
    actions: boolean;
    keywords: boolean;
    /** `user_id` пуст/непуст (`IS NULL`) — у сервера такого отбора нет. */
    userEmpty: boolean;
    /** `user_id != id` (`ne`) — сервер умеет только равенство/список. */
    userNotEqual: boolean;
    /** `user_id NOT IN list` — сервер умеет только `IN`. */
    userNotIn: boolean;
  };
}

/**
 * Строит план запроса «Событий» из общей модели. Часть отбора серверный API
 * выразить не может — она помечена в `clientFilter` и применяется клиентом
 * явно (панель «Событий»), а не теряется.
 */
export function buildActivityQueryPlan(
  state: ActivityCriteriaState,
  allEntityTypes: readonly ActivityEntityType[],
): ActivityQueryPlan {
  const entityTypes = state.entityTypes.length === 0 ? [...allEntityTypes] : state.entityTypes;
  const actions =
    state.actions.length === 0 ? null : new Set<ActivityActionFilter>(state.actions);
  const keywords = state.keywords.trim() === '' ? null : parseKeywords(state.keywords);

  const op = state.authorOp;
  let userIds: Array<string | null>;
  let userNotEqual = false;
  let userNotIn = false;
  if (op === 'empty' || op === 'not_empty') {
    userIds = [null];
  } else if (op === 'eq') {
    userIds = [state.authorId === '' ? null : state.authorId];
  } else if (op === 'ne') {
    // Сервер равенства не исключает — веер по всем не нужен, дофильтруем клиентом.
    userIds = [state.authorId === '' ? null : state.authorId];
    userNotEqual = state.authorId !== '';
  } else if (op === 'not_in') {
    userIds = [null];
    userNotIn = state.authorIds.length > 0;
  } else {
    userIds = state.authorIds.length === 0 ? [null] : state.authorIds.slice();
  }

  return {
    entityTypes,
    userIds,
    actions,
    keywords,
    clientFilter: {
      actions: actions !== null,
      keywords: keywords !== null,
      userEmpty: op === 'empty' || op === 'not_empty',
      userNotEqual,
      userNotIn,
    },
  };
}

/** Строка «Событий» в объёме, нужном клиентской дофильтровке. */
export interface ActivityFilterableRow {
  user_id: string;
  action: string;
  entity_title: string;
}

/**
 * Клиентская дофильтровка строки «Событий» по условиям, которые серверный API
 * не выражает (действие, пустой/непустой пользователь, `ne`/`not_in`,
 * ключевые слова). Зеркало серверной семантики, а не второй конвертер.
 */
export function activityRowPasses(state: ActivityCriteriaState, plan: ActivityQueryPlan, row: ActivityFilterableRow): boolean {
  if (plan.actions !== null && !plan.actions.has(row.action as ActivityActionFilter)) return false;
  if (plan.clientFilter.userEmpty) {
    const empty = row.user_id === '';
    if (state.authorOp === 'empty' && !empty) return false;
    if (state.authorOp === 'not_empty' && empty) return false;
  }
  if (plan.clientFilter.userNotEqual && row.user_id === state.authorId) return false;
  if (plan.clientFilter.userNotIn && state.authorIds.includes(row.user_id)) return false;
  if (plan.keywords !== null && !matchesKeywords(row.entity_title, plan.keywords)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Настройки отбора строки поиска карты (§3.2): общая модель + её wire
// ---------------------------------------------------------------------------

/**
 * Отбор строки поиска карты: общая модель критериев + поля этого экрана.
 * Общие `typeIds`/`linkTypeIds`/`authorId`/`editorId`/`trashed` берутся у
 * модели; группы результатов и поддерево — только у поиска.
 */
export interface SearchCriteriaState extends FilterCriteriaState {
  subtree: boolean;
  /**
   * Мысли-подкорни: поиск идёт среди потомков ЛЮБОЙ из них (объединение
   * результатов). Пустой набор при `subtree` — прежнее поведение: подкорень =
   * текущий фокус (задача a3247f84; до неё хранился один `subrootId`).
   */
  subrootIds: string[];
  onlyThoughts: boolean;
  onlyLinks: boolean;
  onlyChrono: boolean;
  /** «Показывать неактуальные» (у поиска нет трёхзначной актуальности). */
  showInactive: boolean;
}

/** Пустые настройки поиска. */
export function defaultSearchCriteriaState(): SearchCriteriaState {
  return {
    ...defaultFilterCriteriaState(),
    subtree: false,
    subrootIds: [],
    onlyThoughts: false,
    onlyLinks: false,
    onlyChrono: false,
    showInactive: false,
  };
}

/**
 * Читает сохранённые настройки поиска (`search_state`), в т.ч. записанные
 * ранее со старыми ключами (`subrootId`, `typeIds`, `linkTypeIds`,
 * `showInactive`, `authorId`, `editorId`) — одиночный `subrootId` прошлых
 * версий читается как набор из одной мысли.
 */
export function parseSearchCriteria(raw: unknown): SearchCriteriaState {
  const next = defaultSearchCriteriaState();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return next;
  const o = raw as Record<string, unknown>;
  if (o['subtree'] === true) next.subtree = true;
  if (Array.isArray(o['subrootIds'])) {
    next.subrootIds = (o['subrootIds'] as string[]).slice();
  } else if (typeof o['subrootId'] === 'string') {
    // Совместимость с `search_state`, записанным до 0.8.2.
    next.subrootIds = [o['subrootId']];
  }
  if (o['onlyThoughts'] === true) next.onlyThoughts = true;
  if (o['onlyLinks'] === true) next.onlyLinks = true;
  if (o['onlyChrono'] === true) next.onlyChrono = true;
  if (Array.isArray(o['typeIds'])) next.typeIds = (o['typeIds'] as string[]).slice();
  if (Array.isArray(o['linkTypeIds'])) next.linkTypeIds = (o['linkTypeIds'] as string[]).slice();
  if (o['showInactive'] === true) next.showInactive = true;
  if (o['trashed'] === true) next.trashed = true;
  if (typeof o['authorId'] === 'string') next.authorId = o['authorId'];
  if (typeof o['editorId'] === 'string') next.editorId = o['editorId'];
  return next;
}

/**
 * Мысли-подкорни, по которым пойдёт серверный поиск: при включённом `subtree`
 * — выбранные пользователем, а если их не выбрали — текущий фокус (прежнее
 * поведение); без ограничения — один `null` («без подкорня»). Чистая функция:
 * строку поиска с несколькими подкорнями обслуживает объединение запросов.
 */
export function searchSubtreeRoots(
  state: SearchCriteriaState,
  focusId: string | null,
): Array<string | null> {
  if (!state.subtree) return [null];
  return state.subrootIds.length > 0 ? state.subrootIds.slice() : [focusId];
}

/** Часть параметров серверного поиска, вырастающая из критериев отбора. */
export interface SearchCriteriaWire {
  type_id?: string[];
  link_type_id?: string[];
  show_inactive: boolean;
  trashed: boolean;
  author_id?: string;
  editor_id?: string;
}

/** Конвертер критериев поиска в параметры запроса (без `q`/`scope`/подкорня). */
export function buildSearchCriteriaWire(state: SearchCriteriaState): SearchCriteriaWire {
  const out: SearchCriteriaWire = {
    show_inactive: state.showInactive,
    trashed: state.trashed,
  };
  if (state.typeIds.length > 0) out.type_id = state.typeIds.slice();
  if (state.linkTypeIds.length > 0) out.link_type_id = state.linkTypeIds.slice();
  if (state.authorId.trim() !== '') out.author_id = state.authorId;
  if (state.editorId.trim() !== '') out.editor_id = state.editorId;
  return out;
}

/**
 * Конвертер критериев поиска в сохраняемый L4-набор `search_state` — те же
 * ключи, что писал клиент до 0.8.2 (совместимость чтения сохранённого без
 * миграции). Подкорней теперь набор (`subrootIds`); одиночный `subrootId`
 * прошлых версий пишется первым элементом набора — старый клиент прочтёт его.
 */
export function searchCriteriaToStored(state: SearchCriteriaState): Record<string, unknown> {
  return {
    subtree: state.subtree,
    subrootIds: state.subrootIds.slice(),
    subrootId: state.subrootIds[0] ?? null,
    onlyThoughts: state.onlyThoughts,
    onlyLinks: state.onlyLinks,
    onlyChrono: state.onlyChrono,
    typeIds: state.typeIds.slice(),
    linkTypeIds: state.linkTypeIds.slice(),
    showInactive: state.showInactive,
    trashed: state.trashed,
    authorId: state.authorId,
    editorId: state.editorId,
  };
}
