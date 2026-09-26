/**
 * Панель отбора вида «Дневник» (L20, 0.10.1, элемент интерфейса 9b424548).
 *
 * Состав панели — набор «Структур» (требование 306f74cc): календарь месяца
 * (первый элемент, его строит хозяин экрана и передаёт header'ом), период
 * «с»–«по» с пресетами токенов, ключевые слова с областью поиска, типы мыслей,
 * типы связей, родительские мысли, свойства, дополнительно (актуальность +
 * корзина), направление сортировки, футер «Применить/Очистить» + сохранённые
 * отборы.
 *
 * Критерии ЗАПИСИ (ключевые слова/область, период, авторство) живут на верхнем
 * уровне модели; критерии ЦЕЛЕЙ — во вложенной `targets` (тот же конструктор
 * `lib/filter-builder.ts`, что у «Структур»; второй конструктор не рисуется).
 * Двухпутевой поиск T7 (тела/заголовки записей + мыслевый путь) сохраняется в
 * критерии «ключевые слова».
 *
 * Каркас формы — общий `lib/filter-form.ts`; контрол периода — общий
 * `lib/period-editor.ts` (панельный вариант: поля «с»/«по» + пресеты, без
 * переключателя режимов); сохранённые отборы — `lib/saved-filter-bar.ts`.
 */

import {
  type ChronicleFilterDefinition,
  type ChronicleRow,
  type NetworkProperty,
} from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../../canvas/add-dialog.js';
import { loadRecentValues, recordRecentValue } from '../../editor/recent-values.js';
import { div, fmtDate } from '../../lib/dom.js';
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
  buildConditionsSection,
  buildEntityChipSection,
  buildFilterBlock,
  buildFilterFooterButtons,
  buildFilterForm,
  buildKeywordsSection,
  buildSortSection,
  buildTrashedRow,
  buildTriRow,
  extrasActive,
  type EntityChipSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import {
  buildChronicleWire,
  parseChronicleCriteria,
  defaultChronicleCriteriaState,
  withReverseLinkPropertySides,
  type ChronicleCriteriaState,
} from '../../lib/filter-builder.js';
import { buildPeriodEditor, type PeriodValue } from '../../lib/period-editor.js';
import type { SuggestEntry, SuggestSource } from '../../lib/suggest-dropdown.js';
import {
  buildSavedFilterBar,
  type SavedFilterBarHandle,
  type SavedFilterEntry,
  type SavedFilterStore,
} from '../../lib/saved-filter-bar.js';
import type { ThoughtCloudInput } from '../../lib/thought-cloud.js';
import { store } from '../../state.js';
import { SEARCH_DEBOUNCE_MS, periodTokensForRange, resolveDateToken } from './diary.js';

export type { ChronicleCriteriaState as ChronicleFilterState } from '../../lib/filter-builder.js';

/** Ключ истории ввода строки поиска «Дневника» (общий механизм recent-values). */
const KEYWORDS_HISTORY_KEY = 'diary.keywords';

/** Модель отбора — общая модель конструктора. */
type FilterState = ChronicleCriteriaState;

let filter: FilterState = defaultChronicleCriteriaState();
/** Ref of the selected saved filter (null — not saved yet / custom). */
let savedFilterId: string | null = null;
/** Chip meta of the «Родительские мысли» field, resolved by id (not persisted). */
const parentClouds = new Map<string, ThoughtCloudInput>();
/** Строка сохранённых отборов (общий модуль `lib/saved-filter-bar.ts`). */
let savedBar: SavedFilterBarHandle | null = null;
/** Имя отбора в поле строки — переживает перерисовку панели. */
let filterName = '';

let panel: HTMLElement | null = null;
/** Узлы-заголовки панели (календарь) — переносятся при каждой перерисовке. */
let headerNodes: readonly HTMLElement[] = [];
/** Сворачивание группы «Период» (по умолчанию свёрнута, пока период пуст). */
let periodCollapsed = true;
/** Сворачивание группы «Свойства». */
let propertiesCollapsed = true;
/** Сворачивание группы «Дополнительно». */
let extrasCollapsed = true;
/** Реестр свойств сети (для условий целей), один REST-вызов на открытие. */
const propertyDefs = new Map<string, NetworkProperty>();

