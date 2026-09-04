/**
 * Canvas engine (H4/H5): virtualized grid zones, thought clouds, the focus
 * cloud, ellipses and drag gestures (08-ui-spec.md §2.1–2.3, 09-scenarios.md
 * B1/C4).
 *
 * - Four areas: parents (top-left), siblings (top-right), focus row (center),
 *   children (bottom, full width). Grid zones are virtualized (visible window +
 *   overscan inside a CSS grid over a full-height spacer, §2.1.1, §2.5).
 * - A cloud is: icon square + clamped title (1–3 lines, `…`, full text in the
 *   tooltip) + indicators row (📝/📅/📎) + top/bottom ellipses (§2.2).
 * - The focus cloud has a variable width and up to 3 title lines (§2.2.2).
 * - Cloud colors/styles come from the thought (own values win) falling back to
 *   the thought type catalogue; inactive thoughts are dimmed (§2.2).
 * - Single click on a thought cloud opens it in the editor and lights its halo
 *   (§2.2.4); double click focuses it (B1). Keyboard navigation over the map —
 *   arrows/Home/End cursor frame, Enter/Ctrl+Enter, Ctrl+Shift+Up/Down manual
 *   reorder (§2.9, kbd-nav.ts). Dragging from an ellipse: dropped on
 *   another thought → direct link (C4); otherwise → add-thought dialog (H14
 *   registers the opener via {@link setAddDialogOpener}).
 * - Indicator counts load lazily per visible cloud and are cached; realtime
 *   comment/attachment events invalidate the cache.
 */

import { THOUGHT_RESOLVE_MAX_IDS } from '@etn/shared';
import type { FocusEdge, FocusNeighbor, FocusResponse, IconKind, ThoughtRef } from '@etn/shared';

