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
 * - Click on a thought → focus (B1). Dragging from an ellipse: dropped on
 *   another thought → direct link (C4); otherwise → add-thought dialog (H14
 *   registers the opener via {@link setAddDialogOpener}).
 * - Indicator counts load lazily per visible cloud and are cached; realtime
 *   comment/attachment events invalidate the cache.
 */

import type { FocusNeighbor, FocusResponse, IconKind, ThoughtRef } from '@etn/shared';

import { scheduleRefresh, setFocus } from '../app.js';
import { clear, div, el, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import {
  CLOUD_TITLE_LINES_MIN,
  cloudGeom,
  cloudHeight,
  contrastText,
} from '../lib/pure.js';
import { store } from '../state.js';
import {
  initLinksOverlay,
  drawLinksNow,
  invalidateLinkCounts,
  setEllipseHover,
  LINK_LABEL_FONT_BASE,
} from './links.js';
import {
  captureClouds,
  playFocusTransition,
  prefersReducedMotion,
} from './transition.js';
import { mountAddDialog, wireZoneExternalDrops } from './add-dialog.js';
import { showThoughtContextMenu, showZoneContextMenu } from './context-menu.js';
import { wireCloudDrag } from './drag-cloud.js';
import { mountZoneSplitters } from './zone-splitters.js';

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
  mountZoneSplitters({ host, top, focusRow, vertical: zoneSplitterV, horizontal: zoneSplitterH, onLayoutChange: updateFocusBand });

  // Add-thought dialog (H14) and external file/URL drops (08-ui-spec.md §7).
  mountAddDialog();
  wireZoneExternalDrops({ parents: zoneParents, children: zoneChildren });
  // Internal cloud drag-n-drop (move / link / reorder / copy) — one delegation
  // point on the canvas host; siblings are handled there as a non-target.
  wireCloudDrag(host, {
    getZoneEl: (dir) => zones?.[dir] ?? null,
    getZoneOrder: (dir) => store.state.zoneOrder[dir],
  });
  // A click not on a link line clears the sticky link selection and returns the
  // editor to the focused thought (editorTarget=null → editor follows the focus).
  host.addEventListener('click', (event) => {
    const t = event.target as HTMLElement | null;
    const onLine = t?.closest('.link-hit, .link-line') ?? null;
    if (
      onLine === null &&
      (store.state.selectedLinkId !== null || store.state.editorTarget !== null)
    ) {
      store.update({ selectedLinkId: null, editorTarget: null });
    }
  });

  store.subscribe(() => {
    if (host?.isConnected === true) void render();
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

/** Renders everything from the current store state. */
async function render(): Promise<void> {
  if (host === null || zones === null || focusRow === null) return;
  applyCanvasScaleVars(host);
  const focus = store.state.focus;
  if (focus === null) {
    emptyEl?.classList.remove('hidden');
    resetFocusBand(host);
    return;
  }
  emptyEl?.classList.add('hidden');

  // Focus-change choreography (08-ui-spec.md §2.8): snapshot the old clouds
  // before the rebuild, then FLIP/ghost them after it. Other re-renders
  // (edits, selection, realtime refresh of the same focus) are not animated —
  // except when a link-affecting change requested the zone transition so a
  // thought that changed zones visibly flows there (§2.1 exclusivity).
  const focusChanged = focus.focused.id !== lastFocusId;
  const animate = (focusChanged || zoneAnimationPending) && !prefersReducedMotion();
  zoneAnimationPending = false;
  const snapshot = animate ? captureClouds(host) : null;

  // The focused thought is always fresh in the focus response — refresh the
  // neighbour cache so its (possibly just-edited) style, icon and title show
  // correctly when it later appears in a zone instead of the focus row.
  refCache.set(focus.focused.id, focus.focused);

  // Enrich neighbour metadata (colors/fonts/icon_kind are not in FocusNeighbor).
  await enrichRefs(focus);
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
}

/** Focus id of the last render — gates the transition choreography (§2.8). */
let lastFocusId: string | null = null;

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
  if (!thought.active) cloud.classList.add('dim');
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

  const iconBox = div('cloud-icon');
  // Same resolution as zone clouds: the thought's own icon wins, else the
  // thought type's default icon (so a typed focus shows the type icon too).
  applyThoughtIcon(iconBox, thought);
  const title = el('div', 'cloud-title', thought.title);
  setTooltip(title, thought.title.slice(0, 400));
  const ind = div('cloud-ind');
  ind.append(span('📝', 'ind dim'), span('📅', 'ind dim'), span('📎', 'ind dim'));
  const main = div('cloud-main');
  main.append(title, ind);

  cloud.append(topEllipse, iconBox, main, bottomEllipse);
  focusRow.append(cloud);
  focusCloudEl = cloud;
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

/** Builds a grid zone with scroll → virtualization wiring. */
function buildZone(dir: 'parents' | 'siblings' | 'children'): HTMLElement {
  const zone = div(`zone zone-${dir}`);
  zone.dataset['dir'] = dir;

  const spacer = div('zone-spacer');
  const grid = div('zone-grid');
  const empty = div('zone-empty');
  empty.textContent = 'нет мыслей';
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
  const cellW = geom.width + geom.gap;
  // Estimate for not-yet-measured rows: the minimum cloud height (1 title
  // line) — most clouds render at it, so scrolling stays stable.
  const estimate = cloudHeight(store.state.cloudWidth, store.state.canvasZoom, CLOUD_TITLE_LINES_MIN);

  if (entries.length === 0) {
    spacer.style.height = '0px';
    empty.classList.remove('hidden');
    clear(grid);
    return;
  }
  empty.classList.add('hidden');

  const padding = 24; // zone padding (12px each side)
  const avail = Math.max(80, zone.clientWidth - padding);
  const cols = Math.max(1, Math.floor(avail / cellW));
  const rows = Math.ceil(entries.length / cols);
  const heights = rowHeights.get(dir) ?? [];
  while (heights.length < rows) heights.push(estimate);

  grid.style.gridTemplateColumns = `repeat(${cols}, ${geom.width}px)`;
  grid.style.gridAutoRows = 'auto'; // each row is as tall as its tallest cloud
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
  // Column-major fill (08-ui-spec.md §2.1.1): a grid slot keeps its visual
  // position, but the entry placed there follows the top-to-bottom reading
  // order — slot i (column i % cols, row i / cols) shows the entry whose
  // column-major index is (i % cols) * rows + floor(i / cols). Sparse last
  // rows (a partial final column) simply stay empty.
  const slotOf = (i: number): number => (i % cols) * rows + Math.floor(i / cols);
  const first = startRow * cols;
  const last = endRow * cols;
  const rowClouds = new Map<number, HTMLElement[]>();
  for (let i = first; i < last; i++) {
    const entry = entries[slotOf(i)];
    if (entry === undefined) continue;
    const cloud = buildCloud(entry, dir);
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
    const entry = entries[slotOf(i)];
    if (entry !== undefined) queueIndicatorLoad(entry.id);
  }
  redrawLinks?.();
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/**
 * Resolves the visual style of a thought: own values win, then the thought
 * type defaults (08-ui-spec.md §2.2).
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
  const type =
    thought.type_id !== null
      ? store.state.thoughtTypes.find((t) => t.id === thought.type_id)
      : undefined;
  return {
    fg: thought.fg_color ?? type?.fg_color ?? null,
    bg: thought.bg_color ?? type?.bg_color ?? null,
    // font_* use null-coalesce (NOT OR): a manual `false` must override a `true`
    // type default, which `||` would wrongly collapse (02-data-model.md §3.1.1).
    bold: thought.font_bold ?? (type?.font_bold ?? false),
    italic: thought.font_italic ?? (type?.font_italic ?? false),
    underline: thought.font_underline ?? (type?.font_underline ?? false),
    strike: thought.font_strike ?? (type?.font_strike ?? false),
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
 * Resolves a thought's icon: its own icon wins, else the thought-type's default
 * icon, else none (the caller falls back to 💬). Returns the icon value together
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
  const type =
    thought.type_id !== null
      ? store.state.thoughtTypes.find((t) => t.id === thought.type_id)
      : undefined;
  if (type?.icon !== null && type?.icon !== undefined) {
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
function buildCloud(entry: ZoneEntry, dir: 'parents' | 'siblings' | 'children'): HTMLElement {
  const ref = entry.ref;
  const cloud = div('cloud');
  cloud.dataset['id'] = entry.id;
  cloud.dataset['dir'] = dir;

  // The live neighbour carries a fresh `active` flag in every focus response —
  // prefer it over the cached ref, which can lag after a local toggle until the
  // ref is re-resolved (no realtime echo to the actor, 04-realtime.md §5).
  const isInactive = (entry.links[0]?.active ?? ref?.active) === false;
  if (isInactive) cloud.classList.add('dim');
  if (store.state.selection.includes(entry.id)) cloud.classList.add('selected');

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
  const cloudTitle = entry.links[0]?.title ?? ref?.title ?? '—';
  const title = el('div', 'cloud-title', cloudTitle);
  setTooltip(title, cloudTitle);

  const ind = div('cloud-ind');
  const perm = span('📝', 'ind dim');
  const chrono = span('📅', 'ind dim');
  const att = span('📎', 'ind dim');
  ind.append(perm, chrono, att);

  const main = div('cloud-main');
  main.append(title, ind);

  cloud.append(topEllipse, iconBox, main, bottomEllipse);

  // Click → focus (B1); Ctrl+click toggles selection (H16); Enter on a
  // keyboard-focused cloud focuses it; right-click opens the context menu (H15).
  cloud.tabIndex = 0;
  cloud.addEventListener('click', (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      selectionHooks?.onCloudClick(entry.id);
      return;
    }
    void setFocus(entry.id);
  });
  cloud.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void setFocus(entry.id);
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
// Indicators (lazy, cached)
// ---------------------------------------------------------------------------

/** Enqueues an indicator fetch for a thought (deduplicated, cached). */
function queueIndicatorLoad(id: string): void {
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

/** Patches indicator cells of every rendered cloud with this id. */
function applyIndicators(id: string, info: IndicatorInfo): void {
  if (host === null) return;
  for (const cloud of host.querySelectorAll<HTMLElement>(`.cloud[data-id="${id}"]`)) {
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
  ellipse.addEventListener('mouseenter', () => {
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

/** Tracks the drag, highlighting the cloud under the cursor. */
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
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const cloud = target instanceof HTMLElement ? target.closest<HTMLElement>('.cloud') : null;
  if (drag.hovered !== null && drag.hovered !== cloud) {
    drag.hovered.classList.remove('drop-target');
  }
  drag.hovered = cloud;
  if (cloud !== null && cloud.dataset['id'] !== drag.anchorId) {
    cloud.classList.add('drop-target');
  } else if (cloud !== null) {
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
  const hoveredId = drag.hovered?.dataset['id'] ?? null;
  if (drag.hovered !== null) drag.hovered.classList.remove('drop-target');
  drag.sourceEl.classList.remove('drag-source');
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