/** Actions the panel delegates to the host module. */
interface PanelActions {
  /** «Применить» pressed (or Ctrl+Enter) — run the query. */
  apply: () => void;
  /** Переход к найденной записи (строка поиска выбрала запись). */
  jumpToRecord?: (row: ChronicleRow) => void;
}

/** Дополнения сборки панели. */
interface PanelOptions {
  /** Узлы над секциями (календарь месяца — первый элемент панели). */
  header?: readonly HTMLElement[];
}

let actions: PanelActions = { apply: () => undefined };

/** Найденные записи строки поиска по id (для перехода при выборе строки). */
const recordHits = new Map<string, ChronicleRow>();
/** Таймер debounce строки поиска (0.10.1, T7). */
let searchTimer: number | null = null;

/**
 * Применяет отбор через паузу после ввода (debounce строки поиска, T7): не
 * каждое нажатие запускает запрос, но панель не требует явного «Применить»
 * для текстового критерия.
 */
function scheduleSearchApply(): void {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    actions.apply();
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * Источник «найденные записи» строки поиска (T7): живой поиск по телам и
 * заголовкам записей через критерий `keywords` «Дневника». Период и прочие
 * критерии здесь не применяются — иначе не найти запись вне текущего периода,
 * а её и открывает переход. Выбор строки — не подстановка текста, а переход.
 */
async function searchRecordOptions(query: string): Promise<SuggestEntry[]> {
  const needle = query.trim();
  if (needle === '') return [];
  try {
    const result = await etn.chronicle.query(requireNetworkId(), {
      keywords: needle,
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    const out: SuggestEntry[] = [];
    for (const row of result.rows) {
      recordHits.set(row.id, row);
      out.push({
        value: row.id,
        label: `${fmtDate(row.valid_from)} — ${row.title ?? 'Запись'}`,
        recordId: row.id,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Источник подсказок строки поиска — найденные записи. */
function recordSearchSource(): SuggestSource {
  return { when: 'typed', header: 'Найденные записи', load: (query) => searchRecordOptions(query) };
}

/** Returns the current filter state. */
export function getFilterState(): FilterState {
  return { ...filter, targets: { ...filter.targets } };
}

/** Replaces the filter state and repaints the panel (L4 restore / saved filter). */
export function setFilterState(next: FilterState): void {
  filter = { ...next, targets: { ...next.targets } };
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

/** Adds a parent thought to the goals criteria (external drop / picker). */
export function addThoughtToFilter(id: string): void {
  if (!filter.targets.parentIds.includes(id)) {
    filter.targets = { ...filter.targets, parentIds: [...filter.targets.parentIds, id] };
    void syncParentChips().then(() => renderPanel());
  }
}

/** Resolves chip metadata for the current parent ids (missing thoughts dropped). */
async function syncParentChips(): Promise<void> {
  parentClouds.clear();
  const ids = filter.targets.parentIds;
  if (ids.length === 0) return;
  try {
    const refs = await etn.thoughts.resolve(requireNetworkId(), ids);
    for (const ref of refs) parentClouds.set(ref.id, { ...ref });
  } catch {
    // Keep whatever chips we had (offline) — the ids stay in the filter.
  }
}

/** Reloads the saved-filter list and repaints it (real-time `saved-filter.*`). */
export async function reloadSavedFilters(): Promise<void> {
  await savedBar?.reload();
}

/** REST-хранилище отборов вида «Дневник» (`/saved-filters?view=chronicle`). */
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
  // Снимаем отложенное применение поиска: очистка не должна тут же перезапускать отбор.
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
  filter = defaultChronicleCriteriaState();
  savedFilterId = null;
  filterName = '';
  periodCollapsed = true;
  propertiesCollapsed = true;
  extrasCollapsed = true;
  renderPanel();
}

/**
 * Реестр свойств для конструктора условий целей: к загруженному реестру
 * добавлены обратные стороны свойств-связей — тот же хелпер, что у панели
 * «Структур» и диалога отбора типа (стандарт S4).
 */
function registryWithSides(): Map<string, NetworkProperty> {
  return withReverseLinkPropertySides(propertyDefs, store.state.linkTypes);
}

/** Один REST-запрос реестра свойств сети на открытие панели. */
async function loadPropertyDefs(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const rows = await etn.propertyRegistry.list(networkId);
    propertyDefs.clear();
    for (const row of rows) propertyDefs.set(row.id, row);
  } catch {
    // Сеть недоступна — панель работает с пустым реестром.
  }
}

/**
 * Wire-определение текущего отбора (с реестром — условия целей без него
 * потерялись бы). Единственная точка конвертации для запроса и персиста.
 */
export function chronicleDefinition(): ChronicleFilterDefinition {
  return buildChronicleWire(filter, registryWithSides());
}

/**
 * Секция «Период»: панельный вариант общего контрола `lib/period-editor.ts`
 * (элемент 2f14de06, требование 91f8d8dd, приёмка №2): переключатель
 * «Пресеты»/«Даты», границы «с»/«по» без часов и минут + выпадашка готовых
 * пресетов. Контрол лишь сообщает значение — применение делает кнопка
 * «Применить». Режим едет в сохранённый отбор (`date_mode`); токены
 * раскрываются для подсветки календаря общим клиентским вычислителем.
 */
function periodSection(ctx: FilterFormContext): FilterSection {
  const section = buildFilterBlock('Период', {
    collapsible: true,
    getCollapsed: () => periodCollapsed,
    setCollapsed: (v) => (periodCollapsed = v),
    isNonEmpty: () => filter.dateFrom !== '' || filter.dateTo !== '',
  });
  const editor = buildPeriodEditor({
    variant: 'panel',
    panelMode: filter.dateMode,
    resolveToken: (token) => resolveDateToken(token),
    tokensForRange: (from, to) => periodTokensForRange(from, to),
    value: { from: filter.dateFrom, to: filter.dateTo, mode: filter.dateMode },
    label: 'Период дневника',
    onChange: (value: PeriodValue) => {
      filter.dateFrom = value.from ?? '';
      filter.dateTo = value.to ?? '';
      if (value.mode !== undefined) filter.dateMode = value.mode;
      ctx.touch();
    },
  });
  section.body.append(editor.root);
  return section;
}

/** Секция «Типы мыслей» критериев целей (набор «Структур»). */
function targetsTypesSection(ctx: FilterFormContext): FilterSection {
  return buildEntityChipSection(ctx, {
    title: 'Типы мыслей',
    getValues: () => ctx.getState().typeIds,
    setValues: (values) => {
      ctx.getState().typeIds = values;
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
          title: 'Типы мыслей целей',
          currentIds: ctx.getState().typeIds,
        }),
    },
  });
}

/** Секция «Типы связей» критериев целей. */
function targetsLinkTypesSection(ctx: FilterFormContext): FilterSection {
  return buildEntityChipSection(ctx, {
    title: 'Типы связей',
    getValues: () => ctx.getState().linkTypeIds,
    setValues: (values) => {
      ctx.getState().linkTypeIds = values;
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
          title: 'Типы связей целей',
          currentIds: ctx.getState().linkTypeIds,
        }),
    },
  });
}

/**
 * Секция «Родительские мысли» критериев целей: отбор записей, у которых есть
 * цель, подчинённая любой из указанных мыслей.
 */
function targetsParentsSection(ctx: FilterFormContext): EntityChipSection {
  const section = buildEntityChipSection(ctx, {
    title: 'Родительские мысли',
    getValues: () => ctx.getState().parentIds,
    setValues: (values) => {
      ctx.getState().parentIds = values;
    },
    loadOptions: (query) => parentThoughtOptions(query),
    optionsHeader: 'Мысли',
    cloudOf: (id) => (id.startsWith('$') ? null : (parentClouds.get(id) ?? null)),
    placeholder: 'Название мысли…',
    addPlaceholder: '+ ещё одну мысль',
    tooltip: 'Отобрать записи, цель которых подчинена указанным мыслям',
    picker: {
      label: 'Выбрать из списка',
      open: async () => {
        const result = await pickThoughtsDialog({
          networkId: requireNetworkId(),
          allowCreate: false,
          allowLinkType: false,
          selectedIds: ctx.getState().parentIds,
          title: 'Родительские мысли',
        });
        return result === null ? null : pickedThoughtIds(result);
      },
    },
  });
  void syncParentChips().then(() => section.fieldRefresh());
  return section;
}

/**
 * Секция «Дополнительно» критериев целей: только актуальность и корзина
 * (элемент 9b424548). Флажки гаснут, когда соответствующее содержимое
 * настройками скрыто — как у панели «Структур».
 */
function targetsExtrasSection(ctx: FilterFormContext): FilterSection {
  const section = buildFilterBlock('Дополнительно', {
    collapsible: true,
    getCollapsed: () => extrasCollapsed,
    setCollapsed: (v) => (extrasCollapsed = v),
    isNonEmpty: () => extrasActive(ctx.getState()),
  });
  section.body.append(
    buildTriRow(
      ctx,
      'Только актуальные',
      () => ctx.getState().active,
      (v) => (ctx.getState().active = v),
      {
        yes: 'актуальные',
        no: 'не актуальные',
        ...(store.state.showInactive
          ? {}
          : {
              disabled: true,
              tooltip:
                'Доступно при включённой настройке «Показывать неактуальные мысли и связи» (Настройки мыслесети → Видимость)',
            }),
      },
    ),
    buildTrashedRow(ctx, 'Включая помеченные на удаление', {
      ...(store.state.showTrash
        ? {}
        : {
            disabled: true,
            tooltip:
              'Доступно при включённой настройке «Показывать содержимое корзины» (Настройки мыслесети → Видимость)',
          }),
    }),
  );
  return section;
}

/** Живой поиск мыслей для поля «Родительские мысли». */
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

/** Builds and mounts the filter panel into `host`; returns the root element. */
export function mountChronicleFilterPanel(
  host: HTMLElement,
  panelActions: PanelActions,
  opts: PanelOptions = {},
): HTMLElement {
  actions = panelActions;
  headerNodes = opts.header ?? [];
  host.replaceChildren();
  panel = div('chron-filter');
  host.append(panel);
  renderPanel();
  void reloadSavedFilters();
  // Реестр свойств нужен условиям целей — рисуем панель ещё раз, когда он есть.
  void loadPropertyDefs().then(() => renderPanel());
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
    registry: registryWithSides(),
    touch,
  };
  // Критерии целей — вложенная модель `filter.targets` (0.10.1, 306f74cc).
  const targetsCtx: FilterFormContext = {
    ...ctx,
    getState: () => filter.targets,
  };

  sections.push(
    periodSection(ctx),
    buildKeywordsSection(ctx, {
      title: 'Ключевые слова',
      placeholder: 'Поиск по записям: счет* -вод*',
      showScope: true,
      tooltip:
        'Слова через пробел, все обязательны; * — любые символы; -слово — исключение. ' +
        'Ищется в телах и заголовках записей, а также в выбранных областях их мыслей. ' +
        'Подсказка «Найденные записи» открывает запись переходом ' +
        '(период из записи, прокрутка и подсветка).',
      onInput: () => scheduleSearchApply(),
      extraSources: [recordSearchSource()],
      onPickEntry: (entry) => {
        if (entry.recordId === undefined) return false;
        const row = recordHits.get(entry.recordId);
        if (row !== undefined) actions.jumpToRecord?.(row);
        return true;
      },
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
    targetsTypesSection(targetsCtx),
    targetsLinkTypesSection(targetsCtx),
    targetsParentsSection(targetsCtx),
    buildConditionsSection(targetsCtx, {
      get: () => propertiesCollapsed,
      set: (v) => (propertiesCollapsed = v),
    }),
    targetsExtrasSection(targetsCtx),
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
    buildDefinition: () => chronicleDefinition(),
    applyEntry: (entry) => applySavedFilterEntry(entry),
    selectedId: () => savedFilterId,
    setSelectedId: (id) => {
      savedFilterId = id;
    },
  });

  buildFilterForm({
    sections,
    header: [...headerNodes],
    footer: [btnRow, savedBar.root],
    mount: panel,
  });
}

/** Global Ctrl+Enter shortcut for the diary view (hosted by the feed). */
export function wireChronicleApplyShortcut(container: HTMLElement): void {
  container.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      actions.apply();
    }
  });
}
