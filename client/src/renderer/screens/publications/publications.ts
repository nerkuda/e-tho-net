/**
 * Экран «Публикации» — библиотека (0.11.1, задача a3cfc018; элемент интерфейса
 * 1eecd988, требование 1b39206e).
 *
 * Два вида одной библиотеки: «полки» (горизонтальные ряды карточек) и «список»
 * (плоский список, полки — сворачиваемые группы). Общая панель: поиск,
 * сортировка, фильтры (актуальность, полка), создание публикации и полки,
 * пагинация. Персональные настройки вида хранятся в L4 `ui_state`
 * (`PUBLICATIONS_STATE`, «пользователь × сеть»).
 *
 * Разметка — из фасадов `lib/ui` (кнопки, поля, сегменты, чипы, состояния,
 * меню) и `lib/dialog.ts`; списки обновляются инкрементально (`reconcileKeyed`,
 * стандарт «Списки рендерятся инкрементально»). Realtime-обновление — по
 * `publication.*`/`shelf.*` (см. `realtime-ui.ts`).
 */

import type {
  Publication,
  PublicationActiveFilter,
  PublicationDeletionBlocking,
  PublicationSort,
  Shelf,
} from '@etn/shared';
import { BASE_LAYER_ID, UI_STATE_KEY } from '@etn/shared';

import {
  div,
  span,
  setTooltip,
} from '../../lib/dom.js';
import { t, type MessageKey } from '../../lib/i18n.js';
import { etn } from '../../lib/etn.js';
import { svgIcon } from '../../lib/icons.js';
import { errorDialog, promptDialog } from '../../lib/dialog.js';
import { openEntityDeleteDialog } from '../../lib/delete-dialog.js';
import {
  MENU_SEPARATOR,
  menuAction,
  menuChoice,
  menuSubmenu,
  showMenuAt,
  type MenuItem,
} from '../../lib/menu.js';
import { uiButton, iconButton } from '../../lib/ui/button.js';
import { fieldInput } from '../../lib/ui/field.js';
import { segmentedControl } from '../../lib/ui/segmented.js';
import { badge, setBadgeText } from '../../lib/ui/badge.js';
import { emptyState, errorState, loadingState } from '../../lib/ui/empty-state.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { store } from '../../state.js';
import * as users from '../../lib/users.js';
import {
  commitEntity,
  onQueryInvalidated,
  queryKeys,
  registerQuery,
} from '../../lib/live/index.js';
import { buildCover } from './cover.js';
import {
  assemblyDateLabel,
  clampTextWidth,
  defaultPublicationsViewState,
  displayAuthorship,
  groupByShelves,
  isShelfCollapsed,
  nextShelfTitle,
  parsePublicationsViewState,
  publicationMenuCommands,
  publicationsEmptyKind,
  serializePublicationsViewState,
  shelfMenuCommands,
  type PublicationsViewState,
} from './model.js';
import {
  attachLibraryNav,
  LIB_GROUP_CLASS,
  LIB_GROUP_COLLAPSED_CLASS,
  LIB_HEAD_CLASS,
  LIB_PUB_ATTR,
  LIB_SHELF_ATTR,
  type LibraryNavHandle,
} from './library-nav.js';
import { openPublicationWizard } from './wizard.js';
import {
  mountPublicationWorkspace,
  type PublicationOpenTarget,
  type PublicationWorkspaceHandle,
} from './workspace.js';

/** Размер страницы списка публикаций. */
const PAGE_SIZE = 24;

/** Ограничение числа публикаций, для которых лениво грузится бейдж «+N». */
const BADGE_LIMIT = 60;

/** Ключ настройки панели фильтров в словаре (совпадает по смыслу). */
const SORT_LABEL_KEY = {
  manual: 'publications.sort.manual',
  title: 'publications.sort.title',
  date: 'publications.sort.date',
  author: 'publications.sort.author',
} as const satisfies Record<PublicationSort, MessageKey>;

const ACTIVE_LABEL_KEY = {
  true: 'publications.active.true',
  false: 'publications.active.false',
  any: 'publications.active.any',
} as const satisfies Record<PublicationActiveFilter, MessageKey>;

// ---------------------------------------------------------------------------
// Состояние модуля
// ---------------------------------------------------------------------------

let viewState: PublicationsViewState = defaultPublicationsViewState();
let stateLoaded = false;
let publications: Publication[] = [];
let shelves: Shelf[] = [];
let total = 0;
let offset = 0;
let loading = false;
let loadError: unknown = null;
let initializedNetworkId: string | null = null;
let initPromise: Promise<void> | null = null;
let reloadTimer: number | null = null;
let searchTimer: number | null = null;
let unsubStore: (() => void) | null = null;
/**
 * Подписка экрана на инвалидации слоя данных (G4 тех.проекта 269016e2):
 * список библиотеки и полки — запросы слоя `publications-list` / `shelves`.
 * Роутер гасит их на чужие события, мутации — через `invalidateQueries`; экран
 * перечитывает снимок (reconcileKeyed обновляет только изменившиеся строки).
 */
let layerUnsub: (() => void) | null = null;
let draggingPublicationId: string | null = null;
/** Свёрнутые полки-группы (единое состояние обоих видов, задача 55ee3c85). */
const collapsedShelves = new Set<string>();
const badgeCounts = new Map<string, number>();
const badgeBadges = new Map<string, HTMLElement>();

/** Контроллер единой клавиатурной навигации обоих видов (задача 55ee3c85). */
let libraryNav: LibraryNavHandle | null = null;

interface Ui {
  root: HTMLElement;
  search: HTMLInputElement;
  viewSwitch: ReturnType<typeof segmentedControl>;
  sortButton: HTMLButtonElement;
  sortLabel: HTMLElement;
  filtersButton: HTMLButtonElement;
  filtersPanel: HTMLElement;
  activeSwitch: ReturnType<typeof segmentedControl>;
  shelfButton: HTMLButtonElement;
  shelfLabel: HTMLElement;
  shelvesHost: HTMLElement;
  listHost: HTMLElement;
  stateHost: HTMLElement;
  pagerHost: HTMLElement;
  countLabel: HTMLElement;
}

let ui: Ui | null = null;

/** Хост и дескриптор рабочей области открытой публикации (2ebacd12). */
let wsHost: HTMLElement | null = null;
let workspace: PublicationWorkspaceHandle | null = null;

/** Хост карточек внутри секции полки (для вложенной keyed-сверки). */
const cardsHosts = new WeakMap<HTMLElement, HTMLElement>();

/** Хост пустого состояния внутри секции полки (ошибка 87ad669a). */
const shelfEmptyHosts = new WeakMap<HTMLElement, HTMLElement>();

/** Идёт ли сейчас inline-переименование полки (задача 00160da1). */
let renamingShelfId: string | null = null;

// ---------------------------------------------------------------------------
// Публичный вход
// ---------------------------------------------------------------------------

/** Ленивая инициализация вида (зовётся `setActiveView('publications')`). */
export async function ensurePublicationsInitialised(): Promise<void> {
  await initForNetwork(true);
}

