/**
 * «Структуры мыслей» view (L15, 08-ui-spec.md §15): filter panel on the left,
 * the results tree on the right.
 *
 *  - The tree flattens the filter results plus the user's expansions (parents
 *    up / children down) via the pure helpers in `layout.ts`;
 *  - each expansion fetches one hierarchy level with `exclude_ids` = every
 *    thought already shown in the same root branch (per-branch dedup, §15.5);
 *  - a cloud click opens the thought in the editor WITHOUT switching the canvas
 *    focus and lights the activity band; a connector click opens the link and
 *    dims the band (§15.6–15.7);
 *  - Ctrl+click on clouds/ellipses feeds the shared selection (§15.8);
 *  - clicking a thought pushes it into the per-view structures history (L4).
 */

import {
  STRUCTURES_PAGE_SIZE,
  UI_STATE_KEY,
  type FocusEdge,
  type StructureFilter,
  type StructurePropertyCondition,
  type ThoughtRef,
} from '@etn/shared';

import {
  applyCanvasScaleVars,
  applyCloudStyle,
  applyThoughtIcon,
  queueIndicatorLoad,
  resolveCloudStyle,
} from '../../canvas/canvas.js';
import { showLinkContextMenu, showThoughtContextMenu } from '../../canvas/context-menu.js';
import { edgeGeometry } from '../../canvas/links.js';
import { ELLIPSE_INSIDE } from '../../lib/pure.js';
import { resolveLinkTypeVisual } from '../../lib/type-tree.js';
import { addNeighborsOf, toggleSelection } from '../../selection/selection.js';
import { invalidateHistoryBar } from '../history-bar.js';
import { clear, div, el, setTooltip, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { errText } from '../../lib/dom.js';
import { store } from '../../state.js';
import {
  branchThoughtIds,
  flattenStructuresTree,
  subtreeExpansionKeys,
  type ExpansionMap,
  type HierarchyDir,
  type MoreMarker,
  type TreeRow,
} from './layout.js';
import { initStructuresKbdNav, resetStructuresCursor, syncStructuresCursor } from './kbd-nav.js';
import {
  applyPanelWidth,
  buildConditions,
  buildExtraFilter,
  FILTER_W_MAX,
  FILTER_W_MIN,
  getFilterState,
  mountFilterPanel,
  setFilterState,
  setPanelWidth,
  type FilterState,
} from './filter-panel.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
let resultsHost: HTMLElement | null = null;

/** Filter-result roots in sort order (the visible page, grows with «Показать ещё»). */
let resultIds: string[] = [];
/** Unrestricted match count of the current filter. */
let total = 0;

/** True when the thought id is among the currently displayed results (M11). */
export function isThoughtInResults(id: string): boolean {
  return resultIds.includes(id);
}
/** Known thought metadata: roots + every expanded neighbour. */
const refs = new Map<string, ThoughtRef>();
/**
 * Accumulated neighbor pages per expanded node direction, `${nodeKey}|${dir}`
 * (§15.5 per-node pagination): `neighbors` grows with every «Показать ещё»,
 * `hasMore` reflects the last fetched page's `has_more`.
 */
const hierarchy = new Map<string, { neighbors: ThoughtRef[]; hasMore: boolean }>();
/** Ellipse-fill flags accumulated from hierarchy responses. */
const directions = new Map<string, { has_incoming: boolean; has_outgoing: boolean }>();
/** Every active link among the visible thoughts, deduped by id (§15.6/§6.12). */
const edges = new Map<string, FocusEdge>();
/** Signature of the visible-id set the edges cache was fetched for. */
let edgesSignature = '';
/** Which nodes have parents/children expanded. */
let expansion: ExpansionMap = new Map();

/** Whether the initial filter state and first query already ran for this network. */
let networkIdSeen: string | null = null;
/** Loading guard so the tree does not flicker with stale data. */
let querySeq = 0;

// ---------------------------------------------------------------------------
// View switching (L4 active_view)
// ---------------------------------------------------------------------------

/** Loads the persisted filter state and runs the first query (idempotent).
 *  Called by the shared view switcher (../active-view.js, L20). */
export async function ensureStructuresInitialised(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || host === null) return;
  if (networkIdSeen === networkId) return;
  networkIdSeen = networkId;

  // Reset per-network state (a previous network may still be loaded).
  resultIds = [];
  total = 0;
  refs.clear();
  hierarchy.clear();
  directions.clear();
  edges.clear();
  edgesSignature = '';
  expansion = new Map();
  resetStructuresCursor();

  try {
    const raw = await etn.ui.getState(networkId, UI_STATE_KEY.STRUCTURES_STATE);
    if (raw !== null && raw !== '') setFilterState(parseFilterState(raw));
  } catch {
    // Fall back to the empty filter (HOME).
  }
  await applyQuery(true);
}

/** A tri-state field of the persisted JSON: `true`/`false`, anything else → null. */
function parseTriState(value: unknown): boolean | null {
  return value === true || value === false ? value : null;
}

