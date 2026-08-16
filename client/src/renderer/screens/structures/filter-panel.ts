/**
 * Filter panel of the «Структуры мыслей» view (L15, 08-ui-spec.md §15.3).
 *
 * Left column: keywords (mini-syntax), thought-type and link-type checkboxes,
 * property conditions with per-type operators and value editors, sort, the
 * «Применить» button and the saved-filters block. The panel owns the filter
 * DOM and the string→wire value conversion; the host module (`structures.ts`)
 * owns the query lifecycle and persists the state (L4 `structures_state`).
 */

import {
  type PropertyConfig,
  type PropertyDefinition,
  type PropertyValueType,
  type SavedFilter,
  type SortOrder,
  type StructurePropertyCondition,
  type StructurePropertyOp,
  type StructureSort,
} from '@etn/shared';

import { buildValueOptionsCaret } from '../../editor/properties.js';
import { pickThoughtRef, wireThoughtRefSearch } from '../../editor/thought-picker.js';
import { clear, div, el, errText, setTooltip } from '../../lib/dom.js';
import { confirmDialog, errorDialog, promptDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
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

/** Full filter-panel state (persisted as the L4 `structures_state` JSON). */
export interface FilterState {
  keywords: string;
  typeIds: string[];
  linkTypeIds: string[];
  properties: PropertyConditionState[];
  sort: StructureSort;
  order: SortOrder;
  savedFilterId: string | null;
  /** Panel width set by the splitter drag (px), null until first drag. */
  panelWidth: number | null;
  /** Checklist heights set by the group grips (px), null until dragged. */
  typeListHeight: number | null;
  linkTypeListHeight: number | null;
}

/** Callbacks the panel fires into the host module. */
export interface FilterPanelCallbacks {
  /** «Применить» clicked (or a saved filter applied) — rerun the query. */
  onApply(): void;
  /** Any field changed — persist the state (L4). */
  onStatePersist(): void;
}

/** Operators per property value type (03-server-api.md §6.10). */
const OPS_BY_TYPE: Record<PropertyValueType, Array<{ op: StructurePropertyOp; label: string }>> = {
  text: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
  ],
  url: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
  ],
  date: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
  ],
  number: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
  ],
  bool: [{ op: 'eq', label: 'равно' }],
  thought_ref: [
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
  ],
};

