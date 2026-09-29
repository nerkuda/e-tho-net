/**
 * SVG link overlay (H6, 08-ui-spec.md §2.4):
 *
 * Draws every link among the visible thoughts (focus + parents + children +
 * siblings), sourced from `focus.edges`. A pair gets a line when each of its
 * two clouds is at least partly inside its own zone's visible window — a cloud
 * fully scrolled out of its zone (the virtualized overscan, §2.5) carries no
 * line, while a cloud merely clipped by the zone edge keeps its line and its
 * hit curve. Each directed pair (source→target) is one cubic Bézier curve
 * from the source's bottom ellipse to the target's top ellipse, stroked with a
 * source→target colour gradient (L14); several links of the same pair render
 * as a thicker curve with a count badge.
 *
 * Zone borders do NOT clip a line: all overlay layers are children of the
 * CANVAS HOST, never of a zone (`initLinksOverlay`), so a pair whose clouds sit
 * in different zones is one continuous curve across the border, and its hit
 * curve is hoverable along the whole stretch between the clouds (ошибка
 * 16a77453). {@link syncOverlayViewport} keeps the matching viewport invariant:
 * every layer's viewport is exactly the host's pixel box, so a path is never
 * cut by the SVG root at some height inside a zone.
 *
 * Layering: the base overlay sits **under** the clouds; the wide transparent
 * hit curves sit under the clouds too — only the visible stretch of a line
 * is interactive, so hovering a cloud never "surfaces" the links passing
 * beneath it and cloud hover/click always work. The link currently hovered
 * or sticky-selected is re-rendered in a top overlay **above** the clouds,
 * with a popover (type names only) and highlighted ellipses on both
 * endpoints. The popover is itself a hover island: it can be entered with the
 * cursor (`pointer-events: auto`), its position is frozen while it stays open
 * for the same bundle, and it hides 0.3 s after the cursor left both the line
 * and the popover (unless the link is sticky-selected). Ctrl+hover over the
 * popover previews the link's permanent comment, if it has one (a bundle has
 * no single owner edge, so it carries no preview marker). Click opens the link
 * in the editor (single) or a picker (bundle) and leaves it selected until a
 * click elsewhere — including clicks that land on the popover itself, which
 * are forwarded to the line's click handler.
 *
 * Redrawn (rAF-debounced) on canvas renders, scrolling, resizes and focus
 * changes; positions come from `getBoundingClientRect` relative to the host.
 */

import type { FocusEdge, FocusResponse, LinkType } from '@etn/shared';

import { closeMenu, showMenuAt, type MenuItem } from '../lib/menu.js';
import { div, el, setTooltip } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { markCommentPreview } from '../lib/hover-preview.js';
import { svgIcon } from '../lib/icons.js';
import { ELLIPSE_INSIDE } from '../lib/pure.js';
import { holderNameByUserId as resolveLockHolderName } from '../lib/lock-cache.js';
import { resolveLinkTypeVisual, resolveThoughtTypeVisual } from '../lib/type-tree.js';
import { store } from '../state.js';
import { findCloudAnywhere, getRef } from './canvas.js';
import { showLinkContextMenu } from './context-menu.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Editor opener signature: receives the full link record. */
export type LinkEditorOpener = (link: import('@etn/shared').Link) => void;

/** Base line width, px. */
const BASE_WIDTH = 1.5;
/** Extra width per additional link between the same directed pair. */
const EXTRA_WIDTH_PER_LINK = 1.2;
/**
 * Default colour for untyped links. Themed token (`--link-default` in
 * styles.css, L10); SVG presentation attributes resolve CSS variables in
 * Chromium, and lines are redrawn on the store update the theme toggle
 * performs.
 */
const DEFAULT_COLOR = 'var(--link-default, #9aa3b2)';
/** Base font size of link labels, px; scaled by the canvas zoom via the
 *  `--link-label-font` CSS variable (L9). */
export const LINK_LABEL_FONT_BASE = 11;
/** Count badge radius at zoom 1, px. */
const BADGE_RADIUS = 9;
/** Vertical nudge of the badge count glyph (baseline middle), at zoom 1. */
const BADGE_TEXT_DY = 3.5;
/** Label offset from the line midpoint, px at zoom 1. */
const LABEL_OFFSET = 8;
/** Bézier bend clamp range, px (L14): keeps short edges visibly curved and
 *  long edges from growing huge loops. */
const BEND_MIN = 24;
const BEND_MAX = 140;

/**
 * Ребро помечено на удаление (корзина, ошибка 355319d4): линия приглушается и
 * становится пунктирной — та же логика, что у помеченной мысли (облачко
 * бледнеет). Помеченную сущность НЕ прячем: пользователь должен видеть, что
 * ребро есть, но лежит в корзине.
 */
const TRASHED_STROKE = 'var(--link-default, #9aa3b2)';
const TRASHED_DASH = '4 4';
const TRASHED_OPACITY = '0.45';
/** Суффикс подписи типа у помеченного ребра («входит в (в корзине)»). */
const TRASHED_LABEL_SUFFIX = ' (в корзине)';
/**
 * Где на кривой живёт метка корзины (доля параметра Безье): НЕ в середине —
 * там подпись типа и бейдж-счётчик пачки, метка корзины их не перекрывает.
 */
const TRASH_BADGE_T = 0.3;

/** A directed pair of thoughts with the links between them. */
interface Bundle {
  /** `${sourceId}>${targetId}`. */
  key: string;
  sourceId: string;
  targetId: string;
  edges: FocusEdge[];
}

let hostEl: HTMLElement | null = null;
/** Base overlay — under the clouds; carries every visible link line (no input). */
let svg: SVGSVGElement | null = null;
/** Hit overlay — under the clouds with the visual layer; carries wide
 *  transparent curves that capture hover/click on the VISIBLE stretches of a
 *  line (the parts hidden behind a cloud stay non-interactive). */
let svgHit: SVGSVGElement | null = null;
/** Top overlay — above the hit layer; carries the hovered/selected line. */
let svgTop: SVGSVGElement | null = null;
/** Pending-link overlay — above everything; carries the ellipse-drag preview
 *  line and survives the redraws that rebuild svgTop. */
let svgDrag: SVGSVGElement | null = null;
let popover: HTMLElement | null = null;
let opener: LinkEditorOpener | null = null;
/** Bundle key currently under the cursor (transient). */
let hoveredKey: string | null = null;
/** Thought whose ellipse is hovered: its direction's visible links light up. */
let ellipseHover: { thoughtId: string; direction: 'parent' | 'child' } | null = null;

