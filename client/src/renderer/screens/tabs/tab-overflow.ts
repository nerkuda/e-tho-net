/**
 * Overflow computation for a tab strip.
 *
 * The strip is a flex row of fixed-width tab buttons (caller-supplied default
 * and minimum widths). When the row doesn't fit, trailing items collapse into
 * a `[▾N]` dropdown button positioned at the right of the strip — the
 * overflow button is always visible when any item is hidden. Both the
 * workspace tab strip (`screens/tabs/tabs.ts`) and the editor tab strip
 * (`editor/editor.ts`) reuse this layout.
 *
 * The function is fully generic over the item type: callers pass `allItems`
 * (the source of truth — e.g. `store.state.tabs` or the editor's TABS array)
 * and a `renderRow` callback that produces a dropdown row DOM. The callback
 * itself decides which actions to expose (e.g. «Активировать»/«Закрыть» for
 * workspace tabs, just a clickable label for editor tabs).
 */
import { el } from '../../lib/dom.js';

/** Live DOM state of the tab strip, kept by the caller. */
export interface StripElements<T> {
  /** Root container that holds visible tabs and overflow button. */
  root: HTMLElement;
  /** Visible item buttons in DOM order. */
  visible: HTMLButtonElement[];
  /** Hidden items — a sub-array of the caller's `allItems`. */
  hidden: T[];
  /** Optional always-visible accessory button whose width is reserved (e.g. «+»). */
  reserveButton?: HTMLButtonElement | null;
  /** `[▾N]` overflow button (null when nothing is hidden). */
  overflowButton: HTMLButtonElement | null;
}

/**
 * Lays out the strip so visible items plus reserved controls fit in
 * `root.clientWidth`. Toggles each item's `hidden` attribute, rebuilds
 * `elements.hidden`, and shows/hides the overflow button.
 */
export function recomputeOverflow<T>(
  elements: StripElements<T>,
  defaultItemWidth: number,
  minItemWidth: number,
  allItems: readonly T[],
): void {
  const root = elements.root;
  if (root.clientWidth === 0) return;

  const reserveForAccessory = elements.reserveButton !== null && elements.reserveButton !== undefined
    ? elements.reserveButton.getBoundingClientRect().width || 32
    : 0;
  const overflowBtn = elements.overflowButton;
  const reserveForOverflow = overflowBtn !== null && !overflowBtn.hidden ? 32 : 0;

  // Pick the largest item width that lets all items fit alongside the
  // reserved controls.
  const visibleButtons = elements.visible;
  const total = visibleButtons.length;
  const available = root.clientWidth - reserveForAccessory - reserveForOverflow;
  let itemWidth = defaultItemWidth;
  if (total * itemWidth > available) {
    itemWidth = Math.max(minItemWidth, Math.floor(available / Math.max(total, 1)));
  }

  // Reserve width for the overflow button if any item would otherwise overflow.
  let visibleCount = total;
  let needsOverflow = false;
  const visibleWidth = (n: number): number => n * itemWidth + reserveForAccessory;
  while (visibleCount > 0 && visibleWidth(visibleCount) + (needsOverflow ? 32 : 0) > root.clientWidth) {
    visibleCount -= 1;
    needsOverflow = true;
  }

  // Apply visibility.
  for (let i = 0; i < visibleButtons.length; i += 1) {
    const button = visibleButtons[i]!;
    button.style.width = `${itemWidth}px`;
    button.hidden = i >= visibleCount;
  }

  // Hidden = the trailing items.
  elements.hidden = allItems.slice(visibleCount);

  if (overflowBtn !== null) {
    overflowBtn.hidden = !needsOverflow;
    if (needsOverflow) {
      overflowBtn.textContent = `▾${elements.hidden.length}`;
      overflowBtn.title = `Ещё ${elements.hidden.length}`;
    }
  }
}

/**
 * Wires the overflow button: clicking opens a dropdown listing every hidden
 * item with rows built by `renderRow`. Subsequent clicks toggle the dropdown.
 *
 * Returns the live button (a fresh clone — the previous one was detached via
 * `replaceWith` to reset any wired handler). The caller MUST update its
 * reference (e.g. `stripElements.overflowButton`) to the returned node so
 * {@link recomputeOverflow} keeps updating the DOM button after a layout
 * change, not the orphaned original.
 *
 * `getHidden` is called LAZILY on every click — it must return the live
 * `elements.hidden` array. The caller passes a getter (not the array itself)
 * because the dropdown's contents can change between renders: e.g. the
 * editor mounts the tab strip while `tabBar` is detached, so the very first
 * `recomputeOverflow` is an early return (`clientWidth === 0`) and
 * `elements.hidden` is still `[]`. The click handler is wired with that
 * empty snapshot if the array is captured directly — every later dropdown
 * opens empty even after ResizeObserver populates `elements.hidden`. The
 * getter sidesteps the stale-snapshot trap by re-reading at click time.
 */
export function buildOverflowButton<T>(
  overflowBtn: HTMLButtonElement,
  getHidden: () => readonly T[],
  renderRow: (item: T, close: () => void) => HTMLElement,
): HTMLButtonElement {
  // Tear down any previously wired handler so we don't stack listeners.
  const clone = overflowBtn.cloneNode(true) as HTMLButtonElement;
  overflowBtn.replaceWith(clone);
  let open = false;
  let dropdown: HTMLDivElement | null = null;

  const close = (): void => {
    if (dropdown !== null) {
      dropdown.remove();
      dropdown = null;
    }
    open = false;
    document.removeEventListener('click', onDocClick, true);
  };

  const onDocClick = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target === null) return;
    if (dropdown !== null && dropdown.contains(target)) return;
    if (clone.contains(target)) return;
    close();
  };

  clone.addEventListener('click', (event) => {
    event.stopPropagation();
    if (open) {
      close();
      return;
    }
    open = true;
    dropdown = el('div', 'tab-overflow-dropdown');
    const hidden = getHidden();
    for (const item of hidden) {
      const row = renderRow(item, close);
      dropdown.append(row);
    }
    if (dropdown.childElementCount === 0) {
      close();
      return;
    }
    const rect = clone.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = `${rect.bottom + 4}px`;
    // The `▾N` button sits at the right edge of its strip (right after the
    // last visible tab), so anchoring the dropdown by its LEFT edge (old
    // `dropdown.style.left = rect.left`) pushed it mostly off-screen when the
    // strip itself was near the window's right border — only the sliver up
    // to the window edge was visible, the rest was clipped by the OS window
    // boundary. Measure the real width first (min-width: 220px in CSS, but
    // workspace rows with «Активировать»/«Закрыть» buttons can be wider) and
    // anchor the RIGHT edge to the button's right edge instead, clamping
    // both sides to a 4px viewport margin so a narrow window never clips it.
    dropdown.style.visibility = 'hidden';
    document.body.append(dropdown);
    const dropdownWidth = dropdown.getBoundingClientRect().width;
    const viewportWidth = document.documentElement.clientWidth;
    let left = rect.right - dropdownWidth;
    left = Math.max(4, Math.min(left, viewportWidth - dropdownWidth - 4));
    dropdown.style.left = `${left}px`;
    dropdown.style.visibility = '';
    document.addEventListener('click', onDocClick, true);
  });

  return clone;
}
