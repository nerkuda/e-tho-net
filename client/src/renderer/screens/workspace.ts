/**
 * Workspace layout (H1, 08-ui-spec.md §1, §16, workplan Q3):
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ [Tab1 *][Tab2][Tab3][+] [▾N]                       [👤 User ▾]   │ ← top row (Q3)
 * ├──────────────────────────────────────────────────────────────────┤
 * │ [🌐 Мыслесеть ▾] [🗺][🌳][📜] [📌 закреплённые мысли…]            │ ← toolbar (виды)
 * ├──────────────────────────────────────────────────────────────────┤
 * │ [Поиск…] [⚙]                                              (карта)│
 * ├─────────┬──────────────────────────────────────────────┬────────┤
 * │ выделен.│                 холст (зоны)                 │ редак. │
 * ├─────────┴──────────────────────────────────────────────┴────────┤
 * │ Статус-бар: индикатор • история • счётчик • масштаб • последнее      │
 * │            событие • индикатор конфликта                              │
 * └──────────────────────────────────────────────────────────────────┘
 * ```
 *
 * The module owns the chrome (toolbar/status bar/containers). Content modules
 * (canvas H4, editor H8, search H13, selection H16, history H7, pinned L18)
 * mount into the exposed hosts; the toolbar/status bar re-render from the
 * shared store. С фазой Q верхняя строка (`top-row`) содержит tab-strip и
 * user-меню; подменю работы с мыслесетью переехало в toolbar видов (Q3-bugfix).
 */

