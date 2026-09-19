/**
 * Filter panel of the «Структуры мыслей» view (L15, 08-ui-spec.md §15.3).
 *
 * Every group is a single compact line in its collapsed shape: keywords with
 * a history dropdown, a «Родительские мысли» scope field, «Типы мыслей» and
 * «Типы связей» comma-fields that open a checkbox-picker dialog, a
 * collapsible «Свойства» condition editor, a collapsible «Дополнительно»
 * tri-state group and sort. A sticky footer (Применить/Очистить + saved
 * filters) sits below the scrollable criteria list. The panel owns the
 * filter DOM and the string→wire value conversion; the host module
 * (`structures.ts`) owns the query lifecycle and persists the state (L4
 * `structures_state`).
 *
 * Условия отбора строит единый конструктор `lib/filter-builder.ts`
 * (задача 48b59d00, веха 5 версии 0.8.2): модель состояния, словарь
 * операторов, наборы сортировок/направлений, конвертер в wire и строка
 * условия «автор/редактор» импортируются оттуда — панель держит только
 * свои критерии (обход по связям) и жизненный цикл отбора.
 */

import {
  type LinkTypeFilterInput,
  type NetworkProperty,
  type PropertyConfig,
  type PropertyValueType,
  type SavedFilter,
  type SortOrder,
  type StructureAuthorOp,
  type StructureFilter,
  type StructureKeywordScope,
  type StructurePropertyCondition,
  type StructurePropertyOp,
  type StructureSort,
  type ThoughtRef,
} from '@etn/shared';

import {
  FILTER_ORDERS,
  FILTER_SORTS,
  OPS_BY_TYPE,
  authorFilterActive,
  buildAuthorConditionRow,
  buildConditionsWire,
  buildKeywordScope as builderKeywordScope,
  buildWireFilter,
  datesActive,
  defaultFilterCriteriaState,
  parseFilterDefinition,
  type FilterCriteriaState,
  type PropertyConditionState,
  type TriState,
} from '../../lib/filter-builder.js';

