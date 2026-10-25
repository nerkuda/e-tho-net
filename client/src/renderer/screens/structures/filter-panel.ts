/**
 * Панель отбора «Структур» (L15, 08-ui-spec.md §15.3) — на едином редакторе
 * отбора.
 *
 * Задача 213bd2d2 «Пересборка панели «Структур» на дерево» (требование 54cba705
 * «Панель «Структур» пересобрана на единый редактор отбора», ADR fc23f9c1
 * «судьба спец-секций», ADR a9336708 «очерёдность пересборки пяти мест»).
 *
 * Панель больше не собирает собственные секции: условия держит дерево
 * `FilterTreeNode` единой модели `FilterCriteriaState` (ADR 30ff83bb), а вид
 * строит общая фабрика `lib/filter-editor.ts` (профиль контекста `thoughts`).
 * Бывшие спец-секции — обычные строки-условия:
 *
 *   • «Ключевые слова» — строка «Найти слова» с областями поиска в значении;
 *   • «Типы мыслей» — строка «Тип в иерархии» (тип вместе с подтипами);
 *   • «Типы связей» — строка «Тип связи в списке»;
 *   • «Родительские мысли» + «Выбирать потомков по связям» — строка на
 *     «Родителях/Потомках» с оператором «в иерархии» и режимом связей в ячейке
 *     (решение оркестратора 2026-10-12: прежняя пара «корни + фильтр обхода»
 *     заменяется аналогом «в иерархии по всем типам связей»; фасадные
 *     `parent_ids`/`link_filter` из панели уходят);
 *   • «Автор / Редактор», «Создано / Изменено», «Дополнительно», «Свойства» —
 *     строки соответствующих операндов профиля.
 *
 * Панель владеет только своим: жизненным циклом отбора (запрос, L4-состояние),
 * строкой сохранённых отборов вида «Структуры» и политикой видимости плоского
 * контракта §15.3 (`active`/`trashed` по умолчанию — см.
 * {@link buildQueryFilter}).
 */

import {
  FILTER_AST_VERSION,
  type FilterAst,
  type FilterAstEntityKind,
  type FilterAstNode,
  type FilterAstSortKey,
  type NetworkProperty,
  type SavedFilterCriteria,
  type SortOrder,
  type StructureFilter,
  type StructureSort,
} from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { clear } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import {
  buildFilterAst,
  compileFlatCriteriaToAst,
  defaultFilterCriteriaState,
  defaultFilterTreeGroup,
  filterSortFromAstKey,
  filterTreeToAst,
  parseFilterAstState,
  parseFilterDefinitionTree,
  withReverseLinkPropertySides,
  type FilterCriteriaState,
  type FilterTreeLeaf,
  type FilterTreeNode,
} from '../../lib/filter-builder.js';
import {
  filterIssuesFromError,
  filterIssuesFromPayload,
  type FilterIssue,
} from '../../lib/filter-diagnostics.js';
import { canonicalFilterTree } from '../../lib/filter-canonical.js';
import {
  buildFilterEditor,
  type FilterEditorHandle,
} from '../../lib/filter-editor.js';
import { resolveFirstDayOfWeek } from '../../lib/dates.js';
import type { FilterFooterButtonSpec } from '../../lib/filter-footer.js';
import { t } from '../../lib/i18n.js';
import { matchesKeyPrefix, onQueryInvalidated, queryKeys } from '../../lib/live/index.js';
import {
  predefinedFilterIds,
  predefinedFiltersToCreate,
  type PredefinedFilter,
} from '../../lib/predefined-filters.js';
import {
  createSavedFilterController,
  type SavedFilterController,
  type SavedFilterRow,
} from '../../lib/saved-filter-controller.js';
import { registerThoughtDropField } from '../../lib/thought-drop.js';
import { getRtStatus, store } from '../../state.js';

/** Filter-panel width limits, px (the splitter drag clamps to this range). */
export const FILTER_W_MIN = 230;
export const FILTER_W_MAX = 420;

/**
 * Профиль контекста места применения. Панель «Структур» отбирает МЫСЛИ и несёт
 * их видимые характеристики; реестр профилей — `shared/src/filter-profiles.ts`.
 */
export const FILTER_PROFILE = 'thoughts' as const;

/**
 * Полное состояние панели. Критерии — единая модель конструктора
 * (`FilterCriteriaState`: дерево + ключи сортировки); здесь только панельные
 * дополнения.
 *
 * Плоские поля модели (`keywords`, `typeIds`, `parentIds`, …) в новой панели НЕ
 * читаются и не пишутся: их понимает единственный конвертер определения
 * (`parseFilterDefinitionTree`) — так открывается прежний плоский отбор из L4 и
 * из сохранённых отборов.
 */
export interface FilterState extends FilterCriteriaState {
  savedFilterId: string | null;
  /**
   * Ширина панели из ПРЕЖНЕГО пер-экранного снимка `structures_state`
   * (задача 2ebe4206): читается как миграционное значение для каркаса панели,
   * пока в локальном `ui_state.structures_filter_panel` своего размера нет.
   */
  panelWidth: number | null;
}