/** Parses the persisted L4 `structures_state` JSON (unknown input, safe defaults). */
function parseFilterState(raw: string): FilterState {
  try {
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    return {
      keywords: typeof parsed.keywords === 'string' ? parsed.keywords : '',
      parentIds: Array.isArray(parsed.parentIds) ? parsed.parentIds.filter((v) => typeof v === 'string') : [],
      typeIds: Array.isArray(parsed.typeIds) ? parsed.typeIds.filter((v) => typeof v === 'string') : [],
      linkTypeIds: Array.isArray(parsed.linkTypeIds)
        ? parsed.linkTypeIds.filter((v) => typeof v === 'string')
        : [],
      properties: Array.isArray(parsed.properties)
        ? parsed.properties.filter(
            (c): c is FilterState['properties'][number] =>
              typeof c === 'object' && c !== null && typeof c.propertyId === 'string',
          )
        : [],
      hasProperties: parseTriState(parsed.hasProperties),
      hasComment: parseTriState(parsed.hasComment),
      hasAttachments: parseTriState(parsed.hasAttachments),
      hasChronology: parseTriState(parsed.hasChronology),
      active: parseTriState(parsed.active),
      sort: parsed.sort === 'alpha' || parsed.sort === 'created' || parsed.sort === 'viewed' ? parsed.sort : 'created',
      order: parsed.order === 'asc' || parsed.order === 'desc' ? parsed.order : 'asc',
      savedFilterId: typeof parsed.savedFilterId === 'string' ? parsed.savedFilterId : null,
      panelWidth:
        typeof parsed.panelWidth === 'number' &&
        Number.isFinite(parsed.panelWidth)
          ? parsed.panelWidth
          : null,
    };
  } catch {
    return getFilterState();
  }
}

/** Persists the current filter state to the L4 `structures_state` key. */
function persistFilterState(): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.ui
    .setState(networkId, UI_STATE_KEY.STRUCTURES_STATE, JSON.stringify(getFilterState()))
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Builds the wire filter from the panel state (empty arrays dropped). */
function buildFilter(): StructureFilter {
  const state = getFilterState();
  const filter: StructureFilter = { ...buildExtraFilter() };
  if (state.keywords.trim() !== '') filter.keywords = state.keywords.trim();
  if (state.typeIds.length > 0) filter.type_ids = state.typeIds;
  if (state.linkTypeIds.length > 0) filter.link_type_ids = state.linkTypeIds;
  const conditions = buildConditionsFromPanel();
  if (conditions.length > 0) filter.properties = conditions;
  if (store.state.showInactive) filter.show_inactive = true;
  return filter;
}