// Чипы мыслей в панели отбора строит общая фабрика облачка; `applyCloudStyle`
// стилизует подписи чипов типов связей (у типов связей нет своей фабрики).
import { applyCloudStyle, createThoughtCloud } from '../../lib/thought-cloud.js';
import { firstPickedThoughtId, pickedThoughtIds, pickThoughtsDialog } from '../../canvas/add-dialog.js';
import { buildValueEditor, wrapClearable } from '../../editor/value-editor.js';
import { clear, div, el, setTooltip, span } from '../../lib/dom.js';
import { confirmDialog, errorDialog, promptDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { pickEntitiesModal } from '../../lib/entity-picker.js';
import { resolveLinkTypeVisual } from '../../lib/type-tree.js';
import { store } from '../../state.js';
import { requireNetworkId } from '../../app.js';

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

/**
 * Operators per property value type (03-server-api.md §6.10) — единый
 * экземпляр живёт в `lib/filter-builder.ts` (задача 48b59d00, веха 5).
 * Здесь OPS_BY_TYPE не объявляется и не переписывается.
 */

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

/** Property registry: id → registry row. 0.6.5: one property, one id — the
 *  picker no longer walks every thought type (task 171a438e). */
const propertyDefs = new Map<string, NetworkProperty>();
/** Thought-ref titles for value chips (resolved lazily). */
const refTitles = new Map<string, string>();
/** Resolved metadata of the «Родительские мысли» chips (icon/style, lazy). */
const parentRefs = new Map<string, ThoughtRef>();
let savedFilters: SavedFilter[] = [];
/** Signature of the catalogues the panel depends on (rebuild on change). */
let catalogueSignature = '';

// DOM anchors rebuilt in renderPanel().
let keywordsInput: HTMLInputElement | null = null;
let parentFieldBox: HTMLElement | null = null;
let typeFieldBox: HTMLElement | null = null;
let linkTypeFieldBox: HTMLElement | null = null;
let linkFilterFieldBox: HTMLElement | null = null;
let conditionsBox: HTMLElement | null = null;
let sortSelect: HTMLSelectElement | null = null;
let orderSelect: HTMLSelectElement | null = null;
let saveNameInput: HTMLInputElement | null = null;
let savedListBox: HTMLElement | null = null;

/** Collapse state of the two collapsible groups (transient, not persisted). */
let propertiesCollapsed = true;
let extraCollapsed = true;
/**
 * Свёрнута ли группа «Даты» (задача 7032e55a). По умолчанию свёрнута — это
 * новая группа, существующий отбор её не касается; временное состояние, в
 * L4 `structures_state` не сохраняется.
 */
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
  extraCollapsed =
    state.hasProperties === null &&
    state.hasComment === null &&
    state.hasAttachments === null &&
    state.hasChronology === null &&
    state.trashed === false &&
    state.active === null &&
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
 * `parent_ids` раскрывается в поддерево. `undefined` — без ограничения (обход
 * по всем рёбрам, прежнее поведение).
 */
export function buildTraversalFilter(): LinkTypeFilterInput | undefined {
  if (state.linkFilterTypeIds.length === 0 && !state.linkFilterStructural) return undefined;
  const out: LinkTypeFilterInput = {};
  if (state.linkFilterTypeIds.length > 0) out.type_ids = state.linkFilterTypeIds;
  if (state.linkFilterStructural) out.include_structural = true;
  return out;
}

/**
 * Строки условия авторства, словарь операторов, помощники активности и
 * конвертеры значений автора — единые экземпляры конструктора
 * `lib/filter-builder.ts` (задача 48b59d00, веха 5). Здесь они не
 * объявляются повторно.
 */

/** Reloads the saved-filter list (called on `saved-filter.*` realtime events). */
export function invalidateSavedFilters(): void {
  void loadSavedFilters();
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
 * REST call replaces the per-type walk the panel used to do. A registry
 * property is one row per network; the picker no longer cares which types
 * attach it, so the same condition matches thoughts of different types.
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
  datesCollapsed = true;
  renderPanel();
  touch();
}

// ---------------------------------------------------------------------------
// Keywords history (client-local, §15.3)
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
// Panel DOM
// ---------------------------------------------------------------------------

/** Section block with a title; the title element is exposed for the uniform
 *  «group has values» marking (§15.3). */
function block(title: string): { box: HTMLElement; body: HTMLElement; head: HTMLElement } {
  const box = div('st-f-block');
  const head = el('div', 'st-f-title', title);
  const body = div('st-f-body');
  box.append(head, body);
  return { box, body, head };
}

/**
 * The «наименование/синонимы/комментарий» checkbox row under the keywords
 * field (§15.3, bug fix 0.5.5): one line, three checkboxes. Unchecking the
 * last checked box auto-reverts to the default pair («наименование» +
 * «синонимы») instead of leaving the search scope empty.
 */
function buildKeywordScopeRow(): HTMLElement {
  const row = div('st-f-kw-scope');
  const items: Array<{
    label: string;
    tooltip: string;
    get: () => boolean;
    set: (v: boolean) => void;
    input: HTMLInputElement | null;
  }> = [
    {
      label: 'наименование',
      tooltip: 'Искать в наименованиях мыслей',
      get: () => state.keywordInTitle,
      set: (v) => (state.keywordInTitle = v),
      input: null,
    },
    {
      label: 'синонимы',
      tooltip: 'Искать в синонимах мыслей',
      get: () => state.keywordInSynonyms,
      set: (v) => (state.keywordInSynonyms = v),
      input: null,
    },
    {
      label: 'комментарий',
      tooltip: 'Искать в постоянном комментарии мыслей',
      get: () => state.keywordInComment,
      set: (v) => (state.keywordInComment = v),
      input: null,
    },
  ];
    for (const item of items) {
      const lbl = el('label', 'checkbox-row st-f-kw-scope-item');
      const input = el('input') as HTMLInputElement;
      input.type = 'checkbox';
      input.checked = item.get();
      item.input = input;
      setTooltip(lbl, item.tooltip);
      input.addEventListener('change', () => {
        item.set(input.checked);
        // Cleared all three — revert to the default pair (§15.3 proposal).
        if (!state.keywordInTitle && !state.keywordInSynonyms && !state.keywordInComment) {
          state.keywordInTitle = true;
          state.keywordInSynonyms = true;
        }
        for (const other of items) other.input!.checked = other.get();
        touch();
      });
      lbl.append(input, span(item.label));
      row.append(lbl);
    }
    return row;
  }

/**
 * Строка «от / до» одной временной группы (задача 7032e55a). Использует
 * `<input type="datetime-local">` — нативный пикер даты/времени без
 * зависимостей; формат значения `YYYY-MM-DDTHH:MM` совместим с ISO-8601,
 * который сервер уже принимает (`created_after`/`created_before`/…).
 * Пустая строка — граница не выставлена. У каждого поля — общий крестик
 * «✕» очистки одним кликом (`wrapClearable`, ошибка a8e9eef1).
 */
function buildDateBoundRow(
  label: string,
  opts: {
    after: string;
    before: string;
    onAfterChange: (v: string) => void;
    onBeforeChange: (v: string) => void;
  },
): HTMLElement {
  const row = div('st-f-date-row');
  row.append(el('span', 'st-f-date-label', label));
  const afterWrap = div('st-f-date-field');
  afterWrap.append(el('span', 'st-f-date-tag', 'от'));
  const afterInput = el('input', 'st-f-input') as HTMLInputElement;
  afterInput.type = 'datetime-local';
  afterInput.step = '1';
  afterInput.value = opts.after;
  setTooltip(afterInput, 'Включительно. Формат ISO-8601 (YYYY-MM-DDTHH:MM:SS)');
  afterInput.addEventListener('input', () => opts.onAfterChange(afterInput.value));
  afterWrap.append(
    wrapClearable(afterInput, () => {
      afterInput.value = '';
      opts.onAfterChange('');
    }),
  );
  row.append(afterWrap);

  const beforeWrap = div('st-f-date-field');
  beforeWrap.append(el('span', 'st-f-date-tag', 'до'));
  const beforeInput = el('input', 'st-f-input') as HTMLInputElement;
  beforeInput.type = 'datetime-local';
  beforeInput.step = '1';
  beforeInput.value = opts.before;
  setTooltip(beforeInput, 'Включительно. Формат ISO-8601 (YYYY-MM-DDTHH:MM:SS)');
  beforeInput.addEventListener('input', () => opts.onBeforeChange(beforeInput.value));
  beforeWrap.append(
    wrapClearable(beforeInput, () => {
      beforeInput.value = '';
      opts.onBeforeChange('');
    }),
  );
  row.append(beforeWrap);
  return row;
  }

// Group-title elements of the current panel (refreshGroupTitles toggles them).
let kwTitle: HTMLElement | null = null;
let parentTitle: HTMLElement | null = null;
let ttTitle: HTMLElement | null = null;
let ltTitle: HTMLElement | null = null;
let lftTitle: HTMLElement | null = null;
let propsTitle: HTMLElement | null = null;
let extraTitle: HTMLElement | null = null;
let datesTitle: HTMLElement | null = null;

/**
 * Uniform «group carries values» marking (§15.3): EVERY group whose criteria
 * are set — collapsible or not — gets a bold, accent-colored title, so a
 * collapsed group visibly holds settings. «Сортировка» always has a value and
 * is never marked.
 */
function refreshGroupTitles(): void {
  kwTitle?.classList.toggle('st-f-title-active', state.keywords.trim() !== '');
  parentTitle?.classList.toggle('st-f-title-active', state.parentIds.length > 0);
  ttTitle?.classList.toggle('st-f-title-active', state.typeIds.length > 0);
  ltTitle?.classList.toggle('st-f-title-active', state.linkTypeIds.length > 0);
  lftTitle?.classList.toggle(
    'st-f-title-active',
    state.linkFilterTypeIds.length > 0 || state.linkFilterStructural,
  );
  propsTitle?.classList.toggle('st-f-title-active', state.properties.length > 0);
  extraTitle?.classList.toggle(
    'st-f-title-active',
    state.hasProperties !== null ||
      state.hasComment !== null ||
      state.hasAttachments !== null ||
      state.hasChronology !== null ||
      (state.active !== null && store.state.showInactive),
  );
  // Задача 7032e55a: маркер «Даты» заполнен, если задана хотя бы одна граница.
  datesTitle?.classList.toggle('st-f-title-active', datesActive(state));
}

/** Persists the state (L4) and refreshes the uniform group-title marking. */
function touch(): void {
  callbacks?.onStatePersist();
  refreshGroupTitles();
}

/**
 * A collapsible section block: clicking the header toggles the body. The
 * header carries the uniform «group has values» marking (bold + accent,
 * §15.3) — same rule as the always-open groups, collapsed or not.
 */
function collapsibleBlock(
  title: string,
  getCollapsed: () => boolean,
  setCollapsed: (v: boolean) => void,
  isNonEmpty: () => boolean,
): { box: HTMLElement; body: HTMLElement; head: HTMLElement; refresh: () => void } {
  const box = div('st-f-block');
  const head = el('div', 'st-f-title st-f-collapsible-title');
  const caret = el('span', 'st-f-caret', getCollapsed() ? '▸' : '▾');
  head.append(caret, el('span', '', title));
  const body = div('st-f-body');
  box.append(head, body);
  const refresh = (): void => {
    const collapsed = getCollapsed();
    body.classList.toggle('hidden', collapsed);
    caret.textContent = collapsed ? '▸' : '▾';
    head.classList.toggle('st-f-title-active', isNonEmpty());
  };
  head.addEventListener('click', () => {
    setCollapsed(!getCollapsed());
    refresh();
  });
  refresh();
  return { box, body, head, refresh };
}

/** Rebuilds the whole panel from `state`. */
function renderPanel(): void {
  if (host === null) return;
  clear(host);
  applyPanelWidth();
  host.classList.add('st-f-layout');

  const scroll = div('st-f-scroll');
  host.append(scroll);

  // --- keywords ---------------------------------------------------------
  const kw = block('Ключевые слова');
  kwTitle = kw.head;
  const kwWrap = div('st-f-kw-wrap');
  keywordsInput = el('input', 'st-f-input st-f-keywords') as HTMLInputElement;
  keywordsInput.type = 'text';
  keywordsInput.value = state.keywords;
  keywordsInput.placeholder = 'счет* -вод*';
  setTooltip(
    keywordsInput,
    'Слова через пробел, все обязательны; * — любые символы; -слово — исключение. Поиск по названию и синонимам.',
  );
  keywordsInput.addEventListener('input', () => {
    state.keywords = keywordsInput?.value ?? '';
    touch();
  });
  keywordsInput.addEventListener('focus', () => {
    if (keywordsInput === null) return;
    openFieldDropdown(
      kwWrap,
      loadKwHistory().map((word) => ({
        label: word,
        onPick: () => {
          if (keywordsInput !== null) {
            keywordsInput.value = word;
            state.keywords = word;
            touch();
          }
        },
      })),
    );
  });
  keywordsInput.addEventListener('blur', () => window.setTimeout(closeFieldDropdown, 150));
  keywordsInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') triggerApply();
    if (event.key === 'Escape') closeFieldDropdown();
  });
  const kwClear = el('button', 'st-f-clear-inline', '×');
  kwClear.type = 'button';
  setTooltip(kwClear, 'Очистить');
  kwClear.addEventListener('click', () => {
    state.keywords = '';
    if (keywordsInput !== null) keywordsInput.value = '';
    touch();
  });
  kwWrap.append(keywordsInput, kwClear);
  kw.body.append(kwWrap);
  kw.body.append(buildKeywordScopeRow());
  scroll.append(kw.box);

  // --- parent thoughts (scope, §15.3) ------------------------------------
  const pt = block('Родительские мысли');
  parentTitle = pt.head;
  parentFieldBox = div('st-f-chipfield');
  parentFieldBox.tabIndex = 0;
  setTooltip(parentFieldBox, 'Ограничить отбор мыслями, подчинёнными указанным (клик — выбрать)');
  parentFieldBox.addEventListener('click', () => void openParentPicker());
  parentFieldBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openParentPicker();
  });
  const ptClear = el('button', 'st-f-clear-inline', '×');
  ptClear.type = 'button';
  setTooltip(ptClear, 'Очистить');
  ptClear.addEventListener('click', (event) => {
    event.stopPropagation();
    state.parentIds = [];
    touch();
    renderParentField();
  });
  const ptRow = div('st-f-fieldrow');
  ptRow.append(parentFieldBox, ptClear);
  pt.body.append(ptRow);
  scroll.append(pt.box);
  renderParentField();

  // --- thought types ------------------------------------------------------
  const tt = block('Типы мыслей');
  ttTitle = tt.head;
  typeFieldBox = div('st-f-chipfield');
  typeFieldBox.tabIndex = 0;
  typeFieldBox.addEventListener('click', () => void openThoughtTypesPicker());
  typeFieldBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openThoughtTypesPicker();
  });
  const ttClear = el('button', 'st-f-clear-inline', '×');
  ttClear.type = 'button';
  setTooltip(ttClear, 'Очистить');
  ttClear.addEventListener('click', (event) => {
    event.stopPropagation();
    state.typeIds = [];
    touch();
    renderThoughtTypeField();
  });
  const ttRow = div('st-f-fieldrow');
  ttRow.append(typeFieldBox, ttClear);
  tt.body.append(ttRow);
  scroll.append(tt.box);
  renderThoughtTypeField();

  // --- link types -----------------------------------------------------------
  const lt = block('Типы связей');
  ltTitle = lt.head;
  linkTypeFieldBox = div('st-f-chipfield');
  linkTypeFieldBox.tabIndex = 0;
  linkTypeFieldBox.addEventListener('click', () => void openLinkTypesPicker());
  linkTypeFieldBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openLinkTypesPicker();
  });
  const ltClear = el('button', 'st-f-clear-inline', '×');
  ltClear.type = 'button';
  setTooltip(ltClear, 'Очистить');
  ltClear.addEventListener('click', (event) => {
    event.stopPropagation();
    state.linkTypeIds = [];
    touch();
    renderLinkTypeField();
  });
  const ltRow = div('st-f-fieldrow');
  ltRow.append(linkTypeFieldBox, ltClear);
  lt.body.append(ltRow);
  scroll.append(lt.box);
  renderLinkTypeField();

  // --- обход по связям (задача c965ad03) -------------------------------------
  // Ограничивает рёбра, по которым `parent_ids` раскрывается в поддерево:
  // перечисленные типы связей (+ структурные по флагу). Не путать с «Типы
  // связей» выше — тот отбирает мысли, у которых есть связь этих типов.
  const lf = block('Обход по связям');
  lftTitle = lf.head;
  linkFilterFieldBox = div('st-f-chipfield');
  linkFilterFieldBox.tabIndex = 0;
  setTooltip(linkFilterFieldBox, 'Ограничить рёбра, по которым раскрывается отбор (клик — выбрать)');
  linkFilterFieldBox.addEventListener('click', () => void openLinkFilterPicker());
  linkFilterFieldBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openLinkFilterPicker();
  });
  const lfClear = el('button', 'st-f-clear-inline', '×');
  lfClear.type = 'button';
  setTooltip(lfClear, 'Очистить');
  lfClear.addEventListener('click', (event) => {
    event.stopPropagation();
    state.linkFilterTypeIds = [];
    touch();
    renderLinkFilterField();
  });
  const lfRow = div('st-f-fieldrow');
  lfRow.append(linkFilterFieldBox, lfClear);
  lf.body.append(lfRow);

  const lfStructRow = div('st-f-tri-row');
  const lfStructLabel = el('label', 'checkbox-row');
  const lfStructCheck = el('input');
  lfStructCheck.type = 'checkbox';
  lfStructCheck.checked = state.linkFilterStructural;
  setTooltip(lfStructLabel, 'Включить нетипизированные (структурные) связи в обход');
  lfStructCheck.addEventListener('change', () => {
    state.linkFilterStructural = lfStructCheck.checked;
    touch();
  });
  lfStructLabel.append(lfStructCheck, span('структурные связи'));
  lfStructRow.append(el('span', 'st-f-tri-label', 'Структура'), lfStructLabel);
  lf.body.append(lfStructRow);

  scroll.append(lf.box);
  renderLinkFilterField();

  // --- property conditions (collapsible, §15.3) ------------------------------
  // --- authorship (задача 59119797, эволюция операторов) -------------------
  // Автор/Редактор — оператор eq/ne/in/not_in/empty/not_empty + селектор
  // пользователя (одиночный или мульти в зависимости от оператора). Условия
  // AND-комбинируются как и остальные.
  const authorship = collapsibleBlock(
    'Автор / Редактор',
    () => extraCollapsed,
    (v) => {
      extraCollapsed = v;
    },
    () => authorFilterActive(state.authorOp, state.authorId, state.authorIds) ||
      authorFilterActive(state.editorOp, state.editorId, state.editorIds),
  );
  authorship.body.append(
    buildAuthorConditionRow({
      label: 'Автор',
      op: state.authorOp,
      singleId: state.authorId,
      listIds: state.authorIds,
      onOpChange: (op) => {
        state.authorOp = op;
        // При смене оператора чистим значение, если оно несовместимо.
        if (op !== 'eq' && op !== 'ne') state.authorId = '';
        if (op !== 'in' && op !== 'not_in') state.authorIds = [];
        touch();
        authorship.refresh();
        renderPanel();
      },
      onSingleChange: (id) => {
        state.authorId = id;
        touch();
        authorship.refresh();
      },
      onListChange: (ids) => {
        state.authorIds = ids;
        touch();
        authorship.refresh();
      },
    }),
    buildAuthorConditionRow({
      label: 'Редактор',
      op: state.editorOp,
      singleId: state.editorId,
      listIds: state.editorIds,
      onOpChange: (op) => {
        state.editorOp = op;
        if (op !== 'eq' && op !== 'ne') state.editorId = '';
        if (op !== 'in' && op !== 'not_in') state.editorIds = [];
        touch();
        authorship.refresh();
        renderPanel();
      },
      onSingleChange: (id) => {
        state.editorId = id;
        touch();
        authorship.refresh();
      },
      onListChange: (ids) => {
        state.editorIds = ids;
        touch();
        authorship.refresh();
      },
    }),
  );
  scroll.append(authorship.box);

  const props = collapsibleBlock(
    'Свойства',
    () => propertiesCollapsed,
    (v) => {
      propertiesCollapsed = v;
    },
    () => state.properties.length > 0,
  );
  propsTitle = props.head;
  conditionsBox = div('st-f-conds');
  renderConditions();
  const addCond = el('button', 'st-f-add', '+ условие');
  addCond.type = 'button';
  addCond.addEventListener('click', () => {
    const first = [...propertyDefs.values()][0];
    state.properties = [
      ...state.properties,
      first
        ? { propertyId: first.id, op: OPS_BY_TYPE[first.value_type][0]!.op, values: [''] }
        : { propertyId: '', op: 'eq', values: [''] },
    ];
    touch();
    renderConditions();
    props.refresh();
  });
  props.body.append(conditionsBox, addCond);
  scroll.append(props.box);

  // --- Даты (задача 7032e55a): сворачиваемая группа «Создано»/«Изменено»,
  // две пары полей «от»/«до». По умолчанию свёрнута, существующий отбор
  // её не касается.
  const dates = collapsibleBlock(
    'Даты',
    () => datesCollapsed,
    (v) => {
      datesCollapsed = v;
    },
    () => datesActive(state),
  );
  datesTitle = dates.head;
  dates.body.append(
    buildDateBoundRow('Создано', {
      after: state.createdAfter,
      before: state.createdBefore,
      onAfterChange: (v) => {
        state.createdAfter = v;
        touch();
        dates.refresh();
      },
      onBeforeChange: (v) => {
        state.createdBefore = v;
        touch();
        dates.refresh();
      },
    }),
    buildDateBoundRow('Изменено', {
      after: state.updatedAfter,
      before: state.updatedBefore,
      onAfterChange: (v) => {
        state.updatedAfter = v;
        touch();
        dates.refresh();
      },
      onBeforeChange: (v) => {
        state.updatedBefore = v;
        touch();
        dates.refresh();
      },
    }),
  );
  scroll.append(dates.box);

  // --- «Дополнительно» (collapsible tri-state group, §15.3) ------------------
  const extra = collapsibleBlock(
    'Дополнительно',
    () => extraCollapsed,
    (v) => {
      extraCollapsed = v;
    },
    () =>
      state.hasProperties !== null ||
      state.hasComment !== null ||
      state.hasAttachments !== null ||
      state.hasChronology !== null ||
      state.trashed === true ||
      (state.active !== null && store.state.showInactive),
  );
  extraTitle = extra.head;
  const triRow = (
    label: string,
    get: () => TriState,
    set: (v: TriState) => void,
    options?: { yes: string; no: string; disabled?: boolean; tooltip?: string },
  ): HTMLElement => {
    const row = div('st-f-tri-row');
    row.append(el('span', 'st-f-tri-label', label));
    const select = el('select', 'st-f-input') as HTMLSelectElement;
    const opts = [
      { v: '', label: 'не важно' },
      { v: 'yes', label: options?.yes ?? 'есть' },
      { v: 'no', label: options?.no ?? 'нет' },
    ];
    for (const opt of opts) {
      const o = el('option', '', opt.label) as HTMLOptionElement;
      o.value = opt.v;
      select.append(o);
    }
    select.value = get() === null ? '' : get() === true ? 'yes' : 'no';
    if (options?.disabled === true) {
      select.disabled = true;
      if (options.tooltip !== undefined) setTooltip(select, options.tooltip);
    }
    select.addEventListener('change', () => {
      set(select.value === '' ? null : select.value === 'yes');
      touch();
      extra.refresh();
    });
    row.append(select);
    return row;
  };
  extra.body.append(
    triRow('Свойства', () => state.hasProperties, (v) => (state.hasProperties = v)),
    triRow('Комментарий', () => state.hasComment, (v) => (state.hasComment = v)),
    triRow('Вложения', () => state.hasAttachments, (v) => (state.hasAttachments = v)),
    triRow('Хроника', () => state.hasChronology, (v) => (state.hasChronology = v)),
    triRow('Актуальность', () => state.active, (v) => (state.active = v), {
      yes: 'актуальные',
      no: 'не актуальные',
      // Only meaningful while inactive thoughts are in the candidate set at
      // all — i.e. the client setting «Показывать неактуальное» is on (§15.3).
      disabled: !store.state.showInactive,
      tooltip: 'Доступно при включённой настройке «Показывать неактуальное» (Вид → Неактуальные)',
    }),
  );

  // S13: marked-for-deletion is an independent on/off checkbox, not a tri-state
  // (§5a.5, §15.3): off (default) hides marked thoughts, on includes them.
  const trashedRow = div('st-f-tri-row');
  const trashedLabel = el('label', 'checkbox-row');
  const trashedCheck = el('input');
  trashedCheck.type = 'checkbox';
  trashedCheck.checked = state.trashed;
  trashedCheck.addEventListener('change', () => {
    state.trashed = trashedCheck.checked;
    touch();
    extra.refresh();
  });
  trashedLabel.append(trashedCheck, span('помеченные на удаление'));
  trashedRow.append(el('span', 'st-f-tri-label', 'Корзина'), trashedLabel);
  extra.body.append(trashedRow);
  scroll.append(extra.box);

  // --- sort -----------------------------------------------------------------
  // Наборы сортировок и направлений — единые экземпляры конструктора
  // (`lib/filter-builder.ts`), тот же набор, что принимает исполнитель.
  const sortBlock = block('Сортировка');
  const sortRow = div('st-f-sort');
  sortSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of FILTER_SORTS) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    sortSelect.append(o);
  }
  sortSelect.value = state.sort;
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect?.value as StructureSort;
    touch();
  });
  orderSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of FILTER_ORDERS) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    orderSelect.append(o);
  }
  orderSelect.value = state.order;
  orderSelect.addEventListener('change', () => {
    state.order = orderSelect?.value as SortOrder;
    touch();
  });
  sortRow.append(sortSelect, orderSelect);
  sortBlock.body.append(sortRow);
  scroll.append(sortBlock.box);

  // --- sticky footer: Применить/Очистить + saved filters (§15.3) -------------
  const footer = div('st-f-footer');

  const btnRow = div('st-f-btnrow');
  const apply = el('button', 'st-f-apply', 'Применить');
  apply.type = 'button';
  apply.addEventListener('click', () => triggerApply());
  const clearBtn = el('button', 'st-f-clear', 'Очистить');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => clearAllCriteria());
  const commandsBtn = el('button', 'st-f-commands', 'Команды ▾');
  commandsBtn.type = 'button';
  setTooltip(commandsBtn, 'Команды над всеми мыслями отбора (без учёта пагинации)');
  commandsBtn.addEventListener('click', () => callbacks?.onCommands(commandsBtn));
  btnRow.append(apply, clearBtn, commandsBtn);
  footer.append(btnRow);

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
  footer.append(saveRow);

  savedListBox = div('st-f-savedlist');
  footer.append(savedListBox);
  host.append(footer);
  renderSavedList();
  refreshGroupTitles();
}