/** Callbacks the panel fires into the host module. */
export interface FilterPanelCallbacks {
  /** «Применить» clicked (or a saved filter applied) — rerun the query. */
  onApply(): void;
  /** Any field changed — persist the state (L4). */
  onStatePersist(): void;
  /**
   * «Команды ▾» clicked — open the bulk-command menu of the applied filter
   * (L22, §15.3) below the button.
   */
  onCommands(anchor: HTMLElement): void;
}

/** Default panel state: empty tree → плоский пустой отбор (HOME + сироты, §15.3). */
function defaultState(): FilterState {
  return {
    ...defaultFilterCriteriaState(),
    tree: defaultFilterTreeGroup('and'),
    savedFilterId: null,
    panelWidth: null,
  };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
let callbacks: FilterPanelCallbacks | null = null;
let state: FilterState = defaultState();
/** Собранный редактор — перерисовывается целиком при смене данных сети. */
let editor: FilterEditorHandle | null = null;
/** Имя отбора в поле футера — переживает перерисовку панели. */
let filterName = '';
/** Имя применённого сохранённого отбора (`null` — отбор ещё не сохранён). */
let savedFilterName: string | null = null;
/** Снимок определения на момент сохранения (маркер ● футера). */
let savedDefinition: unknown = null;
/** Записи диагностики от сервера (выборка/ошибка) — показываются в строках. */
let serverIssues: readonly FilterIssue[] = [];
/** Property registry: id → registry row (0.6.5: one property, one id). */
const propertyDefs = new Map<string, NetworkProperty>();
/** Signature of the catalogues the panel depends on (rebuild on change). */
let catalogueSignature = '';

/**
 * Подпись входа чтения реестра свойств: сеть, каталоги типов, видимость и
 * rt-статус. Одна функция на оба места чтения — подписку и начальную загрузку
 * монтирования: у начальной загрузки тоже есть «неотработанный» вход, и
 * разошедшиеся формулы дали бы тихое расхождение подписей (ошибка 76282fbc).
 * Статус соединения — вход: после обрыва каталог свойств ОБЯЗАН перечитаться,
 * иначе конструктор условий живёт с пустым реестром до перезапуска.
 */
function catalogueSignatureNow(): string {
  return `${store.state.networkId ?? ''}|${store.state.thoughtTypes.map((t) => t.id).join(',')}|${store.state.linkTypes.map((t) => t.id).join(',')}|${store.state.showInactive ? 1 : 0}|${store.state.showTrash ? 1 : 0}|${getRtStatus(store.state)}`;
}
/** Последний увиденный первый день недели сети (пересборка на смене). */
let firstDayOfWeekSeen = 1;
/** Отписка store-подписки панели (teardown вида, ошибка b5278f9a). */
let unsubscribeStore: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Public API (used by structures.ts / realtime)
// ---------------------------------------------------------------------------

/** Current filter state (source of truth for the query). */
export function getFilterState(): FilterState {
  return state;
}

/** Replaces the state (L4 restore / saved filter applied) and rebuilds the DOM. */
export function setFilterState(next: FilterState): void {
  state = { ...defaultState(), ...next };
  renderPanel();
}

/**
 * Серверная диагностика последнего отбора (выборка/ошибка): строки редактора
 * подсвечиваются, футер запрещает применение красного (требование 44d61c8a).
 */
export function setFilterServerIssues(issues: readonly FilterIssue[]): void {
  serverIssues = issues;
  editor?.refresh();
}

/** Разбор ошибки запроса в записи диагностики (красное ядро — `details.diagnostics`). */
export function filterIssuesFromQueryError(err: unknown): readonly FilterIssue[] {
  return filterIssuesFromError(err);
}

/**
 * Разбор полезной нагрузки выборки: неразрешимые токены AST (требование
 * b7fdab20) и жёлтые/красные записи ядра.
 */
export function filterIssuesFromQueryResult(payload: {
  unresolved?: unknown;
  warnings?: unknown;
}): readonly FilterIssue[] {
  return filterIssuesFromPayload(payload as Parameters<typeof filterIssuesFromPayload>[0]);
}

/**
 * Разбор состояния панели из L4-снимка `structures_state` (неизвестный вход,
 * безопасные значения).
 *
 * Снимок пишет сама модель панели (`FilterState`: дерево + ключи сортировки +
 * плоские поля), поэтому читается он в два приёма:
 *
 *   * снимок ТЕКУЩЕЙ модели (есть `tree`) — дерево и `sortKeys` берутся как
 *     есть, через единый конвертер ({@link filterTreeToAst} +
 *     `parseFilterAstState`); пустые ключи не перебивают сохранённую плоскую
 *     пару `sort`/`order`;
 *   * прежний плоский снимок (camelCase, без `tree`) — критерии компилируются
 *     в дерево ТЕМ ЖЕ конвертером плоских критериев (`compileFlatCriteriaToAst`,
 *     ADR «запрещает вторую точку чтения»), результат читается обратно единым
 *     `parseFilterAstState`.
 *
 * Второй формы отбора панель не заводит. Ошибка ca864656: раньше снимок всегда
 * прогонялся через плоские поля, и дерево условий вместе с ключом-свойством
 * терялись молча.
 */
export function parseFilterState(raw: string): FilterState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return getFilterState();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return getFilterState();
  }
  const rec = parsed as Record<string, unknown>;
  const flat = coerceSnapshotState(rec);
  const model = snapshotModelCriteria(rec, flat);
  const criteria = model ?? fillTreeFromFlat(flat);
  return {
    ...defaultState(),
    ...criteria,
    ...definitionExtras(rec),
  };
}

