/**
 * SVG link overlay (H6, 08-ui-spec.md §2.4):
 *
 * Draws every link among the visible thoughts (focus + parents + children +
 * siblings), sourced from `focus.edges`. Each directed pair (source→target) is
 * one line from the source's bottom ellipse to the target's top ellipse; several
 * links of the same pair render as a thicker line with a count badge.
 *
 * Layering: the base overlay sits **under** the clouds; the link currently
 * hovered or sticky-selected is re-rendered in a top overlay **above** the
 * clouds, with a popover (type name + 📝/📅/📎 counts) and highlighted ellipses
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
import { findCloudAnywhere } from './canvas.js';
import { showLinkContextMenu } from './context-menu.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Editor opener signature: receives the full link record. */
export type LinkEditorOpener = (link: import('@etn/shared').Link) => void;

/** Base line width, px. */
const BASE_WIDTH = 1.5;
/** Extra width per additional link between the same directed pair. */
const EXTRA_WIDTH_PER_LINK = 1.2;
/** Default colour for untyped links. */
const DEFAULT_COLOR = '#9aa3b2';

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
/** Hit overlay — above the clouds; carries wide transparent lines that capture
 *  hover/click so the visual lines under the clouds stay interactive. */
let svgHit: SVGSVGElement | null = null;
/** Top overlay — above the hit layer; carries the hovered/selected line. */
let svgTop: SVGSVGElement | null = null;
let popover: HTMLElement | null = null;
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
  // the clouds), then hit + top overlays LAST (above the clouds). z-index alone
  // is unreliable across the zone/stacking layout.
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
    if (src !== null && tgt !== null) {
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

/** Center of an ellipse side, in canvas-host coordinates. */
function ellipsePoint(
  el: HTMLElement,
  side: 'top' | 'bottom',
  hostRect: DOMRect,
): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const x = rect.left - hostRect.left + rect.width / 2;
  const y = side === 'top' ? rect.top - hostRect.top + 6 : rect.bottom - hostRect.top - 5;
  return { x, y };
}

/** Renders the visible (coloured) line + badge/label on the under-clouds overlay. */
function drawVisualLine(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  if (svg === null) return;
  const count = bundle.edges.length;
  const style = linkStyle(bundle);
  const lineWidth = count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : style.width;

  const line = document.createElementNS(SVG_NS, 'line');
  line.classList.add('link-line');
  line.setAttribute('x1', String(from.x));
  line.setAttribute('y1', String(from.y));
  line.setAttribute('x2', String(to.x));
  line.setAttribute('y2', String(to.y));
  line.setAttribute('stroke', style.color);
  line.setAttribute('stroke-width', String(lineWidth));
  line.setAttribute('stroke-dasharray', style.dash);
  line.setAttribute('stroke-opacity', '0.75');
  line.dataset['key'] = bundle.key;
  line.dataset['links'] = bundle.edges.map((e) => e.id).join(',');
  svg.append(line);

  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  if (count > 1) {
    const badge = document.createElementNS(SVG_NS, 'circle');
    badge.setAttribute('cx', String(midX));
    badge.setAttribute('cy', String(midY));
    badge.setAttribute('r', '9');
    badge.setAttribute('fill', 'var(--surface, #fff)');
    badge.setAttribute('stroke', style.color);
    const text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('link-label-text');
    text.setAttribute('x', String(midX));
    text.setAttribute('y', String(midY + 3.5));
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = String(count);
    svg.append(badge, text);
    return;
  }
  // Single typed link: name_forward label along the line.
  const typeId = bundle.edges[0]?.type_id ?? null;
  const type = typeId !== null ? store.state.linkTypes.find((t) => t.id === typeId) : undefined;
  if (type !== undefined) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('link-label-text');
    const offset = from.y < to.y ? 8 : -8;
    text.setAttribute('x', String(midX));
    text.setAttribute('y', String(midY + offset));
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = type.name_forward;
    svg.append(text);
  }
}

/**
 * Renders a wide transparent line on the above-clouds hit overlay that captures
 * hover/click for the bundle. This is what keeps links interactive even though
 * the visible line is drawn under the clouds.
 */
function drawHitLine(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  if (svgHit === null) return;
  const count = bundle.edges.length;
  const baseWidth = count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : linkStyle(bundle).width;
  const hit = document.createElementNS(SVG_NS, 'line');
  hit.classList.add('link-hit');
  hit.setAttribute('x1', String(from.x));
  hit.setAttribute('y1', String(from.y));
  hit.setAttribute('x2', String(to.x));
  hit.setAttribute('y2', String(to.y));
  // Wide hit area around the (thinner) visible line.
  hit.setAttribute('stroke-width', String(Math.max(baseWidth + 10, 14)));
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

/** Renders the highlighted copy of a line on the above-clouds overlay. */
function drawTopLine(
  bundle: Bundle,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  if (svgTop === null) return;
  const count = bundle.edges.length;
  const baseWidth = count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : linkStyle(bundle).width;
  const line = document.createElementNS(SVG_NS, 'line');
  line.classList.add('link-line', 'link-line-active');
  line.setAttribute('x1', String(from.x));
  line.setAttribute('y1', String(from.y));
  line.setAttribute('x2', String(to.x));
  line.setAttribute('y2', String(to.y));
  line.setAttribute('stroke', 'var(--warn, #c98a06)');
  line.setAttribute('stroke-width', String(baseWidth + 2));
  line.setAttribute('stroke-opacity', '1');
  svgTop.append(line);
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
  const srcBottom = src.querySelector<HTMLElement>('.ellipse:last-of-type');
  const tgtTop = tgt.querySelector<HTMLElement>('.ellipse');
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
    const midX = hostRect.left + (from.x + to.x) / 2;
    const midY = hostRect.top + (from.y + to.y) / 2;
    popover.style.left = `${midX}px`;
    popover.style.top = `${midY}px`;
  }
}

/** Builds the popover content for a bundle (type names + comment/attachment counts). */
function showPopover(bundle: Bundle): void {
  hidePopover();
  popover = div('link-popover');
  popover.dataset['key'] = bundle.key;
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
export const linksInternals = { ellipsePoint, linkStyle, groupBundles };