/** Монтирует вид в хост рабочего пространства; возвращает teardown. */
export function mountPublications(hostEl: HTMLElement): () => void {
  ui = buildUi(hostEl);
  // Корень принимает фокус: клавиатурная навигация (↑/↓/Home/End/←/→/Enter)
  // слушается на нём и обслуживает оба вида (задача 55ee3c85).
  ui.root.tabIndex = 0;
  libraryNav = attachLibraryNav(ui.root, {
    onToggleShelf: (shelfId, collapsed) => setShelfCollapsed(shelfId, collapsed),
    onEditShelf: (shelfId) => beginShelfRenameById(shelfId),
    onOpenPublication: (id) => void openPublicationCard(id),
    onReadPublication: (id) => void openPublicationWorkspace(id),
  });
  wsHost = div('publications-host pub-ws-host hidden');
  hostEl.append(wsHost);
  workspace = mountPublicationWorkspace(wsHost, {
    onClose: () => closePublicationWorkspace(),
    onOpenCard: (id) => void openPublicationCard(id),
    onExport: (id, ev) => openWorkspaceExportMenu(id, ev),
    // Ширина текста документа — персональная настройка вида (ea1b5f14, п. 5):
    // живое движение меняет состояние, завершение — сохраняет в L4.
    getTextWidth: () => viewState.textWidth,
    onTextWidthInput: (value) => {
      viewState = { ...viewState, textWidth: clampTextWidth(value) };
    },
    onTextWidthChange: (value) => {
      viewState = { ...viewState, textWidth: clampTextWidth(value) };
      persist();
    },
  });
  // Реактивность библиотеки — через слой данных (G4 тех.проекта 269016e2):
  // список и полки живут под ключами запросов, роутер/мутации их гасят, экран
  // перечитывает снимок. Локальные каналы (`lib/publication-events`) снесены.
  retargetPublicationsQuery();
  layerUnsub = onQueryInvalidated((prefix) => {
    if (prefix === queryKeys.publicationsListAll() || prefix === queryKeys.shelves()) {
      invalidatePublications();
    }
  });
  unsubStore = store.subscribe(() => {
    if (hostEl.isConnected !== true) return;
    if (store.state.activeView === 'publications') void initForNetwork(false);
  });
  return () => {
    unsubStore?.();
    unsubStore = null;
    layerUnsub?.();
    layerUnsub = null;
    if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    reloadTimer = null;
    searchTimer = null;
    libraryNav?.destroy();
    libraryNav = null;
    workspace?.destroy();
    workspace = null;
    wsHost = null;
    ui = null;
    initializedNetworkId = null;
  };
}

/** Открывает рабочую область чтения публикации (элемент интерфейса 2ebacd12). */
export async function openPublicationWorkspace(
  id: string,
  target?: PublicationOpenTarget,
): Promise<void> {
  if (ui === null || wsHost === null || workspace === null) return;
  ui.root.classList.add('hidden');
  wsHost.classList.remove('hidden');
  await workspace.open(id, target);
}

/** Возвращает экран в библиотеку (кнопка «Назад», Esc). */
export function closePublicationWorkspace(): void {
  workspace?.close();
  wsHost?.classList.add('hidden');
  ui?.root.classList.remove('hidden');
  invalidatePublications();
}

/**
 * Ключ запроса-снимка библиотеки по текущим условиям (поиск/полка/активность/
 * сортировка/страница). Реестр адресуется строками; префикс `publications-list`
 * гасит все страницы разом.
 */
function publicationsFilterKey(): string {
  return [
    viewState.query.trim(),
    viewState.shelfFilter ?? '',
    viewState.activeFilter,
    viewState.sort,
    String(offset),
  ].join('|');
}

/** Зарегистрировать ключи снимка библиотеки в реестре (инвалидации их видят). */
function retargetPublicationsQuery(): void {
  registerQuery(queryKeys.publicationsList(publicationsFilterKey()), null);
  registerQuery(queryKeys.shelves(), null);
}

/** Инвалидирует список (перечитать из сервера с дебаунсом). */
export function invalidatePublications(): void {
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null;
    void load();
  }, 150);
}

/** Открывает карточку публикации в панели редактора (ADR eb687eea). */
export async function openPublicationCard(id: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  // Панель редактирования скрыта — показать её (карточка живёт там).
  if (store.state.editorPosition === 'hidden') {
    store.update({ editorPosition: store.state.lastEditorPosition });
  }
  store.update({ editorTarget: { kind: 'publication', id } });
  try {
    const publication = await etn.publications.get(networkId, id);
    commitEntity('publication', id, publication);
    const live = store.state.editorTarget;
    if (live?.kind === 'publication' && live.id === id) {
      store.update({ editorTarget: { kind: 'publication', id, publication } });
    }
  } catch {
    // Сущность не пришла (удалена/нет доступа) — карточка покажет состояние
    // загрузки; повторное открытие перечитает.
  }
}

/**
 * «Найти на полке» из карточки публикации (задача b02ef1cf): активизирует
 * экран «Публикации», показывает библиотеку (а не рабочую область чтения) и
 * делает публикацию текущей в навигации библиотеки. Точка интеграции карточки
 * с принятым экраном библиотеки — собственных контроллеров здесь нет.
 */
export async function revealPublicationInLibrary(id: string): Promise<void> {
  // Ленивый импорт: статический замкнул бы цикл publications → active-view.
  const { setActiveView } = await import('../active-view.js');
  setActiveView('publications');
  await ensurePublicationsInitialised();
  closePublicationWorkspace();
  libraryNav?.revealPublication(id);
}

// ---------------------------------------------------------------------------
// Разметка: панель, тело, футер
// ---------------------------------------------------------------------------

