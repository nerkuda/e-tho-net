/**
 * Workspace layout (H1, 08-ui-spec.md §1, §16, workplan Q3):
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ [Tab1 *][Tab2][Tab3][+] [▾N]                       [👤 User ▾]   │ ← top row (Q3)
 * ├──────────────────────────────────────────────────────────────────┤
 * │ [🗺][🌳][📜][🕓] [▾ Слой] [📌 закреплённые…]        [🌐 Мыслесеть] │ ← toolbar (виды)
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
import { t } from '../lib/i18n.js';
import { etn } from '../lib/etn.js';
import { svgIcon } from '../lib/icons.js';
import { store, type RtStatus } from '../state.js';
import { wireNetMenu, wireUserMenu } from './workspace-menus.js';
import { initLayerOverridesTracking, wireLayerMenu } from './layers.js';
import { mountCanvas } from '../canvas/canvas.js';
import { mountHistoryBar } from './history-bar.js';
import { mountEditor } from '../editor/editor.js';
import { mountEditorResizer } from './editor-resizer.js';
import { mountEventAreaResizer } from './event-area-resizer.js';
import { mountSelectionResizer } from './selection-resizer.js';
import {
  clampEventAreaW,
  LAYER_MENU_LABEL_FALLBACK,
  layerMenuTooltip,
  truncateLayerMenuLabel,
} from '../lib/pure.js';
import { hidePanel as hideSearchPanel, mountSearch } from '../search/search.js';
import { mountSelection } from '../selection/selection.js';
import { mountStructures } from './structures/structures.js';
import { mountChronicle } from './chronicle/chronicle.js';
import { mountActivity } from './activity/activity.js';
import { mountPublications } from './publications/publications.js';
import { setActiveView } from './active-view.js';
import { mountPinnedBar } from './pinned-bar.js';
import { mountPicker } from './tabs/picker.js';
import { mountTabStrip } from './tabs/tabs.js';
import { iconButton, setButtonActive, uiButton } from '../lib/ui/button.js';
import { splitterElement } from '../lib/ui/splitter.js';
import { fieldInput } from '../lib/ui/field.js';
import { logUiEvent } from '../lib/ui-log.js';

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
  /** View switcher segment (L15/L20, задача f27809d0): map / structures / chronicle / activity. */
  mapViewButton: HTMLButtonElement;
  structuresViewButton: HTMLButtonElement;
  chronicleViewButton: HTMLButtonElement;
  activityViewButton: HTMLButtonElement;
  /** View switcher button of the «Публикации» view (0.11.1). */
  publicationsViewButton: HTMLButtonElement;
  /** Pinned-thoughts panel host in the toolbar (L18). */
  pinnedHost: HTMLElement;
  /** Search row of the map view (L18): the search input, under the top bar. */
  searchRow: HTMLElement;
  /** Search input (H13, lives in the map-view search row). */
  searchInput: HTMLInputElement;
  /** Drop panel under the search row: search results + settings zone (H13). */
  searchHost: HTMLElement;
  /** Left selection panel (H16). */
  selectionHost: HTMLElement;
  /** Center canvas (H4–H6). */
  canvasHost: HTMLElement;
  /** Structures view host (L15, 08-ui-spec.md §15). */
  structuresHost: HTMLElement;
  /** Chronicle view host (L20, 08-ui-spec.md §17). */
  chronicleHost: HTMLElement;
  /** Activity-feed view host (задача f27809d0 «События», элемент UI 8cd9ad55). */
  activityHost: HTMLElement;
  /** Публикации view host (0.11.1, элемент интерфейса 1eecd988). */
  publicationsHost: HTMLElement;
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

/**
 * Teardown-хендлы модулей, смонтированных `buildWorkspace`. Каждый `mountX`
 * возвращает функцию снятия своих глобальных подписок/наблюдателей; их
 * обязательно вызывать перед пересборкой рабочего пространства, иначе живые
 * подписки накапливаются между монтированиями и каждое событие стора
 * обрабатывается N раз (ошибка 37b713de).
 */
const teardowns: Array<() => void> = [];

/** Регистрирует teardown модуля, смонтированного `buildWorkspace`. */
export function onWorkspaceTeardown(fn: () => void): void {
  teardowns.push(fn);
}

/**
 * Снимает смонтированное рабочее пространство: вызывает все зарегистрированные
 * teardown-хендлы и сбрасывает модульные ссылки. Зовётся `showScreen` ПЕРЕД
 * `clear(root)` — модули обязаны отпустить свои подписки/наблюдатели до того,
 * как их DOM будет уничтожен. Идемпотентна: повторный вызов ничего не делает.
 */