/**
 * Дополнительный набор рёбер (задача c8fa74ba): когда сектор карты подгружает
 * порции соседей сверх первых 50, окрестность из ответа фокуса перестаёт
 * покрывать все видимые связи. Канва запрашивает рёбра среди ВСЕХ видимых
 * мыслей (`POST /thoughts/edges`) и передаёт их сюда; рёбра, уже пришедшие в
 * `focus.edges`, из набора вычитаются (для них источник истины — сам ответ
 * фокуса), поэтому здесь остаются только связи, которых фокус НЕ покрывает.
 * `null` — дополнительного набора нет (нет подгрузки или сменился фокус).
 *
 * Почему набор НЕ заменяет `focus.edges` целиком: `focus.edges` — живой
 * источник истины по общим рёбрам (обновляется realtime-перезапросом и
 * локальными правками, в т.ч. `patchFocusEdge`), а подгруженный набор —
 * снимок, обновляемый только при догрузке порции или перечитывании. Если брать
 * общие рёбра из снимка, локальное удаление связи «Удалить совсем» убирает её
 * из `focus.edges`, но не из снимка, и линия висит на карте до смены фокуса
 * (ошибка c02ff7dc).
 */
let supplementalEdges: FocusEdge[] | null = null;

/**
 * Задать/сбросить дополнительный набор рёбер (см. {@link supplementalEdges}).
 * `focusEdges` — рёбра ответа фокуса на момент запроса: они вычитаются из
 * набора, чтобы общие рёбра рисовались по живому `focus.edges`, а не по снимку.
 */
export function setSupplementalEdges(
  edges: FocusEdge[] | null,
  focusEdges: readonly FocusEdge[] = [],
): void {
  if (edges === null) {
    supplementalEdges = null;
    return;
  }
  const covered = new Set(focusEdges.map((e) => e.id));
  supplementalEdges = edges.filter((e) => !covered.has(e.id));
}

/** Есть ли подгруженные рёбра вне `focus.edges` (см. {@link supplementalEdges}). */
export function hasSupplementalEdges(): boolean {
  return supplementalEdges !== null && supplementalEdges.length > 0;
}

/**
 * Источник рёбер для отрисовки: живые рёбра текущего ответа фокуса плюс
 * подгруженные рёбра вне него (см. {@link supplementalEdges}). Порядок и
 * дедупликация по id сохраняют одну линию на ребро.
 */
function edgeSource(focus: FocusResponse): FocusEdge[] {
  const focusEdges = focus.edges ?? edgesFromNeighbours(focus);
  if (supplementalEdges === null || supplementalEdges.length === 0) return focusEdges;
  const seen = new Set(focusEdges.map((e) => e.id));
  const appended = supplementalEdges.filter((e) => !seen.has(e.id));
  return appended.length === 0 ? focusEdges : [...focusEdges, ...appended];
}

/**
 * Highlights every visible link of one ellipse direction (wired by the canvas
 * hover handlers): `parent` → links arriving at the thought, `child` → links
 * leaving it. Redraws only the top overlay, so hover changes never rebuild the
 * hit lines mid-click (08-ui-spec.md §2.4). Pass `null` to clear.
 */
export function setEllipseHover(
  state: { thoughtId: string; direction: 'parent' | 'child' } | null,
): void {
  ellipseHover = state;
  drawActive();
}

/**
 * Moves the pending-link preview (canvas ellipse drag): a dashed line from the
 * dragged ellipse to the cursor, drawn above every other layer. Pass `null` to
 * remove it. Endpoints are viewport coordinates — the line is anchored to the
 * canvas host's drag overlay.
 */
export function setDragLinkLine(
  state: { from: { x: number; y: number }; to: { x: number; y: number } } | null,
): void {
  if (svgDrag === null || hostEl === null) return;
  if (state === null) {
    while (svgDrag.firstChild !== null) svgDrag.removeChild(svgDrag.firstChild);
    return;
  }
  const rect = hostEl.getBoundingClientRect();
  let line = svgDrag.querySelector<SVGLineElement>('.drag-link-line');
  if (line === null) {
    line = document.createElementNS(SVG_NS, 'line');
    line.classList.add('drag-link-line');
    svgDrag.append(line);
  }
  line.setAttribute('x1', String(state.from.x - rect.left));
  line.setAttribute('y1', String(state.from.y - rect.top));
  line.setAttribute('x2', String(state.to.x - rect.left));
  line.setAttribute('y2', String(state.to.y - rect.top));
}
/** Endpoint ellipses currently highlighted, to clear on the next redraw. */
let highlightedEllipses: HTMLElement[] = [];

/**
 * Mounts the link overlay onto a canvas host. Returns the redraw trigger;
 * `mountCanvas` calls it and hands the created SVG elements to {@link draw}.
 *
 * All four layers are children of the CANVAS HOST — never of a zone. That is
 * what makes a line between clouds of different zones a single continuous
 * curve: zone scrollers clip their own descendants (`overflow-y: auto`), so an
 * overlay living inside a zone would cut every cross-zone line at the zone
 * edge (the mechanism suspected in ошибка 16a77453). One host-level overlay is
 * therefore the architectural invariant of this module — see
 * {@link syncOverlayViewport} for the matching viewport invariant.
 */
export function initLinksOverlay(host: HTMLElement): { redraw(): void; dispose(): void } {
  hostEl = host;
  // `links-layer` is the common marker of all four overlays: the focus-change
  // transition (`canvas/transition.ts`) hides and fades them as one group while
  // the clouds fly. The per-layer classes below stay the styling/behaviour hooks.
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('links-overlay', 'links-layer');
  svgHit = document.createElementNS(SVG_NS, 'svg');
  svgHit.classList.add('links-overlay-hit', 'links-layer');
  svgTop = document.createElementNS(SVG_NS, 'svg');
  svgTop.classList.add('links-overlay-top', 'links-layer');
  // The pending-link preview layer lives ABOVE the top overlay and is never
  // cleared by the redraws (draw/drawActive rebuild svgTop) — an ellipse drag
  // keeps its line no matter what repaints in between.
  svgDrag = document.createElementNS(SVG_NS, 'svg');
  svgDrag.classList.add('links-overlay-drag', 'links-layer');
  // DOM order is the source of truth for layering: visual overlay FIRST (under
  // the clouds), then hit + top overlays LAST. The hit layer shares z=0 with
  // the visual one and relies on DOM order to sit above the curves — both stay
  // BELOW the clouds (z=1), keeping every cloud hover/click-able (§2.4).
  host.prepend(svg);
  host.append(svgHit, svgTop, svgDrag);
  syncOverlayViewport();

  const resizeObserver = new ResizeObserver(() => {
    syncOverlayViewport();
    requestDraw();
  });
  resizeObserver.observe(host);
  host.addEventListener(
    'scroll',
    () => {
      syncOverlayViewport();
      requestDraw();
    },
    true,
  );

  // Lock-cache transitions (task 4f141756) carry `lock-locked-*` classes on
  // the path; re-draw so a freshly-acquired lock and a freshly-released one
  // show up on every line without a focus round-trip.
  const unsubscribe = store.subscribe(() => {
    void store.state.lockCacheTick;
    requestDraw();
  });

  // Teardown handle: the store subscription lives in this module (not on the
  // host element), so it must be released explicitly on unmount — otherwise
  // every canvas remount leaks one more subscriber (ошибка 37b713de). The host
  // scroll listener and the SVG children die with the host DOM.
  return {
    redraw: requestDraw,
    dispose: () => {
      unsubscribe();
      resizeObserver.disconnect();
      hostEl = null;
      svg = null;
      svgHit = null;
      svgTop = null;
      svgDrag = null;
    },
  };
}