/**
 * Дерево и ключи сортировки из снимка ТЕКУЩЕЙ модели; `null` — снимок записан
 * прежней плоской панелью (дерева нет) либо дерево нечитаемо. Читает строго тем
 * же конвертером, что и wire-AST: нераспознанный узел отклоняет снимок целиком,
 * а не подменяется пустым отбором.
 */
function snapshotModelCriteria(
  rec: Record<string, unknown>,
  flat: FilterCriteriaState,
): FilterCriteriaState | null {
  const tree = rec['tree'];
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) return null;
  let ast: FilterAst;
  try {
    ast = { version: FILTER_AST_VERSION, filter: filterTreeToAst(tree as FilterTreeNode) };
  } catch {
    return null;
  }
  const sortKeys = coerceSnapshotSortKeys(rec['sortKeys']);
  if (sortKeys.length > 0) ast.sort = sortKeys;
  const model = parseFilterAstState(ast);
  if (sortKeys.length === 0) {
    // Ключей сортировки в снимке нет — пару `sort`/`order` несёт плоская модель
    // прежнего контракта (§15.3), а не дефолт конвертера.
    model.sort = flat.sort;
    model.order = flat.order;
  }
  return { ...model, tree: model.tree ?? defaultFilterTreeGroup('and') };
}

/** Ключи сортировки из снимка модели: только пары «непустой ключ + направление». */
function coerceSnapshotSortKeys(value: unknown): FilterAstSortKey[] {
  if (!Array.isArray(value)) return [];
  const out: FilterAstSortKey[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const key = rec['key'];
    const order = rec['order'];
    if (typeof key !== 'string' || key === '') continue;
    if (order !== 'asc' && order !== 'desc') continue;
    out.push({ key, order });
  }
  return out;
}

/**
 * Снимок прежней панели → плоская модель конструктора. Снимок писался самой
 * моделью `FilterCriteriaState`, поля совпадают 1:1; здесь только защита от
 * неизвестного JSON (тип не тот — берём значение по умолчанию).
 */
function coerceSnapshotState(rec: Record<string, unknown>): FilterCriteriaState {
  const base = defaultFilterCriteriaState();
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const tri = (value: unknown): boolean | null =>
    value === true || value === false ? value : null;
  const sort = rec['sort'];
  const order = rec['order'];
  return {
    ...base,
    keywords: str(rec['keywords'], base.keywords),
    keywordInTitle: rec['keywordInTitle'] !== false,
    keywordInSynonyms: rec['keywordInSynonyms'] !== false,
    keywordInComment: rec['keywordInComment'] === true,
    parentIds: ids(rec['parentIds']),
    typeIds: ids(rec['typeIds']),
    linkTypeIds: ids(rec['linkTypeIds']),
    properties: Array.isArray(rec['properties'])
      ? (rec['properties'] as FilterCriteriaState['properties'])
      : [],
    hasProperties: tri(rec['hasProperties']),
    hasComment: tri(rec['hasComment']),
    hasAttachments: tri(rec['hasAttachments']),
    hasChronology: tri(rec['hasChronology']),
    active: tri(rec['active']),
    trashed: rec['trashed'] === true,
    authorOp: str(rec['authorOp'], base.authorOp) as FilterCriteriaState['authorOp'],
    authorId: str(rec['authorId'], ''),
    authorIds: ids(rec['authorIds']),
    editorOp: str(rec['editorOp'], base.editorOp) as FilterCriteriaState['editorOp'],
    editorId: str(rec['editorId'], ''),
    editorIds: ids(rec['editorIds']),
    createdAfter: str(rec['createdAfter'], ''),
    createdBefore: str(rec['createdBefore'], ''),
    updatedAfter: str(rec['updatedAfter'], ''),
    updatedBefore: str(rec['updatedBefore'], ''),
    sort: (sort === 'alpha' || sort === 'created' || sort === 'viewed' ? sort : base.sort),
    order: (order === 'asc' || order === 'desc' ? order : base.order),
  };
}

/** Плоская модель → дерево единым конвертером (плюс ключи сортировки AST). */
function fillTreeFromFlat(flat: FilterCriteriaState): FilterCriteriaState {
  const ast = compileFlatCriteriaToAst(flat, registryWithSides(), { activeMode: 'structures' });
  if (ast === undefined) return { ...flat, tree: defaultFilterTreeGroup('and'), sortKeys: [] };
  const next = parseFilterAstState(ast, {});
  next.tree = next.tree ?? defaultFilterTreeGroup('and');
  applyLegacyTraversalMode(next.tree);
  return next;
}

/** Панельные дополнения определения (id отбора, миграционная ширина). */
function definitionExtras(parsed: Record<string, unknown>): Pick<FilterState, 'savedFilterId' | 'panelWidth'> {
  return {
    savedFilterId: typeof parsed['savedFilterId'] === 'string' ? parsed['savedFilterId'] : null,
    panelWidth:
      typeof parsed['panelWidth'] === 'number' && Number.isFinite(parsed['panelWidth'])
        ? parsed['panelWidth']
        : null,
  };
}

