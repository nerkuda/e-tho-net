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
  PublicationSort,
  Shelf,
} from '@etn/shared';
import { UI_STATE_KEY } from '@etn/shared';

import {
  div,
  span,
  setTooltip,
} from '../../lib/dom.js';
import { t, type MessageKey } from '../../lib/i18n.js';
import { etn } from '../../lib/etn.js';
import { svgIcon } from '../../lib/icons.js';
import { confirmDialog, errorDialog, promptDialog } from '../../lib/dialog.js';
import { MENU_SEPARATOR, menuAction, menuChoice, menuSubmenu, showMenuAt } from '../../lib/menu.js';
import { uiButton, iconButton } from '../../lib/ui/button.js';
import { fieldInput } from '../../lib/ui/field.js';
import { segmentedControl } from '../../lib/ui/segmented.js';
import { badge, setBadgeText } from '../../lib/ui/badge.js';
import { emptyState, errorState, loadingState } from '../../lib/ui/empty-state.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { store } from '../../state.js';
import * as users from '../../lib/users.js';
import { buildCover } from './cover.js';
import {
  assemblyDateLabel,
  defaultPublicationsViewState,
  displayAuthorship,
  groupByShelves,
  parsePublicationsViewState,
  serializePublicationsViewState,
  type PublicationsViewState,
} from './model.js';
import { openPublicationWizard } from './wizard.js';

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
let draggingPublicationId: string | null = null;
const expandedShelves = new Set<string>();
const badgeCounts = new Map<string, number>();
const badgeBadges = new Map<string, HTMLElement>();

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

/** Хост карточек внутри секции полки (для вложенной keyed-сверки). */
const cardsHosts = new WeakMap<HTMLElement, HTMLElement>();

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
  unsubStore = store.subscribe(() => {
    if (hostEl.isConnected !== true) return;
    if (store.state.activeView === 'publications') void initForNetwork(false);
  });
  return () => {
    unsubStore?.();
    unsubStore = null;
    if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    reloadTimer = null;
    searchTimer = null;
    ui = null;
    initializedNetworkId = null;
  };
}

/** Инвалидирует список (перечитать из сервера с дебаунсом). */
export function invalidatePublications(): void {
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null;
    void load();
  }, 150);
}

/** Realtime-ветка экрана: публикации и полки перечитываются. */
export function applyPublicationsRealtime(eventType: string): void {
  if (
    eventType.startsWith('publication.') ||
    eventType === 'shelf.updated' ||
    eventType === 'shelf.deleted'
  ) {
    if (store.state.activeView === 'publications') invalidatePublications();
  }
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
    const live = store.state.editorTarget;
    if (live?.kind === 'publication' && live.id === id) {
      store.update({ editorTarget: { kind: 'publication', id, publication } });
    }
  } catch {
    // Сущность не пришла (удалена/нет доступа) — карточка покажет состояние
    // загрузки; повторное открытие перечитает.
  }
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
  const newButton = uiButton({
    label: t('publications.new'),
    role: 'primary',
    onClick: () =>
      openPublicationWizard({
        onCreated: (id) => {
          invalidatePublications();
          void openPublicationCard(id);
        },
      }),
  });
  newButton.prepend(svgIcon('plus', 14));

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
    expandedShelves.clear();
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
  if (shelvesView) renderShelves();
  else renderList();
}

function renderState(): void {
  if (ui === null) return;
  emptyNode(ui.stateHost);
  ui.shelvesHost.classList.toggle('hidden', viewState.viewMode !== 'shelves' || loading || loadError !== null);
  ui.listHost.classList.toggle('hidden', viewState.viewMode !== 'list' || loading || loadError !== null);
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
  if (publications.length === 0) {
    const searching = viewState.query.trim() !== '' || viewState.shelfFilter !== null;
    ui.stateHost.append(
      emptyState({
        title: searching ? t('publications.emptySearch') : t('publications.empty'),
        ...(searching
          ? {}
          : {
              hint: t('publications.emptyHint'),
              action: {
                label: t('publications.new'),
                onClick: () =>
                  openPublicationWizard({
                    onCreated: (id) => {
                      invalidatePublications();
                      void openPublicationCard(id);
                    },
                  }),
              },
            }),
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
}

function renderShelves(): void {
  if (ui === null) return;
  const grouped = groupByShelves(publications, shelves);
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
    build: (block) => buildShelfBlock(block),
    update: (node, block) => {
      const cardsHost = cardsHosts.get(node);
      if (cardsHost !== undefined) syncCards(cardsHost, block.items);
      const title = node.querySelector('.pub-shelf-title');
      if (title !== null) title.textContent = block.shelf.title;
    },
    equals: (a, b) =>
      a.shelf.id === b.shelf.id &&
      a.shelf.title === b.shelf.title &&
      a.items === b.items,
  });
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
  const section = div('pub-shelf');
  section.dataset['shelfId'] = block.shelf.id;
  const head = div('pub-shelf-head');
  const title = span(block.shelf.title, 'pub-shelf-title');
  head.append(title);
  if (block.shelf.id !== EMPTY_SHELF.id) {
    head.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openShelfMenu(ev, block.shelf);
    });
  }
  wireDropTarget(head, block.shelf.id === EMPTY_SHELF.id ? null : block.shelf.id);
  const cards = div('pub-cards');
  cardsHosts.set(section, cards);
  section.append(head, cards);
  syncCards(cards, block.items);
  return section;
}

