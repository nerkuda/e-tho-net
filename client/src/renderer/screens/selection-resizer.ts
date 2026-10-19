/**
 * Draggable splitter between a left side panel and the canvas (08-ui-spec.md
 * §5; панель использования — спека f7623077). Mirrors the editor resizer:
 * dragging updates the CSS variable on the workspace body and the store, so
 * the panel (its flex-basis) and the canvas resize live. The new width is
 * persisted to the L4 `window_layout` ui_state via the shared debounced writer
 * (see `editor-resizer.ts`), so it survives restarts alongside the editor
 * sizes. The usage panel writes its own key (`u`), selection — `s`.
 *
 * The pointer-drag lifecycle is the shared `lib/ui/splitter` component
 * (задача 50f57b82).
 */

import { SELECTION_W_MAX, SELECTION_W_MIN, USAGE_W_MAX, USAGE_W_MIN } from '@etn/shared';
import { t } from '../lib/i18n.js';
import { wireSplitter } from '../lib/ui/splitter.js';
import { store } from '../state.js';
import { scheduleLayoutPersist } from './editor-resizer.js';

/** Minimum canvas width preserved when the panel is dragged to its largest. */
const MIN_CANVAS_W = 200;

/** Политика одного бокового сплиттера (панели слева от холста). */
interface SidePanelResizerSpec {
  /** CSS-переменная ширины на `workspace-body`. */
  cssVar: string;
  min: number;
  max: number;
  /** Текущая ширина из store. */
  current: () => number;
  /** Записать новую ширину в store. */
  commit: (size: number) => void;
}

/**
 * Wires a horizontal splitter element: `pointerdown` starts a drag; moving
 * the pointer resizes the panel (the canvas takes the rest). No-op while the
 * panel is hidden (the element is hidden along with it).
 */
function mountSidePanelResizer(
  resizer: HTMLElement,
  body: HTMLElement,
  spec: SidePanelResizerSpec,
): void {
  wireSplitter(resizer, {
    stateHost: () => body,
    stateClass: 'resizing',
    title: t('splitter.resizeHint'),
    ariaLabel: t('splitter.resizeAriaHorizontal'),
    plan: () => {
      // Keep at least `MIN_CANVAS_W` for the canvas; never below the panel min.
      const max = Math.min(
        spec.max,
        Math.max(spec.min + 1, body.clientWidth - MIN_CANVAS_W),
      );
      return {
        axis: 'x',
        start: spec.current(),
        min: spec.min,
        max,
      };
    },
    apply: (size) => {
      body.style.setProperty(spec.cssVar, `${size}px`);
      spec.commit(size);
      scheduleLayoutPersist();
    },
  });
}

/** Splitter панели выделенных (H16, 08-ui-spec.md §5). */
export function mountSelectionResizer(resizer: HTMLElement, body: HTMLElement): void {
  mountSidePanelResizer(resizer, body, {
    cssVar: '--selection-w',
    min: SELECTION_W_MIN,
    max: SELECTION_W_MAX,
    current: () => store.state.selectionW,
    commit: (size) => store.update({ selectionW: size }),
  });
}

/** Splitter панели использования (спека f7623077; `window_layout.u`). */
export function mountUsageResizer(resizer: HTMLElement, body: HTMLElement): void {
  mountSidePanelResizer(resizer, body, {
    cssVar: '--usage-w',
    min: USAGE_W_MIN,
    max: USAGE_W_MAX,
    current: () => store.state.usageW,
    commit: (size) => store.update({ usageW: size }),
  });
}
