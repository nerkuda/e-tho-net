/**
 * Horizontal splitter between stacked panels inside an editor tab
 * (08-ui-spec.md §6.3): a thin grab strip that changes the visible height of
 * the scrollable area above it (its `max-height`, so the CSS defaults — five
 * table rows, one list row — stay the cap until the user drags).
 *
 * The drag is bounded by the tab height: the area above never grows past its
 * natural content height (a four-row table cannot be stretched to five rows,
 * only shrunk — down to `min`), so the area below always keeps the rest of
 * the tab. The resize target is resolved lazily on drag start because some
 * areas (group bodies) are built asynchronously or are absent while their
 * group is collapsed — a splitter next to a collapsed group is inert.
 * Sizes are not persisted; they reset when the entity changes.
 *
 * Follows the pointer-capture drag pattern of `screens/editor-resizer.ts`.
 */

import { div } from '../lib/dom.js';

/** Options for {@link rowSplitter}. */
export interface RowSplitterOptions {
  /** Minimum height of the resized area, px (default 34 — one table row). */
  min?: number;
  /**
   * Resolves the maximum height at drag start, px. Default: the area's
   * natural content height, never less than its height at drag start (an
   * area flex-filled past its content must not snap back on the first move).
   */
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
  const min = options.min ?? 34;
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
    // scrollHeight is the natural content height even while the element is
    // clipped by max-height; keep the current height reachable too.
    const max = options.max?.() ?? Math.max(resizeEl.scrollHeight, startHeight);

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