function buildUi(root: HTMLElement): Ui {
  const container = div('publications');

  const toolbar = div('pub-toolbar');
  const search = fieldInput({ extraClass: 'pub-search', bare: true });
  search.type = 'search';
  search.placeholder = t('publications.search');
  setTooltip(search, t('publications.search'));

  const viewSwitch = segmentedControl({
    items: [
      { id: 'shelves', label: t('publications.view.shelves') },
      { id: 'list', label: t('publications.view.list') },
    ],
    activeId: viewState.viewMode,
    ariaLabel: t('publications.title'),
    onChange: (id) => {
      viewState = { ...viewState, viewMode: id === 'list' ? 'list' : 'shelves' };
      persist();
      renderBody();
    },
  });

  const sortButton = uiButton({
    role: 'ghost',
    onClick: (ev) => openSortMenu(ev),
  });
  setTooltip(sortButton, t('publications.sort.hint'));
  const sortLabel = span('', 'pub-btn-label');
  sortButton.append(sortLabel, svgIcon('chevron-down', 12));

  const filtersButton = iconButton({
    icon: svgIcon('filter'),
    title: t('publications.filters'),
    role: 'ghost',
    onClick: () => {
      viewState = { ...viewState, filtersOpen: !viewState.filtersOpen };
      persist();
      renderFilters();
    },
  });

  const newShelfButton = uiButton({
    label: t('publications.newShelf'),
    role: 'ghost',
    onClick: () => void createShelf(),
  });
  // Иконка `+` — единообразно с «Публикацией» (задача 55ee3c85).
  newShelfButton.prepend(svgIcon('plus', 14));
  setTooltip(newShelfButton, t('publications.newShelfHint'));
  const newButton = uiButton({
    label: t('publications.new'),
    role: 'primary',
    onClick: () =>
      openPublicationWizard({
        shelves,
        onCreated: (id) => {
          invalidatePublications();
          void openPublicationCard(id);
        },
      }),
  });
  newButton.prepend(svgIcon('plus', 14));
  setTooltip(newButton, t('publications.newHint'));

  toolbar.append(search, viewSwitch.root, sortButton, filtersButton, div('pub-spacer'), newShelfButton, newButton);

  const filtersPanel = div('pub-filters hidden');
  const activeSwitch = segmentedControl({
    items: (['true', 'false', 'any'] as const).map((id) => ({
      id,
      label: t(ACTIVE_LABEL_KEY[id]),
    })),
    activeId: viewState.activeFilter,
    ariaLabel: t('publications.filters'),
    onChange: (id) => {
      viewState = { ...viewState, activeFilter: id as PublicationActiveFilter };
      offset = 0;
      persist();
      void load();
    },
  });
  const shelfButton = uiButton({
    role: 'ghost',
    onClick: (ev) => openShelfFilterMenu(ev),
  });
  const shelfLabel = span('', 'pub-btn-label');
  shelfButton.append(shelfLabel, svgIcon('chevron-down', 12));
  filtersPanel.append(activeSwitch.root, shelfButton);

  const body = div('pub-body');
  const shelvesHost = div('pub-shelves');
  const listHost = div('pub-list hidden');
  const stateHost = div('pub-state');
  body.append(shelvesHost, listHost, stateHost);

  const pagerHost = div('pub-pager');
  const countLabel = span('', 'pub-count');

  container.append(toolbar, filtersPanel, body, pagerHost);
  root.append(container);

  search.addEventListener('input', () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = null;
      viewState = { ...viewState, query: search.value };
      offset = 0;
      persist();
      void load();
    }, 250);
  });

  return {
    root: container,
    search,
    viewSwitch,
    sortButton,
    sortLabel,
    filtersButton,
    filtersPanel,
    activeSwitch,
    shelfButton,
    shelfLabel,
    shelvesHost,
    listHost,
    stateHost,
    pagerHost,
    countLabel,
  };
}

/** Удаляет всех детей узла (без `clear`/`replaceChildren` коллекций). */
function emptyNode(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------------------
// Загрузка данных и настройки
// ---------------------------------------------------------------------------

async function initForNetwork(force: boolean): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || ui === null) return;
  if (!force && initializedNetworkId === networkId) return;
  if (initPromise !== null && initializedNetworkId === networkId) return;
  const networkChanged = initializedNetworkId !== null && initializedNetworkId !== networkId;
  if (networkChanged) {
    stateLoaded = false;
    offset = 0;
    publications = [];
    shelves = [];
    total = 0;
    badgeCounts.clear();
    badgeBadges.clear();
    collapsedShelves.clear();
  }
  initializedNetworkId = networkId;
  initPromise = (async () => {
    users.ensureLoaded();
    if (!stateLoaded) {
      stateLoaded = true;
      const raw = await etn.ui.getState(networkId, UI_STATE_KEY.PUBLICATIONS_STATE).catch(() => null);
      viewState = parsePublicationsViewState(raw);
      ui!.viewSwitch.setActive(viewState.viewMode);
      ui!.activeSwitch.setActive(viewState.activeFilter);
      ui!.search.value = viewState.query;
    }
    renderFilters();
    renderToolbarLabels();
    await load();
  })().finally(() => {
    initPromise = null;
  });
  await initPromise;
}

function persist(): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.ui
    .setState(networkId, UI_STATE_KEY.PUBLICATIONS_STATE, serializePublicationsViewState(viewState))
    .catch(() => undefined);
}

async function load(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || ui === null) return;
  // Ключ снимка следует за условиями (поиск/полка/страница) — инвалидации слоя
  // попадают ровно в активный запрос.
  retargetPublicationsQuery();
  loading = true;
  loadError = null;
  renderState();
  try {
    const [list, shelfList] = await Promise.all([
      etn.publications.list(networkId, {
        ...(viewState.query.trim() !== '' ? { q: viewState.query.trim() } : {}),
        ...(viewState.shelfFilter !== null ? { shelf: viewState.shelfFilter } : {}),
        active: viewState.activeFilter,
        sort: viewState.sort,
        limit: PAGE_SIZE,
        offset,
      }),
      etn.publications.listShelves(networkId).catch(() => []),
    ]);
    publications = list.items;
    total = list.total;
    shelves = shelfList;
    // Полные снимки — в нормализованный кэш слоя (точечные патчи роутера лягут
    // поверх полных записей, а не создадут частичные).
    for (const item of list.items) commitEntity('publication', item.id, item);
    for (const shelf of shelfList) commitEntity('shelf', shelf.id, shelf);
    loading = false;
    renderAll();
    void loadBadges();
  } catch (err) {
    loading = false;
    loadError = err;
    renderState();
  }
}

/** Ленивая догрузка бейджей «+N новых» для видимых публикаций. */
async function loadBadges(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const pending = publications
    .filter((p) => !badgeCounts.has(p.id))
    .slice(0, BADGE_LIMIT - badgeCounts.size);
  for (const publication of pending) {
    try {
      const result = await etn.publications.candidates(networkId, publication.id, { limit: 1 });
      badgeCounts.set(publication.id, result.total);
    } catch {
      badgeCounts.set(publication.id, 0);
    }
  }
  for (const publication of publications) {
    const count = badgeCounts.get(publication.id);
    const node = badgeBadges.get(publication.id);
    if (count === undefined || node === undefined) continue;
    setBadgeText(node, count > 0 ? t('publications.newBadge', count) : '');
    node.classList.toggle('hidden', count <= 0);
  }
}

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------

function renderAll(): void {
  renderToolbarLabels();
  renderBody();
}

function renderToolbarLabels(): void {
  if (ui === null) return;
  ui.sortLabel.textContent = `${t('publications.sort')}: ${t(SORT_LABEL_KEY[viewState.sort])}`;
  ui.shelfLabel.textContent =
    viewState.shelfFilter === null
      ? t('publications.shelf.all')
      : (shelves.find((s) => s.id === viewState.shelfFilter)?.title ?? t('publications.shelf.all'));
}

function renderFilters(): void {
  if (ui === null) return;
  ui.filtersPanel.classList.toggle('hidden', !viewState.filtersOpen);
  ui.activeSwitch.setActive(viewState.activeFilter);
}

function renderBody(): void {
  if (ui === null) return;
  const shelvesView = viewState.viewMode === 'shelves';
  renderState();
  renderPager();
  if (loading || loadError !== null) return;
  // Глобальное пустое состояние (пустая библиотека или пустой результат
  // поиска) заменяет тело: секции полок тогда не рендерятся. В сети без
  // публикаций с живой полкой состояние НЕ глобальное — рендерятся полки
  // (элемент интерфейса 1eecd988 v3).
  if (publicationsEmptyKind(publications.length, shelves.length, isSearching()) !== 'none') return;
  if (shelvesView) renderShelves();
  else renderList();
}