// ---------------------------------------------------------------------------
// Chip fields (родительские мысли / типы мыслей / типы связей, §15.3)
// ---------------------------------------------------------------------------

/** Renders a comma-separated row of styled chips (or a placeholder). */
/** Renders ready-made chips separated by commas (empty → «не выбрано»). */
function renderChips(container: HTMLElement, chips: HTMLElement[]): void {
  clear(container);
  if (chips.length === 0) {
    container.append(el('span', 'st-f-chip-empty', 'не выбрано'));
    return;
  }
  chips.forEach((chipEl, index) => {
    container.append(chipEl);
    if (index < chips.length - 1) container.append(el('span', 'st-f-chip-sep', ', '));
  });
}

/** Чип типа связи: подпись в цвете типа связи (иконок у типов связей нет). */
function linkTypeChip(label: string, fg: string | null): HTMLElement {
  const chip = el('span', 'st-f-chip');
  const text = el('span', 'st-f-chip-label', label);
  applyCloudStyle(text, {
    fg,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
  });
  chip.append(text);
  return chip;
}

/** Renders the «Родительские мысли» chips, resolving unknown titles lazily. */
function renderParentField(): void {
  if (parentFieldBox === null) return;
  const networkId = store.state.networkId;
  const missing = state.parentIds.filter((id) => !parentRefs.has(id));
  if (networkId !== null && missing.length > 0) {
    void etn.thoughts
      .resolve(networkId, missing)
      .then((refs) => {
        for (const ref of refs) parentRefs.set(ref.id, ref);
        renderParentField();
      })
      .catch(() => undefined);
  }
  // Чипы мыслей — общей фабрикой облачка (профиль `chip`): значок, цвета,
  // начертание, бледность и метка корзины — как в любом списке клиента.
  renderChips(
    parentFieldBox,
    state.parentIds.map((id) => {
      const ref = parentRefs.get(id);
      const chip = createThoughtCloud(ref ?? { id, title: '…' }, { profile: 'chip', width: 'container' });
      chip.classList.add('st-f-chip');
      return chip;
    }),
  );
}

