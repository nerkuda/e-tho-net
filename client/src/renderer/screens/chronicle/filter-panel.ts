/**
 * Filter panel of the «Хроника» view (L20, 08-ui-spec.md §17).
 *
 * Каркас формы (блоки с маркером, ключевые слова, чип-поля мыслей и типов,
 * автор/редактор, период, сортировка, футер) строит общий модуль
 * `lib/filter-form.ts`, критерии — единый конструктор `lib/filter-builder.ts`
 * (задача 3742dd59): своя модель (`ChronicleFilterState`), свой парсер
 * определения и свой конвертер в wire убраны — теперь их один экземпляр на
 * весь клиент.
 *
 * Состав элементов панели (что именно отбирает «Хроника»): ключевые слова,
 * мысли (+подчинённые), типы мыслей и связей, сторона связи, автор/редактор,
 * период, направление сортировки, сохранённые отборы.
 */

import { type ChronicleSavedFilter } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../../canvas/add-dialog.js';
import { loadRecentValues, recordRecentValue } from '../../editor/recent-values.js';
import { button, div, el, errText, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import {
  linkTypeEntityOptions,
  pickEntitiesModal,
  thoughtEntityOption,
  thoughtTypeEntityOptions,
  type EntityOption,
} from '../../lib/entity-picker.js';
import {
  buildAuthorshipSection,
  buildDatesSection,
  buildEntityChipSection,
  buildFilterBlock,
  buildFilterFooterButtons,
  buildFilterForm,
  buildKeywordsSection,
  buildSortSection,
  type EntityChipSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import { buildChronicleWire, parseChronicleCriteria, defaultChronicleCriteriaState, type ChronicleCriteriaState } from '../../lib/filter-builder.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import type { ThoughtCloudInput } from '../../lib/thought-cloud.js';
import { store } from '../../state.js';

export type { ChronicleCriteriaState as ChronicleFilterState } from '../../lib/filter-builder.js';

/** Ключ истории ввода строки поиска Хроники (общий механизм recent-values). */
const KEYWORDS_HISTORY_KEY = 'chronicle.keywords';

/** Подписи сторон связи (поле `link_scope`). */
const LINK_SCOPE_LABELS: Record<ChronicleCriteriaState['linkScope'], string> = {
  sources: 'только источники связей',
  targets: 'только назначения связей',
  both: 'источники и назначения связей',
};

/** Модель отбора — общая модель конструктора. */
type FilterState = ChronicleCriteriaState;

let filter: FilterState = defaultChronicleCriteriaState();
/** Ref of the selected saved filter (null — not saved yet / custom). */
let savedFilterId: string | null = null;
/** Chip meta of the «мысли» field, resolved by id (not persisted). */
const thoughtClouds = new Map<string, ThoughtCloudInput>();
let savedFilters: ChronicleSavedFilter[] = [];

let panel: HTMLElement | null = null;
/** Чип-поле «Мысли» текущей отрисовки (для внешнего добавления/drop). */
let thoughtsField: EntityChipSection | null = null;
/** Поле имени отбора в футере. */
let filterNameInput: HTMLInputElement | null = null;
/** Список сохранённых отборов в футере. */
let savedListBox: HTMLElement | null = null;
/** Сворачивание группы «Автор / Редактор» (по умолчанию раскрыта). */
let authorCollapsed = false;

/** Actions the panel delegates to the host module. */
interface PanelActions {
  /** «Применить» pressed (or Ctrl+Enter) — run the query. */
  apply: () => void;
}

let actions: PanelActions = { apply: () => undefined };

/** Returns the current filter state. */
export function getFilterState(): FilterState {
  return { ...filter };
}

/** Replaces the filter state and repaints the panel (L4 restore / saved filter). */
export function setFilterState(next: FilterState): void {
  filter = { ...next };
  renderPanel();
}

/** Marks which saved filter is selected (null = custom, not saved). */
export function setSavedFilterId(id: string | null): void {
  savedFilterId = id;
  renderSavedList();
}

/** The id of the currently selected saved filter. */
export function getSavedFilterId(): string | null {
  return savedFilterId;
}

/** Adds a thought to the «мысли» field (external drop / picker). */
export function addThoughtToFilter(id: string): void {
  if (!filter.thoughtIds.includes(id)) {
    filter = { ...filter, thoughtIds: [...filter.thoughtIds, id] };
    void syncChipsFromIds().then(() => thoughtsField?.fieldRefresh());
  }
}

/** Resolves chip metadata for the current ids (missing thoughts dropped). */
async function syncChipsFromIds(): Promise<void> {
  thoughtClouds.clear();
  const ids = filter.thoughtIds;
  if (ids.length === 0) return;
  try {
    const refs = await etn.thoughts.resolve(requireNetworkId(), ids);
    for (const ref of refs) thoughtClouds.set(ref.id, { ...ref });
  } catch {
    // Keep whatever chips we had (offline) — the ids stay in the filter.
  }
}

let savedFiltersLoaded = false;

/** Reloads the saved-filter list and repaints it. */
export async function reloadSavedFilters(): Promise<void> {
  try {
    savedFilters = await etn.chronicleFilters.list(requireNetworkId());
    savedFiltersLoaded = true;
  } catch (err) {
    notice(`Не удалось загрузить отборы: ${errText(err)}`, 'error');
    savedFilters = [];
  }
  renderSavedList();
}

/** Applies a saved filter: fills the controls and delegates the query. */
function applySavedFilter(id: string): void {
  const saved = savedFilters.find((f) => f.id === id);
  if (saved === undefined) return;
  filter = parseChronicleCriteria(saved.definition);
  savedFilterId = id;
  renderPanel();
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
  const definition = buildChronicleWire(filter);
  try {
    const existing = savedFilters.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (existing !== undefined) {
      await etn.chronicleFilters.update(networkId, existing.id, { definition });
      savedFilterId = existing.id;
    } else {
      const created = await etn.chronicleFilters.create(networkId, { name, definition });
      savedFilterId = created.id;
    }
    filterNameInput.value = '';
    await reloadSavedFilters();
    notice('Отбор сохранён.');
  } catch (err) {
    notice(`Не удалось сохранить отбор: ${errText(err)}`, 'error');
  }
}

/** Deletes the selected saved filter. */
async function removeSavedFilter(id: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    await etn.chronicleFilters.remove(networkId, id);
    if (savedFilterId === id) savedFilterId = null;
    await reloadSavedFilters();
    notice('Отбор удалён.');
  } catch (err) {
    notice(`Не удалось удалить отбор: ${errText(err)}`, 'error');
  }
}

/** Clears every filter field (keeps the panel, does not apply). */
export function clearFilter(): void {
  filter = defaultChronicleCriteriaState();
  savedFilterId = null;
  renderPanel();
}

/** Секция «Мысли»: чип-поле + флаг «+подчинённые». */
function buildThoughtsSection(ctx: FilterFormContext): EntityChipSection {
  const section = buildEntityChipSection(ctx, {
    title: 'Мысли',
    getValues: () => filter.thoughtIds,
    setValues: (values) => {
      filter.thoughtIds = values;
    },
    loadOptions: (query) => thoughtsOptions(query),
    optionsHeader: 'Мысли',
    cloudOf: (id) => (id.startsWith('$') ? null : (thoughtClouds.get(id) ?? null)),
    placeholder: 'Название мысли…',
    picker: {
      label: 'выбрать…',
      open: async () => {
        const result = await pickThoughtsDialog({
          networkId: requireNetworkId(),
          allowCreate: false,
          allowLinkType: false,
          selectedIds: filter.thoughtIds,
        });
        return result === null ? null : pickedThoughtIds(result);
      },
    },
  });
  const subtreeRow = div('st-f-tri-row');
  const subtreeLabel = el('label', 'checkbox-row') as HTMLLabelElement;
  const subtreeCheck = el('input') as HTMLInputElement;
  subtreeCheck.type = 'checkbox';
  subtreeCheck.checked = filter.includeSubtree;
  subtreeCheck.addEventListener('change', () => {
    filter.includeSubtree = subtreeCheck.checked;
    ctx.touch();
  });
  subtreeLabel.append(subtreeCheck, span('+подчинённые мысли'));
  subtreeRow.append(el('span', 'st-f-tri-label', 'Подчинённые'), subtreeLabel);
  section.body.append(subtreeRow);
  // Облачка уже выбранных мыслей — догрузка по id.
  void syncChipsFromIds().then(() => section.fieldRefresh());
  return section;
}

/** Живой поиск мыслей для поля «Мысли» (общий пикер подсказок). */
async function thoughtsOptions(query: string): Promise<EntityOption[]> {
  const needle = query.trim();
  if (needle === '') return [];
  try {
    const hits = await etn.thoughts.findDuplicates(requireNetworkId(), needle, [], []);
    return hits.map((hit) => {
      thoughtClouds.set(hit.id, { ...hit });
      return thoughtEntityOption(hit);
    });
  } catch {
    return [];
  }
}

/** Секция «Сторона связи» (поле `link_scope`). */
function buildLinkScopeSection(ctx: FilterFormContext): FilterSection {
  const section = buildFilterBlock('Сторона связи', {
    isNonEmpty: () => filter.linkScope !== 'both',
  });
  const select = el('select', 'st-f-input') as HTMLSelectElement;
  for (const scope of ['sources', 'targets', 'both'] as Array<ChronicleCriteriaState['linkScope']>) {
    const option = el('option', '', LINK_SCOPE_LABELS[scope]) as HTMLOptionElement;
    option.value = scope;
    select.append(option);
  }
  select.value = filter.linkScope;
  select.addEventListener('change', () => {
    filter.linkScope = select.value as ChronicleCriteriaState['linkScope'];
    ctx.touch();
  });
  section.body.append(select);
  return section;
}

/** Секция «Даты»: период хроно-комментариев. */
function periodSection(ctx: FilterFormContext): FilterSection {
  return buildDatesSection(
    ctx,
    { get: () => false, set: () => undefined },
    {
      title: 'Период',
      ranges: [
        {
          label: 'Период',
          getFrom: () => filter.dateFrom,
          getTo: () => filter.dateTo,
          setFrom: (v) => {
            filter.dateFrom = v;
          },
          setTo: (v) => {
            filter.dateTo = v;
          },
        },
      ],
      isNonEmpty: () => filter.dateFrom !== '' || filter.dateTo !== '',
    },
  );
}

/** Список сохранённых отборов (клик — применить, правый клик — сменить). */
function renderSavedList(): void {
  if (savedListBox === null) return;
  savedListBox.replaceChildren();
  if (!savedFiltersLoaded) return;
  if (savedFilters.length === 0) {
    savedListBox.append(el('div', 'st-f-empty', 'Нет сохранённых отборов'));
    return;
  }
  for (const saved of savedFilters) {
    const item = el('button', 'st-f-saved');
    item.type = 'button';
    if (saved.id === savedFilterId) item.classList.add('active');
    item.textContent = saved.name;
    item.addEventListener('click', () => applySavedFilter(saved.id));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const items: MenuItem[] = [
        { label: 'Применить', onClick: () => applySavedFilter(saved.id) },
        { label: 'Удалить', danger: true, onClick: () => void removeSavedFilter(saved.id) },
      ];
      showMenuAt(event.clientX, event.clientY, items);
    });
    savedListBox.append(item);
  }
}

