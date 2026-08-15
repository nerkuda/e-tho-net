/**
 * SVG link overlay (H6, 08-ui-spec.md §2.4):
 *
 * Draws every link among the visible thoughts (focus + parents + children +
 * siblings), sourced from `focus.edges`. Only pairs whose both clouds fully
 * fit their zone's visible scroll window get a line — clouds clipped by the
 * virtualized overscan carry no lines until scrolled into view (§2.5). Each
 * directed pair (source→target) is one cubic Bézier curve from the source's
 * bottom ellipse to the target's top ellipse, stroked with a source→target
 * colour gradient (L14); several links of the same pair render as a thicker
 * curve with a count badge.
 *
 * Layering: the base overlay sits **under** the clouds; the wide transparent
 * hit curves sit under the clouds too — only the visible stretch of a line
 * is interactive, so hovering a cloud never "surfaces" the links passing
 * beneath it and cloud hover/click always work. The link currently hovered
 * or sticky-selected is re-rendered in a top overlay **above** the clouds,
 * with a popover (type name + 📝/📅/📎 counts) and highlighted ellipses
 * on both endpoints. Click opens the link in the editor (single) or a picker
 * (bundle) and leaves it selected until a click elsewhere.
 *
 * Redrawn (rAF-debounced) on canvas renders, scrolling, resizes and focus
 * changes; positions come from `getBoundingClientRect` relative to the host.
 */

import type { FocusEdge, FocusResponse, LinkType } from '@etn/shared';

