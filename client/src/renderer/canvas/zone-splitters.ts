/**
 * Draggable splitters between the canvas zones (08-ui-spec.md §2.1, workplan
 * L8).
 *
 * The vertical splitter sits between the parents and siblings zones inside
 * `.canvas-top`; the horizontal one sits between the focus row and the
 * children zone. The zones are flex items sized by the `--zone-top-split` /
 * `--zone-children-share` CSS variables on the canvas host, so a drag only
 * rewrites those variables — the per-zone ResizeObserver re-renders the
 * virtualized grids and the link overlay follows via its own observer. The
 * store is patched once on release, so a full canvas re-render happens exactly
 * once per gesture.
 *
 * The shares are persisted to the L4 `canvas_layout` ui_state, debounced.
 * Double click on a splitter resets its share to the default.
 */

import {
  CANVAS_CHILDREN_SHARE_DEFAULT,
  CANVAS_TOP_SPLIT_DEFAULT,
  UI_STATE_KEY,
} from '@etn/shared';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';

/** Minimum size guaranteed to every zone during a splitter drag, px. */
const MIN_ZONE_PX = 96;
/** Debounce for persisting the layout after a drag, ms. */
const PERSIST_DEBOUNCE_MS = 400;

let persistTimer: number | null = null;

/** Schedules a debounced persist of the zone shares to the L4 ui_state. */
function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    const payload = JSON.stringify({
      topSplit: store.state.zoneTopSplit,
      childrenShare: store.state.zoneChildrenShare,
    });
    void etn.ui.setState(networkId, UI_STATE_KEY.CANVAS_LAYOUT, payload).catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
}

/** Writes both zone-share CSS variables from the store onto the canvas host. */
export function applyCanvasLayoutVars(host: HTMLElement): void {
  host.style.setProperty('--zone-top-split', String(store.state.zoneTopSplit));
  host.style.setProperty('--zone-children-share', String(store.state.zoneChildrenShare));
}

/** Elements the splitters are wired against (all owned by `mountCanvas`). */
export interface ZoneSplitterHooks {
  /** The canvas host carrying the CSS variables. */
  host: HTMLElement;
  /** `.canvas-top` — the parents|siblings strip the vertical splitter divides. */
  top: HTMLElement;
  /** `.canvas-focus-row` — its height is preserved by the horizontal drag. */
  focusRow: HTMLElement;
  /** The vertical splitter element (between parents and siblings). */
  vertical: HTMLElement;
  /** The horizontal splitter element (between the focus row and children). */
  horizontal: HTMLElement;
}

/** Rounds a share to 3 decimals — keeps stored values and CSS vars tidy. */
function roundShare(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Shared pointer-drag skeleton: capture the pointer, call `move` with the
 * pointer position while dragging, then commit once on release.
 */
function wireDrag(
  splitter: HTMLElement,
  bodyClass: string,
  move: (clientX: number, clientY: number) => void,
  commit: () => void,
): void {
  splitter.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add(bodyClass);
    const onMove = (ev: PointerEvent): void => move(ev.clientX, ev.clientY);
    const onUp = (ev: PointerEvent): void => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      try {
        splitter.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released — ignore */
      }
      splitter.classList.remove('dragging');
      document.body.classList.remove(bodyClass);
      commit();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
  });
}

/** Wires the vertical splitter: divides the top strip width between zones. */
function wireVerticalSplitter(hooks: ZoneSplitterHooks): void {
  let share = store.state.zoneTopSplit;
  wireDrag(
    hooks.vertical,
    'resizing-v',
    (clientX) => {
      const rect = hooks.top.getBoundingClientRect();
      if (rect.width <= 0) return;
      // Keep at least MIN_ZONE_PX on each side of the strip.
      const minShare = MIN_ZONE_PX / rect.width;
      share = roundShare(Math.min(1 - minShare, Math.max(minShare, (clientX - rect.left) / rect.width)));
      hooks.host.style.setProperty('--zone-top-split', String(share));
    },
    () => {
      store.update({ zoneTopSplit: share });
      schedulePersist();
    },
  );
  hooks.vertical.addEventListener('dblclick', () => {
    share = CANVAS_TOP_SPLIT_DEFAULT;
    hooks.host.style.setProperty('--zone-top-split', String(share));
    store.update({ zoneTopSplit: share });
    schedulePersist();
  });
}

/** Wires the horizontal splitter: divides the height between the top strip
 *  (plus the focus row, whose height never changes) and the children zone. */
function wireHorizontalSplitter(hooks: ZoneSplitterHooks): void {
  let share = store.state.zoneChildrenShare;
  wireDrag(
    hooks.horizontal,
    'resizing-h',
    (_clientX, clientY) => {
      const hostRect = hooks.host.getBoundingClientRect();
      const focusH = hooks.focusRow.getBoundingClientRect().height;
      if (hostRect.height <= 0) return;
      // The children zone is what remains below the pointer; the top zones
      // keep at least MIN_ZONE_PX above the (fixed-height) focus row.
      const minH = MIN_ZONE_PX;
      const maxH = hostRect.height - focusH - MIN_ZONE_PX;
      if (maxH < minH) return;
      const h = Math.min(maxH, Math.max(minH, hostRect.bottom - clientY));
      share = roundShare(h / hostRect.height);
      hooks.host.style.setProperty('--zone-children-share', String(share));
    },
    () => {
      store.update({ zoneChildrenShare: share });
      schedulePersist();
    },
  );
  hooks.horizontal.addEventListener('dblclick', () => {
    share = CANVAS_CHILDREN_SHARE_DEFAULT;
    hooks.host.style.setProperty('--zone-children-share', String(share));
    store.update({ zoneChildrenShare: share });
    schedulePersist();
  });
}

/**
 * Mounts both zone splitters: applies the stored shares as CSS variables and
 * wires dragging/double-click-reset. Called once by `mountCanvas`.
 */
export function mountZoneSplitters(hooks: ZoneSplitterHooks): void {
  applyCanvasLayoutVars(hooks.host);
  wireVerticalSplitter(hooks);
  wireHorizontalSplitter(hooks);
  // openNetwork() pushes new shares into the store when a network opens.
  store.subscribe(() => {
    if (hooks.host.isConnected) applyCanvasLayoutVars(hooks.host);
  });
}
