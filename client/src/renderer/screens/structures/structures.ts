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
  type HierarchyResponse,
  type StructureFilter,
  type StructurePropertyCondition,
  type ThoughtRef,
} from '@etn/shared';

import { applyCanvasScaleVars, applyCloudStyle, applyThoughtIcon, resolveCloudStyle } from '../../canvas/canvas.js';
import { showLinkContextMenu, showThoughtContextMenu } from '../../canvas/context-menu.js';
import { addNeighborsOf, toggleSelection } from '../../selection/selection.js';
import { openLinkInEditor } from '../../editor/editor.js';
import { invalidateHistoryBar } from '../history-bar.js';
import { clear, div, el, setTooltip } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { errText } from '../../lib/dom.js';
import { store, type WorkspaceView } from '../../state.js';
import {
  branchThoughtIds,
  flattenStructuresTree,
  subtreeExpansionKeys,
  type ExpansionMap,
  type HierarchyDir,
  type TreeRow,
} from './layout.js';
import {
  applyPanelWidth,
  buildConditions,
  FILTER_W_MAX,
  FILTER_W_MIN,
  getFilterState,
  mountFilterPanel,
  setFilterState,
  setPanelWidth,
  type FilterState,
} from './filter-panel.js';

/** Horizontal step of one indent level, px (connector column + padding). */
const LEVEL_WIDTH = 34;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
let resultsHost: HTMLElement | null = null;

/** Filter-result roots in sort order (the visible page, grows with «Показать ещё»). */
let resultIds: string[] = [];
/** Unrestricted match count of the current filter. */
let total = 0;
/** Known thought metadata: roots + every expanded neighbour. */
const refs = new Map<string, ThoughtRef>();
/** Hierarchy data per expanded node direction, `${nodeKey}|${dir}`. */
const hierarchy = new Map<string, HierarchyResponse>();
/** Ellipse-fill flags accumulated from hierarchy responses. */
const directions = new Map<string, { has_incoming: boolean; has_outgoing: boolean }>();
/** Active links between visible thoughts, deduped by id. */
const edges = new Map<string, FocusEdge>();
/** Which nodes have parents/children expanded. */
let expansion: ExpansionMap = new Map();

/** Whether the initial filter state and first query already ran for this network. */
let networkIdSeen: string | null = null;
/** Loading guard so the tree does not flicker with stale data. */
let querySeq = 0;

// ---------------------------------------------------------------------------
// View switching (L4 active_view)
// ---------------------------------------------------------------------------

/** Switches the workspace view and persists the L4 `active_view` key (§15.1). */
export function setActiveView(view: WorkspaceView): void {
  if (store.state.activeView === view) return;
  store.update({ activeView: view });
  const networkId = store.state.networkId;
  if (networkId !== null) {
    void etn.ui.setState(networkId, UI_STATE_KEY.ACTIVE_VIEW, view).catch(() => undefined);
  }
  if (view === 'structures') void ensureInitialised();
}

/** Loads the persisted filter state and runs the first query (idempotent). */
async function ensureInitialised(): Promise<void> {
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
  expansion = new Map();

  try {
    const raw = await etn.ui.getState(networkId, UI_STATE_KEY.STRUCTURES_STATE);
    if (raw !== null && raw !== '') setFilterState(parseFilterState(raw));
  } catch {
    // Fall back to the empty filter (HOME).
  }
  await applyQuery(true);
}

