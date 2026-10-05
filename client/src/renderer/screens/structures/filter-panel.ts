/**
 * Filter panel of the «Структуры мыслей» view (L15, 08-ui-spec.md §15.3).
 *
 * Каркас формы (блоки с маркером, ключевые слова с областью поиска, чип-поля
 * сущностей, условия по свойствам, «Дополнительно», автор/редактор, даты,
 * сортировка, футер) строит общий модуль `lib/filter-form.ts`, а условия —
 * единый конструктор `lib/filter-builder.ts` (ADR «условия отбора строит один
 * конструктор с одной моделью состояния», стандарт S4). Панель держит только
 * свои критерии (обход по связям, ширина, id сохранённого отбора) и жизненный
 * цикл отбора.
 *
 * Задача 3742dd59: собственный каркас панели, собственные чипы и собственные
 * строки условий убраны — панель собирает те же секции, что диалог отбора
 * типа мысли, «Хроника», «События» и строка поиска карты.
 */

import {
  type LinkTypeFilterInput,
  type NetworkProperty,
  type SavedFilterDefinition,
  type StructureFilter,
  type StructureKeywordScope,
  type StructurePropertyCondition,
} from '@etn/shared';
import { t } from '../../lib/i18n.js';

import { pickedThoughtIds, pickThoughtsDialog } from '../../canvas/add-dialog.js';
import { clear, div, el, setTooltip } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import {
  buildEntityChipField,
  filterEntityOptions,
  linkTypeEntityOptions,
  pickEntitiesModal,
  thoughtTypeEntityOptions,
} from '../../lib/entity-picker.js';
import {
  buildAuthorshipSection,
  buildConditionsSection,
  buildDatesSection,
  buildEntityChipSection,
  buildExtrasSection,
  buildFilterBlock,
  buildFilterFooterButtons,
  buildFilterForm,
  buildKeywordsSection,
  buildParentThoughtsSection,
  buildSortSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import {
  buildSavedFilterBar,
  type SavedFilterBarHandle,
  type SavedFilterEntry,
  type SavedFilterStore,
} from '../../lib/saved-filter-bar.js';
import type { SuggestSource } from '../../lib/suggest-dropdown.js';
import { registerThoughtDropField } from '../../lib/thought-drop.js';
import { matchesKeyPrefix, onQueryInvalidated, queryKeys } from '../../lib/live/index.js';
import { store } from '../../state.js';
import { requireNetworkId } from '../../app.js';
import { checkboxRow } from '../../lib/ui/choice-row.js';

import {
  authorFilterActive,
  buildConditionsWire,
  buildKeywordScope as builderKeywordScope,
  buildWireFilter,
  datesActive,
  defaultFilterCriteriaState,
  parseFilterDefinition,
  withReverseLinkPropertySides,
  type FilterCriteriaState,
} from '../../lib/filter-builder.js';

/** Filter-panel width limits, px (the splitter drag clamps to this range). */
export const FILTER_W_MIN = 230;
export const FILTER_W_MAX = 420;

/**
 * Подписи группы обхода (ошибка 6158d2ea): прежние «Обход по связям» и
 * «структурные связи» не объясняли, что ограничивают, и повторяли слово
 * «связи» из соседней группы «Типы связей».
 */
const TRAVERSAL_TITLE = 'Выбирать потомков по связям';
const TRAVERSAL_UNTYPED_LABEL = 'учитывать связи без типа';
const TRAVERSAL_DISABLED_HINT = 'Доступно при заполненных «Родительских мыслях»';

/** Full filter-panel state (persisted as the L4 `structures_state` JSON).
 *  Общая часть критериев — модель `FilterCriteriaState` единого конструктора
 *  (`lib/filter-builder.ts`); здесь только панельные дополнения. */
export interface FilterState extends FilterCriteriaState {
  /**
   * Задача c965ad03 «Фильтр обхода по типам связей»: типы связей, по которым
   * раскрывается `parentIds` (поддерево). Отличие от `linkTypeIds`: тот
   * отбирает мысли, у которых есть связь перечисленных типов, а этот
   * ограничивает рёбра обхода.
   */
  linkFilterTypeIds: string[];
  /** Включить нетипизированные (структурные) связи в обход. */
  linkFilterStructural: boolean;
  savedFilterId: string | null;
  /**
   * Ширина панели из ПРЕЖНЕГО пер-экранного снимка `structures_state`
   * (задача 2ebe4206): читается как миграционное значение для каркаса панели,
   * пока в локальном `ui_state.structures_filter_panel` своего размера нет.
   * Сама панель ширину больше не пишет — размером владеет каркас.
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

/** Default panel state: empty filter → HOME only (§15.3). */
function defaultState(): FilterState {
  return {
    ...defaultFilterCriteriaState(),
    linkFilterTypeIds: [],
    linkFilterStructural: false,
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

/** Property registry: id → registry row (0.6.5: one property, one id). */
const propertyDefs = new Map<string, NetworkProperty>();
/** Строка сохранённых отборов (общий модуль `lib/saved-filter-bar.ts`). */
let savedBar: SavedFilterBarHandle | null = null;
/** Имя отбора в поле строки — переживает перерисовку панели. */
let filterName = '';
/** Signature of the catalogues the panel depends on (rebuild on change). */
let catalogueSignature = '';

/** Collapse state of the collapsible groups (transient, not persisted). */
let propertiesCollapsed = true;
let extraCollapsed = true;
/**
 * «Автор / Редактор» — своя переменная сворачивания. Задача 3742dd59: раньше
 * группа делила её с «Дополнительно», и обе схлопывались вместе.
 */
let authorCollapsed = true;
let datesCollapsed = true;

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
  propertiesCollapsed = state.properties.length === 0;
  extraCollapsed = !extrasActive(state);
  authorCollapsed =
    !authorFilterActive(state.authorOp, state.authorId, state.authorIds) &&
    !authorFilterActive(state.editorOp, state.editorId, state.editorIds);
  datesCollapsed = !datesActive(state);
  renderPanel();
}

/**
 * Размер панели (ширина/высота) и её скрытость теперь принадлежат общему
 * каркасу панели отбора (`lib/filter-panel-frame.ts`, задача 2ebe4206) — они
 * живут в локальном `ui_state.structures_filter_panel` и переживают перезапуск.
 * Панель отдаёт только миграционное значение прежнего снимка `structures_state`
 * через `getFilterState().panelWidth`.
 */

/** Wire `keyword_scope` from the panel checkboxes (bug fix 0.5.5) — единый
 *  конвертер конструктора (`lib/filter-builder.ts`). */
export function buildKeywordScope(): StructureKeywordScope[] | undefined {
  return builderKeywordScope(state);
}

/** Wire property conditions built from the panel rows (typed conversion) —
 *  единый конвертер конструктора (`lib/filter-builder.ts`). Реестр — с
 *  обратными сторонами свойств-связей (`registryWithSides`), иначе условие по
 *  обратному имени молча выпало бы из запроса. */
export function buildConditions(): StructurePropertyCondition[] {
  return buildConditionsWire(state, registryWithSides());
}

/** The «Родительские мысли»/«Дополнительно» fields of the wire filter (§15.3)
 *  — единый конвертер конструктора (`lib/filter-builder.ts`). */
export function buildExtraFilter(): Pick<
  StructureFilter,
  | 'parent_ids'
  | 'has_properties'
  | 'has_comment'
  | 'has_attachments'
  | 'has_chronology'
  | 'active'
  | 'trashed'
  | 'created_by'
  | 'created_by_op'
  | 'updated_by'
  | 'updated_by_op'
  | 'created_after'
  | 'created_before'
  | 'updated_after'
  | 'updated_before'
> {
  const wire = buildWireFilter(state, registryWithSides(), {
    activeMode: 'structures',
    showInactive: store.state.showInactive,
    showTrash: store.state.showTrash,
  });
  const out: ReturnType<typeof buildExtraFilter> = {};
  if (wire.parent_ids !== undefined) out.parent_ids = wire.parent_ids;
  if (wire.has_properties !== undefined) out.has_properties = wire.has_properties;
  if (wire.has_comment !== undefined) out.has_comment = wire.has_comment;
  if (wire.has_attachments !== undefined) out.has_attachments = wire.has_attachments;
  if (wire.has_chronology !== undefined) out.has_chronology = wire.has_chronology;
  if (wire.active !== undefined) out.active = wire.active;
  if (wire.trashed !== undefined) out.trashed = wire.trashed;
  if (wire.created_by !== undefined) out.created_by = wire.created_by;
  if (wire.created_by_op !== undefined) out.created_by_op = wire.created_by_op;
  if (wire.updated_by !== undefined) out.updated_by = wire.updated_by;
  if (wire.updated_by_op !== undefined) out.updated_by_op = wire.updated_by_op;
  if (wire.created_after !== undefined) out.created_after = wire.created_after;
  if (wire.created_before !== undefined) out.created_before = wire.created_before;
  if (wire.updated_after !== undefined) out.updated_after = wire.updated_after;
  if (wire.updated_before !== undefined) out.updated_before = wire.updated_before;
  return out;
}

/**
 * Ошибка 6158d2ea: группа «Выбирать потомков по связям» применима только когда
 * заполнены «Родительские мысли» — без них обходить нечего. Погашенная группа
 * не попадает в запрос и не делает отбор непустым (иначе вид перестаёт
 * показывать HOME с сиротами).
 */
function traversalEnabled(): boolean {
  return state.parentIds.length > 0;
}

/** Заполнена ли группа обхода с учётом доступности (маркер и подсветка). */
function traversalActive(): boolean {
  return traversalEnabled() && (state.linkFilterTypeIds.length > 0 || state.linkFilterStructural);
}

/**
 * Wire `link_filter` обхода (задача c965ad03): ограничивает рёбра, по которым
 * `parent_ids` раскрывается в поддерево. `undefined` — без ограничения (в том
 * числе когда «Родительские мысли» пусты: обходить нечего — ошибка 6158d2ea).
 */
export function buildTraversalFilter(): LinkTypeFilterInput | undefined {
  if (!traversalEnabled()) return undefined;
  if (state.linkFilterTypeIds.length === 0 && !state.linkFilterStructural) return undefined;
  const out: LinkTypeFilterInput = {};
  if (state.linkFilterTypeIds.length > 0) out.type_ids = state.linkFilterTypeIds;
  if (state.linkFilterStructural) out.include_structural = true;
  return out;
}

/** Слой (G6): `saved-filter.*` роутер гасит ключ `saved-filters` — панель
 *  перечитывает свой список отборов сама, без прямого realtime-хука. */
let savedFiltersWired = false;
function wireSavedFiltersToLayer(): void {
  if (savedFiltersWired) return;
  savedFiltersWired = true;
  onQueryInvalidated((prefix) => {
    if (!matchesKeyPrefix(prefix, queryKeys.savedFiltersAll())) return;
    void savedBar?.reload();
  });
}

/** Признаки «Дополнительно» заполнены («Корзина» — независимый флаг, но
 *  участвует только при включённой настройке видимости — задача 77923b49). */
function extrasActive(s: FilterCriteriaState): boolean {
  return (
    s.hasProperties !== null ||
    s.hasComment !== null ||
    s.hasAttachments !== null ||
    s.hasChronology !== null ||
    (s.active !== null && store.state.showInactive) ||
    (s.trashed && store.state.showTrash)
  );
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** Mounts the panel into its host and wires the store subscriptions. */
export function mountFilterPanel(panelHost: HTMLElement, cb: FilterPanelCallbacks): void {
  host = panelHost;
  callbacks = cb;
  // Дроп мысли (pointer-жест) в ЛЮБОЕ место панели добавляет её в
  // «Родительские мысли» отбора — единая трактовка с панелью «Хроники»
  // (задача d144ef71). Чип-поле корней внутри панели имеет собственный приёмник
  // (общий фасад `buildParentThoughtsSection`) и перехватывает дроп точнее.
  registerThoughtDropField(panelHost, {
    accept: (id: string): boolean => {
      if (state.parentIds.includes(id)) return false;
      state.parentIds = [...state.parentIds, id];
      renderPanel();
      callbacks?.onStatePersist();
      return true;
    },
  });
  wireSavedFiltersToLayer();
  renderPanel();

  store.subscribe(() => {
    if (host === null || !host.isConnected) return;
    const signature = `${store.state.networkId ?? ''}|${store.state.thoughtTypes.map((t) => t.id).join(',')}|${store.state.linkTypes.map((t) => t.id).join(',')}|${store.state.showInactive ? 1 : 0}|${store.state.showTrash ? 1 : 0}`;
    if (signature !== catalogueSignature) {
      catalogueSignature = signature;
      void loadPropertyDefs().then(() => renderPanel());
    }
  });
  void loadPropertyDefs().then(() => renderPanel());
}

/**
 * Loads the property registry of the network (0.6.5 — task 171a438e): one
 * REST call replaces the per-type walk the panel used to do.
 */
async function loadPropertyDefs(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  propertyDefs.clear();
  try {
    const rows = await etn.propertyRegistry.list(networkId);
    for (const row of rows) propertyDefs.set(row.id, row);
  } catch {
    // Network read failed — the panel falls back to the empty registry.
  }
}

/**
 * Реестр свойств для конструктора условий: к загруженному реестру добавлены
 * обратные стороны свойств-связей (задача df992826) — в списке имён условий
 * каждая связь реестра представлена ОБЕИМИ сторонами, а не только цепочкой
 * редактируемого типа. Тот же хелпер, что и в диалоге отбора типа мысли: оба
 * места — применения одного конструктора (стандарт S4).
 */
function registryWithSides(): Map<string, NetworkProperty> {
  return withReverseLinkPropertySides(propertyDefs, store.state.linkTypes);
}

// ---------------------------------------------------------------------------
// Apply / clear
// ---------------------------------------------------------------------------

/** Pushes non-empty keywords into the client-local history, then applies. */
function triggerApply(): void {
  pushKwHistory(state.keywords);
  callbacks?.onApply();
}

/** «Очистить»: drops every criterion but keeps «Сортировка» (§15.3). */
function clearAllCriteria(): void {
  state = { ...defaultState(), sort: state.sort, order: state.order, panelWidth: state.panelWidth };
  filterName = '';
  propertiesCollapsed = true;
  extraCollapsed = true;
  authorCollapsed = true;
  datesCollapsed = true;
  renderPanel();
  callbacks?.onStatePersist();
}

// ---------------------------------------------------------------------------
// Keywords history (client-local, §15.3) — источник подсказок общего поля
// ---------------------------------------------------------------------------

const KW_HISTORY_MAX = 10;

function kwHistoryKey(): string {
  return `structures.kw.history.${store.state.networkId ?? ''}`;
}

function loadKwHistory(): string[] {
  try {
    const raw = localStorage.getItem(kwHistoryKey());
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function pushKwHistory(value: string): void {
  const trimmed = value.trim();
  if (trimmed === '') return;
  const next = [trimmed, ...loadKwHistory().filter((v) => v !== trimmed)].slice(0, KW_HISTORY_MAX);
  try {
    localStorage.setItem(kwHistoryKey(), JSON.stringify(next));
  } catch {
    // Storage unavailable/full — the history is a convenience, not critical.
  }
}

/** Источник подсказок «Ключевые слова»: история ввода этого клиента. */
function keywordsHistorySource(): SuggestSource {
  return {
    when: 'always',
    load: () => loadKwHistory().map((word) => ({ value: word, label: word })),
  };
}

// ---------------------------------------------------------------------------
// Panel DOM — общий каркас
// ---------------------------------------------------------------------------

/** Ограничение обхода по связям (задача c965ad03) — панельное дополнение.
 *  Ошибка 6158d2ea: группа доступна только при заполненных «Родительских
 *  мыслях»; пустая — погашена, в запрос не попадает. */
function buildTraversalSection(ctx: FilterFormContext): FilterSection {
  const section = buildFilterBlock(TRAVERSAL_TITLE, {
    isNonEmpty: traversalActive,
  });
  const field = buildEntityChipField({
    getValues: () => [...state.linkFilterTypeIds],
    onChange: (values) => {
      state.linkFilterTypeIds = values;
      ctx.touch();
    },
    loadOptions: (query) => filterEntityOptions(linkTypeEntityOptions(store.state.linkTypes), query),
    optionsHeader: 'Типы связей',
    placeholder: 'Тип связи…',
    addPlaceholder: '+ ещё один тип',
    picker: {
      label: 'Открыть список типов',
      open: () =>
        pickEntitiesModal({
          networkId: requireNetworkId(),
          kind: 'link-types',
          title: TRAVERSAL_TITLE,
          currentIds: state.linkFilterTypeIds,
        }),
    },
    cloudOf: (id) => {
      const type = store.state.linkTypes.find((t) => t.id === id);
      return type === undefined ? null : { id: type.id, title: type.name_forward };
    },
  });
  setTooltip(field.root, 'Ограничить рёбра, по которым раскрывается отбор от «Родительских мыслей»');
  const structural = div('st-f-tri-row');
  const structuralRow = checkboxRow({
    label: TRAVERSAL_UNTYPED_LABEL,
    checked: state.linkFilterStructural,
    onChange: (checked) => {
      state.linkFilterStructural = checked;
      ctx.touch();
    },
  });
  const structuralLabel = structuralRow.row;
  const structuralCheck = structuralRow.input;
  setTooltip(structuralLabel, 'Учитывать связи без типа (нетипизированные рёбра «родитель/потомок») при обходе');
  structural.append(structuralLabel);
  section.body.append(field.root, structural);

  // Доступность пересчитывается при каждом `refresh()` (её меняют «Родительские
  // мысли»): погашенная группа запрещена к вводу и визуально приглушена.
  const baseRefresh = section.refresh;
  const applyAvailability = (): void => {
    const enabled = traversalEnabled();
    field.setDisabled(!enabled);
    structuralCheck.disabled = !enabled;
    section.box.classList.toggle('st-f-block-disabled', !enabled);
    section.head.title = enabled ? '' : TRAVERSAL_DISABLED_HINT;
    baseRefresh();
  };
  section.refresh = applyAvailability;
  applyAvailability();
  return section;
}

/** Rebuilds the whole panel from `state` — секции общего каркаса. */
function renderPanel(): void {
  if (host === null) return;
  clear(host);
  host.classList.add('st-f-layout');

  const sections: FilterSection[] = [];
  const touch = (): void => {
    callbacks?.onStatePersist();
    for (const section of sections) section.refresh();
  };
  const ctx: FilterFormContext = {
    networkId: requireNetworkId(),
    getState: () => state,
    registry: registryWithSides(),
    touch,
  };

  // Порядок групп (ошибка 6158d2ea): Ключевые слова, Типы мыслей, Типы связей,
  // Родительские мысли, Выбирать потомков по связям — «Родительские мысли»
  // стоят перед ограничением обхода, которое без них ни на что не влияет.
  sections.push(
    buildKeywordsSection(ctx, {
      tooltip: 'Слова через пробел, все обязательны; * — любые символы; -слово — исключение.',
      showScope: true,
      suggestSource: keywordsHistorySource(),
      onEnter: triggerApply,
    }),
    buildEntityChipSection(ctx, {
      title: 'Типы мыслей',
      getValues: () => state.typeIds,
      setValues: (values) => {
        state.typeIds = values;
      },
      loadOptions: (query) =>
        filterEntityOptions(thoughtTypeEntityOptions(store.state.thoughtTypes), query),
      optionsHeader: 'Типы мыслей',
      placeholder: 'Название типа…',
      addPlaceholder: '+ ещё один тип',
      picker: {
        label: 'Открыть список типов',
        open: () =>
          pickEntitiesModal({
            networkId: requireNetworkId(),
            kind: 'thought-types',
            title: 'Типы мыслей',
            currentIds: state.typeIds,
          }),
      },
    }),
    buildEntityChipSection(ctx, {
      title: 'Типы связей',
      getValues: () => state.linkTypeIds,
      setValues: (values) => {
        state.linkTypeIds = values;
      },
      loadOptions: (query) =>
        filterEntityOptions(linkTypeEntityOptions(store.state.linkTypes), query),
      optionsHeader: 'Типы связей',
      placeholder: 'Название типа…',
      addPlaceholder: '+ ещё один тип',
      picker: {
        label: 'Открыть список типов',
        open: () =>
          pickEntitiesModal({
            networkId: requireNetworkId(),
            kind: 'link-types',
            title: 'Типы связей',
            currentIds: state.linkTypeIds,
          }),
      },
    }),
    // «Родительские мысли» — ОБЩИЙ фасад `lib/filter-form.ts`
    // (`buildParentThoughtsSection`): тот же чип-лист корней поддеревьев с
    // ленивой догрузкой облачков, что и в рецепте публикации. Своей копии
    // синхронизации облачков у панели больше нет (замечание координатора:
    // не оставлять две копии логики).
    buildParentThoughtsSection(ctx, {
      tooltip: 'Ограничить отбор мыслями, подчинёнными указанным',
      picker: {
        label: 'Выбрать из списка',
        open: async () => {
          const result = await pickThoughtsDialog({
            networkId: requireNetworkId(),
            allowCreate: false,
            allowLinkType: false,
            selectedIds: state.parentIds,
            title: 'Родительские мысли',
            applyLabel: t('actions.apply'),
          });
          return result === null ? null : pickedThoughtIds(result);
        },
      },
    }),
    buildTraversalSection(ctx),
    buildConditionsSection(ctx, { get: () => propertiesCollapsed, set: (v) => (propertiesCollapsed = v) }),
    buildAuthorshipSection(ctx, { get: () => authorCollapsed, set: (v) => (authorCollapsed = v) }),
    buildDatesSection(ctx, { get: () => datesCollapsed, set: (v) => (datesCollapsed = v) }, { mode: 'period' }),
    buildExtrasSection(
      ctx,
      { get: () => extraCollapsed, set: (v) => (extraCollapsed = v) },
      {
        activeDisabled: !store.state.showInactive,
        activeTooltip:
          'Доступно при включённой настройке «Показывать неактуальные мысли и связи» (Настройки мыслесети → Видимость)',
        trashedDisabled: !store.state.showTrash,
        trashedTooltip:
          'Доступно при включённой настройке «Показывать содержимое корзины» (Настройки мыслесети → Видимость)',
      },
    ),
    buildSortSection(ctx),
  );

  // --- sticky footer: Применить/Очистить + строка сохранённых отборов (§15.3) -
  const commandsBtn = el('button', 'st-f-commands', 'Команды ▾');
  commandsBtn.type = 'button';
  setTooltip(commandsBtn, 'Команды над всеми мыслями отбора (без учёта пагинации)');
  commandsBtn.addEventListener('click', () => callbacks?.onCommands(commandsBtn));

  const btnRow = buildFilterFooterButtons({
    onApply: triggerApply,
    onClear: clearAllCriteria,
    extra: [commandsBtn],
  });

  // Строка сохранённых отборов — общий модуль (`lib/saved-filter-bar.ts`):
  // поле имени, дискета (записать), крестик (удалить), «…» (диалог выбора).
  savedBar = buildSavedFilterBar({
    store: savedFilterStore(),
    getName: () => filterName,
    setName: (name) => {
      filterName = name;
    },
    buildDefinition: () => buildSavedDefinition(),
    applyEntry: (entry) => applySavedFilterEntry(entry),
    selectedId: () => state.savedFilterId,
    setSelectedId: (id) => {
      state.savedFilterId = id;
    },
    onPersist: () => callbacks?.onStatePersist(),
  });

  buildFilterForm({ sections, footer: [btnRow, savedBar.root], mount: host });

  for (const section of sections) section.refresh();
}

// ---------------------------------------------------------------------------
// Saved filters (§15.3) — общий каркас `lib/saved-filter-bar.ts`
// ---------------------------------------------------------------------------

/** REST-хранилище отборов вида «Структуры» (`/saved-filters?view=structures`). */
function savedFilterStore(): SavedFilterStore {
  return {
    list: async () =>
      (await etn.savedFilters.list(requireNetworkId())).map((f) => ({
        id: f.id,
        name: f.name,
        definition: f.definition,
      })),
    create: async (name, definition) =>
      toEntry(
        await etn.savedFilters.create(requireNetworkId(), {
          name,
          definition: definition as SavedFilterDefinition,
        }),
      ),
    update: async (id, patch) =>
      toEntry(
        await etn.savedFilters.update(requireNetworkId(), id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.definition !== undefined
            ? { definition: patch.definition as SavedFilterDefinition }
            : {}),
        }),
      ),
    remove: (id) => etn.savedFilters.remove(requireNetworkId(), id),
  };
}

/** Запись хранилища → запись строки сохранённых отборов. */
function toEntry(filter: { id: string; name: string; definition: SavedFilterDefinition }): SavedFilterEntry {
  return { id: filter.id, name: filter.name, definition: filter.definition };
}

/** Определение отбора для записи: общая часть — единый конвертер конструктора,
 *  панельный `link_filter` обхода ложится рядом. */
function buildSavedDefinition(): SavedFilterDefinition {
  const traversalFilter = buildTraversalFilter();
  return {
    ...buildWireFilter(state, registryWithSides(), {
      activeMode: 'structures',
      showInactive: store.state.showInactive,
      showTrash: store.state.showTrash,
    }),
    ...(traversalFilter !== undefined ? { link_filter: traversalFilter } : {}),
  };
}

/** Applies a saved filter to the panel and reruns the query. Общая часть
 *  восстанавливается единым парсером конструктора (`parseFilterDefinition`),
 *  панельные дополнения (обход по связям, id отбора) — здесь. */
function applySavedFilterEntry(entry: SavedFilterEntry): void {
  const def = entry.definition as SavedFilterDefinition;
  const criteria = parseFilterDefinition(def);
  filterName = entry.name;
  setFilterState({
    ...criteria,
    linkFilterTypeIds: def.link_filter?.type_ids ?? [],
    linkFilterStructural: def.link_filter?.include_structural ?? false,
    savedFilterId: entry.id,
    panelWidth: state.panelWidth,
  });
  callbacks?.onApply();
}