function syncCards(cardsHost: HTMLElement, items: readonly Publication[]): void {
  reconcileKeyed(cardsHost, items, {
    key: (p) => p.id,
    build: (p) => buildCard(p),
    update: (node, p) => updateCard(node, p),
    equals: (a, b) => a.id === b.id && a.version === b.version,
  });
}

function buildCard(publication: Publication): HTMLElement {
  const card = div('pub-card');
  card.dataset['pubId'] = publication.id;
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
  card.dataset['pubId'] = publication.id;
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
  card.addEventListener('click', () => void openPublicationCard(publication.id));
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void openPublicationCard(publication.id);
  });
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

// --- Список (строки, полки-группы) -----------------------------------------

interface ListRow {
  kind: 'group' | 'pub';
  key: string;
  shelfId: string | null;
  title?: string;
  count?: number;
  publication?: Publication;
}

function renderList(): void {
  if (ui === null) return;
  const grouped = groupByShelves(publications, shelves);
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  const pushGroup = (shelfId: string | null, title: string, count: number, items: Publication[]): void => {
    const expanded = shelfId === null || expandedShelves.has(shelfId);
    rows.push({ kind: 'group', key: `g:${shelfId ?? '__unshelved__'}`, shelfId, title, count });
    if (!expanded) return;
    for (const publication of items) {
      if (seen.has(publication.id)) continue;
      seen.add(publication.id);
      rows.push({ kind: 'pub', key: `p:${shelfId ?? 'u'}:${publication.id}`, shelfId, publication });
    }
  };
  for (const { shelf, items } of grouped.byShelf) {
    if (items.length === 0) continue;
    pushGroup(shelf.id, shelf.title, items.length, items);
  }
  if (grouped.unshelved.length > 0) {
    pushGroup(null, t('publications.shelf.none'), grouped.unshelved.length, grouped.unshelved);
  }
  reconcileKeyed(ui.listHost, rows, {
    key: (row) => row.key,
    build: (row) => buildRow(row),
    update: (node, row) => updateRow(node, row),
    equals: (a, b) =>
      a.kind === b.kind &&
      a.key === b.key &&
      a.title === b.title &&
      a.count === b.count &&
      (a.publication?.version ?? '') === (b.publication?.version ?? '') &&
      a.publication?.title === b.publication?.title &&
      a.publication?.active === b.publication?.active,
  });
}

function buildRow(row: ListRow): HTMLElement {
  return row.kind === 'group' ? buildGroupRow(row) : buildPubRow(row);
}

function updateRow(node: HTMLElement, row: ListRow): void {
  if (row.kind === 'group') {
    const title = node.querySelector('.pub-row-group-title');
    if (title !== null) title.textContent = row.title ?? '';
    const count = node.querySelector('.pub-row-group-count');
    if (count !== null) count.textContent = String(row.count ?? 0);
    node.classList.toggle(
      'pub-row-group-collapsed',
      row.shelfId !== null && !expandedShelves.has(row.shelfId),
    );
    return;
  }
  const publication = row.publication;
  if (publication === undefined) return;
  node.dataset['pubId'] = publication.id;
  node.classList.toggle('pub-inactive', !publication.active);
  const title = node.querySelector('.pub-row-title');
  if (title !== null) title.textContent = publication.title;
  const subtitle = node.querySelector('.pub-row-subtitle');
  if (subtitle !== null) subtitle.textContent = publication.subtitle ?? '';
  const author = node.querySelector('.pub-row-author');
  if (author !== null) author.textContent = authorLine(publication);
  const date = node.querySelector('.pub-row-date');
  if (date !== null) date.textContent = assemblyDateLabel(publication.assembly_date);
}

function buildGroupRow(row: ListRow): HTMLElement {
  const node = div('pub-row-group');
  node.append(svgIcon('chevron-down', 14));
  node.append(span(row.title ?? '', 'pub-row-group-title'));
  node.append(span(String(row.count ?? 0), 'pub-row-group-count'));
  if (row.shelfId !== null) {
    node.classList.add('pub-row-group-collapsible');
    node.addEventListener('click', () => {
      if (expandedShelves.has(row.shelfId!)) expandedShelves.delete(row.shelfId!);
      else expandedShelves.add(row.shelfId!);
      renderList();
    });
    node.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const shelf = shelves.find((s) => s.id === row.shelfId);
      if (shelf !== undefined) openShelfMenu(ev, shelf);
    });
  }
  wireDropTarget(node, row.shelfId);
  return node;
}