/** Runs the filter query; `reset` starts a fresh page, otherwise appends. */
async function applyQuery(reset: boolean): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const state = getFilterState();
  const seq = ++querySeq;
  const offset = reset ? 0 : resultIds.length;
  try {
    const result = await etn.structures.query(networkId, {
      ...buildFilter(),
      sort: state.sort,
      order: state.order,
      limit: STRUCTURES_PAGE_SIZE,
      offset,
    });
    if (seq !== querySeq) return; // a newer query won the race
    if (reset) {
      resultIds = result.items.map((r) => r.id);
      expansion = new Map();
      hierarchy.clear();
      // Stale expansion data must not leak into the fresh tree.
      directions.clear();
      edges.clear();
      edgesSignature = '';
    } else {
      const known = new Set(resultIds);
      resultIds = [...resultIds, ...result.items.map((r) => r.id).filter((id) => !known.has(id))];
    }
    total = result.total;
    for (const ref of result.items) refs.set(ref.id, ref);
    // The page carries its own direction flags — the root ellipses are filled
    // right after the query, without waiting for the first expansion (§15.4).
    for (const [id, flags] of Object.entries(result.directions)) directions.set(id, flags);
    renderTree();
  } catch (err) {
    notice(`Ошибка отбора: ${errText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Expansion (§15.5)
// ---------------------------------------------------------------------------

/** Current flattened rows + per-node «Показать ещё» markers (§15.5). */
function currentTree(): { rows: TreeRow[]; moreMarkers: MoreMarker[] } {
  return flattenStructuresTree(resultIds, expansion, neighborsOf);
}

/** Current flattened rows (render + exclude computation share this). */
function currentRows(): TreeRow[] {
  return currentTree().rows;
}

/** Neighbour ids of an expanded node direction, from the hierarchy cache. */
function neighborsOf(nodeKey: string, _thoughtId: string, dir: HierarchyDir): string[] {
  return hierarchy.get(`${nodeKey}|${dir}`)?.neighbors.map((n) => n.id) ?? [];
}

/** Expands or folds one node direction (ellipse click). */
async function toggleExpand(row: TreeRow, dir: HierarchyDir): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const flags = expansion.get(row.key) ?? {};
  if (flags[dir] === true) {
    // Fold: drop the direction and the whole nested expansion state.
    const dropped = subtreeExpansionKeys(row.key, expansion);
    for (const key of dropped) {
      const f = expansion.get(key);
      if (f !== undefined) {
        delete f[dir];
        if (Object.keys(f).length === 0) expansion.delete(key);
        else expansion.set(key, f);
      }
      hierarchy.delete(`${key}|${dir}`);
      hierarchy.delete(`${key}|${dir === 'parents' ? 'children' : 'parents'}`);
    }
    delete flags[dir];
    if (Object.keys(flags).length === 0) expansion.delete(row.key);
    else expansion.set(row.key, flags);
    renderTree();
    return;
  }
  // Expand: fetch one level with the per-branch dedup ids (§15.5).
  const excludeIds = branchThoughtIds(currentRows(), row.rootId);
  try {
    const data = await etn.structures.hierarchy(networkId, row.thoughtId, {
      dir,
      showInactive: store.state.showInactive,
      excludeIds,
    });
    hierarchy.set(`${row.key}|${dir}`, { neighbors: data.neighbors, hasMore: data.has_more });
    for (const ref of data.neighbors) refs.set(ref.id, ref);
    for (const [id, flags] of Object.entries(data.directions)) directions.set(id, flags);
    expansion.set(row.key, { ...flags, [dir]: true });
    renderTree();
  } catch (err) {
    notice(`Не удалось раскрыть: ${errText(err)}`, 'error');
  }
}

/**
 * Fetches the next 100-neighbor page of an already-expanded node direction
 * and appends it to the accumulated cache (§15.5 per-node «Показать ещё»).
 */
async function loadMoreNeighbors(nodeKey: string, thoughtId: string, rootId: string, dir: HierarchyDir): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const cacheKey = `${nodeKey}|${dir}`;
  const cached = hierarchy.get(cacheKey);
  const offset = cached?.neighbors.length ?? 0;
  const excludeIds = branchThoughtIds(currentRows(), rootId);
  try {
    const data = await etn.structures.hierarchy(networkId, thoughtId, {
      dir,
      showInactive: store.state.showInactive,
      excludeIds,
      offset,
    });
    hierarchy.set(cacheKey, {
      neighbors: [...(cached?.neighbors ?? []), ...data.neighbors],
      hasMore: data.has_more,
    });
    for (const ref of data.neighbors) refs.set(ref.id, ref);
    for (const [id, flags] of Object.entries(data.directions)) directions.set(id, flags);
    renderTree();
  } catch (err) {
    notice(`Не удалось загрузить ещё: ${errText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Opening thoughts/links (§15.4, §15.6)
// ---------------------------------------------------------------------------

/**
 * Opens a thought in the editor without switching the canvas focus (§15.7) and
 * pushes it into the per-view structures history (§15.9).
 */
export async function openStructuresThought(id: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const thought = await etn.thoughts.get(networkId, id);
    store.update({
      editorTarget: { kind: 'thought', id },
      structuresActiveThought: thought,
      structuresActiveThoughtId: id,
      selectedLinkId: null,
    });
  } catch (err) {
    notice(`Не удалось открыть мысль: ${errText(err)}`, 'error');
    return;
  }
  const profileId = store.state.profileId;
  if (profileId !== null) {
    await etn.history.push(profileId, networkId, id, 'structures').catch(() => undefined);
  }
}

/** Opens a link in the link editor as the sticky selection (§15.6). */
async function openStructureLink(linkId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const link = await etn.links.get(networkId, linkId);
    // Same store shape as the canvas line click: the editor opens the link and
    // the active-thought band fades out while the link is selected.
    store.update({
      editorTarget: { kind: 'link', id: link.id, link },
      selectedLinkId: link.id,
    });
  } catch (err) {
    notice(`Не удалось открыть связь: ${errText(err)}`, 'error');
  }
}

/** Link label read source → target (§15.6): the forward type name. */
function linkLabel(edge: FocusEdge): string {
  if (edge.type_id === null) return '—';
  const type = store.state.linkTypes.find((t) => t.id === edge.type_id);
  return type?.name_forward ?? '—';
}

/** Opens one link, or a picker menu when several links share the pair. */
function onConnectorClick(event: MouseEvent, links: FocusEdge[]): void {
  if (links.length === 1) {
    void openStructureLink(links[0]!.id);
    return;
  }
  const items: MenuItem[] = links.map((edge) => ({
    label: linkLabel(edge),
    onClick: () => void openStructureLink(edge.id),
  }));
  showMenuAt(event.clientX, event.clientY, items);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Mounts the view: filter panel (left) + results tree (right). */
export function mountStructures(hostEl: HTMLElement): void {
  host = hostEl;
  host.replaceChildren();
  host.classList.add('hidden');

  const panel = div('st-filter');
  const splitter = div('st-splitter');
  const results = div('st-results');
  host.append(panel, splitter, results);
  resultsHost = results;
  applyPanelWidth();
  wirePanelSplitter(splitter, panel);
  initStructuresKbdNav(results, {
    openThought: (id) => void openStructuresThought(id),
    toggleExpand: toggleExpandFor,
  });

  results.addEventListener('click', (event) => {
    // A click on the empty area drops the sticky link selection and returns
    // the editor to the focused thought (same as the canvas, §2.5).
    const target = event.target as HTMLElement;
    if (target.closest('.st-cloud, .st-link-line, .st-more, button') !== null) return;
    store.update({
      selectedLinkId: null,
      editorTarget: null,
      structuresActiveThoughtId: null,
      structuresActiveThought: null,
    });
  });

  mountFilterPanel(panel, {
    onApply: () => {
      persistFilterState();
      // A new filter may make the old structures-history entries unopenable —
      // drop the whole view history and refresh the bar (§15.9).
      void etn.history.clear('structures');
      invalidateHistoryBar();
      void applyQuery(true);
    },
    onStatePersist: () => persistFilterState(),
  });

  store.subscribe(() => {
    if (host === null || !host.isConnected) return;
    const networkId = store.state.networkId;
    if (
      networkId !== null &&
      networkIdSeen !== networkId &&
      store.state.activeView === 'structures'
    ) {
      void ensureStructuresInitialised();
      return;
    }
    if (store.state.activeView !== 'structures') return;
    // Full rebuilds are cheap at tree sizes, but the store fans out on every
    // realtime event (lastEvent etc.) — guard on the visually relevant inputs.
    const signature = renderSignature();
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    renderTree();
  });

  if (store.state.activeView === 'structures') void ensureStructuresInitialised();
}

/**
 * Draggable splitter on the panel/results seam (§15.2): pointer drag resizes
 * the filter panel (clamped to {@link FILTER_W_MIN}..{@link FILTER_W_MAX}),
 * the result tree takes the rest. The width is kept in the filter state and
 * persisted to L4 `structures_state` via the panel's persist callback.
 */
function wirePanelSplitter(splitter: HTMLElement, panel: HTMLElement): void {
  let dragging = false;
  let startX = 0;
  let startW = 0;

  const onMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const width = Math.min(FILTER_W_MAX, Math.max(FILTER_W_MIN, startW + (event.clientX - startX)));
    panel.style.setProperty('--st-filter-w', `${width}px`);
    setPanelWidth(width);
  };
  const onUp = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    try {
      splitter.releasePointerCapture(event.pointerId);
    } catch {
      /* capture already released */
    }
  };

  splitter.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startW = getFilterState().panelWidth ?? panel.clientWidth;
    splitter.classList.add('dragging');
    try {
      splitter.setPointerCapture(event.pointerId);
    } catch {
      /* capture unavailable — window listeners still track the drag */
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/** Signature of the inputs the tree rendering depends on (redundant rebuilds). */
let lastRenderSignature = '';
function renderSignature(): string {
  const st = store.state;
  return JSON.stringify([
    st.networkId,
    resultIds.length,
    total,
    st.selection,
    st.selectedLinkId,
    st.structuresActiveThoughtId,
    st.editorTarget?.kind ?? '',
    st.linkTypes.length,
    [...expansion.keys()],
  ]);
}

/** Rebuilds the results tree from the current state (full rebuild, small lists).
 *  An expanding/collapsing layout change plays a FLIP animation (§15.5): the
 *  rows keep moving smoothly from their old places, freshly revealed rows
 *  fade in, and removed rows dissolve in place. */
function renderTree(): void {
  if (host === null || resultsHost === null) return;
  applyCanvasScaleVars(host);
  finalizeTreeAnimation();
  const before = captureTreeLayout();
  const { rows, moreMarkers } = currentTree();
  clear(resultsHost);

  // Markers with a fresh «has_more» flag, keyed by the row they trail.
  const markersByAfterKey = new Map<string, MoreMarker>();
  for (const marker of moreMarkers) {
    if (hierarchy.get(`${marker.nodeKey}|${marker.dir}`)?.hasMore === true) {
      markersByAfterKey.set(marker.afterKey, marker);
    }
  }
  const rowByKey = new Map(rows.map((r) => [r.key, r]));

  const selection = new Set(store.state.selection);
  // Every filter-result root opens its own framed branch (§15.5): the root row,
  // its parents and its descendants stay visually together, so deep expansions
  // remain attributable to its root.
  let branch: HTMLElement | null = null;
  let branchRootId: string | null = null;
  for (const row of rows) {
    if (branch === null || row.rootId !== branchRootId) {
      branch = div('st-branch');
      branch.dataset['root'] = row.rootId;
      branchRootId = row.rootId;
      resultsHost.append(branch);
    }
    branch.append(buildRow(row, selection));
    const marker = markersByAfterKey.get(row.key);
    const node = marker !== undefined ? rowByKey.get(marker.nodeKey) : undefined;
    if (marker !== undefined && node !== undefined) branch.append(buildMoreButton(marker, node));
  }

  if (total === 0) {
    const empty = div('st-empty');
    empty.textContent = 'Ничего не найдено — измените критерии отбора';
    resultsHost.append(empty);
  }

  // Pagination footer (§15.4).
  if (resultIds.length < total) {
    const more = el('button', 'st-more', 'Показать ещё');
    more.type = 'button';
    more.addEventListener('click', () => void applyQuery(false));
    resultsHost.append(more);
  }
  const counter = div('st-count');
  counter.textContent = `Показано ${resultIds.length} из ${total}`;
  resultsHost.append(counter);

  updateBand();
  syncStructuresCursor();
  const animated = applyTreeFlip(before);
  if (animated) {
    // Lines are drawn at final geometry — wait out the FLIP, then draw.
    flipUntil = performance.now() + FLIP_MS + 40;
    flipTimer = window.setTimeout(() => {
      flipTimer = null;
      flipUntil = 0;
      drawLinks();
    }, FLIP_MS + 50);
  } else {
    drawLinks();
  }
  void refreshEdges();
}

// ---------------------------------------------------------------------------
// FLIP animation of expand/collapse (§15.5)
// ---------------------------------------------------------------------------

/** Animation duration of one expand/collapse transition, ms. */
const FLIP_MS = 220;
/** While set, drawLinks skips (the layout is still animating to it). */
let flipUntil = 0;
let flipTimer: number | null = null;
/** Live FLIP transform cleanups of the current render. */
let flipCleanups: Array<() => void> = [];

/** Layout snapshot before a rebuild: rows keyed by their path key + branches. */
interface TreeLayoutSnapshot {
  rows: Map<string, { left: number; top: number; width: number; html: string }>;
  branches: Map<string, { left: number; top: number }>;
}

/** Captures the current row/branch positions relative to the scrolling host. */
function captureTreeLayout(): TreeLayoutSnapshot {
  const snapshot: TreeLayoutSnapshot = { rows: new Map(), branches: new Map() };
  const host = resultsHost;
  if (host === null) return snapshot;
  const hostRect = host.getBoundingClientRect();
  const x = (r: DOMRect): number => r.left - hostRect.left + host.scrollLeft;
  const y = (r: DOMRect): number => r.top - hostRect.top + host.scrollTop;
  for (const rowEl of host.querySelectorAll<HTMLElement>('.st-row')) {
    const key = rowEl.dataset['key'];
    if (key === undefined) continue;
    const r = rowEl.getBoundingClientRect();
    snapshot.rows.set(key, { left: x(r), top: y(r), width: r.width, html: rowEl.outerHTML });
  }
  for (const branchEl of host.querySelectorAll<HTMLElement>('.st-branch')) {
    const root = branchEl.dataset['root'];
    if (root === undefined) continue;
    const r = branchEl.getBoundingClientRect();
    snapshot.branches.set(root, { left: x(r), top: y(r) });
  }
  return snapshot;
}

/** Snaps any running animation to its end and drops the ghosts (new render). */
function finalizeTreeAnimation(): void {
  if (flipTimer !== null) {
    window.clearTimeout(flipTimer);
    flipTimer = null;
  }
  flipUntil = 0;
  for (const cleanup of flipCleanups) cleanup();
  flipCleanups = [];
  resultsHost?.querySelectorAll('.st-ghost').forEach((g) => g.remove());
}

/** Animates one element from its snapshot position to the current one. */
function flipElement(el: HTMLElement, from: { left: number; top: number }): boolean {
  if (resultsHost === null) return false;
  const hostRect = resultsHost.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const dx = from.left - (r.left - hostRect.left + resultsHost.scrollLeft);
  const dy = from.top - (r.top - hostRect.top + resultsHost.scrollTop);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return false;
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  void el.offsetWidth; // commit the start frame before enabling the transition
  el.style.transition = `transform ${FLIP_MS}ms ease`;
  el.style.transform = '';
  const cleanup = (): void => {
    el.style.transition = '';
    el.style.transform = '';
  };
  el.addEventListener('transitionend', cleanup, { once: true });
  flipCleanups.push(cleanup);
  return true;
}

/**
 * Plays the layout change: moved rows/branches FLIP from their old positions,
 * newly appeared rows fade in, removed rows dissolve as positioned ghosts.
 * Returns true when anything actually animated.
 */
function applyTreeFlip(before: TreeLayoutSnapshot): boolean {
  if (resultsHost === null) return false;
  let animated = false;
  const hostRect = resultsHost.getBoundingClientRect();
  const afterKeys = new Set<string>();

  for (const rowEl of resultsHost.querySelectorAll<HTMLElement>('.st-row')) {
    const key = rowEl.dataset['key'];
    if (key === undefined) continue;
    afterKeys.add(key);
    const snap = before.rows.get(key);
    if (snap === undefined) {
      rowEl.classList.add('st-fade-in');
      flipCleanups.push(() => rowEl.classList.remove('st-fade-in'));
      animated = true;
      continue;
    }
    if (flipElement(rowEl, snap)) animated = true;
  }
  for (const branchEl of resultsHost.querySelectorAll<HTMLElement>('.st-branch')) {
    const root = branchEl.dataset['root'];
    const snap = root === undefined ? undefined : before.branches.get(root);
    if (snap !== undefined && flipElement(branchEl, snap)) animated = true;
  }

  // Removed rows dissolve in place (ghosts over the tree, non-interactive).
  for (const [key, snap] of before.rows) {
    if (afterKeys.has(key)) continue;
    const ghost = div('st-ghost');
    ghost.innerHTML = snap.html;
    ghost.style.left = `${snap.left}px`;
    ghost.style.top = `${snap.top}px`;
    ghost.style.width = `${snap.width}px`;
    resultsHost.append(ghost);
    flipCleanups.push(() => ghost.remove());
    animated = true;
  }
  if (animated) {
    // Ghosts self-remove after their dissolve animation regardless of the
    // next render's finalize.
    window.setTimeout(() => {
      resultsHost?.querySelectorAll('.st-ghost').forEach((g) => g.remove());
    }, FLIP_MS + 120);
  }
  return animated;
}

/** Toggles one node's expansion by its DOM-carried identity (§15.10 Ctrl+↑/↓). */
function toggleExpandFor(key: string, thoughtId: string, rootId: string, dir: HierarchyDir): void {
  void toggleExpand({ key, thoughtId, rootId, root: false, ownIndent: 0, indent: 0, via: null }, dir);
}

/** Builds one tree row: the root triangle (for filter results) + a cloud. */
function buildRow(row: TreeRow, selection: Set<string>): HTMLElement {
  const rowEl = div('st-row');
  rowEl.dataset['key'] = row.key;
  rowEl.dataset['id'] = row.thoughtId;
  rowEl.dataset['root'] = row.rootId;
  rowEl.style.setProperty('--st-indent', String(row.indent));
  if (row.via !== null) {
    // The link lines are drawn over the tree from these attributes (drawLinks).
    rowEl.dataset['via'] = row.via.otherId;
    rowEl.dataset['role'] = row.via.role;
  }
  if (row.root) rowEl.append(div('st-root-marker'));
  const cloud = buildCloud(row, selection);
  rowEl.append(cloud);
  // Patch the indicator row from the shared canvas indicator cache/queue
  // (the cache hit applies synchronously to the fresh DOM, §15.4).
  queueIndicatorLoad(row.thoughtId);
  return rowEl;
}

/** Builds one per-node «Показать ещё» button (§15.5 pagination). */
function buildMoreButton(marker: MoreMarker, node: TreeRow): HTMLElement {
  const btn = el('button', 'st-more', 'Показать ещё');
  btn.type = 'button';
  btn.style.setProperty('--st-indent', String(marker.indent));
  btn.addEventListener('click', () => void loadMoreNeighbors(marker.nodeKey, node.thoughtId, node.rootId, marker.dir));
  return btn;
}

/** Builds one thought cloud: same visual language as the canvas (§15.4). */
function buildCloud(row: TreeRow, selection: Set<string>): HTMLElement {
  const ref = refs.get(row.thoughtId) ?? null;
  const cloud = div('st-cloud cloud');
  cloud.dataset['id'] = row.thoughtId;
  if (ref !== null && !ref.active) cloud.classList.add('dim');
  if (selection.has(row.thoughtId)) cloud.classList.add('selected');

  applyCloudStyle(
    cloud,
    resolveCloudStyle(
      ref ?? {
        type_id: null,
        fg_color: null,
        bg_color: null,
        font_bold: false,
        font_italic: false,
        font_underline: false,
        font_strike: false,
      },
    ),
  );

  // Ellipses (§15.5): filled when the thought has parents/children at all —
  // known from the hierarchy directions accumulated so far.
  const dir = directions.get(row.thoughtId);
  const topEllipse = div('ellipse ellipse-top');
  const bottomEllipse = div('ellipse ellipse-bottom');
  if (dir?.has_incoming === true) topEllipse.classList.add('filled');
  if (dir?.has_outgoing === true) bottomEllipse.classList.add('filled');
  const expanded = expansion.get(row.key);
  if (expanded?.parents === true) topEllipse.classList.add('st-expanded');
  if (expanded?.children === true) bottomEllipse.classList.add('st-expanded');
  // Same wording as the canvas ellipse tooltip (§15.4: the cloud matches the
  // canvas 1-to-1) — connectivity state, not the expand/collapse action.
  setTooltip(topEllipse, dir?.has_incoming === true ? 'Есть входящие связи' : 'Входящих связей нет');
  setTooltip(bottomEllipse, dir?.has_outgoing === true ? 'Есть исходящие связи' : 'Исходящих связей нет');
  topEllipse.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) {
      void addNeighborsOf(row.thoughtId, 'parent');
      return;
    }
    void toggleExpand(row, 'parents');
  });
  bottomEllipse.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) {
      void addNeighborsOf(row.thoughtId, 'child');
      return;
    }
    void toggleExpand(row, 'children');
  });
  // Hovering an ellipse elevates every link of this thought above the clouds
  // (§15.6, same as the canvas endpoint highlight).
  for (const ellipse of [topEllipse, bottomEllipse]) {
    ellipse.addEventListener('mouseenter', () => setLinksHoverThought(row.thoughtId));
    ellipse.addEventListener('mouseleave', () => setLinksHoverThought(null));
  }

  const iconBox = div('cloud-icon');
  applyThoughtIcon(iconBox, ref ?? { icon: null, icon_kind: 'emoji', type_id: null });
  const title = el('div', 'cloud-title', ref?.title ?? '—');
  setTooltip(title, ref?.title ?? '');

  // Indicator row identical to the canvas cloud (§15.4: 📝/📅/📎, patched
  // asynchronously via the shared indicator queue of canvas.ts).
  const ind = div('cloud-ind');
  const perm = span('📝', 'ind dim');
  const chrono = span('📅', 'ind dim');
  const att = span('📎', 'ind dim');
  ind.append(perm, chrono, att);

  const main = div('cloud-main');
  main.append(title, ind);
  cloud.append(topEllipse, iconBox, main, bottomEllipse);

  // Click opens the editor without moving the canvas focus; Ctrl toggles the
  // shared selection; right-click reuses the canvas context menu with the
  // editor-opening variant of «Открыть редактор» (§15.8).
  cloud.tabIndex = 0;
  cloud.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) {
      toggleSelection([row.thoughtId]);
      return;
    }
    void openStructuresThought(row.thoughtId);
  });
  cloud.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openStructuresThought(row.thoughtId);
  });
  cloud.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showThoughtContextMenu(
      event,
      { id: row.thoughtId, title: ref?.title ?? row.thoughtId, dir: 'siblings' },
      { openHandler: (id) => void openStructuresThought(id) },
    );
  });
  return cloud;
}

