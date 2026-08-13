/**
 * Workspace layout (H1, 08-ui-spec.md §1):
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ [Меню сети] [Поиск…] [⚙]              [👤 Пользователь] [Статус] │ ← toolbar
 * ├─────────┬──────────────────────────────────────────────┬────────┤
 * │ выделен.│                 холст (зоны)                 │ редак. │
 * ├─────────┴──────────────────────────────────────────────┴────────┤
 * │ Статус-бар: индикатор • сеть • фокус • история • последнее событ. │
 * └──────────────────────────────────────────────────────────────────┘
 * ```
 *
 * The module owns the chrome (toolbar/status bar/containers). Content modules
 * (canvas H4, editor H8, search H13, selection H16, history H7) mount into the
 * exposed hosts; the toolbar/status bar re-render from the shared store.
 */

import { div, el, setTooltip, span } from '../lib/dom.js';
import { store, type RtStatus } from '../state.js';

/** Hosts exposed to the content modules. */
export interface WorkspaceHandles {
  root: HTMLElement;
  /** Toolbar labels/buttons refreshed from the store. */
  netMenuLabel: HTMLSpanElement;
  userMenuLabel: HTMLSpanElement;
  statusDot: HTMLSpanElement;
  /** Search input in the toolbar (H13). */
  searchInput: HTMLInputElement;
  searchOptionsButton: HTMLButtonElement;
  /** Drop panel under the toolbar for search results (H13). */
  searchHost: HTMLElement;
  /** Left selection panel (H16). */
  selectionHost: HTMLElement;
  /** Center canvas (H4–H6). */
  canvasHost: HTMLElement;
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

/** Status indicator glyph + tooltip per realtime status (08-ui-spec.md §11). */
export function statusGlyph(status: RtStatus): { glyph: string; text: string } {
  switch (status) {
    case 'connected':
      return { glyph: '🟢', text: 'Подключено' };
    case 'connecting':
      return { glyph: '🟡', text: 'Подключение…' };
    case 'reconnecting':
      return { glyph: '🟡', text: 'Переподключение…' };
    default:
      return { glyph: '🔴', text: 'Нет соединения' };
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
  const netMenuLabel = span('📂 —', 'tb-label');
  netMenuButton.append(netMenuLabel, span('▾', 'tb-caret'));
  setTooltip(netMenuButton, 'Меню сети');

  const searchInput = el('input', 'search-input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск… (Ctrl+F)';
  setTooltip(searchInput, 'Поиск по сети');

  const searchOptionsButton = el('button', 'tb-btn tb-icon', '⚙');
  searchOptionsButton.type = 'button';
  setTooltip(searchOptionsButton, 'Опции поиска');

  const spacer = div('toolbar-spacer');

  const userMenuButton = el('button', 'tb-btn', '');
  userMenuButton.type = 'button';
  const userMenuLabel = span('👤 —', 'tb-label');
  userMenuButton.append(userMenuLabel, span('▾', 'tb-caret'));
  setTooltip(userMenuButton, 'Меню пользователя');

  const statusDot = span('⚪', 'status-dot');
  setTooltip(statusDot, 'Состояние соединения');

  toolbar.append(
    netMenuButton,
    searchInput,
    searchOptionsButton,
    spacer,
    userMenuButton,
    statusDot,
  );

  // --- search drop panel -----------------------------------------------------
  const searchHost = div('search-panel hidden');

  // --- body -------------------------------------------------------------------
  const body = div('workspace-body');
  const selectionHost = div('selection-panel hidden');
  const canvasHost = div('canvas');
  const editorHost = div('editor hidden');
  body.append(selectionHost, canvasHost, editorHost);

  // --- status bar ------------------------------------------------------------
  const statusbar = div('statusbar');

  const statusLeft = span(statusGlyph(store.state.rtStatus).glyph, 'status-dot');
  const historyHost = div('history-bar');
  const focusLabel = span('—', 'sb-item sb-focus');
  const sbSpacer = div('sb-spacer');
  const countsLabel = span('', 'sb-item sb-counts');
  const eventLabel = span('', 'sb-item sb-event');
  const conflictHost = div('sb-conflict hidden');
  conflictHost.append(span('⚠ изменено другим пользователем'));
  const showConflictButton = el('button', 'link-btn', 'показать');
  showConflictButton.type = 'button';
  conflictHost.append(showConflictButton);

  statusbar.append(
    statusLeft,
    historyHost,
    focusLabel,
    sbSpacer,
    countsLabel,
    eventLabel,
    conflictHost,
  );

  root.append(toolbar, searchHost, body, statusbar);

  const handles: WorkspaceHandles = {
    root,
    netMenuLabel,
    userMenuLabel,
    statusDot,
    searchInput,
    searchOptionsButton,
    searchHost,
    selectionHost,
    canvasHost,
    editorHost,
    historyHost,
    focusLabel,
    countsLabel,
    eventLabel,
    conflictHost,
    refresh,
  };
  current = handles;

  /** Re-renders store-driven chrome (labels, indicator, editor position). */
  function refresh(): void {
    const st = store.state;
    netMenuLabel.textContent = `📂 ${st.network?.display_name ?? '—'}`;
    const user = st.me?.display_name ?? st.me?.username ?? '—';
    userMenuLabel.textContent = `👤 ${user}`;
    const glyph = statusGlyph(st.rtStatus);
    statusDot.textContent = glyph.glyph;
    setTooltip(statusDot, glyph.text);
    statusLeft.textContent = glyph.glyph;
    applyEditorPosition(body, st.editorPosition);
    focusLabel.textContent = st.focus?.focused.title ?? '—';
    setTooltip(focusLabel, st.focus?.focused.title ?? '');
    eventLabel.textContent = st.lastEvent ?? '';
  }

  store.subscribe(() => {
    if (root.isConnected) refresh();
  });
  refresh();
  return root;
}
