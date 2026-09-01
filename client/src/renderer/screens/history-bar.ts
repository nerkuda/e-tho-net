/**
 * Visit history in the status bar (H7, 08-ui-spec.md §11.1, 11-settings-and-state.md
 * §2.3, 09-scenarios.md B4):
 *
 * `[облачко₁] [облачко₂] … [▾ N]`
 *
 * - ONE history shared by every screen (map/structures/chronicle, 0.5.5):
 *   the list of thoughts opened in the thought editor, wherever they were
 *   opened from — there is no per-view scoping anymore;
 * - the bar claims the full free width of the status bar between the left
 *   edge and the counts/zoom block; as many mini clouds are rendered as
 *   actually fit, the rest collapse into the `▾ N` dropdown;
 * - each mini cloud renders the thought's icon + title (clipped to
 *   {@link CHIP_TITLE_LIMIT} chars + ellipsis), real fg/bg/font styles via
 *   `applyCloudStyle`, dimmed when inactive;
 * - dropdown items mirror the search-panel rendering (08-ui-spec.md §6.7):
 *   the same `mini-icon` DOM node, font/fg/bg/dim classes from the thought,
 *   CSS ellipsis by width;
 * - empty history hides the area entirely;
 * - entries are resolved via `thoughts.resolve` (id → metadata); deleted
 *   thoughts were already pruned locally by the main-process applier, and
 *   inactive thoughts are hidden while `show_inactive` is off;
 * - clicking an entry opens the thought in the editor: switches the focus
 *   (map view) or opens the thought without moving the canvas focus
 *   (structures/chronicle view) — the current-thought frame follows the pick
 *   on every screen;
 * - entries drag onto the canvas like zone clouds (§11.1): link onto a cloud,
 *   Ctrl for reparent, drop into parents/children to link to focus; a canvas
 *   drag dropped onto the bar (or the dropdown) opens the dragged thought.
 */

