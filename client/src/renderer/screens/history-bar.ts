/**
 * Visit history in the status bar (H7, 08-ui-spec.md §11.1/§15.9,
 * 11-settings-and-state.md §2.3, 09-scenarios.md B4):
 *
 * `[ ← ] [облачко₁] [облачко₂] [облачко₃] [▾ N]`
 *
 * - each view has its own local history (L4): the map keeps thoughts that were
 *   in the canvas focus, the structures keep thoughts opened in the editor —
 *   the bar shows the history of the ACTIVE view (L15);
 * - the three freshest thoughts render as mini clouds (icon + ~40-char title,
 *   colors from the thought/type, dimmed when inactive);
 * - `▾ N` opens a dropdown with the remaining entries; N = 0 hides the button;
 * - empty history hides the area entirely;
 * - entries are resolved via `thoughts.resolve` (id → metadata); deleted
 *   thoughts were already pruned locally by the main-process applier, and
 *   inactive thoughts are hidden while `show_inactive` is off;
 * - clicking an entry switches the focus (map view) or opens the thought in
 *   the editor without moving the canvas focus (structures view);
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
import { applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';
import { registerDropActions, wireExternalDragSource } from '../canvas/drag-cloud.js';
import { openStructuresThought } from './structures/structures.js';
import { openChronicleLinkById, openChronicleThought } from './chronicle/chronicle.js';

/** Max title length inside a history mini-cloud. */
const TITLE_LIMIT = 40;
/** How many entries the dropdown shows at once. */
const HISTORY_LIMIT = 50;

let host: HTMLElement | null = null;
/** Signature of the inputs the bar depends on — avoids redundant re-renders. */
let lastSignature = '';

/** Mounts the history bar into the status bar host. */
export function mountHistoryBar(historyHost: HTMLElement): void {
  host = historyHost;
  // Canvas drags dropped onto the bar (or the history dropdown) open the
  // dragged thought like a click on a history entry (08-ui-spec.md §11.1).
  registerDropActions({ openEntry });
  store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
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
  const signature = `${profileId ?? ''}|${networkId ?? ''}|${view}|${currentId() ?? ''}|${String(store.state.showInactive)}`;
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

  const shown = visible.slice(0, 3);
  const rest = visible.slice(3);

  for (const id of shown) {
    host.append(buildChip(id, refs.get(id)));
  }

  if (rest.length > 0) {
    const more = button(
      '',
      () => {
        const items: MenuItem[] = rest.map((id) => {
          const ref = refs.get(id);
          return {
            label: `${ref?.icon ?? '💭'} ${ref?.title ?? id}`.slice(0, TITLE_LIMIT),
            onClick: () => openEntry(id),
            dragId: id,
          };
        });
        const rect = more.getBoundingClientRect();
        const root = showMenuAt(rect.left, rect.top - rest.length * 30 - 8, items);
        // Dropdown rows drag onto the canvas like the mini-clouds (§11.1).
        for (const row of root.querySelectorAll<HTMLElement>('.menu-item')) {
          const rowId = row.dataset['dragId'];
          if (rowId !== undefined) {
            wireExternalDragSource(row, rowId, 'history', { fromMenu: true });
          }
        }
      },
      'history-more',
      'Остальная история',
    );
    more.append(svgIcon('chevron-down', 11), span(` ${rest.length}`));
    host.append(more);
  }
}

/** A chronicle history entry: a thought or a link. */
type ChronicleHistoryEntry = { kind: 'thought' | 'link'; id: string };

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

  const shown = entries.slice(0, 3);
  const rest = entries.slice(3);

  for (const entry of shown) {
    if (entry.kind === 'thought') {
      const chip = buildChip(entry.id, refs.get(entry.id));
      wireExternalDragSource(chip, entry.id, 'history');
      host.append(chip);
    } else {
      host.append(buildLinkChip(entry.id, linkLabels.get(entry.id) ?? '🔗'));
    }
  }

  if (rest.length > 0) {
    const more = button(
      '',
      () => {
        const items: MenuItem[] = rest.map((entry) => ({
          label:
            entry.kind === 'thought'
              ? `${refs.get(entry.id)?.icon ?? '💭'} ${refs.get(entry.id)?.title ?? entry.id}`.slice(0, TITLE_LIMIT)
              : `🔗 ${linkLabels.get(entry.id) ?? entry.id}`.slice(0, TITLE_LIMIT),
          onClick: () => openChronicleEntry(entry),
          dragId: entry.kind === 'thought' ? entry.id : undefined,
        }));
        const rect = more.getBoundingClientRect();
        const root = showMenuAt(rect.left, rect.top - rest.length * 30 - 8, items);
        for (const row of root.querySelectorAll<HTMLElement>('.menu-item')) {
          const rowId = row.dataset['dragId'];
          if (rowId !== undefined) {
            wireExternalDragSource(row, rowId, 'history', { fromMenu: true });
          }
        }
      },
      'history-more',
      'Остальная история',
    );
    more.append(svgIcon('chevron-down', 11), span(` ${rest.length}`));
    host.append(more);
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
  chip.append(el('span', 'mini-icon', '🔗'), el('span', 'hc-title', label.slice(0, TITLE_LIMIT)));
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
  const title = el('span', 'hc-title', (ref?.title ?? id).slice(0, TITLE_LIMIT));
  setTooltip(chip, ref?.title ?? id);
  chip.append(icon, title);
  chip.addEventListener('click', () => openEntry(id));
  return chip;
}
