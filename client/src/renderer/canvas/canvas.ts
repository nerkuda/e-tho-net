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
import type { FocusEdge, FocusNeighbor, FocusResponse, ThoughtRef } from '@etn/shared';

import { scheduleRefresh, setFocus } from '../app.js';
import { openThoughtInEditor } from '../editor/editor.js';
import { clear, div, el, setTooltip, span } from '../lib/dom.js';
import { resolveEffectiveCanvasLinkFilter } from '../lib/effective-link-filter.js';
import { takeFocusOrigin } from '../lib/focus-origin.js';
import { etn } from '../lib/etn.js';
import { ensureLink, throwOnFailures } from '../lib/link-ops.js';
import { holderNameByUserId as resolveLockHolderName } from '../lib/lock-cache.js';
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
// Канон стиля/значка облачка и отложенный одиночный клик живут в общей
// фабрике (задача b28ab6d6): облачка холста собирает `createThoughtCloud`,
// `deferSingleClick`/`SINGLE_CLICK_DELAY_MS` реэкспортируются для
// совместимости.
import {
  createThoughtCloud,
  deferSingleClick,
  SINGLE_CLICK_DELAY_MS,
} from '../lib/thought-cloud.js';
import {
  anchorOffset,
  CLOUD_TITLE_LINES_MIN,
  cloudGeom,
  cloudHeight,
  contrastText,
  neighborsDirForEllipse,
  neighborsPreviewBounds,
  neighborsPreviewHeading,
  shortenCompoundName,
  sortRefsByTitle,
  ZONE_ANCHOR_BY_DIR,
  zoneContentWidth,
} from '../lib/pure.js';
import {
  createZonePaging,
  planZoneReconcile,
  shouldLoadMore,
  zoneCountLabel,
  ZONE_PAGE_SIZE,
  type ZonePagingCounters,
} from '../lib/zone-paging.js';
import { notifyPropertyValuesRefreshed } from '../lib/property-values-refresh.js';
import { LABEL_OPACITY, currentLayerColors, layerLabelView } from '../lib/layer-colors.js';
import { store } from '../state.js';
import {
  initLinksOverlay,
  drawLinksNow,
  setEllipseHover,
  setDragLinkLine,
  setSupplementalEdges,
  hasSupplementalEdges,
  LINK_LABEL_FONT_BASE,
} from './links.js';
import {
  captureClouds,
  finishFocusTransition,
  playFocusTransition,
  prefersReducedMotion,
} from './transition.js';
import { mountAddDialog, wireZoneExternalDrops } from './add-dialog.js';
import { showThoughtContextMenu, showZoneContextMenu } from './context-menu.js';
import { wireCloudDrag } from './drag-cloud.js';
import { initKbdNav, resetCanvasCursor, setCursor, syncCanvasCursor } from './kbd-nav.js';
import { mountZoneSplitters } from './zone-splitters.js';
import { splitterElement } from '../lib/ui/splitter.js';
import {
  getActiveMode as getStripActiveMode,
  loadPersistedStrip,
  mountFilterStrip,
  onModeChange as onStripModeChange,
  renderStrip as renderFilterStrip,
  runActiveViewIfNeeded,
  type ViewResult,
} from './focus-filter-strip.js';
import { openThoughtDeleteDialog } from '../trash.js';

// Канон облачка перенесён в lib/thought-cloud.ts (задача b28ab6d6): облачка
// холста (фокус и зоны) собирает `createThoughtCloud`; здесь остаётся только
// реэкспорт отложенного одиночного клика для совместимости (тесты и
// соседние модули холста).
export { deferSingleClick, SINGLE_CLICK_DELAY_MS };

/** Zone directions of the canvas (parents/siblings/children). */
export type ZoneDir = 'parents' | 'siblings' | 'children';

/** Neighbours grouped by thought id (several links may point at one thought). */
export interface ZoneEntry {
  id: string;
  links: FocusNeighbor[];
  ref: ThoughtRef | null;
  /**
   * Related titles the cloud shortens its compound name against, when the
   * entry comes from a view run result rather than a real focus neighbour
   * (08-ui-spec.md §2.2.3). The lower zone under a view shows the focus's
   * view result "with the same clouds as children" (spec 9984aa98), but its
   * thoughts may have no link to the focus at all — so they cannot be found
   * in {@link relatedTitles} (built from focus edges) and must carry the
   * focus title explicitly. Undefined for real neighbours, which keep the
   * edge-based map (regression cbb91b62).
   */
  viewResultRelated?: readonly string[];
}

/** Comment/attachment counts shown in the cloud indicators row. */
export interface IndicatorInfo {
  permanent: boolean;
  chrono: number;
  attachments: number;
}

/** Overlap rows rendered beyond the visible window (virtualization). */
const OVERSCAN_ROWS = 2;
/** Padding of a `.zone` in px (matches the CSS `padding: 12px`); the grid is
 *  anchored inside the zone's CONTENT box, so the padding is discounted on both
 *  axes when the anchor offset is computed. */
const ZONE_PADDING_PX = 12;
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
  /**
   * Title of the anchor itself. The «вверх/вниз к …» suffix of the dialog names
   * the CALL OWNER (08-ui-spec.md §4.1–4.2) — for an ellipse drag that is the
   * thought whose ellipse was dragged, never the focused thought (ошибка
   * c8bd4676). Supplied by the drag source; the dialog falls back to the
   * focused thought for legacy callers that do not know the anchor's name.
   */
  anchorTitle?: string;
  /** Top ellipse → new parent; bottom ellipse → new child. */
  direction: 'parent' | 'child';
}