/**
 * Sizes every overlay layer to the canvas host's pixel box and pins its
 * `viewBox` to the same box, so the SVG coordinate space is exactly the
 * host's pixel space (1:1, `preserveAspectRatio="none"`).
 *
 * Invariant: the overlay viewport can never be smaller than the rectangle the
 * lines are drawn into. The lines are laid out in host-relative pixels from
 * `getBoundingClientRect`, so any viewport shorter than the host would clip
 * paths mid-canvas on the SVG root's own `overflow: hidden` — cutting a line
 * at an arbitrary height inside a zone rather than at a zone edge (the second
 * half of ошибка 16a77453). Re-synced on host resize, on scroll and before
 * every draw, so a stale viewport can never outlive a layout change.
 */
function syncOverlayViewport(): void {
  if (hostEl === null) return;
  const rect = hostEl.getBoundingClientRect();
  // Exact (unrounded) values: the attributes and the viewBox describe the same
  // box, so with `preserveAspectRatio="none"` the coordinate space maps 1:1 to
  // the host's pixels — nothing is scaled or shifted.
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  for (const layer of [svg, svgHit, svgTop, svgDrag]) {
    if (layer === null) continue;
    layer.setAttribute('width', String(w));
    layer.setAttribute('height', String(h));
    layer.setAttribute('viewBox', `0 0 ${w} ${h}`);
    layer.setAttribute('preserveAspectRatio', 'none');
  }
}

/** Registers the link editor opener (editor module, H8). */
export function setLinkEditorOpener(next: LinkEditorOpener | null): void {
  opener = next;
}

/** rAF draw request state: queued flag + generation to cancel stale frames. */
let drawQueued = false;
let drawGeneration = 0;

/** Requests an rAF-debounced redraw of all link lines. */
export function requestDraw(): void {
  if (drawQueued || svg === null) return;
  drawQueued = true;
  const gen = ++drawGeneration;
  window.requestAnimationFrame(() => {
    if (gen !== drawGeneration) return; // superseded by a synchronous draw
    drawQueued = false;
    draw();
  });
}

/**
 * Redraws all link lines synchronously, cancelling any pending rAF. Callers
 * that must draw against a known DOM state (the focus transition measures
 * final cloud positions BEFORE starting the FLIP animations) need this — the
 * rAF variant would run after the animations apply their first keyframe and
 * capture mid-flight geometry.
 */
