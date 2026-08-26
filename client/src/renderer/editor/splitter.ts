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
 *
 * With `persistKey` (bug ee745368) the dragged height is remembered as the
 * list's MAXIMUM: it survives entity changes and restarts (L4
 * `editor_list_heights` / `chronicle_list_heights`, see list-heights.ts) and
 * caps the list on every content refresh — the visible height follows the row
 * count but never exceeds the saved cap. Without `persistKey` the size stays
 * session-only and resets when the view is rebuilt.
 *
 * Follows the pointer-capture drag pattern of `screens/editor-resizer.ts`.
 */

import { div } from '../lib/dom.js';
import { saveListClamp } from './list-heights.js';

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
  /**
   * Persistence key (list-heights.ts): the dragged height is saved as the
   * list's maximum and re-applied after re-renders. When set, the drag end
   * also stops the area from flex-filling (`flex-grow: 0`), so its height
   * equals the content capped at the saved maximum.
   */
  persistKey?: string;
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
    // The user-requested height (content-unbounded): the visible clamp below
    // never stretches past the content, but the saved MAX must follow the
    // pointer even when the current list is too short to show it (ee745368).
    let requested = startHeight;
    let moved = false;

    const onMove = (ev: PointerEvent): void => {
      moved = true;
      requested = Math.round(startHeight + (ev.clientY - startY));
      resizeEl.style.maxHeight = `${Math.min(max, Math.max(min, requested))}px`;
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
      // Remember the drag as the list's maximum: strict content-height for
      // flex-filled group targets (the «Связи» tab) and a persisted cap that
      // survives entity changes and restarts. A click without a move does
      // not count as a drag.
      if (options.persistKey !== undefined && moved) {
        saveListClamp(options.persistKey, Math.max(min, requested));
        resizeEl.style.flexGrow = '0';
      }
    };

    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onUp);
  });

  return strip;
}
