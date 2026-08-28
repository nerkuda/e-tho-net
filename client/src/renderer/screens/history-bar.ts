/**
 * Visit history in the status bar (H7, 08-ui-spec.md §11.1/§15.9,
 * 11-settings-and-state.md §2.3, 09-scenarios.md B4):
 *
 * `[ ← ] [облачко₁] [облачко₂] … [▾ N]`
 *
 * - each view has its own local history (L4): the map keeps thoughts that were
 *   in the canvas focus, the structures keep thoughts opened in the editor,
 *   and the chronicle keeps thoughts/links touched in the chronicle —
 *   the bar shows the history of the ACTIVE view (L15);
 * - the bar claims the full free width of the status bar between the back
 *   button and the counts/zoom block; as many mini clouds are rendered as
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
 * - clicking an entry switches the focus (map view) or opens the thought in
 *   the editor without moving the canvas focus (structures/chronicle view);
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
import { applyCloudStyle, applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';
import { registerDropActions, wireExternalDragSource } from '../canvas/drag-cloud.js';
import { openStructuresThought } from './structures/structures.js';
import { openChronicleLinkById, openChronicleThought } from './chronicle/chronicle.js';

/**
 * Max title length inside a history mini-cloud (the chip on the bar). When the
 * title is longer we append an ellipsis so the chip stays a single line.
 */
const CHIP_TITLE_LIMIT = 24;
/** How many entries the dropdown source returns at once. */
const HISTORY_LIMIT = 50;
/**
 * Reserved free width for the `▾ N` button. We leave this much space on the
 * right of the strip before we start moving chips into the dropdown, so the
 * button never gets pushed off-screen when there is anything left to show.
 * Generous enough for a two-digit count.
 */
const MORE_BUTTON_RESERVE = 44;

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

/** Opens a history entry in the way its view implies (§15.9, §17). */
function openEntry(id: string): void {
  if (store.state.activeView === 'structures') {
    void openStructuresThought(id);
  } else if (store.state.activeView === 'chronicle') {
    void openChronicleThought(id);
  } else {
    void setFocus(id);
  }
}

/** The id excluded from the list as "current": the view's active thought. */
function currentId(): string | null {
  if (store.state.activeView === 'structures') {
    return store.state.structuresActiveThoughtId;
  }
  if (store.state.activeView === 'chronicle') {
    return null; // the chronicle history has no «current» entity (§17)
  }
  return store.state.focus?.focused.id ?? null;
}