// ---------------------------------------------------------------------------
// Link drawing (§15.6: like the canvas — Bézier curves from the source's
// bottom ellipse to the target's top ellipse, every active link among the
// visible thoughts, §6.12)
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Base stroke width of a single link, px (mirrors the canvas line style). */
const ST_LINK_BASE = 1.5;
/** Extra width per additional link of a pair, px. */
const ST_LINK_EXTRA = 1.2;
/** Default stroke colour (the CSS link colour variable). */
const ST_LINK_DEFAULT = 'var(--link-default, #9aa3b2)';

/** One directed source→target pair of visible thoughts with its links. */
interface EdgeBundle {
  sourceId: string;
  targetId: string;
  edges: FocusEdge[];
}

/** Groups edges into directed bundles by `source>target` (like the canvas). */
function groupEdgeBundles(edges: FocusEdge[]): EdgeBundle[] {
  const byKey = new Map<string, EdgeBundle>();
  for (const edge of edges) {
    const key = `${edge.source_id}>${edge.target_id}`;
    const bundle = byKey.get(key);
    if (bundle === undefined) {
      byKey.set(key, { sourceId: edge.source_id, targetId: edge.target_id, edges: [edge] });
    } else {
      bundle.edges.push(edge);
    }
  }
  return [...byKey.values()];
}

