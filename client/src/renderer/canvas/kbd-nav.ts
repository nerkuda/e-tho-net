/**
 * Keyboard navigation over the thought map (08-ui-spec.md §2.9): while the
 * keyboard focus is inside the canvas host,
 *
 * - arrow keys move a dashed cursor frame from cloud to cloud (spatial
 *   nearest-in-direction over the rendered clouds, including the focus cloud);
 *   when the frame's zone can scroll further in the arrow direction, the zone
 *   scrolls and the step retries against the freshly virtualized window;
 * - `Home`/`End` jump to the first/last cloud of the cursor's zone (from the
 *   focus cloud — of the first/last non-empty zone of the map), scrolling the
 *   virtualized zone to its edge;
 * - `Enter` acts as a single click (open in the editor + halo),
 *   `Ctrl+Enter` focuses the cursor thought;
 * - `Ctrl+Shift+Up`/`Down` move the cursor thought one slot up/down inside its
 *   zone — only while that zone is sorted `manual` (same action as the
 *   Ctrl+Shift cloud drag, drag-cloud.ts `reorderZone`);
 * - `Escape` drops the cursor frame.
 *
 * The cursor is a module-local id; the frame class is re-applied by
 * {@link syncCanvasCursor} after every canvas/zone re-render (virtualization
 * rebuilds the clouds), and the cursor resets when the focus changes.
 */

import { setFocus } from '../app.js';
import { openThoughtInEditor } from '../editor/editor.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';
import { reorderZone } from './drag-cloud.js';

/** Frame class applied to the cloud under the keyboard cursor. */
const CURSOR_CLS = 'kbd-cursor';

/** Minimal forward projection, px — clouds closer than this are not targets. */
const FORWARD_EPS_PX = 2;
/** Penalty weight of the lateral offset against the forward distance. */
const LATERAL_WEIGHT = 2.5;
/** Share of the zone viewport scrolled when the arrow runs past the window. */
const ZONE_SCROLL_SHARE = 0.8;

/** Axis-aligned cloud rectangle (viewport coordinates) with its thought id. */
export interface CloudBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Picks the best cloud to move to from `current` in the unit direction
 * `(dx, dy)` (one of the four arrows): among the clouds projected forward onto
 * the direction, the score favours a small lateral offset — a cloud aligned
 * with the current one wins over a diagonally placed closer one. Returns null
 * when no cloud lies in the direction.
 */
export function pickSpatialCandidate(
  boxes: CloudBox[],
  current: CloudBox,
  dx: -1 | 0 | 1,
  dy: -1 | 0 | 1,
): CloudBox | null {
  const cx = current.x + current.w / 2;
  const cy = current.y + current.h / 2;
  let best: CloudBox | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    if (box.id === current.id) continue;
    const vx = box.x + box.w / 2 - cx;
    const vy = box.y + box.h / 2 - cy;
    const forward = vx * dx + vy * dy;
    if (forward <= FORWARD_EPS_PX) continue;
    const lateral = Math.abs(vx * dy - vy * dx);
    const score = forward + lateral * LATERAL_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = box;
    }
  }
  return best;
}

let hostEl: HTMLElement | null = null;
/** Thought id under the keyboard cursor; null — no cursor (starts at focus). */
let cursorId: string | null = null;

/** Wires the keyboard navigation onto the canvas host. */
export function initKbdNav(host: HTMLElement): void {
  hostEl = host;
  // The keyboard navigation is active while the focus is inside the host.
  // Plain mouse presses keep the focus on the host itself: without
  // preventDefault the browser would move it onto the pressed cloud (its
  // tabIndex), and the next zone re-render destroys that element — the focus
  // fell out of the canvas and the arrows stopped working.
  host.tabIndex = 0;
  host.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    host.focus({ preventScroll: true });
  });
  host.addEventListener('keydown', (event) => {
    if (store.state.activeView !== 'map') return;
    // Tab walks the same cursor as the arrows (DOM tab order would highlight
    // a different cloud — the virtualization's slot order, not the visual one).
    if (event.key === 'Tab') {
      event.preventDefault();
      void step(event.shiftKey ? -1 : 1, 0, true);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'Enter') {
        event.preventDefault();
        focusCursor();
        return;
      }
      if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        void reorderCursor(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      return; // other Ctrl-combos (zoom, search) keep their global handlers
    }
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        void step(0, -1, true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        void step(0, 1, true);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        void step(-1, 0, true);
        break;
      case 'ArrowRight':
        event.preventDefault();
        void step(1, 0, true);
        break;
      case 'Home':
        event.preventDefault();
        void jumpToEdge(true);
        break;
      case 'End':
        event.preventDefault();
        void jumpToEdge(false);
        break;
      case 'Enter':
        event.preventDefault();
        openCursorInEditor();
        break;
      case 'Escape':
        setCursor(null);
        break;
      default:
        break;
    }
  });
}