/** Opens the multi-thought picker for the «Родительские мысли» scope. */
async function openParentPicker(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const result = await pickThoughtsDialog({
    networkId,
    allowCreate: false,
    allowLinkType: false,
    selectedIds: state.parentIds,
    title: 'Родительские мысли',
    applyLabel: 'Применить',
  });
  if (result === null) return;
  state.parentIds = pickedThoughtIds(result);
  touch();
  renderParentField();
}

/** Renders the «Типы мыслей» chips. */
function renderThoughtTypeField(): void {
  if (typeFieldBox === null) return;
  // Чипы типов — той же фабрикой облачка: она резолвит значок и стиль по
  // `type_id` (своя иконка отсутствует — берётся типовая по цепочке предков).
  renderChips(
    typeFieldBox,
    state.typeIds.flatMap((id) => {
      const type = store.state.thoughtTypes.find((t) => t.id === id);
      if (type === undefined) return [];
      const chip = createThoughtCloud(
        { id: type.id, title: type.name },
        { profile: 'chip', width: 'container' },
      );
      chip.classList.add('st-f-chip');
      return [chip];
    }),
  );
}

/** Renders the «Типы связей» chips (link types have no icon in the data model). */
function renderLinkTypeField(): void {
  if (linkTypeFieldBox === null) return;
  renderChips(
    linkTypeFieldBox,
    state.linkTypeIds.flatMap((id) => {
      const type = store.state.linkTypes.find((t) => t.id === id);
      if (type === undefined) return [];
      const visual = resolveLinkTypeVisual(store.state.linkTypes, type.id);
      return [linkTypeChip(type.name_forward, visual.color)];
    }),
  );
}

