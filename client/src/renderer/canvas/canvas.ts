/**
 * Canvas engine (H4): virtualized grid zones and thought clouds
 * (08-ui-spec.md §2.1.1, §2.2, §2.2.1).
 *
 * - Four areas: parents (top-left), siblings (top-right), focus row (center),
 *   children (bottom, full width). Only the grid zones (parents/siblings/
 *   children) are virtualized here; the focus cloud lands in H5.
 * - Grid cells are fixed (`cloud_width` + `cloud_gap`, L4 settings); the number
 *   of columns is recomputed on resize; rows are virtualized: only the visible
 *   window plus overscan is rendered inside a CSS grid translated to the
 *   window offset, over a full-height spacer (spec §2.1.1, §2.5).
 * - A cloud is: icon square + 2-line title (clamped with `…`, full text in the
 *   tooltip) + indicators row (📝/📅/📎) + top/bottom ellipses (§2.2).
 * - Cloud colors/styles come from the thought (own values win) falling back to
 *   the thought type catalogue; inactive thoughts are dimmed (§2.2).
 * - Indicator counts (📝/📅N/📎N) load lazily per visible cloud and are cached;
 *   realtime comment/attachment events invalidate the cache.
 */

import type { FocusNeighbor, FocusResponse, ThoughtRef } from '@etn/shared';

import { clear, div, el, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { cloudFontSize, cloudHeight } from '../lib/pure.js';
import { store } from '../state.js';

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

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
let zones: Record<'parents' | 'siblings' | 'children', HTMLElement> | null = null;
let focusRow: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;

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

  store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
  void render();
}

/** Returns the cached metadata for a thought id, or null. */
export function getRef(id: string): ThoughtRef | null {
  return refCache.get(id) ?? null;
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
}

/**
 * H4 placeholder for the focus row — the real focus cloud (variable width, up
 * to 4 title lines, ellipses) arrives in H5.
 */
function renderFocusRow(focus: FocusResponse): void {
  if (focusRow === null) return;
  clear(focusRow);
  focusRow.append(el('span', 'muted', `Фокус: ${focus.focused.title}`));
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
  const title = el('div', 'cloud-title', ref?.title ?? '—');
  setTooltip(title, ref?.title ?? '');
  body.append(iconBox, title);

  const ind = div('cloud-ind');
  const perm = span('📝', 'ind dim');
  const chrono = span('📅', 'ind dim');
  const att = span('📎', 'ind dim');
  ind.append(perm, chrono, att);

  cloud.append(topEllipse, body, ind, bottomEllipse);
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
