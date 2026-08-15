/**
 * Canvas zoom control (08-ui-spec.md §2.2.1, §13; workplan L9).
 *
 * `Ctrl+=`/`Ctrl+-` step the zoom along the 5% grid (100 → 105 → 110 …),
 * `Ctrl+0` resets to 100%. The store patch triggers the regular canvas
 * re-render (the `--cloud-*`/`--link-label-font` variables and the zone grids
 * all derive from `canvasZoom`), and the value is persisted to the L4
 * `canvas_zoom` ui_state, debounced.
 */

import { CANVAS_ZOOM_DEFAULT, UI_STATE_KEY } from '@etn/shared';
import { etn } from '../lib/etn.js';
import { zoomStep } from '../lib/pure.js';
import { store } from '../state.js';

/** Debounce for persisting the zoom after a key press, ms. */
const PERSIST_DEBOUNCE_MS = 400;

let persistTimer: number | null = null;

/** Schedules a debounced persist of the canvas zoom to the L4 ui_state. */
function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    void etn.ui
      .setState(networkId, UI_STATE_KEY.CANVAS_ZOOM, String(store.state.canvasZoom))
      .catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
}

/** Applies one zoom action: step in, step out or reset to 100%. */
export function applyCanvasZoom(direction: 'in' | 'out' | 'reset'): void {
  const next =
    direction === 'reset'
      ? CANVAS_ZOOM_DEFAULT
      : zoomStep(store.state.canvasZoom, direction === 'in' ? 1 : -1);
  if (next === store.state.canvasZoom) return;
  store.update({ canvasZoom: next });
  schedulePersist();
}