import { scheduleRefresh, setFocus } from '../app.js';
import { openThoughtInEditor } from '../editor/editor.js';
import { clear, div, el, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { logUiEvent } from '../lib/ui-log.js';
import {
  closeHoverPreview,
  markAttachmentsPreview,
  markChronoPreview,
  markCommentPreview,
  markNeighborsPreview,
  markThoughtCommentPreview,
  registerHoverPreviewResolver,
  type HoverPreviewContent,
} from '../lib/hover-preview.js';
import { svgIcon } from '../lib/icons.js';
import { notice } from '../lib/notice.js';
import { resolveThoughtTypeVisual } from '../lib/type-tree.js';
import {
  CLOUD_TITLE_LINES_MIN,
  cloudGeom,
  cloudHeight,
  contrastText,
  neighborsDirForEllipse,
  neighborsPreviewBounds,
  neighborsPreviewHeading,
  shortenCompoundName,
  sortRefsByTitle,
} from '../lib/pure.js';
import { store } from '../state.js';
import {
  initLinksOverlay,
  drawLinksNow,
  invalidateLinkCounts,
  setEllipseHover,
  setDragLinkLine,
  LINK_LABEL_FONT_BASE,
} from './links.js';
import { captureClouds, playFocusTransition, prefersReducedMotion } from './transition.js';
import { mountAddDialog, wireZoneExternalDrops } from './add-dialog.js';
import { showThoughtContextMenu, showZoneContextMenu } from './context-menu.js';
import { wireCloudDrag } from './drag-cloud.js';
import { initKbdNav, resetCanvasCursor, setCursor, syncCanvasCursor } from './kbd-nav.js';
import { mountZoneSplitters } from './zone-splitters.js';
import { openThoughtDeleteDialog } from '../trash.js';

/** Zone directions of the canvas (parents/siblings/children). */
export type ZoneDir = 'parents' | 'siblings' | 'children';

/** Neighbours grouped by thought id (several links may point at one thought). */
export interface ZoneEntry {
  id: string;
  links: FocusNeighbor[];
  ref: ThoughtRef | null;
}

/** Comment/attachment counts shown in the cloud indicators row. */
export interface IndicatorInfo {
  permanent: boolean;
  chrono: number;
  attachments: number;
}

/** Resolved visual style of a cloud (own values win over type defaults). */
export interface CloudStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

/** Overlap rows rendered beyond the visible window (virtualization). */
const OVERSCAN_ROWS = 2;
/** How many indicator fetches may run concurrently. */
const INDICATOR_CONCURRENCY = 3;
/** Minimum mouse travel before a press becomes a drag, px. */
export const DRAG_THRESHOLD_PX = 4;
/** `etn.thoughts.neighbors` limit for the Ctrl-hover ellipse preview list —
 *  same figure `selection.ts`'s `collectNeighbors` uses for the equivalent
 *  gesture (Ctrl+click an ellipse to select all neighbours). */
const NEIGHBORS_PREVIEW_LIMIT = 200;

/** Add-thought dialog context produced by an ellipse drag (H14 registers). */
export interface AddDialogContext {
  /** The thought the dragged ellipse belongs to (link anchor). */
  anchorId: string;
  /** Top ellipse → new parent; bottom ellipse → new child. */
  direction: 'parent' | 'child';
}

/** Pending ellipse drag state. */
interface DragState {
  anchorId: string;
  direction: 'parent' | 'child';
  startX: number;
  startY: number;
  active: boolean;
  hovered: HTMLElement | null;
  /** The pressed ellipse — lights up as the drag source (`.drag-source`). */
  sourceEl: HTMLElement;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
let zones: Record<'parents' | 'siblings' | 'children', HTMLElement> | null = null;
let focusRow: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let focusCloudEl: HTMLElement | null = null;
let drag: DragState | null = null;
let suppressNextClick = false;
let addDialogOpener: ((ctx: AddDialogContext) => void) | null = null;
let redrawLinks: (() => void) | null = null;

/** Marks the next canvas click as a drag aftermath (consumed by the cloud
 *  click handler) — set by the cloud drag gesture (drag-cloud.ts). */
export function suppressNextCanvasClick(): void {
  suppressNextClick = true;
}

/**
 * How long a single click on a cloud waits for a sibling double-click before
 * it fires its own action (open the thought in the editor). The browser fires
 * two `click` events for every double-click; without this delay the first
 * click would already start the editor render only for the second click to
 * refocus the same thought (or for a no-op duplicate `openThoughtInEditor`
 * to bounce the panel), which the user reads as a "double-click handled as
 * two single clicks". Mirrors the OS-level double-click threshold.
 */
const SINGLE_CLICK_DELAY_MS = 220;

/**
 * Defers a single-click action until the browser has had a chance to emit a
 * matching `dblclick`. The first click schedules the action; a second click
 * inside {@link SINGLE_CLICK_DELAY_MS} cancels it and the element's
 * `dblclick` handler runs instead.
 *
 * The returned `cancel` is exposed for tests and for callers that need to
 * drop a pending action on tear-down (cloud rebuild on focus change, etc.).
 */
export function deferSingleClick(action: () => void): { cancel: () => void } {
  let timer: number | null = window.setTimeout(() => {
    timer = null;
    action();
  }, SINGLE_CLICK_DELAY_MS);
  return {
    cancel(): void {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Selection click hooks (H16): Ctrl+click on clouds and ellipses. */
export interface SelectionClickHooks {
  onCloudClick(id: string): void;
  onEllipseClick(id: string, direction: 'parent' | 'child'): void;
}

let selectionHooks: SelectionClickHooks | null = null;

/** Registers the selection Ctrl+click hooks (selection module, H16). */
export function setSelectionClickHooks(next: SelectionClickHooks | null): void {
  selectionHooks = next;
}

/** Resolved metadata cache (id → ThoughtRef), persistent across focuses. */
const refCache = new Map<string, ThoughtRef>();
/** Indicator cache (id → counts), invalidated on comment/attachment events. */
const indicatorCache = new Map<string, IndicatorInfo>();
const indicatorQueue: string[] = [];
let indicatorRunning = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mounts the canvas into the workspace canvas host. Called by the workspace
 * builder; the canvas re-renders on every store change (focus/width/gap).
 */
export function mountCanvas(canvasHost: HTMLElement): void {
  host = canvasHost;
  host.replaceChildren();
  clear(host);

  const top = div('canvas-top');
  const zoneParents = buildZone('parents');
  const zoneSiblings = buildZone('siblings');
  const zoneSplitterV = div('zone-splitter zone-splitter-v');
  top.append(zoneParents, zoneSplitterV, zoneSiblings);

  focusRow = div('canvas-focus-row');

  const zoneChildren = buildZone('children');
  // Draggable zone splitters (08-ui-spec.md §2.1): vertical inside the top
  // strip, horizontal between the focus row and the children zone.
  const zoneSplitterH = div('zone-splitter zone-splitter-h');

  const empty = div('canvas-empty');
  empty.textContent = 'Нет открытой сети';

  host.append(top, focusRow, zoneSplitterH, zoneChildren, empty);
  zones = { parents: zoneParents, siblings: zoneSiblings, children: zoneChildren };
  emptyEl = empty;
  redrawLinks = initLinksOverlay(host).redraw;
  applyCanvasScaleVars(host);
  mountZoneSplitters({
    host,
    top,
    focusRow,
    vertical: zoneSplitterV,
    horizontal: zoneSplitterH,
    onLayoutChange: updateFocusBand,
  });

  // Add-thought dialog (H14) and external file/URL drops (08-ui-spec.md §7).
  mountAddDialog();
  wireZoneExternalDrops({ parents: zoneParents, children: zoneChildren });
  // Internal cloud drag-n-drop (move / link / reorder / copy) — one delegation
  // point on the canvas host; siblings are handled there as a non-target.
  wireCloudDrag(host, {
    getZoneOrder: (dir) => store.state.zoneOrder[dir],
  });
  // Keyboard navigation over the map (§2.9): arrows/Home/End/Enter — active
  // while the keyboard focus is inside the canvas host.
  initKbdNav(host);
  // A click on neither a link line nor a cloud clears the sticky link
  // selection and returns the editor to the focused thought (editorTarget=null
  // → editor follows the focus). Clicks on clouds keep their own handling —
  // a cloud click opens that thought in the editor (§2.2.4), a link-line click
  // selects the link.
  host.addEventListener('click', (event) => {
    const t = event.target as HTMLElement | null;
    const onLine = t?.closest('.link-hit, .link-line') ?? null;
    const onCloud = t?.closest('.cloud') ?? null;
    if (
      onLine === null &&
      onCloud === null &&
      (store.state.selectedLinkId !== null || store.state.editorTarget !== null)
    ) {
      store.update({ selectedLinkId: null, editorTarget: null });
    }
  });

  store.subscribe(() => {
    if (host?.isConnected !== true) return;
    const key = canvasRenderKey();
    if (key === lastRenderKey) {
      // The canvas data is unchanged — only the selection may differ
      // (Ctrl+click on clouds/ellipses, clear, context-menu toggle, 08-ui-spec
      // §2.8: selection changes are not animated). Repaint the `.selected`
      // classes in place: a full rebuild reshuffles the virtualized zones and
      // loses the scroll position of the visible area (2e418bc3).
      const selKey = selectionKey();
      if (selKey !== lastSelectionKey) {
        lastSelectionKey = selKey;
        paintSelection();
      }
      return;
    }
    lastRenderKey = key;
    lastSelectionKey = selectionKey();
    void render();
  });
  // The focus band follows the focus row, whose position depends on the zone
  // shares and the host size — re-anchor it on resizes too (L12).
  new ResizeObserver(() => {
    if (host?.isConnected === true) updateFocusBand();
  }).observe(host);
  void render();
}

/** Returns the cached metadata for a thought id, or null. */
export function getRef(id: string): ThoughtRef | null {
  return refCache.get(id) ?? null;
}

/**
 * Drops the cached metadata for a thought so the next render re-resolves it
 * (icon/type/colors). Called on realtime `thought.updated`/`thought.deleted`.
 */
export function invalidateRef(id: string): void {
  refCache.delete(id);
}

/**
 * Drops every cached thought ref — used on layer switches (13-layers.md §12):
 * refs resolved in the previous layer's context carry that layer's flags
 * (trash mark, active, colors), and a stale trash badge would otherwise
 * survive the switch until the thought is re-read by some other path.
 */
export function invalidateAllRefs(): void {
  refCache.clear();
}

/** Returns the currently rendered focus cloud (H6 line anchoring). */
export function getFocusCloudEl(): HTMLElement | null {
  return focusCloudEl;
}

/** Returns the rendered cloud of a thought inside a zone (visible window only). */
export function findZoneCloud(id: string, dir: ZoneDir): HTMLElement | null {
  if (host === null) return null;
  return host.querySelector<HTMLElement>(`.zone-${dir} .cloud[data-id="${CSS.escape(id)}"]`);
}

/** Returns the rendered cloud of a thought anywhere on the canvas (focus or any
 *  zone, visible window only) — used by the link overlay to find both endpoints. */
export function findCloudAnywhere(id: string): HTMLElement | null {
  if (focusCloudEl !== null && focusCloudEl.dataset['id'] === id) return focusCloudEl;
  if (host === null) return null;
  return host.querySelector<HTMLElement>(`.cloud[data-id="${CSS.escape(id)}"]`);
}

/** Returns the grouped neighbours currently rendered in a zone (H6 pairing). */
export function getZoneEntries(dir: ZoneDir): ZoneEntry[] {
  return zoneData.get(dir) ?? [];
}

/**
 * Registers the add-thought dialog opener (H14). Called at the end of an
 * ellipse drag that did not land on another thought.
 */
export function setAddDialogOpener(opener: ((ctx: AddDialogContext) => void) | null): void {
  addDialogOpener = opener;
}

/**
 * Invalidates cached indicator counts and re-fetches them, patching the
 * rendered clouds (called after comment/attachment changes and realtime events).
 * The link-popover counts cache (links.ts) is dropped for the same id too —
 * for a link owner the id is the link id, for `null` the whole cache goes.
 */
export function invalidateIndicators(id: string | null): void {
  if (id === null) {
    const ids = [...indicatorCache.keys()];
    indicatorCache.clear();
    for (const known of ids) queueIndicatorLoad(known);
  } else {
    indicatorCache.delete(id);
    queueIndicatorLoad(id);
  }
  invalidateLinkCounts(id);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Writes the zoom-aware cloud sizing CSS variables onto a host (L9). On the
 * canvas host they cascade to the zones AND the focus row — before L9 the
 * focus cloud inherited the static `:root` fallbacks instead of the stored
 * L4 `cloud_width`. The same `cloudGeom` numbers drive the zone grid math, so
 * CSS and virtualization never diverge. The structures view (L15) applies the
 * same variables to its own host so its clouds match the canvas scale.
 */
export function applyCanvasScaleVars(h: HTMLElement): void {
  const zoom = store.state.canvasZoom;
  const geom = cloudGeom(store.state.cloudWidth, store.state.cloudGap, zoom);
  h.style.setProperty('--cloud-width', `${geom.width}px`);
  h.style.setProperty('--cloud-gap', `${geom.gap}px`);
  h.style.setProperty('--cloud-font', `${geom.font}px`);
  h.style.setProperty('--cloud-zoom', String(zoom));
  h.style.setProperty('--link-label-font', `${Math.round(LINK_LABEL_FONT_BASE * zoom)}px`);
}

/**
 * Content signature of everything the canvas renders from. A store change
 * whose signature is unchanged — only the selection list differs — repaints
 * cloud classes instead of rebuilding the zones (see the mountCanvas
 * subscriber). `zoneAnimationPending` is part of the signature so a requested
 * FLIP transition is never skipped by the unchanged-data fast path.
 */
function canvasRenderKey(): string {
  const s = store.state;
  return JSON.stringify({
    focus: s.focus,
    cloudWidth: s.cloudWidth,
    cloudGap: s.cloudGap,
    canvasZoom: s.canvasZoom,
    zoneSorts: s.zoneSorts,
    zoneOrder: s.zoneOrder,
    linkTypes: s.linkTypes,
    thoughtTypes: s.thoughtTypes,
    editorTarget: s.editorTarget,
    selectedLinkId: s.selectedLinkId,
    // Live override marking (08-ui-spec.md §2.2): the badge/dashed outline is
    // painted by a full render — without this field a post-mutation override
    // refresh hit the selection-only fast path and the badge only appeared
    // after the next focus/layer change repainted the canvas.
    layerOverrides: s.layerOverrides,
    zoneAnimationPending,
  });
}

/** Signature of the ordered selection list. */
function selectionKey(): string {
  return store.state.selection.join('\u0000');
}

/** Repaints the `.selected` cloud classes from the store selection in place. */
function paintSelection(): void {
  if (host === null) return;
  const selected = new Set(store.state.selection);
  for (const cloud of host.querySelectorAll<HTMLElement>('.cloud')) {
    const id = cloud.dataset['id'];
    if (id === undefined) continue;
    cloud.classList.toggle('selected', selected.has(id));
  }
}

/** Renders everything from the current store state. */
async function render(): Promise<void> {
  if (host === null || zones === null || focusRow === null) return;
  applyCanvasScaleVars(host);
  const focus = store.state.focus;
  if (focus === null) {
    emptyEl?.classList.remove('hidden');
    resetFocusBand(host);
    resetCanvasCursor();
    return;
  }
  emptyEl?.classList.add('hidden');

  // Focus-change choreography (08-ui-spec.md §2.8): snapshot the old clouds
  // before the rebuild, then FLIP/ghost them after it. Other re-renders
  // (edits, selection, realtime refresh of the same focus) are not animated —
  // except when a link-affecting change requested the zone transition so a
  // thought that changed zones visibly flows there (§2.1 exclusivity).
  const focusChanged = focus.focused.id !== lastFocusId;
  // The keyboard cursor does not survive a focus change: the cursor cloud may
  // have become the focus cloud, moved between zones or left the map (§2.9).
  if (focusChanged) resetCanvasCursor();
  const animate = (focusChanged || zoneAnimationPending) && !prefersReducedMotion();
  zoneAnimationPending = false;
  const snapshot = animate ? captureClouds(host) : null;

  // The focused thought is always fresh in the focus response — refresh the
  // neighbour cache so its (possibly just-edited) style, icon and title show
  // correctly when it later appears in a zone instead of the focus row.
  refCache.set(focus.focused.id, focus.focused);

  // Enrich neighbour metadata (colors/fonts/icon_kind are not in FocusNeighbor).
  await enrichRefs(focus);
  relatedTitles = visibleRelatedTitles(focus);
  renderFocusRow(focus);
  updateFocusBand();
  renderZone('parents', groupByThought(focus.parents));
  renderZone('siblings', groupByThought(focus.siblings));
  renderZone('children', groupByThought(focus.children));
  lastFocusId = focus.focused.id;
  scheduleIndicatorLoads();
  if (snapshot !== null) {
    playFocusTransition(host, snapshot, drawLinksNow);
  } else {
    redrawLinks?.();
  }
  syncCanvasCursor();
}

/** Focus id of the last render — gates the transition choreography (§2.8). */
let lastFocusId: string | null = null;

/** Last canvas content signature handled by the store subscriber — gates the
 *  selection-only fast path (2e418bc3). */
let lastRenderKey: string | null = null;
let lastSelectionKey = '';

/**
 * Positions the focus band gradient (L12, 08-ui-spec.md §2.1): writes the
 * focus-row top/bottom (relative to the canvas host) into the
 * `--focus-band-*` CSS variables consumed by the host `::before` layer.
 * Called on every render and on host resizes.
 */
function updateFocusBand(): void {
  if (host === null || focusRow === null) return;
  const hostRect = host.getBoundingClientRect();
  const rowRect = focusRow.getBoundingClientRect();
  host.style.setProperty('--focus-band-top', `${Math.round(rowRect.top - hostRect.top)}px`);
  host.style.setProperty('--focus-band-bottom', `${Math.round(rowRect.bottom - hostRect.top)}px`);
}

/** Clears the focus band (no focus → no band; the CSS defaults render it off-screen). */
function resetFocusBand(h: HTMLElement): void {
  h.style.removeProperty('--focus-band-top');
  h.style.removeProperty('--focus-band-bottom');
}

/** Set by {@link requestZoneAnimation}; consumed by the next render. */
let zoneAnimationPending = false;

/**
 * Requests the FLIP transition choreography for the next render even though
 * the focused thought stays the same — called after link-affecting changes
 * (ellipse drop, cloud link/move) so a thought that changed zones glides to
 * its new place instead of teleporting.
 */
export function requestZoneAnimation(): void {
  zoneAnimationPending = true;
}

/**
 * Mark-for-deletion badge (S13, 08-ui-spec.md §2.2): shown on any visible
 * cloud whose thought is in the trash, regardless of the `trashed` filter
 * (the canvas never hides marked thoughts — only search/query results do).
 * A marked cloud is also dimmed like an inactive one (§2.2). The badge circle
 * is 70% larger than the position badge and carries a bright-red trash glyph;
 * a click opens the single-delete dialog (restore/delete) directly from the
 * badge.
 */
function buildTrashBadge(id: string, title: string): HTMLElement {
  const badge = span('', 'cloud-trash-badge');
  badge.append(svgIcon('trash', 17));
  setTooltip(badge, 'Мысль находится в корзине. Нажмите для удаления/восстановления');
  badge.addEventListener('click', (event) => {
    event.stopPropagation();
    const networkId = store.state.networkId;
    if (networkId === null) return;
    void openThoughtDeleteDialog(networkId, { id, title });
  });
  return badge;
}

/** Ids physically overridden by the session's current layer (S11, §10.3) —
 * rebuilt per render; the lists are small (the layer's own shadow rows). */
function overriddenThoughtIds(): Set<string> {
  return new Set(store.state.layerOverrides.thought_ids);
}

/**
 * Marks a cloud whose thought is overridden by the current layer (S11):
 * a dashed outline plus a small layer badge in the top-right corner — the
 * canvas always shows the RESOLVED state (§4.1), the badge tells the user
 * this particular card carries a layer version and will travel with a merge.
 */
function markOverriddenCloud(cloud: HTMLElement, id: string): void {
  if (!overriddenThoughtIds().has(id)) return;
  cloud.classList.add('overridden');
  const badge = span('', 'cloud-layer-badge');
  badge.append(svgIcon('layers', 15));
  setTooltip(badge, 'Мысль изменена в текущем слое — её правка уедет в основу при слиянии');
  cloud.append(badge);
}

/**
 * Renders the focus cloud (08-ui-spec.md §2.2.2): variable width, up to 3
 * title lines, ellipses filled when incoming/outgoing links exist.
 */
function renderFocusRow(focus: FocusResponse): void {
  if (focusRow === null) return;
  clear(focusRow);
  const thought = focus.focused;
  focusCloudEl = null;

  const cloud = div('cloud focus-cloud');
  cloud.dataset['id'] = thought.id;
  // A marked (trashed) thought is dimmed exactly like an inactive one
  // (08-ui-spec.md §2.2): both states read as "faded", the trash badge on
  // top is what tells them apart.
  if (!thought.active || thought.marked_for_deletion) cloud.classList.add('dim');
  applyCloudStyle(cloud, resolveCloudStyle(thought));

  const parents = groupByThought(focus.parents).length;
  const children = groupByThought(focus.children).length;

  const topEllipse = div('ellipse ellipse-top');
  const bottomEllipse = div('ellipse ellipse-bottom');
  if (parents > 0) topEllipse.classList.add('filled');
  if (children > 0) bottomEllipse.classList.add('filled');
  setTooltip(topEllipse, `Входящие связи: ${parents}`);
  setTooltip(bottomEllipse, `Исходящие связи: ${children}`);
  wireEllipseDrag(topEllipse, thought.id, 'parent');
  wireEllipseDrag(bottomEllipse, thought.id, 'child');
  markNeighborsPreview(topEllipse, thought.id, neighborsDirForEllipse('top'), thought.title);
  markNeighborsPreview(bottomEllipse, thought.id, neighborsDirForEllipse('bottom'), thought.title);

  const iconBox = div('cloud-icon');
  // Same resolution as zone clouds: the thought's own icon wins, else the
  // thought type's default icon (so a typed focus shows the type icon too).
  applyThoughtIcon(iconBox, thought);
  const title = el('div', 'cloud-title', thought.title);
  setTooltip(title, thought.title.slice(0, 400));
  const ind = div('cloud-ind');
  const focusPerm = span('📝', 'ind dim');
  const focusChrono = span('📅', 'ind dim');
  const focusAtt = span('📎', 'ind dim');
  markCommentPreview(focusPerm, 'thought', thought.id, thought.title);
  markChronoPreview(focusChrono, 'thought', thought.id, thought.title);
  markAttachmentsPreview(focusAtt, 'thought', thought.id, thought.title);
  ind.append(focusPerm, focusChrono, focusAtt);
  const main = div('cloud-main');
  main.append(title, ind);

  cloud.append(topEllipse, iconBox, main, bottomEllipse);
  if (thought.marked_for_deletion) {
    cloud.append(buildTrashBadge(thought.id, thought.title));
  }
  markOverriddenCloud(cloud, thought.id);
  focusRow.append(cloud);
  focusCloudEl = cloud;
  // A click on the focus cloud returns the editor to the focused thought
  // (same as a click on empty canvas space); a double-click would refocus
  // the same thought — a no-op, so the single-click action is deferred so a
  // quick second click cancels it instead of triggering two editor
  // navigations back-to-back. Without the delay the first click already
  // pushed the editor target, then the dblclick handler tried to focus
  // the same thought on top of it, producing the "editor shaking" the bug
  // reports describe.
  let pendingClick: { cancel: () => void } | null = null;
  cloud.addEventListener('click', (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    logUiEvent('ui.cloud.click', { id: thought.id });
    if (event.ctrlKey || event.metaKey) {
      pendingClick?.cancel();
      pendingClick = null;
      selectionHooks?.onCloudClick(thought.id);
      return;
    }
    // Click sets the keyboard cursor on this cloud so subsequent arrows
    // (and Ctrl+Shift+←/→ in manual mode) move from the just-clicked
    // cloud, not from wherever the cursor happened to be. The editor halo
    // and the cursor frame are independent — both follow this click.
    pendingClick?.cancel();
    pendingClick = deferSingleClick(() => {
      pendingClick = null;
      setCursor(thought.id);
      openThoughtInEditor(thought.id);
    });
  });
  cloud.addEventListener('dblclick', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    pendingClick?.cancel();
    pendingClick = null;
  });
  cloud.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showThoughtContextMenu(event, { id: thought.id, title: thought.title, dir: 'siblings' });
  });
  queueIndicatorLoad(thought.id);
}

/** Groups neighbour rows by thought id, attaching cached refs. */
function groupByThought(neighbors: FocusNeighbor[]): ZoneEntry[] {
  const byId = new Map<string, ZoneEntry>();
  for (const neighbor of neighbors) {
    let entry = byId.get(neighbor.id);
    if (entry === undefined) {
      entry = { id: neighbor.id, links: [], ref: refCache.get(neighbor.id) ?? null };
      byId.set(neighbor.id, entry);
    }
    entry.links.push(neighbor);
  }
  return [...byId.values()];
}

/**
 * Titles of the visible parents/children of every displayed thought — the
 * endpoint titles of the focus response's `edges` (08-ui-spec.md §2.2.3).
 * Kept for the current focus; the zone clouds shorten compound names against
 * them. The focused thought itself always shows its full name (the focus row).
 */
let relatedTitles = new Map<string, string[]>();

/**
 * Maps each displayed thought to the titles of its visible (displayed) related
 * thoughts — parents and children from the `edges` among the visible set
 * (focused + parents + siblings + children, 03-server-api.md §6.2).
 */
export function visibleRelatedTitles(focus: {
  focused: { id: string; title: string };
  parents: FocusNeighbor[];
  siblings: FocusNeighbor[];
  children: FocusNeighbor[];
  edges: FocusEdge[];
}): Map<string, string[]> {
  const titleOf = new Map<string, string>();
  titleOf.set(focus.focused.id, focus.focused.title);
  for (const neighbor of [...focus.parents, ...focus.siblings, ...focus.children]) {
    titleOf.set(neighbor.id, neighbor.title);
  }
  const related = new Map<string, Set<string>>();
  const add = (id: string, title: string): void => {
    const set = related.get(id) ?? new Set<string>();
    set.add(title);
    related.set(id, set);
  };
  for (const edge of focus.edges) {
    if (edge.source_id === edge.target_id) continue;
    const sourceTitle = titleOf.get(edge.source_id);
    const targetTitle = titleOf.get(edge.target_id);
    if (sourceTitle === undefined || targetTitle === undefined) continue;
    add(edge.source_id, targetTitle);
    add(edge.target_id, sourceTitle);
  }
  return new Map([...related].map(([id, titles]) => [id, [...titles]]));
}

/** Fetches missing refs for all neighbours of a focus response. */
async function enrichRefs(focus: FocusResponse): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const ids = [...focus.parents, ...focus.children, ...focus.siblings]
    .map((n) => n.id)
    .filter((id) => !refCache.has(id));
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  try {
    const resolved = await etn.thoughts.resolve(networkId, unique.slice(0, 100));
    for (const ref of resolved) refCache.set(ref.id, ref);
  } catch {
    // Enrichment is best-effort: clouds render with default styling.
  }
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** Empty-zone hints; the double-click hint only where the gesture works (L19). */
const ZONE_EMPTY_LABELS: Record<'parents' | 'siblings' | 'children', string> = {
  parents: 'Влияющих мыслей нет. Двойной клик для добавления',
  siblings: 'Родственных мыслей нет',
  children: 'Подчинённых мыслей нет. Двойной клик для добавления',
};

/** Builds a grid zone with scroll → virtualization wiring. */
function buildZone(dir: 'parents' | 'siblings' | 'children'): HTMLElement {
  const zone = div(`zone zone-${dir}`);
  zone.dataset['dir'] = dir;

  const spacer = div('zone-spacer');
  const grid = div('zone-grid');
  const empty = div('zone-empty');
  empty.textContent = ZONE_EMPTY_LABELS[dir];
  spacer.append(grid);
  zone.append(spacer, empty);

  let renderQueued = false;
  zone.addEventListener('scroll', () => {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(() => {
      renderQueued = false;
      if (host?.isConnected === true) void renderZoneContent(dir);
    });
  });

  new ResizeObserver(() => {
    if (host?.isConnected === true) void renderZoneContent(dir);
  }).observe(zone);

  // Zone context menu (sorting, H15). Cloud drag-n-drop is wired once on the
  // canvas host in mountCanvas.
  zone.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showZoneContextMenu(event, dir);
  });

  // A double click on the zone's empty space opens the add-thought dialog
  // (L19): top-left adds a parent, bottom — a child (anchor: the focused
  // thought). A single click stays free of side effects (a plain click on the
  // canvas only clears the sticky link selection). The siblings zone gets no
  // gesture — the focus may have several parents, so there is no unambiguous
  // anchor. Double clicks on clouds keep their own handling; double clicks
  // with held modifiers are ignored.
  zone.addEventListener('dblclick', (event) => {
    if (dir === 'siblings') return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && target.closest('.cloud') !== null) return;
    const focusId = store.state.focus?.focused.id;
    if (focusId === undefined) return;
    if (addDialogOpener !== null) {
      addDialogOpener({ anchorId: focusId, direction: dir === 'parents' ? 'parent' : 'child' });
    }
  });

  return zone;
}