/** Builds and mounts the filter panel into `host`; returns the root element. */
export function mountChronicleFilterPanel(host: HTMLElement, panelActions: PanelActions): HTMLElement {
  actions = panelActions;
  host.replaceChildren();
  panel = div('chron-filter');
  host.append(panel);
  renderPanel();
  void reloadSavedFilters();
  return panel;
}

/** Перерисовывает панель из текущего состояния (общий каркас). */
function renderPanel(): void {
  if (panel === null) return;
  panel.replaceChildren();

  const sections: FilterSection[] = [];
  const touch = (): void => {
    for (const section of sections) section.refresh();
  };
  const ctx: FilterFormContext = {
    networkId: requireNetworkId(),
    getState: () => filter,
    registry: new Map(),
    touch,
  };

  thoughtsField = buildThoughtsSection(ctx);
  sections.push(
    buildKeywordsSection(ctx, {
      placeholder: 'Строка поиска: счет* -вод*',
      tooltip:
        'Слова через пробел, все обязательны; * — любые символы; -слово — исключение. Ищется в названиях, синонимах и комментариях мыслей и связей.',
      suggestSource: {
        when: 'always',
        load: () =>
          loadRecentValues(requireNetworkId(), KEYWORDS_HISTORY_KEY).map((value) => ({
            value,
            label: value,
          })),
      },
      onBlur: (value) => {
        const trimmed = value.trim();
        if (trimmed === '') return;
        try {
          recordRecentValue(requireNetworkId(), KEYWORDS_HISTORY_KEY, trimmed);
        } catch {
          // нет сети — история не критична
        }
      },
    }),
    thoughtsField,
    buildEntityChipSection(ctx, {
      title: 'Типы мыслей',
      getValues: () => filter.typeIds,
      setValues: (values) => {
        filter.typeIds = values;
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
            currentIds: filter.typeIds,
          }),
      },
    }),
    buildEntityChipSection(ctx, {
      title: 'Типы связей',
      getValues: () => filter.linkTypeIds,
      setValues: (values) => {
        filter.linkTypeIds = values;
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
            currentIds: filter.linkTypeIds,
          }),
      },
    }),
    buildLinkScopeSection(ctx),
    buildAuthorshipSection(ctx, { get: () => authorCollapsed, set: (v) => (authorCollapsed = v) }),
    periodSection(ctx),
    buildSortSection(ctx, { showSort: false }),
  );

  // Футер: применить/очистить + сохранённые отборы.
  const btnRow = buildFilterFooterButtons({
    onApply: () => actions.apply(),
    onClear: () => clearFilter(),
    clearLabel: 'Очистить отбор',
  });
  const saveRow = div('st-f-saverow');
  filterNameInput = el('input', 'st-f-input') as HTMLInputElement;
  filterNameInput.type = 'text';
  filterNameInput.placeholder = 'Имя отбора';
  filterNameInput.maxLength = 200;
  const saveButton = button('Сохранить отбор', () => void saveFilter(), 'st-f-save');
  saveButton.type = 'button';
  const removeButton = button('Удалить отбор', () => {
    if (savedFilterId !== null) void removeSavedFilter(savedFilterId);
  }, 'st-f-save');
  removeButton.type = 'button';
  saveRow.append(filterNameInput, saveButton, removeButton);
  savedListBox = div('st-f-savedlist');

  buildFilterForm({ sections, footer: [btnRow, saveRow, savedListBox], mount: panel });
  renderSavedList();
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