/**
 * Прочитать определение отбора (сохранённый отбор / снимок L4) в модель панели.
 * Плоское определение прежней панели несёт фасадные `parent_ids` + `link_filter`
 * («корни + фильтр обхода») — обход переводится в аналог «в иерархии по всем
 * типам связей» (решение оркестратора 2026-10-12; ADR fc23f9c1: обход по связям →
 * строка «в иерархии»). Конвертер определения — ЕДИНСТВЕННЫЙ
 * (`parseFilterDefinitionTree`); панель лишь доводит режим связей строки до
 * решения о потери прежнего фасада — своей формы чтения она не заводит.
 */
export function readFilterDefinition(def: unknown): FilterCriteriaState {
  const criteria = parseFilterDefinitionTree(def, { registry: registryWithSides() });
  if (criteria.tree !== null && criteria.tree !== undefined && !isAstDefinition(def)) {
    applyLegacyTraversalMode(criteria.tree);
  }
  return criteria;
}

/** Определение записано формой AST (`{ version, filter }`), а не плоской v1. */
function isAstDefinition(def: unknown): boolean {
  return (
    typeof def === 'object' &&
    def !== null &&
    typeof (def as Record<string, unknown>)['version'] === 'number'
  );
}

/**
 * Прежний «обход по связям» ограничивал рёбра списком типов; в новой модели это
 * тот же оператор «в иерархии», но по ВСЕМ связям — прежний список типов не
 * сохраняется (решение 2026-10-12: пара «корни + фильтр обхода» — неудачное
 * решение, значения переводятся в аналог «в иерархии по всем типам связей»).
 */
function applyLegacyTraversalMode(node: FilterTreeNode): void {
  if (node.kind === 'leaf') {
    const kind = node.entity.kind;
    if (
      (kind === 'parents' || kind === 'children') &&
      (node.operator === 'in_hierarchy' || node.operator === 'not_in_hierarchy') &&
      node.mode === undefined
    ) {
      node.mode = 'all_links';
    }
    return;
  }
  for (const child of node.children) applyLegacyTraversalMode(child);
}

/**
 * Загрузить реестр свойств сети ДО разбора снимка/сохранённого отбора.
 *
 * `false` — чтение не удалось: вход НЕ отработан. Подпись каталога сбрасывается
 * тем же правилом, что и у чтения по подписке (76282fbc), поэтому следующий тик
 * store повторит чтение. Результат возвращается вызывающему: разбор снимка без
 * реестра теряет условия по свойствам, и он обязан отложить переразбор
 * (ошибка cdeb62f1 — прежде отказ здесь глотался).
 */
export async function preloadFilterRegistry(): Promise<boolean> {
  const signature = catalogueSignatureNow();
  const ok = await loadPropertyDefs();
  // Чужую, более новую подпись не трогаем — тот же сторож, что у подписки.
  if (!ok && catalogueSignature === signature) catalogueSignature = '';
  return ok;
}

// ---------------------------------------------------------------------------
// Query — единый источник отбора панели
// ---------------------------------------------------------------------------

/** Несёт ли дерево хотя бы одно условие (пустое дерево — «отбор без условий»). */
export function treeHasConditions(node: FilterTreeNode | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  if (node.kind === 'leaf') return true;
  return node.children.some((child) => treeHasConditions(child));
}

/** Есть ли в дереве условие по операнду этого вида (дефолты видимости уступают). */
function treeUsesKind(node: FilterTreeNode | null | undefined, kind: FilterAstEntityKind): boolean {
  if (node === null || node === undefined) return false;
  if (node.kind === 'leaf') return node.entity.kind === kind;
  return node.children.some((child) => treeUsesKind(child, kind));
}

/**
 * Политика видимости панели «Структур» — прямое наследство плоского контракта
 * §15.3 и серверного компилятора плоского тела
 * (`query-service.ts: compileThoughtQueryToAst`): отбор по умолчанию идёт по
 * АКТУАЛЬНЫМ мыслям и БЕЗ помеченных на удаление.
 *
 * Явное условие дерева по `active`/`trashed` сильнее дефолта; включённая
 * настройка сети «Показывать неактуальные мысли и связи» снимает дефолт по
 * `active` — как снимал его плоский `show_inactive`. Так дерево из редактора
 * даёт тот же результат, что прежняя плоская панель, и не расширяется молча.
 */
export function withVisibilityDefaults(
  filter: FilterAstNode,
  tree: FilterTreeNode | null | undefined,
  opts: { showInactive: boolean },
): FilterAstNode {
  const extra: FilterAstNode[] = [];
  if (!treeUsesKind(tree, 'active') && !opts.showInactive) {
    extra.push({ entity: { kind: 'active' }, operator: 'eq', value: true });
  }
  if (!treeUsesKind(tree, 'trashed')) {
    extra.push({ entity: { kind: 'trashed' }, operator: 'eq', value: false });
  }
  if (extra.length === 0) return filter;
  if ('children' in filter) return { ...filter, children: [...filter.children, ...extra] };
  return { op: 'and', children: [filter, ...extra] };
}

/**
 * Отбор панели в форме запроса: критерии деревом (`ast`) ЛИБО плоский пустой
 * отбор с парой `sort`/`order` (режим HOME + сироты, §15.3).
 */
export type PanelQueryFilter = StructureFilter & { sort?: StructureSort; order?: SortOrder };