/** Активен ли поиск/фильтр полки (пустой результат — состояние запроса). */
function isSearching(): boolean {
  return viewState.query.trim() !== '' || viewState.shelfFilter !== null;
}

function renderState(): void {
  if (ui === null) return;
  emptyNode(ui.stateHost);
  const kind =
    loading || loadError !== null
      ? 'none'
      : publicationsEmptyKind(publications.length, shelves.length, isSearching());
  const occupiesBody = loading || loadError !== null || kind !== 'none';
  ui.shelvesHost.classList.toggle('hidden', viewState.viewMode !== 'shelves' || occupiesBody);
  ui.listHost.classList.toggle('hidden', viewState.viewMode !== 'list' || occupiesBody);
  if (loading) {
    ui.stateHost.append(loadingState());
    return;
  }
  if (loadError !== null) {
    ui.stateHost.append(
      errorState(t('publications.error'), {
        label: t('actions.reset'),
        onClick: () => void load(),
      }),
    );
    return;
  }
  if (kind === 'noResults') {
    ui.stateHost.append(emptyState({ title: t('publications.emptySearch') }));
    return;
  }
  if (kind === 'noData') {
    ui.stateHost.append(
      emptyState({
        title: t('publications.empty'),
        hint: t('publications.emptyHint'),
        action: {
          label: t('publications.new'),
          onClick: () =>
            openPublicationWizard({
              shelves,
              onCreated: (id) => {
                invalidatePublications();
                void openPublicationCard(id);
              },
            }),
        },
      }),
    );
  }
}

function renderPager(): void {
  if (ui === null) return;
  emptyNode(ui.pagerHost);
  if (total <= PAGE_SIZE) {
    ui.countLabel.textContent = total > 0 ? t('publications.page', [1, total, total]) : '';
    if (total > 0) ui.pagerHost.append(ui.countLabel);
    return;
  }
  const from = offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  ui.countLabel.textContent = t('publications.page', [from, to, total]);
  const prev = uiButton({
    label: t('publications.prev'),
    role: 'ghost',
    disabled: offset === 0,
    onClick: () => {
      offset = Math.max(0, offset - PAGE_SIZE);
      void load();
    },
  });
  const next = uiButton({
    label: t('publications.next'),
    role: 'ghost',
    disabled: to >= total,
    onClick: () => {
      offset = offset + PAGE_SIZE;
      void load();
    },
  });
  ui.pagerHost.append(prev, ui.countLabel, next);
}

// --- Полки (карточки) ------------------------------------------------------

interface ShelfBlock {
  kind: 'shelf';
  shelf: Shelf;
  items: Publication[];
  /**
   * Плоский блок выбранной полки (фильтр по конкретной полке, замечание 8
   * приёмки 5de0332d): без шапки-названия и пустого состояния — только
   * содержимое, без группировки. `undefined` — обычный блок-полка.
   */
  flat?: boolean;
}

function renderShelves(): void {
  if (ui === null) return;
  // Фильтр по конкретной полке: сервер уже вернул только её публикации —
  // показываем их плоско, БЕЗ названий остальных полок и их пустых состояний
  // (замечание 8 приёмки 5de0332d). `shelves` при этом содержит все полки,
  // поэтому группировка по ним рисовала бы пустые секции.
  if (viewState.shelfFilter !== null) {
    const block: ShelfBlock = {
      kind: 'shelf',
      shelf: { ...EMPTY_SHELF, id: viewState.shelfFilter, title: '' },
      items: [...publications],
      flat: true,
    };
    reconcileKeyed(ui.shelvesHost, [block], {
      key: (b) => b.shelf.id,
      keyAttr: LIB_SHELF_ATTR,
      build: (b) => buildShelfBlock(b),
      update: (node, b) => updateShelfBlock(node, b),
      // Переход «все полки → конкретная» обязан ПЕРЕСОБРАТЬ узел: раньше он мог
      // быть построен обычным блоком с шапкой, а плоский вид шапки не имеет
      // (замечание 8 приёмки 5de0332d). Сверка подписей этого не видит, поэтому
      // всегда перестраиваем.
      equals: () => false,
    });
    libraryNav?.refresh();
    return;
  }
  const grouped = groupByShelves(publications, shelves, viewState.sort);
  const blocks: ShelfBlock[] = grouped.byShelf.map(({ shelf, items }) => ({
    kind: 'shelf' as const,
    shelf,
    items,
  }));
  if (grouped.unshelved.length > 0) {
    blocks.push({
      kind: 'shelf',
      shelf: { ...EMPTY_SHELF, title: t('publications.shelf.none') },
      items: grouped.unshelved,
    });
  }
  reconcileKeyed(ui.shelvesHost, blocks, {
    key: (block) => block.shelf.id,
    keyAttr: LIB_SHELF_ATTR,
    build: (block) => buildShelfBlock(block),
    update: (node, block) => updateShelfBlock(node, block),
    equals: (a, b) =>
      a.flat === b.flat &&
      a.shelf.id === b.shelf.id &&
      a.shelf.title === b.shelf.title &&
      a.items === b.items,
  });
  libraryNav?.refresh();
}

/** Обновление блока-полки на месте (плоский и обычный варианты). */
function updateShelfBlock(node: HTMLElement, block: ShelfBlock): void {
  const cardsHost = cardsHosts.get(node);
  if (cardsHost !== undefined) syncCards(cardsHost, block.items);
  const title = node.querySelector('.pub-group-title');
  if (title !== null) title.textContent = block.shelf.title;
  const count = node.querySelector('.pub-list-count');
  if (count !== null) count.textContent = String(block.items.length);
  if (block.flat === true) return;
  applyShelfCollapsed(node, isShelfCollapsed(block.shelf.id, collapsedShelves));
  toggleShelfEmpty(node, block.items.length === 0);
}

/** Полка-плейсхолдер «Без полки» (не существует на сервере; DnD — снятие). */
const EMPTY_SHELF: Shelf = {
  id: '__unshelved__',
  title: '',
  position: 0,
  version: 0,
  marked_for_deletion: false,
  marked_for_deletion_at: null,
  marked_for_deletion_by: null,
  created_at: '',
  created_by: '',
  updated_at: '',
  updated_by: '',
  items: [],
};

function buildShelfBlock(block: ShelfBlock): HTMLElement {
  const section = div(`pub-shelf ${LIB_GROUP_CLASS}`);
  const cards = div('pub-cards');
  cardsHosts.set(section, cards);
  if (block.flat === true) {
    // Плоский вид выбранной полки: ни шапки с названием, ни пустого состояния
    // (замечание 8 приёмки 5de0332d) — только карточки содержимого.
    section.classList.add('pub-shelf-flat');
    section.append(cards);
    syncCards(cards, block.items);
    return section;
  }
  const head = buildGroupHead(block.shelf, section);
  wireDropTarget(head, block.shelf.id === EMPTY_SHELF.id ? null : block.shelf.id);
  // Пустое состояние полки (ошибка 87ad669a): без него только что созданная
  // полка без публикаций — это шапка высотой ~29px, которую легко не заметить.
  const empty = div('pub-shelf-empty');
  empty.append(emptyState({ title: t('publications.shelf.empty') }));
  shelfEmptyHosts.set(section, empty);
  section.append(head, cards, empty);
  applyShelfCollapsed(section, isShelfCollapsed(block.shelf.id, collapsedShelves));
  syncCards(cards, block.items);
  toggleShelfEmpty(section, block.items.length === 0);
  return section;
}

