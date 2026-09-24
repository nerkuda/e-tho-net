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

import { type ChronicleFilterDefinition } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../../canvas/add-dialog.js';
import { loadRecentValues, recordRecentValue } from '../../editor/recent-values.js';
import { div, el, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import {
  filterEntityOptions,
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
import {
  buildSavedFilterBar,
  type SavedFilterBarHandle,
  type SavedFilterEntry,
  type SavedFilterStore,
} from '../../lib/saved-filter-bar.js';
import type { ThoughtCloudInput } from '../../lib/thought-cloud.js';
import { store } from '../../state.js';
import { checkboxRow } from '../../lib/ui/choice-row.js';

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
/** Строка сохранённых отборов (общий модуль `lib/saved-filter-bar.ts`). */
let savedBar: SavedFilterBarHandle | null = null;
/** Имя отбора в поле строки — переживает перерисовку панели. */
let filterName = '';

let panel: HTMLElement | null = null;
/** Чип-поле «Мысли» текущей отрисовки (для внешнего добавления/drop). */
let thoughtsField: EntityChipSection | null = null;
/** Сворачивание группы «Автор / Редактор» (по умолчанию раскрыта). */
let authorCollapsed = false;
/**
 * Сворачивание группы «Период» (задача 2ebe4206): «Хроника» повторяет принцип
 * эталона «Структур» — группа сворачивается; по умолчанию свёрнута, пока
 * период пуст.
 */
let periodCollapsed = true;

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
  periodCollapsed = next.dateFrom === '' && next.dateTo === '';
  renderPanel();
}

/** Marks which saved filter is selected (null = custom, not saved). */
export function setSavedFilterId(id: string | null): void {
  savedFilterId = id;
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

/** Reloads the saved-filter list and repaints it (real-time `saved-filter.*`). */
export async function reloadSavedFilters(): Promise<void> {
  await savedBar?.reload();
}

/** REST-хранилище отборов вида «Хроника» (`/saved-filters?view=chronicle`). */
function savedFilterStore(): SavedFilterStore {
  return {
    list: async () =>
      (await etn.chronicleFilters.list(requireNetworkId())).map((f) => ({
        id: f.id,
        name: f.name,
        definition: f.definition,
      })),
    create: async (name, definition) =>
      toEntry(
        await etn.chronicleFilters.create(requireNetworkId(), {
          name,
          definition: definition as ChronicleFilterDefinition,
        }),
      ),
    update: async (id, patch) =>
      toEntry(
        await etn.chronicleFilters.update(requireNetworkId(), id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.definition !== undefined
            ? { definition: patch.definition as ChronicleFilterDefinition }
            : {}),
        }),
      ),
    remove: (id) => etn.chronicleFilters.remove(requireNetworkId(), id),
  };
}

/** Запись хранилища → запись строки сохранённых отборов. */
function toEntry(filter2: {
  id: string;
  name: string;
  definition: ChronicleFilterDefinition;
}): SavedFilterEntry {
  return { id: filter2.id, name: filter2.name, definition: filter2.definition };
}

/** Applies a saved filter: fills the controls and delegates the query. */
function applySavedFilterEntry(entry: SavedFilterEntry): void {
  filter = parseChronicleCriteria(entry.definition as ChronicleFilterDefinition);
  savedFilterId = entry.id;
  filterName = entry.name;
  periodCollapsed = filter.dateFrom === '' && filter.dateTo === '';
  renderPanel();
  actions.apply();
}

/** Clears every filter field (keeps the panel, does not apply). */
export function clearFilter(): void {
  filter = defaultChronicleCriteriaState();
  savedFilterId = null;
  filterName = '';
  periodCollapsed = true;
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
  const subtreeLabel = checkboxRow({
    label: '+подчинённые мысли',
    checked: filter.includeSubtree,
    onChange: (checked) => {
      filter.includeSubtree = checked;
      ctx.touch();
    },
  }).row;
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

/** Секция «Даты»: период хроно-комментариев (сворачиваемая, как в «Структурах»). */
function periodSection(ctx: FilterFormContext): FilterSection {
  return buildDatesSection(
    ctx,
    { get: () => periodCollapsed, set: (v) => (periodCollapsed = v) },
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
      loadOptions: (query) =>
        filterEntityOptions(thoughtTypeEntityOptions(store.state.thoughtTypes), query),
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
      loadOptions: (query) =>
        filterEntityOptions(linkTypeEntityOptions(store.state.linkTypes), query),
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

  // Футер: применить/очистить + строка сохранённых отборов (общий модуль).
  const btnRow = buildFilterFooterButtons({
    onApply: () => actions.apply(),
    onClear: () => clearFilter(),
    clearLabel: 'Очистить отбор',
  });
  savedBar = buildSavedFilterBar({
    store: savedFilterStore(),
    getName: () => filterName,
    setName: (name) => {
      filterName = name;
    },
    buildDefinition: () => buildChronicleWire(filter),
    applyEntry: (entry) => applySavedFilterEntry(entry),
    selectedId: () => savedFilterId,
    setSelectedId: (id) => {
      savedFilterId = id;
    },
  });

  buildFilterForm({ sections, footer: [btnRow, savedBar.root], mount: panel });
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