/**
 * Stroke styling of a bundle, mirroring the canvas line style: a per-link
 * override wins, else the link-type chain default; bundles whose links
 * disagree fall back to the default stroke.
 */
function bundleStroke(bundle: EdgeBundle): { color: string; width: number; dash: string } {
  const resolve = (edge: FocusEdge): { color: string | null; style: string | null; width: number | null } => {
    const type = resolveLinkTypeVisual(store.state.linkTypes, edge.type_id);
    return {
      color: edge.color ?? type.color,
      style: edge.style ?? type.style,
      width: edge.width ?? type.width,
    };
  };
  const first = resolve(bundle.edges[0]!);
  const allAgree = bundle.edges.every((edge) => {
    const s = resolve(edge);
    return s.color === first.color && s.style === first.style && s.width === first.width;
  });
  if (!allAgree) {
    return { color: ST_LINK_DEFAULT, width: ST_LINK_BASE, dash: 'none' };
  }
  const dash = first.style === 'dashed' ? '6 4' : first.style === 'dotted' ? '2 4' : 'none';
  return {
    color: first.color ?? ST_LINK_DEFAULT,
    width: first.width ?? ST_LINK_BASE,
    dash,
  };
}

/** Refetches every active link among the visible thoughts when the visible set
 *  changed (§6.12), then redraws the ellipse-to-ellipse lines. */