export function teardownWorkspace(): void {
  for (const fn of teardowns.splice(0)) {
    try {
      fn();
    } catch (err) {
      // Teardown is best-effort: one failing handle must not block the rest.
      // The failure itself is diagnostic — surface it in the client journal
      // (fire-and-forget, `ui.workspace.teardown_failed`; 08-ui-spec.md §9.7).
      logUiEvent('ui.workspace.teardown_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  current = null;
}

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

  // Network menu (Q3-bugfix, 08-ui-spec.md §8.1; задача a0cdd731): прижато к
  // ПРАВОМУ краю строки меню мыслесети (полоса закреплённых мыслей растягивается
  // и оттесняет его вправо). Метка фиксирована («Мыслесеть») — имя открытой
  // мыслесети показывает активная вкладка.
  const netMenuButton = uiButton({ role: 'ghost', title: 'Меню мыслесети' });
  netMenuButton.append(
    svgIcon('network'),
    span('Мыслесеть', 'tb-label'),
    svgIcon('chevron-down', 12),
  );

  // Layer menu (S11, 08-ui-spec.md §8.2; задача a0cdd731): идёт сразу после
  // закладок экранов, сам состав меню не меняется. Метка — заголовок текущего
  // слоя сессии («Основа» по умолчанию), поэтому меню само служит постоянным
  // индикатором «где я» (§10.3). Метка обрезается до 32 кодпоинтов, а полное
  // имя слоя несёт тултип кнопки (задача 4388305f): refresh() ниже выставляет
  // и то, и другое.
  const layerMenuButton = uiButton({ role: 'ghost', title: LAYER_MENU_LABEL_FALLBACK });
  const layerMenuLabel = span(LAYER_MENU_LABEL_FALLBACK, 'tb-label');
  layerMenuButton.append(
    svgIcon('layers'),
    layerMenuLabel,
    svgIcon('chevron-down', 12),
  );

  // View switcher (L15, 08-ui-spec.md §15.1; задача a0cdd731): ПЕРВАЯ группа
  // строки меню мыслесети — закладки-ярлыки экранов. Класс `view-tab` даёт
  // «блокнотную» рамку закладок, относительные размеры и разделители
  // (styles/layout.css): скруглены только верхние углы, активная подсвечена
  // рамкой цвета выделения и сливается с экраном ниже. Закладки стоят вплотную
  // (общий `.view-switch` без gap), чтобы вертикальные границы были между ними,
  // а не в воздухе.
  const mapViewButton = iconButton({
    icon: svgIcon('mindmap'),
    title: 'Карта мыслей',
    role: 'ghost',
    class: 'view-tab',
    onClick: () => setActiveView('map'),
  });

  const structuresViewButton = iconButton({
    icon: svgIcon('tree'),
    title: 'Структуры мыслей',
    role: 'ghost',
    class: 'view-tab',
    onClick: () => setActiveView('structures'),
  });

  const chronicleViewButton = iconButton({
    icon: svgIcon('calendar-month'),
    title: 'Дневник',
    role: 'ghost',
    class: 'view-tab',
    onClick: () => setActiveView('chronicle'),
  });

  // Activity-feed view button (задача f27809d0 «События»): fourth view
  // showing the network's `activity_log` (lenta from `GET /activity`).
  const activityViewButton = iconButton({
    icon: svgIcon('activity'),
    title: 'События',
    role: 'ghost',
    class: 'view-tab',
    onClick: () => setActiveView('activity'),
  });

  // Publications view button (0.11.1): library of publications. Иконка — не
  // «слои» (дублировала меню слоёв, ошибка af076f53): «раскрытая книга»
  // (`value-publication`, lucide book-open) — тот же смысл «публикации/документ».
  const publicationsViewButton = iconButton({
    icon: svgIcon('value-publication'),
    title: 'Публикации',
    role: 'ghost',
    class: 'view-tab',
    onClick: () => setActiveView('publications'),
  });

  // Порядок закладок экранов (ошибка af076f53): «Публикации» — между
  // «Дневником» и «Действиями» (Событиями), а не последней.
  const viewSwitch = div('view-switch');
  viewSwitch.append(mapViewButton, structuresViewButton, chronicleViewButton, publicationsViewButton, activityViewButton);

  // Pinned-thoughts panel (L18, 08-ui-spec.md §16): right after the view
  // switcher, visible in both views.
  const pinnedHost = div('pinned-bar');

  // The search row belongs to the map view (L18): it sits under the top bar
  // and hides in the structures view, which replaces canvas + search with its
  // own space.
  const searchInput = fieldInput({ extraClass: 'search-input', bare: true });
  searchInput.placeholder = t('actions.searchShortcut', 'Ctrl+F');
  setTooltip(searchInput, 'Поиск по сети');

  // The drop-panel settings gear used to sit here (задача a3247f84, 0.8.2);
  // it moved into the panel as the funnel toggle in its top corner.
  const searchRow = div('search-row');
  searchRow.append(searchInput);

  const userMenuButton = uiButton({ role: 'ghost', title: 'Меню пользователя' });
  const userMenuLabel = span('—', 'tb-label');
  userMenuButton.append(svgIcon('user'), userMenuLabel, svgIcon('chevron-down', 12));

  // Строка меню мыслесети (задача a0cdd731), слева направо: закладки экранов,
  // меню слоя, полоса закреплённых мыслей, меню «Мыслесеть» (прижато вправо —
  // полоса закреплённых растягивается и оттесняет его). Меню «бутерброд» (☰)
  // упразднено: показ/скрытие редактора переехало в меню «Мыслесеть».
  toolbar.append(
    viewSwitch,
    layerMenuButton,
    pinnedHost,
    netMenuButton,
  );

  // --- top row (Q3) — tab strip + user menu ----------------------------------
  // Mounts the tab strip; the user menu lives here. The network menu used to
  // sit in this row (Q3); it moved into the toolbar (Q3-bugfix). The «Вид»
  // (☰) menu was removed in задача a0cdd731 — its commands moved to the
  // «Мыслесеть»/user menus.
  const tabStripHost = div('tab-strip-host');
  const topRow = div('top-row');
  const topRight = div('top-right');
  topRight.append(userMenuButton);
  topRow.append(tabStripHost, topRight);
  onWorkspaceTeardown(mountTabStrip(tabStripHost));

  // --- search drop panel -----------------------------------------------------
  const searchHost = div('search-panel hidden');

  // --- body -------------------------------------------------------------------
  const body = div('workspace-body');
  const selectionHost = div('selection-panel hidden');
  // Every view hangs its content host off the body next to the editor. The
  // shared `view-host` marker is the single anchor the dock-order rules
  // (`styles/layout.css`) key on — the editor position is a global setting and
  // must move the content the same way on the map, structures, chronicle and
  // activity views (ошибка 477fd133). A new view host MUST carry the marker,
  // otherwise the editor's dock order silently stops applying to it.
  const canvasHost = div('canvas view-host');
  const structuresHost = div('structures hidden view-host');
  const chronicleHost = div('chronicle hidden view-host');
  const activityHost = div('activity hidden view-host');
  const publicationsHost = div('publications-host hidden view-host');
  const editorHost = div('editor hidden');
  // Draggable splitter between canvas and editor (08-ui-spec.md §6.1). Positioned
  // absolutely on the canvas/editor seam via the --editor-w/--editor-h variables.
  // The element comes from the shared `lib/ui/splitter` component (задача
  // 50f57b82); its drag is wired in `editor-resizer.ts`.
  const editorResizer = splitterElement('editor-resizer hidden');
  // Draggable splitter between the selection panel and the canvas (08-ui-spec.md
  // §5). Positioned on the panel's right seam via the --selection-w variable.
  const selectionResizer = splitterElement('selection-resizer hidden');
  body.append(
    selectionHost,
    canvasHost,
    structuresHost,
    chronicleHost,
    activityHost,
    publicationsHost,
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
  onWorkspaceTeardown(mountPicker(pickerHost));

  // --- status bar ------------------------------------------------------------
  const statusbar = div('statusbar');

  const statusLeft = span('', 'status-light');
  // Zoom indicator (08-ui-spec §11): sits to the LEFT of the history strip,
  // immediately after the connection dot — the old position next to the
  // event area invited the layout to repaint the history chips every time
  // the event text appeared (bug de07e690-…: «Дергание нижней строки
  // клиента»).
  const zoomLabel = span('', 'sb-item sb-zoom');
  const historyHost = div('history-bar');
  // Drag-resize splitter on the seam between the history strip and the
  // right-most status-bar region. Dragging it changes the event-area width
  // (counts + last realtime event text) by writing `--event-area-w` on the
  // status bar. Cursor is set by `.event-area-resizer` so the affordance is
  // visible without JS on every render.
  const eventAreaResizer = splitterElement('event-area-resizer');
  setTooltip(eventAreaResizer, 'Изменить ширину области событий');
  // Fixed-width region of the status bar. The history strip and the
  // status-light live OUTSIDE this container so they no longer repaint when
  // a realtime event arrives and the event text reflows.
  const eventArea = div('event-area');
  const countsLabel = span('', 'sb-item sb-counts');
  const eventLabel = span('', 'sb-item sb-event');
  eventArea.append(countsLabel, eventLabel);
  const conflictHost = div('sb-conflict hidden');
  const conflictText = span('изменено другим пользователем');
  conflictHost.append(svgIcon('alert', 14), conflictText);
  const showConflictButton = el('button', 'link-btn', 'показать');
  showConflictButton.type = 'button';
  conflictHost.append(showConflictButton);

  statusbar.append(
    statusLeft,
    zoomLabel,
    historyHost,
    eventAreaResizer,
    eventArea,
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
    mapViewButton,
    structuresViewButton,
    chronicleViewButton,
    activityViewButton,
    publicationsViewButton,
    pinnedHost,
    searchRow,
    searchInput,
    searchHost,
    selectionHost,
    canvasHost,
    structuresHost,
    chronicleHost,
    activityHost,
    publicationsHost,
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
  onWorkspaceTeardown(mountCanvas(canvasHost));
  onWorkspaceTeardown(mountHistoryBar(historyHost));
  onWorkspaceTeardown(mountPinnedBar(pinnedHost));
  mountEditor(editorHost);
  mountEditorResizer(editorResizer, body);
  mountSelectionResizer(selectionResizer, body);
  mountEventAreaResizer(eventAreaResizer, statusbar);
  onWorkspaceTeardown(mountSearch({ input: searchInput, host: searchHost }));
  onWorkspaceTeardown(mountSelection(selectionHost));
  onWorkspaceTeardown(mountStructures(structuresHost));
  onWorkspaceTeardown(mountChronicle(chronicleHost));
  onWorkspaceTeardown(mountActivity(activityHost));
  onWorkspaceTeardown(mountPublications(publicationsHost));

  /** Re-renders store-driven chrome (labels, indicator, editor position). */
  let lastMapActive = true;
  function refresh(): void {
    const st = store.state;
    const user = st.me?.display_name ?? st.me?.username ?? '—';
    userMenuLabel.textContent = user;
    // The layer menu label is the current layer indicator (S11, §10.3): capped
    // to 32 code points (задача 4388305f), while the button's tooltip always
    // carries the full layer name (even when the label is not truncated).
    layerMenuLabel.textContent = truncateLayerMenuLabel(st.currentLayer?.title);
    setTooltip(layerMenuButton, layerMenuTooltip(st.currentLayer?.title));
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
    // Event-area width is a CSS variable so the layout does not reflow the
    // history strip on every text change — only the right-most region grows
    // or shrinks. `clampEventAreaW` re-applies the window-relative upper
    // bound so a resize that shrank the window narrows the area too.
    const clampedEventW = clampEventAreaW(st.eventAreaW, statusbar.clientWidth);
    statusbar.style.setProperty('--event-area-w', `${clampedEventW}px`);
    eventLabel.textContent = st.lastEvent ?? '';

    // View switcher (L15/L18/L20, задача f27809d0): the structures/chronicle/
    // activity views replace the canvas and the search row (which belongs to
    // the map); editor, resizer, status bar, selection panel and the pinned
    // panel are shared.
    const mapActive = st.activeView === 'map';
    const structuresActive = st.activeView === 'structures';
    const chronicleActive = st.activeView === 'chronicle';
    const activityActive = st.activeView === 'activity';
    const publicationsActive = st.activeView === 'publications';
    setButtonActive(mapViewButton, mapActive);
    setButtonActive(structuresViewButton, structuresActive);
    setButtonActive(chronicleViewButton, chronicleActive);
    setButtonActive(activityViewButton, activityActive);
    setButtonActive(publicationsViewButton, publicationsActive);
    canvasHost.classList.toggle('hidden', !mapActive);
    structuresHost.classList.toggle('hidden', !structuresActive);
    chronicleHost.classList.toggle('hidden', !chronicleActive);
    activityHost.classList.toggle('hidden', !activityActive);
    publicationsHost.classList.toggle('hidden', !publicationsActive);
    searchRow.classList.toggle('hidden', !mapActive);
    // Leaving the map view closes the open search dropdown (it anchors to the
    // now hidden search row); returning leaves it closed.
    if (!mapActive && lastMapActive) hideSearchPanel();
    lastMapActive = mapActive;
  }

  onWorkspaceTeardown(
    store.subscribe(() => {
      if (root.isConnected) refresh();
    }),
  );
  refresh();
  return root;
}

/**
 * Renders the «Нет доступа к сети» placeholder inside `host`. Toggles visibility
 * whenever the active tab becomes inaccessible (Q5, 08-ui-spec.md §1.1).
 */
function mountInaccessiblePlaceholder(host: HTMLElement): void {
  const closeBtn = uiButton({ label: 'Закрыть таб', role: 'primary' });
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
