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
 */

import { EVENT_AREA_W_MAX_RATIO, EVENT_AREA_W_MIN } from '@etn/shared';

import { scheduleLayoutPersist } from './editor-resizer.js';
import { clampEventAreaW } from '../lib/pure.js';
import { store } from '../state.js';
import { invalidateHistoryBar } from './history-bar.js';

/** Width of the splitter hit area, px. */
const HIT_W = 6;
/** Minimum left-over width for the history strip, px. The drag stops here
 *  even if the upper bound would allow a wider event area. */
const MIN_HISTORY_W = 80;

interface DragPlan {
  /** Event-area width at drag start, px. */
  startSize: number;
  /** Pointer position at drag start, px. */
  startX: number;
  /** Status-bar width at drag start, px. */
  startBarWidth: number;
}

/**
 * Wires the resizer element: `pointerdown` starts a drag, moving the pointer
 * resizes the event area (the history strip takes the rest). The status-bar
 * element is needed to read its current width for the upper-bound clamp.
 */
export function mountEventAreaResizer(resizer: HTMLElement, statusbar: HTMLElement): void {
  resizer.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;

    const plan: DragPlan = {
      startSize: store.state.eventAreaW,
      startX: event.clientX,
      startBarWidth: statusbar.clientWidth,
    };

    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
    statusbar.classList.add('resizing');

    const onMove = (ev: PointerEvent): void => {
      // The user drags the splitter left → event area grows → positive delta.
      const delta = plan.startX - ev.clientX;
      const ratioCap = Math.floor(
        Math.max(EVENT_AREA_W_MIN, plan.startBarWidth * EVENT_AREA_W_MAX_RATIO),
      );
      // The history strip must keep at least MIN_HISTORY_W so the chips
      // always have somewhere to live; otherwise the splitter cannot move
      // further, regardless of the ratio cap.
      const historyCap = Math.max(
        EVENT_AREA_W_MIN,
        plan.startBarWidth - MIN_HISTORY_W - HIT_W,
      );
      const max = Math.min(ratioCap, historyCap);
      const raw = plan.startSize + delta;
      const size = clampEventAreaW(raw, plan.startBarWidth);
      const clamped = Math.min(size, max);
      store.update({ eventAreaW: clamped });
      statusbar.style.setProperty('--event-area-w', `${clamped}px`);
      scheduleLayoutPersist();
    };
    const onUp = (ev: PointerEvent): void => {
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onUp);
      resizer.removeEventListener('pointercancel', onUp);
      try {
        resizer.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released — ignore */
      }
      resizer.classList.remove('dragging');
      statusbar.classList.remove('resizing');
      // After the drag the history strip has a new free width: poke the
      // history bar so it reflows the visible chips even if the host's
      // ResizeObserver missed the transition (e.g. observe() started before
      // the host was in the DOM, or the strip's first width assignment
      // landed in the same layout frame as the initial setProperty). Bug
      // 3ccacc1c-… («Мысли истории не отображаются в нижней панели»).
      invalidateHistoryBar();
    };

    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
  });
}