import { closeMenu, showMenuAt, type MenuItem } from '../lib/menu.js';
import { div, el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
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
/** Y-offsets from a bounding edge to an ellipse center, px at zoom 1: the
 *  ellipses lie ON the cloud frame, so the center is half their 8px height
 *  inwards from the card edge (L12). */
const ELLIPSE_TOP_DY = 4;
const ELLIPSE_BOTTOM_DY = 4;
/** Bézier bend clamp range, px (L14): keeps short edges visibly curved and
 *  long edges from growing huge loops. */
const BEND_MIN = 24;
const BEND_MAX = 140;

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
let popover: HTMLElement | null = null;
/** Bundle whose popover is open (to refresh counts on invalidation). */
let activePopoverBundle: Bundle | null = null;
let opener: LinkEditorOpener | null = null;
/** Bundle key currently under the cursor (transient). */
let hoveredKey: string | null = null;
/** Endpoint ellipses currently highlighted, to clear on the next redraw. */
let highlightedEllipses: HTMLElement[] = [];

/** Comment/chronology/attachment counts of a single link, cached per hover. */
const linkCountsCache = new Map<string, { comments: number; chrono: number; attachments: number }>();

/**
 * Mounts the link overlay onto a canvas host. Returns the redraw trigger;
 * `mountCanvas` calls it and hands the created SVG elements to {@link draw}.
 */
export function initLinksOverlay(host: HTMLElement): { redraw(): void } {
  hostEl = host;
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('links-overlay');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svgHit = document.createElementNS(SVG_NS, 'svg');
  svgHit.classList.add('links-overlay-hit');
  svgHit.setAttribute('width', '100%');
  svgHit.setAttribute('height', '100%');
  svgTop = document.createElementNS(SVG_NS, 'svg');
  svgTop.classList.add('links-overlay-top');
  svgTop.setAttribute('width', '100%');
  svgTop.setAttribute('height', '100%');
  // DOM order is the source of truth for layering: visual overlay FIRST (under
  // the clouds), then hit + top overlays LAST. The hit layer shares z=0 with
  // the visual one and relies on DOM order to sit above the curves — both stay
  // BELOW the clouds (z=1), keeping every cloud hover/click-able (§2.4).
  host.prepend(svg);
  host.append(svgHit, svgTop);

  new ResizeObserver(() => requestDraw()).observe(host);
  host.addEventListener('scroll', () => requestDraw(), true);

  return { redraw: requestDraw };
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

  // `edges` is populated by a current server; fall back to deriving the
  // focus↔neighbour edges from parents/children so the overlay still draws
  // (and never crashes) if a stale server process omits the field.
  const edges = focus.edges ?? edgesFromNeighbours(focus);
  const bundles = groupBundles(edges);
  for (const bundle of bundles) {
    const src = findCloudAnywhere(bundle.sourceId);
    const tgt = findCloudAnywhere(bundle.targetId);
    if (src === null || tgt === null) continue;
    // Virtualized zones also render overscan rows clipped outside the scroll
    // window (08-ui-spec.md §2.5) — a line ending at such a cloud floats over
    // other zones and misleads. Draw only between fully visible clouds.
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
  return groupBundles(focus.edges ?? edgesFromNeighbours(focus));
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
  hidePopover();
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
 * True when the cloud is fully inside its zone's visible (clipped) scroll
 * window. Clouds rendered into the overscan rows stick out of the clipped
 * zone (08-ui-spec.md §2.5) and must not carry link lines until they fully
 * fit. Clouds outside any zone (the focus row) are always visible.
 */
function isCloudVisible(cloud: HTMLElement): boolean {
  const zone = cloud.closest('.zone');
  if (zone === null) return true;
  return rectFitsInside(cloud.getBoundingClientRect(), zone.getBoundingClientRect());
}

/** Layout rounding tolerance for the nested-rect check, px. */
const VISIBILITY_EPSILON_PX = 1;

/** Pure geometry: `inner` fully inside `outer` (within `epsilon` per side). */
function rectFitsInside(
  inner: DOMRectLike,
  outer: DOMRectLike,
  epsilon = VISIBILITY_EPSILON_PX,
): boolean {
  return (
    inner.left >= outer.left - epsilon &&
    inner.right <= outer.right + epsilon &&
    inner.top >= outer.top - epsilon &&
    inner.bottom <= outer.bottom + epsilon
  );
}

/** Minimal rect shape for {@link rectFitsInside} (DOMRect in the renderer). */
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

/** Center of an ellipse side, in canvas-host coordinates. The ellipse grows
 *  with the canvas zoom, so do the Y nudges (L9). */
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
      ? rect.top - hostRect.top + ELLIPSE_TOP_DY * zoom
      : rect.bottom - hostRect.top - ELLIPSE_BOTTOM_DY * zoom;
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
  const dy = Math.abs(to.y - from.y);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const bend = Math.min(BEND_MAX, Math.max(BEND_MIN, Math.max(dy * 0.45, dist * 0.18)));
  const c1 = { x: from.x, y: from.y + bend };
  const c2 = { x: to.x, y: to.y - bend };
  // Cubic Bézier at t = 0.5: (P0 + 3·P1 + 3·P2 + P3) / 8.
  const mid = {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  };
  return {
    d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
    mid,
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
    if (ref.type_id !== null) {
      return store.state.thoughtTypes.find((t) => t.id === ref.type_id)?.bg_color ?? null;
    }
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
  // Line widths scale with the canvas zoom (L9).
  const zoom = store.state.canvasZoom;
  const lineWidth =
    (count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : style.width) * zoom;
  const geo = edgeGeometry(from, to);

  // Gradient source→target colour (L14): an endpoint's identity colour (own
  // or type background) wins, else the line style colour. Same colours on
  // both ends → plain solid stroke, no gradient is built.
  const fromColor = endpointColor(bundle.sourceId) ?? style.color;
  const toColor = endpointColor(bundle.targetId) ?? style.color;
  const stroke = fromColor !== toColor ? ensureEdgeGradient(from, to, fromColor, toColor) : fromColor;

  const line = document.createElementNS(SVG_NS, 'path');
  line.classList.add('link-line');
  line.setAttribute('d', geo.d);
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-width', String(lineWidth));
  line.setAttribute('stroke-dasharray', style.dash);
  line.setAttribute('stroke-opacity', '0.75');
  line.setAttribute('fill', 'none');
  line.dataset['key'] = bundle.key;
  line.dataset['links'] = bundle.edges.map((e) => e.id).join(',');
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
    text.textContent = linkLabel(bundle, type);
    svg.append(text);
  }
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
    drawActive();
  });
  hit.addEventListener('mouseleave', () => {
    if (hoveredKey === bundle.key) {
      hoveredKey = null;
      drawActive();
    }
  });
  hit.addEventListener('click', (event) => void onLineClick(bundle, event));
  hit.addEventListener('contextmenu', (event) => onLineContextMenu(bundle, event));
  svgHit.append(hit);
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
  const line = document.createElementNS(SVG_NS, 'path');
  line.classList.add('link-line', 'link-line-active');
  line.setAttribute('d', geo.d);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'var(--warn, #c98a06)');
  line.setAttribute('stroke-width', String(baseWidth * zoom + 2));
  line.setAttribute('stroke-opacity', '1');
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
    text.textContent = linkLabel(bundle, type);
    svgTop.append(text);
  }
}

