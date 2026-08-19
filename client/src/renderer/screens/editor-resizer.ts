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
import { store } from '../state.js';

/** Minimum canvas size preserved when the editor is dragged to its largest. */
const MIN_CANVAS_W = 200;
const MIN_CANVAS_H = 160;
/** Debounce for persisting the layout after a drag, ms. */
const PERSIST_DEBOUNCE_MS = 400;

interface DragPlan {
  /** Which pointer axis drives the resize. */
  axis: 'x' | 'y';
  /** +1 when dragging in the positive axis direction grows the editor, else -1. */
  sign: 1 | -1;
  /** Editor size at drag start, px. */
  startSize: number;
  /** Pointer position at drag start, px. */
  startX: number;
  startY: number;
  /** Clamped `[min, max]` range for the editor size during this drag. */
  min: number;
  max: number;
}

let persistTimer: number | null = null;

/** Reads the active editor dock position off the workspace body's data attribute. */
function currentPosition(body: HTMLElement): string {
  return body.dataset['editorPos'] ?? 'right';
}

/**
 * Schedules a debounced persist of the current panel sizes (editor w/h and the
 * selection panel width) to the L4 `window_layout` ui_state. Shared by the
 * editor and selection-panel resizers — the full payload is read from the store
 * at fire time, so the last writer never loses the other panel's size.
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
    });
    void etn.ui.setState(networkId, UI_STATE_KEY.WINDOW_LAYOUT, payload).catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Wires the resizer element: `pointerdown` starts a drag, moving the pointer
 * resizes the editor (the canvas takes the rest). No-op while the editor is
 * hidden.
 */
export function mountEditorResizer(resizer: HTMLElement, body: HTMLElement): void {
  resizer.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    const pos = currentPosition(body);
    if (pos === 'hidden') return;

    const horizontal = pos === 'left' || pos === 'right';
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

    const plan: DragPlan = {
      axis: horizontal ? 'x' : 'y',
      sign,
      startSize,
      startX: event.clientX,
      startY: event.clientY,
      min: hardMin,
      max,
    };

    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
    body.classList.add('resizing');

    const varName = horizontal ? '--editor-w' : '--editor-h';

    const onMove = (ev: PointerEvent): void => {
      const delta = plan.axis === 'x' ? ev.clientX - plan.startX : ev.clientY - plan.startY;
      const raw = plan.startSize + plan.sign * delta;
      const size = Math.round(Math.min(plan.max, Math.max(plan.min, raw)));
      body.style.setProperty(varName, `${size}px`);
      if (horizontal) store.update({ editorW: size });
      else store.update({ editorH: size });
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
