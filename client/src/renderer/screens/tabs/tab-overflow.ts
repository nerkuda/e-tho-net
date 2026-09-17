/**
 * Overflow computation for a tab strip.
 *
 * The strip is a flex row of tab buttons. When the row doesn't fit, trailing
 * items collapse into a `[▾N]` dropdown button positioned at the right of the
 * strip — the overflow button is always visible when any item is hidden. Both
 * the workspace tab strip (`screens/tabs/tabs.ts`) and the editor tab strip
 * (`editor/editor.ts`) reuse this layout; their button widths differ and are
 * described by {@link TabLayout} (equal fixed widths for the workspace,
 * content-sized buttons for the editor).
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
 * Ширина кнопки `[▾N]` — запас, который оставляем под неё, когда что-то
 * скрывается. Оценка снизу: кнопка узкая (`▾12`), плюс промежуток строки.
 */
const OVERFLOW_BTN_PX = 32;

/**
 * Как раскладываются кнопки полосы вкладок.
 *
 * - `fixed` — все кнопки одной ширины: сначала `defaultWidth`, при нехватке
 *   места сжимаются, но не ниже `minWidth`; не поместившиеся уходят в `[▾N]`.
 *   Так живут вкладки рабочего стола — там важна одинаковая ширина.
 * - `content` — ширина каждой кнопки по её содержимому (заголовок + счётчик
 *   «(N)»), `minWidth` — только нижняя граница для коротких заголовков.
 *   Кнопки не сжимаются: не поместившиеся уходят в `[▾N]`. Так живёт панель
 *   вкладок редактора: заголовки разной длины («Комментарий» против «Граф»),
 *   и при фиксированной ширине длинный заголовок вылезал за кнопку.
 */
export type TabLayout =
  | { kind: 'fixed'; defaultWidth: number; minWidth: number }
  | { kind: 'content'; minWidth?: number };

/**
 * Ширина, реально доступная кнопкам полосы: content-box без внутренних
 * отступов контейнера.
 *
 * `clientWidth` включает padding (у `.editor-tabs` это 10 px с каждой стороны),
 * и раскладка по нему оставляла бы кнопке `[▾N]` меньше места, чем нужно, —
 * она уезжала бы под `overflow: hidden` полосы, а скрытые вкладки становились
 * бы недоступны. У полосы рабочего стола отступов нет — там результат прежний.
 */
function contentBoxWidth(root: HTMLElement): number {
  const styles = getComputedStyle(root);
  const paddingX =
    (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
  return Math.max(0, root.clientWidth - paddingX);
}

/**
 * Lays out the strip so visible items plus reserved controls fit in
 * `root.clientWidth`. Toggles each item's `hidden` attribute, rebuilds
 * `elements.hidden`, and shows/hides the overflow button.
 *
 * Кнопки `elements.visible` обязаны быть flex-элементами без растягивания
 * (`flex: 0 0 auto` в CSS) — иначе в режиме `content` браузер сжимает их
 * меньше содержимого, и замеренные ширины перестают быть «нужными».
 */
export function recomputeOverflow<T>(
  elements: StripElements<T>,
  allItems: readonly T[],
  layout: TabLayout,
): void {
  const root = elements.root;
  if (root.clientWidth === 0) return;
  const boxWidth = contentBoxWidth(root);

  const reserveForAccessory =
    elements.reserveButton !== null && elements.reserveButton !== undefined
      ? elements.reserveButton.getBoundingClientRect().width || 32
      : 0;
  const overflowBtn = elements.overflowButton;
  const reserveForOverflow = overflowBtn !== null && !overflowBtn.hidden ? OVERFLOW_BTN_PX : 0;

  const visibleButtons = elements.visible;
  const total = visibleButtons.length;
  let visibleCount = total;
  let needsOverflow = false;

  if (layout.kind === 'fixed') {
    // Pick the largest item width that lets all items fit alongside the
    // reserved controls.
    const available = boxWidth - reserveForAccessory - reserveForOverflow;
    let itemWidth = layout.defaultWidth;
    if (total * itemWidth > available) {
      itemWidth = Math.max(layout.minWidth, Math.floor(available / Math.max(total, 1)));
    }
    for (const button of visibleButtons) button.style.width = `${itemWidth}px`;

    // Reserve width for the overflow button if any item would otherwise overflow.
    const visibleWidth = (n: number): number => n * itemWidth + reserveForAccessory;
    while (
      visibleCount > 0 &&
      visibleWidth(visibleCount) + (needsOverflow ? OVERFLOW_BTN_PX : 0) > boxWidth
    ) {
      visibleCount -= 1;
      needsOverflow = true;
    }
  } else {
    // Ширина — по содержимому: снимаем прежнюю фиксированную ширину, задаём
    // нижнюю границу и раскладываем строку целиком, а затем читаем фактические
    // края кнопок: их разница и есть нужные ширины вместе с промежутками
    // (gap строки). Скрытие идёт после замера и на ширину оставшихся не влияет
    // — кнопки не растягиваются.
    for (const button of visibleButtons) {
      button.style.width = 'auto';
      if (layout.minWidth !== undefined) button.style.minWidth = `${layout.minWidth}px`;
      button.hidden = false;
    }
    const rects = visibleButtons.map((button) => button.getBoundingClientRect());
    const first = rects[0];
    const chainWidth = (n: number): number =>
      n <= 0 || first === undefined ? 0 : rects[n - 1]!.right - first.left;
    const limit = boxWidth - reserveForAccessory;
    while (
      visibleCount > 0 &&
      chainWidth(visibleCount) + (needsOverflow ? OVERFLOW_BTN_PX : 0) > limit
    ) {
      visibleCount -= 1;
      needsOverflow = true;
    }
  }

  // Apply visibility.
  for (let i = 0; i < visibleButtons.length; i += 1) {
    visibleButtons[i]!.hidden = i >= visibleCount;
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
