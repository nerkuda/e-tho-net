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
 */

import {
  STRUCTURE_AUTHOR_OPS,
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

import { applyCloudStyle, applyThoughtIcon, resolveCloudStyle } from '../../canvas/canvas.js';
import { firstPickedThoughtId, pickedThoughtIds, pickThoughtsDialog } from '../../canvas/add-dialog.js';
import { buildValueOptionsCaret } from '../../editor/properties.js';
import { wireThoughtRefSearch } from '../../editor/thought-picker.js';
import { clear, div, el, setTooltip, span } from '../../lib/dom.js';
import { confirmDialog, errorDialog, promptDialog, showDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { orderedTypeRows, resolveLinkTypeVisual, resolveThoughtTypeVisual } from '../../lib/type-tree.js';
import { buildUserMultiSelectWidget, buildUserSelectWidget } from '../../lib/users.js';
import { store } from '../../state.js';

/** One property condition row (values kept as strings; typed on the wire). */
export interface PropertyConditionState {
  propertyId: string;
  op: StructurePropertyOp;
  values: string[];
}

/** Filter-panel width limits, px (the splitter drag clamps to this range). */
export const FILTER_W_MIN = 230;
export const FILTER_W_MAX = 420;

/** Tri-state UI value of a «Дополнительно» field: `null` — «не важно». */
type TriState = boolean | null;

/** Full filter-panel state (persisted as the L4 `structures_state` JSON). */
export interface FilterState {
  keywords: string;
  /**
   * Where `keywords` searches (§15.3, bug fix 0.5.5): «наименование» /
   * «синонимы» / «комментарий» checkboxes under the keywords field. The
   * panel enforces at least one of «наименование»/«синонимы» checked at all
   * times — unchecking the last one auto-reverts to the default pair.
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
  /**
   * Id пользователя-автора для `eq`/`ne` (пустая строка — фильтр не
   * применяется). Для `in`/`not_in` — массив id (см. `authorIds`).
   */
  authorId: string;
  /** Список id для операторов `in`/`not_in` авторства. */
  authorIds: string[];
  /** Оператор условия по редактору (см. `authorOp`). */
  editorOp: StructureAuthorOp;
  /** Id пользователя-редактора для `eq`/`ne`. */
  editorId: string;
  /** Список id редакторов для `in`/`not_in`. */
  editorIds: string[];
  sort: StructureSort;
  order: SortOrder;
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
 * Operators per property value type (03-server-api.md §6.10).
 *
 * `is_empty` / `not_empty` test for the presence of a value at all (the
 * `value` payload is ignored). Available for every type EXCEPT `bool`: for
 * booleans, `eq true` / `eq false` already cover the same intent, so an
 * extra toggle would be redundant noise on a small list.
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
  thought_ref: [
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
};

/** Default panel state: empty filter → HOME only (§15.3). */
function defaultState(): FilterState {
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
    sort: 'created',
    order: 'asc',
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
let conditionsBox: HTMLElement | null = null;
let sortSelect: HTMLSelectElement | null = null;
let orderSelect: HTMLSelectElement | null = null;
let saveNameInput: HTMLInputElement | null = null;
let savedListBox: HTMLElement | null = null;

/** Collapse state of the two collapsible groups (transient, not persisted). */
let propertiesCollapsed = true;
let extraCollapsed = true;

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

/**
 * Wire `keyword_scope` from the panel checkboxes (bug fix 0.5.5). Returns
 * `undefined` when it matches the server default (title+synonyms) — keeps
 * the wire filter and saved-filter definitions minimal, same convention as
 * the other optional §15.3 fields.
 */
export function buildKeywordScope(): StructureKeywordScope[] | undefined {
  const scope: StructureKeywordScope[] = [];
  if (state.keywordInTitle) scope.push('title');
  if (state.keywordInSynonyms) scope.push('synonyms');
  if (state.keywordInComment) scope.push('comment');
  if (scope.length === 2 && scope.includes('title') && scope.includes('synonyms')) return undefined;
  return scope;
}

/** Wire property conditions built from the panel rows (typed conversion). */
export function buildConditions(): StructurePropertyCondition[] {
  const out: StructurePropertyCondition[] = [];
  for (const cond of state.properties) {
    const def = propertyDefs.get(cond.propertyId);
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

/** The «Родительские мысли»/«Дополнительно» fields of the wire filter (§15.3). */
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
> {
  const out: ReturnType<typeof buildExtraFilter> = {};
  if (state.parentIds.length > 0) out.parent_ids = state.parentIds;
  if (state.hasProperties !== null) out.has_properties = state.hasProperties;
  if (state.hasComment !== null) out.has_comment = state.hasComment;
  if (state.hasAttachments !== null) out.has_attachments = state.hasAttachments;
  if (state.hasChronology !== null) out.has_chronology = state.hasChronology;
  // «Актуальность» only participates while «Показывать неактуальное» is on —
  // otherwise inactive thoughts are not in the candidate set at all (§15.3).
  if (state.active !== null && store.state.showInactive) out.active = state.active;
  // S13: a marked-for-deletion filter is an independent checkbox (default off).
  if (state.trashed) out.trashed = true;
  // Задача 59119797 «Фильтры Автор/Редактор»: оператор + значение (id или
  // массив id). empty/not_empty — без значения.
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
  return out;
}

/** Builds the wire value+op for one author filter (задача 59119797). */
function buildAuthorWireValue(
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
function authorFilterActive(op: StructureAuthorOp, single: string, list: string[]): boolean {
  if (op === 'empty' || op === 'not_empty') return true;
  if (op === 'in' || op === 'not_in') return list.length > 0;
  return single !== '';
}

/**
 * Russian labels for the author-op dropdown (задача 59119797).
 * Не используем «содержит»/«не содержит» — у id нет смысла частичного
 * совпадения, поэтому «равен»/«не равен» чище.
 */
const AUTHOR_OP_LABELS: Record<StructureAuthorOp, string> = {
  eq: 'равен',
  ne: 'не равен',
  in: 'в списке',
  not_in: 'не в списке',
  empty: 'не заполнено',
  not_empty: 'заполнено',
};

/** Russian labels for the saved-filter tag rendering (задача 59119797). */
function authorOpLabel(op: StructureAuthorOp): string {
  return AUTHOR_OP_LABELS[op] ?? op;
}

/**
 * Строит одну строку условия авторства: «подпись / оператор / значение».
 * Значение показывает либо одиночный `<select>`, либо мульти-чипы.
 */
function buildAuthorConditionRow(opts: {
  label: string;
  op: StructureAuthorOp;
  singleId: string;
  listIds: string[];
  onOpChange: (op: StructureAuthorOp) => void;
  onSingleChange: (id: string) => void;
  onListChange: (ids: string[]) => void;
}): HTMLElement {
  const row = div('author-cond-row');
  const label = el('span', 'author-cond-label', opts.label);
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
  row.append(label, opSelect);

  if (opts.op === 'empty' || opts.op === 'not_empty') {
    row.append(el('span', 'author-cond-hint', 'значение не требуется'));
    return row;
  }
  if (opts.op === 'in' || opts.op === 'not_in') {
    const multi = buildUserMultiSelectWidget({
      label: '',
      currentIds: opts.listIds,
      onChange: opts.onListChange,
    });
    row.append(multi);
    return row;
  }
  const single = buildUserSelectWidget({
    label: '',
    currentId: opts.singleId,
    onChange: opts.onSingleChange,
  });
  row.append(single);
  return row;
}

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

// Group-title elements of the current panel (refreshGroupTitles toggles them).
let kwTitle: HTMLElement | null = null;
let parentTitle: HTMLElement | null = null;
let ttTitle: HTMLElement | null = null;
let ltTitle: HTMLElement | null = null;
let propsTitle: HTMLElement | null = null;
let extraTitle: HTMLElement | null = null;

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
  propsTitle?.classList.toggle('st-f-title-active', state.properties.length > 0);
  extraTitle?.classList.toggle(
    'st-f-title-active',
    state.hasProperties !== null ||
      state.hasComment !== null ||
      state.hasAttachments !== null ||
      state.hasChronology !== null ||
      (state.active !== null && store.state.showInactive),
  );
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
  const sortBlock = block('Сортировка');
  const sortRow = div('st-f-sort');
  sortSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of [
    { v: 'alpha', label: 'по названию' },
    { v: 'created', label: 'по созданию' },
    { v: 'viewed', label: 'по просмотру' },
  ]) {
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
  for (const opt of [
    { v: 'asc', label: 'возрастание' },
    { v: 'desc', label: 'убывание' },
  ]) {
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
function renderChips(
  container: HTMLElement,
  items: Array<{
    key: string;
    label: string;
    icon: HTMLElement | null;
    style: { fg: string | null; bg: string | null; bold: boolean; italic: boolean; underline: boolean; strike: boolean };
  }>,
): void {
  clear(container);
  if (items.length === 0) {
    container.append(el('span', 'st-f-chip-empty', 'не выбрано'));
    return;
  }
  items.forEach((item, index) => {
    const chip = el('span', 'st-f-chip');
    if (item.icon !== null) chip.append(item.icon);
    const label = el('span', 'st-f-chip-label', item.label);
    applyCloudStyle(label, item.style);
    chip.append(label);
    container.append(chip);
    if (index < items.length - 1) container.append(el('span', 'st-f-chip-sep', ', '));
  });
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
  renderChips(
    parentFieldBox,
    state.parentIds.map((id) => {
      const ref = parentRefs.get(id);
      const icon = div('st-f-chip-icon');
      applyThoughtIcon(icon, ref ?? { icon: null, icon_kind: 'emoji', type_id: null });
      return {
        key: id,
        label: ref?.title ?? '…',
        icon,
        style: resolveCloudStyle(
          ref ?? {
            type_id: null,
            fg_color: null,
            bg_color: null,
            font_bold: false,
            font_italic: false,
            font_underline: false,
            font_strike: false,
          },
        ),
      };
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
  renderChips(
    typeFieldBox,
    state.typeIds.flatMap((id) => {
      const type = store.state.thoughtTypes.find((t) => t.id === id);
      if (type === undefined) return [];
      const visual = resolveThoughtTypeVisual(store.state.thoughtTypes, type.id);
      const icon = div('st-f-chip-icon');
      applyThoughtIcon(icon, { icon: visual.icon, icon_kind: visual.icon_kind, type_id: type.id });
      return [
        {
          key: id,
          label: type.name,
          icon,
          style: {
            fg: visual.fg_color,
            bg: visual.bg_color,
            bold: visual.font_bold ?? false,
            italic: visual.font_italic ?? false,
            underline: visual.font_underline ?? false,
            strike: visual.font_strike ?? false,
          },
        },
      ];
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
      return [
        {
          key: id,
          label: type.name_forward,
          icon: null,
          style: {
            fg: visual.color,
            bg: null,
            bold: false,
            italic: false,
            underline: false,
            strike: false,
          },
        },
      ];
    }),
  );
}

async function openThoughtTypesPicker(): Promise<void> {
  const rows = orderedTypeRows(store.state.thoughtTypes)
    .filter((row) => !row.type.is_root)
    .map((row) => ({ id: row.type.id, label: row.type.name, depth: row.depth - 1 }));
  const picked = await openTypePickerDialog('Типы мыслей', rows, state.typeIds);
  if (picked === null) return;
  state.typeIds = picked;
  touch();
  renderThoughtTypeField();
}

async function openLinkTypesPicker(): Promise<void> {
  const rows = orderedTypeRows(store.state.linkTypes)
    .filter((row) => !row.type.is_root)
    .map((row) => ({ id: row.type.id, label: row.type.name_forward, depth: row.depth - 1 }));
  const picked = await openTypePickerDialog('Типы связей', rows, state.linkTypeIds);
  if (picked === null) return;
  state.linkTypeIds = picked;
  touch();
  renderLinkTypeField();
}

// ---------------------------------------------------------------------------
// Type picker dialog (search + multi-column checklist + «Применить», §15.3)
// ---------------------------------------------------------------------------

/** Minimum column width of a checklist, px (columns fill the dialog width). */
const CHECK_COL_W = 85;
/** Column gap, px (must match the CSS column-gap). */
const CHECK_COL_GAP = 14;
/** Fixed height of one checklist row, px (must match the CSS row height). */
const CHECK_ROW_H = 22;

/**
 * Recomputes the column count of a checklist for its current height and width:
 * as many columns as fit the dialog width; when the items need more columns
 * than that, the last column overflows downward and the list scrolls
 * vertically (`column-fill: auto`).
 */
function applyCheckColumns(list: HTMLElement): void {
  const rowsPerCol = Math.max(1, Math.floor(list.clientHeight / CHECK_ROW_H));
  const needed = Math.ceil(list.children.length / rowsPerCol);
  const maxCols = Math.max(1, Math.floor((list.clientWidth + CHECK_COL_GAP) / (CHECK_COL_W + CHECK_COL_GAP)));
  const count = Math.max(1, Math.min(needed, maxCols));
  list.style.columnCount = String(count);
  list.style.columnFill = needed > count ? 'auto' : 'balance';
}

/**
 * Modal type picker: a search box filtering as you type, a multi-column
 * checklist (checked first, then alphabetical) and «Отмена»/«Применить».
 * Resolves the picked id list, or `null` when cancelled.
 */
function openTypePickerDialog(
  title: string,
  rows: Array<{ id: string; label: string; depth: number }>,
  initial: string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const checked = new Set(initial);
    let needle = '';
    let settled = false;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = div('st-f-picker');
    const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
    searchInput.type = 'text';
    searchInput.placeholder = 'Найти…';
    const list = div('st-f-checks st-f-picker-list');
    const clearBtn = el('button', 'st-f-clear', 'Очистить');
    clearBtn.type = 'button';

    const renderList = (): void => {
      clear(list);
      const filtered = rows.filter((row) => row.label.toLowerCase().includes(needle));
      const byAlpha = (a: (typeof rows)[number], b: (typeof rows)[number]): number =>
        a.label.localeCompare(b.label, 'ru');
      const sorted = [
        ...filtered.filter((row) => checked.has(row.id)).sort(byAlpha),
        ...filtered.filter((row) => !checked.has(row.id)).sort(byAlpha),
      ];
      if (sorted.length === 0) list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
      for (const row of sorted) {
        const line = el('label', 'st-f-check');
        line.style.paddingLeft = `${Math.max(0, row.depth) * 14}px`;
        const input = el('input') as HTMLInputElement;
        input.type = 'checkbox';
        input.checked = checked.has(row.id);
        input.addEventListener('change', () => {
          if (input.checked) checked.add(row.id);
          else checked.delete(row.id);
          clearBtn.disabled = checked.size === 0;
          renderList();
        });
        line.append(input, el('span', '', row.label));
        list.append(line);
      }
      if (list.isConnected) applyCheckColumns(list);
      else requestAnimationFrame(() => applyCheckColumns(list));
    };
    searchInput.addEventListener('input', () => {
      needle = searchInput.value.trim().toLowerCase();
      renderList();
    });
    clearBtn.disabled = checked.size === 0;
    clearBtn.addEventListener('click', () => {
      checked.clear();
      renderList();
      clearBtn.disabled = true;
    });
    body.append(searchInput, list, clearBtn);

    showDialog({
      title,
      body,
      width: 480,
      buttons: [
        { label: 'Отмена', onClick: () => finish(null) },
        { label: 'Применить', primary: true, onClick: () => finish([...checked]) },
      ],
      onMount: () => {
        renderList();
        searchInput.focus();
      },
    });
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
  const valueBox = buildValueEditor(cond, def, index);

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
 * Builds the value editor for the condition's current value type (§15.3).
 *
 * The editor mirrors the thought editor (§6.3): text properties with
 * predefined options get the options dropdown, `thought_ref` gets the live
 * candidate search plus the dialog picker. Every handler reads the CURRENT
 * condition row from the state (`live()`), never the closure-captured one —
 * the «+ значение» button must not lose values typed into earlier rows.
 */
function buildValueEditor(
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
  const setValue = (i: number, v: string): void => {
    const current = live();
    const values = [...current.values];
    while (values.length <= i) values.push('');
    values[i] = v;
    state.properties[index] = { ...current, values };
    touch();
  };

  const addScalar = (i: number): HTMLElement => {
    if (valueType === 'number') {
      const input = el('input', 'st-f-input') as HTMLInputElement;
      input.type = 'number';
      input.value = live().values[i] ?? '';
      input.addEventListener('input', () => setValue(i, input.value));
      return input;
    }
    if (valueType === 'date') {
      const input = el('input', 'st-f-input') as HTMLInputElement;
      input.type = 'date';
      input.value = live().values[i] ?? '';
      input.addEventListener('input', () => setValue(i, input.value));
      return input;
    }
    if (valueType === 'bool') {
      const select = el('select', 'st-f-input') as HTMLSelectElement;
      const yes = el('option', '', 'да') as HTMLOptionElement;
      yes.value = 'true';
      const no = el('option', '', 'нет') as HTMLOptionElement;
      no.value = 'false';
      select.append(yes, no);
      select.value = live().values[i] === 'false' ? 'false' : 'true';
      select.addEventListener('change', () => setValue(i, select.value));
      return select;
    }
    if (valueType === 'thought_ref') {
      return buildThoughtRefEditor(def, index, i);
    }
    const input = el('input', 'st-f-input') as HTMLInputElement;
    input.type = 'text';
    input.value = live().values[i] ?? '';
    input.addEventListener('input', () => setValue(i, input.value));
    // Text properties with predefined options get the picker dropdown — an
    // input aid, never a restriction (same as the thought editor, §6.3).
    const options = (def?.config?.options ?? []).filter((o) => o !== '');
    if (options.length > 0) {
      const row = div('st-f-value-row');
      row.append(
        input,
        buildValueOptionsCaret(
          input,
          options,
          false,
          (value) => setValue(i, value),
          () => {
            input.value = live().values[i] ?? '';
          },
        ),
      );
      return row;
    }
    return input;
  };

  if (isPresence) {
    box.append(el('span', 'st-f-value-hint', 'значение не требуется'));
    return box;
  }
  if (!isList) {
    box.append(addScalar(0));
    return box;
  }

  // List editor: one row per value + the «+» button (OR inside the list).
  const renderList = (): void => {
    clear(box);
    const values = live().values.length > 0 ? live().values : [''];
    values.forEach((_, i) => {
      const line = div('st-f-value-row');
      line.append(addScalar(i));
      const rm = el('button', 'st-f-remove', '×');
      rm.type = 'button';
      rm.addEventListener('click', () => {
        const current = live();
        const next = current.values.filter((_, j) => j !== i);
        state.properties[index] = { ...current, values: next.length > 0 ? next : [''] };
        touch();
        renderList();
      });
      line.append(rm);
      box.append(line);
    });
    const add = el('button', 'st-f-add', '+ значение');
    add.type = 'button';
    add.addEventListener('click', () => {
      const current = live();
      state.properties[index] = { ...current, values: [...current.values, ''] };
      touch();
      renderList();
    });
    box.append(add);
  };
  renderList();
  return box;
}

/**
 * Thought-ref value editor, same as the thought editor (§6.3): the field
 * doubles as a live candidate search and a dialog picker button; only an
 * explicitly picked thought writes the value (its id), the field shows the
 * thought's title.
 */
function buildThoughtRefEditor(
  def: { config?: PropertyConfig | null } | undefined,
  index: number,
  valueIndex: number,
): HTMLElement {
  const networkId = store.state.networkId;
  const row = div('st-f-ref-row');
  const live = (): PropertyConditionState => state.properties[index]!;
  const setValue = (v: string): void => {
    const current = live();
    const values = [...current.values];
    while (values.length <= valueIndex) values.push('');
    values[valueIndex] = v;
    state.properties[index] = { ...current, values };
    touch();
  };

  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = 'введите название для поиска…';

  const storedId = live().values[valueIndex] ?? '';
  if (storedId !== '') {
    const title = refTitles.get(storedId) ?? 'Мысль…';
    input.value = title;
    if (networkId !== null && !refTitles.has(storedId)) {
      // The stored id may have no title cached (restored from a saved
      // filter) — resolve it asynchronously.
      void etn.thoughts
        .resolve(networkId, [storedId])
        .then((refs) => {
          const ref = refs[0];
          if (ref !== undefined) {
            refTitles.set(ref.id, ref.title);
            if (input.isConnected) input.value = ref.title;
          }
        })
        .catch(() => undefined);
    }
  }

  if (networkId !== null) {
    const filterIds = (
      def?.config?.allowed_type_ids ??
      (def?.config?.allowed_type_id !== undefined ? [def.config.allowed_type_id] : [])
    ).filter((id) => id !== '');
    wireThoughtRefSearch(input, {
      networkId,
      typeIds: filterIds,
      onPick: (id) => {
        refTitles.set(id, input.value);
        setValue(id);
      },
    });
    const pick = el('button', 'st-f-add st-f-ref-pick', 'выбрать') as HTMLButtonElement;
    pick.type = 'button';
    pick.addEventListener('click', () => {
      void pickThoughtsDialog({
        networkId,
        allowCreate: false,
        allowLinkType: false,
        searchTypeIds: filterIds,
      }).then(async (result) => {
        const id = firstPickedThoughtId(result);
        if (id === null) return;
        try {
          const [ref] = await etn.thoughts.resolve(networkId, [id]);
          if (ref !== undefined) {
            refTitles.set(ref.id, ref.title);
            input.value = ref.title;
          } else {
            input.value = 'Мысль…';
          }
        } catch {
          input.value = 'Мысль…';
        }
        setValue(id);
      });
    });
    row.append(input, pick);
  } else {
    row.append(input);
  }
  return row;
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

/** Applies a saved filter to the panel and reruns the query. */
function applySavedFilter(filter: SavedFilter): void {
  const def = filter.definition;
  const scope = def.keyword_scope ?? [];
  setFilterState({
    keywords: def.keywords ?? '',
    keywordInTitle: scope.length === 0 ? true : scope.includes('title'),
    keywordInSynonyms: scope.length === 0 ? true : scope.includes('synonyms'),
    keywordInComment: scope.includes('comment'),
    parentIds: def.parent_ids ?? [],
    typeIds: def.type_ids ?? [],
    linkTypeIds: def.link_type_ids ?? [],
    properties: (def.properties ?? []).map((c) => ({
      propertyId: c.property_id,
      op: c.op,
      values: Array.isArray(c.value) ? c.value.map((v) => String(v)) : [String(c.value)],
    })),
    hasProperties: def.has_properties ?? null,
    hasComment: def.has_comment ?? null,
    hasAttachments: def.has_attachments ?? null,
    hasChronology: def.has_chronology ?? null,
    active: def.active ?? null,
    trashed: def.trashed ?? false,
    // Задача 59119797: фильтры авторства читаются прямо из сохранённого
    // определения. Отсутствующие поля — «не применять».
    authorId: typeof def.created_by === 'string' ? def.created_by : '',
    authorIds: Array.isArray(def.created_by) ? def.created_by : [],
    authorOp: (def.created_by_op ?? 'eq') as StructureAuthorOp,
    editorId: typeof def.updated_by === 'string' ? def.updated_by : '',
    editorIds: Array.isArray(def.updated_by) ? def.updated_by : [],
    editorOp: (def.updated_by_op ?? 'eq') as StructureAuthorOp,
    sort: def.sort,
    order: def.order,
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
  const keywordScope = buildKeywordScope();
  const definition = {
    ...(state.keywords.trim() !== '' ? { keywords: state.keywords.trim() } : {}),
    ...(state.keywords.trim() !== '' && keywordScope !== undefined ? { keyword_scope: keywordScope } : {}),
    ...(state.parentIds.length > 0 ? { parent_ids: state.parentIds } : {}),
    ...(state.typeIds.length > 0 ? { type_ids: state.typeIds } : {}),
    ...(state.linkTypeIds.length > 0 ? { link_type_ids: state.linkTypeIds } : {}),
    ...(buildConditions().length > 0 ? { properties: buildConditions() } : {}),
    ...buildExtraFilter(),
    ...(store.state.showInactive ? { show_inactive: true } : {}),
    sort: state.sort,
    order: state.order,
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
