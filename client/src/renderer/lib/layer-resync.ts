/**
 * Pure layer-switch resync helpers — the focus side of
 * `resyncAfterLayerSwitch` (app.ts).
 *
 * Lives in `lib/` (no canvas/editor dependency) so unit tests can exercise
 * the focus reset path without pulling the whole DOM stack. App.ts still
 * owns the canvas-cache invalidation calls — those are a separate concern.
 *
 * The focus side is what fixes ETN error dc4e0c07 «Переключение слоя не
 * сбрасывает открытый редактор мысли: сырая ошибка not found вместо
 * корректного состояния»: when a layer switch leaves the previously
 * focused thought without a row in the new layer (a thought that exists
 * only in a non-base layer that the tab just left), the server returns
 * 404 from `thoughts.focus` — without recovery the editor keeps the
 * stale entity from the previous layer's context and every property
 * fetch 404s with a raw server string visible in the UI. Falling back
 * to HOME (the only row guaranteed in every layer) gives the editor a
 * valid target in the new layer.
 */

import type { FocusResponse, Thought } from '@etn/shared';

import { etn } from './etn.js';
import { store } from '../state.js';

/**
 * Finds the protected HOME (root) thought of a freshly opened network. The
 * root is identified by the `is_root` flag, not by its title — the home
 * thought may be renamed (e.g. to the network's own name), so a title
 * search would miss it. The structural query with an empty filter returns
 * exactly the root thought (03-server-api.md §6.10).
 *
 * (Mirrors `findRootThought` in app.ts — duplicated here to keep this
 * module canvas-free; the copy is short and stable.)
 */
export async function findRootThought(networkId: string): Promise<Thought> {
  const result = await etn.structures.query(networkId, {
    sort: 'alpha',
    order: 'asc',
    limit: 1,
    offset: 0,
  });
  const root = result.items[0];
  if (root === undefined) {
    throw new Error('Не удалось найти корневую мысль этой сети.');
  }
  return etn.thoughts.get(networkId, root.id);
}

/**
 * Derives the per-zone sort and display order from a focus response, so the
 * cloud drag module can decide reorder-vs-bounce-back and rebuild an order.
 */
export function zoneStateFromFocus(response: FocusResponse): {
  zoneSorts: FocusResponse['sorts'];
  zoneOrder: { parents: string[]; children: string[] };
} {
  const order = (arr: typeof response.parents): string[] => [...new Set(arr.map((n) => n.id))];
  return {
    zoneSorts: response.sorts,
    zoneOrder: { parents: order(response.parents), children: order(response.children) },
  };
}

/**
 * Initialise `user_focus_order` for any `manual`-sorted zone whose neighbours
 * all came back with `manual_position === null`. Best-effort — if it fails
 * the user can still reorder manually and the next refresh will see the
 * now-existing positions.
 */
export async function ensureManualPositionsInitialized(
  networkId: string,
  focusId: string,
  response: FocusResponse,
  zoneOrder: { parents: string[]; children: string[] },
): Promise<void> {
  for (const dir of ['parents', 'children'] as const) {
    if (response.sorts[dir].sort !== 'manual') continue;
    const neighbourArr = dir === 'parents' ? response.parents : response.children;
    if (neighbourArr.length === 0) continue;
    const allUnpositioned = neighbourArr.every((n) => n.manual_position === null);
    if (!allUnpositioned) continue;
    const ordered_ids = zoneOrder[dir];
    if (ordered_ids.length === 0) continue;
    try {
      await etn.thoughts.setFocusOrder(networkId, focusId, { dir, ordered_ids });
    } catch {
      // Best-effort — see the docstring above.
    }
  }
}

/**
 * Refetches the current focus without touching the focus history (used for
 * realtime refreshes and `resume.stale`).
 *
 * Returns the focus response on success, or `null` when the focused thought
 * is not present in the current layer (server returns 404). The caller
 * decides what to do in that case — typically `resetFocusToHome` for layer
 * switches, where HOME is the only row guaranteed in every layer.
 */
export async function refreshFocusOrNull(networkId: string): Promise<FocusResponse | null> {
  const focusId = store.state.focus?.focused.id;
  if (focusId === undefined) return null;
  try {
    const response: FocusResponse = await etn.thoughts.focus(networkId, focusId);
    const zoneState = zoneStateFromFocus(response);
    store.update({ focus: response, ...zoneState });
    void ensureManualPositionsInitialized(networkId, focusId, response, zoneState.zoneOrder).catch(
      () => undefined,
    );
    return response;
  } catch {
    return null;
  }
}

/**
 * Resets the workspace focus to the protected HOME thought of `networkId`.
 * Best-effort: if HOME itself can't be resolved (catalogue unreachable),
 * the previous focus is left as-is rather than wipe the workspace.
 *
 * Returns the new HOME focus response on success, `null` when HOME could
 * not be resolved. Caller must already be on the target layer — this
 * helper does NOT switch the server session.
 */
export async function resetFocusToHome(networkId: string): Promise<FocusResponse | null> {
  let home: Thought;
  try {
    home = await findRootThought(networkId);
  } catch {
    return null;
  }
  try {
    const response: FocusResponse = await etn.thoughts.focus(networkId, home.id);
    const zoneState = zoneStateFromFocus(response);
    store.update({ focus: response, ...zoneState });
    void ensureManualPositionsInitialized(networkId, home.id, response, zoneState.zoneOrder).catch(
      () => undefined,
    );
    return response;
  } catch {
    return null;
  }
}