/** Default panel state: empty filter → HOME only (§15.3). */
function defaultState(): FilterState {
  return {
    keywords: '',
    typeIds: [],
    linkTypeIds: [],
    properties: [],
    sort: 'created',
    order: 'asc',
    savedFilterId: null,
    panelWidth: null,
    typeListHeight: null,
    linkTypeListHeight: null,
  };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
let callbacks: FilterPanelCallbacks | null = null;
let state: FilterState = defaultState();

/** Property definitions across all thought types (loaded per network). */
const propertyDefs = new Map<string, { def: PropertyDefinition; typeName: string }>();
/** Thought-ref titles for value chips (resolved lazily). */
const refTitles = new Map<string, string>();
let savedFilters: SavedFilter[] = [];
/** Signature of the catalogues the panel depends on (rebuild on change). */
let catalogueSignature = '';

// DOM anchors rebuilt in renderPanel().
let keywordsInput: HTMLInputElement | null = null;
let conditionsBox: HTMLElement | null = null;
let sortSelect: HTMLSelectElement | null = null;
let orderSelect: HTMLSelectElement | null = null;
let saveNameInput: HTMLInputElement | null = null;
let savedListBox: HTMLElement | null = null;

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

/** Wire property conditions built from the panel rows (typed conversion). */
export function buildConditions(): StructurePropertyCondition[] {
  const out: StructurePropertyCondition[] = [];
  for (const cond of state.properties) {
    const def = propertyDefs.get(cond.propertyId);
    if (def === undefined) continue; // property deleted — server skips it too
    const list = cond.op === 'in' || cond.op === 'not_in';
    const rawValues = list ? cond.values : cond.values.slice(0, 1);
    const values: Array<string | number | boolean> = [];
    for (const raw of rawValues) {
      if (raw === '') continue;
      if (def.def.value_type === 'number') {
        const num = Number(raw);
        if (!Number.isFinite(num)) continue;
        values.push(num);
      } else if (def.def.value_type === 'bool') {
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
    const signature = `${store.state.networkId ?? ''}|${store.state.thoughtTypes.map((t) => t.id).join(',')}|${store.state.linkTypes.map((t) => t.id).join(',')}`;
    if (signature !== catalogueSignature) {
      catalogueSignature = signature;
      void loadPropertyDefs().then(() => renderPanel());
    }
  });
  void loadPropertyDefs().then(() => renderPanel());
}

/** Loads the property definitions of every thought type of the network. */
async function loadPropertyDefs(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  propertyDefs.clear();
  const types = store.state.thoughtTypes;
  await Promise.all(
    types.map(async (type) => {
      try {
        const defs = await etn.types.listTypeProperties(networkId, 'thought_type', type.id);
        for (const def of defs) propertyDefs.set(def.id, { def, typeName: type.name });
      } catch {
        // Type vanished or not readable — its properties are skipped.
      }
    }),
  );
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
// Panel DOM
// ---------------------------------------------------------------------------

/** Section block with a title. */
function block(title: string): { box: HTMLElement; body: HTMLElement } {
  const box = div('st-f-block');
  const head = el('div', 'st-f-title', title);
  const body = div('st-f-body');
  box.append(head, body);
  return { box, body };
}

/** Rebuilds the whole panel from `state`. */
function renderPanel(): void {
  if (host === null) return;
  clear(host);
  applyPanelWidth();

  // --- keywords -------------------------------------------------------------
  const kw = block('Ключевые слова');
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
    callbacks?.onStatePersist();
  });
  keywordsInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') callbacks?.onApply();
  });
  kw.body.append(keywordsInput);
  host.append(kw.box);

  // --- thought types --------------------------------------------------------
  const tt = block('Типы мыслей');
  renderCheckGroup(
    tt.body,
    store.state.thoughtTypes.map((t) => ({ id: t.id, label: t.name })),
    () => state.typeIds,
    (ids) => {
      state.typeIds = ids;
      callbacks?.onStatePersist();
    },
    'thoughtTypes',
  );
  host.append(tt.box);

  // --- link types -----------------------------------------------------------
  const lt = block('Типы связей');
  renderCheckGroup(
    lt.body,
    store.state.linkTypes.map((t) => ({ id: t.id, label: t.name_forward })),
    () => state.linkTypeIds,
    (ids) => {
      state.linkTypeIds = ids;
      callbacks?.onStatePersist();
    },
    'linkTypes',
  );
  host.append(lt.box);

  // --- property conditions --------------------------------------------------
  const props = block('Свойства');
  conditionsBox = div('st-f-conds');
  renderConditions();
  const addCond = el('button', 'st-f-add', '+ условие');
  addCond.type = 'button';
  addCond.addEventListener('click', () => {
    const first = [...propertyDefs.values()][0];
    state.properties = [
      ...state.properties,
      first
        ? { propertyId: first.def.id, op: OPS_BY_TYPE[first.def.value_type][0]!.op, values: [''] }
        : { propertyId: '', op: 'eq', values: [''] },
    ];
    callbacks?.onStatePersist();
    renderConditions();
  });
  props.body.append(conditionsBox, addCond);
  host.append(props.box);

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
    callbacks?.onStatePersist();
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
    callbacks?.onStatePersist();
  });
  sortRow.append(sortSelect, orderSelect);
  sortBlock.body.append(sortRow);
  host.append(sortBlock.box);

  // --- apply ----------------------------------------------------------------
  const apply = el('button', 'st-f-apply', 'Применить');
  apply.type = 'button';
  apply.addEventListener('click', () => callbacks?.onApply());
  host.append(apply);

  // --- saved filters --------------------------------------------------------
  const saved = block('Сохранённые отборы');
  const saveRow = div('st-f-saverow');
  saveNameInput = el('input', 'st-f-input') as HTMLInputElement;
  saveNameInput.type = 'text';
  saveNameInput.placeholder = 'имя отбора';
  const saveBtn = el('button', 'st-f-save', 'Сохранить');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => void saveCurrentFilter());
  saveRow.append(saveNameInput, saveBtn);
  savedListBox = div('st-f-savedlist');
  saved.body.append(saveRow, savedListBox);
  host.append(saved.box);
  renderSavedList();
}

// ---------------------------------------------------------------------------
// Type checklists (§15.3)
// ---------------------------------------------------------------------------