function buildPubRow(row: ListRow): HTMLElement {
  const publication = row.publication;
  const node = div('pub-row');
  if (publication === undefined) return node;
  node.dataset['pubId'] = publication.id;
  node.draggable = true;
  node.tabIndex = 0;
  node.append(buildCover(publication, 'row'));
  node.append(span(publication.title, 'pub-row-title'));
  node.append(span(publication.subtitle ?? '', 'pub-row-subtitle'));
  node.append(span(authorLine(publication), 'pub-row-author'));
  node.append(span(assemblyDateLabel(publication.assembly_date), 'pub-row-date'));
  node.addEventListener('click', () => void openPublicationCard(publication.id));
  node.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void openPublicationCard(publication.id);
  });
  node.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openPublicationMenu(ev, publication);
  });
  node.addEventListener('dragstart', (ev) => {
    draggingPublicationId = publication.id;
    ev.dataTransfer?.setData('text/plain', publication.id);
    if (ev.dataTransfer !== null) ev.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragend', () => {
    draggingPublicationId = null;
  });
  return node;
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
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const shelfItems = shelves.map((shelf) =>
    menuChoice(
      shelf.title,
      shelf.items.some((i) => i.publication_id === publication.id),
      () => void toggleShelf(publication.id, shelf.id),
    ),
  );
  const items = [
    menuAction(t('publications.menu.settings'), () => void openPublicationCard(publication.id)),
    menuSubmenu(t('publications.menu.export'), [
      menuAction(t('publications.menu.exportMd'), () => void runExport(publication.id, 'md')),
      menuAction(t('publications.menu.exportHtml'), () => void runExport(publication.id, 'html')),
    ]),
    MENU_SEPARATOR,
    ...(shelfItems.length > 0
      ? [menuSubmenu(t('publications.menu.shelves'), shelfItems)]
      : []),
    menuAction(
      publication.active ? t('publications.menu.inactive') : t('publications.menu.active'),
      () => void toggleActive(publication),
    ),
    menuAction(t('actions.toTrash'), () => void trash(publication.id), { danger: true }),
  ];
  showMenuAt(ev.clientX, ev.clientY, items);
}

function openShelfMenu(ev: MouseEvent, shelf: Shelf): void {
  showMenuAt(ev.clientX, ev.clientY, [
    menuAction(t('publications.shelf.rename'), () => void renameShelf(shelf)),
    menuAction(t('publications.shelf.trash'), () => void trashShelf(shelf), { danger: true }),
  ]);
}

async function toggleShelf(publicationId: string, shelfId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const shelf = shelves.find((s) => s.id === shelfId);
  const on = shelf?.items.some((i) => i.publication_id === publicationId) ?? false;
  try {
    if (on) await etn.publications.removeShelfItem(networkId, shelfId, publicationId);
    else await etn.publications.addShelfItem(networkId, shelfId, publicationId);
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  invalidatePublications();
}

async function toggleActive(publication: Publication): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    await etn.publications.update(
      networkId,
      publication.id,
      { active: !publication.active },
      publication.version,
    );
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  invalidatePublications();
}

async function trash(publicationId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const ok = await confirmDialog(t('actions.toTrash'), t('actions.toTrash'), true);
  if (!ok) return;
  try {
    await etn.publications.trash(networkId, publicationId);
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  invalidatePublications();
}

async function createShelf(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const title = await promptDialog(t('publications.newShelf'), t('publications.shelf.rename'), '');
  if (title === null || title.trim() === '') return;
  try {
    await etn.publications.createShelf(networkId, { title: title.trim() });
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  invalidatePublications();
}

async function renameShelf(shelf: Shelf): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const title = await promptDialog(t('publications.shelf.rename'), t('publications.shelf.rename'), shelf.title);
  if (title === null || title.trim() === '' || title.trim() === shelf.title) return;
  try {
    await etn.publications.updateShelf(networkId, shelf.id, { title: title.trim() });
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  invalidatePublications();
}

async function trashShelf(shelf: Shelf): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const ok = await confirmDialog(t('publications.shelf.trash'), shelf.title, true);
  if (!ok) return;
  try {
    await etn.publications.trashShelf(networkId, shelf.id);
  } catch (err) {
    errorDialog(t('publications.title'), err);
  }
  if (viewState.shelfFilter === shelf.id) viewState = { ...viewState, shelfFilter: null };
  invalidatePublications();
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
