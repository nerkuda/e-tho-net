/**
 * Pinned-thoughts panel in the top toolbar (L18, 08-ui-spec.md §16).
 *
 * `[ 📌 облачко₁ … облачкоₙ  ▾ N ]` — visible in both workspace views, right
 * after the view switcher. The pinned list itself lives on the server
 * (L3, per-user × network); this module renders it and owns the panel
 * interactions:
 *
 * - chips: icon + ≤64-char title, thought/type colours, dimmed when inactive;
 *   inactive pins are hidden while `show_inactive` is off (like the history);
 * - overflow: chips that don't fit on the row move into a dropdown («▾ N»)
 *   like the history dropdown; rows drag onto the canvas as well;
 * - click: the map view focuses the thought (the editor follows), the
 *   structures view opens it in the editor and highlights it in the tree;
 * - right-click: the same thought context menu as on the canvas;
 * - drag-n-drop: chips drag onto the canvas/selection/history by the standard
 *   rules (the pin survives); dropping a thought onto the panel pins it at the
 *   drop position — re-pinning a pinned thought reorders it.
 */

import type { ThoughtRef } from '@etn/shared';

import { setFocus } from '../app.js';
import { applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';
import { showThoughtContextMenu } from '../canvas/context-menu.js';
import { registerDropActions, wireExternalDragSource } from '../canvas/drag-cloud.js';
import { button, clear, div, el, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { markThoughtCommentPreview } from '../lib/hover-preview.js';
import { svgIcon } from '../lib/icons.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { pinAt } from '../pinned/pins.js';
import { store } from '../state.js';
import { openStructuresThought } from './structures/structures.js';
import { openChronicleThought } from './chronicle/chronicle.js';

/** Max title length inside a pinned chip (08-ui-spec.md §16). */
const TITLE_LIMIT = 64;

let host: HTMLElement | null = null;
/** Signature of the inputs the panel depends on — avoids redundant re-renders. */
let lastSignature = '';
/** Resolved chip metadata, reused across renders and evicted on updates. */
const refCache = new Map<string, ThoughtRef>();
/** Drop-position indicator shown while a drag hovers the panel. */
let insertMarker: HTMLElement | null = null;

/** Mounts the panel into the toolbar host (called from the workspace builder). */
export function mountPinnedBar(pinnedHost: HTMLElement): void {
  host = pinnedHost;
  registerDropActions({
    pinThought: (id, dropIndex) => void pinAt(id, dropIndex),
    resolvePinTarget,
    onDragEnd: hideInsertMarker,
  });
  store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
  // The toolbar width changes with the window — re-fit the chip row.
  new ResizeObserver(() => {
    lastSignature = '';
    if (host?.isConnected === true) void render();
  }).observe(pinnedHost);
  void render();
}

/**
 * Forces a re-render even when the inputs did not change — realtime
 * `thought.updated`/`thought.deleted` refresh the chip metadata (the pin list
 * itself updates through the store).
 */
export function invalidatePinnedBar(): void {
  lastSignature = '';
  if (host?.isConnected === true) void render();
}

/** Evicts one thought's metadata (its `thought.updated` event arrived). */
export function invalidatePinnedRef(thoughtId: string): void {
  refCache.delete(thoughtId);
}

/** Opens a pinned thought the way the active view implies (08-ui-spec.md §16). */
function openPinnedEntry(id: string): void {
  if (store.state.activeView === 'structures') {
    void openStructuresThought(id);
  } else if (store.state.activeView === 'chronicle') {
    void openChronicleThought(id);
  } else {
    void setFocus(id);
  }
}

/** Re-renders the panel from the store pin list + server metadata. */
async function render(): Promise<void> {
  if (host === null) return;
  const networkId = store.state.networkId;
  const pins = store.state.pins;
  const signature = `${networkId ?? ''}|${pins.join(',')}|${String(store.state.showInactive)}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  if (networkId === null) {
    clear(host);
    return;
  }
  const refs = await resolveRefs(networkId, pins);
  // A newer render may have started while we fetched — don't paint stale data.
  if (host === null || !host.isConnected || signature !== lastSignature) return;

  // Inactive pins follow the «Показывать неактуальное» setting (§16).
  const visible = pins.filter((id) => {
    const ref = refs.get(id);
    return store.state.showInactive || ref === undefined || ref.active;
  });

  clear(host);
  insertMarker = null;
  if (visible.length === 0) {
    const empty = div('pinned-empty');
    empty.append(
      span('📌', 'pinned-empty-icon'),
      span(pins.length === 0 ? 'закрепите мысль' : 'закреплённые скрыты', 'pinned-empty-label'),
    );
    host.append(empty);
    return;
  }

  // Chips in a row; those that don't fit move into the dropdown (§16).
  const chips = visible.map((id) => buildChip(id, refs.get(id)));
  const restIds: string[] = [];
  const more = button('', () => openOverflowMenu(restIds, refs), 'pinned-more', 'Остальные закреплённые');
  more.append(svgIcon('chevron-down', 11));
  for (const chip of chips) host.append(chip);
  host.append(more);
  while (chips.length > 1 && host.scrollWidth > host.clientWidth) {
    const removed = chips.pop();
    removed?.remove();
    restIds.unshift(visible[chips.length] ?? '');
    more.replaceChildren(svgIcon('chevron-down', 11), span(` ${restIds.length}`));
  }
  if (restIds.length === 0) more.remove();
}

/** The dropdown with the overflowing pins; rows drag like the chips (§16). */
function openOverflowMenu(restIds: string[], refs: Map<string, ThoughtRef>): void {
  const items: MenuItem[] = restIds.map((id) => {
    const ref = refs.get(id);
    return {
      label: `${ref?.icon ?? '💭'} ${ref?.title ?? id}`.slice(0, TITLE_LIMIT),
      onClick: () => openPinnedEntry(id),
      dragId: id,
    };
  });
  const buttonRect = host?.querySelector<HTMLElement>('.pinned-more')?.getBoundingClientRect();
  const x = buttonRect?.left ?? 8;
  const y = (buttonRect?.bottom ?? 56) + 4;
  const root = showMenuAt(x, y, items);
  root.classList.add('pinned-menu');
  for (const row of root.querySelectorAll<HTMLElement>('.menu-item')) {
    const rowId = row.dataset['dragId'];
    if (rowId !== undefined) {
      wireExternalDragSource(row, rowId, 'pinned', { fromMenu: true });
      // Same Ctrl-hover preview as the chips themselves — the overflow menu
      // rows are the same thoughts, just hidden from the bar.
      markThoughtCommentPreview(row, rowId, refs.get(rowId)?.title ?? rowId);
    }
  }
}

/**
 * Drop-target resolution for the drag gesture: a drop on the panel (or its
 * dropdown) pins at the drop position — between the chips, at the start or at
 * the end. Returns the insertion index in the FULL ordered list (hidden pins
 * included), or `null` when the point is not over the panel. While the cursor
 * is over the panel the insertion marker follows the resolved position; it is
 * hidden as soon as the drag leaves (or ends).
 *
 * Coordinate fallback: when the panel is empty its only child is `.pinned-empty`,
 * a small inline-flex chip — and `elementFromPoint` may return the surrounding
 * `.toolbar`/`.pinned-bar` background or some overlay above it instead of a
 * panel descendant (L18 fix). If the cursor is inside the panel rect we still
 * treat it as a drop on the panel so the empty panel is a valid target.
 */
function resolvePinTarget(
  el: HTMLElement,
  x: number,
  y: number,
): { dropIndex: number; highlightEl: HTMLElement } | null {
  const bar = el.closest<HTMLElement>('.pinned-bar');
  if (bar !== null && host !== null) {
    const pins = store.state.pins;
    const chips = Array.from(host.querySelectorAll<HTMLElement>('.pinned-chip[data-id]'));
    const barLeft = host.getBoundingClientRect().left;
    // Walk left → right: the drop lands before the first chip whose midpoint
    // is right of the cursor, after the last chip, or at the very end.
    let index = pins.length;
    let markerX = 10;
    for (const chip of chips) {
      const chipId = chip.dataset['id'];
      if (chipId === undefined) continue;
      const fullIndex = pins.indexOf(chipId);
      const rect = chip.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) {
        index = fullIndex;
        markerX = rect.left - barLeft - 5;
        break;
      }
      index = fullIndex + 1;
      markerX = rect.right - barLeft + 5;
    }
    showInsertMarker(markerX);
    return { dropIndex: index, highlightEl: bar };
  }
  // Coordinate fallback: cursor is over the panel but elementFromPoint did not
  // land on a panel descendant — typical when the panel is empty (only
  // `.pinned-empty` is a small inline chip) or when an overlay covers it.
  if (host !== null) {
    const rect = host.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
      const pins = store.state.pins;
      showInsertMarker(10);
      return { dropIndex: pins.length, highlightEl: host };
    }
  }
  const row = el.closest<HTMLElement>('.pinned-menu .menu-item[data-drag-id]');
  if (row !== null && row.parentElement !== null) {
    hideInsertMarker();
    const rows = Array.from(
      row.parentElement.querySelectorAll<HTMLElement>('.menu-item[data-drag-id]'),
    );
    const rowIndex = rows.indexOf(row);
    const chipCount = host?.querySelectorAll('.pinned-chip[data-id]').length ?? 0;
    return { dropIndex: chipCount + rowIndex, highlightEl: row };
  }
  hideInsertMarker();
  return null;
}

/** Shows the drop-position marker at the bar-relative x coordinate. */
function showInsertMarker(x: number): void {
  if (host === null) return;
  if (insertMarker === null) {
    insertMarker = div('pin-insert-marker');
    host.append(insertMarker);
  }
  insertMarker.style.left = `${Math.max(6, x)}px`;
}

/** Removes the drop-position marker. */
function hideInsertMarker(): void {
  insertMarker?.remove();
  insertMarker = null;
}

/** Resolves metadata for pin ids (one batched call; cached across renders). */
async function resolveRefs(networkId: string, ids: string[]): Promise<Map<string, ThoughtRef>> {
  const missing = ids.filter((id) => !refCache.has(id));
  if (missing.length > 0) {
    try {
      const resolved = await etn.thoughts.resolve(networkId, missing);
      for (const ref of resolved) refCache.set(ref.id, ref);
    } catch {
      // Metadata unavailable — render the ids as-is; the next render retries.
    }
  }
  const out = new Map<string, ThoughtRef>();
  for (const id of ids) {
    const ref = refCache.get(id);
    if (ref !== undefined) out.set(id, ref);
  }
  return out;
}

/** Builds a pinned chip (icon + ≤64-char title, thought styles, menus, drag). */
function buildChip(id: string, ref: ThoughtRef | undefined): HTMLElement {
  const chip = div('pinned-chip');
  chip.dataset['id'] = id;
  if (ref !== undefined && !ref.active) chip.classList.add('dim');
  if (ref !== undefined) {
    const style = resolveCloudStyle(ref);
    if (style.fg !== null) chip.style.color = style.fg;
    if (style.bg !== null) chip.style.background = style.bg;
    chip.classList.toggle('font-italic', style.italic);
  }
  const icon = el('span', 'mini-icon');
  if (ref !== undefined) {
    applyThoughtIcon(icon, ref);
  } else {
    icon.textContent = '💭';
  }
  const title = el('span', 'pc-title', (ref?.title ?? id).slice(0, TITLE_LIMIT));
  setTooltip(chip, ref?.title ?? id);
  chip.append(icon, title);
  // Stage 3: no per-indicator icons on a pinned chip — Ctrl+hover on the whole
  // chip shows the thought's permanent comment.
  markThoughtCommentPreview(chip, id, ref?.title ?? id);
  // A thought in the trash (S13, §5a.2): the chip dims and carries the red
  // trash glyph — the same marked reading as the canvas badge, chip-sized.
  if (ref?.marked_for_deletion === true) {
    chip.classList.add('dim');
    const mark = span('', 'list-trash-mark');
    mark.append(svgIcon('trash', 11));
    chip.append(mark);
  }
  chip.addEventListener('click', () => openPinnedEntry(id));
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showThoughtContextMenu(event, { id, title: ref?.title ?? id, dir: 'siblings' });
  });
  wireExternalDragSource(chip, id, 'pinned');
  return chip;
}
