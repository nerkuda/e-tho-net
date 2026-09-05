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

import { resyncAfterLayerSwitch, scheduleRefresh } from './app.js';
import { invalidateIndicators, invalidateRef } from './canvas/canvas.js';
import { etn } from './lib/etn.js';
import { invalidateHistoryBar } from './screens/history-bar.js';
import { invalidatePinnedBar, invalidatePinnedRef } from './screens/pinned-bar.js';
import {
  invalidateStructuresThought,
  scheduleStructuresRefresh,
} from './screens/structures/structures.js';
import { invalidateSavedFilters } from './screens/structures/filter-panel.js';
import { invalidateChronicleThought, scheduleChronicleRefresh } from './screens/chronicle/chronicle.js';
import { reloadSavedFilters as reloadChronicleSavedFilters } from './screens/chronicle/filter-panel.js';
import { store } from './state.js';
import { syncLayersForTab } from './screens/layers.js';
import { invalidateWikiLinkCache } from './editor/wiki-link-resolver.js';

/**
 * Tiny wrapper so the inline call sites above stay readable. Drops the cached
 * entry for a thought across all networks — the resolver repaints on the
 * next view render.
 */
function invalidateWikiLinkCacheById(thoughtId: string): void {
  invalidateWikiLinkCache(thoughtId);
}

/** Reloads both type catalogues into the store (L21 — the hierarchy changed). */
export async function reloadTypeCatalogues(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const [thoughtTypes, linkTypes] = await Promise.all([
      etn.types.listThoughtTypes(networkId),
      etn.types.listLinkTypes(networkId),
    ]);
    store.update({ thoughtTypes, linkTypes });
  } catch {
    // The network may have just been closed — ignore.
  }
}