/**
 * Отбор панели в wire-форме запроса `POST /thoughts/query`.
 *
 * Пустое дерево (нет ни одного условия) БЕЗ ключей сортировки отдаётся ПЛОСКИМ
 * пустым отбором без `ast` и без пары `sort`/`order`: контракт «нет критериев →
 * HOME + сироты» (§15.3) сервер определяет именно по отсутствию `ast`
 * (`isFilterEmpty`), порядок — по умолчанию сервера. Единственный ключ,
 * выразимый плоской парой (`title`/`created_at`/`updated_at`), остаётся плоской
 * парой — с ключом и направлением из ЧИПА, а не из легаси-полей модели;
 * ключ-свойство, имя стороны свойства-связи и многоуровневая сортировка идут
 * `ast.sort` — единственной формой, которая их выражает.
 *
 * Сортировку панели несёт секция чипов: снятые чипы не оставляют «невидимого»
 * ключа ни в одной из форм (ошибки ca864656 и 32fd6125 — плоская пара бралась из
 * легаси-поля `state.sort`, которого пользователь в интерфейсе не видит).
 */
export function buildQueryFilter(s: FilterState = state): PanelQueryFilter {
  const tree = s.tree ?? null;
  const sortKeys = s.sortKeys ?? [];
  if (!treeHasConditions(tree)) {
    if (sortKeys.length === 0) return {};
    const only = sortKeys.length === 1 ? sortKeys[0] : undefined;
    const legacy = only === undefined ? null : filterSortFromAstKey(only.key);
    if (only !== undefined && legacy !== null) {
      return { sort: legacy, order: only.order };
    }
  }
  const ast: FilterAst = buildFilterAst(s, {
    profile: FILTER_PROFILE,
    // Секция чипов — единственный источник сортировки панели: пустые чипы не
    // воскрешают легаси-пару `state.sort` в `ast.sort` (ошибка 32fd6125).
    sort: sortKeys.length > 0,
  });
  ast.filter = withVisibilityDefaults(ast.filter, tree, {
    showInactive: store.state.showInactive,
  });
  return { ast };
}

/**
 * Определение отбора для сохранения: чистое дерево с сортировкой, БЕЗ дефолтов
 * видимости (видимость — настройка сети, а не семантика отбора). Форма — AST
 * (`{ version, filter, sort? }`); прежние плоские определения читает тот же
 * конвертер — второй формы записи не появляется.
 *
 * Сортировку несёт секция чипов: пустые чипы не оставляют в определении
 * «невидимый» ключ из легаси-поля `state.sort` (ошибка 32fd6125) — определение и
 * пара `sort`/`order` согласованы с чипами в обе стороны записи.
 */