/** Renders a zone from the current focus data. */
function renderZone(dir: 'parents' | 'siblings' | 'children', entries: ZoneEntry[]): void {
  zoneData.set(dir, entries);
  // The entry set changed — per-row height measurements no longer apply
  // (rows shift with the order and the column count).
  rowHeights.delete(dir);
  renderZoneContent(dir);
}

/** Per-zone entry lists, kept between scroll-triggered re-renders. */
const zoneData = new Map<'parents' | 'siblings' | 'children', ZoneEntry[]>();

/** Column-major grid geometry of a zone (cols × rows, 08-ui-spec.md §2.1.1). */
function zoneGridOf(dir: 'parents' | 'siblings' | 'children'): {
  cols: number;
  rows: number;
} | null {
  const zone = zones?.[dir];
  if (zone === null || zone === undefined) return null;
  const entries = zoneData.get(dir) ?? [];
  const geom = cloudGeom(store.state.cloudWidth, store.state.cloudGap, store.state.canvasZoom);
  const cellW = geom.width + geom.gap;
  const avail = Math.max(80, zone.clientWidth - 24);
  const cols = Math.max(1, Math.floor(avail / cellW));
  return { cols, rows: Math.ceil(entries.length / cols) };
}

/**
 * Measured heights of a zone's grid rows (px, gap excluded). Rows that were
 * never rendered fall back to the one-line estimate; every render re-measures
 * its visible rows and re-runs the layout once when anything changed, so the
 * virtualization never diverges from the DOM. A cloud's height depends only
 * on its title, the fixed cloud width and the zoom — deterministic per row,
 * so the re-run converges immediately.
 */
