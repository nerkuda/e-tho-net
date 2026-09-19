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
 * (`alpha`/`created`/`viewed`): конструктор сохраняет только то, что
 * исполнитель в состоянии исполнить. Сохранённые ранее значения вне набора
 * (легаси `updated` из старого диалога) исполнитель принимает с явным
 * сообщением, а не отбрасывает молча — требование «Сортировки отбора:
 * единый набор…» и ошибка 33a3e285. Когда сервер научится сортировать по
 * дате изменения, `updated` добавится в один этот модуль и появится сразу
 * в обеих панелях и в исполнителе.
 */

import {
  SORT_ORDERS,
  STRUCTURE_AUTHOR_OPS,
  STRUCTURE_SORTS,
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
  return raw === 'updated' ? 'по дате изменения (updated)' : raw;
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
  }
  if (typeof parsed['updated_by'] === 'string') {
    next.editorId = parsed['updated_by'];
    if (typeof parsed['updated_by_op'] === 'string') next.editorOp = parsed['updated_by_op'] as StructureAuthorOp;
  } else if (Array.isArray(parsed['updated_by'])) {
    next.editorIds = (parsed['updated_by'] as string[]).slice();
    next.editorOp = (parsed['updated_by_op'] as StructureAuthorOp | undefined) ?? 'in';
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
  const authorWire = buildAuthorWireValue(state.authorOp, state.authorId, state.authorIds);
  if (authorWire !== undefined) {
    out.created_by = authorWire;
    if (state.authorOp !== 'eq') out.created_by_op = state.authorOp;
  }
  const editorWire = buildAuthorWireValue(state.editorOp, state.editorId, state.editorIds);
  if (editorWire !== undefined) {
    out.updated_by = editorWire;
    if (state.editorOp !== 'eq') out.updated_by_op = state.editorOp;
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