import { setFocus } from '../app.js';
import { button, div, clear, el, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { svgIcon } from '../lib/icons.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { store } from '../state.js';
import { currentThoughtId, setHistoryChangeListener } from '../history.js';
import { applyCloudStyle, applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';
import { registerDropActions, wireExternalDragSource } from '../canvas/drag-cloud.js';
import { openStructuresThought } from './structures/structures.js';
import { openChronicleThought } from './chronicle/chronicle.js';
import { HISTORY_BAR_MORE_RESERVE, planHistoryChips } from '../lib/pure.js';

/**
 * Max title length inside a history mini-cloud (the chip on the bar). When the
 * title is longer we append an ellipsis so the chip stays a single line.
 */
const CHIP_TITLE_LIMIT = 24;
/** How many entries the dropdown source returns at once. */
const HISTORY_LIMIT = 50;
/**
 * Width used by the peel loop when the host hasn't been laid out yet
 * (`host.clientWidth === 0`). The plan still peels against this nominal width
 * so the strip does not show `▾ N` alone if the real width comes back tiny.
 */
const ZERO_WIDTH_PLACEHOLDER = 0;

/** Suffix appended when a title is truncated to {@link CHIP_TITLE_LIMIT}. */
const ELLIPSIS = '…';

/** Truncates `text` to `limit` characters; appends an ellipsis when cut. */
function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}${ELLIPSIS}` : text;
}

let host: HTMLElement | null = null;
/** Signature of the inputs the bar depends on — avoids redundant re-renders. */
let lastSignature = '';
/** Coalesces `ResizeObserver` ticks into one render per animation frame. */
let resizePending = false;
/** Cached `ResizeObserver` so we don't re-create it on every render. */
let resizeObserver: ResizeObserver | null = null;

/** Mounts the history bar into the status bar host. */
export function mountHistoryBar(historyHost: HTMLElement): void {
  host = historyHost;
  // Canvas drags dropped onto the bar (or the history dropdown) open the
  // dragged thought like a click on a history entry (08-ui-spec.md §11.1).
  registerDropActions({ openEntry });
  store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
  // History writes land outside the store snapshot (history.js is not part of
  // the reactive state) — the module notifies via this listener so the bar
  // repaints even when no store field changed.
  setHistoryChangeListener(() => {
    invalidateHistoryBar();
  });
  // The number of visible chips depends on the strip width; recompute on
  // window/status-bar resize (08-ui-spec.md §11.1: «при изменении ширины окна
  // состав видимых облачков пересчитывается»).
  resizeObserver = new ResizeObserver(() => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      if (host?.isConnected === true) void render();
    });
  });
  resizeObserver.observe(historyHost);
  void render();
}

/**
 * Forces a re-render on the next store change even if the inputs did not
 * change — called on realtime `thought.deleted` (the main-process applier has
 * already pruned the local history by then).
 */
export function invalidateHistoryBar(): void {
  lastSignature = '';
  if (host?.isConnected === true) void render();
}

/** Opens a history entry in the way its view implies (§11.1). */
function openEntry(id: string): void {
  if (store.state.activeView === 'structures') {
    void openStructuresThought(id);
  } else if (store.state.activeView === 'chronicle') {
    void openChronicleThought(id);
  } else {
    void setFocus(id);
  }
}

/**
 * The id excluded from the list as "current": the thought open in the editor,
 * else the canvas focus. A link open in the editor means no current thought
 * (a link is never a history entry anyway).
 */
function currentId(): string | null {
  return currentThoughtId();
}

/** Re-renders the history bar from the local history + server metadata. */
async function render(): Promise<void> {
  if (host === null) return;
  const profileId = store.state.profileId;
  const networkId = store.state.networkId;
  const view = store.state.activeView;
  // The width is part of the signature: the visible chip set depends on it.
  // The view is part of it too: chips route the click per the active screen.
  const signature = `${profileId ?? ''}|${networkId ?? ''}|${view}|${currentId() ?? ''}|${String(store.state.showInactive)}|${host.clientWidth}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  if (profileId === null || networkId === null) {
    clear(host);
    return;
  }

  const entries = await etn.history.list(
    profileId,
    networkId,
    store.state.activeTabId,
    HISTORY_LIMIT,
  );
  if (host === null || !host.isConnected) return;
  const ids = entries.map((entry) => entry.thoughtId);

  const refs = ids.length > 0 ? await resolveRefs(networkId, ids) : new Map();
  const activeId = currentId();
  const visible = ids.filter((id) => {
    // The current thought is not a "recent" — it enters the list only after
    // the user moves away from it.
    if (id === activeId) return false;
    const ref = refs.get(id);
    return store.state.showInactive || ref === undefined || ref.active;
  });

  clear(host);
  if (visible.length === 0) {
    const empty = div('history-empty');
    empty.textContent = 'нет предыдущих мыслей';
    host.append(empty);
    return;
  }

  const chips = visible.map((id) => ({
    id,
    ref: refs.get(id),
    el: buildChip(id, refs.get(id)),
  }));
  const { shown, rest } = layoutChips(chips);
  for (const chip of shown) host.append(chip.el);

  if (rest.length > 0) {
    let more = buildMoreButton(rest.length, () => openHistoryMenu(rest, more));
    host.append(more);
    // Peel chips until the pure planner is satisfied. Replaces the previous
    // one-shot peel that left a tight strip with `▾ N` alone — when more
    // than one chip had to go, or `shown` was already empty, the button
    // stayed and the user saw no chips beside it (regression a1c7c8dc-…:
    // «Регресс 3ccacc1c: облачка истории снова уходят в ▾ N после рестарта
    // клиента»). Re-add the button after every peel so its `rest.length`
    // label stays in sync with the dropdown count.
    const chipWidths = chips.map((c) => c.el.getBoundingClientRect().width);
    let plan = planHistoryChips(
      chipWidths,
      host.clientWidth,
      HISTORY_BAR_MORE_RESERVE,
      more.getBoundingClientRect().width,
    );
    while (plan.shownCount < shown.length) {
      const moved = shown.pop();
      if (moved === undefined) break;
      host.removeChild(moved.el);
      rest.unshift(moved);
      host.removeChild(more);
      more = buildMoreButton(rest.length, () => openHistoryMenu(rest, more));
      host.append(more);
      plan = planHistoryChips(
        chipWidths,
        host.clientWidth,
        HISTORY_BAR_MORE_RESERVE,
        more.getBoundingClientRect().width,
      );
    }
    // Last resort: the dropdown button itself overflows (the strip is
    // narrower than the button even alone — happens on very tight windows
    // and at first layout after a restart). Hide the button and let the
    // chips overflow the strip — better than seeing `▾ N` with nothing
    // beside it. The chips stay in `rest` so the next render can re-show
    // them when the strip grows.
    if (!plan.moreFits) {
      more.style.visibility = 'hidden';
    }
  }
}

/**
 * Splits a chip sequence into the chips that fit on the strip and the chips
 * that must move into the dropdown. Reserving {@link HISTORY_BAR_MORE_RESERVE}
 * of free space keeps the `▾ N` button visible whenever there is something
 * left to hide. When the host has not been laid out yet (clientWidth === 0)
 * we keep all chips on the strip — the next ResizeObserver tick will
 * recompute.
 */