/** Parses the persisted L4 `structures_state` JSON (unknown input, safe defaults). */
function parseFilterState(raw: string): FilterState {
  try {
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    return {
      keywords: typeof parsed.keywords === 'string' ? parsed.keywords : '',
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
      sort: parsed.sort === 'alpha' || parsed.sort === 'created' || parsed.sort === 'viewed' ? parsed.sort : 'created',
      order: parsed.order === 'asc' || parsed.order === 'desc' ? parsed.order : 'asc',
      savedFilterId: typeof parsed.savedFilterId === 'string' ? parsed.savedFilterId : null,
      panelWidth:
        typeof parsed.panelWidth === 'number' &&
        Number.isFinite(parsed.panelWidth)
          ? parsed.panelWidth
          : null,
      typeListHeight:
        typeof parsed.typeListHeight === 'number' && Number.isFinite(parsed.typeListHeight)
          ? parsed.typeListHeight
          : null,
      linkTypeListHeight:
        typeof parsed.linkTypeListHeight === 'number' && Number.isFinite(parsed.linkTypeListHeight)
          ? parsed.linkTypeListHeight
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
  const filter: StructureFilter = {};
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

/** Current flattened rows (render + exclude computation share this). */
function currentRows(): TreeRow[] {
  return flattenStructuresTree(resultIds, expansion, neighborsOf);
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
    hierarchy.set(`${row.key}|${dir}`, data);
    for (const ref of data.neighbors) refs.set(ref.id, ref);
    for (const [id, flags] of Object.entries(data.directions)) directions.set(id, flags);
    for (const edge of data.edges) edges.set(edge.id, edge);
    expansion.set(row.key, { ...flags, [dir]: true });
    renderTree();
  } catch (err) {
    notice(`Не удалось раскрыть: ${errText(err)}`, 'error');
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

/** Links between two thoughts (either direction), from the accumulated edges. */
function pairLinks(a: string, b: string): FocusEdge[] {
  return [...edges.values()].filter(
    (e) =>
      (e.source_id === a && e.target_id === b) || (e.source_id === b && e.target_id === a),
  );
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
      void ensureInitialised();
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

  if (store.state.activeView === 'structures') void ensureInitialised();
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

/** Rebuilds the results tree from the current state (full rebuild, small lists). */
function renderTree(): void {
  if (host === null || resultsHost === null) return;
  applyCanvasScaleVars(host);
  const rows = currentRows();
  clear(resultsHost);

  const selection = new Set(store.state.selection);
  // Every filter-result root opens its own framed branch (§15.5): the root row,
  // its parents and its descendants stay visually together, so deep expansions
  // remain attributable to their root.
  let branch: HTMLElement | null = null;
  let branchRootId: string | null = null;
  for (const row of rows) {
    if (branch === null || row.rootId !== branchRootId) {
      branch = div('st-branch');
      branchRootId = row.rootId;
      resultsHost.append(branch);
    }
    branch.append(buildRow(row, selection));
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
  drawLinks();
}

/** Builds one tree row: the root triangle (for filter results) + a cloud. */
function buildRow(row: TreeRow, selection: Set<string>): HTMLElement {
  const rowEl = div('st-row');
  rowEl.dataset['key'] = row.key;
  rowEl.dataset['id'] = row.thoughtId;
  rowEl.style.setProperty('--st-indent', String(row.indent));
  if (row.via !== null) {
    // The link lines are drawn over the tree from these attributes (drawLinks).
    rowEl.dataset['via'] = row.via.otherId;
    rowEl.dataset['role'] = row.via.role;
  }
  if (row.root) rowEl.append(div('st-root-marker'));
  rowEl.append(buildCloud(row, selection));
  return rowEl;
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
  setTooltip(topEllipse, 'Родители');
  setTooltip(bottomEllipse, 'Дети');
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

  const iconBox = div('cloud-icon');
  applyThoughtIcon(iconBox, ref ?? { icon: null, icon_kind: 'emoji', type_id: null });
  const title = el('div', 'cloud-title', ref?.title ?? '…');
  setTooltip(title, ref?.title ?? '');

  const main = div('cloud-main');
  main.append(title);
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

/**
 * Draws one link line per parent→child pair over the tree (§15.6), absolute
 * in the results host: the vertical starts at the parent cloud's bottom-left
 * corner and reaches the child's left edge. Lines are appended in row order,
 * so the links of lower rows paint over the links of the rows above — exactly
 * how several parents of one thought overlap. A line is a single element, so
 * hovering it highlights the whole link at once (--warn) and reveals the
 * source → target label, which otherwise stays hidden (no label collisions).
 */
function drawLinks(): void {
  if (resultsHost === null) return;
  resultsHost.querySelectorAll('.st-link-line').forEach((l) => l.remove());
  const hostRect = resultsHost.getBoundingClientRect();
  const scrollLeft = resultsHost.scrollLeft;
  const scrollTop = resultsHost.scrollTop;

  for (const branch of resultsHost.querySelectorAll<HTMLElement>('.st-branch')) {
    const rows = [...branch.querySelectorAll<HTMLElement>('.st-row')];
    const rowsById = new Map<string, HTMLElement>();
    for (const rowEl of rows) {
      const id = rowEl.dataset['id'];
      if (id !== undefined) rowsById.set(id, rowEl);
    }
    const drawn = new Set<string>();
    for (const rowEl of rows) {
      const selfId = rowEl.dataset['id'];
      const viaId = rowEl.dataset['via'];
      const role = rowEl.dataset['role'];
      if (selfId === undefined || viaId === undefined) continue;
      if (role !== 'child' && role !== 'parent') continue;
      const parentId = role === 'child' ? viaId : selfId;
      const childId = role === 'child' ? selfId : viaId;
      const pairKey = `${parentId}|${childId}`;
      if (drawn.has(pairKey)) continue;
      drawn.add(pairKey);

      const parentCloud =
        rowsById.get(parentId)?.querySelector<HTMLElement>('.st-cloud') ?? null;
      const childCloud =
        rowsById.get(childId)?.querySelector<HTMLElement>('.st-cloud') ?? null;
      if (parentCloud === null || childCloud === null) continue;

      const pr = parentCloud.getBoundingClientRect();
      const cr = childCloud.getBoundingClientRect();
      const x = pr.left - hostRect.left + scrollLeft + 5;
      const yTop = pr.bottom - hostRect.top + scrollTop;
      const yMid = cr.top - hostRect.top + scrollTop + cr.height / 2;
      const xEnd = cr.left - hostRect.left + scrollLeft;
      if (yMid <= yTop) continue; // the child cannot sit above its parent

      const line = div('st-link-line');
      line.style.left = `${x}px`;
      line.style.top = `${yTop}px`;
      line.style.width = `${Math.max(2, xEnd - x)}px`;
      line.style.height = `${yMid - yTop}px`;

      const links = pairLinks(parentId, childId);
      if (links.length > 0) {
        const selected = store.state.selectedLinkId;
        if (selected !== null && links.some((l) => l.id === selected)) {
          line.classList.add('st-selected');
        }
        const label = el('span', 'st-link-label', connectorLabel(links));
        line.append(label);
        line.addEventListener('click', (event) => {
          event.stopPropagation();
          onConnectorClick(event, links);
        });
        line.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (links.length === 1) {
            showLinkContextMenu(event, links[0]!.id);
          } else {
            const items: MenuItem[] = links.map((edge) => ({
              label: `Связь: ${linkLabel(edge)}`,
              onClick: () => showLinkContextMenuAt(event, edge.id),
            }));
            showMenuAt(event.clientX, event.clientY, items);
          }
        });
      }
      resultsHost.append(line);
    }
  }
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
        hierarchy.set(cacheKey, data);
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