/** Drops the cursor (focus change, network reset — the old cloud may be gone). */
export function resetCanvasCursor(): void {
  setCursor(null);
}

/**
 * Returns the thought id under the dashed cursor frame on the canvas, or null
 * when no cursor is active. Read by the global Ctrl+C/V handlers
 * (`app.ts:globalCopy`/`globalPaste`) so they target the cloud the user
 * actually clicked, not the editor focus — clicking a cloud moves the cursor
 * synchronously but the focus state only catches up when `setFocus` runs,
 * so `store.state.focus.focused.id` is stale by the time Ctrl+C/V fires.
 */
export function getCanvasCursor(): string | null {
  return cursorId;
}

/**
 * Re-applies the cursor frame after a re-render (the canvas rebuilds clouds on
 * every store change; virtualized zones rebuild them on scroll). A cursor
 * thought scrolled out of the virtualization window simply loses the frame
 * until it is visible again — the id stays, and a later step restarts from the
 * focus cloud when its cloud is gone from the DOM.
 */
export function syncCanvasCursor(): void {
  if (hostEl === null) return;
  for (const el of hostEl.querySelectorAll<HTMLElement>(`.${CURSOR_CLS}`)) {
    el.classList.remove(CURSOR_CLS);
  }
  if (cursorId === null) return;
  hostEl
    .querySelector<HTMLElement>(`.cloud[data-id="${CSS.escape(cursorId)}"]`)
    ?.classList.add(CURSOR_CLS);
  // A re-render may have destroyed the focused element (e.g. the browser had
  // focused a cloud that the virtualization rebuilt) — the focus fell onto
  // <body> and the keys stopped reaching the canvas. While the cursor is
  // active, pull the focus back to the host. An open menu/dialog/input keeps
  // its own focus (activeElement is not <body> there), so it is not touched.
  if (document.activeElement === null || document.activeElement === document.body) {
    hostEl.focus({ preventScroll: true });
  }
}

/** Live cloud of a thought (null when it is outside the virtualization window
 *  or not on the map). Ghosts of the focus transition are skipped. */
function cloudEl(id: string): HTMLElement | null {
  if (hostEl === null) return null;
  const el = hostEl.querySelector<HTMLElement>(`.cloud[data-id="${CSS.escape(id)}"]`);
  if (el === null) return null;
  return el.closest('.cloud-ghosts') !== null ? null : el;
}

/** All rendered clouds of the map (focus + zone windows), ghosts excluded. */
function visibleClouds(): HTMLElement[] {
  if (hostEl === null) return [];
  const out: HTMLElement[] = [];
  for (const el of hostEl.querySelectorAll<HTMLElement>('.cloud')) {
    if (el.closest('.cloud-ghosts') !== null) continue;
    out.push(el);
  }
  return out;
}