/** Which checklist a group's search text / height belongs to. */
type CheckKind = 'thoughtTypes' | 'linkTypes';

/** Live search text of the two checklists (survives panel re-renders). */
const checkSearch: Record<CheckKind, string> = { thoughtTypes: '', linkTypes: '' };
/** Fixed height of one checklist row, px (must match the CSS row height). */
const CHECK_ROW_H = 22;
/** Minimum column width of a checklist, px (columns fill the panel width). */
const CHECK_COL_W = 170;
/** Column gap, px (must match the CSS column-gap). */
const CHECK_COL_GAP = 14;
/** Drag range of the checklist height grips, px. */
const CHECK_H_MIN = 60;
const CHECK_H_MAX = 420;

/** Persisted height of the given checklist (null — the CSS default). */
function checkHeight(kind: CheckKind): number | null {
  return kind === 'thoughtTypes' ? state.typeListHeight : state.linkTypeListHeight;
}

/** Records the grip-dragged checklist height for the L4 persist. */
function setCheckHeight(kind: CheckKind, height: number): void {
  if (kind === 'thoughtTypes') state.typeListHeight = height;
  else state.linkTypeListHeight = height;
  callbacks?.onStatePersist();
}

/**
 * Recomputes the column count of a checklist for its current height and width:
 * as many columns as fit the panel width; when the items need more columns
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

/** Renders only the checklist rows (search, grip and clear button survive). */
function renderCheckItems(
  list: HTMLElement,
  items: Array<{ id: string; label: string }>,
  getChecked: () => string[],
  onChange: (ids: string[]) => void,
  kind: CheckKind,
): void {
  const scrollTop = list.scrollTop;
  clear(list);
  const checked = new Set(getChecked());
  const needle = checkSearch[kind].trim().toLowerCase();
  const matches = items.filter((i) => i.label.toLowerCase().includes(needle));
  const byAlpha = (a: { label: string }, b: { label: string }): number =>
    a.label.localeCompare(b.label, 'ru');
  // Checked items first, the rest alphabetically (§15.3).
  const sorted = [
    ...matches.filter((i) => checked.has(i.id)).sort(byAlpha),
    ...matches.filter((i) => !checked.has(i.id)).sort(byAlpha),
  ];
  if (sorted.length === 0) {
    list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
  }
  for (const item of sorted) {
    const line = el('label', 'st-f-check');
    line.dataset['id'] = item.id;
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = checked.has(item.id);
    const label = el('span', '', item.label);
    line.append(input, label);
    list.append(line);
  }
  if (list.isConnected) applyCheckColumns(list);
  else requestAnimationFrame(() => applyCheckColumns(list));
}

/**
 * Renders one checklist group: a search box filtering as you type, a
 * multi-column checklist (checked first, then alphabetical), a height grip on
 * the group's bottom border and a «Очистить» button dropping every check.
 */