export function drawLinksNow(): void {
  if (svg === null) return;
  drawGeneration++; // invalidate a queued rAF draw
  drawQueued = false;
  draw();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Recomputes and re-renders every line, plus the active hover/selection. */
function draw(): void {
  if (svg === null || svgHit === null || svgTop === null || hostEl === null) return;
  clearSvg();
  clearEnds();
  // Fresh defs for the per-edge gradients (L14); rebuilt with every draw.
  defsEl = document.createElementNS(SVG_NS, 'defs');
  gradientSeq = 0;
  svg.append(defsEl);
  const focus = store.state.focus;
  if (focus === null) {
    hidePopover();
    return;
  }
  const hostRect = hostEl.getBoundingClientRect();
  if (hostRect.width === 0) return;
  // Keep the SVG viewport exactly the host box before laying out paths in it
  // (resize/scroll may have changed the box since the last draw).
  syncOverlayViewport();

  // `edges` is populated by a current server; fall back to deriving the
  // focus↔neighbour edges from parents/children so the overlay still draws
  // (and never crashes) if a stale server process omits the field.
  const edges = edgeSource(focus);
  const bundles = groupBundles(edges);
  for (const bundle of bundles) {
    const src = findCloudAnywhere(bundle.sourceId);
    const tgt = findCloudAnywhere(bundle.targetId);
    if (src === null || tgt === null) continue;
    if (!isCloudVisible(src) || !isCloudVisible(tgt)) continue;
    const from = ellipsePoint(src, 'bottom', hostRect);
    const to = ellipsePoint(tgt, 'top', hostRect);
    drawVisualLine(bundle, from, to);
    drawHitLine(bundle, from, to);
  }

  // Hovered or sticky-selected bundle: redraw on top, show popover + ellipses.
  // Kept in a separate function so a hover change can refresh only this layer
  // without rebuilding the visual/hit lines (which would break in-flight clicks).
  drawActive();
}

/** Bundles derived from the current focus response. */
function currentBundles(): Bundle[] {
  const focus = store.state.focus;
  if (focus === null) return [];
  return groupBundles(edgeSource(focus));
}

/**
 * Redraws only the active (hovered/selected) line on the top overlay, plus the
 * popover and endpoint ellipses. Does NOT touch the visual or hit layers — so
 * it is safe to call from mouseenter/mouseleave (which happen between
 * mousedown/mouseup of a click; rebuilding hit lines there kills the click).
 */
function drawActive(): void {
  if (svgTop === null || hostEl === null) return;
  while (svgTop.firstChild !== null) svgTop.removeChild(svgTop.firstChild);
  clearEnds();
  const hostRect = hostEl.getBoundingClientRect();

  // Links of a hovered ellipse (§2.4 hover highlight): every visible bundle
  // arriving at (top ellipse) or leaving (bottom ellipse) the hovered thought.
  if (ellipseHover !== null) {
    for (const bundle of currentBundles()) {
      const matches =
        ellipseHover.direction === 'parent'
          ? bundle.targetId === ellipseHover.thoughtId
          : bundle.sourceId === ellipseHover.thoughtId;
      if (!matches) continue;
      const src = findCloudAnywhere(bundle.sourceId);
      const tgt = findCloudAnywhere(bundle.targetId);
      if (src === null || tgt === null) continue;
      if (!isCloudVisible(src) || !isCloudVisible(tgt)) continue;
      const from = ellipsePoint(src, 'bottom', hostRect);
      const to = ellipsePoint(tgt, 'top', hostRect);
      drawTopLine(bundle, from, to);
    }
  }

  const active = activeBundle(currentBundles());
  if (active !== null) {
    const src = findCloudAnywhere(active.sourceId);
    const tgt = findCloudAnywhere(active.targetId);
    if (src !== null && tgt !== null && isCloudVisible(src) && isCloudVisible(tgt)) {
      const from = ellipsePoint(src, 'bottom', hostRect);
      const to = ellipsePoint(tgt, 'top', hostRect);
      drawTopLine(active, from, to);
      highlightEnds(src, tgt);
      ensurePopover(active, from, to, hostRect);
      return;
    }
  }
  // No active bundle: don't yank the popover away at once — the cursor may be
  // inside it (or about to enter it). A scheduled hide closes it 0.3 s later
  // unless the line/popover is re-entered or the bundle becomes selected.
  schedulePopoverHide();
}

/** Removes every child of all three overlay SVGs. */
function clearSvg(): void {
  for (const layer of [svg, svgHit, svgTop]) {
    if (layer !== null) {
      while (layer.firstChild !== null) layer.removeChild(layer.firstChild);
    }
  }
}

/**
 * True when the cloud is at least partly inside its zone's visible (clipped)
 * scroll window — the spec's draw condition for a link end (08-ui-spec.md
 * §2.4, элемент «Линия связи на холсте»): intersection of the cloud's rect
 * with the zone's scroll window must exceed {@link VISIBILITY_EPSILON_PX}. A
 * cloud rendered into the overscan rows and fully clipped outside that window
 * carries no line; a cloud only PARTLY scrolled past the zone edge keeps its
 * line and its hit curve (ошибка 16a77453 — requiring FULL containment used to
 * drop the line and kill hover the moment a cloud was clipped by a pixel).
 * Clouds outside any zone (the focus row) are always visible.
 *
 * Zone borders still do not cut the drawn curve: the overlay lives on the
 * canvas host, so the line of a pair spanning two zones stays continuous — this
 * function only decides whether the pair is drawn at all.
 */
function isCloudVisible(cloud: HTMLElement): boolean {
  const zone = cloud.closest('.zone');
  if (zone === null) return true;
  return rectsOverlap(cloud.getBoundingClientRect(), zone.getBoundingClientRect());
}

/** Minimum visible overlap of a cloud with its zone window, px — an overlap
 *  thinner than this is a fully-clipped overscan cloud plus sub-pixel jitter. */
const VISIBILITY_EPSILON_PX = 1;

/** Pure geometry: `a` and `b` overlap by more than `epsilon` on BOTH axes (a
 *  cloud is visible only when it actually has some area inside the window). */
function rectsOverlap(
  a: DOMRectLike,
  b: DOMRectLike,
  epsilon = VISIBILITY_EPSILON_PX,
): boolean {
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlapX > epsilon && overlapY > epsilon;
}

/** Minimal rect shape for {@link rectsOverlap} (DOMRect in the renderer). */
interface DOMRectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Groups edges into directed bundles by `source>target`. */
function groupBundles(edges: readonly FocusEdge[]): Bundle[] {
  const map = new Map<string, Bundle>();
  for (const edge of edges) {
    const key = `${edge.source_id}>${edge.target_id}`;
    let bundle = map.get(key);
    if (bundle === undefined) {
      bundle = { key, sourceId: edge.source_id, targetId: edge.target_id, edges: [] };
      map.set(key, bundle);
    }
    bundle.edges.push(edge);
  }
  return [...map.values()];
}

/**
 * Builds focus↔neighbour edges from the parents/children lists — a fallback for
 * when the server response carries no `edges` (e.g. a not-yet-restarted server
 * predating the field). Neighbour↔neighbour links are not recoverable here.
 */
function edgesFromNeighbours(focus: FocusResponse): FocusEdge[] {
  const fid = focus.focused.id;
  const edges: FocusEdge[] = [];
  for (const n of focus.parents) {
    edges.push({
      id: n.link_id,
      source_id: n.id,
      target_id: fid,
      type_id: n.link_type_id,
      // The neighbour DTO carries the edge's trash flag, so the fallback marks
      // a trashed edge exactly like server-provided `focus.edges` does.
      link_marked_for_deletion: n.link_marked_for_deletion === true,
      // Override unknown in this fallback; inherit from the type.
      color: null,
      style: null,
      width: null,
    });
  }
  for (const n of focus.children) {
    edges.push({
      id: n.link_id,
      source_id: fid,
      target_id: n.id,
      type_id: n.link_type_id,
      link_marked_for_deletion: n.link_marked_for_deletion === true,
      // Override unknown in this fallback; inherit from the type.
      color: null,
      style: null,
      width: null,
    });
  }
  return edges;
}

/** The bundle to highlight right now: the hovered one, else the selected one. */
function activeBundle(bundles: readonly Bundle[]): Bundle | null {
  if (hoveredKey !== null) {
    const hit = bundles.find((b) => b.key === hoveredKey);
    if (hit !== undefined) return hit;
  }
  const selected = store.state.selectedLinkId;
  if (selected !== null) {
    const hit = bundles.find((b) => b.edges.some((e) => e.id === selected));
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * Attachment point of a link on a cloud, in canvas-host coordinates. The
 * argument is the CLOUD (not its ellipse): the ellipses lie on the frame with
 * half of their height outside the card, and a line starts at the OUTER edge
 * of the source's bottom ellipse — `ELLIPSE_INSIDE` px below the frame — and
 * ends at the OUTER edge of the target's top ellipse — `ELLIPSE_INSIDE` px
 * above it (08-ui-spec.md §2.2/§2.4). Fixed offsets keep lines stable while
 * an ellipse grows on hover.
 */
function ellipsePoint(
  el: HTMLElement,
  side: 'top' | 'bottom',
  hostRect: DOMRect,
): { x: number; y: number } {
  const zoom = store.state.canvasZoom;
  const rect = el.getBoundingClientRect();
  const x = rect.left - hostRect.left + rect.width / 2;
  const y =
    side === 'top'
      ? rect.top - hostRect.top - ELLIPSE_INSIDE * zoom
      : rect.bottom - hostRect.top + ELLIPSE_INSIDE * zoom;
  return { x, y };
}

/** Geometry of one Bézier edge (L14, 08-ui-spec.md §2.4). */
export interface EdgeGeometry {
  /** SVG path `d` for the curve. */
  d: string;
  /** Point on the curve at t=0.5 — the badge/label anchor. */
  mid: { x: number; y: number };
}

/**
 * Cubic Bézier edge geometry (L14): the control points leave the endpoints
 * along the attachment normals — the source's bottom ellipse points down,
 * the target's top ellipse points up. Downward edges become smooth vertical
 * S-curves, horizontal ones gentle cables; the bend is clamped to
 * `BEND_MIN..BEND_MAX` so short edges stay visibly curved and long ones
 * never grow huge loops.
 */
export function edgeGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
): EdgeGeometry {
  const { c1, c2 } = edgeControlPoints(from, to);
  return {
    d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
    mid: edgePointAt(from, to, 0.5),
  };
}

/** Control points of the edge curve (see {@link edgeGeometry}). */
function edgeControlPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { c1: { x: number; y: number }; c2: { x: number; y: number } } {
  const dy = Math.abs(to.y - from.y);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const bend = Math.min(BEND_MAX, Math.max(BEND_MIN, Math.max(dy * 0.45, dist * 0.18)));
  return { c1: { x: from.x, y: from.y + bend }, c2: { x: to.x, y: to.y - bend } };
}

/**
 * Point on the edge curve at parameter `t` (0..1) — the same cubic Bézier the
 * line is drawn with. `edgeGeometry` exposes only `t = 0.5` (the label/badge
 * anchor); the trash badge wants an off-centre anchor so it never collides
 * with the type label or the bundle count badge (ошибка 355319d4).
 */
export function edgePointAt(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const { c1, c2 } = edgeControlPoints(from, to);
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * from.x + b1 * c1.x + b2 * c2.x + b3 * to.x,
    y: b0 * from.y + b1 * c1.y + b2 * c2.y + b3 * to.y,
  };
}

/**
 * Resolves the "identity colour" of an endpoint thought for the line gradient
 * (L14): its own background colour, else the thought type's default
 * background. Null when neither is set — the caller falls back to the line
 * style colour.
 */
function endpointColor(thoughtId: string): string | null {
  const ref = getRef(thoughtId);
  if (ref !== null) {
    if (ref.bg_color !== null) return ref.bg_color;
    // L21: the type bg colour resolves along the ancestor chain; an untyped
    // thought resolves the root type.
    return resolveThoughtTypeVisual(store.state.thoughtTypes, ref.type_id).bg_color;
  }
  return null;
}

/** `defs` element of the base overlay; rebuilt on every draw (L14). */
let defsEl: SVGDefsElement | null = null;
/** Sequence for unique gradient ids within one draw. */
let gradientSeq = 0;

/**
 * Adds a linear gradient along the edge (source colour → target colour) to
 * the base overlay defs and returns its `url(#…)` paint reference. One
 * gradient per bundle: the axis follows that bundle's endpoints
 * (`userSpaceOnUse`), so a shared gradient would mis-orient on edges with
 * different directions.
 */
function ensureEdgeGradient(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromColor: string,
  toColor: string,
): string {
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  const id = `etn-lg-${gradientSeq++}`;
  grad.setAttribute('id', id);
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('x1', String(from.x));
  grad.setAttribute('y1', String(from.y));
  grad.setAttribute('x2', String(to.x));
  grad.setAttribute('y2', String(to.y));
  for (const [offset, color] of [
    ['0%', fromColor],
    ['100%', toColor],
  ] as const) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    grad.append(stop);
  }
  defsEl?.append(grad);
  return `url(#${id})`;
}

