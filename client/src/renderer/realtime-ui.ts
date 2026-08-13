/**
 * Realtime event application to the UI (G8 client side, H-phase):
 *
 * - thought/link changes near the current focus → debounced re-focus (the
 *   canvas/editor re-render from server truth);
 * - comment/attachment changes → indicator cache invalidation;
 * - `thought.deleted` → local history re-render (the main-process applier has
 *   already pruned the focus history);
 * - L3 user-scoped events (`show_inactive`, focus preferences/order) → store
 *   update + refresh;
 * - `network.updated` → patch the network meta in the store.
 *
 * Registered as a realtime listener in `app.boot`.
 */

import type { AnyRealtimeEvent } from '@etn/shared';

import { scheduleRefresh } from './app.js';
import { invalidateIndicators, invalidateRef } from './canvas/canvas.js';
import { invalidateHistoryBar } from './screens/history-bar.js';
import { store } from './state.js';

/** True when the thought id participates in the current focus neighbourhood. */
function inNeighbourhood(id: string): boolean {
  const focus = store.state.focus;
  if (focus === null) return false;
  return (
    focus.focused.id === id ||
    focus.parents.some((n) => n.id === id) ||
    focus.children.some((n) => n.id === id) ||
    focus.siblings.some((n) => n.id === id)
  );
}

/** Applies one accepted realtime event to the UI state. */
export function applyRealtimeToUi(evt: AnyRealtimeEvent): void {
  switch (evt.type) {
    case 'thought.deleted':
      invalidateIndicators(evt.data.id);
      invalidateRef(evt.data.id);
      invalidateHistoryBar();
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      break;

    case 'thought.created':
      if (inNeighbourhood(evt.data.thought.id)) scheduleRefresh();
      break;

    case 'thought.updated':
      invalidateRef(evt.data.id);
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      break;

    case 'thought.reordered':
    case 'link.created':
    case 'link.updated':
    case 'link.deleted':
    case 'property-value.set':
    case 'property-value.deleted':
      scheduleRefresh();
      break;

    case 'comment.created':
      invalidateIndicators(evt.data.comment.owner_id);
      if (inNeighbourhood(evt.data.comment.owner_id)) scheduleRefresh();
      break;

    case 'comment.deleted':
      invalidateIndicators(evt.data.owner_id);
      if (inNeighbourhood(evt.data.owner_id)) scheduleRefresh();
      break;

    case 'comment.updated':
      // The event carries no owner id — the editor listens itself; the canvas
      // only cares about counts, so refresh lazily.
      scheduleRefresh();
      break;

    case 'attachment.created':
      invalidateIndicators(evt.data.attachment.owner_id);
      if (inNeighbourhood(evt.data.attachment.owner_id)) scheduleRefresh();
      break;

    case 'attachment.updated':
    case 'attachment.deleted':
      invalidateIndicators(null);
      scheduleRefresh();
      break;

    case 'user-preference.updated':
      if (evt.data.key === 'show_inactive') {
        store.update({ showInactive: evt.data.value === true });
        scheduleRefresh();
      }
      break;

    case 'user-focus-preferences.updated':
    case 'user-focus-order.updated':
      if (evt.data.focus_thought_id === store.state.focus?.focused.id) scheduleRefresh();
      break;

    case 'network.updated': {
      const network = store.state.network;
      if (network !== null) store.update({ network: { ...network, ...evt.data } });
      break;
    }

    default:
      break;
  }
}