async function openThoughtTypesPicker(): Promise<void> {
  const picked = await pickEntitiesModal({
    networkId: requireNetworkId(),
    kind: 'thought-types',
    title: 'Типы мыслей',
    currentIds: state.typeIds,
  });
  if (picked === null) return;
  state.typeIds = picked;
  touch();
  renderThoughtTypeField();
}

async function openLinkTypesPicker(): Promise<void> {
  const picked = await pickEntitiesModal({
    networkId: requireNetworkId(),
    kind: 'link-types',
    title: 'Типы связей',
    currentIds: state.linkTypeIds,
  });
  if (picked === null) return;
  state.linkTypeIds = picked;
  touch();
  renderLinkTypeField();
}

/** Renders the «Обход по связям» chips (задача c965ad03). */
function renderLinkFilterField(): void {
  if (linkFilterFieldBox === null) return;
  renderChips(
    linkFilterFieldBox,
    state.linkFilterTypeIds.flatMap((id) => {
      const type = store.state.linkTypes.find((t) => t.id === id);
      if (type === undefined) return [];
      const visual = resolveLinkTypeVisual(store.state.linkTypes, type.id);
      return [linkTypeChip(type.name_forward, visual.color)];
    }),
  );
}

/** Opens the link-type picker for the traversal filter (задача c965ad03). */
async function openLinkFilterPicker(): Promise<void> {
  const picked = await openLinkFilterPickerLib();
  if (picked === null) return;
  state.linkFilterTypeIds = picked;
  touch();
  renderLinkFilterField();
}