async function refreshEdges(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || resultsHost === null) return;
  const ids = [...new Set(currentRows().map((r) => r.thoughtId))];
  const signature = `${store.state.showInactive ? 1 : 0}|${ids.slice().sort().join(',')}`;
  if (signature === edgesSignature) return;
  edgesSignature = signature;
  try {
    const list = await etn.structures.edges(networkId, ids, store.state.showInactive);
    edges.clear();
    for (const edge of list) edges.set(edge.id, edge);
    drawLinks();
  } catch {
    // The tree stays usable without the lines.
  }
}

/** One drawn curve: the bundle, its geometry and stroke (for the top layer). */
interface DrawnBundle {
  /** Unique drawn-curve key (`source>target#branch`). */
  key: string;
  bundle: EdgeBundle;
  from: { x: number; y: number };
  to: { x: number; y: number };
  width: number;
  dash: string;
  color: string;
  label: string;
}

/** Curves of the last drawLinks() — input of the hover/selection top layer. */
let drawnBundles: DrawnBundle[] = [];
/** Curve currently under the pointer (top-layer elevation). */
let hoveredBundleKey: string | null = null;
/** Thought whose ellipse is hovered — all its links elevate (§15.6). */
let linksHoverThoughtId: string | null = null;

/** Records/removes the ellipse-hover elevation of a thought's links. */
function setLinksHoverThought(id: string | null): void {
  if (linksHoverThoughtId === id) return;
  linksHoverThoughtId = id;
  drawTopOverlay();
}