function boxOf(el: HTMLElement): CloudBox {
  const r = el.getBoundingClientRect();
  const id = el.dataset['id'];
  return { id: id === undefined ? '' : id, x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * Stores the cursor id and repaints the frame. Exported so cloud clicks can
 * set the cursor on the clicked thought (the halo and the cursor are two
 * independent visual states; both follow the click — see 08-ui-spec.md §2.2.4
 * and §2.9).
 */
export function setCursor(id: string | null): void {
  cursorId = id;
  syncCanvasCursor();
}

/** Resolves the step origin: the cursor cloud or, without a cursor / with the
 *  cursor cloud outside the DOM, the focus cloud (always rendered). */
function originBox(): CloudBox | null {
  const focusId = store.state.focus?.focused.id ?? null;
  if (cursorId !== null) {
    const el = cloudEl(cursorId);
    if (el !== null) return boxOf(el);
  }
  if (focusId === null) return null;
  const el = cloudEl(focusId);
  if (el === null) return null;
  if (cursorId !== null && cursorId !== focusId) {
    // The cursor thought left the DOM (scrolled out of the window, focus
    // changed under it) — restart from the focus cloud.
    cursorId = focusId;
    syncCanvasCursor();
  }
  return boxOf(el);
}

/** One arrow step: nearest cloud in the direction; past the zone's window the
 *  zone scrolls and the step retries once against the fresh DOM. */
async function step(dx: -1 | 0 | 1, dy: -1 | 0 | 1, retry: boolean): Promise<void> {
  const origin = originBox();
  if (origin === null) return;
  const clouds = visibleClouds();
  const next = pickSpatialCandidate(
    clouds.map(boxOf),
    origin,
    dx,
    dy,
  );
  if (next !== null) {
    const el = cloudEl(next.id);
    if (el === null) return;
    setCursor(next.id);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  if (!retry || dy === 0) return; // zones scroll vertically only
  // No cloud in the direction: maybe the cursor's zone has more rows past the
  // virtualization window — scroll it and retry once after the re-render.
  const originEl = cloudEl(origin.id);
  const zone = originEl?.closest<HTMLElement>('.zone') ?? null;
  if (zone === null || zone.dataset['dir'] === 'siblings') return;
  const delta = Math.round(zone.clientHeight * ZONE_SCROLL_SHARE) * dy;
  const before = zone.scrollTop;
  zone.scrollTop += delta;
  if (zone.scrollTop === before) return; // already at the edge
  await nextRender();
  await step(dx, dy, false);
}

/** Home/End: first/last cloud of the cursor's zone; from the focus cloud — of
 *  the first/last non-empty zone of the map. */
async function jumpToEdge(toStart: boolean): Promise<void> {
  const cursorEl = cursorId !== null ? cloudEl(cursorId) : null;
  const zone = cursorEl?.closest<HTMLElement>('.zone') ?? null;
  if (zone !== null) {
    await scrollZoneToEdge(zone, toStart);
    return;
  }
  const order = toStart
    ? (['parents', 'siblings', 'children'] as const)
    : (['children', 'siblings', 'parents'] as const);
  for (const dir of order) {
    const zoneEl = hostEl?.querySelector<HTMLElement>(`.zone-${dir}`) ?? null;
    if (zoneEl === null) continue;
    if (await scrollZoneToEdge(zoneEl, toStart)) return;
  }
}

/** Scrolls a zone to its edge and puts the cursor on its first/last rendered
 *  cloud. Returns false when the zone has no clouds at all. */
async function scrollZoneToEdge(zone: HTMLElement, toStart: boolean): Promise<boolean> {
  zone.scrollTop = toStart ? 0 : zone.scrollHeight;
  await nextRender();
  const clouds = [...zone.querySelectorAll<HTMLElement>('.cloud')].filter(
    (el) => el.closest('.cloud-ghosts') === null,
  );
  const el = toStart ? clouds[0] : clouds[clouds.length - 1];
  const id = el?.dataset['id'];
  if (el === undefined || id === undefined) return false;
  setCursor(id);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

/** Enter: same as a single click — open the cursor thought in the editor with
 *  its halo (editor.ts loads the entity); on the focus cloud this returns the
 *  editor to the focused thought. */
function openCursorInEditor(): void {
  const id = cursorId;
  if (id === null) return;
  openThoughtInEditor(id);
}

/** Ctrl+Enter: focus the cursor thought (same as a double click). */
function focusCursor(): void {
  const id = cursorId;
  if (id === null || id === store.state.focus?.focused.id) return;
  void setFocus(id);
}

/** Ctrl+Shift+Up/Down: move the cursor thought one slot inside its zone —
 *  only in the parents/children zones and only while sorted `manual`. */
async function reorderCursor(delta: -1 | 1): Promise<void> {
  const id = cursorId;
  if (id === null) return;
  const zone = cloudEl(id)?.closest<HTMLElement>('.zone') ?? null;
  const dir = zone?.dataset['dir'];
  if (dir !== 'parents' && dir !== 'children') return;
  if (store.state.zoneSorts[dir].sort !== 'manual') {
    notice('Упорядочивание работает при сортировке зоны «ручной» (правый клик по зоне → порядок).');
    return;
  }
  const order = store.state.zoneOrder[dir];
  const idx = order.indexOf(id);
  if (idx === -1) return;
  const target = idx + delta;
  if (target < 0 || target >= order.length) return;
  // The cursor stays on the thought: the frame re-applies after the refresh.
  await reorderZone(id, dir, target);
}

/** Waits until a scroll-triggered zone re-render (rAF of the scroll handler)
 *  has painted the fresh virtualization window. */
function nextRender(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}