/**
 * Общая шапка полки-группы для обоих видов (задача 55ee3c85): кнопка-заголовок
 * с шевроном, клик — сворачивание, двойной клик по имени — inline-правка,
 * контекстное меню — команды полки. `count` показывается только в «Списке».
 */
function buildGroupHead(shelf: Shelf, section: HTMLElement, count?: number): HTMLButtonElement {
  const head = uiButton({
    role: 'ghost',
    class: LIB_HEAD_CLASS,
    onClick: () => setShelfCollapsed(shelf.id, !isShelfCollapsed(shelf.id, collapsedShelves)),
  });
  const title = span(shelf.title, 'pub-group-title');
  head.append(svgIcon('chevron-down', 14), title);
  if (count !== undefined) head.append(span(String(count), 'pub-list-count'));
  if (shelf.id !== EMPTY_SHELF.id) {
    // Двойной клик по имени — inline-переименование (задача 00160da1). Поле ввода
    // живёт в самой секции перед шапкой: вкладывать `<input>` в `<button>` нельзя.
    title.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      startShelfRename(shelf, title, section, head);
    });
    head.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openShelfMenu(ev, shelf);
    });
  }
  return head;
}

/** Применить свёрнутость секции-группы (класс, CSS прячет содержимое). */
function applyShelfCollapsed(section: HTMLElement | null, collapsed: boolean): void {
  section?.classList.toggle(LIB_GROUP_COLLAPSED_CLASS, collapsed);
}

/**
 * Свернуть/развернуть полку-группу. Состояние — модульный набор `collapsedShelves`
 * (единый для обоих видов). Переключение — на месте (без полной перерисовки):
 * так сохраняются фокус и выделение навигации.
 */
function setShelfCollapsed(shelfId: string, collapsed: boolean): void {
  if (collapsed) collapsedShelves.add(shelfId);
  else collapsedShelves.delete(shelfId);
  const host = activeListHost();
  const section = host?.querySelector<HTMLElement>(`[${LIB_SHELF_ATTR}="${shelfId}"]`) ?? null;
  applyShelfCollapsed(section, collapsed);
  libraryNav?.refresh();
}

/** Хост активного представления (полки или список). */
function activeListHost(): HTMLElement | null {
  if (ui === null) return null;
  return viewState.viewMode === 'shelves' ? ui.shelvesHost : ui.listHost;
}

/** Секция активного вида по id полки. */
function sectionOfShelf(shelfId: string): HTMLElement | null {
  return (
    activeListHost()?.querySelector<HTMLElement>(`[${LIB_SHELF_ATTR}="${shelfId}"]`) ?? null
  );
}

/** Enter на полке: открыть inline-правку имени в активном виде (задача 55ee3c85). */
function beginShelfRenameById(shelfId: string): void {
  const shelf = shelves.find((item) => item.id === shelfId);
  if (shelf === undefined) return;
  const section = sectionOfShelf(shelfId);
  if (section === null) return;
  const head = section.querySelector<HTMLElement>(`.${LIB_HEAD_CLASS}`);
  const title = section.querySelector<HTMLElement>('.pub-group-title');
  if (head === null || title === null) return;
  startShelfRename(shelf, title, section, head);
}

/** Показать/скрыть пустое состояние секции полки. */
function toggleShelfEmpty(section: HTMLElement, isEmpty: boolean): void {
  shelfEmptyHosts.get(section)?.classList.toggle('hidden', !isEmpty);
}

function syncCards(cardsHost: HTMLElement, items: readonly Publication[]): void {
  reconcileKeyed(cardsHost, items, {
    key: (p) => p.id,
    keyAttr: LIB_PUB_ATTR,
    build: (p) => buildCard(p),
    update: (node, p) => updateCard(node, p),
    equals: (a, b) => a.id === b.id && a.version === b.version,
  });
}

function buildCard(publication: Publication): HTMLElement {
  const card = div('pub-card');
  card.draggable = true;
  card.tabIndex = 0;
  card.append(buildCover(publication, 'card'));
  const info = div('pub-card-info');
  info.append(
    span(publication.title, 'pub-card-title'),
    span(publication.subtitle ?? '', 'pub-card-subtitle'),
    span(authorLine(publication), 'pub-card-author'),
    span(assemblyDateLabel(publication.assembly_date), 'pub-card-date'),
  );
  const badgeNode = badge('', { kind: 'pill', tone: 'accent' });
  badgeNode.classList.add('pub-new-badge');
  badgeBadges.set(publication.id, badgeNode);
  info.append(badgeNode);
  card.append(info);
  updateCard(card, publication);
  wireCardEvents(card, publication);
  return card;
}

function updateCard(card: HTMLElement, publication: Publication): void {
  card.classList.toggle('pub-inactive', !publication.active);
  const title = card.querySelector('.pub-card-title');
  if (title !== null) title.textContent = publication.title;
  const subtitle = card.querySelector('.pub-card-subtitle');
  if (subtitle !== null) subtitle.textContent = publication.subtitle ?? '';
  const author = card.querySelector('.pub-card-author');
  if (author !== null) author.textContent = authorLine(publication);
  const date = card.querySelector('.pub-card-date');
  if (date !== null) date.textContent = assemblyDateLabel(publication.assembly_date);
  const cover = card.querySelector('.pub-cover');
  if (cover !== null && cover.getAttribute('data-kind') !== publication.cover_kind) {
    cover.replaceWith(buildCover(publication, 'card'));
  }
}

function wireCardEvents(card: HTMLElement, publication: Publication): void {
  // Одиночный клик — то же, что Enter: карточка публикации в панели редактора;
  // двойной клик — режим чтения (задача b51dbca4). Ctrl+Enter (навигация)
  // делает то же, что двойной клик.
  card.addEventListener('click', () => void openPublicationCard(publication.id));
  card.addEventListener('dblclick', () => void openPublicationWorkspace(publication.id));
  card.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openPublicationMenu(ev, publication);
  });
  card.addEventListener('dragstart', (ev) => {
    draggingPublicationId = publication.id;
    ev.dataTransfer?.setData('text/plain', publication.id);
    if (ev.dataTransfer !== null) ev.dataTransfer.effectAllowed = 'move';
    card.classList.add('pub-dragging');
  });
  card.addEventListener('dragend', () => {
    draggingPublicationId = null;
    card.classList.remove('pub-dragging');
  });
}

// --- Список (полки-группы на фасаде таблиц) --------------------------------

/**
 * Группа списка: полка и её строки (задача 55ee3c85). Полка — реально
 * сворачиваемая группа (общий контроллер навигации и общий переключатель
 * `collapsedShelves`), строки — двухстрочные записи `.pub-entry` на keyed-сверке.
 * Таблиц с колонками внутри групп больше нет (прямое требование задачи;
 * расхождение с требованием 93115633 — осознанное, зафиксировано хроно-записью).
 */