/** Redraws the lines after a hover/selection change (cheap, small lists). */
function drawTopOverlay(): void {
  if (resultsHost === null) return;
  resultsHost.querySelectorAll('.st-links-top').forEach((el) => el.remove());
  const selected = store.state.selectedLinkId;
  const elevated = drawnBundles.filter(
    (d) =>
      d.key === hoveredBundleKey ||
      (selected !== null && d.bundle.edges.some((e) => e.id === selected)) ||
      (linksHoverThoughtId !== null &&
        (d.bundle.sourceId === linksHoverThoughtId || d.bundle.targetId === linksHoverThoughtId)),
  );
  if (elevated.length === 0) return;

  const overlay = div('st-links-top');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(resultsHost.scrollWidth));
  svg.setAttribute('height', String(resultsHost.scrollHeight));
  overlay.append(svg);
  const zoom = store.state.canvasZoom;
  for (const d of elevated) {
    const geo = edgeGeometry(d.from, d.to);
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', geo.d);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--warn, #c98a06)');
    line.setAttribute('stroke-width', String(d.width + 2 * zoom));
    if (d.dash !== 'none') line.setAttribute('stroke-dasharray', d.dash);
    svg.append(line);
    const label = document.createElementNS(SVG_NS, 'text');
    label.classList.add('st-link-label');
    label.setAttribute('x', String(geo.mid.x));
    label.setAttribute('y', String(geo.mid.y - 8 * zoom));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = d.label;
    svg.append(label);
  }
  resultsHost.append(overlay);
}

/**
 * Draws the link curves over the tree (§15.6): one Bézier per directed pair
 * INSIDE ONE BRANCH FRAME (links between different result frames are not
 * drawn — the frames are the visual context), from the source cloud's bottom
 * ellipse to the target cloud's top ellipse — the same geometry and line
 * style as the canvas. A wide transparent hit stroke under the rows captures
 * hover/click; the label (type name, or «Тип ×N» for several links) appears
 * on hover and stays for the selected link. Hovering a line or an endpoint
 * ellipse elevates the curve above the clouds (drawTopOverlay).
 */
function drawLinks(): void {
  if (resultsHost === null) return;
  if (performance.now() < flipUntil) return; // layout still animating
  resultsHost.querySelectorAll('.st-links').forEach((el) => el.remove());
  drawnBundles = [];
  const bundles = groupEdgeBundles([...edges.values()]);
  if (bundles.length === 0) {
    drawTopOverlay();
    return;
  }

  const overlay = div('st-links');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(resultsHost.scrollWidth));
  svg.setAttribute('height', String(resultsHost.scrollHeight));
  overlay.append(svg);

  const hostRect = resultsHost.getBoundingClientRect();
  const scrollLeft = resultsHost.scrollLeft;
  const scrollTop = resultsHost.scrollTop;
  const zoom = store.state.canvasZoom;

  for (const branch of resultsHost.querySelectorAll<HTMLElement>('.st-branch')) {
    // First cloud occurrence per id inside THIS branch (a thought may render
    // in several branches; each frame draws its own copy of the link).
    const cloudById = new Map<string, HTMLElement>();
    for (const cloud of branch.querySelectorAll<HTMLElement>('.st-row .st-cloud')) {
      const id = cloud.dataset['id'];
      if (id !== undefined && !cloudById.has(id)) cloudById.set(id, cloud);
    }

    for (const bundle of bundles) {
      const fromCloud = cloudById.get(bundle.sourceId);
      const toCloud = cloudById.get(bundle.targetId);
      if (fromCloud === undefined || toCloud === undefined) continue;
      const fr = fromCloud.getBoundingClientRect();
      const tr = toCloud.getBoundingClientRect();
      const from = {
        x: fr.left - hostRect.left + scrollLeft + fr.width / 2,
        y: fr.bottom - hostRect.top + scrollTop - ELLIPSE_INSIDE * zoom,
      };
      const to = {
        x: tr.left - hostRect.left + scrollLeft + tr.width / 2,
        y: tr.top - hostRect.top + scrollTop + ELLIPSE_INSIDE * zoom,
      };
      if (to.y < from.y) continue; // the target must sit below the source
      const geo = edgeGeometry(from, to);
      const style = bundleStroke(bundle);
      const count = bundle.edges.length;
      const width = (count > 1 ? ST_LINK_BASE + (count - 1) * ST_LINK_EXTRA : style.width) * zoom;

      const group = document.createElementNS(SVG_NS, 'g');
      group.classList.add('st-bundle');

      const visual = document.createElementNS(SVG_NS, 'path');
      visual.classList.add('st-link-visual');
      visual.setAttribute('d', geo.d);
      visual.setAttribute('fill', 'none');
      visual.setAttribute('stroke', style.color);
      visual.setAttribute('stroke-width', String(width));
      if (style.dash !== 'none') visual.setAttribute('stroke-dasharray', style.dash);

      // Wide transparent hit stroke following the same curve.
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.classList.add('st-link-hit');
      hit.setAttribute('d', geo.d);
      hit.setAttribute('fill', 'none');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', String(Math.max(width + 10, 16)));
      hit.setAttribute('pointer-events', 'stroke');
      hit.setAttribute('cursor', 'pointer');

      const drawnKey = `${bundle.sourceId}>${bundle.targetId}#${branch.dataset['root'] ?? ''}`;
      hit.addEventListener('mouseenter', () => {
        hoveredBundleKey = drawnKey;
        drawTopOverlay();
      });
      hit.addEventListener('mouseleave', () => {
        if (hoveredBundleKey === drawnKey) {
          hoveredBundleKey = null;
          drawTopOverlay();
        }
      });
      hit.addEventListener('click', (event) => {
        event.stopPropagation();
        onConnectorClick(event, bundle.edges);
      });
      hit.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (bundle.edges.length === 1) {
          showLinkContextMenu(event, bundle.edges[0]!.id);
        } else {
          const items: MenuItem[] = bundle.edges.map((edge) => ({
            label: `Связь: ${linkLabel(edge)}`,
            onClick: () => showLinkContextMenuAt(event, edge.id),
          }));
          showMenuAt(event.clientX, event.clientY, items);
        }
      });

      const label = document.createElementNS(SVG_NS, 'text');
      label.classList.add('st-link-label');
      label.setAttribute('x', String(geo.mid.x));
      label.setAttribute('y', String(geo.mid.y - 8 * zoom));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = connectorLabel(bundle.edges);

      group.append(visual, hit, label);
      svg.append(group);
      drawnBundles.push({
        key: drawnKey,
        bundle,
        from,
        to,
        width,
        dash: style.dash,
        color: style.color,
        label: connectorLabel(bundle.edges),
      });
    }
  }
  resultsHost.append(overlay);
  drawTopOverlay();
}

