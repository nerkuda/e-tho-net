/**
 * SVG link overlay (H6, 08-ui-spec.md §2.4):
 *
 * - draws a line from the bottom ellipse of the source cloud to the top
 *   ellipse of the target cloud: parents → focus (top ellipse), focus →
 *   children;
 * - typed links carry the `name_forward` label along the line (color/style/
 *   width from the link type catalogue);
 * - several links between the same pair → thicker line with a count badge;
 *   hover opens a tooltip with forward/reverse names and comment/attachment
 *   counts; click opens the link in the editor (single) or shows a picker
 *   (multiple) — the editor registers via {@link setLinkEditorOpener}.
 *
 * The overlay is redrawn (rAF-debounced) on canvas renders, scrolling,
 * resizes and focus changes; positions are computed from `getBoundingClientRect`
 * relative to the canvas host.
 */

import type { LinkType } from '@etn/shared';

import { closeMenu, showMenuAt, type MenuItem } from '../lib/menu.js';
import { div, el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import { findZoneCloud, getFocusCloudEl, getZoneEntries, type ZoneEntry } from './canvas.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Editor opener signature: receives the full link record. */
export type LinkEditorOpener = (link: import('@etn/shared').Link) => void;

/** Base line width, px. */
const BASE_WIDTH = 1.5;
/** Extra width per additional link between the same pair. */
const EXTRA_WIDTH_PER_LINK = 1.2;
/** Default colour for untyped links. */
const DEFAULT_COLOR = '#9aa3b2';
/** Tooltip offset from the cursor, px. */
const TOOLTIP_OFFSET = 14;

let svg: SVGSVGElement | null = null;
let hostEl: HTMLElement | null = null;
let tooltip: HTMLElement | null = null;
let opener: LinkEditorOpener | null = null;
let drawQueued = false;

/** Comment/attachment counts of a link, cached on first hover. */
const linkCountsCache = new Map<string, { comments: number; attachments: number }>();

/**
 * Mounts the link overlay onto a canvas host. Returns the redraw trigger;
 * `mountCanvas` calls it and hands the created SVG element to {@link draw}.
 */
export function initLinksOverlay(host: HTMLElement): { redraw(): void } {
  hostEl = host;
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('links-overlay');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  host.append(svg);

  new ResizeObserver(() => requestDraw()).observe(host);
  host.addEventListener('scroll', () => requestDraw(), true);

  return { redraw: requestDraw };
}

/** Registers the link editor opener (editor module, H8). */
export function setLinkEditorOpener(next: LinkEditorOpener | null): void {
  opener = next;
}

/** Requests an rAF-debounced redraw of all link lines. */
export function requestDraw(): void {
  if (drawQueued || svg === null) return;
  drawQueued = true;
  window.requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

/** Hides the hover tooltip. */
export function hideLinkTooltip(): void {
  tooltip?.remove();
  tooltip = null;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Recomputes and re-renders every line of the overlay. */
function draw(): void {
  if (svg === null || hostEl === null) return;
  clearSvg();
  const focus = store.state.focus;
  if (focus === null) return;
  const focusCloud = getFocusCloudEl();
  const hostRect = hostEl.getBoundingClientRect();
  if (focusCloud === null || hostRect.width === 0) return;

  // Parents: their bottom ellipse → focus top ellipse.
  for (const entry of getZoneEntries('parents')) {
    const cloud = findZoneCloud(entry.id, 'parents');
    if (cloud === null) continue;
    const from = ellipsePoint(cloud, 'bottom', hostRect);
    const to = ellipsePoint(focusCloud, 'top', hostRect);
    drawLinkLine(entry, from, to);
  }
  // Children: focus bottom ellipse → their top ellipse.
  for (const entry of getZoneEntries('children')) {
    const cloud = findZoneCloud(entry.id, 'children');
    if (cloud === null) continue;
    const from = ellipsePoint(focusCloud, 'bottom', hostRect);
    const to = ellipsePoint(cloud, 'top', hostRect);
    drawLinkLine(entry, from, to);
  }
}

/** Removes every child of the overlay SVG. */
function clearSvg(): void {
  if (svg === null) return;
  while (svg.firstChild !== null) svg.removeChild(svg.firstChild);
  hideLinkTooltip();
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

/** Renders one line (or a bundle) for a zone entry. */
function drawLinkLine(
  entry: ZoneEntry,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  if (svg === null) return;
  const count = entry.links.length;

  const line = document.createElementNS(SVG_NS, 'line');
  line.classList.add('link-line');
  line.setAttribute('x1', String(from.x));
  line.setAttribute('y1', String(from.y));
  line.setAttribute('x2', String(to.x));
  line.setAttribute('y2', String(to.y));

  const style = linkStyle(entry);
  // Bundles of several links render thicker than a single typed link.
  const lineWidth = count > 1 ? BASE_WIDTH + (count - 1) * EXTRA_WIDTH_PER_LINK : style.width;
  line.setAttribute('stroke', style.color);
  line.setAttribute('stroke-width', String(lineWidth));
  line.setAttribute('stroke-dasharray', style.dash);
  line.setAttribute('stroke-opacity', '0.75');
  line.dataset['links'] = entry.links.map((l) => l.link_id).join(',');

  line.addEventListener('mouseenter', (event) => void showLineTooltip(entry, event));
  line.addEventListener('mousemove', moveTooltip);
  line.addEventListener('mouseleave', hideLinkTooltip);
  line.addEventListener('click', (event) => void onLineClick(entry, event));
  svg.append(line);

  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;

  if (count > 1) {
    // Bundle badge with the number of links.
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
  const label = entry.links[0];
  const type = store.state.linkTypes.find((t) => t.id === label?.link_type_id);
  if (label !== undefined && type !== undefined) {
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

/** Stroke styling for an entry (same type for all links, else default). */
function linkStyle(entry: ZoneEntry): { color: string; width: number; dash: string } {
  const types = new Set(entry.links.map((l) => l.link_type_id));
  if (types.size === 1) {
    const typeId = entry.links[0]?.link_type_id ?? null;
    const type: LinkType | undefined =
      typeId !== null ? store.state.linkTypes.find((t) => t.id === typeId) : undefined;
    if (type !== undefined) {
      return {
        color: type.color ?? DEFAULT_COLOR,
        width: type.width,
        dash: type.style === 'dashed' ? '6 4' : type.style === 'dotted' ? '2 4' : 'none',
      };
    }
  }
  return { color: DEFAULT_COLOR, width: BASE_WIDTH, dash: 'none' };
}

// ---------------------------------------------------------------------------
// Interaction: tooltip and click
// ---------------------------------------------------------------------------

/** Shows the hover tooltip with link names and counts. */
async function showLineTooltip(entry: ZoneEntry, event: MouseEvent): Promise<void> {
  hideLinkTooltip();
  tooltip = div('link-tooltip');
  const types = entry.links
    .map((l) => {
      const type = store.state.linkTypes.find((t) => t.id === l.link_type_id);
      return type === undefined ? 'без типа' : `${type.name_forward} / ${type.name_reverse}`;
    })
    .join(' · ');
  tooltip.append(el('div', 'link-tooltip-types', types));
  const counts = div('link-tooltip-counts faint');
  tooltip.append(counts);
  tooltip.style.left = `${event.clientX + TOOLTIP_OFFSET}px`;
  tooltip.style.top = `${event.clientY + TOOLTIP_OFFSET}px`;
  document.body.append(tooltip);
  void loadLinkCounts(entry, counts);
}

/** Follows the cursor while the tooltip is open. */
function moveTooltip(event: MouseEvent): void {
  if (tooltip !== null) {
    tooltip.style.left = `${event.clientX + TOOLTIP_OFFSET}px`;
    tooltip.style.top = `${event.clientY + TOOLTIP_OFFSET}px`;
  }
}

/** Lazily fetches comment/attachment counts for a link bundle. */
async function loadLinkCounts(entry: ZoneEntry, target: HTMLElement): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || entry.links.length !== 1) {
    target.textContent = `связей: ${entry.links.length}`;
    return;
  }
  const linkId = entry.links[0]?.link_id;
  if (linkId === undefined) return;
  let cached = linkCountsCache.get(linkId);
  if (cached === undefined) {
    try {
      const [comments, attachments] = await Promise.all([
        etn.comments.list(networkId, 'link', linkId),
        etn.attachments.list(networkId, 'link', linkId),
      ]);
      cached = { comments: comments.length, attachments: attachments.length };
      linkCountsCache.set(linkId, cached);
    } catch {
      cached = { comments: 0, attachments: 0 };
    }
  }
  if (tooltip === null) return;
  target.textContent = `📝 ${cached.comments} · 📎 ${cached.attachments}`;
}

/** Click on a line: single link → editor; bundle → picker menu. */
async function onLineClick(entry: ZoneEntry, event: MouseEvent): Promise<void> {
  if (entry.links.length === 1) {
    const linkId = entry.links[0]?.link_id;
    if (linkId === undefined || opener === null) return;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    try {
      const link = await etn.links.get(networkId, linkId);
      opener(link);
    } catch {
      // The link disappeared concurrently — the realtime refresh will redraw.
    }
    return;
  }
  // Multiple links: let the user pick one.
  const items: MenuItem[] = entry.links.map((l) => {
    const type = store.state.linkTypes.find((t) => t.id === l.link_type_id);
    return {
      label: type?.name_forward ?? 'Связь без типа',
      onClick: () => {
        void (async () => {
          if (opener === null) return;
          const networkId = store.state.networkId;
          if (networkId === null) return;
          try {
            const link = await etn.links.get(networkId, l.link_id);
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

/** Test seam. */
export const linksInternals = { ellipsePoint, linkStyle };