interface ListGroup {
  id: string;
  shelfId: string | null;
  title: string;
  count: number;
  rows: Publication[];
  /** Группа свёрнута — строки не рендерятся. */
  collapsed: boolean;
  /** Пустая полка (0 публикаций) — чтобы было видно её состояние. */
  empty: boolean;
  /** Плоский вид выбранной полки (фильтр): без шапки и пустого состояния. */
  flat?: boolean;
}

/** Ключ группы «Без полки» (публикации без полок). */
const UNSHELVED_ID = '__unshelved__';

/** Хосты строк групп (для вложенной keyed-сверки). */
const entriesHosts = new WeakMap<HTMLElement, HTMLElement>();

/** Хосты пустого состояния пустой полки-группы (ошибка 87ad669a). */
const listEmptyHosts = new WeakMap<HTMLElement, HTMLElement>();

function renderList(): void {
  if (ui === null) return;
  // Фильтр по конкретной полке: плоско, без названий остальных полок и их
  // пустых состояний (замечание 8 приёмки 5de0332d) — как и в виде «полки».
  if (viewState.shelfFilter !== null) {
    const group: ListGroup = {
      id: viewState.shelfFilter,
      shelfId: viewState.shelfFilter,
      title: '',
      count: publications.length,
      rows: [...publications],
      collapsed: false,
      empty: false,
      flat: true,
    };
    reconcileKeyed(ui.listHost, [group], {
      key: (g) => g.id,
      keyAttr: LIB_SHELF_ATTR,
      build: (g) => buildListGroup(g),
      update: (node, g) => updateListGroup(node, g),
      // См. renderShelves: переход к плоскому виду требует пересборки узла.
      equals: () => false,
    });
    libraryNav?.refresh();
    return;
  }
  const grouped = groupByShelves(publications, shelves, viewState.sort);
  const groups: ListGroup[] = [];
  const seen = new Set<string>();
  const pushGroup = (
    shelfId: string | null,
    title: string,
    items: Publication[],
  ): void => {
    const id = shelfId ?? UNSHELVED_ID;
    const collapsed = shelfId !== null && isShelfCollapsed(shelfId, collapsedShelves);
    const rows: Publication[] = [];
    if (!collapsed) {
      for (const publication of items) {
        if (seen.has(publication.id)) continue;
        seen.add(publication.id);
        rows.push(publication);
      }
    }
    groups.push({ id, shelfId, title, count: items.length, rows, collapsed, empty: items.length === 0 });
  };
  for (const { shelf, items } of grouped.byShelf) {
    // Пустые полки не пропускаем (ошибка 87ad669a): только что созданная полка
    // без публикаций обязана быть видна и в виде «список» — группой с пустым
    // состоянием.
    pushGroup(shelf.id, shelf.title, items);
  }
  if (grouped.unshelved.length > 0) {
    pushGroup(null, t('publications.shelf.none'), grouped.unshelved);
  }
  reconcileKeyed(ui.listHost, groups, {
    key: (group) => group.id,
    keyAttr: LIB_SHELF_ATTR,
    build: (group) => buildListGroup(group),
    update: (node, group) => updateListGroup(node, group),
    equals: (a, b) =>
      a.flat === b.flat &&
      a.title === b.title &&
      a.count === b.count &&
      a.collapsed === b.collapsed &&
      a.empty === b.empty &&
      a.rows.length === b.rows.length &&
      a.rows.every((row, index) => rowSignature(row) === rowSignature(b.rows[index])),
  });
  libraryNav?.refresh();
}

/** Подпись строки для сравнения (версия + визуально значимые поля). */
function rowSignature(row: Publication | undefined): string {
  if (row === undefined) return '';
  return `${row.id}:${row.version}:${row.title}:${row.subtitle ?? ''}:${row.authorship ?? ''}:${row.assembly_date ?? ''}:${row.active}:${row.cover_kind}`;
}

function buildListGroup(group: ListGroup): HTMLElement {
  const section = div(`pub-list-section ${LIB_GROUP_CLASS}`);
  const list = div('pub-entries');
  entriesHosts.set(section, list);
  if (group.flat === true) {
    // Плоский вид выбранной полки в «Списке»: без шапки-названия и пустого
    // состояния (замечание 8 приёмки 5de0332d).
    section.classList.add('pub-list-section-flat');
    section.append(list);
    syncEntries(list, group.rows);
    return section;
  }
  const shelf =
    group.shelfId === null
      ? { ...EMPTY_SHELF, title: group.title }
      : (shelves.find((item) => item.id === group.shelfId) ?? {
          ...EMPTY_SHELF,
          id: group.shelfId,
          title: group.title,
        });
  const head = buildGroupHead(shelf, section, group.count);
  wireDropTarget(head, group.shelfId);
  // Пустая группа-полка видна и в «Списке» (ошибка 87ad669a): шапка с count 0
  // плюс пустое состояние, иначе полку без публикаций невозможно заметить.
  const empty = div('pub-list-empty');
  empty.append(emptyState({ title: t('publications.shelf.empty') }));
  listEmptyHosts.set(section, empty);
  section.append(head, list, empty);
  applyShelfCollapsed(section, group.collapsed);
  syncEntries(list, group.rows);
  toggleListEmpty(section, group.empty);
  return section;
}

function updateListGroup(node: HTMLElement, group: ListGroup): void {
  const title = node.querySelector('.pub-group-title');
  if (title !== null) title.textContent = group.title;
  const count = node.querySelector('.pub-list-count');
  if (count !== null) count.textContent = String(group.count);
  applyShelfCollapsed(node, group.collapsed);
  const list = entriesHosts.get(node);
  if (list !== undefined) syncEntries(list, group.rows);
  toggleListEmpty(node, group.empty);
}

/** Показать/скрыть пустое состояние пустой полки-группы. */
function toggleListEmpty(section: HTMLElement, isEmpty: boolean): void {
  listEmptyHosts.get(section)?.classList.toggle('hidden', !isEmpty);
}

/** Сверка строк группы по ключу (id публикации) — инкрементально. */
function syncEntries(host: HTMLElement, rows: readonly Publication[]): void {
  reconcileKeyed(host, rows, {
    key: (row) => row.id,
    keyAttr: LIB_PUB_ATTR,
    build: (row) => buildEntry(row),
    update: (node, row) => updateEntry(node, row),
    equals: (a, b) => rowSignature(a) === rowSignature(b),
  });
}

/**
 * Строка публикации в «Списке» — ДВЕ строки (задача 55ee3c85):
 * (1) заголовок крупным шрифтом без переноса + автор обычным, прижат вправо;
 * (2) подзаголовок мелким шрифтом с переносом, обрезается по высоте в две
 * строки (CSS). Обложка-миниатюра — слева. Клик — читать, меню — контекстное.
 */
