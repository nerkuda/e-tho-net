/**
 * Draggable splitter between the history strip and the status-bar event area
 * (08-ui-spec.md §11). The resizer is a 6 px column absolutely positioned on
 * the seam; dragging it resizes the right-most status-bar region (counts +
 * last realtime event text) by updating the `--event-area-w` CSS variable on
 * the status bar, and the history strip takes the remaining space.
 *
 * The new size is written to the store at once (so the history strip's
 * ResizeObserver re-flows the visible chips without further work) and
 * persisted to the L4 `window_layout` ui_state, debounced — the same timer
 * as the editor/selection resizers, so all three never overwrite each other.
 *
 * Width bounds (08-ui-spec §11): `[EVENT_AREA_W_MIN, 30 % of the client
 * window width]`. The upper bound is recomputed on every drag tick so a
 * window resize between drags is respected.
 *
 * The pointer-drag lifecycle is the shared `lib/ui/splitter` component
 * (задача 50f57b82).
 */

import { EVENT_AREA_W_MAX_RATIO, EVENT_AREA_W_MIN } from '@etn/shared';

import { wireSplitter } from '../lib/ui/splitter.js';
import { store } from '../state.js';
import { scheduleLayoutPersist } from './editor-resizer.js';

/** Width of the splitter hit area, px. */
const HIT_W = 6;
/** Minimum left-over width for the history strip, px. The drag stops here
 *  even if the upper bound would allow a wider event area. */
const MIN_HISTORY_W = 80;

/**
 * Wires the resizer element: dragging the seam left grows the event area (the
 * history strip takes the rest). The status-bar element is needed to read its
 * width for the upper-bound clamp.
 */
export function mountEventAreaResizer(resizer: HTMLElement, statusbar: HTMLElement): void {
  let startBarWidth = 0;

  wireSplitter(resizer, {
    stateHost: () => statusbar,
    stateClass: 'resizing',
    plan: () => {
      startBarWidth = statusbar.clientWidth;
      const ratioCap = Math.floor(
        Math.max(EVENT_AREA_W_MIN, startBarWidth * EVENT_AREA_W_MAX_RATIO),
      );
      // The history strip must keep at least MIN_HISTORY_W so the chips
      // always have somewhere to live; otherwise the splitter cannot move
      // further, regardless of the ratio cap.
      const historyCap = Math.max(EVENT_AREA_W_MIN, startBarWidth - MIN_HISTORY_W - HIT_W);
      return {
        // The user drags the splitter left → event area grows → positive delta.
        axis: 'x',
        sign: -1,
        start: store.state.eventAreaW,
        min: EVENT_AREA_W_MIN,
        max: Math.min(ratioCap, historyCap),
      };
    },
    apply: (size) => {
      store.update({ eventAreaW: size });
      statusbar.style.setProperty('--event-area-w', `${size}px`);
      scheduleLayoutPersist();
    },
  });
}
