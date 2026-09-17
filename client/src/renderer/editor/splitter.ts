/**
 * Horizontal splitter between stacked panels inside an editor tab or a
 * screen (08-ui-spec.md §6.3): a thin grab strip that changes the visible
 * height of the area above it.
 *
 * Always-fixed policy (bugs 6b757336, ee745368, 4cc6248c; требование «Высота
 * областей и таблиц не зависит от содержимого»): the dragged height is the
 * area's **fixed** height. It never depends on the current content — fewer
 * rows leave empty space, more rows scroll inside — so the layout cannot
 * jump when the data refreshes or the entity changes. The value is saved via
 * `saveListClamp` (list-heights.ts, L4 ui_state) and re-applied on every
 * rebuild — inline via `applyGroupClamp` for tab/screen groups, or through a
 * `--clamp-*` CSS variable for the editor tables — so it survives entity
 * switches and restarts. Until the user drags, the area keeps its CSS
 * default (a fixed five-row height for the tables, flex-fill for groups) —
 * never a content-derived size.
 *
 * The drag range is content-unbounded up to {@link FIXED_MAX_PX} (bug
 * 4cc6248c): the user must be able to grow the area past the current rows —
 * pre-reserving space for future content — and to shrink it below them. The
 * `max-height` set while the pointer is down is a live preview only; the
 * drag end commits the exact `height` through `applyGroupClamp` right away,
 * so the area cannot relayout between the drag and the next rebuild.
 *
 * The resize target is resolved lazily on drag start because some areas
 * (group bodies) are built asynchronously or are absent while their group is
 * collapsed — a splitter next to a collapsed group is inert.
 *
 * Follows the pointer-capture drag pattern of `screens/editor-resizer.ts`.
 */

import { div } from '../lib/dom.js';
import { applyGroupClamp, saveListClamp } from './list-heights.js';

/**
 * Upper bound of the drag range, px (bug 4cc6248c): large enough for a dozen
 * table rows and well inside any reasonable editor pane, but never derived
 * from the current content — the user may grow the area past the rows of the
 * entity on screen to pre-reserve space for the next one.
 */
const FIXED_MAX_PX = 800;

/** Options for {@link rowSplitter}. */
export interface RowSplitterOptions {
  /** Minimum height of the resized area, px (default 34 — one table row). */
  min?: number;
  /**
   * Resolves the maximum height at drag start, px. Default
   * {@link FIXED_MAX_PX} — the range never depends on the area's current
   * content (требование «Высота областей и таблиц не зависит от
   * содержимого»); pass an explicit resolver only for genuinely bounded
   * areas, never the natural content height of the resized element.
   */
  max?: () => number;
  /**
   * Persistence key (list-heights.ts): the dragged height is saved and
   * re-applied after re-renders — inline via `applyGroupClamp` for tab and
   * screen groups, and as a fixed CSS `height` for the editor tables
   * (`props`/`chrono`/`attachments`) through their `--clamp-*` variable.
   * When set, the drag end also stops the area from flex-filling
   * (`flex-grow: 0`).
   */
  persistKey?: string;
}

/**
 * Builds a splitter strip. Dragging sets `style.maxHeight` on the element the
 * resolver returns (no-op while it resolves to null); releasing the pointer
 * commits the exact fixed height and persists it.
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
    const max = options.max?.() ?? FIXED_MAX_PX;
    // The user-requested height (content-unbounded): the visible clamp below
    // never stretches past `max`, but the saved value follows the pointer
    // even when the current list is too short to show it (ee745368, 4cc6248c).
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
      // Remember the drag as the area's exact fixed height and apply it at
      // once (inline `height` + no flex-fill, stale preview cap cleared) so
      // the size holds through content refreshes until the next rebuild,
      // where `applyGroupClamp` / the `--clamp-*` variable re-applies it.
      // A click without a move does not count as a drag.
      if (options.persistKey !== undefined && moved) {
        saveListClamp(options.persistKey, Math.min(max, Math.max(min, requested)));
        applyGroupClamp(resizeEl, options.persistKey);
      }
    };

    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onUp);
  });

  return strip;
}
