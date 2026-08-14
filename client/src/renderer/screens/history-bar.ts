/**
 * Focus history in the status bar (H7, 08-ui-spec.md §11.1,
 * 11-settings-and-state.md §2.3, 09-scenarios.md B4):
 *
 * `[ ← ] [облачко₁] [облачко₂] [облачко₃] [▾ N]`
 *
 * - the three freshest thoughts render as mini clouds (icon + ~40-char title,
 *   colors from the thought/type, dimmed when inactive);
 * - `▾ N` opens a dropdown with the remaining entries; N = 0 hides the button;
 * - empty history hides the area entirely;
 * - entries are resolved via `thoughts.resolve` (id → metadata); deleted
 *   thoughts were already pruned locally by the main-process applier, and
 *   inactive thoughts are hidden while `show_inactive` is off;
 * - clicking an entry is a normal focus switch: the current thought rotates
 *   into history and the clicked one becomes the focus (app.setFocus).
 */

import { setFocus } from '../app.js';
import { button, div, clear, el, setTooltip } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { store } from '../state.js';
import { applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';

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

/** Re-renders the history bar from the local history + server metadata. */
async function render(): Promise<void> {
  if (host === null) return;
  const profileId = store.state.profileId;
  const networkId = store.state.networkId;
  const signature = `${profileId ?? ''}|${networkId ?? ''}|${store.state.focus?.focused.id ?? ''}|${String(store.state.showInactive)}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  if (profileId === null || networkId === null) {
    clear(host);
    return;
  }

  const entries = await etn.history.list(profileId, networkId, HISTORY_LIMIT);
  if (host === null || !host.isConnected) return;
  const ids = entries.map((entry) => entry.thoughtId);

  const refs = ids.length > 0 ? await resolveRefs(networkId, ids) : new Map();
  const visible = ids.filter((id) => {
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

  const back = button(
    '←',
    () => {
      const first = visible[0];
      if (first !== undefined) void setFocus(first);
    },
    'history-back',
    'Назад к предыдущей мысли',
  );
  host.append(back);

  const shown = visible.slice(0, 3);
  const rest = visible.slice(3);

  for (const id of shown) {
    host.append(buildChip(id, refs.get(id)));
  }

  if (rest.length > 0) {
    const more = button(
      `▾ ${rest.length}`,
      () => {
        const items: MenuItem[] = rest.map((id) => {
          const ref = refs.get(id);
          return {
            label: `${ref?.icon ?? '💭'} ${ref?.title ?? id}`.slice(0, TITLE_LIMIT),
            onClick: () => void setFocus(id),
          };
        });
        const rect = more.getBoundingClientRect();
        showMenuAt(rect.left, rect.top - rest.length * 30 - 8, items);
      },
      'history-more',
      'Остальная история',
    );
    host.append(more);
  }
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
  const icon = el('span', 'hc-icon');
  if (ref !== undefined) {
    applyThoughtIcon(icon, ref);
  } else {
    icon.textContent = '💭';
  }
  const title = el('span', 'hc-title', (ref?.title ?? id).slice(0, TITLE_LIMIT));
  setTooltip(chip, ref?.title ?? id);
  chip.append(icon, title);
  chip.addEventListener('click', () => void setFocus(id));
  return chip;
}