/** Renders the visible (coloured) Bézier curve + badge/label on the
 *  under-clouds overlay (L14). */
function drawVisualLine(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  if (svg === null) return;
  const count = bundle.edges.length;
  const style = linkStyle(bundle);
  const trashed = bundleTrashed(bundle);
  // Line widths scale with the canvas zoom (L9).
  const zoom = store.state.canvasZoom;
  const lineWidth =
    (count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : style.width) * zoom;
  const geo = edgeGeometry(from, to);

  // Gradient source→target colour (L14): an endpoint's identity colour (own
  // or type background) wins, else the line style colour. Same colours on
  // both ends → plain solid stroke, no gradient is built. A trashed edge takes
  // the neutral dimmed stroke instead, so the gradient is not built at all.
  const fromColor = endpointColor(bundle.sourceId) ?? style.color;
  const toColor = endpointColor(bundle.targetId) ?? style.color;
  const stroke = trashed
    ? TRASHED_STROKE
    : fromColor !== toColor
      ? ensureEdgeGradient(from, to, fromColor, toColor)
      : fromColor;

  const line = document.createElementNS(SVG_NS, 'path');
  line.classList.add('link-line');
  line.setAttribute('d', geo.d);
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-width', String(lineWidth));
  line.setAttribute('stroke-dasharray', trashed ? TRASHED_DASH : style.dash);
  line.setAttribute('stroke-opacity', trashed ? TRASHED_OPACITY : '0.75');
  line.setAttribute('fill', 'none');
  line.dataset['key'] = bundle.key;
  line.dataset['links'] = bundle.edges.map((e) => e.id).join(',');
  // Trash marker (ошибка 355319d4): dimmed dashed line + plain-language title;
  // the clickable restore badge is drawn by `drawHitLine`.
  if (trashed) {
    line.classList.add('link-trashed');
    const trashTitle = document.createElementNS(SVG_NS, 'title');
    trashTitle.textContent = 'Связь в корзине';
    line.append(trashTitle);
  }
  // S11 (§10.3): mark bundles where at least one edge is overridden by the
  // current layer — dashed violet styling tells the user the link carries a
  // layer version without changing its geometry.
  if (bundle.edges.some((e) => store.state.layerOverrides.link_ids.includes(e.id))) {
    line.classList.add('link-overridden');
  }
  // Object-lock indicator (task 4f141756, UI element 8e3703ee): when at least
  // one edge in the bundle is locked, attach an SVG <title> tooltip and a
  // CSS class. The visual 🔒 glyph is rendered separately below as an SVG
  // circle+text at the line midpoint, mirroring the type-label position.
  const lockedEdge = bundle.edges.find((e) => store.state.lockCache[`link:${e.id}`] !== undefined);
  if (lockedEdge !== undefined) {
    const lockRow = store.state.lockCache[`link:${lockedEdge.id}`];
    if (lockRow !== undefined) {
      const meId = store.state.me?.id ?? null;
      const isOwn = meId !== null && lockRow.user_id === meId;
      const holderName = resolveLockHolderName(lockRow.user_id) ?? lockRow.user_id;
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = isOwn
        ? 'Вы редактируете эту связь'
        : `Редактирует ${holderName}`;
      line.append(title);
      line.classList.add(isOwn ? 'link-locked-own' : 'link-locked-other');
    }
  }
  svg.append(line);

  const midX = geo.mid.x;
  const midY = geo.mid.y;
  if (count > 1) {
    const badge = document.createElementNS(SVG_NS, 'circle');
    badge.setAttribute('cx', String(midX));
    badge.setAttribute('cy', String(midY));
    badge.setAttribute('r', String(BADGE_RADIUS * zoom));
    badge.setAttribute('fill', 'var(--surface, #fff)');
    badge.setAttribute('stroke', style.color);
    const text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('link-label-text');
    text.setAttribute('x', String(midX));
    text.setAttribute('y', String(midY + BADGE_TEXT_DY * zoom));
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = String(count);
    svg.append(badge, text);
    return;
  }
  // Single typed link: directional label along the curve.
  const typeId = bundle.edges[0]?.type_id ?? null;
  const type = typeId !== null ? store.state.linkTypes.find((t) => t.id === typeId) : undefined;
  if (type !== undefined) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('link-label-text');
    const offset = (from.y < to.y ? LABEL_OFFSET : -LABEL_OFFSET) * zoom;
    text.setAttribute('x', String(midX));
    text.setAttribute('y', String(midY + offset));
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = linkLabel(bundle, type) + (trashed ? TRASHED_LABEL_SUFFIX : '');
    svg.append(text);
  }
}

