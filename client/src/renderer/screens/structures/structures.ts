/**
 * «Структуры мыслей» view (L15, 08-ui-spec.md §15): filter panel on the left,
 * the results tree on the right.
 *
 *  - The tree flattens the filter results plus the user's expansions (parents
 *    up / children down) via the pure helpers in `layout.ts`;
 *  - each expansion fetches one hierarchy level with `exclude_ids` = every
 *    thought already shown in the same root branch (per-branch dedup, §15.5);
 *  - a cloud click opens the thought in the editor WITHOUT switching the canvas
 *    focus and lights its halo; a connector click opens the link and drops
 *    the halo (§15.6–15.7);
 *  - Ctrl+click on clouds/ellipses feeds the shared selection (§15.8);
 *  - an opened thought lands in the unified visit history (0.5.5) shared by
 *    every screen.
 */

import {
  STRUCTURES_PAGE_SIZE,
  UI_STATE_KEY,
  type AnyRealtimeEvent,
  type FocusEdge,
  type HierarchyResponse,
  type LinkUpdateInput,
  type StructureFilter,
  type StructurePropertyCondition,
  type StructureSort,
  type ThoughtRef,
  type ThoughtUpdateInput,
} from '@etn/shared';

import {
  applyCanvasScaleVars,
  queueIndicatorLoad,
} from '../../canvas/canvas.js';
// Облачка дерева собирает общая фабрика (профиль `tree`): значок, цвета,
// начертание, бледность и метка корзины; эллипсы и индикаторы дерево
// добавляет само (домен структур — те же, что на холсте).
import { createThoughtCloud } from '../../lib/thought-cloud.js';
import { setFocus } from '../../app.js';
import { showLinkContextMenu, showThoughtContextMenu } from '../../canvas/context-menu.js';
import { edgeGeometry } from '../../canvas/links.js';
import { setThoughtEditorTarget } from '../../editor/editor.js';
import { currentThoughtId } from '../../history.js';
import { ELLIPSE_INSIDE } from '../../lib/pure.js';
import { resolveLinkTypeVisual } from '../../lib/type-tree.js';
import { addNeighborsOf, toggleSelection } from '../../selection/selection.js';
import { setActiveView } from '../active-view.js';
import { div, el, setTooltip, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import {
  markAttachmentsPreview,
  markChronoPreview,
  markCommentPreview,
} from '../../lib/hover-preview.js';
import { showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { badge } from '../../lib/ui/badge.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { createRealtimeBatch } from '../../lib/realtime-batch.js';
import {
  applyLinkUpdateToState,
  applyThoughtUpdateToState,
  linkChangeNeedsReload,
  removeLinkFromState,
  removeThoughtFromState,
  rowRenderSignature,
  thoughtChangeNeedsReload,
  type StructuresLinkCriteria,
  type StructuresState,
} from './realtime-apply.js';
import { preserveScroll } from '../../lib/ui/scroll-anchor.js';
import { splitterElement } from '../../lib/ui/splitter.js';
import { deepEqual } from '../../lib/ui/state.js';
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
import { patchCloudVisualStates, ST_CLOUD_CLASS, type CloudVisualState } from './visual-states.js';
import { openFilterCommandsMenu } from './commands.js';
import { StructuresPager } from './pagination.js';
import {
  buildConditions,
  buildExtraFilter,
  buildKeywordScope,
  buildTraversalFilter,
  FILTER_W_MAX,
  FILTER_W_MIN,
  getFilterState,
  mountFilterPanel,
  setFilterState,
  type FilterState,
} from './filter-panel.js';
import { mountFilterPanelFrame, type FilterPanelFrameHandle } from '../../lib/filter-panel-frame.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
/** Рукоятка общего каркаса панели отбора (скрытость/положение/размер). */
let structuresFrame: FilterPanelFrameHandle | null = null;
let resultsHost: HTMLElement | null = null;

/** Filter-result roots in sort order (the visible page, grows with «Показать ещё»). */
let resultIds: string[] = [];
/** Unrestricted match count of the current filter. */
let total = 0;
/**
 * Листание списка результатов (требование 3f2fdc41): продолжение читается по
 * `next_cursor` предыдущего ответа, `offset` не растёт; смена
 * фильтра/сортировки сбрасывает пейджер на первую страницу без курсора.
 */
const resultPager = new StructuresPager();

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

/** Composite cache key of the last init: `${networkId}:${tabId}` so the
 *  view re-initialises when EITHER the network or the active tab changes
 *  (per-tab filter snapshot, Q4). `null` until the first call. */
let networkIdSeen: string | null = null;
/** Loading guard so the tree does not flicker with stale data. */
let querySeq = 0;
/**
 * Отмена последнего запроса выборки (требование ebed4980, ADR b32aa57f):
 * быстрая смена фильтра гасит предыдущий запрос, а не оставляет его висеть
 * конкурентом за состояние. Серийный сторож `querySeq` остаётся — он ловит
 * уже доставленный, но устаревший ответ.
 */
let inflightQuery: AbortController | null = null;
/**
 * The last APPLIED filter (criteria + sort/order) — what the results tree
 * shows. The bulk «Команды» menu (L22, §15.3) runs against this, not against
 * the panel draft: a command must touch exactly what the user applied.
 */
let appliedQuery: {
  filter: StructureFilter;
  sort: FilterState['sort'];
  order: FilterState['order'];
} | null = null;

// ---------------------------------------------------------------------------
// View switching (L4 active_view)
// ---------------------------------------------------------------------------

/** Loads the persisted filter state and runs the first query (idempotent).
 *  Called by the shared view switcher (../active-view.js, L20). */
export async function ensureStructuresInitialised(): Promise<void> {
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  if (networkId === null || host === null) return;
  // Q-bugfix: cache key includes the active tab so switching tabs (same
  // network, different snapshot) re-reads `tab.structures_state` instead of
  // serving the previous tab's filter.
  const key = `${networkId}:${tabId ?? ''}`;
  if (networkIdSeen === key) return;
  networkIdSeen = key;

  // Reset per-network state (a previous network may still be loaded).
  resultIds = [];
  total = 0;
  refs.clear();
  hierarchy.clear();
  directions.clear();
  edges.clear();
  edgesSignature = '';
  expansion = new Map();
  appliedQuery = null;
  resultPager.reset();
  resetStructuresCursor();

  // Q4: prefer per-tab persisted filter, fall back to legacy ui_state when
  // the active tab has no entry (migration / fresh tab).
  try {
    let raw: string | null = null;
    if (tabId !== null) {
      const tab = store.state.tabs.find((t) => t.tab_id === tabId);
      raw = tab?.structures_state ?? null;
    }
    if (raw === null) {
      raw = await etn.ui.getState(networkId, UI_STATE_KEY.STRUCTURES_STATE);
    }
    if (raw !== null && raw !== '') setFilterState(parseFilterState(raw));
    // Миграционное значение прежней ширины панели (`structures_state`) —
    // каркас читает его геттером, поэтому переприменяем состояние после
    // восстановления снимка (если в `ui_state` своего размера ещё нет).
    structuresFrame?.apply();
  } catch {
    // Fall back to the empty filter (HOME).
  }
  await applyQuery(true);
}

/** A tri-state field of the persisted JSON: `true`/`false`, anything else → null. */
function parseTriState(value: unknown): boolean | null {
  return value === true || value === false ? value : null;
}

/** Coerces an unknown op value into the author-op union (default `eq`). */
function parseAuthorOp(value: unknown): 'eq' | 'ne' | 'in' | 'not_in' | 'empty' | 'not_empty' {
  if (
    value === 'eq' ||
    value === 'ne' ||
    value === 'in' ||
    value === 'not_in' ||
    value === 'empty' ||
    value === 'not_empty'
  ) {
    return value;
  }
  return 'eq';
}

/** Parses the persisted L4 `structures_state` JSON (unknown input, safe defaults). */
function parseFilterState(raw: string): FilterState {
  try {
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    return {
      keywords: typeof parsed.keywords === 'string' ? parsed.keywords : '',
      keywordInTitle: parsed.keywordInTitle !== false,
      keywordInSynonyms: parsed.keywordInSynonyms !== false,
      keywordInComment: parsed.keywordInComment === true,
      parentIds: Array.isArray(parsed.parentIds) ? parsed.parentIds.filter((v): v is string => typeof v === 'string') : [],
      typeIds: Array.isArray(parsed.typeIds) ? parsed.typeIds.filter((v): v is string => typeof v === 'string') : [],
      linkTypeIds: Array.isArray(parsed.linkTypeIds)
        ? parsed.linkTypeIds.filter((v): v is string => typeof v === 'string')
        : [],
      linkFilterTypeIds: Array.isArray(parsed.linkFilterTypeIds)
        ? parsed.linkFilterTypeIds.filter((v): v is string => typeof v === 'string')
        : [],
      linkFilterStructural: parsed.linkFilterStructural === true,
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
      trashed: parsed.trashed === true,
      // Задача 59119797 «Фильтры Автор/Редактор», эволюция операторов: op +
      // значение (одиночный id или массив для in/not_in).
      authorOp: parseAuthorOp(parsed.authorOp),
      authorId: typeof parsed.authorId === 'string' ? parsed.authorId : '',
      authorIds: Array.isArray(parsed.authorIds)
        ? parsed.authorIds.filter((v): v is string => typeof v === 'string')
        : [],
      editorOp: parseAuthorOp(parsed.editorOp),
      editorId: typeof parsed.editorId === 'string' ? parsed.editorId : '',
      editorIds: Array.isArray(parsed.editorIds)
        ? parsed.editorIds.filter((v): v is string => typeof v === 'string')
        : [],
      // Задача 7032e55a «Фильтры по датам»: ISO-8601 строка (или пустая).
      // В L4 `structures_state` сохраняется всегда (через `getFilterState()`);
      // старые JSON без этих полей получат дефолт `''` — граница не выставляется.
      createdAfter: typeof parsed.createdAfter === 'string' ? parsed.createdAfter : '',
      createdBefore: typeof parsed.createdBefore === 'string' ? parsed.createdBefore : '',
      updatedAfter: typeof parsed.updatedAfter === 'string' ? parsed.updatedAfter : '',
      updatedBefore: typeof parsed.updatedBefore === 'string' ? parsed.updatedBefore : '',
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
  const tabId = store.state.activeTabId;
  if (tabId === null) return;
  void etn.tabs
    .updateState(tabId, { structures_state: JSON.stringify(getFilterState()) })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Builds the wire filter from the panel state (empty arrays dropped). */
function buildFilter(): StructureFilter {
  const state = getFilterState();
  const filter: StructureFilter = { ...buildExtraFilter() };
  if (state.keywords.trim() !== '') {
    filter.keywords = state.keywords.trim();
    const scope = buildKeywordScope();
    if (scope !== undefined) filter.keyword_scope = scope;
  }
  if (state.typeIds.length > 0) filter.type_ids = state.typeIds;
  if (state.linkTypeIds.length > 0) filter.link_type_ids = state.linkTypeIds;
  const linkFilter = buildTraversalFilter();
  if (linkFilter !== undefined) filter.link_filter = linkFilter;
  const conditions = buildConditionsFromPanel();
  if (conditions.length > 0) filter.properties = conditions;
  if (store.state.showInactive) filter.show_inactive = true;
  return filter;
}

/** Runs the filter query; `reset` starts a fresh page, otherwise appends.
 *  `keepScroll` сохраняет позицию прокрутки при пересборке (realtime-перезапрос,
 *  дозагрузка); новый отбор и первый вход показывают список с начала. */
async function applyQuery(reset: boolean, keepScroll = false): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const state = getFilterState();
  const seq = ++querySeq;
  // Быстрая смена фильтра: гасим предыдущий запрос (требование ebed4980) —
  // его fetch в main прерывается, ответ не приходит вовсе.
  inflightQuery?.abort();
  const controller = new AbortController();
  inflightQuery = controller;
  // A fresh application re-anchors the bulk commands to the new result (L22)
  // and drops the keyset cursor — next page starts from scratch.
  if (reset) {
    appliedQuery = { filter: buildFilter(), sort: state.sort, order: state.order };
    resultPager.reset();
  }
  const page = resultPager.address(reset);
  try {
    const result = await etn.structures.query(
      networkId,
      {
        ...buildFilter(),
        sort: state.sort,
        order: state.order,
        limit: STRUCTURES_PAGE_SIZE,
        offset: page.offset,
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      },
      { signal: controller.signal },
    );
    if (seq !== querySeq) return; // a newer query won the race
    // Continuation rides the cursor of THIS page (requirement 3f2fdc41).
    resultPager.accept(result.next_cursor);
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
    renderTree(keepScroll);
  } catch (err) {
    // Отменённый запрос — не ошибка: его сменил более новый (требование
    // ebed4980). Ничего не показываем.
    if (controller.signal.aborted) return;
    notice(`Ошибка отбора: ${errText(err)}`, 'error');
  } finally {
    if (inflightQuery === controller) inflightQuery = null;
  }
}

// ---------------------------------------------------------------------------
// Expansion (§15.5)
// ---------------------------------------------------------------------------

/** Current flattened rows + per-node «Показать ещё» markers (§15.5). */
function currentTree(): { rows: TreeRow[]; moreMarkers: MoreMarker[] } {
  const tree = flattenStructuresTree(resultIds, expansion, neighborsOf);
  // Подпись видимого содержимого строки: keyed-сверка зовёт `update` только
  // тогда, когда метаданные мысли/эллипсы/раскрытость реально изменились —
  // так чужая правка (realtime) обновляет ОДНУ строку, не трогая соседние.
  for (const row of tree.rows) {
    row.rev = rowRenderSignature(refs.get(row.thoughtId), directions.get(row.thoughtId), expansion.get(row.key));
  }
  return tree;
}

/** Current flattened rows (render + exclude computation share this). */
function currentRows(): TreeRow[] {
  return currentTree().rows;
}

/** Neighbour ids of an expanded node direction, from the hierarchy cache. */
function neighborsOf(nodeKey: string, _thoughtId: string, dir: HierarchyDir): string[] {
  return hierarchy.get(`${nodeKey}|${dir}`)?.neighbors.map((n) => n.id) ?? [];
}

/**
 * Один запрос уровня дерева (раскрытие узла, «Показать ещё», перезапрос после
 * realtime). ЕДИНСТВЕННАЯ точка, откуда уходит `etn.structures.hierarchy(...)`:
 * здесь к запросу добавляется фильтр обхода по связям — ровно применённый к
 * текущему отбору (`appliedQuery.filter.link_filter`, тот же, что у спуска от
 * «Родительских мыслей»). Без этого раскрытая ветвь показывала соседей по
 * нетипизированным связям, которых отбор не включал (ошибка db504c1a).
 */
function fetchHierarchy(
  networkId: string,
  thoughtId: string,
  dir: HierarchyDir,
  opts: { excludeIds?: string[]; offset?: number } = {},
): Promise<HierarchyResponse> {
  return etn.structures.hierarchy(networkId, thoughtId, {
    dir,
    showInactive: store.state.showInactive,
    excludeIds: opts.excludeIds,
    offset: opts.offset,
    linkFilter: appliedQuery?.filter.link_filter,
  });
}

/** Expands or folds one node direction (ellipse click). */
async function toggleExpand(row: TreeRow, dir: HierarchyDir): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const flags = expansion.get(row.key) ?? {};
  if (flags[dir] === true) {
    // Fold: drop the CLICKED direction of this node plus everything nested
    // under that direction only (§15.5) — the other direction (its zone and
    // its subtree) stays untouched.
    const dropped = subtreeExpansionKeys(row.key, expansion, dir);
    for (const key of dropped) {
      if (key === row.key) {
        const f = expansion.get(key);
        if (f !== undefined) {
          delete f[dir];
          if (Object.keys(f).length === 0) expansion.delete(key);
          else expansion.set(key, f);
        }
        hierarchy.delete(`${key}|${dir}`);
        continue;
      }
      // Nested under the folded direction: the whole branch disappears.
      expansion.delete(key);
      hierarchy.delete(`${key}|parents`);
      hierarchy.delete(`${key}|children`);
    }
    renderTree(true);
    return;
  }
  // Expand: fetch one level with the per-branch dedup ids (§15.5).
  const excludeIds = branchThoughtIds(currentRows(), row.rootId);
  try {
    const data = await fetchHierarchy(networkId, row.thoughtId, dir, { excludeIds });
    // Every neighbor is already shown in this branch (per-branch dedup) —
    // nothing to reveal, so nothing changes (no shift, no expansion flag).
    if (data.neighbors.length === 0) return;
    hierarchy.set(`${row.key}|${dir}`, { neighbors: data.neighbors, hasMore: data.has_more });
    for (const ref of data.neighbors) refs.set(ref.id, ref);
    for (const [id, flags] of Object.entries(data.directions)) directions.set(id, flags);
    expansion.set(row.key, { ...flags, [dir]: true });
    renderTree(true);
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
    const data = await fetchHierarchy(networkId, thoughtId, dir, { excludeIds, offset });
    hierarchy.set(cacheKey, {
      neighbors: [...(cached?.neighbors ?? []), ...data.neighbors],
      hasMore: data.has_more,
    });
    for (const ref of data.neighbors) refs.set(ref.id, ref);
    for (const [id, flags] of Object.entries(data.directions)) directions.set(id, flags);
    renderTree(true);
  } catch (err) {
    notice(`Не удалось загрузить ещё: ${errText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Opening thoughts/links (§15.4, §15.6)
// ---------------------------------------------------------------------------

/**
 * Opens a thought in the editor without switching the canvas focus (§15.7)
 * and records it in the unified visit history (0.5.5).
 */
export async function openStructuresThought(id: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const thought = await etn.thoughts.get(networkId, id);
    await setThoughtEditorTarget(thought);
  } catch (err) {
    notice(`Не удалось открыть мысль: ${errText(err)}`, 'error');
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
  const splitter = splitterElement('st-splitter');
  const results = div('st-results');
  host.append(panel, splitter, results);
  resultsHost = results;
  // Общий каркас панели отбора (задача 2ebe4206): скрываемость плавающей
  // кнопкой, положение по ширине полотна (слева/вверху), перетаскивание
  // границы; состояние — локально в `ui_state.structures_filter_panel`.
  structuresFrame = mountFilterPanelFrame({
    container: host,
    panel,
    splitter,
    stateKey: UI_STATE_KEY.STRUCTURES_FILTER_PANEL,
    minSize: FILTER_W_MIN,
    maxSize: FILTER_W_MAX,
    legacySize: () => getFilterState().panelWidth,
  });
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
      void applyQuery(true);
    },
    onStatePersist: () => persistFilterState(),
    onCommands: (anchor) => {
      if (appliedQuery === null) return;
      openFilterCommandsMenu(anchor, {
        filter: appliedQuery.filter,
        sort: appliedQuery.sort,
        order: appliedQuery.order,
        refresh: () => scheduleStructuresRefresh(),
      });
    },
  });

  store.subscribe(() => {
    if (host === null || !host.isConnected) return;
    const networkId = store.state.networkId;
    const tabId = store.state.activeTabId;
    if (
      networkId !== null &&
      networkIdSeen !== `${networkId}:${tabId ?? ''}` &&
      store.state.activeView === 'structures'
    ) {
      void ensureStructuresInitialised();
      return;
    }
    if (store.state.activeView !== 'structures') return;
    reactToStore();
  });

  if (store.state.activeView === 'structures') void ensureStructuresInitialised();
}

// ---------------------------------------------------------------------------
// Store reaction: data layer vs visual layer (task 1a0a607d)
// ---------------------------------------------------------------------------

/**
 * Слой ДАННЫХ отрисовки: входные данные, смена которых требует пересборки
 * строк. Слой ВИЗУАЛЬНЫХ состояний (выборка, текущая мысль, цель редактора,
 * фокус холста) меняется дёшево и обрабатывается {@link patchVisualStates} без
 * пересоздания DOM.
 *
 * Почему сигнатуры со структурным сравнением (`deepEqual`), а не селекторы
 * `lib/ui/state.ts`: данные дерева (`resultIds`, `total`, `expansion`) живут в
 * модуле и меняются запросами БЕЗ обновления store, а дерево тогда
 * перерисовывается прямыми вызовами `renderTree`. Селектор запоминает срез
 * только на обновлениях store и после прямого `renderTree` остаётся устаревшим,
 * «вооружая» лишнюю пересборку на следующем постороннем апдейте. Поэтому срез
 * переанкерится самими путями отрисовки — {@link syncRenderSlices}.
 */
type DataSlice = readonly [string | null, number, number, number, number, string[]];
type VisualSlice = readonly [
  readonly string[],
  string | null,
  string | null,
  string,
  string,
];

/** Данные, от которых зависит состав строк дерева. */
function dataSlice(): DataSlice {
  const st = store.state;
  return [
    st.networkId,
    resultIds.length,
    total,
    st.linkTypes.length,
    st.thoughtTypes.length,
    [...expansion.keys()],
  ];
}

/** Визуальные состояния облачков: выборка, выделенная связь, цель редактора,
 *  фокус холста. «Кто текущий» включает `structuresActiveThoughtId` (его
 *  выставляет `setThoughtEditorTarget`) и `focus.focused.id`. */
function visualSlice(): VisualSlice {
  const st = store.state;
  return [
    st.selection,
    st.selectedLinkId,
    st.structuresActiveThoughtId,
    st.editorTarget?.kind ?? '',
    st.focus?.focused.id ?? '',
  ];
}

let lastDataSlice: DataSlice | null = null;
let lastVisualSlice: VisualSlice | null = null;

/** Зафиксировать срезы как отработанные — зовут пути отрисовки (полная сборка
 *  и точечный патч), чтобы прямой `renderTree` не «вооружил» лишний rebuild. */
function syncRenderSlices(data: DataSlice, visual: VisualSlice): void {
  lastDataSlice = data;
  lastVisualSlice = visual;
}

/** Реакция на обновление store: данные изменились — пересборка; изменился
 *  только визуальный слой — точечный патч классов. */
function reactToStore(): void {
  const data = dataSlice();
  const visual = visualSlice();
  if (lastDataSlice === null || !deepEqual(lastDataSlice, data)) {
    syncRenderSlices(data, visual);
    // Обновление слоя данных без явного сброса (подгрузка типов/связей, приход
    // имён) не должно уводить список вверх — позиция прокрутки сохраняется.
    renderTree(true);
    return;
  }
  if (lastVisualSlice === null || !deepEqual(lastVisualSlice, visual)) {
    syncRenderSlices(data, visual);
    patchVisualStates();
  }
}

/**
 * Точечно переставить классы облачков после изменения ТОЛЬКО визуального слоя
 * (задача 1a0a607d): DOM строк переиспользуется как есть — прокрутка, hover и
 * клавиатурный курсор (`syncStructuresCursor`) не затрагиваются. Выделенная
 * связь — надстройка верхнего слоя: обновляется `drawTopOverlay()` без строк.
 */
function patchVisualStates(): void {
  if (resultsHost === null) return;
  const selection = new Set(store.state.selection);
  patchCloudVisualStates(resultsHost, (id) => cloudVisualState(id, selection));
  // Клавиатурный курсор не синхронизируем: строки и его DOM-якоря не менялись.
  drawTopOverlay();
  syncRenderSlices(dataSlice(), visualSlice());
}

/** Визуальные классы одного облачка — ЕДИНОЕ определение для первичной сборки
 *  (`buildCloud`) и точечного патча. Текущая мысль — `currentThoughtId()`: то
 *  же определение, что у холста и панели истории (0.5.5), иначе гало разъедется. */
function cloudVisualState(thoughtId: string, selection: ReadonlySet<string>): CloudVisualState {
  return { selected: selection.has(thoughtId), halo: currentThoughtId() === thoughtId };
}

/**
 * Rebuilds the results tree from the current state. Инкрементально
 * (уровень 2 тех.проекта `1d48df6d`): внешний ключ — ветвь корня
 * (`.st-branch`, `data-root`), внутренний — строки ветви (`.st-row`, `data-key`)
 * и кнопки «Показать ещё». Неизменные строки НЕ пересоздаются — сохраняются
 * прокрутка, hover и клавиатурный курсор. Пустое состояние и футер листания
 * монтируются после сверки (вне keyed-слоя).
 *
 * An expanding/collapsing layout change plays a FLIP animation (§15.5): the
 * rows keep moving smoothly from their old places, freshly revealed rows
 * fade in, and removed rows dissolve in place — по статистике сверки
 * (`added`/`removed`/`moved`); без изменений кадр анимации не запускается.
 *
 *  `keepScroll` сохраняет позицию прокрутки через {@link preserveScroll}: сверка
 *  держит identity строк, но не сдвигает `scrollTop`, когда узлы выше кромки
 *  меняют высоту (раскрытие/свёртывание, дозагрузка). Новый отбор и первый вход
 *  показывают список с начала. */
function renderTree(keepScroll = false): void {
  if (host === null || resultsHost === null) return;
  if (keepScroll) {
    // Якорь снимается до сборки, позиция восстанавливается после (тот же путь
    // сборки без сохранения — иначе позиция сбросилась бы внутри самого rebuild).
    preserveScroll(resultsHost, () => renderTree(false));
    return;
  }
  const results = resultsHost;
  applyCanvasScaleVars(host);
  finalizeTreeAnimation();
  const before = captureTreeLayout();
  const { rows, moreMarkers } = currentTree();

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
  // remain attributable to its root. Ветвь — внешний элемент keyed-сверки,
  // её строки и «Показать ещё» — элементы вложенной сверки.
  const branches: TreeBranch[] = [];
  let currentBranch: TreeBranch | null = null;
  for (const row of rows) {
    if (currentBranch === null || row.rootId !== currentBranch.rootId) {
      currentBranch = { rootId: row.rootId, items: [] };
      branches.push(currentBranch);
    }
    currentBranch.items.push({ key: row.key, row, marker: null, node: null });
    const marker = markersByAfterKey.get(row.key);
    const node = marker !== undefined ? rowByKey.get(marker.nodeKey) : undefined;
    if (marker !== undefined && node !== undefined) {
      currentBranch.items.push({ key: moreMarkerKey(marker), row: null, marker, node });
    }
  }

  let changed = false;
  const branchStats = reconcileKeyed(results, branches, {
    keyAttr: 'data-root',
    key: (branch) => branch.rootId,
    // Ветвь меняется только составом строк — их сверяет вложенный вызов ниже.
    equals: (a, b) => a.rootId === b.rootId,
    build: (branch) => buildBranch(branch.rootId),
    update: () => undefined,
  });
  changed = branchStats.added.length > 0 || branchStats.removed.length > 0 || branchStats.moved;

  for (const branch of branches) {
    const branchEl = results.querySelector<HTMLElement>(`[data-root="${branch.rootId}"]`);
    if (branchEl === null) continue;
    const stats = reconcileKeyed(branchEl, branch.items, {
      keyAttr: 'data-key',
      key: (item) => item.key,
      build: (item) =>
        item.row !== null
          ? buildRow(item.row, selection)
          : buildMoreButton(item.marker as MoreMarker, item.node as TreeRow),
      update: (el, item) => {
        if (item.row !== null) fillRow(el, item.row, selection);
        else applyMoreButton(el as HTMLButtonElement, item.marker as MoreMarker, item.node as TreeRow);
      },
    });
    if (stats.added.length > 0 || stats.removed.length > 0 || stats.moved || stats.updated.length > 0) {
      changed = true;
    }
  }

  // Empty state and pagination footer (§15.4) — вне keyed-слоя: монтируются
  // после сверки и пересобираются целиком. Continuation is signalled by the
  // keyset cursor of the last page (`total` feeds only the counter, 3f2fdc41).
  if (total === 0) {
    const empty = div('st-empty');
    empty.textContent = 'Ничего не найдено — измените критерии отбора';
    results.append(empty);
  }
  if (resultPager.hasMore) {
    const more = el('button', 'st-more', 'Показать ещё');
    more.type = 'button';
    more.addEventListener('click', () => void applyQuery(false, true));
    results.append(more);
  }
  const counter = badge(`Показано ${resultIds.length} из ${total}`, {
    kind: 'quiet',
    extraClass: 'ui-badge--block',
  });
  results.append(counter);

  syncStructuresCursor();
  const animated = changed && applyTreeFlip(before);
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
  // Сборка применила и данные, и визуальные классы — фиксируем оба среза,
  // чтобы следующее постороннее обновление store не вызвало пересборку.
  syncRenderSlices(dataSlice(), visualSlice());
}

// ---------------------------------------------------------------------------
// FLIP animation of expand/collapse (§15.5)
// ---------------------------------------------------------------------------

/** Animation duration of one expand/collapse transition, ms. Kept in sync
 *  with the stFadeIn/stGhostDissolve keyframe durations in styles.css. */
const FLIP_MS = 400;
/** Ease-out curve: the move starts promptly and settles smoothly, so the eye
 *  follows the rows shifting to their new places (§15.5). */
const FLIP_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
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
  el.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASING}`;
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

/** Одна ветвь дерева (обрамление корня отбора) — внешний элемент keyed-сверки. */
interface TreeBranch {
  rootId: string;
  items: TreeBranchItem[];
}

/** Элемент ветви: строка дерева ИЛИ кнопка «Показать ещё» (одно из двух). */
interface TreeBranchItem {
  key: string;
  row: TreeRow | null;
  marker: MoreMarker | null;
  /** Строка, которую завершает маркер (для `loadMoreNeighbors`); у строки — сам себя. */
  node: TreeRow | null;
}

/** Устойчивый ключ кнопки «Показать ещё» в keyed-сверке ветви. */
function moreMarkerKey(marker: MoreMarker): string {
  return `more:${marker.nodeKey}:${marker.dir}`;
}

/** Ветвь-обрамление корня отбора: сверка наполнит её строками. */
function buildBranch(rootId: string): HTMLElement {
  const branch = div('st-branch');
  branch.dataset['root'] = rootId;
  return branch;
}

/** Builds one tree row: the root triangle (for filter results) + a cloud. */
function buildRow(row: TreeRow, selection: Set<string>): HTMLElement {
  const rowEl = div('st-row');
  fillRow(rowEl, row, selection);
  return rowEl;
}

/** Наполнить/обновить строку дерева (общая сборка и keyed-обновление). */
function fillRow(rowEl: HTMLElement, row: TreeRow, selection: Set<string>): void {
  rowEl.dataset['key'] = row.key;
  rowEl.dataset['id'] = row.thoughtId;
  rowEl.dataset['root'] = row.rootId;
  rowEl.style.setProperty('--st-indent', String(row.indent));
  if (row.via !== null) {
    // The link lines are drawn over the tree from these attributes (drawLinks).
    rowEl.dataset['via'] = row.via.otherId;
    rowEl.dataset['role'] = row.via.role;
  } else {
    delete rowEl.dataset['via'];
    delete rowEl.dataset['role'];
  }
  // Содержимое строки пересобирается только при её изменении (keyed-сверка):
  // сам узел строки сохраняется, поэтому прокрутка и позиция не теряются.
  rowEl.replaceChildren();
  if (row.root) rowEl.append(div('st-root-marker'));
  rowEl.append(buildCloud(row, selection));
  // Patch the indicator row from the shared canvas indicator cache/queue
  // (the cache hit applies synchronously to the fresh DOM, §15.4).
  queueIndicatorLoad(row.thoughtId);
}

/** Builds one per-node «Показать ещё» button (§15.5 pagination). */
function buildMoreButton(marker: MoreMarker, node: TreeRow): HTMLElement {
  const btn = el('button', 'st-more', 'Показать ещё');
  btn.type = 'button';
  applyMoreButton(btn, marker, node);
  return btn;
}

/** Настроить кнопку «Показать ещё»: отступ и обработчик (без наслоения). */
function applyMoreButton(btn: HTMLButtonElement, marker: MoreMarker, node: TreeRow): void {
  btn.style.setProperty('--st-indent', String(marker.indent));
  btn.onclick = () => void loadMoreNeighbors(marker.nodeKey, node.thoughtId, node.rootId, marker.dir);
}

/** Builds one thought cloud: same visual language as the canvas (§15.4). */
function buildCloud(row: TreeRow, selection: Set<string>): HTMLElement {
  const ref = refs.get(row.thoughtId) ?? null;
  // Базовая часть облачка — общая фабрика (профиль `tree`): значок, цвета и
  // начертание мысли, бледность неактуальной/помеченной, метка корзины и
  // единые жесты. Дерево добавляет домен структур: эллипсы, индикаторы,
  // клавиатуру и «открыть в редакторе» контекстом меню.
  const cloud = createThoughtCloud(
    ref ?? { id: row.thoughtId, title: '—' },
    {
      profile: 'tree',
      // Ширина — по колонке дерева: имя обрезается многоточием по ней
      // (раньше это делал контекстный селектор `.st-row .st-cloud.cloud`).
      width: 'container',
      actions: {
        onClick: (id) => void openStructuresThought(id),
        onCtrlClick: (id) => toggleSelection([id]),
        // Метка корзины на облачке узла (ошибка 8bbc9542): сосед-мысль в
        // корзине виден и помечен, как на карте, и клик по метке открывает
        // тот же диалог восстановления/удаления. Импорт ленивый — trash.ts
        // статически тянет этот модуль (scheduleStructuresRefresh), статический
        // импорт замкнул бы цикл.
        onTrashBadgeClick: (id) => {
          const networkId = store.state.networkId;
          if (networkId === null) return;
          void import('../../trash.js').then(({ openThoughtDeleteDialog }) =>
            openThoughtDeleteDialog(networkId, {
              id,
              title: refs.get(id)?.title ?? row.thoughtId,
            }),
          );
        },
        onContextMenu: (event, id) => {
          event.stopPropagation();
          showThoughtContextMenu(
            event,
            { id, title: ref?.title ?? row.thoughtId, dir: 'siblings' },
            {
              openHandler: (targetId) => void openStructuresThought(targetId),
              findOnMapHandler: (targetId) => {
                // «Найти на карте мыслей» (L23, §15.8): switch the view first so
                // the map is visible while the focus response arrives.
                setActiveView('map');
                void setFocus(targetId);
              },
            },
          );
        },
      },
    },
  );
  cloud.classList.add(ST_CLOUD_CLASS);
  // Выборка и гало — из единого определения (то же, что в точечном патче
  // `patchVisualStates`), иначе начальная сборка и патч разъедутся.
  const visual = cloudVisualState(row.thoughtId, selection);
  if (visual.selected) cloud.classList.add('selected');
  // Halo of the active thought (§15.7): the same accent ring around the cloud
  // as the canvas (§2.2.4) instead of the old full-width band. The "current
  // thought" is the thought open in the editor, else the canvas focus — the
  // same definition on every screen (0.5.5, unified visit history), so the
  // frame follows the thought across screen switches. While a link is open in
  // the editor there is no current thought and the halo fades (the link takes
  // the spotlight).
  if (visual.halo) cloud.classList.add('halo');

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
  // The ellipse click must not reach the cloud handler: the click means
  // "toggle this direction", not "activate the thought" (§15.5).
  topEllipse.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      void addNeighborsOf(row.thoughtId, 'parent');
      return;
    }
    void toggleExpand(row, 'parents');
  });
  bottomEllipse.addEventListener('click', (event) => {
    event.stopPropagation();
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

  // Indicator row identical to the canvas cloud (§15.4: 📝/📅/📎, patched
  // asynchronously via the shared indicator queue of canvas.ts).
  const ind = div('cloud-ind');
  const perm = span('📝', 'ind dim');
  const chrono = span('📅', 'ind dim');
  const att = span('📎', 'ind dim');
  markCommentPreview(perm, 'thought', row.thoughtId, ref?.title ?? '—');
  markChronoPreview(chrono, 'thought', row.thoughtId, ref?.title ?? '—');
  markAttachmentsPreview(att, 'thought', row.thoughtId, ref?.title ?? '—');
  ind.append(perm, chrono, att);
  // Индикаторы — под названием в колонке облачка (та же разметка, что на
  // холсте: `.cloud-main > .cloud-title + .cloud-ind`).
  const main = cloud.querySelector<HTMLElement>(':scope > .cloud-main');
  main?.append(ind);

  // Порядок эллипсов — как на холсте: верхний перед значком, нижний в конце.
  cloud.prepend(topEllipse);
  cloud.append(bottomEllipse);

  // Click opens the editor without moving the canvas focus; Ctrl toggles the
  // shared selection (unit gestures already mounted by the factory).
  cloud.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void openStructuresThought(row.thoughtId);
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
  if (ids.length === 0) {
    // §6.12 requires a non-empty ids list; an empty tree just drops the lines.
    edges.clear();
    drawLinks();
    return;
  }
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

// ---------------------------------------------------------------------------
// Realtime refresh (§15.4)
// ---------------------------------------------------------------------------

/**
 * Realtime-путь «Структур» (задача afcfb144, уровень 3 тех.проекта `1d48df6d`).
 *
 * **Таблица «событие → действие».**
 *
 * | Событие | Инкрементально | Fallback (полный перезапрос) |
 * |---|---|---|
 * | `thought.updated` | мысль уже видима и правка меняет только оформление/имя без влияния на порядок: `refs` + `update()` одной строки | нет среди видимых — игнор; сортировка `updated` — ЛЮБАЯ правка (ключ `updated_at`); сортировка `alpha` или активный текст. отбор + смена `title`; текст. отбор + `synonyms`; отбор по типам + `type_id`; скрытые неактуальные/корзина + `active`/`marked_for_deletion` |
 * | `thought.deleted` | убрать из `resultIds`/`refs`/`directions`/`hierarchy`/`edges` → строка уходит removed-путём сверки | нет среди видимых — игнор |
 * | `link.updated` | ребро нарисовано и меняется только оформление (`color`/`style`/`width`) → `edges` + перерисовка линий | ребро не нарисовано — игнор; смена концов (`source_id`/`target_id`) или `active`; смена `type_id` под активным фильтром обхода (сосед может выпасть из раскрытых уровней); `marked_for_deletion` при скрытой корзине (линия обязана исчезнуть) — состав/структура графа |
 * | `link.deleted` | ребро нарисовано → убрать из `edges` + перерисовать линии + точечный додар `directions` концов | ребро не нарисовано — игнор |
 * | `thought.created` | — | всегда: вхождение в отбор не проверяется (нет построения проверки членства) |
 * | `link.created`, `property-value.*`, `thought-type*`, `link-type*`, `property-definition.*`, `*-view.*`, `layer.merged` | — | всегда (состав/структура/каталог) |
 *
 * Очередь событий за окно дебаунса применяется ОДНИМ батчем → один reconcile
 * (`renderTree`) на окно. Наличие хоть одного fallback-события в окне отменяет
 * батч и запускает {@link reloadAll}. Локальные производители по-прежнему зовут
 * {@link scheduleStructuresRefresh} (полный путь) сами — своё realtime-эхо до
 * рендерера не доходит.
 *
 * **Эллипсы при удалении ребра.** Линия снимается точечно, но `directions`
 * (наполненность эллипсов) считается сервером по ВСЕМ активным связям мысли, а
 * не только по видимым, — из кэша `edges` её не вывести. Поэтому для концов
 * УДАЛЁННОГО ребра направления перечитываются точечно
 * ({@link refreshDirections}), а не полной перезагрузкой страницы. Правки,
 * меняющие состав графа (в том числе смена типа под фильтром обхода и пометка
 * корзины при скрытой корзине), идут полным путём — эллипсы берутся из
 * перезапроса.
 */
type StructuresRealtimeOp =
  | { kind: 'thought-updated'; id: string; changes: ThoughtUpdateInput }
  | { kind: 'thought-deleted'; id: string }
  | { kind: 'link-updated'; id: string; changes: LinkUpdateInput }
  | { kind: 'link-deleted'; id: string };

const realtimeBatch = createRealtimeBatch<StructuresRealtimeOp>({
  windowMs: 400,
  applyBatch: (ops) => applyStructuresOps(ops),
  applyFull: () => {
    void reloadAll();
  },
});

/** Коллекции снимка экрана для чистого применощего модуля. */
function structuresState(): StructuresState {
  return { refs, edges, resultIds, directions, hierarchy };
}

/** Критерии отбора, влияющие на применимость события к строке. */
function criteriaSnapshot(): {
  sort: StructureSort;
  keywords: string;
  typeIds: readonly string[];
  showInactive: boolean;
  showTrash: boolean;
} {
  const state = getFilterState();
  return {
    sort: state.sort,
    keywords: state.keywords,
    typeIds: state.typeIds,
    showInactive: store.state.showInactive,
    showTrash: store.state.showTrash,
  };
}

/** Критерии, влияющие на применимость правки РЕБРА (эллипсы концов). */
function linkCriteriaSnapshot(): StructuresLinkCriteria {
  return {
    // Фильтр обхода по типам связей активен ровно тогда, когда задан у
    // применённого отбора (тот же, что у раскрытия — `fetchHierarchy`).
    linkFilterActive: appliedQuery?.filter.link_filter !== undefined,
    showTrash: store.state.showTrash,
  };
}

/**
 * Применить накопленный батч к снимку и ОДИН раз свернуть дерево. Пустой батч
 * (событие не изменило видимого) кадр сверки не запускает. Для концов
 * изменённого/удалённого ребра дополнительно запускается точечный додар
 * направлений ({@link refreshDirections}).
 */
function applyStructuresOps(ops: readonly StructuresRealtimeOp[]): void {
  const state = structuresState();
  const refreshDirectionsFor = new Set<string>();
  let changed = false;
  for (const op of ops) {
    switch (op.kind) {
      case 'thought-updated':
        if (applyThoughtUpdateToState(state, op.id, op.changes)) changed = true;
        break;
      case 'thought-deleted': {
        const wasRoot = resultIds.includes(op.id);
        if (removeThoughtFromState(state, op.id)) {
          changed = true;
          if (wasRoot) total = Math.max(0, total - 1);
        }
        break;
      }
      case 'link-updated': {
        // Всё, что меняет состав графа (концы, active, тип под фильтром
        // обхода, пометка корзины при скрытой корзине), уходит полным путём
        // ещё в `applyStructuresRealtime`; сюда доходит только точечное
        // оформление нарисованного ребра (цвет/стиль/ширина/тип/пометка).
        if (applyLinkUpdateToState(state, op.id, op.changes)) changed = true;
        break;
      }
      case 'link-deleted': {
        const edge = edges.get(op.id);
        if (edge !== undefined) {
          refreshDirectionsFor.add(edge.source_id);
          refreshDirectionsFor.add(edge.target_id);
        }
        if (removeLinkFromState(state, op.id)) changed = true;
        break;
      }
    }
  }
  if (changed) renderTree(true);
  if (refreshDirectionsFor.size > 0) void refreshDirections(refreshDirectionsFor);
}

/**
 * Точечный додар свежих `directions` (наполненности эллипсов) для концов
 * удалённого ребра. Эллипс сервер считает по ВСЕМ активным связям мысли с
 * учётом фильтра обхода и видимости корзины, поэтому из локального кэша
 * `edges` (связи только среди видимых) его не вывести.
 *
 * Источник — та же точка {@link fetchHierarchy}, что и раскрытие: тот же
 * `link_filter` отбора и `showInactive`/корзина, значит и та же семантика
 * закраски. Соседей и рёбра ответа НЕ сливаем в снимок — берём лишь флаги
 * нужных мыслей. Додар не удался — полный путь ({@link reloadAll}): эллипс
 * нельзя оставить неверным.
 */
async function refreshDirections(ids: ReadonlySet<string>): Promise<void> {
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  const seen = `${networkId}:${tabId ?? ''}`;
  if (networkId === null) return;
  let fresh: ReadonlyArray<readonly [string, { has_incoming: boolean; has_outgoing: boolean } | undefined]>;
  try {
    fresh = await Promise.all(
      [...ids].map(
        async (id) =>
          [id, (await fetchHierarchy(networkId, id, 'children', {})).directions[id]] as const,
      ),
    );
  } catch {
    realtimeBatch.markFull();
    return;
  }
  // Сменили сеть/вкладку, пока шёл додар, — ответ устарел.
  if (networkIdSeen !== seen) return;
  let changed = false;
  for (const [id, flags] of fresh) {
    if (flags === undefined) continue;
    const prev = directions.get(id);
    if (
      prev === undefined ||
      prev.has_incoming !== flags.has_incoming ||
      prev.has_outgoing !== flags.has_outgoing
    ) {
      directions.set(id, flags);
      changed = true;
    }
  }
  if (changed) renderTree(true);
}

/**
 * Принять чужое realtime-событие: классифицировать и положить в очередь окна
 * (батч) или пометить окно как fallback. Событие по невидимой сущности
 * игнорируется — состав отбора по нему не перестраиваем.
 *
 * Гейта по активному виду НЕТ (замечание проверки уровня 3): снимок экрана
 * поддерживается и когда «Структуры» не показаны — иначе `thought.deleted` вне
 * экрана не чистил бы `refs`/активную мысль, и при возврате оставалась бы
 * устаревшая строка (ре-квери при возврате не запускается). Отрисовка (один
 * reconcile на окно) идёт тем же путём.
 */
export function applyStructuresRealtime(evt: AnyRealtimeEvent): void {
  switch (evt.type) {
    case 'thought.updated': {
      const { id, changes } = evt.data;
      if (!refs.has(id)) return;
      if (thoughtChangeNeedsReload(changes, criteriaSnapshot())) {
        realtimeBatch.markFull();
        return;
      }
      realtimeBatch.push({ kind: 'thought-updated', id, changes });
      return;
    }
    case 'thought.deleted': {
      const { id } = evt.data;
      clearActiveThought(id);
      if (!refs.has(id) && !resultIds.includes(id)) return;
      realtimeBatch.push({ kind: 'thought-deleted', id });
      return;
    }
    case 'link.updated': {
      const { id, changes } = evt.data;
      if (!edges.has(id)) return;
      if (linkChangeNeedsReload(changes, linkCriteriaSnapshot())) {
        realtimeBatch.markFull();
        return;
      }
      realtimeBatch.push({ kind: 'link-updated', id, changes });
      return;
    }
    case 'link.deleted': {
      const { id } = evt.data;
      if (!edges.has(id)) return;
      realtimeBatch.push({ kind: 'link-deleted', id });
      return;
    }
    default:
      return;
  }
}

/**
 * Полный путь: пометить окно дебаунса как требующее перезапроса страницы и
 * всех раскрытых уровней ({@link reloadAll}). Зовётся локальными
 * производителями и realtime-ветками, которые нельзя применить точечно.
 */
export function scheduleStructuresRefresh(): void {
  if (store.state.activeView !== 'structures') return;
  realtimeBatch.markFull();
}

/** Reloads the page and all expanded hierarchy levels. */
async function reloadAll(): Promise<void> {
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  if (networkId === null || networkIdSeen !== `${networkId}:${tabId ?? ''}`) return;
  await applyQuery(true, true);
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
        const data = await fetchHierarchy(networkId, row.thoughtId, dir, { excludeIds });
        hierarchy.set(cacheKey, { neighbors: data.neighbors, hasMore: data.has_more });
        for (const ref of data.neighbors) refs.set(ref.id, ref);
        for (const [id, flags2] of Object.entries(data.directions)) directions.set(id, flags2);
        for (const edge of data.edges) edges.set(edge.id, edge);
      } catch {
        // Keep the previous data for this node.
      }
    }
  }
  renderTree(true);
}

/** Сбросить «текущую мысль» (и цель редактора), если удалена именно она. */
function clearActiveThought(id: string): void {
  if (store.state.structuresActiveThoughtId !== id) return;
  store.update({
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
    ...(store.state.editorTarget?.kind === 'thought' ? { editorTarget: null } : {}),
  });
}

/** Drops caches after a thought was deleted locally (also see history prune). */
export function invalidateStructuresThought(id: string): void {
  refs.delete(id);
  clearActiveThought(id);
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
