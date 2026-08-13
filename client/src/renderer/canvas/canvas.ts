/**
 * Canvas engine (H4/H5): virtualized grid zones, thought clouds, the focus
 * cloud, ellipses and drag gestures (08-ui-spec.md §2.1–2.3, 09-scenarios.md
 * B1/C4).
 *
 * - Four areas: parents (top-left), siblings (top-right), focus row (center),
 *   children (bottom, full width). Grid zones are virtualized (visible window +
 *   overscan inside a CSS grid over a full-height spacer, §2.1.1, §2.5).
 * - A cloud is: icon square + clamped title (2 lines, `…`, full text in the
 *   tooltip) + indicators row (📝/📅/📎) + top/bottom ellipses (§2.2).
 * - The focus cloud has a variable width and up to 4 title lines (§2.2.2).
 * - Cloud colors/styles come from the thought (own values win) falling back to
 *   the thought type catalogue; inactive thoughts are dimmed (§2.2).
 * - Click on a thought → focus (B1). Dragging from an ellipse: dropped on
 *   another thought → direct link (C4); otherwise → add-thought dialog (H14
 *   registers the opener via {@link setAddDialogOpener}).
 * - Indicator counts load lazily per visible cloud and are cached; realtime
 *   comment/attachment events invalidate the cache.
 */

import type { FocusNeighbor, FocusResponse, ThoughtRef } from '@etn/shared';