export function buildSavedDefinition(s: FilterState = state): FilterAst {
  return buildFilterAst(s, {
    profile: FILTER_PROFILE,
    sort: (s.sortKeys ?? []).length > 0,
  });
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** Mounts the panel into its host and wires the store subscriptions. */
export function mountFilterPanel(panelHost: HTMLElement, cb: FilterPanelCallbacks): void {
  host = panelHost;
  callbacks = cb;
  // Дроп мысли (pointer-жест) в ЛЮБОЕ место панели добавляет условие
  // «Родители в иерархии (по всем связям)» с этой мыслью — единая трактовка с
  // прежним «Родительскими мыслями» (задача d144ef71), переведённая на аналогию
  // «в иерархии» (решение 2026-10-12).
  registerThoughtDropField(panelHost, {
    kind: 'filter',
    accept: (id: string): boolean => {
      if (addDropRoot(id)) {
        renderPanel();
        callbacks?.onStatePersist();
      }
      return true;
    },
  });
  wireSavedFiltersToLayer();
  firstDayOfWeekSeen = resolveFirstDayOfWeek(store.state.network?.first_day_of_week);
  renderPanel();

  unsubscribeStore?.();
  unsubscribeStore = store.subscribe(() => {
    if (host === null || !host.isConnected) return;
    // Выход из сети (`resetNetwork`) синхронно рассылает `networkId: null`:
    // панель пересобирать не из чего — `renderPanel()` зовёт
    // `requireNetworkId()` и бросил бы, оборвав `resetNetwork` до перехода на
    // экран списка сетей (ошибка b5278f9a). Синхронизируем отслеживаемые
    // значения: при следующем открытии сети подпись каталога не совпадёт и
    // панель перечитает реестр и перерисуется.
    if (store.state.networkId === null) {
      firstDayOfWeekSeen = resolveFirstDayOfWeek(store.state.network?.first_day_of_week);
      catalogueSignature = '';
      return;
    }
    // Смена первого дня недели в «Все настройки» перестраивает открытую
    // панель: календарь точной даты читает настройку заново (ошибка b5278f9a).
    const firstDayOfWeek = resolveFirstDayOfWeek(store.state.network?.first_day_of_week);
    if (firstDayOfWeek !== firstDayOfWeekSeen) {
      firstDayOfWeekSeen = firstDayOfWeek;
      renderPanel();
    }
    // Статус соединения — вход чтения реестра свойств: после обрыва каталог
    // свойств ОБЯЗАН перечитаться, иначе конструктор условий живёт с пустым
    // реестром до перезапуска (ошибка 76282fbc — класс «подпись рендера, снятая
    // до чтения, без rt-статуса»).
    const signature = catalogueSignatureNow();
    if (signature !== catalogueSignature) {
      catalogueSignature = signature;
      void loadPropertyDefs().then((ok) => {
        // Отказ чтения — подпись не считается отработанной: следующий тик store
        // (в первую очередь переход в `connected`) повторит чтение. Чужую,
        // более новую подпись не трогаем.
        if (!ok && catalogueSignature === signature) catalogueSignature = '';
        renderPanel();
      });
    }
  });
  // Начальная загрузка реестра — такой же вход чтения: её отказ обязан
  // оставить подпись «неотработанной» (`''`), иначе устаревшая подпись от
  // прошлого монтирования совпадёт с текущей и следующий тик store не повторит
  // чтение (ошибка 76282fbc, замечание верификатора 2026-10-24). Успех
  // фиксирует подпись — тот же вход подписка повторно не перечитывает.
  const initialSignature = catalogueSignatureNow();
  void loadPropertyDefs().then((ok) => {
    catalogueSignature = ok ? initialSignature : '';
    renderPanel();
  });
}

/**
 * Размонтировать панель (teardown вида): снять редактор вместе с его
 * клавиатурными контекстами и подписками. Без этого `destroy` дерева не
 * вызывается ни разу, и реестр диспетчера клавиш растёт с каждой пересборкой
 * вида.
 */
export function unmountFilterPanel(): void {
  editor?.destroy();
  editor = null;
  unsubscribeStore?.();
  unsubscribeStore = null;
  host = null;
  callbacks = null;
  // Подпись принадлежит смонтированной панели: после unmount она
  // недействительна, и близкое монтирование обязано прочитать реестр заново
  // (ошибка 76282fbc: иначе отказ чтения при совпавшей подписи не повторился бы).
  catalogueSignature = '';
}

/**
 * Добавить брошенную мысль в строку «Родители в иерархии (по всем связям)»:
 * строка есть — мысль дописывается в её список; нет — строка создаётся.
 */
function addDropRoot(id: string): boolean {
  const root = state.tree ?? defaultFilterTreeGroup('and');
  if (root.kind !== 'group') {
    state.tree = {
      op: 'and',
      children: [root, hierarchyLeafFor([id])],
    } as FilterTreeNode;
    return true;
  }
  const existing = root.children.find(isHierarchyRootsLeaf);
  if (existing !== undefined && existing.kind === 'leaf') {
    const items = existing.value.kind === 'list' ? existing.value.items : [];
    if (items.includes(id)) return false;
    existing.value = { kind: 'list', items: [...items, id] };
    return true;
  }
  root.children = [...root.children, hierarchyLeafFor([id])];
  state.tree = root;
  return true;
}

/** Строка «Родители в иерархии — по всем связям» с указанными корнями. */
function hierarchyLeafFor(ids: string[]): FilterTreeLeaf {
  return {
    kind: 'leaf',
    entity: { kind: 'parents' },
    operator: 'in_hierarchy',
    mode: 'all_links',
    value: { kind: 'list', items: [...ids] },
  };
}

/** Строка-«корни» дропа: «Родители» + «в иерархии» + режим всех связей. */
function isHierarchyRootsLeaf(node: FilterTreeNode): boolean {
  return (
    node.kind === 'leaf' &&
    node.entity.kind === 'parents' &&
    (node.operator === 'in_hierarchy' || node.operator === 'not_in_hierarchy') &&
    node.mode === 'all_links'
  );
}

/**
 * Loads the property registry of the network (0.6.5 — task 171a438e): one
 * REST call replaces the per-type walk the panel used to use.
 * Returns `false` when the server read failed — the caller must not treat the
 * panel's catalogue signature as worked out then (76282fbc).
 */
async function loadPropertyDefs(): Promise<boolean> {
  const networkId = store.state.networkId;
  if (networkId === null) return true;
  propertyDefs.clear();
  try {
    const rows = await etn.propertyRegistry.list(networkId);
    for (const row of rows) propertyDefs.set(row.id, row);
    return true;
  } catch {
    // Network read failed — the panel falls back to the empty registry; the
    // caller resets its signature so the next store tick retries.
    return false;
  }
}

/**
 * Реестр свойств для конструктора условий: к загруженному реестру добавлены
 * обратные стороны свойств-связей (задача df992826) — тот же хелпер, что и в
 * диалоге отбора типа мысли: оба места — применения одного конструктора (S4).
 */
function registryWithSides(): Map<string, NetworkProperty> {
  return withReverseLinkPropertySides(propertyDefs, store.state.linkTypes);
}

// ---------------------------------------------------------------------------
// Panel DOM — единая фабрика редактора
// ---------------------------------------------------------------------------

/** Rebuilds the whole panel from `state` — единый редактор + футер. */
function renderPanel(): void {
  if (host === null) return;
  // Пересборка = размонтирование прежнего редактора: снять подписки и
  // клавиатурные контексты дерева, иначе реестр диспетчера клавиш копит
  // объявления.
  editor?.destroy();
  editor = null;
  clear(host);
  host.classList.add('st-f-layout');

  editor = buildFilterEditor({
    profile: FILTER_PROFILE,
    networkId: requireNetworkId(),
    // Функция, а не снимок: календарь точной даты читает настройку в момент
    // открытия (ошибка b5278f9a).
    firstDayOfWeek: () => store.state.network?.first_day_of_week,
    // Заголовок панели — из словаря (ошибка 23c7d3e9 п. B1): прежде секция
    // подписывалась профильным «Показать мысли по условиям:».
    title: t('filterEditor.titleThoughts'),
    data: {
      registry: registryWithSides(),
      linkTypes: store.state.linkTypes,
      thoughtTypes: store.state.thoughtTypes,
      // Видимые характеристики места идут первыми строками списка (порядок
      // групп §15.3): слова, типы, обход по связям, даты, видимость.
      contextual: ['keywords', 'type', 'link_type', 'parents', 'children'],
    },
    getState: () => state,
    touch: () => {
      serverIssues = [];
      callbacks?.onStatePersist();
      editor?.refresh();
    },
    // Набор текста в поле значения (ошибка 7d36f439): персист и снятие серверной
    // диагностики — БЕЗ пересборки редактора (поле не теряет фокус и каретку).
    touchValue: () => {
      serverIssues = [];
      callbacks?.onStatePersist();
    },
    host: {
      apply: () => triggerApply(),
      save: (request) => void saveFilter(request),
      reset: () => clearAllCriteria(),
      getName: () => filterName,
      setName: (name) => {
        filterName = name;
      },
      savedName: () => savedFilterName,
      baseline: () => savedDefinition,
      current: () => buildSavedDefinition(),
      issues: () => serverIssues,
    },
    buttons: { extra: footerExtraButtons() },
  });
  host.append(editor.root);
}

/** Кнопки места: массовые команды и выбор сохранённого отбора. */
function footerExtraButtons(): FilterFooterButtonSpec[] {
  return [
    {
      id: 'commands',
      label: 'Команды ▾',
      title: 'Команды над всеми мыслями отбора (без учёта пагинации)',
      onClick: () => {
        const anchor = editor?.root.querySelector<HTMLElement>('.ff-extra--commands');
        if (anchor !== null && anchor !== undefined) callbacks?.onCommands(anchor);
      },
    },
    {
      // Нижний ряд футера — манипуляции с сохранёнными отборами (решение
      // заказчика 2026-10-14, ошибка 4258e694 п.2): кнопка «…» рядом с именем.
      id: 'saved',
      label: 'Отборы…',
      title: 'Выбрать сохранённый отбор',
      place: 'name',
      onClick: () => void openSavedPicker(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Apply / clear
// ---------------------------------------------------------------------------

function triggerApply(): void {
  callbacks?.onApply();
}

/** «Очистить»: drops every criterion but keeps «Сортировка» (§15.3). */
function clearAllCriteria(): void {
  const sort = state.sort;
  const order = state.order;
  const sortKeys = state.sortKeys ?? [];
  state = {
    ...defaultState(),
    sort,
    order,
    sortKeys,
    panelWidth: state.panelWidth,
  };
  filterName = '';
  savedFilterName = null;
  savedDefinition = null;
  serverIssues = [];
  renderPanel();
  callbacks?.onStatePersist();
}

// ---------------------------------------------------------------------------
// Saved filters (§15.3) — общий контроллер `lib/saved-filter-controller.ts`
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Предопределённые наборы (задача 347b307e)
// ---------------------------------------------------------------------------

/** Условия набора одним корнем-группой `И` — определение в форме записи (AST). */
function presetAst(children: FilterAstNode[]): FilterAst {
  return { version: FILTER_AST_VERSION, filter: { op: 'and', children } };
}

/**
 * Предопределённые наборы отбора панели «Структур» — формулировки заказчика
 * ДОСЛОВНО (задача 347b307e). Порядок — как в постановке. Условия несут
 * «Актуальность = да»/«Пометка удаления = нет» явно (не полагаются на дефолты
 * видимости панели, §15.3), кроме набора «Помеченные на удаление» — у него по
 * постановке только «Пометка удаления = да».
 */
export const PREDEFINED_FILTERS: readonly PredefinedFilter[] = [
  {
    name: 'Сиротские мысли (без родителей)',
    definition: presetAst([
      { entity: { kind: 'parents' }, operator: 'is_empty' },
      { entity: { kind: 'active' }, operator: 'eq', value: true },
      { entity: { kind: 'trashed' }, operator: 'eq', value: false },
    ]),
  },
  {
    name: 'Создано на этой неделе',
    definition: presetAst([
      {
        entity: { kind: 'created_at' },
        operator: 'between',
        value: [{ token: '$weekStart' }, { token: '$weekEnd' }],
      },
      { entity: { kind: 'active' }, operator: 'eq', value: true },
      { entity: { kind: 'trashed' }, operator: 'eq', value: false },
    ]),
  },
  {
    name: 'Создано за 30 дней',
    definition: presetAst([
      {
        entity: { kind: 'created_at' },
        operator: 'between',
        value: [{ token: '$today-30d' }, { token: '$today' }],
      },
      { entity: { kind: 'active' }, operator: 'eq', value: true },
      { entity: { kind: 'trashed' }, operator: 'eq', value: false },
    ]),
  },
  {
    name: 'Помеченные на удаление',
    definition: presetAst([{ entity: { kind: 'trashed' }, operator: 'eq', value: true }]),
  },
];

/**
 * Каноничная форма условий определения отбора «Структур» — сопоставление
 * предопределённых наборов «по условиям» (арбитраж 2026-10-14). Определение
 * приводит к дереву РИДЕР ПАНЕЛИ ({@link readFilterDefinition}), поэтому
 * легаси-плоский отбор сравнивается наравне с AST.
 */
export function canonicalDefinition(def: unknown): string {
  return canonicalFilterTree(readFilterDefinition(def).tree);
}

/**
 * Общий контроллер личных отборов «Структур» (0.13.3, задача c0c7b834):
 * перечитывание списка, сохранение, диалог выбора и realtime — одна
 * реализация на три места (`lib/saved-filter-controller.ts`).
 */
let savedFilters: SavedFilterController | null = null;

function savedFilterStore(): {
  list: () => Promise<SavedFilterRow[]>;
  create: (name: string, definition: unknown) => Promise<SavedFilterRow>;
  update: (id: string, patch: { name?: string; definition?: unknown }) => Promise<SavedFilterRow>;
  remove: (id: string) => Promise<void>;
} {
  return {
    list: async () => etn.savedFilters.list(requireNetworkId()),
    create: (name, definition) =>
      etn.savedFilters.create(requireNetworkId(), {
        name,
        definition: definition as SavedFilterCriteria,
      }),
    update: (id, patch) =>
      etn.savedFilters.update(requireNetworkId(), id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.definition !== undefined
          ? { definition: patch.definition as SavedFilterCriteria }
          : {}),
      }),
    remove: (id) => etn.savedFilters.remove(requireNetworkId(), id),
  };
}

/** Создать контроллер один раз на панель (переиспользуется перерисовками). */
function ensureSavedFilters(): SavedFilterController {
  savedFilters ??= createSavedFilterController({
    store: savedFilterStore(),
    getName: () => filterName,
    setName: (name) => {
      filterName = name;
    },
    buildDefinition: () => buildSavedDefinition(),
    applyEntry: (entry) => applySavedFilter(entry),
    getSelectedId: () => state.savedFilterId,
    setSelectedId: (id) => {
      state.savedFilterId = id;
    },
    onSaved: ({ name, definition }) => {
      filterName = name;
      savedFilterName = name;
      savedDefinition = definition;
    },
    onRenamed: (id, name) => {
      if (state.savedFilterId === id) {
        filterName = name;
        savedFilterName = name;
      }
    },
    onUnselected: () => {
      savedFilterName = null;
      savedDefinition = null;
    },
    onPersist: () => callbacks?.onStatePersist(),
    onRefresh: () => editor?.refresh(),
    beforePicker: seedPredefinedFilters,
    afterReload: markPredefinedRows,
  });
  return savedFilters;
}

/**
 * Досоздать отсутствующие предопределённые наборы (при открытии списка отборов,
 * задача 347b307e). Сопоставление — по каноничным условиям
 * (`predefinedFiltersToCreate`), поэтому переименованный пользователем набор НЕ
 * дублируется; конфликт имени с чужим отбором даёт свободное имя
 * (`duplicateFilterName`), падения нет. Ошибка REST (сеть) набор не теряет —
 * он досоздастся при следующем открытии.
 */
async function seedPredefinedFilters(): Promise<void> {
  const controller = ensureSavedFilters();
  const rows = controller.rows();
  const toCreate = predefinedFiltersToCreate(PREDEFINED_FILTERS, rows, canonicalDefinition);
  if (toCreate.length > 0) {
    for (const item of toCreate) {
      try {
        await etn.savedFilters.create(requireNetworkId(), {
          name: item.name,
          definition: item.definition as SavedFilterCriteria,
        });
      } catch {
        // набор досоздастся при следующем открытии списка
      }
    }
  }
  await controller.reload();
}

/** Пометить строки, условия которых совпали с предопределённым набором. */
function markPredefinedRows(rows: SavedFilterRow[]): void {
  const ids = predefinedFilterIds(PREDEFINED_FILTERS, rows, canonicalDefinition);
  for (const row of rows) row.predefined = ids.has(row.id);
}

/** Слой (G6): `saved-filter.*` роутер гасит ключ — панель перечитывает список сама. */
let savedFiltersWired = false;
function wireSavedFiltersToLayer(): void {
  if (savedFiltersWired) return;
  savedFiltersWired = true;
  onQueryInvalidated((prefix) => {
    if (matchesKeyPrefix(prefix, queryKeys.savedFiltersAll())) void ensureSavedFilters().syncRealtime();
  });
}

/** Записать текущий отбор (кнопка «Сохранить» футера). */
function saveFilter(request: { name: string; asCopy: boolean }): void {
  void ensureSavedFilters().save(request);
}

/** Открыть общий диалог выбора сохранённого отбора (кнопка «Отборы…»). */
function openSavedPicker(): void {
  void ensureSavedFilters().openPicker();
}

/**
 * Применить сохранённый отбор к панели и выполнить запрос. Определение читает
 * ЕДИНЫЙ конвертер (`parseFilterDefinitionTree`) — прежний плоский отбор
 * (`parent_ids` + `link_filter`) компилируется в строку «в иерархии».
 */
function applySavedFilter(entry: { id: string; name: string; definition: unknown }): void {
  const criteria = readFilterDefinition(entry.definition);
  state = {
    ...state,
    ...criteria,
    savedFilterId: entry.id,
  };
  filterName = entry.name;
  savedFilterName = entry.name;
  savedDefinition = entry.definition;
  serverIssues = [];
  renderPanel();
  callbacks?.onStatePersist();
  callbacks?.onApply();
}