/** Re-shows the link context menu at remembered coordinates (multi-link pick). */
function showLinkContextMenuAt(event: MouseEvent, linkId: string): void {
  showLinkContextMenu(
    { clientX: event.clientX, clientY: event.clientY } as MouseEvent,
    linkId,
  );
}

/** Label of a connector: the type name (source → target) plus a ×N badge. */
function connectorLabel(links: FocusEdge[]): string {
  const first = links[0]!;
  const base = linkLabel(first);
  return links.length > 1 ? `${base} ×${links.length}` : base;
}

/** Positions the active-thought band over its row (§15.7), or hides it. */
function updateBand(): void {
  if (resultsHost === null) return;
  const target = store.state.editorTarget;
  const activeId =
    target !== null && target.kind === 'link' ? null : store.state.structuresActiveThoughtId;
  const row =
    activeId !== null
      ? resultsHost.querySelector<HTMLElement>(`.st-row[data-id="${activeId}"]`)
      : null;
  if (row === null) {
    resultsHost.style.setProperty('--st-band-top', '9999px');
    resultsHost.style.setProperty('--st-band-bottom', '0px');
    return;
  }
  // The rows sit inside .st-branch frames (their own offset parent), so the
  // band is anchored via viewport rects relative to the scrolling host.
  const rowRect = row.getBoundingClientRect();
  const hostRect = resultsHost.getBoundingClientRect();
  const top = rowRect.top - hostRect.top + resultsHost.scrollTop;
  resultsHost.style.setProperty('--st-band-top', `${top}px`);
  resultsHost.style.setProperty('--st-band-bottom', `${top + rowRect.height}px`);
}

// ---------------------------------------------------------------------------
// Realtime refresh (§15.4)
// ---------------------------------------------------------------------------

let refreshTimer: number | null = null;

/**
 * Coalesces realtime updates into one reload: the visible page is re-queried
 * and every expanded node refetches its hierarchy level (expansion survives).
 */
export function scheduleStructuresRefresh(): void {
  if (store.state.activeView !== 'structures') return;
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void reloadAll();
  }, 400);
}

/** Reloads the page and all expanded hierarchy levels. */
async function reloadAll(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || networkIdSeen !== networkId) return;
  await applyQuery(true);
  // The visible set may be unchanged while the links themselves changed
  // (realtime) — force the edges refresh even for the same id signature.
  edgesSignature = '';
  // Refetch every expanded direction, top-down, with fresh per-branch excludes.
  const rows = currentRows();
  const seen = new Set<string>();
  for (const row of rows) {
    const flags = expansion.get(row.key);
    if (flags === undefined) continue;
    for (const dir of ['children', 'parents'] as const) {
      if (flags[dir] !== true) continue;
      const cacheKey = `${row.key}|${dir}`;
      if (seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      const excludeIds = branchThoughtIds(currentRows(), row.rootId);
      try {
        const data = await etn.structures.hierarchy(networkId, row.thoughtId, {
          dir,
          showInactive: store.state.showInactive,
          excludeIds,
        });
        hierarchy.set(cacheKey, { neighbors: data.neighbors, hasMore: data.has_more });
        for (const ref of data.neighbors) refs.set(ref.id, ref);
        for (const [id, flags2] of Object.entries(data.directions)) directions.set(id, flags2);
        for (const edge of data.edges) edges.set(edge.id, edge);
      } catch {
        // Keep the previous data for this node.
      }
    }
  }
  renderTree();
}

/** Drops caches after a thought was deleted locally (also see history prune). */
export function invalidateStructuresThought(id: string): void {
  refs.delete(id);
  if (store.state.structuresActiveThoughtId === id) {
    store.update({
      structuresActiveThoughtId: null,
      structuresActiveThought: null,
      ...(store.state.editorTarget?.kind === 'thought' ? { editorTarget: null } : {}),
    });
  }
  scheduleStructuresRefresh();
}

// ---------------------------------------------------------------------------
// Panel bridge (typed value conversion lives in the panel module)
// ---------------------------------------------------------------------------

/** Panel-typed property conditions for the wire filter. */
function buildConditionsFromPanel(): StructurePropertyCondition[] {
  return buildConditions();
}
// Re-export for the history bar / workspace wiring.
export type { FilterState };
