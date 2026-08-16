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
  type PropertyDefinition,
  type PropertyValueType,
  type SavedFilter,
  type SortOrder,
  type StructurePropertyCondition,
  type StructurePropertyOp,
  type StructureSort,
} from '@etn/shared';

import { pickThoughtRef } from '../../editor/thought-picker.js';
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
let thoughtTypesBox: HTMLElement | null = null;
let linkTypesBox: HTMLElement | null = null;
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
  thoughtTypesBox = div('st-f-checks');
  renderCheckList(
    thoughtTypesBox,
    store.state.thoughtTypes.map((t) => ({ id: t.id, label: t.name })),
    () => state.typeIds,
    (ids) => {
      state.typeIds = ids;
      callbacks?.onStatePersist();
    },
  );
  tt.body.append(thoughtTypesBox);
  host.append(tt.box);

  // --- link types -----------------------------------------------------------
  const lt = block('Типы связей');
  linkTypesBox = div('st-f-checks');
  renderCheckList(
    linkTypesBox,
    store.state.linkTypes.map((t) => ({ id: t.id, label: t.name_forward })),
    () => state.linkTypeIds,
    (ids) => {
      state.linkTypeIds = ids;
      callbacks?.onStatePersist();
    },
  );
  lt.body.append(linkTypesBox);
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

/** Renders a checkbox list; reads/writes the checked ids via the getters. */
function renderCheckList(
  box: HTMLElement,
  items: Array<{ id: string; label: string }>,
  getChecked: () => string[],
  onChange: (ids: string[]) => void,
): void {
  clear(box);
  if (items.length === 0) {
    const empty = el('div', 'st-f-empty', '—');
    box.append(empty);
    return;
  }
  const checkedSet = new Set(getChecked());
  for (const item of items) {
    const line = el('label', 'st-f-check');
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = checkedSet.has(item.id);
    input.addEventListener('change', () => {
      const next = new Set(getChecked());
      if (input.checked) next.add(item.id);
      else next.delete(item.id);
      onChange([...next]);
    });
    const label = el('span', '', item.label);
    line.append(input, label);
    box.append(line);
  }
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
    state.properties[index] = { ...cond, op: opSelect.value as StructurePropertyOp, values: [''] };
    callbacks?.onStatePersist();
    renderConditions();
  });

  // Value editor.
  const valueBox = buildValueEditor(cond, def?.value_type ?? 'text', index);

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

/** Builds the value editor for the condition's current value type. */
function buildValueEditor(
  cond: PropertyConditionState,
  valueType: PropertyValueType,
  index: number,
): HTMLElement {
  const box = div('st-f-values');
  const isList = cond.op === 'in' || cond.op === 'not_in';
  const setValue = (i: number, v: string): void => {
    const values = [...cond.values];
    while (values.length <= i) values.push('');
    values[i] = v;
    state.properties[index] = { ...cond, values };
    callbacks?.onStatePersist();
  };

  const addScalar = (i: number): HTMLElement => {
    if (valueType === 'number') {
      const input = el('input', 'st-f-input') as HTMLInputElement;
      input.type = 'number';
      input.value = cond.values[i] ?? '';
      input.addEventListener('input', () => setValue(i, input.value));
      return input;
    }
    if (valueType === 'date') {
      const input = el('input', 'st-f-input') as HTMLInputElement;
      input.type = 'date';
      input.value = cond.values[i] ?? '';
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
      select.value = cond.values[i] === 'false' ? 'false' : 'true';
      select.addEventListener('change', () => setValue(i, select.value));
      return select;
    }
    if (valueType === 'thought_ref') {
      return buildThoughtRefEditor(cond, index, i);
    }
    const input = el('input', 'st-f-input') as HTMLInputElement;
    input.type = 'text';
    input.value = cond.values[i] ?? '';
    input.addEventListener('input', () => setValue(i, input.value));
    return input;
  };

  if (!isList) {
    box.append(addScalar(0));
    return box;
  }

  // List editor: one row per value + the «+» button (OR inside the list).
  const renderList = (): void => {
    clear(box);
    const values = cond.values.length > 0 ? cond.values : [''];
    values.forEach((_, i) => {
      const line = div('st-f-value-row');
      const editor = valueType === 'thought_ref' ? buildThoughtRefEditor(cond, index, i) : addScalar(i);
      const rm = el('button', 'st-f-remove', '×');
      rm.type = 'button';
      rm.addEventListener('click', () => {
        const next = cond.values.filter((_, j) => j !== i);
        state.properties[index] = { ...cond, values: next.length > 0 ? next : [''] };
        callbacks?.onStatePersist();
        renderList();
      });
      line.append(editor, rm);
      box.append(line);
    });
    const add = el('button', 'st-f-add', '+ значение');
    add.type = 'button';
    add.addEventListener('click', () => {
      state.properties[index] = { ...cond, values: [...cond.values, ''] };
      callbacks?.onStatePersist();
      renderList();
    });
    box.append(add);
  };
  renderList();
  return box;
}

/** Thought-ref value chip: pick a thought via the shared picker (§15.3). */
function buildThoughtRefEditor(
  cond: PropertyConditionState,
  index: number,
  valueIndex: number,
): HTMLElement {
  const currentId = cond.values[valueIndex] ?? '';
  const chip = el('button', 'st-f-input st-f-ref') as HTMLButtonElement;
  chip.type = 'button';
  const id = currentId === '' ? null : currentId;
  const title = id !== null ? (refTitles.get(id) ?? 'Мысль…') : 'Выбрать мысль…';
  chip.textContent = title;
  setTooltip(chip, title);
  chip.addEventListener('click', async () => {
    const networkId = store.state.networkId;
    if (networkId === null) return;
    const picked = await pickThoughtRef(networkId);
    if (picked === null) return;
    try {
      const [ref] = await etn.thoughts.resolve(networkId, [picked]);
      if (ref !== undefined) refTitles.set(ref.id, ref.title);
    } catch {
      // Title stays unknown — the chip falls back to the generic label.
    }
    const values = [...cond.values];
    while (values.length <= valueIndex) values.push('');
    values[valueIndex] = picked;
    state.properties[index] = { ...cond, values };
    callbacks?.onStatePersist();
    chip.textContent = refTitles.get(picked) ?? 'Мысль…';
  });
  return chip;
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