function layoutChips<T extends { el: HTMLElement }>(
  chips: T[],
): { shown: T[]; rest: T[] } {
  if (host === null) return { shown: chips, rest: [] };
  // Append every chip, then peel from the tail until the strip fits with the
  // dropdown reserve accounted for. Single measurement per chip keeps this
  // O(n) and avoids per-iteration reflow thrash.
  for (const chip of chips) host.append(chip.el);
  const clientWidth = host.clientWidth;
  if (clientWidth <= 0) return { shown: chips.slice(), rest: [] };
  let shownCount = chips.length;
  const targetWithMore = clientWidth - HISTORY_BAR_MORE_RESERVE;
  while (shownCount > 0 && host.scrollWidth > targetWithMore) {
    shownCount--;
    host.removeChild(chips[shownCount]!.el);
  }
  return {
    shown: chips.slice(0, shownCount),
    rest: chips.slice(shownCount),
  };
}

/** Opens the dropdown for a list of history chips (thought refs). */
function openHistoryMenu(
  rest: Array<{ id: string; ref: import('@etn/shared').ThoughtRef | undefined; el: HTMLElement }>,
  anchor: HTMLElement,
): void {
  const items: MenuItem[] = rest.map(({ id, ref }) => ({
    icon: buildDropdownIcon(ref),
    label: ref?.title ?? id,
    dragId: id,
    onClick: () => openEntry(id),
  }));
  const rect = anchor.getBoundingClientRect();
  const root = showMenuAt(rect.left, rect.bottom + 2, items);
  styleDropdownRows(root, rest.map((r) => r.ref));
  // Dropdown rows drag onto the canvas like the mini-clouds (§11.1).
  for (const row of root.querySelectorAll<HTMLElement>('.menu-item')) {
    const rowId = row.dataset['dragId'];
    if (rowId !== undefined) {
      wireExternalDragSource(row, rowId, 'history', { fromMenu: true });
    }
  }
}

/**
 * Builds the icon node shown in a history dropdown row. Mirrors the
 * search-panel rendering (08-ui-spec.md §6.7): a real `mini-icon` node with
 * the same icon/image and font/fg/bg styles as the on-canvas cloud.
 */
function buildDropdownIcon(ref: import('@etn/shared').ThoughtRef | undefined): HTMLElement {
  const icon = el('span', 'mini-icon');
  if (ref !== undefined) {
    applyThoughtIcon(icon, ref);
  } else {
    icon.textContent = '💭';
  }
  return icon;
}

/**
 * Applies cloud-style classes (`font-*`, `dim`) to the dropdown rows after
 * they are built — `showMenuAt` builds rows internally, so we walk them
 * here in the same order as the items.
 */
function styleDropdownRows(
  root: HTMLElement,
  refs: Array<import('@etn/shared').ThoughtRef | undefined>,
): void {
  const rows = root.querySelectorAll<HTMLElement>(':scope > .menu-item');
  refs.forEach((ref, index) => {
    const row = rows[index];
    if (row === undefined || ref === undefined) return;
    applyCloudStyle(row, resolveCloudStyle(ref));
    if (!ref.active || ref.marked_for_deletion) row.classList.add('dim');
  });
}

/** Builds the `▾ N` button anchored to the right edge of the visible chips. */
function buildMoreButton(count: number, onClick: () => void): HTMLElement {
  const more = button('', onClick, 'history-more', 'Остальная история');
  more.append(svgIcon('chevron-down', 11), span(` ${count}`));
  return more;
}

/** Resolves metadata for history ids (single batched call). */
async function resolveRefs(
  networkId: string,
  ids: string[],
): Promise<Map<string, import('@etn/shared').ThoughtRef>> {
  try {
    const resolved = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    return new Map(resolved.map((ref) => [ref.id, ref]));
  } catch {
    return new Map();
  }
}

/** Builds a history mini-cloud chip. */
function buildChip(id: string, ref: import('@etn/shared').ThoughtRef | undefined): HTMLElement {
  const chip = div('history-cloud');
  chip.dataset['id'] = id;
  if (ref !== undefined) {
    applyCloudStyle(chip, resolveCloudStyle(ref));
  }
  if (ref !== undefined && !ref.active) chip.classList.add('dim');
  const icon = el('span', 'mini-icon');
  if (ref !== undefined) {
    applyThoughtIcon(icon, ref);
  } else {
    icon.textContent = '💭';
  }
  const title = el('span', 'hc-title', clip(ref?.title ?? id, CHIP_TITLE_LIMIT));
  setTooltip(chip, ref?.title ?? id);
  chip.append(icon, title);
  // A thought in the trash (S13, §5a.2): the mini-cloud dims and carries the
  // red trash glyph — the same marked reading as the canvas badge, scaled
  // down to the strip.
  if (ref?.marked_for_deletion === true) {
    chip.classList.add('dim');
    chip.append(buildTrashMark());
  }
  chip.addEventListener('click', () => openEntry(id));
  return chip;
}

/** Builds the small red trash glyph appended to marked history mini-clouds. */
function buildTrashMark(): HTMLElement {
  const mark = span('', 'list-trash-mark');
  mark.append(svgIcon('trash', 11));
  return mark;
}