/**
 * Ребро (точнее — вся пачка рёбер одной направленной пары) в корзине: так
 * считается, когда КАЖДОЕ её ребро помечено на удаление. Смешанная пачка
 * (живое + помеченное) рисуется обычной линией — связь между мыслями есть,
 * помечать всю линию было бы ложью (ошибка 355319d4).
 */
function bundleTrashed(bundle: Bundle): boolean {
  return bundle.edges.length > 0 && bundle.edges.every((e) => e.link_marked_for_deletion === true);
}

/**
 * Метка корзины на помеченной линии: чёрный кружок с красной иконкой корзины
 * (тот же язык, что у метки помеченного облачка, §2.2). Кликабельна —
 * открывает диалог связи «Вернуть из корзины» / «Удалить совсем»; это и есть
 * «восстановление через корзину» для ребра (у мыслей метку открывает
 * `onTrashBadgeClick` → тот же класс диалога).
 *
 * Рисуется только у пачки из ОДНОГО ребра: у пачки из нескольких непонятно,
 * какое из них восстанавливать, а вся линия помечена лишь когда помечены все —
 * такой редкий случай остаётся с приглушением, пунктиром и подсказкой.
 */
function drawTrashBadge(
  parent: SVGSVGElement,
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  const linkId = bundle.edges.length === 1 ? bundle.edges[0]?.id : undefined;
  if (linkId === undefined) return;
  const zoom = store.state.canvasZoom;
  const size = Math.max(BADGE_RADIUS * 2 * zoom, 16);
  const at = edgePointAt(from, to, TRASH_BADGE_T);
  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', String(at.x - size / 2));
  fo.setAttribute('y', String(at.y - size / 2));
  fo.setAttribute('width', String(size));
  fo.setAttribute('height', String(size));
  const badge = el('button', 'link-trash-badge');
  badge.type = 'button';
  badge.append(svgIcon('trash', Math.round(size * 0.55)));
  setTooltip(badge, 'Связь в корзине — нажмите, чтобы восстановить');
  badge.addEventListener('click', (event) => {
    event.stopPropagation();
    const networkId = store.state.networkId;
    if (networkId === null) return;
    // Ленивый импорт: статический замкнул бы цикл
    // canvas/links → trash → canvas/canvas → canvas/links.
    void import('../trash.js').then(({ openLinkDeleteDialog }) =>
      openLinkDeleteDialog(networkId, linkId),
    );
  });
  // Метка — свой «остров» наведения, как попап: без этого уход курсора с
  // линии на метку гасил бы попап, пока пользователь тянется к кнопке.
  badge.addEventListener('mouseenter', () => cancelPopoverHide());
  fo.append(badge);
  parent.append(fo);
}

/**
 * The type name to label a line with, read from the focused thought (08-ui-spec.md
 * §2.4): links leaving the focus use `name_forward`, links arriving at it —
 * `name_reverse` (e.g. «сотрудники» from the company, «место работы» from the
 * employee). Neighbour↔neighbour lines default to the forward name.
 */
function linkLabel(bundle: Bundle, type: LinkType): string {
  const focusId = store.state.focus?.focused.id;
  if (focusId !== undefined && focusId === bundle.targetId) return type.name_reverse;
  return type.name_forward;
}

/**
 * Renders a wide transparent curve on the hit overlay that captures
 * hover/click for the bundle. Sits under the clouds with the visual layer,
 * so only the stretches of the curve not covered by a cloud are interactive.
 */
function drawHitLine(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  if (svgHit === null) return;
  const count = bundle.edges.length;
  const baseWidth = count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : linkStyle(bundle).width;
  const hit = document.createElementNS(SVG_NS, 'path');
  hit.classList.add('link-hit');
  // Same Bézier geometry as the visible curve (L14) — the wide invisible
  // stroke follows the curve, so hover/click stay on the drawn line.
  hit.setAttribute('d', edgeGeometry(from, to).d);
  hit.setAttribute('fill', 'none');
  // Wide hit area around the (thinner) visible curve, zoom-scaled (L9).
  hit.setAttribute('stroke-width', String(Math.max(baseWidth + 10, 14) * store.state.canvasZoom));
  hit.dataset['key'] = bundle.key;

  hit.addEventListener('mouseenter', () => {
    hoveredKey = bundle.key;
    cancelPopoverHide();
    drawActive();
  });
  hit.addEventListener('mouseleave', () => {
    if (hoveredKey === bundle.key) {
      hoveredKey = null;
      // Leaving the line no longer hides the popover instantly: the cursor may
      // be heading into it (it sits on the curve's midpoint). The scheduled
      // hide is cancelled by the popover's own mouseenter; the sticky
      // selection keeps its popover regardless (checked in the timer).
      schedulePopoverHide();
      drawActive();
    }
  });
  hit.addEventListener('click', (event) => void onLineClick(bundle, event));
  hit.addEventListener('contextmenu', (event) => onLineContextMenu(bundle, event));
  svgHit.append(hit);
  // Restore affordance for a trashed edge (ошибка 355319d4) — lives in the
  // interactive layer, so it is clickable and survives the top-overlay redraws.
  if (bundleTrashed(bundle)) drawTrashBadge(svgHit, bundle, from, to);
}

