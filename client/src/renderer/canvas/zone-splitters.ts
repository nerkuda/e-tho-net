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
 *
 * The pointer-drag lifecycle is the shared `lib/ui/splitter` component
 * (задача 50f57b82); these two splitters differ from the panel resizers in
 * that their metric is a share of the zone (0..1), not pixels.
 */

import {
  CANVAS_CHILDREN_SHARE_DEFAULT,
  CANVAS_TOP_SPLIT_DEFAULT,
  UI_STATE_KEY,
} from '@etn/shared';
import { etn } from '../lib/etn.js';
import { wireSplitter } from '../lib/ui/splitter.js';
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
  /**
   * Optional: re-anchor canvas decorations whose position depends on the
   * layout (the focus band, L12). Called after every live share change so
   * they follow the drag instead of jumping on release.
   */
  onLayoutChange?: () => void;
}

/** Rounds a share to 3 decimals — keeps stored values and CSS vars tidy. */
function roundShare(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Wires the vertical splitter: divides the top strip width between zones. */
function wireVerticalSplitter(hooks: ZoneSplitterHooks): void {
  wireSplitter(hooks.vertical, {
    stateHost: () => document.body,
    stateClass: 'resizing-v',
    plan: () => {
      const rect = hooks.top.getBoundingClientRect();
      if (rect.width <= 0) return null;
      // Keep at least MIN_ZONE_PX on each side of the strip.
      const minShare = MIN_ZONE_PX / rect.width;
      return {
        axis: 'x',
        start: store.state.zoneTopSplit,
        min: minShare,
        max: 1 - minShare,
        round: roundShare,
      };
    },
    resolve: (event) => {
      const rect = hooks.top.getBoundingClientRect();
      if (rect.width <= 0) return store.state.zoneTopSplit;
      return (event.clientX - rect.left) / rect.width;
    },
    apply: (share) => {
      hooks.host.style.setProperty('--zone-top-split', String(share));
      hooks.onLayoutChange?.();
    },
    commit: (share) => {
      store.update({ zoneTopSplit: share });
      schedulePersist();
    },
  });
  hooks.vertical.addEventListener('dblclick', () => {
    hooks.host.style.setProperty('--zone-top-split', String(CANVAS_TOP_SPLIT_DEFAULT));
    hooks.onLayoutChange?.();
    store.update({ zoneTopSplit: CANVAS_TOP_SPLIT_DEFAULT });
    schedulePersist();
  });
}

/** Wires the horizontal splitter: divides the height between the top strip
 *  (plus the focus row, whose height never changes) and the children zone. */
function wireHorizontalSplitter(hooks: ZoneSplitterHooks): void {
  wireSplitter(hooks.horizontal, {
    stateHost: () => document.body,
    stateClass: 'resizing-h',
    plan: () => {
      const hostRect = hooks.host.getBoundingClientRect();
      const focusH = hooks.focusRow.getBoundingClientRect().height;
      if (hostRect.height <= 0) return null;
      // The children zone is what remains below the (fixed-height) focus row;
      // the top zones keep at least MIN_ZONE_PX above it.
      const maxH = hostRect.height - focusH - MIN_ZONE_PX;
      if (maxH < MIN_ZONE_PX) return null;
      return {
        axis: 'y',
        start: store.state.zoneChildrenShare * hostRect.height,
        min: MIN_ZONE_PX,
        max: maxH,
        // The metric is a px height; the share is computed in apply/commit.
        round: (value) => value,
      };
    },
    resolve: (event) => {
      const hostRect = hooks.host.getBoundingClientRect();
      return hostRect.bottom - event.clientY;
    },
    apply: (height) => {
      const hostRect = hooks.host.getBoundingClientRect();
      if (hostRect.height <= 0) return;
      hooks.host.style.setProperty('--zone-children-share', String(roundShare(height / hostRect.height)));
      hooks.onLayoutChange?.();
    },
    commit: (height) => {
      const hostRect = hooks.host.getBoundingClientRect();
      if (hostRect.height <= 0) return;
      store.update({ zoneChildrenShare: roundShare(height / hostRect.height) });
      schedulePersist();
    },
  });
  hooks.horizontal.addEventListener('dblclick', () => {
    hooks.host.style.setProperty('--zone-children-share', String(CANVAS_CHILDREN_SHARE_DEFAULT));
    hooks.onLayoutChange?.();
    store.update({ zoneChildrenShare: CANVAS_CHILDREN_SHARE_DEFAULT });
    schedulePersist();
  });
}

/**
 * Mounts both zone splitters: applies the stored shares as CSS variables and
 * wires dragging/double-click-reset. Called once by `mountCanvas`. Returns a
 * teardown handle that releases the store subscription (ошибка 37b713de).
 */
export function mountZoneSplitters(hooks: ZoneSplitterHooks): () => void {
  applyCanvasLayoutVars(hooks.host);
  wireVerticalSplitter(hooks);
  wireHorizontalSplitter(hooks);
  // openNetwork() pushes new shares into the store when a network opens.
  const unsubscribe = store.subscribe(() => {
    if (hooks.host.isConnected) applyCanvasLayoutVars(hooks.host);
  });
  return () => {
    unsubscribe();
  };
}