import { setFocus } from '../app.js';
import { clear, div, el, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { cloudFontSize, cloudHeight } from '../lib/pure.js';
import { store } from '../state.js';
import { initLinksOverlay } from './links.js';
import { mountAddDialog, wireZoneExternalDrops } from './add-dialog.js';
import { showThoughtContextMenu, showZoneContextMenu } from './context-menu.js';
import { wireCloudDrag } from './drag-cloud.js';

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
const DRAG_THRESHOLD_PX = 4;

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
  top.append(zoneParents, zoneSiblings);

  focusRow = div('canvas-focus-row');

  const zoneChildren = buildZone('children');

  const empty = div('canvas-empty');
  empty.textContent = 'Нет открытой сети';

  host.append(top, focusRow, zoneChildren, empty);
  zones = { parents: zoneParents, siblings: zoneSiblings, children: zoneChildren };
  emptyEl = empty;
  redrawLinks = initLinksOverlay(host).redraw;

  // Add-thought dialog (H14) and external file/URL drops (08-ui-spec.md §7).
  mountAddDialog();
  wireZoneExternalDrops({ parents: zoneParents, children: zoneChildren });
  // Internal cloud drag-n-drop (move / link / reorder / copy) — one delegation
  // point on the canvas host; siblings are handled there as a non-target.
  wireCloudDrag(host, {
    getZoneEl: (dir) => zones?.[dir] ?? null,
    getZoneOrder: (dir) => store.state.zoneOrder[dir],
  });

  store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
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

/** Invalidates cached indicator counts (realtime comment/attachment events). */
export function invalidateIndicators(id: string | null): void {
  if (id === null) {
    indicatorCache.clear();
  } else {
    indicatorCache.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Renders everything from the current store state. */
async function render(): Promise<void> {
  if (host === null || zones === null || focusRow === null) return;
  const focus = store.state.focus;
  if (focus === null) {
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  // Enrich neighbour metadata (colors/fonts/icon_kind are not in FocusNeighbor).
  await enrichRefs(focus);
  renderFocusRow(focus);
  renderZone('parents', groupByThought(focus.parents));
  renderZone('siblings', groupByThought(focus.siblings));
  renderZone('children', groupByThought(focus.children));
  scheduleIndicatorLoads();
  redrawLinks?.();
}

/**
 * Renders the focus cloud (08-ui-spec.md §2.2.2): variable width, up to 4
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

  const topEllipse = div('ellipse');
  const bottomEllipse = div('ellipse');
  if (parents > 0) topEllipse.classList.add('filled');
  if (children > 0) bottomEllipse.classList.add('filled');
  setTooltip(topEllipse, `Входящие связи: ${parents}`);
  setTooltip(bottomEllipse, `Исходящие связи: ${children}`);
  wireEllipseDrag(topEllipse, thought.id, 'parent');
  wireEllipseDrag(bottomEllipse, thought.id, 'child');

  const body = div('cloud-body');
  const iconBox = div('cloud-icon');
  if (thought.icon_kind === 'image' && thought.icon !== null) {
    const img = el('img');
    img.src = thought.icon;
    img.alt = '';
    iconBox.append(img);
  } else {
    iconBox.textContent = thought.icon ?? '💭';
  }
  const title = el('div', 'cloud-title', thought.title);
  setTooltip(title, thought.title.slice(0, 400));
  body.append(iconBox, title);

  const ind = div('cloud-ind');
  ind.append(span('📝', 'ind dim'), span('📅', 'ind dim'), span('📎', 'ind dim'));

  cloud.append(topEllipse, body, ind, bottomEllipse);
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
  renderZoneContent(dir);
}

/** Per-zone entry lists, kept between scroll-triggered re-renders. */
const zoneData = new Map<'parents' | 'siblings' | 'children', ZoneEntry[]>();

/** Renders the visible window of one zone (virtualized grid). */
function renderZoneContent(dir: 'parents' | 'siblings' | 'children'): void {
  if (zones === null) return;
  const zone = zones[dir];
  const entries = zoneData.get(dir) ?? [];
  const spacer = zone.querySelector<HTMLElement>('.zone-spacer');
  const grid = zone.querySelector<HTMLElement>('.zone-grid');
  const empty = zone.querySelector<HTMLElement>('.zone-empty');
  if (spacer === null || grid === null || empty === null) return;

  const width = store.state.cloudWidth;
  const gap = store.state.cloudGap;
  const cellW = width + gap;
  const cellH = cloudHeight(width) + gap;

  zone.style.setProperty('--cloud-width', `${width}px`);
  zone.style.setProperty('--cloud-gap', `${gap}px`);
  zone.style.setProperty('--cloud-font', `${cloudFontSize(width)}px`);

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

  grid.style.gridTemplateColumns = `repeat(${cols}, ${width}px)`;
  grid.style.gridAutoRows = `${cloudHeight(width)}px`;
  grid.style.columnGap = `${gap}px`;
  grid.style.rowGap = `${gap}px`;

  const startRow = Math.max(0, Math.floor(zone.scrollTop / cellH) - OVERSCAN_ROWS);
  const endRow = Math.min(
    rows,
    Math.ceil((zone.scrollTop + zone.clientHeight) / cellH) + OVERSCAN_ROWS,
  );

  spacer.style.height = `${rows * cellH}px`;
  grid.style.transform = `translateY(${startRow * cellH}px)`;

  clear(grid);
  const first = startRow * cols;
  const last = Math.min(entries.length, endRow * cols);
  for (let i = first; i < last; i++) {
    const entry = entries[i];
    if (entry !== undefined) grid.append(buildCloud(entry, dir));
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
    bold: thought.font_bold || (type?.font_bold ?? false),
    italic: thought.font_italic || (type?.font_italic ?? false),
    underline: thought.font_underline || (type?.font_underline ?? false),
    strike: thought.font_strike || (type?.font_strike ?? false),
  };
}

/** Applies a resolved style to a cloud element. */
function applyCloudStyle(cloud: HTMLElement, style: CloudStyle): void {
  if (style.fg !== null) cloud.style.color = style.fg;
  if (style.bg !== null) cloud.style.background = style.bg;
  cloud.classList.toggle('font-bold', style.bold);
  cloud.classList.toggle('font-italic', style.italic);
  cloud.classList.toggle('font-underline', style.underline);
  cloud.classList.toggle('font-strike', style.strike);
}

/** Builds one zone cloud element. */
function buildCloud(entry: ZoneEntry, dir: 'parents' | 'siblings' | 'children'): HTMLElement {
  const ref = entry.ref;
  const cloud = div('cloud');
  cloud.dataset['id'] = entry.id;
  cloud.dataset['dir'] = dir;

  if (ref !== null && !ref.active) cloud.classList.add('dim');
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

  // Ellipses: parents link OUT of themselves (bottom filled), children link IN
  // (top filled); siblings carry no link info from the focus response.
  const topEllipse = div('ellipse');
  const bottomEllipse = div('ellipse');
  if (dir === 'children') topEllipse.classList.add('filled');
  if (dir === 'parents') bottomEllipse.classList.add('filled');
  setTooltip(topEllipse, dir === 'children' ? 'Входящие связи' : 'Входящих связей нет');
  setTooltip(bottomEllipse, dir === 'parents' ? 'Исходящие связи' : 'Исходящих связей нет');
  wireEllipseDrag(topEllipse, entry.id, 'parent');
  wireEllipseDrag(bottomEllipse, entry.id, 'child');

  const body = div('cloud-body');
  const iconBox = div('cloud-icon');
  if (ref?.icon_kind === 'image' && ref.icon !== null) {
    const img = el('img');
    img.src = ref.icon;
    img.alt = '';
    iconBox.append(img);
  } else {
    iconBox.textContent = ref?.icon ?? '💭';
  }
  // Prefer the live neighbour title (fresh from the focus response) over the
  // cached ref, which can lag behind after a rename until re-resolved.
  const cloudTitle = entry.links[0]?.title ?? ref?.title ?? '—';
  const title = el('div', 'cloud-title', cloudTitle);
  setTooltip(title, cloudTitle);
  body.append(iconBox, title);

  const ind = div('cloud-ind');
  const perm = span('📝', 'ind dim');
  const chrono = span('📅', 'ind dim');
  const att = span('📎', 'ind dim');
  ind.append(perm, chrono, att);

  cloud.append(topEllipse, body, ind, bottomEllipse);

  // Click → focus (B1); Ctrl+click toggles selection (H16); Enter on a
  // keyboard-focused cloud focuses it; right-click opens the context menu (H15).
  cloud.tabIndex = 0;
  cloud.draggable = dir !== 'siblings';
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

  queueIndicatorLoad(entry.id);
  return cloud;
}

// ---------------------------------------------------------------------------
// Indicators (lazy, cached)
// ---------------------------------------------------------------------------

/** Enqueues an indicator fetch for a thought (deduplicated, cached). */
function queueIndicatorLoad(id: string): void {
  if (indicatorCache.has(id) || indicatorQueue.includes(id)) return;
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
      perm.title = 'Постоянного комментария нет';
    }
    chrono.textContent = `📅 ${info.chrono}`;
    chrono.classList.toggle('dim', info.chrono === 0);
    chrono.classList.toggle('active', info.chrono > 0);
    chrono.title = `Хронологических комментариев: ${info.chrono}`;
    att.textContent = `📎 ${info.attachments}`;
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
 */
function wireEllipseDrag(
  ellipse: HTMLElement,
  anchorId: string,
  direction: 'parent' | 'child',
): void {
  ellipse.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    // Ctrl+click on an ellipse adds all parents/children to the selection (H16).
    if (event.ctrlKey || event.metaKey) {
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
    notice('Связь создана.');
  } catch (err) {
    notice(
      `Не удалось создать связь: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  }
}