const rowHeights = new Map<'parents' | 'siblings' | 'children', number[]>();

/** Renders the visible window of one zone (virtualized grid, auto rows). */
function renderZoneContent(dir: 'parents' | 'siblings' | 'children'): void {
  if (zones === null) return;
  const zone = zones[dir];
  const entries = zoneData.get(dir) ?? [];
  const spacer = zone.querySelector<HTMLElement>('.zone-spacer');
  const grid = zone.querySelector<HTMLElement>('.zone-grid');
  const empty = zone.querySelector<HTMLElement>('.zone-empty');
  if (spacer === null || grid === null || empty === null) return;

  // Effective (zoom-multiplied) sizes; the --cloud-* CSS variables with the
  // same numbers live on the canvas host (applyCanvasScaleVars).
  const geom = cloudGeom(store.state.cloudWidth, store.state.cloudGap, store.state.canvasZoom);
  // Estimate for not-yet-measured rows: the minimum cloud height (1 title
  // line) — most clouds render at it, so scrolling stays stable.
  const estimate = cloudHeight(
    store.state.cloudWidth,
    store.state.canvasZoom,
    CLOUD_TITLE_LINES_MIN,
  );

  if (entries.length === 0) {
    spacer.style.height = '0px';
    empty.classList.remove('hidden');
    clear(grid);
    return;
  }
  empty.classList.add('hidden');

  const gridInfo = zoneGridOf(dir);
  if (gridInfo === null) return;
  const { cols, rows } = gridInfo;
  const heights = rowHeights.get(dir) ?? [];
  while (heights.length < rows) heights.push(estimate);

  grid.style.gridTemplateColumns = `repeat(${cols}, ${geom.width}px)`;
  grid.style.gridAutoRows = 'auto'; // each row is as tall as its tallest cloud
  grid.style.gridAutoFlow = 'row'; // row-major: DOM order = entries order; default, fixed for safety
  grid.style.columnGap = `${geom.gap}px`;
  grid.style.rowGap = `${geom.gap}px`;

  // Row tops as prefix sums; the gap follows every row (incl. the last — the
  // spacer keeps the same gap-sized overshoot as the old `rows * cellH`).
  const prefix = new Array<number>(rows + 1);
  let top = 0;
  prefix[0] = 0;
  for (let i = 0; i < rows; i++) {
    top += (heights[i] ?? estimate) + geom.gap;
    prefix[i + 1] = top;
  }

  let startRow = 0;
  while (startRow + 1 < rows && prefix[startRow + 1]! <= zone.scrollTop) startRow++;
  let endRow = startRow;
  const windowBottom = zone.scrollTop + zone.clientHeight;
  while (endRow < rows && prefix[endRow]! < windowBottom) endRow++;
  startRow = Math.max(0, startRow - OVERSCAN_ROWS);
  endRow = Math.min(rows, endRow + OVERSCAN_ROWS);

  spacer.style.height = `${prefix[rows]!}px`;
  grid.style.transform = `translateY(${prefix[startRow]!}px)`;

  clear(grid);
  // Row-major fill (08-ui-spec.md §2.1.1): DOM order = entries order
  // (`entries[i]`); CSS Grid `grid-auto-flow: row` (fixed above) lays them
  // out left-to-right within a row, then advances to the next row. Visual
  // slot `(col = i % cols, row = floor(i / cols))` therefore contains the
  // entry with row-major index i — i.e. the same position it occupies in
  // the server-returned neighbours array (zoneOrder). This matches the
  // keyboard cursor model (↑/↓/←/→ step by row-major index) and
  // `Ctrl+Shift+↑/↓` (which moves by one position in zoneOrder).
  const showPosition = dir !== 'siblings' && store.state.zoneSorts[dir].sort === 'manual';
  const first = startRow * cols;
  const last = endRow * cols;
  const rowClouds = new Map<number, HTMLElement[]>();
  for (let i = first; i < last; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const position = showPosition ? (entry.links[0]?.manual_position ?? null) : null;
    const cloud = buildCloud(entry, dir, position);
    const r = Math.floor(i / cols);
    const clouds = rowClouds.get(r);
    if (clouds === undefined) rowClouds.set(r, [cloud]);
    else clouds.push(cloud);
    grid.append(cloud);
  }

  // Measure the rendered rows and re-run the layout once when any height
  // changed (heights are deterministic — the re-run converges immediately).
  let measured = false;
  for (let r = startRow; r < endRow; r++) {
    const clouds = rowClouds.get(r);
    if (clouds === undefined) continue;
    let h = estimate;
    for (const cloud of clouds) h = Math.max(h, cloud.offsetHeight);
    if (heights[r] !== h) {
      heights[r] = h;
      measured = true;
    }
  }
  rowHeights.set(dir, heights);
  if (measured) {
    renderZoneContent(dir);
    return;
  }

  // Request indicators only AFTER the clouds are in the DOM: a cached value is
  // applied synchronously and would otherwise patch nothing (the focus row
  // loads it after mounting for the same reason).
  for (let i = first; i < last; i++) {
    const entry = entries[i];
    if (entry !== undefined) queueIndicatorLoad(entry.id);
  }
  // The rebuilt clouds lost the keyboard cursor frame — repaint it (§2.9).
  syncCanvasCursor();
  redrawLinks?.();
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/**
 * Resolves the visual style of a thought: own values win, then the type chain
 * defaults (L21: the type inherits unset fields from its ancestors; a thought
 * without a type resolves the root type «основной тип»), 08-ui-spec.md §2.2.
 */
export function resolveCloudStyle(
  thought: Pick<
    ThoughtRef,
    | 'fg_color'
    | 'bg_color'
    | 'font_bold'
    | 'font_italic'
    | 'font_underline'
    | 'font_strike'
    | 'type_id'
  >,
): CloudStyle {
  const type = resolveThoughtTypeVisual(store.state.thoughtTypes, thought.type_id);
  return {
    fg: thought.fg_color ?? type.fg_color,
    bg: thought.bg_color ?? type.bg_color,
    // font_* use null-coalesce (NOT OR): a manual `false` must override a `true`
    // type default, which `||` would wrongly collapse (02-data-model.md §3.1.1).
    bold: thought.font_bold ?? type.font_bold ?? false,
    italic: thought.font_italic ?? type.font_italic ?? false,
    underline: thought.font_underline ?? type.font_underline ?? false,
    strike: thought.font_strike ?? type.font_strike ?? false,
  };
}

/** Applies a resolved style to a cloud element (also used by the structures tree, L15). */
export function applyCloudStyle(cloud: HTMLElement, style: CloudStyle): void {
  if (style.fg !== null) {
    cloud.style.color = style.fg;
  } else if (style.bg !== null) {
    // Only the background is set — pick a readable text colour for it (L12,
    // 08-ui-spec.md §2.2); an explicit fg always wins.
    cloud.style.color = contrastText(style.bg);
  } else {
    cloud.style.color = '';
  }
  if (style.bg !== null) cloud.style.background = style.bg;
  cloud.classList.toggle('font-bold', style.bold);
  cloud.classList.toggle('font-italic', style.italic);
  cloud.classList.toggle('font-underline', style.underline);
  cloud.classList.toggle('font-strike', style.strike);
}

/**
 * Resolves a thought's icon: its own icon wins, else the default icon resolved
 * along the type chain (L21; a thought without a type resolves the root type),
 * else none (the caller falls back to 💬). Returns the icon value together
 * with its kind (02-data-model.md §3.1.1).
 */
export function resolveThoughtIcon(thought: {
  icon: string | null;
  icon_kind: IconKind;
  type_id: string | null;
}): { icon: string | null; kind: IconKind } {
  if (thought.icon !== null) {
    return { icon: thought.icon, kind: thought.icon_kind };
  }
  const type = resolveThoughtTypeVisual(store.state.thoughtTypes, thought.type_id);
  if (type.icon !== null) {
    return { icon: type.icon, kind: type.icon_kind };
  }
  return { icon: null, kind: 'emoji' };
}

/**
 * Renders a thought's resolved icon into an element: an `<img>` for an
 * `image`-kind icon, otherwise the glyph (own/type default, else 💬). When the
 * icon is backed by an attachment (L16), the `<img>` carries the thought and
 * attachment ids so the Ctrl-hover magnifier shows the attachment's full
 * picture instead of the icon-sized preview.
 */
export function applyThoughtIcon(
  iconBox: HTMLElement,
  thought: {
    icon: string | null;
    icon_kind: IconKind;
    type_id: string | null;
    /** Thought id — required together with {@link icon_attachment_id} for zoom. */
    id?: string;
    icon_attachment_id?: string | null;
  },
): void {
  const ic = resolveThoughtIcon(thought);
  iconBox.replaceChildren();
  if (ic.kind === 'image' && ic.icon !== null) {
    const img = el('img');
    img.src = ic.icon;
    img.alt = '';
    if (thought.id !== undefined && (thought.icon_attachment_id ?? null) !== null) {
      img.dataset['zoomThought'] = thought.id;
      img.dataset['zoomAttachment'] = thought.icon_attachment_id ?? '';
    }
    iconBox.append(img);
  } else {
    iconBox.textContent = ic.icon ?? '💭';
  }
}

/** Builds one zone cloud element. */
function buildCloud(
  entry: ZoneEntry,
  dir: 'parents' | 'siblings' | 'children',
  position: number | null,
): HTMLElement {
  const ref = entry.ref;
  const cloud = div('cloud');
  cloud.dataset['id'] = entry.id;
  cloud.dataset['dir'] = dir;

  // The live neighbour carries a fresh `active` flag in every focus response —
  // prefer it over the cached ref, which can lag after a local toggle until the
  // ref is re-resolved (no realtime echo to the actor, 04-realtime.md §5).
  // `marked_for_deletion` lives only on the ref (FocusNeighbor does not carry
  // it), so the trash state follows the ref cache — refreshed via
  // invalidateRef() + scheduleRefresh() right after a mark/restore.
  const isMarked = ref?.marked_for_deletion === true;
  const isInactive = (entry.links[0]?.active ?? ref?.active) === false;
  // Marked (trashed) clouds are dimmed like inactive ones (08-ui-spec.md
  // §2.2); when both states combine the cloud is simply dim with the badge
  // on top.
  if (isInactive || isMarked) cloud.classList.add('dim');
  if (store.state.selection.includes(entry.id)) cloud.classList.add('selected');
  // Halo: the thought is open in the editor (§2.2.4) — a single click, Enter
  // or a pick from the structures/chronicle view.
  const editorTarget = store.state.editorTarget;
  if (editorTarget?.kind === 'thought' && editorTarget.id === entry.id) {
    cloud.classList.add('halo');
  }

  const style = resolveCloudStyle(
    ref ?? {
      type_id: null,
      fg_color: null,
      bg_color: null,
      font_bold: false,
      font_italic: false,
      font_underline: false,
      font_strike: false,
    },
  );
  applyCloudStyle(cloud, style);

  // Ellipses are filled by whether the thought has ANY incoming/outgoing link
  // (so a chain continues off-screen), not by which zone it sits in.
  const neighbor = entry.links[0];
  const topEllipse = div('ellipse ellipse-top');
  const bottomEllipse = div('ellipse ellipse-bottom');
  const hasIn = neighbor?.has_incoming === true;
  const hasOut = neighbor?.has_outgoing === true;
  if (hasIn) topEllipse.classList.add('filled');
  if (hasOut) bottomEllipse.classList.add('filled');
  setTooltip(topEllipse, hasIn ? 'Есть входящие связи' : 'Входящих связей нет');
  setTooltip(bottomEllipse, hasOut ? 'Есть исходящие связи' : 'Исходящих связей нет');
  wireEllipseDrag(topEllipse, entry.id, 'parent');
  wireEllipseDrag(bottomEllipse, entry.id, 'child');

  const iconBox = div('cloud-icon');
  applyThoughtIcon(iconBox, ref ?? { icon: null, icon_kind: 'emoji', type_id: null });
  // Prefer the live neighbour title (fresh from the focus response) over the
  // cached ref, which can lag behind after a rename until re-resolved.
  const cloudTitleFull = entry.links[0]?.title ?? ref?.title ?? '—';
  // Outside the focus, compound names hide the parts matching visible related
  // thoughts (08-ui-spec.md §2.2.3); the tooltip keeps the full name.
  const cloudTitle = shortenCompoundName(cloudTitleFull, relatedTitles.get(entry.id) ?? []);
  const title = el('div', 'cloud-title', cloudTitle);
  setTooltip(title, cloudTitleFull);
  markNeighborsPreview(topEllipse, entry.id, neighborsDirForEllipse('top'), cloudTitleFull);
  markNeighborsPreview(bottomEllipse, entry.id, neighborsDirForEllipse('bottom'), cloudTitleFull);

  const ind = div('cloud-ind');
  const perm = span('📝', 'ind dim');
  const chrono = span('📅', 'ind dim');
  const att = span('📎', 'ind dim');
  markCommentPreview(perm, 'thought', entry.id, cloudTitleFull);
  markChronoPreview(chrono, 'thought', entry.id, cloudTitleFull);
  markAttachmentsPreview(att, 'thought', entry.id, cloudTitleFull);
  ind.append(perm, chrono, att);

  const main = div('cloud-main');
  main.append(title, ind);

  // Manual-order position indicator (08-ui-spec.md §2.2): small black badge
  // in the right-bottom corner, number = position+1 (1-based). Shown only when
  // the zone is sorted `manual` AND the thought has an actual entry in
  // `user_focus_order`. For newly added thoughts in a `manual`-sorted zone
  // there is no entry yet — the indicator stays hidden until the user gives
  // it a position via Ctrl+Shift+↑/↓ or a drag.
  const posBadge = div('cloud-pos');
  if (position === null) {
    posBadge.hidden = true;
  } else {
    posBadge.textContent = String(position + 1);
    posBadge.title = `Позиция в зоне: ${position + 1}`;
  }

  cloud.append(topEllipse, iconBox, main, bottomEllipse, posBadge);
  if (isMarked) {
    cloud.append(buildTrashBadge(entry.id, cloudTitleFull));
  }
  markOverriddenCloud(cloud, entry.id);

  // Single click → open the thought in the editor + halo (§2.2.4); double
  // click → focus (B1); Ctrl+click toggles selection (H16); right-click opens
  // the context menu (H15). The cloud stays tab-focusable (clouds re-enable
  // the pointer inside the pointer-transparent grids) — Enter and the arrows
  // are handled by the canvas keyboard navigation (kbd-nav.ts).
  cloud.tabIndex = 0;
  // The single-click action is deferred so the browser can deliver a
  // matching `dblclick` first — every double-click fires two `click` events
  // first, and processing the first one used to push the editor target
  // twice in a row (once for the click, once for the focus that the
  // dblclick triggers), producing the "double-click handled as two events"
  // shake. The deferred click is cancelled by the dblclick handler below.
  let pendingClick: { cancel: () => void } | null = null;
  cloud.addEventListener('click', (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    logUiEvent('ui.cloud.click', { id: entry.id });
    if (event.ctrlKey || event.metaKey) {
      pendingClick?.cancel();
      pendingClick = null;
      selectionHooks?.onCloudClick(entry.id);
      return;
    }
    // Click selects the cloud as the keyboard cursor so subsequent arrows
    // (and Ctrl+Shift+←/→ in manual mode) move from the just-clicked cloud,
    // not from whichever cloud the cursor happened to be on. The editor
    // halo and the cursor frame are independent — both follow this click.
    pendingClick?.cancel();
    pendingClick = deferSingleClick(() => {
      pendingClick = null;
      setCursor(entry.id);
      openThoughtInEditor(entry.id);
    });
  });
  cloud.addEventListener('dblclick', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    pendingClick?.cancel();
    pendingClick = null;
    void setFocus(entry.id);
  });
  cloud.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showThoughtContextMenu(event, {
      id: entry.id,
      title: entry.ref?.title ?? entry.id,
      dir,
    });
  });

  return cloud;
}