/** Stroke styling for a bundle: per-link override wins, else the type default. */
function linkStyle(bundle: Bundle): { color: string; width: number; dash: string } {
  const edges = bundle.edges;
  if (edges.length === 0) {
    return { color: DEFAULT_COLOR, width: BASE_WIDTH, dash: 'none' };
  }
  // Resolve one edge: its own override (color/style/width) wins over the type
  // default (08-ui-spec.md §6.9). All edges of a bundle must agree, else the
  // bundle is heterogeneous and falls back to the default stroke.
  const resolve = (edge: FocusEdge) => {
    const type =
      edge.type_id !== null ? store.state.linkTypes.find((t) => t.id === edge.type_id) : undefined;
    const color = edge.color ?? type?.color ?? null;
    const style = edge.style ?? type?.style ?? 'solid';
    const width = edge.width ?? type?.width ?? null;
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

/** Shows the popover for `bundle` if not already, then positions it at the midpoint. */
function ensurePopover(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
  hostRect: DOMRect,
): void {
  if (popover === null || popover.dataset['key'] !== bundle.key) {
    showPopover(bundle);
  }
  if (popover !== null) {
    // Anchor at the curve's t=0.5 point, matching the badge (L14).
    const mid = edgeGeometry(from, to).mid;
    popover.style.left = `${hostRect.left + mid.x}px`;
    popover.style.top = `${hostRect.top + mid.y}px`;
  }
}

/** Builds the popover content for a bundle (type names + comment/attachment counts). */
function showPopover(bundle: Bundle): void {
  hidePopover();
  popover = div('link-popover');
  popover.dataset['key'] = bundle.key;
  activePopoverBundle = bundle;
  const names = bundle.edges
    .map((edge) => {
      const type =
        edge.type_id !== null ? store.state.linkTypes.find((t) => t.id === edge.type_id) : undefined;
      return type === undefined ? 'без типа' : `${type.name_forward} / ${type.name_reverse}`;
    })
    .join(' · ');
  popover.append(el('div', 'link-popover-types', names));
  const counts = div('link-popover-counts');
  popover.append(counts);
  document.body.append(popover);
  void loadLinkCounts(bundle, counts);
}

function hidePopover(): void {
  popover?.remove();
  popover = null;
  activePopoverBundle = null;
}

/**
 * Drops the cached popover counts of one link (all links when `linkId` is
 * null). A popover that is currently open for the affected link re-fetches its
 * counts at once — the popover stays visible while the link is sticky-selected
 * and its owner (comments/attachments) changes in the editor or via realtime.
 */
export function invalidateLinkCounts(linkId: string | null): void {
  if (linkId === null) {
    linkCountsCache.clear();
  } else {
    linkCountsCache.delete(linkId);
  }
  const bundle = activePopoverBundle;
  if (popover === null || bundle === null || bundle.edges.length !== 1) return;
  const edge = bundle.edges[0];
  if (edge === undefined) return;
  if (linkId !== null && edge.id !== linkId) return;
  const counts = popover.querySelector('.link-popover-counts');
  if (counts instanceof HTMLElement) void loadLinkCounts(bundle, counts);
}

/** Lazily fetches comment/chronology/attachment counts for a bundle. */
async function loadLinkCounts(bundle: Bundle, target: HTMLElement): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  if (bundle.edges.length !== 1) {
    target.textContent = `связей: ${bundle.edges.length}`;
    return;
  }
  const linkId = bundle.edges[0]?.id;
  if (linkId === undefined) return;
  let cached = linkCountsCache.get(linkId);
  if (cached === undefined) {
    try {
      const comments = await etn.comments.list(networkId, 'link', linkId);
      const attachments = await etn.attachments.list(networkId, 'link', linkId);
      const chrono = comments.filter((c) => c.kind === 'chronological').length;
      const perm = comments.filter((c) => c.kind === 'permanent').length;
      cached = { comments: perm, chrono, attachments: attachments.length };
      linkCountsCache.set(linkId, cached);
    } catch {
      cached = { comments: 0, chrono: 0, attachments: 0 };
    }
  }
  if (popover === null || popover.dataset['key'] !== bundle.key) return;
  target.textContent = `📝 ${cached.comments} · 📅 ${cached.chrono} · 📎 ${cached.attachments}`;
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
  rectFitsInside,
  edgeGeometry,
};
