/**
 * Horizontal splitter between stacked panels inside an editor tab
 * (08-ui-spec.md §6.3): a thin grab strip that changes the visible height of
 * the scrollable area above it (its `max-height`, so the CSS defaults — five
 * list rows, fifteen link rows — stay the cap until the user drags). Sizes are
 * not persisted; they reset when the entity changes.
 *
 * The resize target is resolved lazily on drag start because some areas (group
 * bodies) are built asynchronously or may be absent while a group is collapsed.
 * Follows the pointer-capture drag pattern of `screens/editor-resizer.ts`.
 */

import { div } from '../lib/dom.js';

/** Options for {@link rowSplitter}. */
export interface RowSplitterOptions {
  /** Minimum height of the resized area, px (default 60). */
  min?: number;
  /** Resolves the maximum height at drag start, px (default: 60% of window). */
  max?: () => number;
}

/**
 * Builds a splitter strip. Dragging sets `style.maxHeight` on the element the
 * resolver returns (no-op while it resolves to null).
 */
export function rowSplitter(
  getResizeEl: () => HTMLElement | null,
  options: RowSplitterOptions = {},
): HTMLElement {
  const min = options.min ?? 60;
  const strip = div('row-splitter');
  strip.textContent = '⣿';
  strip.title = 'Потяните, чтобы изменить высоту';

  strip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const resizeEl = getResizeEl();
    if (resizeEl === null) return;
    event.preventDefault();
    strip.setPointerCapture(event.pointerId);
    strip.classList.add('dragging');

    const startY = event.clientY;
    const startHeight = resizeEl.getBoundingClientRect().height;
    const max = options.max?.() ?? Math.round(window.innerHeight * 0.6);

    const onMove = (ev: PointerEvent): void => {
      const raw = Math.round(startHeight + (ev.clientY - startY));
      resizeEl.style.maxHeight = `${Math.min(max, Math.max(min, raw))}px`;
    };
    const onUp = (ev: PointerEvent): void => {
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', onUp);
      strip.removeEventListener('pointercancel', onUp);
      try {
        strip.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released — ignore */
      }
      strip.classList.remove('dragging');
    };

    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onUp);
  });

  return strip;
}