// ---------------------------------------------------------------------------
// Ctrl-hover ellipse neighbours preview (task «Распространить предпросмотр с
// зажатым Ctrl на эллипсы облачков мыслей») — registers a `neighbors` content
// resolver with the shared `lib/hover-preview.ts` engine. Lives here (not in
// hover-preview.ts itself) because it needs `applyCloudStyle`/
// `resolveCloudStyle`/`applyThoughtIcon`, and hover-preview.ts must not import
// canvas.ts (module doc comment there) — canvas.ts already imports
// hover-preview.ts for the mark* trigger helpers, so importing back would
// close a cycle.
// ---------------------------------------------------------------------------

/** Resolves a batch of thought ids into full `ThoughtRef`s, chunked at the
 *  server's `thoughts.resolve` cap (same pattern as `selection.ts`). */
async function resolveNeighborRefs(networkId: string, ids: string[]): Promise<ThoughtRef[]> {
  const refs: ThoughtRef[] = [];
  for (let i = 0; i < ids.length; i += THOUGHT_RESOLVE_MAX_IDS) {
    const chunk = await etn.thoughts.resolve(networkId, ids.slice(i, i + THOUGHT_RESOLVE_MAX_IDS));
    refs.push(...chunk);
  }
  return refs;
}

/** One row of the neighbours-preview list — same visual pattern as
 *  `editor/links-tab.ts`'s `endpointRow`/`linkRow`: icon + own/type style,
 *  dimmed when inactive, no indicators of its own, nested Ctrl-hover shows
 *  the row's own permanent comment. A click/double-click navigates AND closes
 *  this popup (a lingering popup over content that just changed reads as a
 *  bug — no existing precedent does this navigate-from-inside-a-popup
 *  gesture, so the close is explicit here). */
