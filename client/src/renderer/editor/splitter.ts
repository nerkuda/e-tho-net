/**
 * Horizontal splitter between stacked panels inside an editor tab
 * (08-ui-spec.md §6.3): a thin grab strip that changes the visible height of
 * the scrollable area above it.
 *
 * For `props`/`chrono`/`attachments` (bug 6b757336) the persisted height is
 * applied as a fixed CSS `height`, not a cap: the area keeps this exact size
 * regardless of the current row count (fewer rows leave empty space, more
 * rows scroll) — this is what stops the area from collapsing and jumping on
 * every content reload or thought switch. This function itself still only
 * ever sets `style.maxHeight` on the live drag preview (see below) — the
 * fixed-height CSS rule lives in `styles.css` and reads the same persisted
 * value from the `--clamp-*` variable.
 *
 * For groups with a `persistKey` rowSplitter that read the saved value
 * inline through `applyGroupClamp` (the «Связи» tab groups, the «Свойства
 * типа» group, the chronicle screen areas — bug 4cc6248c) the drag preview
 * sets `style.maxHeight` only while the pointer is down; `applyGroupClamp`
 * then commits the exact `height` on the next tab rebuild. The drag range is
 * lifted past the current content height (to {@link FIXED_MAX_PX}) so the
 * user can pre-reserve space for a future thought with more rows, and the
 * saved value is content-unbounded.
 *
 * The CSS-var consumers (`props`/`chrono`/`attachments`) keep their drag
 * range pinned to the natural content height on purpose: the saved value
 * drives the `--clamp-*` variable which CSS reads as `height`, so dragging
 * past the content would persist a huge value and inflate the table on
 * every render. The CSS-var channel and the inline-height channel thus have
 * intentionally different upper bounds.
 *
 * With `persistKey` (bug ee745368) the dragged height is remembered as the
 * list's fixed height: it survives entity changes and restarts (L4
 * `editor_list_heights` / `chronicle_list_heights`, see list-heights.ts).
 * Without `persistKey` the size stays session-only and resets when the view
 * is rebuilt.
 *
 * The resize target is resolved lazily on drag start because some areas
 * (group bodies) are built asynchronously or are absent while their group is
 * collapsed — a splitter next to a collapsed group is inert.
 *
 * Follows the pointer-capture drag pattern of `screens/editor-resizer.ts`.
 */

import { div } from '../lib/dom.js';
import { CSS_VAR_KEYS, saveListClamp } from './list-heights.js';

/**
 * Upper bound of the drag range for `persistKey` rowSplitters whose target is
 * NOT a CSS-var consumer (bug 4cc6248c) — the user must be able to grow the
 * group past the current thought's content so the saved height pre-reserves
 * space for the next thought. 800 px is large enough for a dozen table rows
 * and still well inside any reasonable editor pane.
 */
const FIXED_MAX_PX = 800;

/** Options for {@link rowSplitter}. */
export interface RowSplitterOptions {
  /** Minimum height of the resized area, px (default 34 — one table row). */
  min?: number;
  /**
   * Resolves the maximum height at drag start, px. Default: the area's
   * natural content height, never less than its height at drag start (an
   * area flex-filled past its content must not snap back on the first move);
   * for `persistKey` consumers outside the CSS-var channel (bug 4cc6248c)
   * the upper bound is lifted to {@link FIXED_MAX_PX} so the user can grow
   * the group past its current rows.
   */
  max?: () => number;
  /**
   * Persistence key (list-heights.ts): the dragged height is saved and
   * re-applied after re-renders — as a fixed CSS `height` for
   * `props`/`chrono`/`attachments` via `--clamp-*` (bug 6b757336), and as an
   * inline `height` for every other group via `applyGroupClamp` (bug
   * 4cc6248c: was a content-bound `max-height` cap). When set, the drag end
   * also stops the area from flex-filling (`flex-grow: 0`).
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
    // persistKey consumers that read the saved value inline (groups on the
    // «Связи» / «Свойства» / chronicle tabs) get a generous upper bound
    // (FIXED_MAX_PX) so the user can grow the group past the current rows
    // (bug 4cc6248c); CSS-var consumers stay pinned to the natural content
    // height, otherwise dragging past it would inflate the table on every
    // render.
    const naturalMax = Math.max(resizeEl.scrollHeight, startHeight);
    const isExpandablePersist =
      options.persistKey !== undefined &&
      !Object.prototype.hasOwnProperty.call(CSS_VAR_KEYS, options.persistKey);
    const max =
      options.max?.() ??
      (isExpandablePersist ? Math.max(naturalMax, FIXED_MAX_PX) : naturalMax);
    // The user-requested height (content-unbounded): the visible clamp below
    // never stretches past `max`, but the saved MAX must follow the pointer
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
      // Remember the drag as the list's height: a content-bound cap for
      // CSS-var consumers (`props`/`chrono`/`attachments`) and an inline
      // `height` for everyone else (bug 4cc6248c). A click without a move
      // does not count as a drag.
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