import { div, el, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { svgIcon } from '../lib/icons.js';
import { store, type RtStatus } from '../state.js';
import { wireNetMenu, wireUserMenu, wireViewMenu } from './workspace-menus.js';
import { initLayerOverridesTracking, wireLayerMenu } from './layers.js';
import { mountCanvas } from '../canvas/canvas.js';
import { mountHistoryBar } from './history-bar.js';
import { mountEditor } from '../editor/editor.js';
import { mountEditorResizer } from './editor-resizer.js';
import { mountSelectionResizer } from './selection-resizer.js';
import { hidePanel as hideSearchPanel, mountSearch } from '../search/search.js';
import { mountSelection } from '../selection/selection.js';
import { mountStructures } from './structures/structures.js';
import { mountChronicle } from './chronicle/chronicle.js';
import { setActiveView } from './active-view.js';
import { mountPinnedBar } from './pinned-bar.js';
import { mountPicker } from './tabs/picker.js';
import { mountTabStrip } from './tabs/tabs.js';

/** Hosts exposed to the content modules. */
export interface WorkspaceHandles {
  root: HTMLElement;
  /** Toolbar dropdown for the open network (members/leave/types/settings). */
  netMenuButton: HTMLButtonElement;
  /** Toolbar dropdown for change layers (S11): its label IS the current layer. */
  layerMenuButton: HTMLButtonElement;
  layerMenuLabel: HTMLSpanElement;
  userMenuButton: HTMLButtonElement;
  userMenuLabel: HTMLSpanElement;
  /** Toolbar dropdown for workspace-layout commands (show/hide editor, …). */
  viewMenuButton: HTMLButtonElement;
  /** View switcher segment (L15/L20): map / structures / chronicle. */
  mapViewButton: HTMLButtonElement;
  structuresViewButton: HTMLButtonElement;
  chronicleViewButton: HTMLButtonElement;
  /** Pinned-thoughts panel host in the toolbar (L18). */
  pinnedHost: HTMLElement;
  /** Search row of the map view (L18): input + gear, under the top bar. */
  searchRow: HTMLElement;
  /** Search input (H13, lives in the map-view search row). */
  searchInput: HTMLInputElement;
  searchOptionsButton: HTMLButtonElement;
  /** Drop panel under the search row for search results (H13). */
  searchHost: HTMLElement;
  /** Left selection panel (H16). */
  selectionHost: HTMLElement;
  /** Center canvas (H4–H6). */
  canvasHost: HTMLElement;
  /** Structures view host (L15, 08-ui-spec.md §15). */
  structuresHost: HTMLElement;
  /** Chronicle view host (L20, 08-ui-spec.md §17). */
  chronicleHost: HTMLElement;
  /** Editor container (H8–H12). */
  editorHost: HTMLElement;
  /** Status bar cells. */
  historyHost: HTMLElement;
  countsLabel: HTMLSpanElement;
  eventLabel: HTMLSpanElement;
  conflictHost: HTMLElement;
  /** Re-applies editor position + indicator from the store. */
  refresh(): void;
}

let current: WorkspaceHandles | null = null;

/** Returns the mounted workspace handles (null before the first build). */
export function getWorkspace(): WorkspaceHandles | null {
  return current;
}

/** Status indicator colour class + tooltip per realtime status (§11, L13). */
export function statusGlyph(status: RtStatus): { cls: string; text: string } {
  switch (status) {
    case 'connected':
      return { cls: 'ok', text: 'Подключено' };
    case 'connecting':
      return { cls: 'warn', text: 'Подключение…' };
    case 'reconnecting':
      return { cls: 'warn', text: 'Переподключение…' };
    default:
      return { cls: 'bad', text: 'Нет соединения' };
  }
}

/** Applies `editor_position` (left/right/top/bottom/hidden) to the body. */
function applyEditorPosition(body: HTMLElement, pos: string): void {
  const valid = ['left', 'right', 'top', 'bottom', 'hidden'];
  body.dataset['editorPos'] = valid.includes(pos) ? pos : 'right';
}

/** Builds and mounts the workspace chrome. */
export function buildWorkspace(): HTMLElement {
  const root = div('workspace');

  // --- toolbar ---------------------------------------------------------------
  const toolbar = div('toolbar');

  // Network menu (Q3-bugfix, 08-ui-spec.md §8.1): sits in the toolbar to the
  // left of the view switcher. The label is fixed ("Мыслесеть") — the active
  // tab is the source of truth for the current network's name.
  const netMenuButton = el('button', 'tb-btn', '');
  netMenuButton.type = 'button';
  netMenuButton.append(
    svgIcon('network'),
    span('Мыслесеть', 'tb-label'),
    svgIcon('chevron-down', 12),
  );
  setTooltip(netMenuButton, 'Меню мыслесети');

  // Layer menu (S11, 08-ui-spec.md §8.2): right after «Мыслесеть». The label
  // is the session's current layer title — «Основа» by default — which makes
  // the menu itself the constant «where am I» indicator (§10.3).
  const layerMenuButton = el('button', 'tb-btn', '');
  layerMenuButton.type = 'button';
  const layerMenuLabel = span('Основа', 'tb-label');
  layerMenuButton.append(
    svgIcon('layers'),
    layerMenuLabel,
    svgIcon('chevron-down', 12),
  );
  setTooltip(layerMenuButton, 'Слои изменений');

  // View switcher (L15, 08-ui-spec.md §15.1): immediately after the network
  // menu. The pressed button marks the active view.
  const mapViewButton = el('button', 'tb-btn tb-icon view-btn', '');
  mapViewButton.type = 'button';
  mapViewButton.append(svgIcon('mindmap'));
  setTooltip(mapViewButton, 'Карта мыслей');
  mapViewButton.addEventListener('click', () => setActiveView('map'));

  const structuresViewButton = el('button', 'tb-btn tb-icon view-btn', '');
  structuresViewButton.type = 'button';
  structuresViewButton.append(svgIcon('tree'));
  setTooltip(structuresViewButton, 'Структуры мыслей');
  structuresViewButton.addEventListener('click', () => setActiveView('structures'));

  const chronicleViewButton = el('button', 'tb-btn tb-icon view-btn', '');
  chronicleViewButton.type = 'button';
  chronicleViewButton.append(svgIcon('history'));
  setTooltip(chronicleViewButton, 'Хроника');
  chronicleViewButton.addEventListener('click', () => setActiveView('chronicle'));

  // Pinned-thoughts panel (L18, 08-ui-spec.md §16): right after the view
  // switcher, visible in both views.
  const pinnedHost = div('pinned-bar');

  // The search row belongs to the map view (L18): it sits under the top bar
  // and hides in the structures view, which replaces canvas + search with its
  // own space.
  const searchInput = el('input', 'search-input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск… (Ctrl+F)';
  setTooltip(searchInput, 'Поиск по сети');

  const searchOptionsButton = el('button', 'tb-btn tb-icon', '');
  searchOptionsButton.type = 'button';
  searchOptionsButton.append(svgIcon('settings'));
  setTooltip(searchOptionsButton, 'Опции поиска');

  const searchRow = div('search-row');
  searchRow.append(searchInput, searchOptionsButton);

  const userMenuButton = el('button', 'tb-btn', '');
  userMenuButton.type = 'button';
  const userMenuLabel = span('—', 'tb-label');
  userMenuButton.append(svgIcon('user'), userMenuLabel, svgIcon('chevron-down', 12));
  setTooltip(userMenuButton, 'Меню пользователя');

  // Workspace-layout commands menu (replaces the duplicated status dot — the
  // connection indicator lives in the status bar). First command toggles the
  // editor panel, which is otherwise unreachable once hidden.
  const viewMenuButton = el('button', 'tb-btn tb-icon', '');
  viewMenuButton.type = 'button';
  viewMenuButton.append(svgIcon('menu'));
  setTooltip(viewMenuButton, 'Вид');

  // The pinned panel (L18) stretches across the whole free toolbar width —
  // it is one big drop target between the view switcher and the user menu.
  toolbar.append(
    netMenuButton,
    layerMenuButton,
    mapViewButton,
    structuresViewButton,
    chronicleViewButton,
    pinnedHost,
  );

  // --- top row (Q3) — tab strip + user/view ----------------------------------
  // Mounts the tab strip; user/view menus live here. The network menu used to
  // sit in this row (Q3); it moved into the toolbar (Q3-bugfix).
  const tabStripHost = div('tab-strip-host');
  const topRow = div('top-row');
  const topRight = div('top-right');
  topRight.append(userMenuButton, viewMenuButton);
  topRow.append(tabStripHost, topRight);
  mountTabStrip(tabStripHost);

  // --- search drop panel -----------------------------------------------------
  const searchHost = div('search-panel hidden');

  // --- body -------------------------------------------------------------------
  const body = div('workspace-body');
  const selectionHost = div('selection-panel hidden');
  const canvasHost = div('canvas');
  const structuresHost = div('structures hidden');
  const chronicleHost = div('chronicle hidden');
  const editorHost = div('editor hidden');
  // Draggable splitter between canvas and editor (08-ui-spec.md §6.1). Positioned
  // absolutely on the canvas/editor seam via the --editor-w/--editor-h variables.
  const editorResizer = div('editor-resizer hidden');
  // Draggable splitter between the selection panel and the canvas (08-ui-spec.md
  // §5). Positioned on the panel's right seam via the --selection-w variable.
  const selectionResizer = div('selection-resizer hidden');
  body.append(
    selectionHost,
    canvasHost,
    structuresHost,
    chronicleHost,
    editorHost,
    editorResizer,
    selectionResizer,
  );

  // Q5: full-body placeholder shown when the active tab is inaccessible
  // (08-ui-spec.md §1.1). It subscribes to the store and toggles visibility on
  // every change of `activeTabId`/`inaccessibleTabIds`.
  const placeholderHost = div('workspace-placeholder hidden');
  body.append(placeholderHost);
  mountInaccessiblePlaceholder(placeholderHost);

  // Q-bugfix: the «+» tab opens a network picker overlay that lives inside
  // the workspace body. The top-row (with the tab strip) stays visible
  // above it, so the user can cancel by clicking any other tab.
  const pickerHost = div('workspace-picker hidden');
  body.append(pickerHost);
  mountPicker(pickerHost);

  // --- status bar ------------------------------------------------------------
  const statusbar = div('statusbar');

  const statusLeft = span('', 'status-light');
  const historyHost = div('history-bar');
  const sbSpacer = div('sb-spacer');
  const countsLabel = span('', 'sb-item sb-counts');
  const zoomLabel = span('', 'sb-item sb-zoom');
  const eventLabel = span('', 'sb-item sb-event');
  const conflictHost = div('sb-conflict hidden');
  const conflictText = span('изменено другим пользователем');
  conflictHost.append(svgIcon('alert', 14), conflictText);
  const showConflictButton = el('button', 'link-btn', 'показать');
  showConflictButton.type = 'button';
  conflictHost.append(showConflictButton);

  statusbar.append(
    statusLeft,
    historyHost,
    sbSpacer,
    countsLabel,
    zoomLabel,
    eventLabel,
    conflictHost,
  );

  root.append(topRow, toolbar, searchRow, searchHost, body, statusbar);

  const handles: WorkspaceHandles = {
    root,
    netMenuButton,
    layerMenuButton,
    layerMenuLabel,
    userMenuButton,
    userMenuLabel,
    viewMenuButton,
    mapViewButton,
    structuresViewButton,
    chronicleViewButton,
    pinnedHost,
    searchRow,
    searchInput,
    searchOptionsButton,
    searchHost,
    selectionHost,
    canvasHost,
    structuresHost,
    chronicleHost,
    editorHost,
    historyHost,
    countsLabel,
    eventLabel,
    conflictHost,
    refresh,
  };
  current = handles;

  // Toolbar dropdown menus (H3/H18), canvas (H4), history (H7), editor (H8),
  // search (H13), structures view (L15).
  wireNetMenu(handles);
  wireLayerMenu(handles);
  // Live override marking (08-ui-spec.md §2.2): the canvas badge appears the
  // moment a layer write happens, not on the next layer/tab switch.
  initLayerOverridesTracking();
  wireUserMenu(handles);
  wireViewMenu(handles);
  mountCanvas(canvasHost);
  mountHistoryBar(historyHost);
  mountPinnedBar(pinnedHost);
  mountEditor(editorHost);
  mountEditorResizer(editorResizer, body);
  mountSelectionResizer(selectionResizer, body);
  mountSearch({ input: searchInput, optionsButton: searchOptionsButton, host: searchHost });
  mountSelection(selectionHost);
  mountStructures(structuresHost);
  mountChronicle(chronicleHost);

  /** Re-renders store-driven chrome (labels, indicator, editor position). */
  let lastMapActive = true;
  function refresh(): void {
    const st = store.state;
    const user = st.me?.display_name ?? st.me?.username ?? '—';
    userMenuLabel.textContent = user;
    // The layer menu label is the current layer indicator (S11, §10.3).
    layerMenuLabel.textContent = st.currentLayer?.title ?? 'Основа';
    const glyph = statusGlyph(st.rtStatus);
    statusLeft.className = `status-light ${glyph.cls}`;
    setTooltip(statusLeft, glyph.text);
    applyEditorPosition(body, st.editorPosition);
    const editorHidden = st.editorPosition === 'hidden';
    editorHost.classList.toggle('hidden', editorHidden);
    editorResizer.classList.toggle('hidden', editorHidden);
    body.style.setProperty('--editor-w', `${st.editorW}px`);
    body.style.setProperty('--editor-h', `${st.editorH}px`);
    body.style.setProperty('--selection-w', `${st.selectionW}px`);
    // The selection panel (and its resizer) are visible only while the list is
    // non-empty (mountSelection toggles the panel's own hidden class).
    selectionResizer.classList.toggle('hidden', st.selection.length === 0);
    zoomLabel.replaceChildren(svgIcon('search', 12), span(` ${Math.round(st.canvasZoom * 100)}%`));
    eventLabel.textContent = st.lastEvent ?? '';

    // View switcher (L15/L18/L20): the structures and chronicle views replace
    // the canvas and the search row (which belongs to the map); editor,
    // resizer, status bar, selection panel and the pinned panel are shared.
    const mapActive = st.activeView === 'map';
    const structuresActive = st.activeView === 'structures';
    mapViewButton.classList.toggle('active', mapActive);
    structuresViewButton.classList.toggle('active', structuresActive);
    chronicleViewButton.classList.toggle('active', st.activeView === 'chronicle');
    canvasHost.classList.toggle('hidden', !mapActive);
    structuresHost.classList.toggle('hidden', !structuresActive);
    chronicleHost.classList.toggle('hidden', st.activeView !== 'chronicle');
    searchRow.classList.toggle('hidden', !mapActive);
    // Leaving the map view closes the open search dropdown (it anchors to the
    // now hidden search row); returning leaves it closed.
    if (!mapActive && lastMapActive) hideSearchPanel();
    lastMapActive = mapActive;
  }

  store.subscribe(() => {
    if (root.isConnected) refresh();
  });
  refresh();
  return root;
}

/**
 * Renders the «Нет доступа к сети» placeholder inside `host`. Toggles visibility
 * whenever the active tab becomes inaccessible (Q5, 08-ui-spec.md §1.1).
 */
function mountInaccessiblePlaceholder(host: HTMLElement): void {
  const closeBtn = el('button', 'btn primary', 'Закрыть таб') as HTMLButtonElement;
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => {
    const id = store.state.activeTabId;
    if (id === null) return;
    void etn.tabs.close(id).catch(() => undefined);
    // tabs.ts subscribes to the store and removes the tab locally.
  });
  const text = document.createElement('div');
  text.className = 'placeholder-text';
  text.textContent = 'Нет доступа к сети';
  const hint = document.createElement('div');
  hint.className = 'placeholder-hint';
  hint.textContent =
    'Сеть, открытая в этом табе, больше не доступна (вы исключены из участников или сеть удалена).';
  host.append(text, hint, closeBtn);

  const update = (): void => {
    const id = store.state.activeTabId;
    const inaccessible =
      id !== null && store.state.inaccessibleTabIds.has(id);
    host.classList.toggle('hidden', !inaccessible);
    if (inaccessible) {
      const tab = store.state.tabs.find((t) => t.tab_id === id);
      text.textContent =
        tab !== undefined
          ? `Нет доступа к сети ${shortNetworkId(tab.network_id)}`
          : 'Нет доступа к сети';
    }
  };

  store.subscribe(update);
  update();
}

/** Best-effort display label for a network id; falls back to a short id. */
function shortNetworkId(networkId: string): string {
  const found = store.state.networkList.find((n) => n.id === networkId);
  if (found !== undefined) return found.display_name;
  return networkId.length <= 8 ? networkId : `${networkId.slice(0, 8)}…`;
}