function neighborPreviewRow(ref: ThoughtRef): HTMLElement {
  const row = div('link-group-item');
  applyCloudStyle(row, resolveCloudStyle(ref));
  const icon = span('', 'mini-icon');
  applyThoughtIcon(icon, ref);
  const title = el('span', 'link-item-title', ref.title);
  if (!ref.active) row.classList.add('dim');
  row.append(icon, title);
  markThoughtCommentPreview(row, ref.id, ref.title);
  // Same single/double-click interplay as the clouds themselves: the first
  // click defers the "open in editor" action so a quick second click cancels
  // it and the dblclick focus action runs instead — an immediate single-click
  // handler would close the popup on the first click and kill the dblclick.
  let pendingClick: { cancel: () => void } | null = null;
  row.addEventListener('click', () => {
    logUiEvent('ui.cloud.click', { id: ref.id });
    pendingClick?.cancel();
    pendingClick = deferSingleClick(() => {
      pendingClick = null;
      closeHoverPreview();
      openThoughtInEditor(ref.id);
    });
  });
  row.addEventListener('dblclick', () => {
    pendingClick?.cancel();
    pendingClick = null;
    closeHoverPreview();
    void setFocus(ref.id);
  });
  return row;
}

/** Builds the `neighbors` popup content: incoming/outgoing links of the
 *  triggering ellipse's thought, alphabetical, scrollable, capped at 70%
 *  height / 25% width of the canvas viewport. Empty list → `null` (no popup),
 *  per spec — mirrors the built-in resolvers' "nothing to show" convention. */
