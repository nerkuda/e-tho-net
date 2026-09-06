/**
 * Filter panel of the «Хроника» view (L20, 08-ui-spec.md §17).
 *
 * Four rows per the spec:
 *   1. saved filter selector (choice = fill + apply) + period «с»/«по» + the
 *      keywords search box (`*` wildcard, `-` exclusion, searched in
 *      titles/synonyms/comments);
 *   2. «мысли» chips (multi-thought picker dialog, «Выбрать…»/«Очистить») +
 *      «+подчинённые»;
 *   3. thought types + link types (checkbox-list dialogs) + link scope
 *      (sources/targets/both);
 *   4. sort order + «Применить» (Ctrl+Enter) + «Очистить отбор» + filter name
 *      + «Сохранить отбор» (overwrites by name) + «Удалить отбор».
 *
 * The panel holds the filter state; the host module reads it via
 * {@link getFilterState} and writes it via {@link setFilterState} (L4 restore
 * and saved-filter apply).
 */

import { STRUCTURE_AUTHOR_OPS, type ChronicleSavedFilter, type StructureAuthorOp, type ThoughtRef } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../../canvas/add-dialog.js';
import { applyThoughtIcon } from '../../canvas/canvas.js';
import { button, div, el, span, setTooltip } from '../../lib/dom.js';
import { showDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import { markThoughtCommentPreview } from '../../lib/hover-preview.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { errText } from '../../lib/dom.js';
import { orderedTypeRows } from '../../lib/type-tree.js';
import { buildUserMultiSelectWidget, buildUserSelectWidget } from '../../lib/users.js';
import { store } from '../../state.js';
import { DEFAULT_FILTER, fromDefinition, toDefinition } from './state.js';
import type { ChronicleFilterState } from './state.js';

export type { ChronicleFilterState } from './state.js';

const LINK_SCOPE_LABELS: Record<ChronicleFilterState['linkScope'], string> = {
  sources: 'только источники связей',
  targets: 'только назначения связей',
  both: 'источники и назначения связей',
};

/** Russian labels for the chronicle author-op dropdown (задача 59119797). */
const AUTHOR_OP_LABELS: Record<StructureAuthorOp, string> = {
  eq: 'равен',
  ne: 'не равен',
  in: 'в списке',
  not_in: 'не в списке',
  empty: 'не заполнено',
  not_empty: 'заполнено',
};

/** Строит одну строку условия авторства хроники: «подпись / оператор / значение». */
function buildChronicleAuthorRow(opts: {
  label: string;
  op: StructureAuthorOp;
  singleId: string;
  listIds: string[];
  onOpChange: (op: StructureAuthorOp) => void;
  onSingleChange: (id: string) => void;
  onListChange: (ids: string[]) => void;
}): HTMLElement {
  const row = div('chron-author-row');
  row.append(span(opts.label, 'chron-label'));
  const opSelect = el('select', 'select-input chron-author-op') as HTMLSelectElement;
  for (const op of STRUCTURE_AUTHOR_OPS) {
    const option = el('option', '', AUTHOR_OP_LABELS[op]) as HTMLOptionElement;
    option.value = op;
    opSelect.append(option);
  }
  opSelect.value = opts.op;
  opSelect.addEventListener('change', () => {
    opts.onOpChange(opSelect.value as StructureAuthorOp);
  });
  row.append(opSelect);

  if (opts.op === 'empty' || opts.op === 'not_empty') {
    row.append(el('span', 'muted', 'значение не требуется'));
    return row;
  }
  if (opts.op === 'in' || opts.op === 'not_in') {
    const multi = buildUserMultiSelectWidget({
      label: 'участники',
      currentIds: opts.listIds,
      onChange: opts.onListChange,
    });
    row.append(multi);
    return row;
  }
  const single = buildUserSelectWidget({
    label: 'участник',
    currentId: opts.singleId,
    onChange: opts.onSingleChange,
  });
  row.append(single);
  return row;
}

let filter: ChronicleFilterState = { ...DEFAULT_FILTER };
/** Ref of the selected saved filter (null — not saved yet / custom). */
let savedFilterId: string | null = null;
/** Chip meta of the «мысли» field, resolved by id (not persisted). */
const thoughtRefs = new Map<string, ThoughtRef>();
/** Reference to the chips box for external drops (drag-cloud). */
let chipsBox: HTMLElement | null = null;

// UI refs (set while the panel is mounted)
let panel: HTMLElement | null = null;
let keywordsInput: HTMLInputElement | null = null;
let includeSubtreeCheck: HTMLInputElement | null = null;
let dateFromInput: HTMLInputElement | null = null;
let dateToInput: HTMLInputElement | null = null;
let orderSelect: HTMLSelectElement | null = null;
let savedSelect: HTMLSelectElement | null = null;
let filterNameInput: HTMLInputElement | null = null;
let typesButton: HTMLButtonElement | null = null;
let linkTypesButton: HTMLButtonElement | null = null;
let linkScopeButton: HTMLButtonElement | null = null;

/** Actions the panel delegates to the host module. */
interface PanelActions {
  /** «Применить» pressed (or Ctrl+Enter) — run the query. */
  apply: () => void;
}

let actions: PanelActions = { apply: () => undefined };

/** Returns the current filter state. */
export function getFilterState(): ChronicleFilterState {
  return { ...filter };
}

/** Replaces the filter state and repaints the panel (L4 restore / saved filter). */
export function setFilterState(next: ChronicleFilterState): void {
  filter = { ...next };
  void syncChipsFromIds().then(() => repaintControls());
}

/** Marks which saved filter is selected (null = custom, not saved). */
export function setSavedFilterId(id: string | null): void {
  savedFilterId = id;
  if (savedSelect !== null) savedSelect.value = id ?? '';
}

/** The id of the currently selected saved filter. */
export function getSavedFilterId(): string | null {
  return savedFilterId;
}

/** Adds a thought to the «мысли» field (external drop / picker). */
export function addThoughtToFilter(id: string): void {
  if (!filter.thoughtIds.includes(id)) {
    filter = { ...filter, thoughtIds: [...filter.thoughtIds, id] };
    void syncChipsFromIds().then(() => repaintControls());
  }
}

/** Removes a thought from the «мысли» field. */
function removeThoughtFromFilter(id: string): void {
  filter = { ...filter, thoughtIds: filter.thoughtIds.filter((x) => x !== id) };
  thoughtRefs.delete(id);
  repaintControls();
}

/** Opens the universal thought picker; applies the chosen ids to the filter. */
async function pickThoughts(): Promise<void> {
  const result = await pickThoughtsDialog({
    networkId: requireNetworkId(),
    allowCreate: false,
    allowLinkType: false,
    selectedIds: filter.thoughtIds,
  });
  if (result === null) return;
  filter = { ...filter, thoughtIds: pickedThoughtIds(result) };
  await syncChipsFromIds();
  repaintControls();
}

/** Clears the «мысли» field (keeps the rest of the filter). */
function clearThoughts(): void {
  filter = { ...filter, thoughtIds: [] };
  thoughtRefs.clear();
  repaintControls();
}

/** Resolves chip metadata for the current ids (missing thoughts dropped). */
async function syncChipsFromIds(): Promise<void> {
  thoughtRefs.clear();
  const ids = filter.thoughtIds;
  if (ids.length === 0) return;
  try {
    const refs = await etn.thoughts.resolve(requireNetworkId(), ids);
    for (const ref of refs) thoughtRefs.set(ref.id, ref);
  } catch {
    // Keep whatever chips we had (offline) — the ids stay in the filter.
  }
}

/** Wraps the select of saved filters (filled by {@link reloadSavedFilters}). */
function refreshSavedSelect(): void {
  if (savedSelect === null) return;
  savedSelect.replaceChildren();
  const placeholder = el('option', undefined, 'Сохранённые отборы…');
  placeholder.value = '';
  savedSelect.append(placeholder);
  for (const saved of savedFilters) {
    const option = el('option', undefined, saved.name);
    option.value = saved.id;
    savedSelect.append(option);
  }
  savedSelect.value = savedFilterId ?? '';
}

let savedFilters: ChronicleSavedFilter[] = [];

/** Reloads the saved-filter list and repaints the selector. */
export async function reloadSavedFilters(): Promise<void> {
  try {
    savedFilters = await etn.chronicleFilters.list(requireNetworkId());
  } catch (err) {
    notice(`Не удалось загрузить отборы: ${errText(err)}`, 'error');
    savedFilters = [];
  }
  refreshSavedSelect();
}

/** Rebuilds the chip list of the «мысли» field. */
function repaintChips(): void {
  if (chipsBox === null) return;
  chipsBox.replaceChildren();
  for (const id of filter.thoughtIds) {
    const ref = thoughtRefs.get(id);
    const chip = el('span', 'chron-chip thought');
    chip.dataset['id'] = id;
    // Image icons render via <img> (applyThoughtIcon) — the raw ref.icon of an
    // image thought is a base64 data URI that must never land as chip text.
    const icon = span('', 'chip-icon');
    applyThoughtIcon(icon, ref ?? { icon: null, icon_kind: 'emoji', type_id: null });
    chip.append(icon, span(ref?.title ?? id, 'chip-title'), span('×', 'chip-x'));
    // Ctrl+hover on a filter chip previews the thought's permanent comment
    // (preview stage 3 — same as the table's thought chips).
    markThoughtCommentPreview(chip, id, ref?.title ?? id);
    chip.addEventListener('click', (e) => {
      if ((e.target as HTMLElement | null)?.classList.contains('chip-x')) {
        removeThoughtFromFilter(id);
      }
    });
    chipsBox!.append(chip);
  }
}

/** Syncs every control with the current filter state. */
function repaintControls(): void {
  if (keywordsInput !== null) keywordsInput.value = filter.keywords;
  if (includeSubtreeCheck !== null) includeSubtreeCheck.checked = filter.includeSubtree;
  if (dateFromInput !== null) dateFromInput.value = filter.dateFrom;
  if (dateToInput !== null) dateToInput.value = filter.dateTo;
  if (orderSelect !== null) orderSelect.value = filter.order;
  repaintChips();
  refreshTypeButtons();
  refreshSavedSelect();
}

/** Label of the thought-types button («Типы мыслей: все / N»). */
function refreshTypeButtons(): void {
  if (typesButton === null || linkTypesButton === null || linkScopeButton === null) return;
  const typeNames = filter.typeIds
    .map((id) => store.state.thoughtTypes.find((t) => t.id === id)?.name)
    .filter((n): n is string => n !== undefined);
  typesButton.textContent =
    typeNames.length === 0 ? 'Типы мыслей: все' : `Типы мыслей: ${typeNames.join(', ')}`;
  const linkTypeNames = filter.linkTypeIds
    .map((id) => store.state.linkTypes.find((t) => t.id === id)?.name_forward)
    .filter((n): n is string => n !== undefined);
  linkTypesButton.textContent =
    linkTypeNames.length === 0 ? 'Типы связей: все' : `Типы связей: ${linkTypeNames.join(', ')}`;
  linkScopeButton.textContent = LINK_SCOPE_LABELS[filter.linkScope];
}

/**
 * Checkbox-list dialog of thought/link types — several types are ticked in
 * one pass (instead of toggling single choices from a menu). «OK» commits
 * the ticks to the filter; «Очистить» untick everything.
 */
function showTypesDialog(kind: 'thought' | 'link'): void {
  const list = div('type-filter-box');
  list.style.maxHeight = '260px';
  const selected = new Set(kind === 'thought' ? filter.typeIds : filter.linkTypeIds);
  const thoughtTypes = store.state.thoughtTypes;
  const linkTypes = store.state.linkTypes;

  const render = (): void => {
    list.replaceChildren();
    const renderRow = (id: string, label: string, swatchColor: string | null, depth: number): void => {
      const lab = el('label', 'checkbox-row');
      lab.style.marginLeft = `${Math.max(0, depth - 1) * 14}px`;
      const check = el('input');
      check.type = 'checkbox';
      check.checked = selected.has(id);
      check.addEventListener('change', () => {
        if (check.checked) selected.add(id);
        else selected.delete(id);
      });
      if (swatchColor !== null) {
        const swatch = span('', 'link-type-swatch');
        swatch.style.borderTopColor = swatchColor;
        lab.append(check, swatch);
      } else {
        lab.append(check);
      }
      lab.append(span(label));
      list.append(lab);
    };
    if (kind === 'thought') {
      if (thoughtTypes.length === 0) {
        list.append(el('p', 'muted', 'В сети ещё нет типов мыслей.'));
        return;
      }
      // L21: the type tree with indents; the root is not selectable.
      for (const row of orderedTypeRows(thoughtTypes)) {
        if (row.type.is_root) continue;
        renderRow(row.type.id, row.type.name, null, row.depth - 1);
      }
    } else {
      if (linkTypes.length === 0) {
        list.append(el('p', 'muted', 'В сети ещё нет типов связей.'));
        return;
      }
      for (const row of orderedTypeRows(linkTypes)) {
        if (row.type.is_root) continue;
        renderRow(row.type.id, row.type.name_forward, row.type.color, row.depth - 1);
      }
    }
  };
  render();

  showDialog({
    title: kind === 'thought' ? 'Типы мыслей' : 'Типы связей',
    body: list,
    width: 400,
    buttons: [
      {
        label: 'Очистить',
        keepOpen: true,
        onClick: () => {
          selected.clear();
          render();
        },
      },
      { label: 'Отмена' },
      {
        label: 'OK',
        primary: true,
        onClick: () => {
          filter = {
            ...filter,
            ...(kind === 'thought' ? { typeIds: [...selected] } : { linkTypeIds: [...selected] }),
          };
          repaintControls();
        },
      },
    ],
  });
}

/** Menu of the link-scope selector. */
function showScopeMenu(anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const items: MenuItem[] = (Object.keys(LINK_SCOPE_LABELS) as Array<ChronicleFilterState['linkScope']>).map(
    (scope) => ({
      label: LINK_SCOPE_LABELS[scope],
      checked: filter.linkScope === scope,
      onClick: () => {
        filter = { ...filter, linkScope: scope };
        repaintControls();
      },
    }),
  );
  showMenuAt(rect.left, rect.bottom + 4, items);
}

/** Applies a saved filter: fills the controls and delegates the query. */
async function applySavedFilter(id: string): Promise<void> {
  const saved = savedFilters.find((f) => f.id === id);
  if (saved === undefined) return;
  setFilterState(fromDefinition(saved.definition));
  setSavedFilterId(id);
  actions.apply();
}

/** Saves the current criteria under the typed name (overwrites by name). */
async function saveFilter(): Promise<void> {
  if (filterNameInput === null) return;
  const name = filterNameInput.value.trim();
  if (name === '') {
    notice('Введите имя отбора.', 'info');
    return;
  }
  const networkId = requireNetworkId();
  const definition = toDefinition(filter);
  try {
    const existing = savedFilters.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (existing !== undefined) {
      await etn.chronicleFilters.update(networkId, existing.id, { definition });
      setSavedFilterId(existing.id);
    } else {
      const created = await etn.chronicleFilters.create(networkId, { name, definition });
      setSavedFilterId(created.id);
    }
    filterNameInput.value = '';
    await reloadSavedFilters();
    notice('Отбор сохранён.');
  } catch (err) {
    notice(`Не удалось сохранить отбор: ${errText(err)}`, 'error');
  }
}

/** Deletes the selected saved filter. */
async function removeSavedFilter(): Promise<void> {
  if (savedFilterId === null) return;
  const networkId = requireNetworkId();
  try {
    await etn.chronicleFilters.remove(networkId, savedFilterId);
    setSavedFilterId(null);
    await reloadSavedFilters();
    notice('Отбор удалён.');
  } catch (err) {
    notice(`Не удалось удалить отбор: ${errText(err)}`, 'error');
  }
}

/** Clears every filter field (keeps the panel, does not apply). */
export function clearFilter(): void {
  setFilterState({ ...DEFAULT_FILTER });
  setSavedFilterId(null);
}

/** Builds and mounts the filter panel into `host`; returns the root element. */
export function mountChronicleFilterPanel(host: HTMLElement, panelActions: PanelActions): HTMLElement {
  actions = panelActions;
  host.replaceChildren();
  panel = div('chron-filter');

  // Row 1: saved filters + period + keywords ---------------------------------
  const row1 = div('chron-filter-row');
  savedSelect = el('select', 'select-input chron-saved-select');
  savedSelect.append(el('option', undefined, 'Сохранённые отборы…'));
  savedSelect.addEventListener('change', () => {
    const value = savedSelect!.value;
    if (value !== '') void applySavedFilter(value);
  });
  dateFromInput = el('input', 'text-input chron-date');
  dateFromInput.type = 'date';
  dateFromInput.addEventListener('change', () => {
    filter = { ...filter, dateFrom: dateFromInput!.value };
  });
  dateToInput = el('input', 'text-input chron-date');
  dateToInput.type = 'date';
  dateToInput.addEventListener('change', () => {
    filter = { ...filter, dateTo: dateToInput!.value };
  });
  keywordsInput = el('input', 'text-input chron-keywords');
  keywordsInput.type = 'text';
  keywordsInput.placeholder = 'Строка поиска: счет* -вод*';
  setTooltip(
    keywordsInput,
    'Слова через пробел, все обязательны; * — любые символы; -слово — исключение. Ищется в названиях, синонимах и комментариях мыслей и связей.',
  );
  keywordsInput.addEventListener('input', () => {
    filter = { ...filter, keywords: keywordsInput!.value };
  });
  row1.append(
    span('Сохранённые отборы:', 'chron-label'),
    savedSelect,
    span('Период с', 'chron-label'),
    dateFromInput,
    span('по', 'chron-label'),
    dateToInput,
    keywordsInput,
  );

  // Row 2: thoughts (chips + picker dialog + clear) + subtree ---------------
  const row2 = div('chron-filter-row');
  const thoughtsLabel = span('Мысли:', 'chron-label');
  chipsBox = div('chron-chips');
  const pickButton = button('Выбрать…', () => void pickThoughts(), 'btn small');
  pickButton.type = 'button';
  pickButton.title = 'Диалог выбора нескольких мыслей (Enter — добавить, Ctrl+Enter — применить)';
  const clearThoughtsButton = button(
    'Очистить',
    () => clearThoughts(),
    'btn small',
    'Убрать все мысли из отбора',
  );
  clearThoughtsButton.type = 'button';
  const subtreeLabel = el('label', 'checkbox-row');
  includeSubtreeCheck = el('input');
  includeSubtreeCheck.type = 'checkbox';
  includeSubtreeCheck.addEventListener('change', () => {
    filter = { ...filter, includeSubtree: includeSubtreeCheck!.checked };
  });
  subtreeLabel.append(includeSubtreeCheck, span('+подчинённые мысли'));
  row2.append(thoughtsLabel, chipsBox, pickButton, clearThoughtsButton, subtreeLabel);

  // Row 3: thought types + link types (full width) + link scope --------------
  const row3 = div('chron-filter-row');
  typesButton = button('Типы мыслей: все', () => showTypesDialog('thought'), 'btn small chron-type-btn');
  typesButton.type = 'button';
  linkTypesButton = button('Типы связей: все', () => showTypesDialog('link'), 'btn small chron-type-btn');
  linkTypesButton.type = 'button';
  linkScopeButton = button(LINK_SCOPE_LABELS['both'], () => showScopeMenu(linkScopeButton!), 'btn small');
  linkScopeButton.type = 'button';
  row3.append(typesButton, linkTypesButton, linkScopeButton);

  // Row 3.5: автор/редактор хроно-комментария (задача 59119797, эволюция
  // операторов). Две строки: «подпись / оператор / значение». Для `in` /
  // `not_in` используется мульти-чип, для `eq`/`ne` — одиночный `<select>`.
  const row35 = div('chron-filter-row chron-filter-author');
  row35.append(
    buildChronicleAuthorRow({
      label: 'Автор:',
      op: filter.authorOp,
      singleId: filter.authorId,
      listIds: filter.authorIds,
      onOpChange: (op) => {
        filter = {
          ...filter,
          authorOp: op,
          ...(op !== 'eq' && op !== 'ne' ? { authorId: '' } : {}),
          ...(op !== 'in' && op !== 'not_in' ? { authorIds: [] } : {}),
        };
      },
      onSingleChange: (id) => {
        filter = { ...filter, authorId: id };
      },
      onListChange: (ids) => {
        filter = { ...filter, authorIds: ids };
      },
    }),
    buildChronicleAuthorRow({
      label: 'Редактор:',
      op: filter.editorOp,
      singleId: filter.editorId,
      listIds: filter.editorIds,
      onOpChange: (op) => {
        filter = {
          ...filter,
          editorOp: op,
          ...(op !== 'eq' && op !== 'ne' ? { editorId: '' } : {}),
          ...(op !== 'in' && op !== 'not_in' ? { editorIds: [] } : {}),
        };
      },
      onSingleChange: (id) => {
        filter = { ...filter, editorId: id };
      },
      onListChange: (ids) => {
        filter = { ...filter, editorIds: ids };
      },
    }),
  );

  // Row 4: order + actions -----------------------------------------------------
  const row4 = div('chron-filter-row');
  orderSelect = el('select', 'select-input');
  const ascOption = el('option', undefined, 'по возрастанию');
  ascOption.value = 'asc';
  const descOption = el('option', undefined, 'по убыванию');
  descOption.value = 'desc';
  orderSelect.append(ascOption, descOption);
  orderSelect.addEventListener('change', () => {
    filter = { ...filter, order: orderSelect!.value === 'desc' ? 'desc' : 'asc' };
  });
  const applyButton = button('Применить', () => actions.apply(), 'btn primary');
  applyButton.type = 'button';
  applyButton.title = 'Ctrl+Enter';
  const clearButton = button('Очистить отбор', () => clearFilter(), 'btn');
  clearButton.type = 'button';
  filterNameInput = el('input', 'text-input chron-name-input');
  filterNameInput.type = 'text';
  filterNameInput.placeholder = 'Имя отбора';
  filterNameInput.maxLength = 200;
  const saveButton = button('Сохранить отбор', () => void saveFilter(), 'btn');
  saveButton.type = 'button';
  const removeButton = button('Удалить отбор', () => void removeSavedFilter(), 'btn danger');
  removeButton.type = 'button';
  row4.append(
    span('Сортировка:', 'chron-label'),
    orderSelect,
    applyButton,
    clearButton,
    filterNameInput,
    saveButton,
    removeButton,
  );

  panel.append(row1, row2, row3, row35, row4);
  host.append(panel);
  repaintControls();
  void reloadSavedFilters();
  return panel;
}

/** Global Ctrl+Enter shortcut for the chronicle view (hosted by the table). */
export function wireChronicleApplyShortcut(container: HTMLElement): void {
  container.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      actions.apply();
    }
  });
}