/** Pending ellipse drag state. */
interface DragState {
  anchorId: string;
  /** Anchor's own title — carried into the add dialog (see {@link AddDialogContext}). */
  anchorTitle: string;
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
/** Layer-name stripe at the left edge of the focus zone (0.6.4 §2.2a). */
let layerLabelEl: HTMLElement | null = null;
let layerLabelText: HTMLElement | null = null;
/** Change-detection key of the last painted label (skips no-op writes). */
let lastLabelKey = '';
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
/**
 * Counter of evicted rendered refs. `invalidateRef`/`invalidateAllRefs` bump
 * it when they drop an entry the canvas may be showing, so a content-identical
 * focus re-fetch still triggers a repaint ({@link canvasRenderKey}); without it
 * a neighbour's new icon never reached its cloud (ошибка 1ea2d05a).
 */
let refEpoch = 0;
/** Indicator cache (id → counts), invalidated on comment/attachment events. */
const indicatorCache = new Map<string, IndicatorInfo>();
const indicatorQueue: string[] = [];
let indicatorRunning = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Отписки глобальных подписок канваса (режим полосы отборов, store, lock-бейджи)
 * и `ResizeObserver` хоста. Собираются на монтировании и снимаются возвращённым
 * teardown-хендлом: без этого каждое перемонтирование рабочего пространства
 * добавляло живого слушателя, и клик по кнопке отбора запускал `render()` по
 * ВСЕМ прошлым монтированиям — N параллельных POST `views/run` (ошибка 37b713de).
 */
let stripModeUnsubscribe: (() => void) | null = null;
let storeUnsubscribe: (() => void) | null = null;
let lockBadgeUnsubscribe: (() => void) | null = null;

/**
 * Mounts the canvas into the workspace canvas host. Called by the workspace
 * builder; the canvas re-renders on every store change (focus/width/gap).
 *
 * Returns a teardown handle that releases every global subscription/observer
 * registered here. The workspace builder MUST call it before rebuilding the
 * canvas (см. `teardownWorkspace`), otherwise listeners accumulate across
 * mount cycles (ошибка 37b713de).
 */
export function mountCanvas(canvasHost: HTMLElement): () => void {
  host = canvasHost;
  // A remount (layer/view switch) may find a transition still running against
  // the previous host — drop its layers/timers before the DOM is wiped.
  finishFocusTransition();
  host.replaceChildren();
  clear(host);
  // Wire the lock-badge refresh once — `store.subscribe` is a cheap
  // pointer per render frame, and the body is gated on `lockCacheTick`
  // so unrelated store updates are O(1).
  wireLockBadgeRefresh();

  const top = div('canvas-top');
  const zoneParents = buildZone('parents');
  const zoneSiblings = buildZone('siblings');
  const zoneSplitterV = splitterElement('zone-splitter zone-splitter-v');
  top.append(zoneParents, zoneSplitterV, zoneSiblings);

  focusRow = div('canvas-focus-row');

  const zoneChildren = buildZone('children');
  // Draggable zone splitters (08-ui-spec.md §2.1): vertical inside the top
  // strip, horizontal between the focus row and the children zone.
  const zoneSplitterH = splitterElement('zone-splitter zone-splitter-h');

  const empty = div('canvas-empty');
  empty.textContent = 'Нет открытой сети';

  // Layer-name stripe (0.6.4, §2.2a): vertical text at the left edge of the
  // focus zone, non-interactive — painted over the focus band, under the
  // link overlays. Hidden on the base layer (see updateLayerLabel).
  layerLabelEl = div('layer-label');
  layerLabelText = el('span', 'layer-label-text');
  layerLabelEl.append(layerLabelText);
  layerLabelEl.setAttribute('aria-hidden', 'true');

  host.append(top, focusRow, zoneSplitterH, zoneChildren, empty, layerLabelEl);
  zones = { parents: zoneParents, siblings: zoneSiblings, children: zoneChildren };
  emptyEl = empty;
  const linksOverlay = initLinksOverlay(host);
  redrawLinks = linksOverlay.redraw;
  applyCanvasScaleVars(host);

  // Focus filter strip (task 02ba2ae7, spec 9984aa98) — sits between the
  // focus row and the children zone. It owns its own DOM and L4 state,
  // but renders the lower zone's content together with the canvas render
  // path via `getActiveMode()` + `takeViewResult()`.
  mountFilterStrip(host);
  // Wire the strip mode as a render trigger: every button click invalidates
  // the lower zone, so the canvas must repaint. The strip fires the
  // listener synchronously after persisting the new mode.
  // Keep the unsubscribe handle — the listener must not survive a remount
  // (ошибка 37b713de).
  stripModeUnsubscribe = onStripModeChange(() => {
    void render();
  });
  // Load the persisted strip map once per tab mount (the strip module owns
  // it). Errors are swallowed — L4 is best-effort.
  void loadPersistedStrip();
  const disposeZoneSplitters = mountZoneSplitters({
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

  storeUnsubscribe = store.subscribe(() => {
    if (host?.isConnected !== true) return;
    // The label follows layer/theme changes even when the canvas data itself
    // is unchanged (the fast path below skips the full rebuild).
    updateLayerLabel();
    // Свежий ответ фокуса мог не изменить ничего рисуемого: мысль, добавленная
    // за уже загруженной порцией сектора, в ответе не видна, а индикатор-число
    // и порция обязаны обновиться сразу (ошибка ec5ba58c). Поэтому сверка
    // секторов идёт ДО fast-path, который на таком ответе пропускает `render()`.
    syncZoneTotalsWithFreshFocus();
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
      // `editorTarget` is intentionally NOT part of `canvasRenderKey`
      // (task ff82809a): a click on a parent/sibling only changes which
      // thought is open in the editor. Update the single `.halo` cloud in
      // place instead of rebuilding every zone.
      const haloId =
        store.state.editorTarget?.kind === 'thought'
          ? store.state.editorTarget.id
          : null;
      if (haloId !== lastHaloId) {
        lastHaloId = haloId;
        paintHalo();
      }
      return;
    }
    lastRenderKey = key;
    lastSelectionKey = selectionKey();
    lastHaloId =
      store.state.editorTarget?.kind === 'thought'
        ? store.state.editorTarget.id
        : null;
    void render();
  });
  // The focus band follows the focus row, whose position depends on the zone
  // shares and the host size — re-anchor it on resizes too (L12).
  const resizeObserver = new ResizeObserver(() => {
    if (host?.isConnected === true) updateFocusBand();
  });
  resizeObserver.observe(host);
  void render();

  // Teardown handle: releases every global subscription/observer wired above.
  // Idempotent — a second call is a no-op (handles are cleared).
  return () => {
    stripModeUnsubscribe?.();
    stripModeUnsubscribe = null;
    storeUnsubscribe?.();
    storeUnsubscribe = null;
    lockBadgeUnsubscribe?.();
    lockBadgeUnsubscribe = null;
    lockBadgeRefreshWired = false;
    resizeObserver.disconnect();
    linksOverlay.dispose();
    disposeZoneSplitters();
    // Detach the DOM handles so no late async render paints into a dead host.
    host = null;
    zones = null;
    focusRow = null;
    emptyEl = null;
    focusCloudEl = null;
    layerLabelEl = null;
    layerLabelText = null;
    redrawLinks = null;
  };
}

/** Returns the cached metadata for a thought id, or null. */
export function getRef(id: string): ThoughtRef | null {
  return refCache.get(id) ?? null;
}

/**
 * Drops the cached metadata for a thought so the next render re-resolves it
 * (icon/type/colors). Called on realtime `thought.updated`/`thought.deleted`
 * and by local producers (`reflectThoughtUpdate`) that got no realtime echo.
 *
 * Evicting a ref that IS rendered bumps {@link refEpoch}: the focus response
 * carries no icon/colors of a neighbour, so a re-fetch of the same focus is
 * content-identical and the content-addressed {@link canvasRenderKey} would
 * otherwise skip the repaint — the stale icon of the thought while it is not
 * the focus persisted until the next focus switch (ошибка 1ea2d05a).
 */
export function invalidateRef(id: string): void {
  if (refCache.delete(id)) refEpoch++;
  notifyRefInvalidated(id);
}

/**
 * Drops every cached thought ref — used on layer switches (13-layers.md §12):
 * refs resolved in the previous layer's context carry that layer's flags
 * (trash mark, active, colors), and a stale trash badge would otherwise
 * survive the switch until the thought is re-read by some other path.
 */
export function invalidateAllRefs(): void {
  if (refCache.size > 0) refEpoch++;
  refCache.clear();
  notifyRefInvalidated(null);
}

/**
 * Подписчики на сброс кэша метаданных мыслей. Панели со СВОИМ кэшем ref-ов
 * (панель выделенных) обновляют по этому сигналу свои строки точечно, не
 * подписываясь на весь store: иначе панель перерисовывалась на каждое событие
 * магазина — в т.ч. на догрузку длинных списков — и мигала (ошибка 3a64e680).
 * `id` — конкретная мысль, `null` — сброшен весь кэш.
 */
const refInvalidationListeners = new Set<(id: string | null) => void>();

/** Регистрирует подписчика на сброс ref-кэша; возвращает отписку. */
export function onThoughtRefInvalidated(cb: (id: string | null) => void): () => void {
  refInvalidationListeners.add(cb);
  return () => {
    refInvalidationListeners.delete(cb);
  };
}

/** Оповещает подписчиков о сбросе ref-кэша (см. {@link onThoughtRefInvalidated}). */
function notifyRefInvalidated(id: string | null): void {
  for (const cb of [...refInvalidationListeners]) cb(id);
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
 *
 * `editorTarget` / `selectedLinkId` are deliberately excluded: they only
 * affect the editor and the `.halo` class on a single cloud, and would
 * otherwise force a full zone rebuild on every click in the upper zones
 * (task ff82809a). Their updates are handled in the subscriber's
 * fast path (`paintHalo` + `links.ts`'s own subscription).
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
    // Live override marking (08-ui-spec.md §2.2): the badge/dashed outline is
    // painted by a full render — without this field a post-mutation override
    // refresh hit the selection-only fast path and the badge only appeared
    // after the next focus/layer change repainted the canvas.
    layerOverrides: s.layerOverrides,
    // Evicted rendered refs (ошибка 1ea2d05a): a neighbour's icon/colors live
    // only in `refCache` (the focus response does not carry them), so an
    // invalidation of a shown ref must break the content-addressed fast path
    // and force `render()` to re-resolve it — otherwise the cloud kept the
    // stale icon until the next focus switch.
    refEpoch,
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

/** Repaints the `.halo` cloud class — the single thought open in the editor
 *  (§2.2.4). Called from the store subscriber when `editorTarget` changes;
 *  cheap (one DOM pass) and keeps clicks in the upper zones from rebuilding
 *  the lower zone (task ff82809a). */
function paintHalo(): void {
  if (host === null) return;
  const editorTarget = store.state.editorTarget;
  const haloId = editorTarget?.kind === 'thought' ? editorTarget.id : null;
  for (const cloud of host.querySelectorAll<HTMLElement>('.cloud')) {
    const id = cloud.dataset['id'];
    cloud.classList.toggle('halo', id !== undefined && id === haloId);
  }
}

/** Renders everything from the current store state. */
async function render(): Promise<void> {
  if (host === null || zones === null || focusRow === null) return;
  // A real data update arriving mid-flight wins: snap any running transition to
  // its final state (release the held focus, drop the clones/layers) BEFORE the
  // old layout is captured and rebuilt. The rebuild below then starts from the
  // settled positions, so animations never run against dead coordinates.
  finishFocusTransition();
  applyCanvasScaleVars(host);
  const focus = store.state.focus;
  if (focus === null) {
    emptyEl?.classList.remove('hidden');
    resetFocusBand(host);
    resetCanvasCursor();
    // The strip hides itself when there is no focus; nothing to do here.
    void renderFilterStrip(null);
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
  // A new neighbourhood invalidates the paged sectors (задача c8fa74ba):
  // appended pages belong to the previous focus, and in-flight page requests
  // must not land on the new one.
  if (focusChanged) resetZonePaging(focus);
  const animate = (focusChanged || zoneAnimationPending) && !prefersReducedMotion();
  zoneAnimationPending = false;
  const snapshot = animate ? captureClouds(host) : null;
  // Source of the flight when the focus was picked OUTSIDE the map (pinned /
  // history / search chip, `lib/focus-origin.ts`). Consumed on every focus
  // change — even when this render turns out not to animate — so a stale click
  // box never leaks into a later focus change.
  const externalOrigin = focusChanged ? takeFocusOrigin(focus.focused.id) : null;

  // The focused thought is always fresh in the focus response — refresh the
  // neighbour cache so its (possibly just-edited) style, icon and title show
  // correctly when it later appears in a zone instead of the focus row.
  refCache.set(focus.focused.id, focus.focused);

  // Enrich neighbour metadata (colors/fonts/icon_kind are not in FocusNeighbor).
  await enrichRefs(focus);
  relatedTitles = visibleRelatedTitles(focus);
  // Resolve the filter strip and any active view result BEFORE rebuilding the
  // DOM. The rebuild and the focus transition MUST share one synchronous task
  // (дефект 1 задачи e9f0af94): otherwise the browser paints a frame with the
  // NEW focus content in the centre after `renderFocusRow` and before
  // `playFocusTransition` hides it — the new thought flashes in place, then the
  // old focus "returns" as the held overlay. Hoisting every await above the
  // rebuild means the first painted frame of the new state already holds the
  // old content. `guard-focus-animation` guards the invariant.
  await renderFilterStrip(focus);
  const stripMode = getStripActiveMode();
  let viewResult: ViewResult | null = null;
  if (stripMode.kind !== 'children') {
    // Run the view against the focused thought (no-op if already cached).
    // The mode change listener also calls `render()`; this call may execute
    // repeatedly during a mode toggle, and the strip's run cancellation keeps
    // stale responses from overwriting fresh ones.
    viewResult = await runActiveViewIfNeeded(focus.focused.id);
  }

  // --- Rebuild + transition: one synchronous task, one paint --------------
  renderFocusRow(focus);
  updateFocusBand();
  renderZone('parents', groupByThought(zoneNeighbors('parents', focus)));
  renderZone('siblings', groupByThought(zoneNeighbors('siblings', focus)));
  // Lower zone: the strip's active mode decides whether it shows real children
  // or a view's run result. View results share the children-zone DOM (same
  // virtualization, same cloud shape) but the gestures that imply a
  // parent/child link to the focus (manual order, double-click-to-add) are
  // gated on `viewResultActive`.
  if (stripMode.kind === 'children') {
    renderZone('children', groupByThought(zoneNeighbors('children', focus)));
    setZoneAsViewResult(false, null);
  } else {
    renderZone('children', viewResultToZoneEntries(viewResult, focus));
    setZoneAsViewResult(true, viewResult);
  }
  lastFocusId = focus.focused.id;
  // The response is now on screen: a further store notification with the SAME
  // object is a layout/selection re-render, not fresh neighbourhood data.
  lastFocusResponse = focus;
  // Totals for the count indicators (async) — a fresh focus seeds every
  // sector's counters; a fresh response for the SAME focus is reconciled by
  // `syncZoneTotalsWithFreshFocus` from the store subscriber.
  if (focusChanged) void ensureZoneTotals(focus);
  paintZoneIndicators();
  scheduleIndicatorLoads();
  if (snapshot !== null) {
    playFocusTransition(host, snapshot, drawLinksNow, externalOrigin);
  } else {
    redrawLinks?.();
  }
  syncCanvasCursor();
}

/** Marks the children zone as carrying a view result so the gestures that
 *  imply a parent/child link to the focus (manual order, double-click-to-add)
 *  short-circuit (task 02ba2ae7, requirement «Исключительность зон»). */
function setZoneAsViewResult(active: boolean, result: ViewResult | null): void {
  if (zones === null) return;
  const zone = zones['children'];
  zone.classList.toggle('zone-children-view-result', active);
  // The empty-state copy is owned by the zone renderer; here we only flip
  // the body class so other modules (cloud drag, manual order, dblclick)
  // can short-circuit. When `result` is non-null we also store it on the
  // dataset so the empty-state text can switch between "Ничего не найдено"
  // and the unresolved-token explanation.
  if (result !== null) {
    zone.dataset['viewResult'] = result.empty ? 'empty' : 'normal';
    if (result.unresolved !== null) {
      zone.dataset['viewResult'] = 'unresolved';
      zone.dataset['unresolved'] = JSON.stringify(result.unresolved);
    } else {
      delete zone.dataset['unresolved'];
    }
  } else {
    delete zone.dataset['viewResult'];
    delete zone.dataset['unresolved'];
  }
}

/** Builds ZoneEntry rows for the children zone from a view run result. The
 *  canvas's virtualization expects `FocusNeighbor`-shaped entries (it uses
 *  `id` for keys and the link count for ellipses), so we synthesise the
 *  minimum surface and fill the metadata from the ref cache when known. */
function viewResultToZoneEntries(
  result: ViewResult | null,
  focus: FocusResponse,
): ZoneEntry[] {
  if (result === null) return [];
  const focusId = focus.focused.id;
  // Exclude the focused thought itself — the server already filters it out,
  // but a stale cached result may still contain it; guard explicitly so the
  // user never sees the focus duplicated in its own view result.
  return result.items
    .filter((ref) => ref.id !== focusId)
    .map((ref) => {
      const flags = result.directions[ref.id] ?? { has_incoming: false, has_outgoing: false };
      // The `FocusNeighbor` shape is wider than what the canvas actually
      // reads for view results; we cast to satisfy the type. The fields
      // below are the only ones the canvas touches for a non-focus cloud
      // (id, type_id for line colour, has_incoming/has_outgoing for the
      // ellipse fill, source_id/target_id for line geometry).
      const neighbor = {
        id: ref.id,
        type_id: null,
        link_id: `view-result:${ref.id}`,
        source_id: focusId,
        target_id: ref.id,
        title: ref.title,
        icon: ref.icon,
        icon_kind: ref.icon_kind,
        active: ref.active,
        marked_for_deletion: ref.marked_for_deletion,
        has_incoming: flags.has_incoming,
        has_outgoing: flags.has_outgoing,
      } as unknown as FocusNeighbor;
      return {
        id: ref.id,
        links: [neighbor],
        ref,
        // A view result is shown with the same clouds as a child, but its
        // thought may have no link to the focus — shorten compound parts
        // against the focused thought explicitly (08-ui-spec.md §2.2.3,
        // ошибка ace5e73b). Real neighbours keep the edge-based map.
        viewResultRelated: [focus.focused.title],
      };
    });
}

/** Focus id of the last render — gates the transition choreography (§2.8). */
let lastFocusId: string | null = null;

/**
 * Ответ фокуса, по которому рисовался холст. Свежий ответ (пусть и тот же
 * фокус) — сигнал сверить количества секторов: своя запись связи не поднимает
 * версию мысли, других признаков изменений у ответа нет (ошибка ec5ba58c).
 */
let lastFocusResponse: FocusResponse | null = null;

/** Last canvas content signature handled by the store subscriber — gates the
 *  selection-only fast path (2e418bc3). */
let lastRenderKey: string | null = null;
let lastSelectionKey = '';
/** Id of the cloud currently carrying the `.halo` class (task ff82809a).
 *  Used to repaint the halo in the selection-only fast path without
 *  rebuilding any zone. */
let lastHaloId: string | null = null;

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
  updateLayerLabel();
  positionZoneIndicators();
}

/**
 * Paints the layer-name stripe (0.6.4, §2.2a): visible only while a non-base
 * layer is current; horizontal text at the left edge of the focus zone, up to
 * 30% of the zone height (fixed by the zone geometry, never shrunk for the
 * name), auto-contrast black/white against the effective focus-stripe colour.
 * The stripe never exceeds 10% of the canvas width and clips what does not
 * fit (`overflow: hidden` in CSS). Semi-transparent ({@link LABEL_OPACITY})
 * and non-interactive (`pointer-events: none` in CSS).
 */
function updateLayerLabel(): void {
  if (host === null || focusRow === null || layerLabelEl === null || layerLabelText === null) {
    return;
  }
  const s = store.state;
  const view = layerLabelView(
    s.currentLayer,
    currentLayerColors(s.layers, s.currentLayer),
    s.theme,
    Math.round(focusRow.getBoundingClientRect().height),
    Math.round(host.getBoundingClientRect().width),
  );
  const key = `${view.visible}|${view.title}|${view.color}|${view.fontPx}`;
  if (key !== lastLabelKey) {
    lastLabelKey = key;
    if (!view.visible) {
      layerLabelEl.style.display = 'none';
      return;
    }
    layerLabelText.textContent = view.title;
    layerLabelEl.style.color = view.color;
    layerLabelEl.style.fontSize = `${view.fontPx}px`;
    layerLabelEl.style.opacity = String(LABEL_OPACITY);
    layerLabelEl.style.display = 'flex';
  }
  // Geometry follows the focus row on every layout change (render, resizes,
  // splitter drags) — anchor unconditionally, the key only gates the restyle.
  if (!view.visible) return;
  const hostRect = host.getBoundingClientRect();
  const rowRect = focusRow.getBoundingClientRect();
  const top = Math.round(rowRect.top - hostRect.top);
  layerLabelEl.style.top = `${top}px`;
  layerLabelEl.style.height = `${Math.round(rowRect.height)}px`;
}

/** Clears the focus band (no focus → no band; the CSS defaults render it off-screen). */
function resetFocusBand(h: HTMLElement): void {
  h.style.removeProperty('--focus-band-top');
  h.style.removeProperty('--focus-band-bottom');
  if (layerLabelEl !== null) {
    lastLabelKey = '';
    layerLabelEl.style.display = 'none';
  }
  for (const dir of ZONE_DIRS) setZoneIndicator(dir, null);
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
 * Object-lock badge: a small 🔒 rendered on top of the cloud when another
 * user (or this user — soft highlight) holds the lock (task 4f141756, UI
 * element 8e3703ee). Tooltip is «редактирует <имя>» / «вы редактируете».
 * The badge is read-only: the click-through is suppressed so the cloud keeps
 * its normal click/dblclick behaviour.
 *
 * Returns `null` when nobody holds the lock — callers MUST then remove any
 * stale `.cloud-lock-badge` from the cloud.
 */
function buildLockBadge(row: { user_id: string }, meId: string | null): HTMLElement | null {
  const isOwn = meId !== null && row.user_id === meId;
  const name = isOwn
    ? 'вы редактируете'
    : resolveLockHolderName(row.user_id) ?? row.user_id;
  const badge = span('🔒', 'cloud-lock-badge' + (isOwn ? ' own' : ''));
  setTooltip(badge, isOwn ? 'Вы редактируете эту мысль.' : `Редактирует ${name}`);
  // Suppress click/dblclick so the cloud keeps its normal navigation.
  for (const evt of ['click', 'dblclick', 'contextmenu'] as const) {
    badge.addEventListener(evt, (e) => {
      e.stopPropagation();
    });
  }
  return badge;
}

/**
 * Sync the lock badge on a single cloud (or any element) to the current
 * cache state. Removes a stale badge if the lock has been released, adds a
 * fresh one if acquired. Called once on build (above) and again on every
 * `lockCacheTick` bump via {@link scheduleLockBadgeRefresh}.
 */
function refreshCloudLockBadges(
  host: HTMLElement,
  entityType: string,
  entityId: string,
): void {
  // Wipe any stale badge first so we don't end up with duplicates when the
  // holder changes mid-session.
  for (const old of Array.from(host.querySelectorAll('.cloud-lock-badge'))) {
    old.remove();
  }
  const row = store.state.lockCache[`${entityType}:${entityId}`];
  if (row === undefined) {
    host.classList.remove('locked-by-other', 'locked-by-self');
    return;
  }
  const meId = store.state.me?.id ?? null;
  const isOwn = meId !== null && row.user_id === meId;
  host.classList.toggle('locked-by-other', !isOwn);
  host.classList.toggle('locked-by-self', isOwn);
  const badge = buildLockBadge(row, meId);
  if (badge !== null) host.append(badge);
}

/**
 * Re-paint every cloud's lock badge. Cheap (queries only `.cloud` elements
 * inside the canvas host) and called from `store.subscribe` on every
 * `lockCacheTick` bump. The subscribers are wired once from `boot()` via
 * {@link wireLockBadgeRefresh}.
 */
let lockBadgeRefreshWired = false;
function wireLockBadgeRefresh(): void {
  if (lockBadgeRefreshWired) return;
  lockBadgeRefreshWired = true;
  lockBadgeUnsubscribe = store.subscribe(() => {
    // `lockCacheTick` is bumped on every cache transition; use it as the
    // signal so unrelated store updates do not re-paint badges.
    void store.state.lockCacheTick;
    const host = canvasHost();
    if (host === null) return;
    for (const cloud of host.querySelectorAll<HTMLElement>('.cloud')) {
      const id = cloud.dataset['id'];
      if (id === undefined) continue;
      refreshCloudLockBadges(cloud, 'thought', id);
    }
  });
}

/** Resolve the canvas host element; returns `null` before the canvas mounts. */
function canvasHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.canvas-host');
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
 * title lines, ellipses filled when incoming/outgoing links exist. The base
 * cloud (icon, colours, font, dim/trash state, gestures) comes from the shared
 * factory; the canvas adds its domain pieces — ellipses, indicators, layer and
 * lock badges.
 */
function renderFocusRow(focus: FocusResponse): void {
  if (focusRow === null) return;
  clear(focusRow);
  const thought = focus.focused;
  focusCloudEl = null;

  const cloud = createThoughtCloud(thought, {
    profile: 'canvas',
    actions: {
      onClick: (id) => {
        // The cloud drag gesture suppresses the click that follows a real drag
        // (suppressNextCanvasClick, drag-cloud.ts) — same guard the hand-rolled
        // handler had.
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        // Click sets the keyboard cursor on this cloud so subsequent arrows
        // (and Ctrl+Shift+←/→ in manual mode) move from the just-clicked
        // cloud, not from wherever the cursor happened to be. The editor halo
        // and the cursor frame are independent — both follow this click.
        setCursor(id);
        openThoughtInEditor(id);
      },
      // A click on the focus cloud returns the editor to the focused thought
      // (same as a click on empty canvas space); a double-click would refocus
      // the same thought — a no-op. The factory's deferred single click lets a
      // quick second click cancel it instead of triggering two editor
      // navigations back-to-back (the "editor shaking" the bug reports
      // describe) — the dblclick action is intentionally absent.
      onCtrlClick: (id) => selectionHooks?.onCloudClick(id),
      onContextMenu: (event, id) => {
        showThoughtContextMenu(event, { id, title: thought.title, dir: 'siblings' });
      },
      onTrashBadgeClick: (id) => {
        const networkId = store.state.networkId;
        if (networkId === null) return;
        void openThoughtDeleteDialog(networkId, { id, title: thought.title });
      },
    },
  });
  cloud.classList.add('focus-cloud');

  const parents = groupByThought(focus.parents).length;
  const children = groupByThought(focus.children).length;

  const topEllipse = div('ellipse ellipse-top');
  const bottomEllipse = div('ellipse ellipse-bottom');
  if (parents > 0) topEllipse.classList.add('filled');
  if (children > 0) bottomEllipse.classList.add('filled');
  setTooltip(topEllipse, `Входящие связи: ${parents}`);
  setTooltip(bottomEllipse, `Исходящие связи: ${children}`);
  wireEllipseDrag(topEllipse, thought.id, thought.title, 'parent');
  wireEllipseDrag(bottomEllipse, thought.id, thought.title, 'child');
  markNeighborsPreview(topEllipse, thought.id, neighborsDirForEllipse('top'), thought.title);
  markNeighborsPreview(bottomEllipse, thought.id, neighborsDirForEllipse('bottom'), thought.title);

  // Indicator row identical to the zone clouds: 📝/📅/📎 under the title.
  const ind = div('cloud-ind');
  const focusPerm = span('📝', 'ind dim');
  const focusChrono = span('📅', 'ind dim');
  const focusAtt = span('📎', 'ind dim');
  markCommentPreview(focusPerm, 'thought', thought.id, thought.title);
  markChronoPreview(focusChrono, 'thought', thought.id, thought.title);
  markAttachmentsPreview(focusAtt, 'thought', thought.id, thought.title);
  ind.append(focusPerm, focusChrono, focusAtt);
  const main = cloud.querySelector<HTMLElement>(':scope > .cloud-main');
  main?.append(ind);

  cloud.prepend(topEllipse);
  cloud.append(bottomEllipse);
  markOverriddenCloud(cloud, thought.id);
  refreshCloudLockBadges(cloud, 'thought', thought.id);
  focusRow.append(cloud);
  focusCloudEl = cloud;
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

// ---------------------------------------------------------------------------
// Sector pagination (задача c8fa74ba)
// ---------------------------------------------------------------------------

/** Neighbours of a zone for the current focus: first page from the focus
 *  response plus every page appended by scrolling the sector. */
function zoneNeighbors(
  dir: 'parents' | 'siblings' | 'children',
  focus: FocusResponse,
): FocusNeighbor[] {
  const appended = zoneAppended.get(dir);
  return appended === undefined ? focus[dir] : focus[dir].concat(appended);
}

/** Is the children zone currently showing a view run result (not real children)? */
function isChildrenViewResult(): boolean {
  const zone = zones?.['children'];
  return zone !== undefined && zone.classList.contains('zone-children-view-result');
}

/**
 * Resets the paged sectors for a freshly focused thought: appended pages and
 * counters are dropped, the exclusivity set is seeded from the focus response
 * (its zones are already exclusive server-side), in-flight page requests are
 * invalidated by the bumped token, and the supplemental edge set is cleared so
 * the overlay falls back to `focus.edges`.
 */
function resetZonePaging(focus: FocusResponse): void {
  zoneAppended.clear();
  zonePaging.clear();
  // The next reconcile has nothing to compare a freshly focused neighbourhood
  // against (see `reconcileZoneTotals`).
  zoneNeighbourhoodSignature = null;
  zonePagingToken++;
  setSupplementalEdges(null);
  zoneVisibleIds = new Set<string>([
    focus.focused.id,
    ...focus.parents.map((n) => n.id),
    ...focus.children.map((n) => n.id),
    ...focus.siblings.map((n) => n.id),
  ]);
}

/**
 * Fetches the total neighbour count of every zone (in the background) so the
 * count indicators can show it. `limit: 1` keeps the payload tiny — the focus
 * response already delivered the first page; only `meta.total` is needed here.
 * The first-page offset is therefore the server page size clamped to the total
 * (the focus response was fetched with the same default page size).
 */
async function ensureZoneTotals(focus: FocusResponse): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const token = zonePagingToken;
  for (const dir of ZONE_DIRS) {
    void loadZoneTotal(networkId, focus, dir, token);
  }
}

/** Loads one zone's total count and enables pagination for it. */
async function loadZoneTotal(
  networkId: string,
  focus: FocusResponse,
  dir: 'parents' | 'siblings' | 'children',
  token: number,
): Promise<void> {
  const total = await readZoneTotal(networkId, focus, dir, token);
  if (total === null) return;
  const counters = createZonePaging();
  const plan = planZoneReconcile(counters, total);
  counters.total = plan.counters.total;
  counters.loaded = plan.counters.loaded;
  zonePaging.set(dir, counters);
  paintZoneIndicators();
  // A tall window / tiny zone may already sit at the bottom — try once.
  void maybeLoadMoreZone(dir);
}

/**
 * Общее количество мыслей сектора по серверу; `null` — запрос не удался или
 * окрестность успела смениться (в полёте ответ уже не нужен).
 *
 * `limit: 1` держит ответ крошечным: ответ фокуса уже принёс первую порцию,
 * здесь читается только `meta.total`.
 */
async function readZoneTotal(
  networkId: string,
  focus: FocusResponse,
  dir: 'parents' | 'siblings' | 'children',
  token: number,
): Promise<number | null> {
  try {
    const linkFilter = await resolveEffectiveCanvasLinkFilter(networkId).catch(() => undefined);
    const { sort, order } = focus.sorts[dir];
    const page = await etn.thoughts.neighborsPage(
      networkId,
      focus.focused.id,
      dir,
      1,
      0,
      sort,
      order,
      linkFilter,
    );
    if (token !== zonePagingToken || store.state.focus?.focused.id !== focus.focused.id) return null;
    return page.total;
  } catch {
    // Best effort: the indicator keeps its previous number and scrolling retries.
    return null;
  }
}

/**
 * Сверка секторов по свежему ответу фокуса на ТОМ ЖЕ фокусе — зовётся из
 * подписчика до fast-path: смена количества или состава окрестности может не
 * менять ничего рисуемого (новая мысль за загруженной порцией), и обычная
 * ветка перерисовки её бы пропустила (ошибка ec5ba58c). Смену фокуса
 * отрабатывает `render()` (сброс порций + чтение количеств).
 */
function syncZoneTotalsWithFreshFocus(): void {
  const focus = store.state.focus;
  if (focus === null || focus === lastFocusResponse) return;
  if (focus.focused.id !== lastFocusId) return;
  lastFocusResponse = focus;
  // Подгруженные рёбра — снимок `POST /thoughts/edges` по видимым мыслям,
  // обновляется только при догрузке порции или здесь. Удаление связи между
  // ДВУМЯ подгруженными соседями (её нет и не будет в `focus.edges`) снимок не
  // трогает — линия висела бы до смены фокуса. Перечитываем снимок на свежем
  // ответе ТОГО ЖЕ фокуса после сверки секторов (её догрузка успевает
  // пополнить видимый набор, и запрос идёт по устоявшемуся составу мыслей;
  // ошибка c02ff7dc). Общие рёбра фокуса чинятся самим `edgeSource` — снимок их
  // не хранит.
  void reconcileZoneTotals(focus).then(() => {
    if (hasSupplementalEdges()) void refreshZoneEdges(focus);
  });
}

/**
 * Сверяет сектора со свежим ответом фокуса, когда фокус НЕ менялся (ошибка
 * ec5ba58c). Своя запись ребра не поднимает версию мысли, а собственному
 * клиенту не приходит realtime-эхо (04-realtime.md §5) — без этой сверки
 * индикатор-число показывал старое количество, а мысль, добавленная за уже
 * загруженный префикс, не появлялась в секторе до смены фокуса.
 *
 * Что делает:
 *  - перечитывает `meta.total` каждого сектора и переносит его в счётчики, не
 *    теряя показанные облачка ({@link planZoneReconcile});
 *  - если количество выросло — дотягивает ОДНУ порцию: при порядке `created`
 *    (по умолчанию) и `manual` новая мысль встаёт в хвост списка, то есть за
 *    первой порцией. Сектор на тысячи мыслей сознательно остаётся за скроллом —
 *    дотягивать его целиком из-за одной новой мысли нельзя (ради этого и
 *    вводилась пагинация, задача c8fa74ba);
 *  - если окрестность (наборы первой порции, рёбра, количества) изменилась —
 *    уведомляет открытую карточку, что значения свойств надо перечитать:
 *    таблица свойств читает снимок значений при построении и о правке ребра
 *    иначе не узнает (её полная пересборка гейтится версией мысли, а версия от
 *    ребра не меняется).
 */
async function reconcileZoneTotals(focus: FocusResponse): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const token = zonePagingToken;
  const signature = zoneNeighbourhoodSignatureOf(focus);
  // Первая сверка после смены фокуса сравнивать не с чем: карточка к этому
  // моменту уже перестроена сменой фокуса.
  let neighbourhoodChanged = zoneNeighbourhoodSignature !== null
    && zoneNeighbourhoodSignature !== signature;
  zoneNeighbourhoodSignature = signature;
  // Количества читаются параллельно: сверка едет на каждом свежем ответе
  // фокуса, три последовательных запроса вместо одного круга — лишняя задержка.
  const totals = await Promise.all(
    ZONE_DIRS.map((dir) => readZoneTotal(networkId, focus, dir, token)),
  );
  const toTopUp: Array<'parents' | 'siblings' | 'children'> = [];
  ZONE_DIRS.forEach((dir, index) => {
    const total = totals[index];
    if (total === null || total === undefined) return;
    const counters = zonePaging.get(dir);
    const plan = planZoneReconcile(counters ?? createZonePaging(), total);
    if (counters !== undefined && plan.counters.total !== counters.total) {
      neighbourhoodChanged = true;
    }
    const next = counters ?? createZonePaging();
    next.loaded = plan.counters.loaded;
    next.total = plan.counters.total;
    zonePaging.set(dir, next);
    if (plan.grew) toTopUp.push(dir);
  });
  paintZoneIndicators();
  for (const dir of toTopUp) await appendNextZonePage(dir);
  if (neighbourhoodChanged) notifyPropertyValuesRefreshed();
}

/**
 * Подпись окрестности фокуса: составы первых порций секторов и рёбра видимых
 * мыслей. Первых порций достаточно вместе с количествами: мысль за префиксом
 * подписи не меняет, но её видно по росту `meta.total` (см.
 * {@link reconcileZoneTotals}). Рёбра сверяются без учёта порядка — он не
 * определён контрактом ответа фокуса.
 */
function zoneNeighbourhoodSignatureOf(focus: FocusResponse): string {
  const zones = ZONE_DIRS.map((dir) => `${dir}:${focus[dir].map((n) => n.id).join(',')}`);
  const edges = focus.edges.map((e) => e.id).sort().join(',');
  return [...zones, `edges:${edges}`].join('|');
}

/**
 * Appends the next page of a zone when the sector is scrolled near its bottom.
 */
async function maybeLoadMoreZone(
  dir: 'parents' | 'siblings' | 'children',
): Promise<void> {
  const zone = zones?.[dir];
  const counters = zonePaging.get(dir);
  if (zone === null || zone === undefined || counters === undefined) return;
  if (
    !shouldLoadMore(counters, {
      scrollTop: zone.scrollTop,
      clientHeight: zone.clientHeight,
      scrollHeight: zone.scrollHeight,
    })
  ) {
    return;
  }
  await appendNextZonePage(dir);
}

/**
 * Дотягивает ОДНУ следующую порцию сектора и перерисовывает его. Дубликаты
 * фильтруются по {@link zoneVisibleIds}, поэтому исключительность секторов
 * ответа фокуса сохраняется и между порциями; принятые строки добавляются к
 * сектору инкрементально — карта целиком не пересобирается, облачко фокуса не
 * двигается.
 */
async function appendNextZonePage(
  dir: 'parents' | 'siblings' | 'children',
): Promise<void> {
  const counters = zonePaging.get(dir);
  if (counters === undefined) return;
  if (dir === 'children' && isChildrenViewResult()) return;
  const focus = store.state.focus;
  const networkId = store.state.networkId;
  if (focus === null || networkId === null) return;
  const token = zonePagingToken;
  counters.loading = true;
  try {
    const linkFilter = await resolveEffectiveCanvasLinkFilter(networkId).catch(() => undefined);
    const { sort, order } = focus.sorts[dir];
    let appendedAny = false;
    const acceptedIds: string[] = [];
    // Bounded loop: a page fully consumed by the exclusivity filter (all rows
    // already shown elsewhere) must not stall the sector — fetch the next one.
    for (let guard = 0; guard < 20 && counters.loaded < counters.total; guard++) {
      const page = await etn.thoughts.neighborsPage(
        networkId,
        focus.focused.id,
        dir,
        ZONE_PAGE_SIZE,
        counters.loaded,
        sort,
        order,
        linkFilter,
      );
      if (token !== zonePagingToken) return;
      counters.total = page.total;
      if (page.items.length === 0) {
        counters.loaded = counters.total;
        break;
      }
      counters.loaded += page.items.length;
      const accepted: FocusNeighbor[] = [];
      for (const neighbor of page.items) {
        if (zoneVisibleIds.has(neighbor.id)) continue;
        zoneVisibleIds.add(neighbor.id);
        accepted.push(neighbor);
      }
      if (accepted.length > 0) {
        const list = zoneAppended.get(dir) ?? [];
        list.push(...accepted);
        zoneAppended.set(dir, list);
        for (const neighbor of accepted) acceptedIds.push(neighbor.id);
        appendedAny = true;
        break;
      }
    }
    if (appendedAny) {
      renderZone(dir, groupByThought(zoneNeighbors(dir, focus)));
      paintZoneIndicators();
      scheduleIndicatorLoads();
      // Colours/icon of the appended clouds come from the ref cache, which
      // the focus response only seeded for the first page — resolve the new
      // ids and repaint the zone when they arrive (best effort).
      void resolveZoneRefs(networkId, acceptedIds).then(() => {
        if (token !== zonePagingToken) return;
        renderZone(dir, groupByThought(zoneNeighbors(dir, focus)));
      });
      void refreshZoneEdges(focus);
    }
  } catch {
    // Best effort: the next scroll of the sector retries.
  } finally {
    counters.loading = false;
  }
}

/**
 * Re-fetches every active link among the currently VISIBLE thoughts (focus +
 * all appended pages) and hands them to the link overlay. Beyond the first
 * page the focus response's `edges` no longer covers the neighbourhood, so the
 * overlay is fed the authoritative set from `POST /thoughts/edges`; the edges
 * already in `focus.edges` are dropped from the snapshot so the overlay renders
 * shared edges from the live focus response (ошибка c02ff7dc).
 */
async function refreshZoneEdges(focus: FocusResponse): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const token = zonePagingToken;
  const ids = [...zoneVisibleIds];
  try {
    // Снимок обязан уважать активный фильтр типов связей — тот же, что уходит
    // фокусу и порциям секторов (ошибка a617b4c6); иначе на холст вернутся
    // рёбра отфильтрованных типов.
    const linkFilter = await resolveEffectiveCanvasLinkFilter(networkId).catch(() => undefined);
    const edges = await etn.structures.edges(
      networkId,
      ids,
      store.state.showInactive,
      linkFilter,
    );
    if (token !== zonePagingToken) return;
    setSupplementalEdges(edges, focus.edges ?? []);
    redrawLinks?.();
  } catch {
    // Best effort: the overlay keeps drawing the focus response's edges.
  }
}

/** Writes one sector's floating count overlay; `null` hides it. */
function setZoneIndicator(
  dir: 'parents' | 'siblings' | 'children',
  label: string | null,
): void {
  const el = zoneCountEls[dir];
  if (el === null) return;
  if (label === null) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  if (el.textContent !== label) el.textContent = label;
  el.classList.remove('hidden');
}

/**
 * Refreshes every sector's count overlay from the current state: parents and
 * siblings show their server total; the children zone shows the view-result
 * size while a view is active, otherwise the same server total.
 */
function paintZoneIndicators(): void {
  setZoneIndicator('parents', zoneCountLabel(zonePaging.get('parents')?.total ?? -1));
  setZoneIndicator('siblings', zoneCountLabel(zonePaging.get('siblings')?.total ?? -1));
  if (isChildrenViewResult()) {
    setZoneIndicator('children', zoneCountLabel(zoneData.get('children')?.length ?? 0));
  } else {
    setZoneIndicator('children', zoneCountLabel(zonePaging.get('children')?.total ?? -1));
  }
}

/**
 * Pins each count overlay to the top-right corner of its zone (canvas-space),
 * reading the theme background under it so the number stays readable on any
 * backdrop (contrast text colour). Called from {@link updateFocusBand} on every
 * render, host resize and splitter drag.
 */
function positionZoneIndicators(): void {
  if (host === null) return;
  const hostRect = host.getBoundingClientRect();
  const bg =
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#eef0f4';
  const color = contrastText(bg);
  for (const dir of ZONE_DIRS) {
    const el = zoneCountEls[dir];
    const zone = zones?.[dir];
    if (el === null || zone === undefined) continue;
    const rect = zone.getBoundingClientRect();
    el.style.top = `${Math.round(rect.top - hostRect.top + 6)}px`;
    el.style.left = `${Math.round(rect.right - hostRect.left - 6)}px`;
    el.style.color = color;
  }
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
 * thoughts — **only the focused thought** is the source of related titles for
 * the zone clouds (08-ui-spec.md §2.2.3, requirement cf9601fa): outside the
 * focus, compound names hide parts equal to the title (or any part of the
 * title) of the thought in focus, never of any other visible thought.
 *
 * `focus.edges` carries every active link among the visible set (focus +
 * parents + siblings + children, 03-server-api.md §6.2), so it also contains
 * neighbour↔neighbour links that have nothing to do with the focused thought.
 * Including those would let a sibling named «Ошибки» make a child named
 * «Проект А.Ошибки» render as «Проект А» even when the focus is unrelated —
 * a regression reported in error cbb91b62. Only edges incident to the
 * focused thought contribute to the map; neighbour↔neighbour edges are
 * ignored so a thought's display name depends solely on the focus.
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
  const focusedId = focus.focused.id;
  for (const edge of focus.edges) {
    if (edge.source_id === edge.target_id) continue;
    // Requirement cf9601fa — relatedTitles is built from the focus only:
    // neighbour↔neighbour edges must not pollute the cloud of a thought
    // whose only link to the focus is via a third party (regression cbb91b62).
    if (edge.source_id !== focusedId && edge.target_id !== focusedId) continue;
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

/** Resolves the metadata of freshly appended sector clouds (colours/icon) into
 *  the ref cache — the focus response only enriched the first page. Best
 *  effort: failures leave those clouds with default styling. */
async function resolveZoneRefs(networkId: string, ids: string[]): Promise<void> {
  const missing = [...new Set(ids.filter((id) => !refCache.has(id)))];
  if (missing.length === 0) return;
  try {
    const resolved = await etn.thoughts.resolve(networkId, missing.slice(0, 100));
    for (const ref of resolved) refCache.set(ref.id, ref);
  } catch {
    // Best effort.
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
  // Floating per-zone count (задача c8fa74ba) — overlay above the grid,
  // positioned by `positionZoneIndicators()` on the canvas host.
  const count = div('zone-count hidden');
  count.setAttribute('aria-hidden', 'true');
  zoneCountEls[dir] = count;
  spacer.append(grid);
  zone.append(spacer, empty);
  // Overlay on the canvas host (not inside the scroller): the count must stay
  // pinned to the zone's top-right corner while its content scrolls.
  host?.append(count);

  let renderQueued = false;
  zone.addEventListener('scroll', () => {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(() => {
      renderQueued = false;
      if (host?.isConnected === true) {
        void renderZoneContent(dir);
        // Порционная подгрузка: порция запрашивается, когда окно сектора
        // подходит к нижней границе (задача c8fa74ba).
        void maybeLoadMoreZone(dir);
      }
    });
  });

  // A host resize — editor dock switch, panel/window splitter drag, plain
  // window resize — changes the zone box: recompute the column count and
  // re-anchor the grid right away, otherwise the clouds keep the previous
  // width's layout and a bottom/right-anchored zone grows a horizontal
  // scrollbar (ошибка 1deced69). Deliberately re-laid out in place instead of
  // through `render()`: `render()` starts with `finishFocusTransition()`, so a
  // resize mid-flight would snap a running focus animation.
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
  //
  // Жест работает и при активном отборе (ошибка 119b314f): «Добавить мысль»
  // подвешивает новую мысль к фокусу, отбор на это не влияет; блокировать
  // жест из-за временно отображаемого результата отбора — лишать
  // пользователя быстрого способа добавить ребёнка в фокус.
  zone.addEventListener('dblclick', (event) => {
    if (dir === 'siblings') return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && target.closest('.cloud') !== null) return;
    const focusId = store.state.focus?.focused.id;
    const focusTitle = store.state.focus?.focused.title;
    if (focusId === undefined) return;
    if (addDialogOpener !== null) {
      addDialogOpener({
        anchorId: focusId,
        anchorTitle: focusTitle,
        direction: dir === 'parents' ? 'parent' : 'child',
      });
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

/** Directions of the paged map zones (the focus row is never counted). */
const ZONE_DIRS: readonly ('parents' | 'siblings' | 'children')[] = [
  'parents',
  'siblings',
  'children',
];

/**
 * Порционная подгрузка секторов (задача c8fa74ba). Серверный ответ фокуса
 * отдаёт первые {@link ZONE_PAGE_SIZE} мыслей каждого сектора; при скролле
 * сектора следующие порции догружаются в фоне через
 * `GET /thoughts/{id}/neighbors` с `limit`/`offset`, а плавающий индикатор
 * показывает общее количество (`meta.total`).
 */
const zoneAppended = new Map<'parents' | 'siblings' | 'children', FocusNeighbor[]>();
/** Счётчики порции каждого сектора (offset, total, идёт ли запрос). */
const zonePaging = new Map<'parents' | 'siblings' | 'children', ZonePagingCounters>();
/**
 * Подпись окрестности последнего сверенного ответа фокуса (ошибка ec5ba58c).
 * Смена подписи или количества при том же фокусе означает, что состав
 * окрестности изменился, — открытой карточке надо перечитать значения свойств.
 * `null` — сверки ещё не было (фокус только что сменился).
 */
let zoneNeighbourhoodSignature: string | null = null;
/** Идентификаторы мыслей, уже показанных в каком-либо секторе (исключительность). */
let zoneVisibleIds = new Set<string>();
/** Версия окрестности: смена фокуса инвалидирует ответы подгрузки в полёте. */
let zonePagingToken = 0;
/** Плавающие индикаторы-числа секторов (DOM-оверлей поверх холста). */
const zoneCountEls: Record<'parents' | 'siblings' | 'children', HTMLElement | null> = {
  parents: null,
  siblings: null,
  children: null,
};

/** Column-major grid geometry of a zone (cols × rows, 08-ui-spec.md §2.1.1). */
function zoneGridOf(dir: 'parents' | 'siblings' | 'children'): {
  cols: number;
  rows: number;
  /** Width of the zone's content box (padding discounted) — the container the
   *  grid is anchored in (task f45ffc8a). */
  avail: number;
} | null {
  const zone = zones?.[dir];
  if (zone === null || zone === undefined) return null;
  const entries = zoneData.get(dir) ?? [];
  const geom = cloudGeom(store.state.cloudWidth, store.state.cloudGap, store.state.canvasZoom);
  const cellW = geom.width + geom.gap;
  const avail = Math.max(80, zone.clientWidth - 2 * ZONE_PADDING_PX);
  const cols = Math.max(1, Math.floor(avail / cellW));
  return { cols, rows: Math.ceil(entries.length / cols), avail };
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
    // Drop the previous render's content width: a leftover box would keep the
    // empty zone horizontally scrollable (ошибка 1deced69).
    grid.style.width = '';
    // The children zone carries a view-result empty state when the active
    // strip mode is a view (spec 9984aa98). Distinguish three cases:
    //   * "unresolved" — the filter referenced a token that did not bind;
    //     surface the reason instead of the generic «Ничего не найдено».
    //   * "empty" — the filter ran and returned nothing.
    //   * otherwise — render the children zone's default hint.
    if (dir === 'children') {
      const viewResult = zone.dataset['viewResult'];
      if (viewResult === 'unresolved') {
        const raw = zone.dataset['unresolved'];
        let text = 'Не удалось выполнить отбор: токен не разрешился.';
        if (raw !== undefined) {
          try {
            const issues = JSON.parse(raw) as Array<{ token?: string; reason?: string }>;
            if (issues.length > 0) {
              const first = issues[0];
              const token = typeof first?.token === 'string' ? first.token : '?';
              const reason = typeof first?.reason === 'string' ? first.reason : 'причина не указана';
              text = `Отбор вернул пустой результат: токен «${token}» не разрешился (${reason}).`;
            }
          } catch {
            // Fall back to the generic message.
          }
        }
        empty.textContent = text;
      } else if (viewResult === 'empty') {
        empty.textContent = 'Ничего не найдено';
      } else {
        empty.textContent = ZONE_EMPTY_LABELS[dir];
      }
    } else {
      empty.textContent = ZONE_EMPTY_LABELS[dir];
    }
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
  // Anchor the grid inside the zone's content box (task f45ffc8a): the zones
  // pull towards the focus row (parents/siblings — bottom edge, children — top
  // edge), so the clouds read as one cluster instead of scattered corners. The
  // offset moves ONLY the grid's origin: the row-major order, gaps,
  // virtualization window and (hence) all hit-testing/index math stay exactly
  // as before.
  //
  // The anchor container is the zone's content box; the CONTENT width is the
  // widest ROW of clouds, not the grid BOX. `gridTemplateColumns` pins all
  // `cols` columns, so a row with fewer clouds leaves the trailing columns
  // EMPTY and the box still spans almost the whole zone — anchoring by the box
  // made `(avail − content) ≈ 0`, so the horizontal offset vanished and the
  // children zone's single partial row stayed left instead of centring
  // (приёмочный дефект f45ffc8a). Row-major fill means only the LAST row can
  // be partial, and only when `entries.length < cols` is the grid a single
  // partial row; otherwise the widest row holds all `cols` clouds.
  const contentWidth = zoneContentWidth(cols, entries.length, geom.width, geom.gap);
  const contentHeight = Math.max(0, prefix[rows]! - geom.gap);
  const origin = anchorOffset(
    { width: gridInfo.avail, height: Math.max(0, zone.clientHeight - 2 * ZONE_PADDING_PX) },
    { width: contentWidth, height: contentHeight },
    ZONE_ANCHOR_BY_DIR[dir],
  );
  // The grid BOX must be no wider than the visible content (ошибка 1deced69).
  // `gridTemplateColumns` pins all `cols` columns, so the box spans almost the
  // whole zone even when the only row uses a fraction of them. Anchoring such a
  // box by `origin.x` pushed its EMPTY trailing columns past the zone's right
  // edge — a horizontal scrollbar appeared in a zone holding a single thought
  // (bottom/right-anchored zones), and the scrollbar only disappeared once the
  // rows happened to fill all columns. Narrowing the box to the widest ROW
  // removes the phantom scroll WITHOUT moving a cloud: the trailing columns
  // hold no items, and a full grid (`contentWidth` = every column) is unchanged.
  // The box still overflows — and the scrollbar is legitimate — when a single
  // cloud is genuinely wider than the zone (`cols === 1`).
  grid.style.width = `${contentWidth}px`;
  grid.style.transform = `translate(${origin.x}px, ${origin.y + prefix[startRow]!}px)`;

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

/** Builds one zone cloud element. */
function buildCloud(
  entry: ZoneEntry,
  dir: 'parents' | 'siblings' | 'children',
  position: number | null,
): HTMLElement {
  const ref = entry.ref;
  // The live neighbour carries a fresh `active` flag in every focus response —
  // prefer it over the cached ref, which can lag after a local toggle until the
  // ref is re-resolved (no realtime echo to the actor, 04-realtime.md §5).
  // `marked_for_deletion` lives only on the ref (FocusNeighbor does not carry
  // it) — the factory reads it from the ref and paints the trash badge itself.
  const isInactive = (entry.links[0]?.active ?? ref?.active) === false;
  // Prefer the live neighbour title (fresh from the focus response) over the
  // cached ref, which can lag behind after a rename until re-resolved.
  const cloudTitleFull = entry.links[0]?.title ?? ref?.title ?? '—';
  // Outside the focus, compound names hide the parts matching visible related
  // thoughts (08-ui-spec.md §2.2.3); the tooltip keeps the full name. A view
  // result in the lower zone carries the focus title explicitly (its thoughts
  // need no link to the focus, ошибка ace5e73b); real neighbours use the
  // edge-based map built from the focus response.
  const cloudTitle = shortenCompoundName(
    cloudTitleFull,
    entry.viewResultRelated ?? relatedTitles.get(entry.id) ?? [],
  );

  // The base cloud (icon, colours, font, dim/trash states, deferred click,
  // Ctrl+click, context menu) comes from the shared factory; the canvas adds
  // its domain pieces — ellipses, indicators, position badge, drag, cursor.
  const cloud = createThoughtCloud(
    {
      ...(ref ?? { icon: null, icon_kind: 'emoji' as const, type_id: null }),
      id: entry.id,
      title: cloudTitle,
      active: isInactive ? false : (ref?.active ?? true),
    },
    {
      profile: 'canvas',
      actions: {
        onClick: (id) => {
          if (suppressNextClick) {
            suppressNextClick = false;
            return;
          }
          // Click selects the cloud as the keyboard cursor so subsequent arrows
          // (and Ctrl+Shift+←/→ in manual mode) move from the just-clicked
          // cloud, not from whichever cloud the cursor happened to be on. The
          // editor halo and the cursor frame are independent — both follow this
          // click.
          setCursor(id);
          openThoughtInEditor(id);
        },
        onDoubleClick: (id) => void setFocus(id),
        onCtrlClick: (id) => selectionHooks?.onCloudClick(id),
        onContextMenu: (event, id) => {
          event.stopPropagation();
          showThoughtContextMenu(event, {
            id,
            title: entry.ref?.title ?? entry.id,
            dir,
          });
        },
        onTrashBadgeClick: (id) => {
          const networkId = store.state.networkId;
          if (networkId === null) return;
          void openThoughtDeleteDialog(networkId, { id, title: cloudTitleFull });
        },
      },
    },
  );
  cloud.dataset['dir'] = dir;
  if (store.state.selection.includes(entry.id)) cloud.classList.add('selected');
  // Halo: the thought is open in the editor (§2.2.4) — a single click, Enter
  // or a pick from the structures/chronicle view.
  const editorTarget = store.state.editorTarget;
  if (editorTarget?.kind === 'thought' && editorTarget.id === entry.id) {
    cloud.classList.add('halo');
  }
  // Полное имя — подсказкой на названии (фабрика ставит сокращённое).
  const titleEl = cloud.querySelector<HTMLElement>(':scope > .cloud-main > .cloud-title');
  if (titleEl !== null) setTooltip(titleEl, cloudTitleFull);

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
  wireEllipseDrag(topEllipse, entry.id, cloudTitleFull, 'parent');
  wireEllipseDrag(bottomEllipse, entry.id, cloudTitleFull, 'child');
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

  const main = cloud.querySelector<HTMLElement>(':scope > .cloud-main');
  main?.append(ind);

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

  cloud.prepend(topEllipse);
  cloud.append(bottomEllipse, posBadge);
  // Object-lock badge (task 4f141756, UI element 8e3703ee): mounted once on
  // build, then re-painted by `refreshCloudLockBadges()` on every store
  // tick — see the `lockCacheTick` bump in `lib/lock-cache.ts`.
  refreshCloudLockBadges(cloud, 'thought', entry.id);
  markOverriddenCloud(cloud, entry.id);

  return cloud;
}

// ---------------------------------------------------------------------------
// Ctrl-hover ellipse neighbours preview (task «Распространить предпросмотр с
// зажатым Ctrl на эллипсы облачков мыслей») — registers a `neighbors` content
// resolver with the shared `lib/hover-preview.ts` engine. Lives here (not in
// hover-preview.ts itself) because canvas.ts already imports hover-preview.ts
// for the mark* trigger helpers, so importing back would close a cycle.
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
 *  `editor/links-tab.ts`'s `endpointRow`/`linkRow`: a factory-built mini-cloud
 *  (icon + own/type style, dimmed when inactive, no indicators of its own),
 *  nested Ctrl-hover shows the row's own permanent comment. A click/double-
 *  click navigates AND closes this popup (a lingering popup over content that
 *  just changed reads as a bug — no existing precedent does this
 *  navigate-from-inside-a-popup gesture, so the close is explicit here). */
function neighborPreviewRow(ref: ThoughtRef): HTMLElement {
  const row = createThoughtCloud(ref, {
    profile: 'chip',
    actions: {
      // Same single/double-click interplay as the clouds themselves: the first
      // click defers the "open in editor" action so a quick second click
      // cancels it and the dblclick focus action runs instead.
      onClick: (id) => {
        closeHoverPreview();
        openThoughtInEditor(id);
      },
      onDoubleClick: (id) => {
        closeHoverPreview();
        void setFocus(id);
      },
    },
  });
  row.classList.add('link-group-item');
  markThoughtCommentPreview(row, ref.id, ref.title);
  return row;
}

/** Builds the `neighbors` popup content: incoming/outgoing links of the
 *  triggering ellipse's thought, alphabetical, scrollable, capped at 70%
 *  height / 25% width of the canvas viewport. Empty list → `null` (no popup),
 *  per spec — mirrors the built-in resolvers' "nothing to show" convention.
 *
 *  Ошибка e5cee08e: список ограничивается фильтром типов связей карты — тем
 *  же набором `type_ids` + `include_structural`, которым сервер рисует саму
 *  карту, иначе Ctrl-наведение показывало и отфильтрованные типы.
 *
 *  Задача 7e9ec8bf: фильтр не читается из `store.state.canvasLinkFilter`
 *  напрямую, а резолвится целиком ({@link resolveEffectiveCanvasLinkFilter}) —
 *  явное предпочтение, иначе живой дефолт из `show_on_map`. Иначе при
 *  незаданном предпочтении карта (её фильтрует сервер) рисовала по
 *  `show_on_map`, а превью показывало все связи. */
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
    const linkFilter = await resolveEffectiveCanvasLinkFilter(networkId);
    neighbors = await etn.thoughts.neighbors(
      networkId,
      thoughtId,
      dir,
      NEIGHBORS_PREVIEW_LIMIT,
      undefined,
      linkFilter,
    );
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
  viewResultToZoneEntries,
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
 * The gesture belongs to the ellipse's OWN thought: `anchorId`/`anchorTitle`
 * come from the cloud that renders the ellipse, so a drag started on a
 * non-focus cloud links (or opens the dialog) for THAT thought — the focused
 * thought plays no part here (ошибка c8bd4676).
 *
 * Hovering an ellipse highlights it and every visible link of its direction
 * (the link overlay's {@link setEllipseHover}).
 */
function wireEllipseDrag(
  ellipse: HTMLElement,
  anchorId: string,
  anchorTitle: string,
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
      anchorTitle,
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

/**
 * What an ellipse drag resolves to on release — a link to the thought under
 * the cursor, or the add-thought dialog for the drag's own anchor. Pure: the
 * DOM hit-testing lives in {@link onDragMove}; this only decides the outcome.
 *
 * The anchor and the direction come from the DRAGGED ellipse (`top` → the new
 * thought becomes the anchor's parent, `bottom` → its child); the focused
 * thought is not consulted at all (ошибка c8bd4676).
 */
export function resolveEllipseDrop(
  drag: { anchorId: string; anchorTitle: string; direction: 'parent' | 'child' },
  hoveredId: string | null,
): EllipseDropOutcome {
  if (hoveredId !== null && hoveredId !== drag.anchorId) {
    return {
      kind: 'link',
      anchorId: drag.anchorId,
      direction: drag.direction,
      droppedId: hoveredId,
    };
  }
  return {
    kind: 'add',
    anchorId: drag.anchorId,
    anchorTitle: drag.anchorTitle,
    direction: drag.direction,
  };
}

/** Outcome of an ellipse drag release (see {@link resolveEllipseDrop}). */
export type EllipseDropOutcome =
  /** Dropped on another thought — a direct link from/to the drag's anchor. */
  | { kind: 'link'; anchorId: string; direction: 'parent' | 'child'; droppedId: string }
  /** Dropped on empty space — the add-thought dialog for the drag's anchor. */
  | { kind: 'add'; anchorId: string; anchorTitle: string; direction: 'parent' | 'child' };

/** Ends the drag: creates a link or opens the add dialog. */
function onDragEnd(_event: MouseEvent): void {
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
  if (drag === null) return;
  const wasActive = drag.active;
  const hoveredId = drag.hovered !== null ? ellipseDropId(drag.hovered) : null;
  const outcome = resolveEllipseDrop(
    { anchorId: drag.anchorId, anchorTitle: drag.anchorTitle, direction: drag.direction },
    hoveredId,
  );
  if (drag.hovered !== null) drag.hovered.classList.remove('drop-target');
  drag.sourceEl.classList.remove('drag-source');
  setDragLinkLine(null);
  drag = null;
  document.body.classList.remove('dragging');

  if (!wasActive) return;

  if (outcome.kind === 'link') {
    void createLinkFromDrop(outcome.direction, outcome.anchorId, outcome.droppedId);
    return;
  }
  if (addDialogOpener !== null) {
    addDialogOpener({
      anchorId: outcome.anchorId,
      anchorTitle: outcome.anchorTitle,
      direction: outcome.direction,
    });
  } else {
    notice('Диалог добавления мыслей ещё не готов.', 'error');
  }
}

/**
 * Creates a link between two thoughts after a successful drop (C4).
 *
 * 0.8.1 (6dcd6db7): `POST /links` is removed — the untyped edge is created by
 * the batch `link_parents` operation; an already linked pair is reported up
 * front (the batch itself is idempotent and would skip it silently).
 */
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
    const grouped = await etn.links.listByThought(networkId, targetId);
    const linked = [
      ...grouped.by_type.flatMap((g) => g.items.map((i) => i.link)),
      ...grouped.untyped_parents.map((u) => u.link),
      ...grouped.untyped_children.map((u) => u.link),
    ];
    if (linked.some((l) => l.source_id === sourceId && l.target_id === targetId)) {
      notice('Такая связь уже существует.');
      return;
    }
    throwOnFailures(await ensureLink(networkId, sourceId, targetId));
    // The acting client gets no realtime echo (04-realtime.md §5) — refresh
    // explicitly so the new edge, the zone move and the editor's «Связи»
    // update, and animate the thought flowing into its new zone.
    requestZoneAnimation();
    scheduleRefresh();
    notice('Связь создана.', 'success');
  } catch (err) {
    notice(
      `Не удалось создать связь: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  }
}