/** Re-renders the history bar from the local history + server metadata. */
async function render(): Promise<void> {
  if (host === null) return;
  const profileId = store.state.profileId;
  const networkId = store.state.networkId;
  const view = store.state.activeView;
  // The width is part of the signature: the visible chip set depends on it.
  const signature = `${profileId ?? ''}|${networkId ?? ''}|${view}|${currentId() ?? ''}|${String(store.state.showInactive)}|${host.clientWidth}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  if (profileId === null || networkId === null) {
    clear(host);
    return;
  }

  if (view === 'chronicle') {
    await renderChronicle(profileId, networkId);
    return;
  }

  const entries = await etn.history.list(
    profileId,
    networkId,
    store.state.activeTabId,
    HISTORY_LIMIT,
    view === 'structures' ? 'structures' : 'focus',
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
    empty.textContent = view === 'structures' ? 'нет открытых мыслей' : 'нет предыдущих мыслей';
    host.append(empty);
    return;
  }

  const back = button('', () => {
    const first = visible[0];
    if (first !== undefined) openEntry(first);
  }, 'history-back', 'Назад к предыдущей мысли');
  back.append(svgIcon('arrow-left', 13));
  host.append(back);

  const chips = visible.map((id) => ({
    id,
    ref: refs.get(id),
    el: buildChip(id, refs.get(id)),
  }));
  const { shown, rest } = layoutChips(chips);
  for (const chip of shown) host.append(chip.el);

  if (rest.length > 0) {
    const more = buildMoreButton(rest.length, () => openHistoryMenu(rest, more));
    host.append(more);
    // If the button itself overflows, peel one more chip and re-add it.
    if (host.scrollWidth > host.clientWidth) {
      host.removeChild(more);
      const moved = shown.pop();
      if (moved !== undefined) {
        host.removeChild(moved.el);
        rest.unshift(moved);
      }
      host.append(buildMoreButton(rest.length, () => openHistoryMenu(rest, more)));
    }
  }
}

/** A chronicle history entry: a thought or a link. */
type ChronicleHistoryEntry = { kind: 'thought' | 'link'; id: string };

/**
 * Splits a chip sequence into the chips that fit on the strip and the chips
 * that must move into the dropdown. Reserving {@link MORE_BUTTON_RESERVE} of
 * free space keeps the `▾ N` button visible whenever there is something left
 * to hide. When the host has not been laid out yet (clientWidth === 0) we keep
 * all chips on the strip — the next ResizeObserver tick will recompute.
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
  const targetWithMore = clientWidth - MORE_BUTTON_RESERVE;
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

/** Opens the dropdown for chronicle history entries (thoughts + links). */
function openChronicleMenu(
  rest: ChronicleHistoryEntry[],
  refs: Map<string, import('@etn/shared').ThoughtRef>,
  linkLabels: Map<string, string>,
  anchor: HTMLElement,
): void {
  const items: MenuItem[] = rest.map((entry) => {
    if (entry.kind === 'thought') {
      const ref = refs.get(entry.id);
      return {
        icon: buildDropdownIcon(ref),
        label: ref?.title ?? entry.id,
        dragId: entry.id,
        onClick: () => void openChronicleThought(entry.id),
      };
    }
    return {
      icon: '🔗',
      label: linkLabels.get(entry.id) ?? entry.id,
      onClick: () => void openChronicleLinkById(entry.id),
    };
  });
  const rect = anchor.getBoundingClientRect();
  const root = showMenuAt(rect.left, rect.bottom + 2, items);
  styleDropdownRows(root, rest.map((entry) => (entry.kind === 'thought' ? refs.get(entry.id) : undefined)));
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

/** Renders the chronicle view's own history (thoughts AND links, §17). */
async function renderChronicle(profileId: string, networkId: string): Promise<void> {
  const entries = await etn.history.chronicleList(
    profileId,
    networkId,
    store.state.activeTabId,
    HISTORY_LIMIT,
  );
  if (host === null || !host.isConnected) return;

  clear(host);
  if (entries.length === 0) {
    const empty = div('history-empty');
    empty.textContent = 'нет открытых мыслей и связей';
    host.append(empty);
    return;
  }

  const back = button('', () => {
    const first = entries[0];
    if (first !== undefined) openChronicleEntry(first);
  }, 'history-back', 'Назад к предыдущей записи');
  back.append(svgIcon('arrow-left', 13));
  host.append(back);

  const thoughtIds = entries.filter((e) => e.kind === 'thought').map((e) => e.id);
  const refs = thoughtIds.length > 0 ? await resolveRefs(networkId, thoughtIds) : new Map();
  const linkLabels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === 'link' && !linkLabels.has(entry.id)) {
      linkLabels.set(entry.id, await resolveLinkLabel(networkId, entry.id));
    }
  }

  const chips = entries.map((entry) => ({
    entry,
    el:
      entry.kind === 'thought'
        ? buildChip(entry.id, refs.get(entry.id))
        : buildLinkChip(entry.id, linkLabels.get(entry.id) ?? '🔗'),
  }));
  const { shown, rest } = layoutChips(chips);
  for (const chip of shown) host.append(chip.el);

  if (rest.length > 0) {
    const more = buildMoreButton(rest.length, () =>
      openChronicleMenu(
        rest.map((c) => c.entry),
        refs,
        linkLabels,
        more,
      ),
    );
    host.append(more);
    if (host.scrollWidth > host.clientWidth) {
      host.removeChild(more);
      const moved = shown.pop();
      if (moved !== undefined) {
        host.removeChild(moved.el);
        rest.unshift(moved);
      }
      host.append(
        buildMoreButton(rest.length, () =>
          openChronicleMenu(
            rest.map((c) => c.entry),
            refs,
            linkLabels,
            more,
          ),
        ),
      );
    }
  }
}

/** Opens a chronicle history entry (thought or link) in the editor. */
function openChronicleEntry(entry: ChronicleHistoryEntry): void {
  if (entry.kind === 'thought') void openChronicleThought(entry.id);
  else void openChronicleLinkById(entry.id);
}

/** Resolves the display label of a link history entry («источник — назначение»). */
async function resolveLinkLabel(networkId: string, linkId: string): Promise<string> {
  try {
    const link = await etn.links.get(networkId, linkId);
    const refs = await etn.thoughts.resolve(networkId, [link.source_id, link.target_id]);
    const src = refs.find((r) => r.id === link.source_id);
    const dst = refs.find((r) => r.id === link.target_id);
    return `${src?.title ?? link.source_id} → ${dst?.title ?? link.target_id}`;
  } catch {
    return linkId;
  }
}

/** Builds a link mini-chip of the chronicle history. */
function buildLinkChip(id: string, label: string): HTMLElement {
  const chip = div('history-cloud');
  chip.dataset['id'] = id;
  chip.append(el('span', 'mini-icon', '🔗'), el('span', 'hc-title', clip(label, CHIP_TITLE_LIMIT)));
  setTooltip(chip, label);
  chip.addEventListener('click', () => void openChronicleLinkById(id));
  return chip;
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