async function openLinkFilterPickerLib(): Promise<string[] | null> {
  return pickEntitiesModal({
    networkId: requireNetworkId(),
    kind: 'link-types',
    title: 'Обход по связям',
    currentIds: state.linkFilterTypeIds,
  });
}

// ---------------------------------------------------------------------------
// Property conditions (§15.3, unchanged editor logic)
// ---------------------------------------------------------------------------

/** Renders the property condition rows. */
function renderConditions(): void {
  if (conditionsBox === null) return;
  clear(conditionsBox);
  if (state.properties.length === 0) {
    conditionsBox.append(el('div', 'st-f-empty', 'Условий нет'));
    return;
  }
  state.properties.forEach((cond, index) => {
    conditionsBox?.append(buildConditionRow(cond, index));
  });
}

/** Builds one `[property][op][value(s)]` row with the × remove button. */
function buildConditionRow(cond: PropertyConditionState, index: number): HTMLElement {
  const row = div('st-f-cond');
  const def = propertyDefs.get(cond.propertyId);

  // Property picker: registry rows — labels are the property names. The
  // picker no longer carries a «Тип · » prefix because one registry id
  // already addresses the property on every attaching type (0.6.5).
  const propSelect = el('select', 'st-f-input st-f-prop') as HTMLSelectElement;
  if (!propertyDefs.has(cond.propertyId)) {
    const placeholder = el('option', '', cond.propertyId === '' ? '— свойство —' : '?') as HTMLOptionElement;
    placeholder.value = cond.propertyId;
    propSelect.append(placeholder);
  }
  for (const [id, entry] of propertyDefs) {
    const option = el('option', '', entry.name) as HTMLOptionElement;
    option.value = id;
    propSelect.append(option);
  }
  propSelect.value = cond.propertyId;
  propSelect.addEventListener('change', () => {
    const nextId = propSelect.value;
    const nextType = propertyDefs.get(nextId)?.value_type ?? 'text';
    const ops = OPS_BY_TYPE[nextType];
    // A different property starts with one empty value.
    state.properties[index] = {
      propertyId: nextId,
      op: ops.some((o) => o.op === cond.op) ? cond.op : ops[0]!.op,
      values: [''],
    };
    touch();
    renderConditions();
  });

  // Operator picker (per value type).
  const opSelect = el('select', 'st-f-input st-f-op') as HTMLSelectElement;
  const ops = OPS_BY_TYPE[def?.value_type ?? 'text'];
  for (const op of ops) {
    const option = el('option', '', op.label) as HTMLOptionElement;
    option.value = op.op;
    opSelect.append(option);
  }
  if (!ops.some((o) => o.op === cond.op)) {
    cond.op = ops[0]!.op;
  }
  opSelect.value = cond.op;
  opSelect.addEventListener('change', () => {
    // The row may have been edited since this closure was built — read the
    // live state as the base (a different op starts with one empty value).
    const live = state.properties[index] ?? cond;
    state.properties[index] = { ...live, op: opSelect.value as StructurePropertyOp, values: [''] };
    touch();
    renderConditions();
  });

  // Value editor.
  const valueBox = buildConditionValueBox(cond, def, index);

  const remove = el('button', 'st-f-remove', '×');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    state.properties = state.properties.filter((_, i) => i !== index);
    touch();
    renderConditions();
  });

  row.append(propSelect, opSelect, valueBox, remove);
  return row;
}

