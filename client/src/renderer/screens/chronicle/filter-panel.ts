/**
 * Filter panel of the «Хроника» view (L20, 08-ui-spec.md §17).
 *
 * Four rows per the spec:
 *   1. saved filter selector (choice = fill + apply) + the keywords search box
 *      (`*` wildcard, `-` exclusion, searched in titles/synonyms/comments);
 *   2. «мысли» field (chips, live picker) + «+подчинённые» + thought types;
 *   3. period «с»/«по» + link types + link scope (sources/targets/both);
 *   4. sort order + «Применить» (Ctrl+Enter) + «Очистить отбор» + filter name
 *      + «Сохранить отбор» (overwrites by name) + «Удалить отбор».
 *
 * The panel holds the filter state; the host module reads it via
 * {@link getFilterState} and writes it via {@link setFilterState} (L4 restore
 * and saved-filter apply).
 */

import type { ChronicleSavedFilter, ThoughtRef } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { button, div, el, span, setTooltip } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, MENU_SEPARATOR, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { errText } from '../../lib/dom.js';
import { store } from '../../state.js';
import { wireThoughtRefSearch } from '../../editor/thought-picker.js';
import { DEFAULT_FILTER, fromDefinition, toDefinition } from './state.js';
import type { ChronicleFilterState } from './state.js';

export type { ChronicleFilterState } from './state.js';

const LINK_SCOPE_LABELS: Record<ChronicleFilterState['linkScope'], string> = {
  sources: 'только источники связей',
  targets: 'только назначения связей',
  both: 'источники и назначения связей',
};

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
let thoughtPickerInput: HTMLInputElement | null = null;
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
  /** «Применить» pressed (or Ctrl+Enter) — run the query and clear history. */
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
    const icon = span(ref?.icon ?? '💭', 'chip-icon');
    chip.append(icon, span(ref?.title ?? id, 'chip-title'), span('×', 'chip-x'));
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

/** Checkbox menu of thought/link types (lib/menu supports `checked`). */
function showTypesMenu(anchor: HTMLElement, kind: 'thought' | 'link'): void {
  const rect = anchor.getBoundingClientRect();
  const items: MenuItem[] =
    kind === 'thought'
      ? store.state.thoughtTypes.map((t) => ({
          label: t.name,
          checked: filter.typeIds.includes(t.id),
          onClick: () => {
            filter = {
              ...filter,
              typeIds: filter.typeIds.includes(t.id)
                ? filter.typeIds.filter((x) => x !== t.id)
                : [...filter.typeIds, t.id],
            };
            repaintControls();
          },
        }))
      : store.state.linkTypes.map((t) => ({
          label: t.name_forward,
          checked: filter.linkTypeIds.includes(t.id),
          onClick: () => {
            filter = {
              ...filter,
              linkTypeIds: filter.linkTypeIds.includes(t.id)
                ? filter.linkTypeIds.filter((x) => x !== t.id)
                : [...filter.linkTypeIds, t.id],
            };
            repaintControls();
          },
        }));
  const menuItems: MenuItem[] =
    items.length === 0
      ? [{ label: 'Типов нет', disabled: true }]
      : [
          {
            label: 'Очистить',
            onClick: () => {
              filter = {
                ...filter,
                ...(kind === 'thought' ? { typeIds: [] } : { linkTypeIds: [] }),
              };
              repaintControls();
            },
          },
          MENU_SEPARATOR,
          ...items,
        ];
  showMenuAt(rect.left, rect.bottom + 4, menuItems);
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

  // Row 1: saved filters + keywords -------------------------------------------
  const row1 = div('chron-filter-row');
  savedSelect = el('select', 'select-input chron-saved-select');
  savedSelect.append(el('option', undefined, 'Сохранённые отборы…'));
  savedSelect.addEventListener('change', () => {
    const value = savedSelect!.value;
    if (value !== '') void applySavedFilter(value);
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
  row1.append(span('Сохранённые отборы:', 'chron-label'), savedSelect, keywordsInput);

  // Row 2: thoughts + subtree + types ----------------------------------------
  const row2 = div('chron-filter-row');
  const thoughtsLabel = span('Мысли:', 'chron-label');
  chipsBox = div('chron-chips');
  thoughtPickerInput = el('input', 'text-input chron-thought-picker');
  thoughtPickerInput.type = 'text';
  thoughtPickerInput.placeholder = 'Добавить мысль…';
  wireThoughtRefSearch(thoughtPickerInput, {
    networkId: requireNetworkId(),
    onPick: (id) => {
      addThoughtToFilter(id);
      thoughtPickerInput!.value = '';
    },
  });
  const subtreeLabel = el('label', 'checkbox-row');
  includeSubtreeCheck = el('input');
  includeSubtreeCheck.type = 'checkbox';
  includeSubtreeCheck.addEventListener('change', () => {
    filter = { ...filter, includeSubtree: includeSubtreeCheck!.checked };
  });
  subtreeLabel.append(includeSubtreeCheck, span('+подчинённые мысли'));
  typesButton = button('Типы мыслей: все', () => showTypesMenu(typesButton!, 'thought'), 'btn small chron-type-btn');
  typesButton.type = 'button';
  row2.append(thoughtsLabel, chipsBox, thoughtPickerInput, subtreeLabel, typesButton);

  // Row 3: period + link types + link scope ----------------------------------
  const row3 = div('chron-filter-row');
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
  linkTypesButton = button('Типы связей: все', () => showTypesMenu(linkTypesButton!, 'link'), 'btn small chron-type-btn');
  linkTypesButton.type = 'button';
  linkScopeButton = button(LINK_SCOPE_LABELS['both'], () => showScopeMenu(linkScopeButton!), 'btn small chron-type-btn');
  linkScopeButton.type = 'button';
  row3.append(
    span('Период с', 'chron-label'),
    dateFromInput,
    span('по', 'chron-label'),
    dateToInput,
    linkTypesButton,
    linkScopeButton,
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

  panel.append(row1, row2, row3, row4);
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
