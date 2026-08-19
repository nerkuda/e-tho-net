/**
 * Draggable splitter between the selection panel and the canvas (08-ui-spec.md
 * §5). Mirrors the editor resizer: dragging updates the `--selection-w` CSS
 * variable on the workspace body and the store, so the panel (its flex-basis)
 * and the canvas resize live. The new width is persisted to the L4
 * `window_layout` ui_state via the shared debounced writer (see
 * `editor-resizer.ts`), so it survives restarts alongside the editor sizes.
 */

import { SELECTION_W_MAX, SELECTION_W_MIN } from '@etn/shared';
import { store } from '../state.js';
import { scheduleLayoutPersist } from './editor-resizer.js';

/** Minimum canvas width preserved when the panel is dragged to its largest. */
const MIN_CANVAS_W = 200;

/**
 * Wires the resizer element: `pointerdown` starts a horizontal drag; moving
 * the pointer resizes the panel (the canvas takes the rest). No-op while the
 * panel is hidden (the element is hidden along with it).
 */
export function mountSelectionResizer(resizer: HTMLElement, body: HTMLElement): void {
  resizer.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;

    const startSize = store.state.selectionW;
    const startX = event.clientX;
    // Keep at least `MIN_CANVAS_W` for the canvas; never below the panel min.
    const max = Math.min(
      SELECTION_W_MAX,
      Math.max(SELECTION_W_MIN + 1, body.clientWidth - MIN_CANVAS_W),
    );

    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
    body.classList.add('resizing');

    const onMove = (ev: PointerEvent): void => {
      const raw = startSize + (ev.clientX - startX);
      const size = Math.round(Math.min(max, Math.max(SELECTION_W_MIN, raw)));
      body.style.setProperty('--selection-w', `${size}px`);
      store.update({ selectionW: size });
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
      body.classList.remove('resizing');
    };

    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
  });
}
