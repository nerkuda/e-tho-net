/**
 * Keyboard navigation over the «Структуры мыслей» results tree (L15,
 * 08-ui-spec.md §15.10) — the same spatial-cursor principle as the canvas
 * (§2.9, `canvas/kbd-nav.ts`), minus the parts that don't apply to a tree
 * without zones/manual order/a single focus cloud:
 *
 * - arrow keys / Tab / Shift+Tab move a dashed cursor frame to the nearest
 *   rendered cloud in that direction (the results tree is never virtualized,
 *   so every cloud is always in the DOM — no zone-scroll retry needed);
 * - `Home`/`End` jump to the first/last rendered cloud;
 * - `Enter` opens the cursor thought in the editor (same as a click);
 * - `Ctrl+Up`/`Ctrl+Down` toggle the parents/children expansion of the
 *   cursor thought (same as clicking its top/bottom ellipse);
 * - `Escape` drops the cursor frame.
 *
 * There is no manual order and no separate "focus" thought in this view, so
 * `Ctrl+Shift+Up/Down` and `Ctrl+Enter` (canvas-only) are not wired here.
 */

import { pickSpatialCandidate, type CloudBox } from '../../canvas/kbd-nav.js';
import { store } from '../../state.js';

/** Frame class applied to the cloud under the keyboard cursor (shared with the canvas). */
const CURSOR_CLS = 'kbd-cursor';

let hostEl: HTMLElement | null = null;
/** Thought id under the keyboard cursor; null — no cursor (starts on the first arrow press). */
let cursorId: string | null = null;

/** Callbacks into the host module (structures.ts). */
export interface StructuresKbdNavCallbacks {
  openThought(id: string): void;
  toggleExpand(key: string, thoughtId: string, rootId: string, dir: 'parents' | 'children'): void;
}

let callbacks: StructuresKbdNavCallbacks | null = null;

/** Wires the keyboard navigation onto the results host. */
export function initStructuresKbdNav(host: HTMLElement, cb: StructuresKbdNavCallbacks): void {
  hostEl = host;
  callbacks = cb;
  host.tabIndex = 0;

  host.addEventListener('click', (event) => {
    const cloud = (event.target as HTMLElement).closest<HTMLElement>('.st-cloud.cloud');
    const id = cloud?.dataset['id'];
    if (id !== undefined) setCursor(id);
  });

  host.addEventListener('keydown', (event) => {
    if (store.state.activeView !== 'structures') return;
    if (event.key === 'Tab') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1, 0);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        toggleCursorExpansion('parents');
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        toggleCursorExpansion('children');
        return;
      }
      return; // other Ctrl-combos keep their global handlers
    }
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        step(0, -1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        step(0, 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        step(-1, 0);
        break;
      case 'ArrowRight':
        event.preventDefault();
        step(1, 0);
        break;
      case 'Home':
        event.preventDefault();
        jumpToEdge(true);
        break;
      case 'End':
        event.preventDefault();
        jumpToEdge(false);
        break;
      case 'Enter':
        event.preventDefault();
        if (cursorId !== null) callbacks?.openThought(cursorId);
        break;
      case 'Escape':
        setCursor(null);
        break;
      default:
        break;
    }
  });
}

/** Drops the cursor (new query, network switch — the old cloud may be gone). */
export function resetStructuresCursor(): void {
  setCursor(null);
}

/** Re-applies the cursor frame after a full tree rebuild (renderTree() clears the DOM). */
export function syncStructuresCursor(): void {
  if (hostEl === null) return;
  for (const el of hostEl.querySelectorAll<HTMLElement>(`.${CURSOR_CLS}`)) {
    el.classList.remove(CURSOR_CLS);
  }
  if (cursorId === null) return;
  cloudEl(cursorId)?.classList.add(CURSOR_CLS);
}

function cloudEl(id: string): HTMLElement | null {
  if (hostEl === null) return null;
  return hostEl.querySelector<HTMLElement>(`.st-cloud.cloud[data-id="${CSS.escape(id)}"]`);
}

function visibleClouds(): HTMLElement[] {
  if (hostEl === null) return [];
  return [...hostEl.querySelectorAll<HTMLElement>('.st-cloud.cloud')];
}

function boxOf(el: HTMLElement): CloudBox {
  const r = el.getBoundingClientRect();
  const id = el.dataset['id'];
  return { id: id === undefined ? '' : id, x: r.left, y: r.top, w: r.width, h: r.height };
}

function setCursor(id: string | null): void {
  cursorId = id;
  syncStructuresCursor();
}

/** One arrow/Tab step: nearest cloud in the direction; the first press with no
 *  cursor lands on the first rendered cloud (§15.10). */
function step(dx: -1 | 0 | 1, dy: -1 | 0 | 1): void {
  if (cursorId === null) {
    const first = visibleClouds()[0];
    const id = first?.dataset['id'];
    if (id === undefined) return;
    setCursor(id);
    first?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const originEl = cloudEl(cursorId);
  if (originEl === null) {
    setCursor(null);
    return;
  }
  const clouds = visibleClouds();
  const next = pickSpatialCandidate(clouds.map(boxOf), boxOf(originEl), dx, dy);
  if (next === null) return;
  const el = cloudEl(next.id);
  if (el === null) return;
  setCursor(next.id);
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Home/End: first/last rendered cloud (no zones to scroll to an edge here). */
function jumpToEdge(toStart: boolean): void {
  const clouds = visibleClouds();
  const el = toStart ? clouds[0] : clouds[clouds.length - 1];
  const id = el?.dataset['id'];
  if (id === undefined) return;
  setCursor(id);
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Ctrl+Up/Down: toggle the cursor thought's parents/children expansion. */
function toggleCursorExpansion(dir: 'parents' | 'children'): void {
  if (cursorId === null || callbacks === null) return;
  const rowEl = cloudEl(cursorId)?.closest<HTMLElement>('.st-row');
  const key = rowEl?.dataset['key'];
  const rootId = rowEl?.dataset['root'];
  if (key === undefined || rootId === undefined) return;
  callbacks.toggleExpand(key, cursorId, rootId, dir);
}
