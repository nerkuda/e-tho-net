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
  type SavedFilter,
  type StructureFilter,
  type StructureKeywordScope,
  type StructurePropertyCondition,
} from '@etn/shared';

import { pickedThoughtIds, pickThoughtsDialog } from '../../canvas/add-dialog.js';
import { clear, div, el, setTooltip, span } from '../../lib/dom.js';
import { confirmDialog, errorDialog, promptDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import {
  buildEntityChipField,
  linkTypeEntityOptions,
  pickEntitiesModal,
  thoughtEntityOption,
  thoughtTypeEntityOptions,
  type EntityOption,
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
  buildSortSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import type { SuggestSource } from '../../lib/suggest-dropdown.js';
import type { ThoughtCloudInput } from '../../lib/thought-cloud.js';
import { store } from '../../state.js';
import { requireNetworkId } from '../../app.js';

import {
  authorFilterActive,
  buildConditionsWire,
  buildKeywordScope as builderKeywordScope,
  buildWireFilter,
  datesActive,
  defaultFilterCriteriaState,
  parseFilterDefinition,
  type FilterCriteriaState,
} from '../../lib/filter-builder.js';

/** Filter-panel width limits, px (the splitter drag clamps to this range). */
export const FILTER_W_MIN = 230;
export const FILTER_W_MAX = 420;

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
  /** Panel width set by the splitter drag (px), null until first drag. */
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
/** Облачка выбранных родительских мыслей (id → данные облачка, лениво). */
const parentClouds = new Map<string, ThoughtCloudInput>();
let savedFilters: SavedFilter[] = [];
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

/** Records the splitter-dragged panel width for the L4 persist. */
export function setPanelWidth(width: number): void {
  state.panelWidth = width;
}

/**
 * Applies the persisted/splitter panel width to the DOM: sets the `--st-filter-w`
 * variable the CSS uses, or clears it to fall back to the default 33%.
 */
export function applyPanelWidth(): void {
  if (host === null) return;
  const width = state.panelWidth;
  if (width === null) host.style.removeProperty('--st-filter-w');
  else host.style.setProperty('--st-filter-w', `${Math.round(width)}px`);
}

/** Wire `keyword_scope` from the panel checkboxes (bug fix 0.5.5) — единый
 *  конвертер конструктора (`lib/filter-builder.ts`). */
export function buildKeywordScope(): StructureKeywordScope[] | undefined {
  return builderKeywordScope(state);
}

/** Wire property conditions built from the panel rows (typed conversion) —
 *  единый конвертер конструктора (`lib/filter-builder.ts`). */
export function buildConditions(): StructurePropertyCondition[] {
  return buildConditionsWire(state, propertyDefs);
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
  const wire = buildWireFilter(state, propertyDefs, {
    activeMode: 'structures',
    showInactive: store.state.showInactive,
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
 * Wire `link_filter` обхода (задача c965ad03): ограничивает рёбра, по которым
 * `parent_ids` раскрывается в поддерево. `undefined` — без ограничения.
 */
export function buildTraversalFilter(): LinkTypeFilterInput | undefined {
  if (state.linkFilterTypeIds.length === 0 && !state.linkFilterStructural) return undefined;
  const out: LinkTypeFilterInput = {};
  if (state.linkFilterTypeIds.length > 0) out.type_ids = state.linkFilterTypeIds;
  if (state.linkFilterStructural) out.include_structural = true;
  return out;
}

/** Reloads the saved-filter list (called on `saved-filter.*` realtime events). */
export function invalidateSavedFilters(): void {
  void loadSavedFilters();
}

/** Признаки «Дополнительно» заполнены («Корзина» — независимый флаг). */
function extrasActive(s: FilterCriteriaState): boolean {
  return (
    s.hasProperties !== null ||
    s.hasComment !== null ||
    s.hasAttachments !== null ||
    s.hasChronology !== null ||
    (s.active !== null && store.state.showInactive) ||
    s.trashed
  );
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** Mounts the panel into its host and wires the store subscriptions. */
export function mountFilterPanel(panelHost: HTMLElement, cb: FilterPanelCallbacks): void {
  host = panelHost;
  callbacks = cb;
  renderPanel();
  void loadSavedFilters();

  store.subscribe(() => {
    if (host === null || !host.isConnected) return;
    const signature = `${store.state.networkId ?? ''}|${store.state.thoughtTypes.map((t) => t.id).join(',')}|${store.state.linkTypes.map((t) => t.id).join(',')}|${store.state.showInactive ? 1 : 0}`;
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

/** Loads the user's saved filters and re-renders the list. */
async function loadSavedFilters(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    savedFilters = await etn.savedFilters.list(networkId);
  } catch {
    return;
  }
  if (savedListBox !== null) renderSavedList();
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

/** A small absolutely-positioned dropdown anchored right after `anchor`. */
let openDropdownBox: HTMLElement | null = null;
function closeFieldDropdown(): void {
  openDropdownBox?.remove();
  openDropdownBox = null;
}
function openFieldDropdown(anchor: HTMLElement, options: Array<{ label: string; onPick: () => void }>): void {
  closeFieldDropdown();
  if (options.length === 0) return;
  const box = div('st-f-dropdown');
  for (const opt of options) {
    const item = el('div', 'st-f-dropdown-item', opt.label);
    item.addEventListener('mousedown', (event) => {
      // Keep the field focused so the click registers before any blur-close.
      event.preventDefault();
      opt.onPick();
      closeFieldDropdown();
    });
    box.append(item);
  }
  openDropdownBox = box;
  anchor.insertAdjacentElement('afterend', box);
}

// ---------------------------------------------------------------------------
// Panel DOM — общий каркас
// ---------------------------------------------------------------------------

let saveNameInput: HTMLInputElement | null = null;
let savedListBox: HTMLElement | null = null;

/** Догружает облачка уже выбранных родительских мыслей (по id). */
function resolveParentClouds(): void {
  const networkId = store.state.networkId;
  const missing = state.parentIds.filter((id) => !parentClouds.has(id));
  if (networkId === null || missing.length === 0) return;
  void etn.thoughts
    .resolve(networkId, missing)
    .then((refs) => {
      for (const ref of refs) parentClouds.set(ref.id, { ...ref });
      renderPanel();
    })
    .catch(() => undefined);
}

/** Live-search кандидаты мыслей для чип-листа «Родительские мысли». */
async function parentThoughtOptions(query: string): Promise<EntityOption[]> {
  const needle = query.trim();
  if (needle === '') return [];
  try {
    const hits = await etn.thoughts.findDuplicates(requireNetworkId(), needle, [], []);
    return hits.map((hit) => {
      parentClouds.set(hit.id, { ...hit });
      return thoughtEntityOption(hit);
    });
  } catch {
    return [];
  }
}

/** Ограничение обхода по связям (задача c965ad03) — панельное дополнение. */
function buildTraversalSection(ctx: FilterFormContext): FilterSection {
  const section = buildFilterBlock('Обход по связям', {
    isNonEmpty: () => state.linkFilterTypeIds.length > 0 || state.linkFilterStructural,
  });
  const field = buildEntityChipField({
    getValues: () => [...state.linkFilterTypeIds],
    onChange: (values) => {
      state.linkFilterTypeIds = values;
      ctx.touch();
    },
    loadOptions: () => linkTypeEntityOptions(store.state.linkTypes),
    optionsHeader: 'Типы связей',
    placeholder: 'Тип связи…',
    picker: {
      label: 'список типов…',
      open: () =>
        pickEntitiesModal({
          networkId: requireNetworkId(),
          kind: 'link-types',
          title: 'Обход по связям',
          currentIds: state.linkFilterTypeIds,
        }),
    },
    cloudOf: (id) => {
      const type = store.state.linkTypes.find((t) => t.id === id);
      return type === undefined ? null : { id: type.id, title: type.name_forward };
    },
  });
  setTooltip(field.root, 'Ограничить рёбра, по которым раскрывается отбор');
  const structural = div('st-f-tri-row');
  const structuralLabel = el('label', 'checkbox-row') as HTMLLabelElement;
  const structuralCheck = el('input') as HTMLInputElement;
  structuralCheck.type = 'checkbox';
  structuralCheck.checked = state.linkFilterStructural;
  setTooltip(structuralLabel, 'Включить нетипизированные (структурные) связи в обход');
  structuralCheck.addEventListener('change', () => {
    state.linkFilterStructural = structuralCheck.checked;
    ctx.touch();
  });
  structuralLabel.append(structuralCheck, span('структурные связи'));
  structural.append(el('span', 'st-f-tri-label', 'Структура'), structuralLabel);
  section.body.append(field.root, structural);
  return section;
}

/** Rebuilds the whole panel from `state` — секции общего каркаса. */
function renderPanel(): void {
  if (host === null) return;
  clear(host);
  applyPanelWidth();
  host.classList.add('st-f-layout');

  const sections: FilterSection[] = [];
  const touch = (): void => {
    callbacks?.onStatePersist();
    for (const section of sections) section.refresh();
  };
  const ctx: FilterFormContext = {
    networkId: requireNetworkId(),
    getState: () => state,
    registry: propertyDefs,
    touch,
  };

  sections.push(
    buildKeywordsSection(ctx, {
      tooltip: 'Слова через пробел, все обязательны; * — любые символы; -слово — исключение.',
      showScope: true,
      suggestSource: keywordsHistorySource(),
      onEnter: triggerApply,
    }),
    buildEntityChipSection(ctx, {
      title: 'Родительские мысли',
      getValues: () => state.parentIds,
      setValues: (values) => {
        state.parentIds = values;
      },
      loadOptions: (query) => parentThoughtOptions(query),
      optionsHeader: 'Мысли',
      cloudOf: (id) => (id.startsWith('$') ? null : (parentClouds.get(id) ?? null)),
      placeholder: 'Название мысли…',
      tooltip: 'Ограничить отбор мыслями, подчинёнными указанным',
      picker: {
        label: 'выбрать…',
        open: async () => {
          const result = await pickThoughtsDialog({
            networkId: requireNetworkId(),
            allowCreate: false,
            allowLinkType: false,
            selectedIds: state.parentIds,
            title: 'Родительские мысли',
            applyLabel: 'Применить',
          });
          return result === null ? null : pickedThoughtIds(result);
        },
      },
    }),
    buildEntityChipSection(ctx, {
      title: 'Типы мыслей',
      getValues: () => state.typeIds,
      setValues: (values) => {
        state.typeIds = values;
      },
      loadOptions: () => thoughtTypeEntityOptions(store.state.thoughtTypes),
      optionsHeader: 'Типы мыслей',
      placeholder: 'Название типа…',
      picker: {
        label: 'список типов…',
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
      loadOptions: () => linkTypeEntityOptions(store.state.linkTypes),
      optionsHeader: 'Типы связей',
      placeholder: 'Название типа…',
      picker: {
        label: 'список типов…',
        open: () =>
          pickEntitiesModal({
            networkId: requireNetworkId(),
            kind: 'link-types',
            title: 'Типы связей',
            currentIds: state.linkTypeIds,
          }),
      },
    }),
    buildTraversalSection(ctx),
    buildConditionsSection(ctx, { get: () => propertiesCollapsed, set: (v) => (propertiesCollapsed = v) }),
    buildAuthorshipSection(ctx, { get: () => authorCollapsed, set: (v) => (authorCollapsed = v) }),
    buildDatesSection(ctx, { get: () => datesCollapsed, set: (v) => (datesCollapsed = v) }, { mode: 'datetime' }),
    buildExtrasSection(
      ctx,
      { get: () => extraCollapsed, set: (v) => (extraCollapsed = v) },
      {
        activeDisabled: !store.state.showInactive,
        activeTooltip:
          'Доступно при включённой настройке «Показывать неактуальное» (Вид → Неактуальные)',
      },
    ),
    buildSortSection(ctx),
  );

  // --- sticky footer: Применить/Очистить + saved filters (§15.3) -------------
  const commandsBtn = el('button', 'st-f-commands', 'Команды ▾');
  commandsBtn.type = 'button';
  setTooltip(commandsBtn, 'Команды над всеми мыслями отбора (без учёта пагинации)');
  commandsBtn.addEventListener('click', () => callbacks?.onCommands(commandsBtn));

  const btnRow = buildFilterFooterButtons({
    onApply: triggerApply,
    onClear: clearAllCriteria,
    extra: [commandsBtn],
  });

  const saveRow = div('st-f-saverow');
  const saveNameWrap = div('st-f-kw-wrap');
  saveNameInput = el('input', 'st-f-input') as HTMLInputElement;
  saveNameInput.type = 'text';
  saveNameInput.placeholder = 'имя отбора';
  saveNameInput.addEventListener('focus', () => renderSaveDropdown());
  saveNameInput.addEventListener('input', () => renderSaveDropdown());
  saveNameInput.addEventListener('blur', () => window.setTimeout(closeFieldDropdown, 150));
  saveNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeFieldDropdown();
  });
  saveNameWrap.append(saveNameInput);
  const saveBtn = el('button', 'st-f-save', 'Сохранить');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => void saveCurrentFilter());
  const deleteBtn = el('button', 'st-f-save', 'Удалить');
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', () => void deleteNamedFilter());
  saveRow.append(saveNameWrap, saveBtn, deleteBtn);

  savedListBox = div('st-f-savedlist');

  buildFilterForm({ sections, footer: [btnRow, saveRow, savedListBox], mount: host });

  renderSavedList();
  for (const section of sections) section.refresh();
  resolveParentClouds();
}

// ---------------------------------------------------------------------------
// Saved filters (§15.3)
// ---------------------------------------------------------------------------

/** Filters the saved list by the current name-field text (search-as-type). */
function renderSaveDropdown(): void {
  if (saveNameInput === null) return;
  const needle = saveNameInput.value.trim().toLowerCase();
  const matches =
    needle === '' ? savedFilters : savedFilters.filter((f) => f.name.toLowerCase().includes(needle));
  openFieldDropdown(
    saveNameInput.parentElement ?? saveNameInput,
    matches.map((filter) => ({
      label: filter.name,
      onPick: () => {
        if (saveNameInput !== null) saveNameInput.value = filter.name;
        applySavedFilter(filter);
      },
    })),
  );
}

/** Deletes the saved filter whose name matches the name field, after confirming. */
async function deleteNamedFilter(): Promise<void> {
  const name = (saveNameInput?.value ?? '').trim();
  const filter = savedFilters.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (filter === undefined) {
    notice('Отбор с таким именем не найден');
    return;
  }
  await removeSavedFilter(filter);
}

/** Renders the saved-filter list (click — apply; right-click — manage). */
function renderSavedList(): void {
  if (savedListBox === null) return;
  clear(savedListBox);
  if (savedFilters.length === 0) {
    savedListBox.append(el('div', 'st-f-empty', 'Нет сохранённых отборов'));
    return;
  }
  for (const filter of savedFilters) {
    const item = el('button', 'st-f-saved');
    item.type = 'button';
    if (filter.id === state.savedFilterId) item.classList.add('active');
    item.textContent = filter.name;
    item.addEventListener('click', () => applySavedFilter(filter));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const items: MenuItem[] = [
        { label: 'Применить', onClick: () => applySavedFilter(filter) },
        { label: 'Переименовать…', onClick: () => void renameSavedFilter(filter) },
        { label: 'Удалить', danger: true, onClick: () => void removeSavedFilter(filter) },
      ];
      showMenuAt(event.clientX, event.clientY, items);
    });
    savedListBox.append(item);
  }
}

/** Applies a saved filter to the panel and reruns the query. Общая часть
 *  восстанавливается единым парсером конструктора (`parseFilterDefinition`),
 *  панельные дополнения (обход по связям, id отбора, ширина) — здесь. */
function applySavedFilter(filter: SavedFilter): void {
  const def = filter.definition;
  const criteria = parseFilterDefinition(def);
  setFilterState({
    ...criteria,
    linkFilterTypeIds: def.link_filter?.type_ids ?? [],
    linkFilterStructural: def.link_filter?.include_structural ?? false,
    savedFilterId: filter.id,
    panelWidth: state.panelWidth,
  });
  if (saveNameInput !== null) saveNameInput.value = filter.name;
  callbacks?.onApply();
}

/** Saves (or updates by name) the current filter under the entered name. */
async function saveCurrentFilter(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const name = (saveNameInput?.value ?? '').trim();
  if (name === '') {
    notice('Введите имя отбора');
    return;
  }
  const traversalFilter = buildTraversalFilter();
  // Общая часть определения — единый конвертер конструктора; панельный
  // `link_filter` обхода ложится рядом.
  const definition = {
    ...buildWireFilter(state, propertyDefs, {
      activeMode: 'structures',
      showInactive: store.state.showInactive,
    }),
    ...(traversalFilter !== undefined ? { link_filter: traversalFilter } : {}),
  };
  try {
    const created = await etn.savedFilters.create(networkId, { name, definition });
    state.savedFilterId = created.id;
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'DUPLICATE') {
      const existing = savedFilters.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (existing !== undefined) {
        const updated = await etn.savedFilters.update(networkId, existing.id, { definition });
        state.savedFilterId = updated.id;
      }
    } else {
      errorDialog('Сохранить отбор', err);
      return;
    }
  }
  callbacks?.onStatePersist();
  await loadSavedFilters();
  renderSavedList();
  notice(`Отбор «${name}» сохранён`);
}

/** Renames a saved filter via the prompt dialog. */
async function renameSavedFilter(filter: SavedFilter): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const name = await promptDialog('Переименовать отбор', 'Имя', filter.name);
  if (name === null || name.trim() === '' || name.trim() === filter.name) return;
  try {
    await etn.savedFilters.update(networkId, filter.id, { name: name.trim() });
  } catch (err) {
    errorDialog('Переименовать отбор', err);
    return;
  }
  await loadSavedFilters();
}

/** Deletes a saved filter after a confirmation. */
async function removeSavedFilter(filter: SavedFilter): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const confirmed = await confirmDialog('Удалить отбор', `Удалить сохранённый отбор «${filter.name}»?`, true);
  if (!confirmed) return;
  try {
    await etn.savedFilters.remove(networkId, filter.id);
  } catch (err) {
    errorDialog('Удалить отбор', err);
    return;
  }
  if (state.savedFilterId === filter.id) {
    state.savedFilterId = null;
    callbacks?.onStatePersist();
  }
  await loadSavedFilters();
}
