/**
 * Pinned-thoughts state operations (L18, 08-ui-spec.md §16).
 *
 * Shared by the pinned panel (`screens/pinned-bar.ts`) and the thought context
 * menus (`canvas/context-menu.ts`). Lives in its own module importing only
 * state/etn/lib code — the canvas menu builder and the panel both use it, and
 * neither may create an import cycle through the other.
 *
 * The list is stored on the server (L3, per-user × network): every mutation
 * replaces the whole ordered list via `PUT /pins`, mirrors the result into the
 * store and is synced to the user's other clients by the
 * `pinned-thoughts.updated` event (audience=user).
 */

import { PINNED_THOUGHTS_LIMIT } from '@etn/shared';

import { showDialog } from '../lib/dialog.js';
import { el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** True when the thought is pinned in the open network. */
export function isPinned(thoughtId: string): boolean {
  return store.state.pins.includes(thoughtId);
}

/**
 * Explains the 20-entry cap: the user must unpin something first
 * (08-ui-spec.md §16). Returns without changing the list.
 */
export function showPinLimitMessage(): void {
  showDialog({
    title: 'Закреплённые мысли',
    body: el(
      'div',
      'dialog-text',
      `Закрепить можно не более ${PINNED_THOUGHTS_LIMIT} мыслей. ` +
        'Сначала открепите лишние мысли из панели закреплённых.',
    ),
    buttons: [{ label: 'ОК', primary: true }],
  });
}

/** Persists the ordered list and mirrors it into the store. */
export async function setPins(networkId: string, orderedIds: string[]): Promise<boolean> {
  try {
    const entries = await etn.pins.set(networkId, orderedIds);
    store.update({ pins: entries.map((entry) => entry.thought_id) });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notice(`Не удалось изменить закреплённые: ${message}`, 'error');
    return false;
  }
}

/** Context-menu «Закрепить мысль»: appends to the end (08-ui-spec.md §16). */
export async function pinThought(thoughtId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || isPinned(thoughtId)) return;
  if (store.state.pins.length >= PINNED_THOUGHTS_LIMIT) {
    showPinLimitMessage();
    return;
  }
  await setPins(networkId, [...store.state.pins, thoughtId]);
}

/** Context-menu «Открепить мысль». */
export async function unpinThought(thoughtId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || !isPinned(thoughtId)) return;
  await setPins(
    networkId,
    store.state.pins.filter((id) => id !== thoughtId),
  );
}

/** Menu toggle used by the pinned-panel context menu. */
export async function togglePinned(thoughtId: string): Promise<void> {
  if (isPinned(thoughtId)) await unpinThought(thoughtId);
  else await pinThought(thoughtId);
}

/**
 * Pins the thought at `dropIndex` of the FULL ordered list (a drop onto the
 * pinned panel, 08-ui-spec.md §16). Re-pinning an already pinned thought moves
 * it — reordering between pinned thoughts works by dragging them inside the
 * panel. `dropIndex` is the insertion point BEFORE removal, so a move to the
 * right shifts back by one after the dragged id is taken out.
 */
export async function pinAt(thoughtId: string, dropIndex: number): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const pins = store.state.pins;
  const prevIndex = pins.indexOf(thoughtId);
  if (prevIndex === -1 && pins.length >= PINNED_THOUGHTS_LIMIT) {
    showPinLimitMessage();
    return;
  }
  const rest = pins.filter((id) => id !== thoughtId);
  let at = dropIndex;
  if (prevIndex !== -1 && prevIndex < dropIndex) at -= 1;
  at = Math.max(0, Math.min(rest.length, at));
  rest.splice(at, 0, thoughtId);
  await setPins(networkId, rest);
}
