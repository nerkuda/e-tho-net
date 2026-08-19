/**
 * Workspace layout (H1, 08-ui-spec.md §1, §16):
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ [Меню сети] [🗺][🌳] [📌 закреплённые мысли (вся свободная ширина)] [👤][☰] │
 * ├──────────────────────────────────────────────────────────────────┤
 * │ [Поиск…] [⚙]                                              (карта)│
 * ├─────────┬──────────────────────────────────────────────┬────────┤
 * │ выделен.│                 холст (зоны)                 │ редак. │
 * ├─────────┴──────────────────────────────────────────────┴────────┤
 * │ Статус-бар: индикатор • сеть • фокус • история • последнее событ. │
 * └──────────────────────────────────────────────────────────────────┘
 * ```
 *
 * The module owns the chrome (toolbar/status bar/containers). Content modules
 * (canvas H4, editor H8, search H13, selection H16, history H7, pinned L18)
 * mount into the exposed hosts; the toolbar/status bar re-render from the
 * shared store.
 */

import { div, el, setTooltip, span } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { store, type RtStatus } from '../state.js';
import { wireNetMenu, wireUserMenu, wireViewMenu } from './workspace-menus.js';
import { mountCanvas } from '../canvas/canvas.js';
import { mountHistoryBar } from './history-bar.js';
import { mountEditor } from '../editor/editor.js';
import { mountEditorResizer } from './editor-resizer.js';
import { mountSelectionResizer } from './selection-resizer.js';
import { hidePanel as hideSearchPanel, mountSearch } from '../search/search.js';
import { mountSelection } from '../selection/selection.js';
import { mountStructures, setActiveView } from './structures/structures.js';
import { mountPinnedBar } from './pinned-bar.js';

/** Hosts exposed to the content modules. */
export interface WorkspaceHandles {
  root: HTMLElement;
  /** Toolbar buttons/labels refreshed from the store. */
  netMenuButton: HTMLButtonElement;
  netMenuLabel: HTMLSpanElement;
  userMenuButton: HTMLButtonElement;
  userMenuLabel: HTMLSpanElement;
  /** Toolbar dropdown for workspace-layout commands (show/hide editor, …). */
  viewMenuButton: HTMLButtonElement;
  /** View switcher segment (L15): map / structures. */
  mapViewButton: HTMLButtonElement;
  structuresViewButton: HTMLButtonElement;
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
  /** Editor container (H8–H12). */
  editorHost: HTMLElement;
  /** Status bar cells. */
  historyHost: HTMLElement;
  focusLabel: HTMLSpanElement;
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

  const netMenuButton = el('button', 'tb-btn', '');
  netMenuButton.type = 'button';
  const netMenuLabel = span('—', 'tb-label');
  netMenuButton.append(svgIcon('network'), netMenuLabel, svgIcon('chevron-down', 12));
  setTooltip(netMenuButton, 'Меню сети');

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
    mapViewButton,
    structuresViewButton,
    pinnedHost,
    userMenuButton,
    viewMenuButton,
  );

  // --- search drop panel -----------------------------------------------------
  const searchHost = div('search-panel hidden');

  // --- body -------------------------------------------------------------------
  const body = div('workspace-body');
  const selectionHost = div('selection-panel hidden');
  const canvasHost = div('canvas');
  const structuresHost = div('structures hidden');
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
    editorHost,
    editorResizer,
    selectionResizer,
  );

  // --- status bar ------------------------------------------------------------
  const statusbar = div('statusbar');

  const statusLeft = span('', 'status-light');
  const historyHost = div('history-bar');
  const focusLabel = span('—', 'sb-item sb-focus');
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
    focusLabel,
    sbSpacer,
    countsLabel,
    zoomLabel,
    eventLabel,
    conflictHost,
  );

  root.append(toolbar, searchRow, searchHost, body, statusbar);

  const handles: WorkspaceHandles = {
    root,
    netMenuButton,
    netMenuLabel,
    userMenuButton,
    userMenuLabel,
    viewMenuButton,
    mapViewButton,
    structuresViewButton,
    pinnedHost,
    searchRow,
    searchInput,
    searchOptionsButton,
    searchHost,
    selectionHost,
    canvasHost,
    structuresHost,
    editorHost,
    historyHost,
    focusLabel,
    countsLabel,
    eventLabel,
    conflictHost,
    refresh,
  };
  current = handles;

  // Toolbar dropdown menus (H3/H18), canvas (H4), history (H7), editor (H8),
  // search (H13), structures view (L15).
  wireNetMenu(handles);
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

  /** Re-renders store-driven chrome (labels, indicator, editor position). */
  let lastStructuresActive = false;
  function refresh(): void {
    const st = store.state;
    netMenuLabel.textContent = st.network?.display_name ?? '—';
    const user = st.me?.display_name ?? st.me?.username ?? '—';
    userMenuLabel.textContent = user;
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
    focusLabel.textContent = st.focus?.focused.title ?? '—';
    setTooltip(focusLabel, st.focus?.focused.title ?? '');
    zoomLabel.replaceChildren(svgIcon('search', 12), span(` ${Math.round(st.canvasZoom * 100)}%`));
    eventLabel.textContent = st.lastEvent ?? '';

    // View switcher (L15/L18): the structures view replaces the canvas and the
    // search row (which belongs to the map); editor, resizer, status bar,
    // selection panel and the pinned panel are shared.
    const structuresActive = st.activeView === 'structures';
    mapViewButton.classList.toggle('active', !structuresActive);
    structuresViewButton.classList.toggle('active', structuresActive);
    canvasHost.classList.toggle('hidden', structuresActive);
    structuresHost.classList.toggle('hidden', !structuresActive);
    searchRow.classList.toggle('hidden', structuresActive);
    // Leaving the map view closes the open search dropdown (it anchors to the
    // now hidden search row); returning leaves it closed.
    if (structuresActive && !lastStructuresActive) hideSearchPanel();
    lastStructuresActive = structuresActive;
  }

  store.subscribe(() => {
    if (root.isConnected) refresh();
  });
  refresh();
  return root;
}