function buildEntry(publication: Publication): HTMLElement {
  const entry = div('pub-entry');
  entry.tabIndex = 0;
  const cover = buildCover(publication, 'row');
  const text = div('pub-entry-text');
  const top = div('pub-entry-top');
  const badgeNode = badge('', { kind: 'pill', tone: 'accent' });
  badgeNode.classList.add('pub-new-badge');
  badgeBadges.set(publication.id, badgeNode);
  top.append(
    span(publication.title, 'pub-entry-title'),
    span(authorLine(publication), 'pub-entry-author'),
    badgeNode,
  );
  const subtitle = span(publication.subtitle ?? '', 'pub-entry-subtitle');
  text.append(top, subtitle);
  entry.append(cover, text);
  updateEntry(entry, publication);
  wireEntryEvents(entry, publication);
  return entry;
}

function updateEntry(entry: HTMLElement, publication: Publication): void {
  entry.classList.toggle('pub-inactive', !publication.active);
  const title = entry.querySelector('.pub-entry-title');
  if (title !== null) title.textContent = publication.title;
  const author = entry.querySelector('.pub-entry-author');
  if (author !== null) author.textContent = authorLine(publication);
  const subtitle = entry.querySelector('.pub-entry-subtitle');
  if (subtitle !== null) subtitle.textContent = publication.subtitle ?? '';
  const cover = entry.querySelector('.pub-cover');
  if (cover !== null && cover.getAttribute('data-kind') !== publication.cover_kind) {
    cover.replaceWith(buildCover(publication, 'row'));
  }
}

function wireEntryEvents(entry: HTMLElement, publication: Publication): void {
  // Одиночный клик — карточка в редакторе, двойной — чтение (задача b51dbca4).
  entry.addEventListener('click', () => void openPublicationCard(publication.id));
  entry.addEventListener('dblclick', () => void openPublicationWorkspace(publication.id));
  entry.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openPublicationMenu(ev, publication);
  });
}

/** Отображаемая строка автора: текст авторства или создатель (через users). */
function authorLine(publication: Publication): string {
  return displayAuthorship(publication, users.resolveUserName(publication.created_by));
}

// ---------------------------------------------------------------------------
// Drag & drop между полками
// ---------------------------------------------------------------------------

function wireDropTarget(target: HTMLElement, shelfId: string | null): void {
  target.addEventListener('dragover', (ev) => {
    if (draggingPublicationId === null) return;
    ev.preventDefault();
    if (ev.dataTransfer !== null) ev.dataTransfer.dropEffect = 'move';
    target.classList.add('pub-drop');
  });
  target.addEventListener('dragleave', () => target.classList.remove('pub-drop'));
  target.addEventListener('drop', (ev) => {
    ev.preventDefault();
    target.classList.remove('pub-drop');
    const id = draggingPublicationId ?? ev.dataTransfer?.getData('text/plain') ?? '';
    if (id === '') return;
    void movePublication(id, shelfId);
  });
}

/** Переносит публикацию на полку (или снимает со всех, если `shelfId` = null). */
async function movePublication(publicationId: string, targetShelfId: string | null): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const current = shelves.filter((s) => s.items.some((i) => i.publication_id === publicationId));
  if (targetShelfId !== null) {
    if (current.some((s) => s.id === targetShelfId)) return; // уже там
    for (const shelf of current) {
      await etn.publications.removeShelfItem(networkId, shelf.id, publicationId).catch(() => undefined);
    }
    const target = shelves.find((s) => s.id === targetShelfId);
    const position =
      target === undefined
        ? undefined
        : target.items.reduce((max, item) => Math.max(max, item.position), 0) + 1;
    try {
      await etn.publications.addShelfItem(networkId, targetShelfId, publicationId, position);
    } catch (err) {
      errorDialog(t('publications.title'), err);
    }
  } else {
    for (const shelf of current) {
      await etn.publications.removeShelfItem(networkId, shelf.id, publicationId).catch(() => undefined);
    }
  }
  invalidatePublications();
}

// ---------------------------------------------------------------------------
// Меню
// ---------------------------------------------------------------------------

function openSortMenu(ev: MouseEvent): void {
  const items = (Object.keys(SORT_LABEL_KEY) as PublicationSort[]).map((sort) =>
    menuChoice(t(SORT_LABEL_KEY[sort]), viewState.sort === sort, () => {
      viewState = { ...viewState, sort };
      offset = 0;
      persist();
      void load();
    }),
  );
  showMenuAt(ev.clientX, ev.clientY, items);
}

function openShelfFilterMenu(ev: MouseEvent): void {
  const items = [
    menuChoice(t('publications.shelf.all'), viewState.shelfFilter === null, () => {
      viewState = { ...viewState, shelfFilter: null };
      offset = 0;
      persist();
      void load();
    }),
    ...shelves.map((shelf) =>
      menuChoice(shelf.title, viewState.shelfFilter === shelf.id, () => {
        viewState = { ...viewState, shelfFilter: shelf.id };
        offset = 0;
        persist();
        void load();
      }),
    ),
  ];
  showMenuAt(ev.clientX, ev.clientY, items);
}

function openPublicationMenu(ev: MouseEvent, publication: Publication): void {
  showMenuAt(ev.clientX, ev.clientY, publicationMenuItems(publication));
}

/**
 * Пункты контекстного меню публикации (карточки полки и строки списка) —
 * ЕДИНЫЕ для обоих видов и обеих задач (55ee3c85, b51dbca4). Состав задаёт
 * чистая модель `publicationMenuCommands` (покрыта тестом): «Открыть»,
 * «Удалить», «Читать» и «Экспортировать» (подменю md/html).
 */
function publicationMenuItems(publication: Publication): MenuItem[] {
  const commands = publicationMenuCommands();
  const items: MenuItem[] = [];
  let exportItems: MenuItem[] = [];
  for (const command of commands) {
    switch (command) {
      case 'open':
        items.push(menuAction(t('publications.menu.open'), () => void openPublicationCard(publication.id)));
        break;
      case 'read':
        items.push(
          menuAction(t('publications.menu.read'), () => void openPublicationWorkspace(publication.id)),
          MENU_SEPARATOR,
        );
        break;
      case 'exportMd':
        exportItems.push(menuAction(t('publications.menu.exportMd'), () => void runExport(publication.id, 'md')));
        break;
      case 'exportHtml':
        exportItems.push(menuAction(t('publications.menu.exportHtml'), () => void runExport(publication.id, 'html')));
        items.push(menuSubmenu(t('publications.menu.export'), exportItems), MENU_SEPARATOR);
        exportItems = [];
        break;
      case 'delete':
        items.push(
          menuAction(t('publications.menu.delete'), () => void openPublicationDeleteDialog(publication), {
            danger: true,
          }),
        );
        break;
    }
  }
  return items;
}

/**
 * Контекстное меню полки/группы: «Добавить публикацию» (мастер с предвыбранной
 * полкой) и «Удалить» — состав из чистой модели `shelfMenuCommands`.
 */
function openShelfMenu(ev: MouseEvent, shelf: Shelf): void {
  const items = shelfMenuCommands().map((command) =>
    command === 'addPublication'
      ? menuAction(t('publications.menu.addPublication'), () =>
          openPublicationWizard({
            shelves,
            initialShelfId: shelf.id,
            onCreated: (id) => {
              invalidatePublications();
              void openPublicationCard(id);
            },
          }),
        )
      : menuAction(t('publications.menu.delete'), () => void openShelfDeleteDialog(shelf), {
          danger: true,
        }),
  );
  showMenuAt(ev.clientX, ev.clientY, items);
}