/** Renders the highlighted copy of a curve on the above-clouds overlay,
 *  together with its badge/label highlighted in the selection colour (§2.4). */
function drawTopLine(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  if (svgTop === null) return;
  const count = bundle.edges.length;
  const baseWidth = count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : linkStyle(bundle).width;
  const zoom = store.state.canvasZoom;
  const geo = edgeGeometry(from, to);
  // A trashed bundle keeps its dashes when highlighted, so hovering does not
  // momentarily «un-trash» the line (ошибка 355319d4).
  const trashed = bundleTrashed(bundle);
  const line = document.createElementNS(SVG_NS, 'path');
  line.classList.add('link-line', 'link-line-active');
  line.setAttribute('d', geo.d);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'var(--warn, #c98a06)');
  line.setAttribute('stroke-width', String(baseWidth * zoom + 2));
  line.setAttribute('stroke-opacity', '1');
  if (trashed) line.setAttribute('stroke-dasharray', TRASHED_DASH);
  svgTop.append(line);

  // The label rides along in the selection colour: a count badge for bundles,
  // the type name for a single typed link — drawn exactly over the base-layer
  // copy, so the dim original is fully covered.
  const midX = geo.mid.x;
  const midY = geo.mid.y;
  if (count > 1) {
    const badge = document.createElementNS(SVG_NS, 'circle');
    badge.setAttribute('cx', String(midX));
    badge.setAttribute('cy', String(midY));
    badge.setAttribute('r', String(BADGE_RADIUS * zoom));
    badge.setAttribute('fill', 'var(--surface, #fff)');
    badge.setAttribute('stroke', 'var(--warn, #c98a06)');
    badge.setAttribute('stroke-width', '2');
    const text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('link-label-text');
    text.setAttribute('fill', 'var(--warn, #c98a06)');
    text.setAttribute('font-weight', '700');
    text.setAttribute('x', String(midX));
    text.setAttribute('y', String(midY + BADGE_TEXT_DY * zoom));
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = String(count);
    svgTop.append(badge, text);
    return;
  }
  const typeId = bundle.edges[0]?.type_id ?? null;
  const type = typeId !== null ? store.state.linkTypes.find((t) => t.id === typeId) : undefined;
  if (type !== undefined) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('link-label-text');
    text.setAttribute('fill', 'var(--warn, #c98a06)');
    text.setAttribute('font-weight', '700');
    const offset = (from.y < to.y ? LABEL_OFFSET : -LABEL_OFFSET) * zoom;
    text.setAttribute('x', String(midX));
    text.setAttribute('y', String(midY + offset));
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = linkLabel(bundle, type) + (trashed ? TRASHED_LABEL_SUFFIX : '');
    svgTop.append(text);
  }
}

/** Stroke styling for a bundle: per-link override wins, else the type chain. */
function linkStyle(bundle: Bundle): { color: string; width: number; dash: string } {
  const edges = bundle.edges;
  if (edges.length === 0) {
    return { color: DEFAULT_COLOR, width: BASE_WIDTH, dash: 'none' };
  }
  // Resolve one edge: its own override (color/style/width) wins over the type
  // chain default (08-ui-spec.md §6.9; L21 — unset type fields inherit from
  // the ancestors, an untyped link resolves the root type). All edges of a
  // bundle must agree, else the bundle is heterogeneous and falls back to the
  // default stroke.
  const resolve = (edge: FocusEdge) => {
    const type = resolveLinkTypeVisual(store.state.linkTypes, edge.type_id);
    const color = edge.color ?? type.color;
    const style = edge.style ?? type.style;
    const width = edge.width ?? type.width;
    return { color, style, width };
  };
  const first = resolve(edges[0]!);
  const allAgree = edges.every((edge) => {
    const s = resolve(edge);
    return s.color === first.color && s.style === first.style && s.width === first.width;
  });
  if (!allAgree) {
    return { color: DEFAULT_COLOR, width: BASE_WIDTH, dash: 'none' };
  }
  const dash = first.style === 'dashed' ? '6 4' : first.style === 'dotted' ? '2 4' : 'none';
  return {
    color: first.color ?? DEFAULT_COLOR,
    width: first.width ?? BASE_WIDTH,
    dash,
  };
}

/** Highlights the bottom ellipse of the source and the top ellipse of the target. */
function highlightEnds(src: HTMLElement, tgt: HTMLElement): void {
  const srcBottom = src.querySelector<HTMLElement>('.ellipse-bottom');
  const tgtTop = tgt.querySelector<HTMLElement>('.ellipse-top');
  highlightedEllipses = [];
  for (const el of [srcBottom, tgtTop]) {
    if (el !== null) {
      el.classList.add('link-end');
      highlightedEllipses.push(el);
    }
  }
}

/** Removes the endpoint highlight set by the previous draw. */
function clearEnds(): void {
  for (const el of highlightedEllipses) el.classList.remove('link-end');
  highlightedEllipses = [];
}

// ---------------------------------------------------------------------------
// Popover (hover/selection info)
// ---------------------------------------------------------------------------

/** Grace delay before the popover hides once the cursor left BOTH the hit
 *  line and the popover itself — the same 0.3 s "hover island" pattern as
 *  `lib/hover-preview.ts`: gives time to move the cursor into the popover. */
const POPOVER_CLOSE_DELAY_MS = 300;
/** Pending hide timer; cancelled by re-entering the hit line or the popover. */
let popoverHideTimer: number | null = null;
/** True while the cursor is inside the popover (keeps it alive even when a
 *  canvas redraw runs `drawActive` with no hovered/selected bundle). */
let popoverInside = false;

function cancelPopoverHide(): void {
  if (popoverHideTimer !== null) {
    window.clearTimeout(popoverHideTimer);
    popoverHideTimer = null;
  }
}

/** Schedules the popover hide (no-op when none is open). The timer callback
 *  re-checks the live state before hiding: the popover survives while its
 *  bundle is still the hovered/selected one (e.g. the click that
 *  sticky-selected the link just landed) or while the cursor is inside it. */