/** True when the thought id participates in the current focus neighbourhood. */
export function inNeighbourhood(id: string): boolean {
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
      invalidateStructuresThought(evt.data.id);
      invalidateChronicleThought(evt.data.id);
      // R7: drop cached wiki-link titles for the deleted thought so any
      // visible ID-based link switches to the «deleted» muted style.
      invalidateWikiLinkCacheById(evt.data.id);
      // The pin row cascades on the server (FK ON DELETE CASCADE) without a
      // `pinned-thoughts.updated` event — drop the chip locally (L18).
      if (store.state.pins.includes(evt.data.id)) {
        store.update({ pins: store.state.pins.filter((id) => id !== evt.data.id) });
      }
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      break;

    case 'thought.created':
      if (inNeighbourhood(evt.data.thought.id)) scheduleRefresh();
      scheduleStructuresRefresh();
      scheduleChronicleRefresh();
      break;

    case 'thought.updated':
      invalidateRef(evt.data.id);
      // A pinned chip mirrors the thought's title/icon/styles — refresh it.
      if (store.state.pins.includes(evt.data.id)) {
        invalidatePinnedRef(evt.data.id);
        invalidatePinnedBar();
      }
      // R7: refresh wiki-link view-resolver cache for the renamed thought so
      // existing ID-based links in view-mode re-render with the new title.
      invalidateWikiLinkCacheById(evt.data.id);
      if (inNeighbourhood(evt.data.id)) scheduleRefresh();
      scheduleStructuresRefresh();
      scheduleChronicleRefresh();
      break;

    case 'thought.reordered':
    case 'link.created':
    case 'link.updated':
    case 'link.deleted':
    case 'property-value.set':
    case 'property-value.deleted':
      scheduleRefresh();
      scheduleStructuresRefresh();
      scheduleChronicleRefresh();
      break;

    case 'comment.created':
      // Comments are sub-objects of a thought/link and do NOT change the
      // focus response (parents/children/siblings/edges). Schedule a focus
      // refresh here and the editor would re-render on every comment write
      // anywhere in the neighbourhood — bug 206e33a1 «Бессмысленное
      // обновление редактора при получении внешних событий»: typing in the
      // comment field of an open thought would lose its in-progress edit to a
      // focus-refresh round-trip on every remote comment event. The editor
      // subscribes to `comment.*` itself and updates the open entity's
      // comment view in place; the canvas indicator below the cloud was
      // already invalidated by `invalidateIndicators`.
      invalidateIndicators(evt.data.comment.owner_id);
      scheduleChronicleRefresh();
      break;

    case 'comment.deleted':
      // Same reasoning as `comment.created`: never refresh focus for
      // comment events. The canvas indicator cache is invalidated above; the
      // editor's comment view is patched by its own listener.
      invalidateIndicators(evt.data.owner_id);
      scheduleChronicleRefresh();
      break;

    case 'comment.updated':
      // Same reasoning as `comment.created`/`comment.deleted`: never refresh
      // focus. The comment body lives on the entity, not in the focus
      // neighbourhood. The editor owns the comment view for its open entity
      // and updates it in place via its own `onRealtimeEvent` hook.
      invalidateIndicators(null);
      scheduleChronicleRefresh();
      break;

    case 'attachment.created':
      invalidateIndicators(evt.data.attachment.owner_id);
      if (inNeighbourhood(evt.data.attachment.owner_id)) scheduleRefresh();
      break;

    case 'attachment.updated':
    case 'attachment.deleted':
      // Same reasoning as `comment.*` (see above): attachments are
      // sub-objects of a thought/link and never change the focus response.
      // Calling `scheduleRefresh` here forced an unrelated store update on
      // every remote attachment write, which in turn fired the editor's
      // `store.subscribe` callback — bug 206e33a1. The canvas indicator
      // cache is invalidated; the editor owns its own «Вложения» tab and
      // updates it via its own realtime hook (attachments.ts).
      invalidateIndicators(null);
      break;

    case 'user-preference.updated':
      if (evt.data.key === 'show_inactive') {
        store.update({ showInactive: evt.data.value === true });
        scheduleRefresh();
        scheduleStructuresRefresh();
      }
      break;

    case 'user-focus-preferences.updated':
    case 'user-focus-order.updated':
      if (evt.data.focus_thought_id === store.state.focus?.focused.id) scheduleRefresh();
      break;

    case 'saved-filter.created':
    case 'saved-filter.updated':
    case 'saved-filter.deleted':
      // The user's other client changed a saved filter (audience=user) — the
      // local lists re-sync from the server (§15.3, §17).
      invalidateSavedFilters();
      void reloadChronicleSavedFilters();
      break;

    case 'pinned-thoughts.updated':
      // The user's other client changed the pinned list (audience=user) — the
      // event carries the full new order (L18, 08-ui-spec.md §16).
      store.update({ pins: evt.data.ordered_ids });
      break;

    case 'thought-type.created':
    case 'thought-type.updated':
    case 'thought-type.deleted':
    case 'link-type.created':
    case 'link-type.updated':
    case 'link-type.deleted':
    case 'property-definition.created':
    case 'property-definition.updated':
    case 'property-definition.deleted':
      // Another client changed the type catalogues (L21): reload both lists
      // and repaint everything that renders type styles/names.
      void reloadTypeCatalogues();
      scheduleRefresh();
      scheduleStructuresRefresh();
      scheduleChronicleRefresh();
      break;

    case 'network.updated': {
      const network = store.state.network;
      if (network !== null) store.update({ network: { ...network, ...evt.data } });
      break;
    }

    case 'layer.merged': {
      // S11 (04-realtime.md §11.4): a merge emits exactly one event and the
      // recipients resync fully — the visible state changed wholesale, so
      // re-read layers/overrides and drop the cached editor/structures
      // snapshots (13-layers.md §12: a layer change invalidates the whole
      // client cache, not just the canvas).
      const networkId = store.state.networkId;
      if (networkId !== null) {
        void syncLayersForTab(networkId, store.state.currentLayer?.id ?? null).then(() => {
          void resyncAfterLayerSwitch();
          scheduleStructuresRefresh();
          scheduleChronicleRefresh();
        });
      }
      break;
    }

    default:
      break;
  }
}