/** Строки-причины, почему публикацию нельзя удалить совсем (для диалога). */
function publicationBlockedLines(blocking: PublicationDeletionBlocking): string[] {
  const lines: string[] = [];
  if (blocking.properties > 0) {
    lines.push(t('publications.delete.reasonProperties', blocking.properties));
  }
  if (blocking.layers.some((layer) => layer.id === BASE_LAYER_ID)) {
    lines.push(t('publications.delete.reasonBase'));
  }
  const others = blocking.layers.filter((layer) => layer.id !== BASE_LAYER_ID);
  if (others.length > 0) {
    lines.push(
      t('publications.delete.reasonLayers', others.map((layer) => `«${layer.title}»`).join(', ')),
    );
  }
  return lines;
}

/** Диалог удаления публикации: «Удалить совсем» (если возможно) / «В корзину». */
async function openPublicationDeleteDialog(publication: Publication): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  let check: { blocked: boolean; blocking: PublicationDeletionBlocking };
  try {
    check = await etn.publications.deletionCheck(networkId, publication.id);
  } catch (err) {
    errorDialog(t('publications.title'), err);
    return;
  }
  const alreadyMarked = publication.marked_for_deletion;
  openEntityDeleteDialog({
    title: t('publications.delete.publicationTitle', publication.title),
    lines: publicationBlockedLines(check.blocking),
    blocked: check.blocked,
    alreadyMarked,
    onPurge: async (close) => {
      try {
        await etn.publications.purge(networkId, publication.id);
        close();
      } catch (err) {
        errorDialog(t('publications.delete.publicationTitle', publication.title), err);
      }
      invalidatePublications();
    },
    onTrash: async (close) => {
      try {
        if (alreadyMarked) await etn.publications.restore(networkId, publication.id);
        else await etn.publications.trash(networkId, publication.id);
        close();
      } catch (err) {
        errorDialog(t('publications.title'), err);
      }
      invalidatePublications();
    },
  });
}

/** Диалог удаления полки: «Удалить совсем» (только в основе) / «В корзину». */
async function openShelfDeleteDialog(shelf: Shelf): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  let check: { blocked: boolean };
  try {
    check = await etn.publications.shelfDeletionCheck(networkId, shelf.id);
  } catch (err) {
    errorDialog(t('publications.title'), err);
    return;
  }
  const alreadyMarked = shelf.marked_for_deletion;
  openEntityDeleteDialog({
    title: t('publications.delete.shelfTitle', shelf.title),
    lines: check.blocked ? [t('publications.delete.reasonShelfBase')] : [],
    blocked: check.blocked,
    alreadyMarked,
    onPurge: async (close) => {
      try {
        await etn.publications.purgeShelf(networkId, shelf.id);
        close();
      } catch (err) {
        errorDialog(t('publications.delete.shelfTitle', shelf.title), err);
      }
      dropShelfFilter(shelf.id);
      invalidatePublications();
    },
    onTrash: async (close) => {
      try {
        if (alreadyMarked) await etn.publications.restoreShelf(networkId, shelf.id);
        else await etn.publications.trashShelf(networkId, shelf.id);
        close();
      } catch (err) {
        errorDialog(t('publications.title'), err);
      }
      dropShelfFilter(shelf.id);
      invalidatePublications();
    },
  });
}

/** Сбросить фильтр полки, если удалили именно её. */
function dropShelfFilter(shelfId: string): void {
  if (viewState.shelfFilter !== shelfId) return;
  viewState = { ...viewState, shelfFilter: null };
  persist();
}

// ---------------------------------------------------------------------------
// Inline-переименование полки (задача 00160da1)
// ---------------------------------------------------------------------------

/**
 * Двойной клик по имени полки/группы: заголовок заменяется полем ввода с
 * текущим именем. Enter или потеря фокуса — сохранить (PATCH), Esc — отменить
 * и вернуть прежнее значение. Поле — фасад `fieldInput` (правило lib/ui).
 *
 * `inputHost` — куда вставить поле; `hideEl` — что скрыть на время правки
 * (у вида «список» шапка — `<button>`, вкладывать в неё `<input>` нельзя,
 * поэтому поле живёт в секции перед шапкой).
 */
function startShelfRename(
  shelf: Shelf,
  titleEl: HTMLElement,
  inputHost: HTMLElement,
  hideEl: HTMLElement = titleEl,
): void {
  if (renamingShelfId !== null) return;
  renamingShelfId = shelf.id;
  const input = fieldInput({ extraClass: 'pub-shelf-rename', bare: true });
  input.value = shelf.title;
  input.setAttribute('aria-label', t('publications.shelf.rename'));
  hideEl.classList.add('hidden');
  inputHost.insertBefore(input, hideEl);
  input.focus();
  input.select();

  let finished = false;
  const finish = (save: boolean): void => {
    if (finished) return;
    finished = true;
    renamingShelfId = null;
    const title = save ? nextShelfTitle(shelf.title, input.value) : null;
    input.remove();
    hideEl.classList.remove('hidden');
    if (title === null) return;
    titleEl.textContent = title;
    void commitShelfRename(shelf, title);
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/** PATCH имени полки после inline-правки; перечитать список. */
async function commitShelfRename(shelf: Shelf, title: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    await etn.publications.updateShelf(networkId, shelf.id, { title });
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  invalidatePublications();
}

async function createShelf(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  // Контракт диалога СОЗДАНИЯ (ошибка 87ad669a): заголовок «Новая полка»,
  // подпись «Название полки», пустое поле. Переименование — inline, двойным
  // кликом по имени полки (задача 00160da1).
  const title = await promptDialog(t('publications.shelf.create'), t('publications.shelf.name'), '');
  if (title === null || title.trim() === '') return;
  try {
    await etn.publications.createShelf(networkId, { title: title.trim() });
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  invalidatePublications();
}

/** Меню формата экспорта из рабочей области открытой публикации (2ebacd12). */
function openWorkspaceExportMenu(publicationId: string, ev: MouseEvent): void {
  showMenuAt(ev.clientX, ev.clientY, [
    menuAction(t('publications.menu.exportMd'), () => void runExport(publicationId, 'md')),
    menuAction(t('publications.menu.exportHtml'), () => void runExport(publicationId, 'html')),
  ]);
}

/** Экспорт документа публикации: старт джобы → ожидание → сохранение zip. */
async function runExport(publicationId: string, format: 'md' | 'html'): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const { job_id } = await etn.publications.export(networkId, publicationId, { format });
    let job = await etn.system.getJob(job_id);
    for (let attempt = 0; attempt < 60 && job.status !== 'done' && job.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      job = await etn.system.getJob(job_id);
    }
    if (job.status !== 'done') throw new Error(t('publications.error'));
    await etn.system.downloadExport(job_id, job.filename ?? `publication.${format}.zip`);
  } catch (err) {
    errorDialog(t('publications.menu.export'), err);
  }
}
