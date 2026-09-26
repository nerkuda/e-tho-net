/**
 * Draggable splitter between the canvas and the editor panel (08-ui-spec.md
 * §6.1). The resizer element is absolutely positioned on the canvas/editor seam
 * (see `styles.css`); dragging it resizes the editor by updating the
 * `--editor-w` / `--editor-h` CSS variables on the workspace body, and the
 * canvas takes the remaining space.
 *
 * The new size is written to the store at once (so the editor/canvas relayout
 * immediately) and persisted to the L4 `window_layout` ui_state, debounced.
 * The selection-panel resizer shares this persistence (one timer, full
 * payload), so the two splitters never overwrite each other's sizes.
 */

import { EDITOR_H_MAX, EDITOR_H_MIN, EDITOR_W_MAX, EDITOR_W_MIN, UI_STATE_KEY } from '@etn/shared';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { wireSplitter, type SplitterPlan } from '../lib/ui/splitter.js';
import { store } from '../state.js';

/** Minimum canvas size preserved when the editor is dragged to its largest. */
const MIN_CANVAS_W = 200;
const MIN_CANVAS_H = 160;
/** Debounce for persisting the layout after a drag, ms. */
const PERSIST_DEBOUNCE_MS = 400;

let persistTimer: number | null = null;

/** Reads the active editor dock position off the workspace body's data attribute. */
function currentPosition(body: HTMLElement): string {
  return body.dataset['editorPos'] ?? 'right';
}

/**
 * Schedules a debounced persist of the current panel sizes (editor w/h, the
 * selection panel width, and the status-bar event-area width) to the L4
 * `window_layout` ui_state. Shared by the editor, selection-panel, and
 * event-area resizers — the full payload is read from the store at fire time,
 * so the last writer never loses the other panel's size.
 */
export function scheduleLayoutPersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    const payload = JSON.stringify({
      w: store.state.editorW,
      h: store.state.editorH,
      s: store.state.selectionW,
      e: store.state.eventAreaW,
    });
    void etn.ui.setState(networkId, UI_STATE_KEY.WINDOW_LAYOUT, payload).catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Wires the resizer element: `pointerdown` starts a drag, moving the pointer
 * resizes the editor (the canvas takes the rest). No-op while the editor is
 * hidden. The pointer-drag lifecycle is the shared `lib/ui/splitter` component
 * (задача 50f57b82); here only the editor's dock-dependent policy lives.
 */
export function mountEditorResizer(resizer: HTMLElement, body: HTMLElement): void {
  let horizontal = false;

  wireSplitter(resizer, {
    stateHost: () => body,
    stateClass: 'resizing',
    plan: (): SplitterPlan | null => {
      const pos = currentPosition(body);
      if (pos === 'hidden') return null;

      horizontal = pos === 'left' || pos === 'right';
      // Доступное имя — по текущей оси дока (док меняется на ходу).
      resizer.title = t('splitter.resizeHint');
      resizer.setAttribute(
        'aria-label',
        horizontal ? t('splitter.resizeAriaHorizontal') : t('splitter.resizeAriaVertical'),
      );
      const startSize = horizontal ? store.state.editorW : store.state.editorH;
      const bodySize = horizontal ? body.clientWidth : body.clientHeight;
      const canvasMin = horizontal ? MIN_CANVAS_W : MIN_CANVAS_H;
      const hardMin = horizontal ? EDITOR_W_MIN : EDITOR_H_MIN;
      const hardMax = horizontal ? EDITOR_W_MAX : EDITOR_H_MAX;
      // Keep at least `canvasMin` for the canvas; never below the editor hardMin.
      const max = Math.min(hardMax, Math.max(hardMin + 1, bodySize - canvasMin));

      // Drag direction sign: for left/top docks the editor is on the leading side,
      // so dragging into the body grows it; for right/bottom it shrinks it.
      const sign: 1 | -1 = pos === 'left' || pos === 'top' ? 1 : -1;

      return {
        axis: horizontal ? 'x' : 'y',
        sign,
        start: startSize,
        min: hardMin,
        max,
      };
    },
    apply: (size) => {
      const varName = horizontal ? '--editor-w' : '--editor-h';
      body.style.setProperty(varName, `${size}px`);
      if (horizontal) store.update({ editorW: size });
      else store.update({ editorH: size });
      scheduleLayoutPersist();
    },
  });
}