async function resolveNeighborsPreview(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  const thoughtId = trigger.dataset['hpOwnerId'];
  const dir = trigger.dataset['hpDir'];
  const networkId = store.state.networkId;
  if (
    thoughtId === undefined ||
    thoughtId === '' ||
    (dir !== 'parents' && dir !== 'children') ||
    networkId === null
  ) {
    return null;
  }
  let neighbors: FocusNeighbor[];
  try {
    neighbors = await etn.thoughts.neighbors(networkId, thoughtId, dir, NEIGHBORS_PREVIEW_LIMIT);
  } catch {
    return null;
  }
  const ids = [...new Set(neighbors.map((n) => n.id))];
  if (ids.length === 0) return null;
  let refs: ThoughtRef[];
  try {
    refs = await resolveNeighborRefs(networkId, ids);
  } catch {
    return null;
  }
  if (refs.length === 0) return null;
  const body = div('link-group-rows');
  for (const ref of sortRefsByTitle(refs)) body.append(neighborPreviewRow(ref));
  const bounds = host !== null ? neighborsPreviewBounds(host.getBoundingClientRect()) : null;
  return {
    title: neighborsPreviewHeading(dir, trigger.dataset['hpTitle'] ?? '—'),
    body,
    maxWidthPx: bounds?.maxWidthPx,
    maxHeightPx: bounds?.maxHeightPx,
  };
}

registerHoverPreviewResolver('neighbors', resolveNeighborsPreview);

// ---------------------------------------------------------------------------
// Indicators (lazy, cached)
// ---------------------------------------------------------------------------

/**
 * Enqueues an indicator fetch for a thought (deduplicated, cached). Exported
 * so the structures tree can share the same cache/queue for its clouds (L15,
 * 08-ui-spec.md §15.4: clouds match the canvas 1-to-1, indicators included).
 */
export function queueIndicatorLoad(id: string): void {
  // Clouds are rebuilt on scroll/resize (virtualized zones); a cached value
  // must be re-applied to the fresh DOM instead of being skipped.
  const cached = indicatorCache.get(id);
  if (cached !== undefined) {
    applyIndicators(id, cached);
    return;
  }
  if (indicatorQueue.includes(id)) return;
  indicatorQueue.push(id);
  scheduleIndicatorLoads();
}

/** Drains the indicator queue with bounded concurrency. */
function scheduleIndicatorLoads(): void {
  while (indicatorRunning < INDICATOR_CONCURRENCY && indicatorQueue.length > 0) {
    const id = indicatorQueue.shift();
    if (id === undefined) break;
    indicatorRunning++;
    void loadIndicators(id).finally(() => {
      indicatorRunning--;
      scheduleIndicatorLoads();
    });
  }
}