function schedulePopoverHide(): void {
  if (popover === null || popoverHideTimer !== null) return;
  popoverHideTimer = window.setTimeout(() => {
    popoverHideTimer = null;
    if (popover === null) return;
    if (popover.dataset['key'] === activeBundle(currentBundles())?.key) return;
    if (popoverInside) return;
    hidePopover();
  }, POPOVER_CLOSE_DELAY_MS);
}

/**
 * Shows the popover for `bundle` if not already open for it, positioning it at
 * the curve's t=0.5 point once. While the popover stays open for the SAME
 * bundle (`popover.dataset['key']` matches) the position is FROZEN: redraws
 * and re-hovers must not move the box under the cursor — the user may be
 * inside it, Ctrl-hovering it for the permanent-comment preview (the popover
 * is interactive, `pointer-events: auto`, so the Ctrl-hover preview engine
 * works inside it).
 */
function ensurePopover(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
  hostRect: DOMRect,
): void {
  if (popover !== null && popover.dataset['key'] === bundle.key) return;
  showPopover(bundle);
  if (popover !== null) {
    // Anchor at the curve's t=0.5 point, matching the badge (L14).
    const mid = edgeGeometry(from, to).mid;
    popover.style.left = `${hostRect.left + mid.x}px`;
    popover.style.top = `${hostRect.top + mid.y}px`;
  }
}

/** Type names of a bundle's links (also used as the Ctrl-hover preview title
 *  for a single-link bundle — a link has no title of its own). */
function bundleTypeNames(bundle: Bundle): string {
  return bundle.edges
    .map((edge) => {
      const type =
        edge.type_id !== null ? store.state.linkTypes.find((t) => t.id === edge.type_id) : undefined;
      return type === undefined ? 'без типа' : `${type.name_forward} / ${type.name_reverse}`;
    })
    .join(' · ');
}

/** Builds the popover content for a bundle (type names only). */
function showPopover(bundle: Bundle): void {
  hidePopover();
  popover = div('link-popover');
  popover.dataset['key'] = bundle.key;
  // Trashed edge: the popover states it in words — the dimmed dashed line plus
  // the badge say «корзина», the text says it unambiguously (ошибка 355319d4).
  const trashed = bundleTrashed(bundle);
  const title = bundleTypeNames(bundle) + (trashed ? ' · в корзине' : '');
  popover.append(el('div', 'link-popover-types', title));
  // Single-link bundles carry the Ctrl-hover preview marker for the link's
  // permanent comment (the engine shows nothing when it has none). A bundle of
  // several links has no single owner edge, so it stays plain names.
  const single = bundle.edges.length === 1 ? bundle.edges[0] : undefined;
  if (single !== undefined) {
    markCommentPreview(popover, 'link', single.id, title);
  }
  // The popover is a "hover island" (pointer-events: auto, styles.css): a
  // leave from the hit line only SCHEDULES the hide — entering the popover
  // cancels it (and keeps the top-line highlight alive, as the hover would),
  // leaving the popover schedules it again. Without this the popover vanished
  // the instant the cursor stepped off the curve and could never be entered.
  popover.addEventListener('mouseenter', () => {
    popoverInside = true;
    cancelPopoverHide();
    // Entering the popover counts as still hovering its link: the top-line
    // highlight and the popover itself stay alive (the leave from the hit
    // line had only scheduled a hide).
    hoveredKey = bundle.key;
    drawActive();
  });
  popover.addEventListener('mouseleave', () => {
    popoverInside = false;
    if (hoveredKey === bundle.key) hoveredKey = null;
    schedulePopoverHide();
    drawActive();
  });
  // The popover sits ON the curve's midpoint, where the hit line runs beneath
  // it. Clicks are forwarded to the line's handler, so the sticky-select /
  // editor-open / bundle-picker behaviour of clicking the line works exactly
  // as before the popover became interactive. `stopPropagation` keeps
  // document-level listeners (e.g. a menu's close-on-outside-click) from
  // eating the very click that opened the picker.
  popover.addEventListener('click', (event) => {
    event.stopPropagation();
    void onLineClick(bundle, event);
  });
  document.body.append(popover);
}

function hidePopover(): void {
  cancelPopoverHide();
  popover?.remove();
  popover = null;
  popoverInside = false;
}

// ---------------------------------------------------------------------------
// Click: editor (single) or picker (bundle), with sticky selection
// ---------------------------------------------------------------------------

async function onLineClick(bundle: Bundle, event: MouseEvent): Promise<void> {
  if (bundle.edges.length === 1) {
    const edge = bundle.edges[0];
    if (edge === undefined || opener === null) return;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    selectLink(edge.id);
    try {
      const link = await etn.links.get(networkId, edge.id);
      opener(link);
    } catch {
      // The link disappeared concurrently — the realtime refresh will redraw.
    }
    return;
  }
  // Multiple links: let the user pick one.
  const items: MenuItem[] = bundle.edges.map((edge) => {
    const type =
      edge.type_id !== null ? store.state.linkTypes.find((t) => t.id === edge.type_id) : undefined;
    return {
      label: type?.name_forward ?? 'Связь без типа',
      onClick: () => {
        void (async () => {
          if (opener === null) return;
          const networkId = store.state.networkId;
          if (networkId === null) return;
          selectLink(edge.id);
          try {
            const link = await etn.links.get(networkId, edge.id);
            opener(link);
          } catch {
            // ignore
          }
        })();
      },
    };
  });
  closeMenu();
  showMenuAt(event.clientX, event.clientY, items);
}

/** Sets the sticky link selection and refreshes only the active layer. */
function selectLink(linkId: string): void {
  store.update({ selectedLinkId: linkId });
  drawActive();
}

/**
 * Right-click on a link bundle: opens the link context menu (properties /
 * activity / delete). For a multi-link bundle the user first picks the link.
 */
function onLineContextMenu(bundle: Bundle, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (bundle.edges.length === 1) {
    const edge = bundle.edges[0];
    if (edge !== undefined) showLinkContextMenu(event, edge.id);
    return;
  }
  const items: MenuItem[] = bundle.edges.map((edge) => {
    const type =
      edge.type_id !== null ? store.state.linkTypes.find((t) => t.id === edge.type_id) : undefined;
    return {
      label: type?.name_forward ?? 'Связь без типа',
      onClick: () => showLinkContextMenu(event, edge.id),
    };
  });
  closeMenu();
  showMenuAt(event.clientX, event.clientY, items);
}

/** Test seam. */
export const linksInternals = {
  ellipsePoint,
  linkStyle,
  groupBundles,
  bundleTrashed,
  rectsOverlap,
  edgeGeometry,
  edgePointAt,
  edgeSource,
};
