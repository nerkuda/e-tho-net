/**
 * Keyboard navigation over the «Структуры мыслей» results tree (L15,
 * 08-ui-spec.md §15.10).
 *
 * The tree behaves like a folder tree in Explorer (every node may have
 * several parents), so the cursor walks the rows **sequentially** — the flat
 * visual order of the rendered tree — instead of spatially:
 *
 * - `ArrowUp`/`ArrowDown` (and `Tab`/`Shift+Tab`) move to the previous/next
 *   visible row, following the tree order exactly like Explorer;
 * - `ArrowRight` expands the children of the cursor row (when it has any and
 *   they are collapsed); otherwise it steps to the next row;
 * - `ArrowLeft` collapses the children, else the parents, of the cursor row;
 *   otherwise it steps to the previous row;
 * - `Ctrl+ArrowUp`/`Ctrl+ArrowDown` toggle the parents/children expansion of
 *   the cursor row (same as clicking its top/bottom ellipse);
 * - `Home`/`End` jump to the first/last visible row;
 * - `Enter` opens the cursor thought in the editor (same as a click);
 * - `Escape` drops the cursor frame.
 *
 * There is no manual order and no separate "focus" thought in this view, so
 * `Ctrl+Shift+Up/Down` and `Ctrl+Enter` (canvas-only) are not wired here.
 */

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

/** One navigable tree row. */
interface NavRow {
  rowEl: HTMLElement;
  cloud: HTMLElement;
  id: string;
  key: string;
  rootId: string;
}

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
      step(event.shiftKey ? -1 : 1);
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
        step(-1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        stepRight();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        stepLeft();
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
  navRowOf(cursorId)?.cloud.classList.add(CURSOR_CLS);
}

/** All rows in the flat visual (DOM) order — the sequential walk order. */
function navRows(): NavRow[] {
  if (hostEl === null) return [];
  const out: NavRow[] = [];
  for (const rowEl of hostEl.querySelectorAll<HTMLElement>('.st-row')) {
    const cloud = rowEl.querySelector<HTMLElement>('.st-cloud.cloud');
    const id = cloud?.dataset['id'];
    const key = rowEl.dataset['key'];
    const rootId = rowEl.dataset['root'];
    if (cloud === null || id === undefined || key === undefined || rootId === undefined) continue;
    out.push({ rowEl, cloud, id, key, rootId });
  }
  return out;
}

function navRowOf(id: string): NavRow | null {
  return navRows().find((r) => r.id === id) ?? null;
}

function setCursor(id: string | null): void {
  cursorId = id;
  syncStructuresCursor();
}

/** Up/Down (and Tab/Shift+Tab): one row back/forward in the flat tree order.
 *  The first press with no cursor lands on the first row. */
function step(delta: -1 | 1): void {
  const rows = navRows();
  if (rows.length === 0) return;
  if (cursorId === null) {
    const first = rows[0];
    if (first === undefined) return;
    setCursor(first.id);
    first.cloud.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const index = rows.findIndex((r) => r.id === cursorId);
  if (index === -1) {
    setCursor(null);
    return;
  }
  const target = rows[index + delta];
  if (target === undefined) return;
  setCursor(target.id);
  target.cloud.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Explorer ArrowRight: expand children when possible, else step forward. */
function stepRight(): void {
  const rows = navRows();
  if (rows.length === 0) return;
  if (cursorId === null) {
    const first = rows[0];
    if (first !== undefined) {
      setCursor(first.id);
      first.cloud.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return;
  }
  const current = navRowOf(cursorId);
  if (current !== null && canExpand(current, 'children')) {
    callbacks?.toggleExpand(current.key, current.id, current.rootId, 'children');
    return;
  }
  step(1);
}

/** Explorer ArrowLeft: collapse children, then parents; else step backward. */
function stepLeft(): void {
  const current = cursorId === null ? null : navRowOf(cursorId);
  if (current !== null && isExpanded(current, 'children')) {
    callbacks?.toggleExpand(current.key, current.id, current.rootId, 'children');
    return;
  }
  if (current !== null && isExpanded(current, 'parents')) {
    callbacks?.toggleExpand(current.key, current.id, current.rootId, 'parents');
    return;
  }
  step(-1);
}

/** Home/End: first/last row of the flat tree order. */
function jumpToEdge(toStart: boolean): void {
  const rows = navRows();
  const target = toStart ? rows[0] : rows[rows.length - 1];
  if (target === undefined) return;
  setCursor(target.id);
  target.cloud.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Ctrl+Up/Down: toggle the cursor thought's parents/children expansion. */
function toggleCursorExpansion(dir: 'parents' | 'children'): void {
  if (cursorId === null || callbacks === null) return;
  const current = navRowOf(cursorId);
  if (current === null) return;
  callbacks.toggleExpand(current.key, current.id, current.rootId, dir);
}

/** True when the direction's ellipse is filled (neighbors exist) — `filled`. */
function canExpand(row: NavRow, dir: 'parents' | 'children'): boolean {
  const ellipse =
    dir === 'children'
      ? row.cloud.querySelector<HTMLElement>('.ellipse-bottom')
      : row.cloud.querySelector<HTMLElement>('.ellipse-top');
  return ellipse?.classList.contains('filled') === true && !isExpanded(row, dir);
}

/** True when the direction is currently expanded (`.st-expanded` on the ellipse). */
function isExpanded(row: NavRow, dir: 'parents' | 'children'): boolean {
  const ellipse =
    dir === 'children'
      ? row.cloud.querySelector<HTMLElement>('.ellipse-bottom')
      : row.cloud.querySelector<HTMLElement>('.ellipse-top');
  return ellipse?.classList.contains('st-expanded') === true;
}