/** Fetches comment/attachment counts for a thought and patches its clouds. */
async function loadIndicators(id: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const [comments, attachments] = await Promise.all([
      etn.comments.list(networkId, 'thought', id),
      etn.attachments.list(networkId, 'thought', id),
    ]);
    const info: IndicatorInfo = {
      permanent: comments.some((c) => c.kind === 'permanent'),
      chrono: comments.filter((c) => c.kind === 'chronological').length,
      attachments: attachments.length,
    };
    indicatorCache.set(id, info);
    applyIndicators(id, info);
  } catch {
    // Counts stay unknown — the indicators remain grey.
  }
}

/**
 * Patches indicator cells of every rendered cloud with this id, on the canvas
 * AND the structures tree (both render the same `.cloud`/`.cloud-ind` markup,
 * 08-ui-spec.md §15.4) — queried document-wide, not scoped to the canvas host.
 */
function applyIndicators(id: string, info: IndicatorInfo): void {
  for (const cloud of document.querySelectorAll<HTMLElement>(`.cloud[data-id="${id}"]`)) {
    const cells = cloud.querySelectorAll<HTMLElement>('.cloud-ind .ind');
    const perm = cells[0];
    const chrono = cells[1];
    const att = cells[2];
    if (perm === undefined || chrono === undefined || att === undefined) continue;
    if (info.permanent) {
      perm.textContent = '📝';
      perm.classList.remove('dim');
      perm.classList.add('active');
      perm.title = 'Есть постоянный комментарий';
    } else {
      // Explicitly dim: this may re-patch a previously active cell (the
      // permanent comment was deleted while the cloud stayed rendered).
      perm.classList.add('dim');
      perm.classList.remove('active');
      perm.title = 'Постоянного комментария нет';
    }
    chrono.textContent = `📅${info.chrono}`;
    chrono.classList.toggle('dim', info.chrono === 0);
    chrono.classList.toggle('active', info.chrono > 0);
    chrono.title = `Хронологических комментариев: ${info.chrono}`;
    att.textContent = `📎${info.attachments}`;
    att.classList.toggle('dim', info.attachments === 0);
    att.classList.toggle('active', info.attachments > 0);
    att.title = `Вложений: ${info.attachments}`;
  }
}

/** Test seam for unit tests. */
export const canvasInternals = {
  groupByThought,
  resolveCloudStyle,
  refCache,
  indicatorCache,
  canvasRenderKey,
  selectionKey,
  deferSingleClick,
  SINGLE_CLICK_DELAY_MS,
};

// ---------------------------------------------------------------------------
// Ellipse drag (08-ui-spec.md §2.3, 09-scenarios.md C4)
// ---------------------------------------------------------------------------

/**
 * Wires a mouse-drag gesture on an ellipse. On release:
 *  - over another thought cloud → direct link creation;
 *  - anywhere else → the registered add-thought dialog opener.
 *
 * Hovering an ellipse highlights it and every visible link of its direction
 * (the link overlay's {@link setEllipseHover}).
 */
function wireEllipseDrag(
  ellipse: HTMLElement,
  anchorId: string,
  direction: 'parent' | 'child',
): void {
  ellipse.addEventListener('mouseenter', (event) => {
    // Ctrl+Shift is the zone reorder drag — hovering an ellipse must not
    // highlight it or its links: only the clouds matter for the insertion
    // preview.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey) return;
    setEllipseHover({ thoughtId: anchorId, direction });
  });
  ellipse.addEventListener('mouseleave', () => {
    setEllipseHover(null);
  });
  ellipse.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    // Ctrl+click on an ellipse adds all parents/children to the selection (H16);
    // Ctrl+Shift is the zone reorder drag (drag-cloud.ts) — that press must
    // reach the cloud gesture, so let it bubble untouched.
    if (event.ctrlKey || event.metaKey) {
      if (event.shiftKey) return;
      event.preventDefault();
      selectionHooks?.onEllipseClick(anchorId, direction);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    drag = {
      anchorId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      hovered: null,
      sourceEl: ellipse,
    };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  });
}

/**
 * Elements the ellipse drag can land on for a direct link: a zone cloud, a
 * pinned chip, a history mini-cloud (toolbar or dropdown) or a pinned/history
 * dropdown row — every place a single thought is rendered as more than plain
 * text (08-ui-spec.md §2.3.1). A drop anywhere else falls through to the
 * add-thought dialog. Cloud-drag (drag-cloud.ts) treats the list panels
 * differently (open/pin/select) because dragging a *whole* cloud there reads
 * as "do something with this thought here"; dragging just an *ellipse* is an
 * explicit link gesture, so every thought representation is a valid target
 * regardless of where it lives (bug: dropping onto a pinned chip used to miss
 * the `.cloud` check and open the add dialog instead of linking).
 */
const ELLIPSE_DROP_TARGET_SELECTOR =
  '.cloud[data-id], .pinned-chip[data-id], .history-cloud[data-id], .menu-item[data-drag-id]';

/** Reads the thought id off a resolved ellipse-drop target element. */
function ellipseDropId(dropEl: HTMLElement): string | null {
  return dropEl.dataset['id'] ?? dropEl.dataset['dragId'] ?? null;
}

/** Tracks the drag, highlighting the thought (cloud or list chip) under the cursor. */
function onDragMove(event: MouseEvent): void {
  if (drag === null) return;
  if (!drag.active) {
    const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (dist < DRAG_THRESHOLD_PX) return;
    drag.active = true;
    drag.sourceEl.classList.add('drag-source');
    document.body.classList.add('dragging');
    suppressNextClick = true;
  }
  // The pending-link line follows the cursor from the dragged ellipse's centre.
  const rect = drag.sourceEl.getBoundingClientRect();
  setDragLinkLine({
    from: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    to: { x: event.clientX, y: event.clientY },
  });
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const dropEl =
    target instanceof HTMLElement
      ? target.closest<HTMLElement>(ELLIPSE_DROP_TARGET_SELECTOR)
      : null;
  if (drag.hovered !== null && drag.hovered !== dropEl) {
    drag.hovered.classList.remove('drop-target');
  }
  drag.hovered = dropEl;
  if (dropEl !== null && ellipseDropId(dropEl) !== drag.anchorId) {
    dropEl.classList.add('drop-target');
  } else if (dropEl !== null) {
    drag.hovered = null;
  }
}

/** Ends the drag: creates a link or opens the add dialog. */
function onDragEnd(_event: MouseEvent): void {
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
  if (drag === null) return;
  const wasActive = drag.active;
  const anchorId = drag.anchorId;
  const direction = drag.direction;
  const hoveredId = drag.hovered !== null ? ellipseDropId(drag.hovered) : null;
  if (drag.hovered !== null) drag.hovered.classList.remove('drop-target');
  drag.sourceEl.classList.remove('drag-source');
  setDragLinkLine(null);
  drag = null;
  document.body.classList.remove('dragging');

  if (!wasActive) return;

  if (hoveredId !== null && hoveredId !== anchorId) {
    void createLinkFromDrop(direction, anchorId, hoveredId);
    return;
  }
  if (addDialogOpener !== null) {
    addDialogOpener({ anchorId, direction });
  } else {
    notice('Диалог добавления мыслей ещё не готов.', 'error');
  }
}

/** Creates a link between two thoughts after a successful drop (C4). */
async function createLinkFromDrop(
  direction: 'parent' | 'child',
  anchorId: string,
  droppedId: string,
): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const sourceId = direction === 'child' ? anchorId : droppedId;
  const targetId = direction === 'child' ? droppedId : anchorId;
  try {
    await etn.links.create(networkId, { source_id: sourceId, target_id: targetId });
    // The acting client gets no realtime echo (04-realtime.md §5) — refresh
    // explicitly so the new edge, the zone move and the editor's «Связи»
    // update, and animate the thought flowing into its new zone.
    requestZoneAnimation();
    scheduleRefresh();
    notice('Связь создана.');
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'DUPLICATE') {
      notice('Такая связь уже существует.');
      return;
    }
    notice(
      `Не удалось создать связь: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  }
}