/**
 * Box значений условия (§15.3). Любой вид значения строится ОБЩИМ редактором
 * `buildValueEditor` (`editor/value-editor.ts`, стандарт S2): у поля справа
 * «✕» очистки одним кликом (ошибка a8e9eef1), для text с закрытым списком —
 * общая выпадашка вариантов, для `bool` — трёхзначное поле, для
 * `link`/`thought_ref` — чипы-облачка целей с живым поиском (облачко, значки,
 * цвета, бледность, отбор по типам). `thought_ref` — legacy-вид с тем же
 * значением (id мысли), поэтому ведётся редактором связи. Состояние условия
 * хранит строки, редактор связи отдаёт массив id — переходник сводит массив
 * к строкам; wire-конвертер (`lib/filter-builder.ts`) ждёт `'true'`/`'false'`
 * строками у bool и первое значение у скалярной операции.
 *
 * Каждый обработчик читает ТЕКУЩУЮ строку условия из состояния (`live()`), а
 * не замкнутую, — перерисовка строки не должна терять введённое.
 */
function buildConditionValueBox(
  cond: PropertyConditionState,
  def: { value_type: PropertyValueType; config?: PropertyConfig | null } | undefined,
  index: number,
): HTMLElement {
  const valueType = def?.value_type ?? 'text';
  const box = div('st-f-values');
  const isList = cond.op === 'in' || cond.op === 'not_in';
  // `is_empty` / `not_empty` test for the presence of a value at all —
  // the value editor is replaced with a hint so the row stays balanced
  // (bug fix 0.6.3).
  const isPresence = cond.op === 'is_empty' || cond.op === 'not_empty';
  const live = (): PropertyConditionState => state.properties[index] ?? cond;
  const setValues = (values: string[]): void => {
    state.properties[index] = { ...live(), values: values.length > 0 ? values : [''] };
    touch();
  };

  if (isPresence) {
    box.append(el('span', 'st-f-value-hint', 'значение не требуется'));
    return box;
  }

  const current = live();
  const editorType: PropertyValueType = valueType === 'thought_ref' ? 'link' : valueType;
  const stored = current.values.filter((v) => v !== '');
  const raw = current.values[0] ?? '';
  // Скаляр — одно значение в родном типе редактора (число — число, bool —
  // boolean/null); связь и списочная операция — набор. Без ветвления по виду
  // значения: диспетчер по виду — только в общем редакторе (стандарт S2).
  const scalar: unknown =
    valueType === 'bool'
      ? (raw === '' ? null : raw === 'true')
      : valueType === 'number'
        ? (raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : '')
        : raw;
  const value: unknown = editorType === 'link' || isList ? stored : scalar;
  const config = isList ? { ...(def?.config ?? {}), multiple: true } : (def?.config ?? null);

  box.append(
    buildValueEditor({
      networkId: requireNetworkId(),
      definition: {
        value_type: editorType,
        config,
        required: false,
        default_value: null,
      },
      value,
      commitOn: 'change',
      // bool — трёхзначное поле: «—» (пусто) не задаёт условие.
      boolTriState: valueType === 'bool',
      save: (next) => {
        if (Array.isArray(next)) {
          setValues(next.map((v) => String(v)));
        } else if (next === null || next === undefined || next === '') {
          setValues(['']);
        } else {
          setValues([String(next)]);
        }
        return true;
      },
    }),
  );
  return box;
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
        {
          label: 'Применить',
          onClick: () => applySavedFilter(filter),
        },
        {
          label: 'Переименовать…',
          onClick: () => void renameSavedFilter(filter),
        },
        {
          label: 'Удалить',
          danger: true,
          onClick: () => void removeSavedFilter(filter),
        },
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
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'DUPLICATE'
    ) {
      // Same name — update the existing filter in place.
      const existing = savedFilters.find(
        (f) => f.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing !== undefined) {
        const updated = await etn.savedFilters.update(networkId, existing.id, {
          definition,
        });
        state.savedFilterId = updated.id;
      }
    } else {
      errorDialog('Сохранить отбор', err);
      return;
    }
  }
  touch();
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
  const confirmed = await confirmDialog(
    'Удалить отбор',
    `Удалить сохранённый отбор «${filter.name}»?`,
    true,
  );
  if (!confirmed) return;
  try {
    await etn.savedFilters.remove(networkId, filter.id);
  } catch (err) {
    errorDialog('Удалить отбор', err);
    return;
  }
  if (state.savedFilterId === filter.id) {
    state.savedFilterId = null;
    touch();
  }
  await loadSavedFilters();
}
