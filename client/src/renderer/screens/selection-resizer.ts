/**
 * Draggable splitter between the selection panel and the canvas (08-ui-spec.md
 * §5). Mirrors the editor resizer: dragging updates the `--selection-w` CSS
 * variable on the workspace body and the store, so the panel (its flex-basis)
 * and the canvas resize live. The new width is persisted to the L4
 * `window_layout` ui_state via the shared debounced writer (see
 * `editor-resizer.ts`), so it survives restarts alongside the editor sizes.
 *
 * The pointer-drag lifecycle is the shared `lib/ui/splitter` component
 * (задача 50f57b82).
 */

import { SELECTION_W_MAX, SELECTION_W_MIN } from '@etn/shared';
import { t } from '../lib/i18n.js';
import { wireSplitter } from '../lib/ui/splitter.js';
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
  wireSplitter(resizer, {
    stateHost: () => body,
    stateClass: 'resizing',
    title: t('splitter.resizeHint'),
    ariaLabel: t('splitter.resizeAriaHorizontal'),
    plan: () => {
      // Keep at least `MIN_CANVAS_W` for the canvas; never below the panel min.
      const max = Math.min(
        SELECTION_W_MAX,
        Math.max(SELECTION_W_MIN + 1, body.clientWidth - MIN_CANVAS_W),
      );
      return {
        axis: 'x',
        start: store.state.selectionW,
        min: SELECTION_W_MIN,
        max,
      };
    },
    apply: (size) => {
      body.style.setProperty('--selection-w', `${size}px`);
      store.update({ selectionW: size });
      scheduleLayoutPersist();
    },
  });
}