function renderCheckGroup(
  box: HTMLElement,
  items: Array<{ id: string; label: string }>,
  getChecked: () => string[],
  onChange: (ids: string[]) => void,
  kind: CheckKind,
): void {
  clear(box);
  box.classList.add('st-f-group');

  const search = el('input', 'st-f-input st-f-search') as HTMLInputElement;
  search.type = 'text';
  search.placeholder = 'Найти…';
  search.value = checkSearch[kind];
  search.addEventListener('input', () => {
    checkSearch[kind] = search.value;
    renderCheckItems(list, items, getChecked, onChange, kind);
  });
  box.append(search);

  const list = div('st-f-checks');
  const height = checkHeight(kind);
  if (height !== null) list.style.setProperty('--st-checks-h', `${height}px`);
  box.append(list);
  renderCheckItems(list, items, getChecked, onChange, kind);

  const grip = div('st-f-grip');
  setTooltip(grip, 'Изменить высоту списка');
  grip.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    const startY = event.clientY;
    const startH = checkHeight(kind) ?? 132;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('dragging');
    const onMove = (ev: PointerEvent): void => {
      const h = Math.min(CHECK_H_MAX, Math.max(CHECK_H_MIN, startH + (ev.clientY - startY)));
      setCheckHeight(kind, h);
      list.style.setProperty('--st-checks-h', `${h}px`);
      applyCheckColumns(list);
    };
    const onUp = (): void => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.classList.remove('dragging');
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
  });
  box.append(grip);

  const clearBtn = el('button', 'st-f-clear', 'Очистить');
  clearBtn.type = 'button';
  clearBtn.disabled = getChecked().length === 0;
  clearBtn.addEventListener('click', () => {
    if (getChecked().length === 0) return;
    onChange([]);
    renderCheckItems(list, items, getChecked, onChange, kind);
    clearBtn.disabled = true;
  });
  box.append(clearBtn);

  // One delegated handler for every checkbox: re-sorts the list (checked
  // items jump to the top) and keeps the «Очистить» state in sync.
  box.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.type !== 'checkbox') return;
    const line = input.closest<HTMLElement>('.st-f-check');
    const id = line?.dataset['id'];
    if (id === undefined) return;
    const next = new Set(getChecked());
    if (input.checked) next.add(id);
    else next.delete(id);
    onChange([...next]);
    renderCheckItems(list, items, getChecked, onChange, kind);
    clearBtn.disabled = getChecked().length === 0;
  });
}

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
  const meta = propertyDefs.get(cond.propertyId);
  const def = meta?.def;

  // Property picker (grouped labels: «Тип · свойство»).
  const propSelect = el('select', 'st-f-input st-f-prop') as HTMLSelectElement;
  if (!propertyDefs.has(cond.propertyId)) {
    const placeholder = el('option', '', cond.propertyId === '' ? '— свойство —' : '?') as HTMLOptionElement;
    placeholder.value = cond.propertyId;
    propSelect.append(placeholder);
  }
  for (const [id, entry] of propertyDefs) {
    const option = el('option', '', `${entry.typeName} · ${entry.def.key}`) as HTMLOptionElement;
    option.value = id;
    propSelect.append(option);
  }
  propSelect.value = cond.propertyId;
  propSelect.addEventListener('change', () => {
    const nextId = propSelect.value;
    const nextType = propertyDefs.get(nextId)?.def.value_type ?? 'text';
    const ops = OPS_BY_TYPE[nextType];
    // A different property starts with one empty value.
    state.properties[index] = {
      propertyId: nextId,
      op: ops.some((o) => o.op === cond.op) ? cond.op : ops[0]!.op,
      values: [''],
    };
    callbacks?.onStatePersist();
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
    callbacks?.onStatePersist();
    renderConditions();
  });

  // Value editor.
  const valueBox = buildValueEditor(cond, def, index);

  const remove = el('button', 'st-f-remove', '×');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    state.properties = state.properties.filter((_, i) => i !== index);
    callbacks?.onStatePersist();
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
  const live = (): PropertyConditionState => state.properties[index] ?? cond;
  const setValue = (i: number, v: string): void => {
    const current = live();
    const values = [...current.values];
    while (values.length <= i) values.push('');
    values[i] = v;
    state.properties[index] = { ...current, values };
    callbacks?.onStatePersist();
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
        callbacks?.onStatePersist();
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
      callbacks?.onStatePersist();
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
    callbacks?.onStatePersist();
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
      void pickThoughtRef(networkId, filterIds).then(async (id) => {
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
// Saved filters
// ---------------------------------------------------------------------------

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
  setFilterState({
    keywords: def.keywords ?? '',
    typeIds: def.type_ids ?? [],
    linkTypeIds: def.link_type_ids ?? [],
    properties: (def.properties ?? []).map((c) => ({
      propertyId: c.property_id,
      op: c.op,
      values: Array.isArray(c.value) ? c.value.map((v) => String(v)) : [String(c.value)],
    })),
    sort: def.sort,
    order: def.order,
    savedFilterId: filter.id,
    panelWidth: state.panelWidth,
    typeListHeight: state.typeListHeight,
    linkTypeListHeight: state.linkTypeListHeight,
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
  const definition = {
    ...(state.keywords.trim() !== '' ? { keywords: state.keywords.trim() } : {}),
    ...(state.typeIds.length > 0 ? { type_ids: state.typeIds } : {}),
    ...(state.linkTypeIds.length > 0 ? { link_type_ids: state.linkTypeIds } : {}),
    ...(buildConditions().length > 0 ? { properties: buildConditions() } : {}),
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
    callbacks?.onStatePersist();
  }
  await loadSavedFilters();
}
