/**
 * Realtime wiring for the renderer (G8/H-phase).
 *
 * Subscribes to `etn.realtime.*` and funnels events into the store:
 *  - status → `rtStatus` (🟢/🟡/🔴 indicator, H19 offline blocking);
 *  - events → narrowed via {@link isRealtimeEvent}, described for the status
 *    bar, then dispatched to every registered listener (canvas, editor,
 *    history bar, drafts…);
 *  - `resume.stale` → full re-focus request;
 *  - derived effects: `focus-lost` (focused thought deleted) and
 *    `network-lost` (network deleted or self removed from members).
 *
 * The main process already drops own-client echoes (G8 applier), so every event
 * reaching here is a change from another client or a server-side action.
 */

import type { AnyRealtimeEvent } from '@etn/shared';

import { etn } from './lib/etn.js';
import { describeEvent, isRealtimeEvent } from './lib/pure.js';
import { store, type RtStatus } from './state.js';
import { markTabDirty } from './screens/tabs/tab-state.js';

/** Application-level effect callbacks (registered by the app controller). */
export interface RealtimeEffects {
  /** `resume.stale` — the local event stream is behind; full re-focus needed. */
  onStale: () => void;
  /** The currently focused thought was deleted server-side. */
  onFocusLost: () => void;
  /** The open network is gone or the user lost membership. */
  onNetworkLost: () => void;
}

const effects: RealtimeEffects = {
  onStale: () => undefined,
  onFocusLost: () => undefined,
  onNetworkLost: () => undefined,
};

/** Event listeners — content modules register their own without clobbering. */
const eventListeners = new Set<(evt: AnyRealtimeEvent) => void>();

let initialized = false;
let hideTimer: number | null = null;

/** How long the "last event" text stays in the status bar, ms (08-ui-spec.md §11). */
const EVENT_TEXT_TTL_MS = 5_000;

/**
 * Registers/overrides the derived-effect callbacks (stale/focus-lost/
 * network-lost). Call at any time; subscriptions are created once.
 */
export function setRealtimeEffects(next: Partial<RealtimeEffects>): void {
  Object.assign(effects, next);
}

/**
 * Subscribes to accepted realtime events. Returns the unsubscribe function.
 */
export function onRealtimeEvent(listener: (evt: AnyRealtimeEvent) => void): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/** Connects the realtime bridge. Called once at boot. */
export function initRealtime(): void {
  if (initialized) return;
  initialized = true;

  etn.realtime.onStatusChange((payload) => {
    // Q2: payload is `{networkId, status}` from TabRealtimePool.
    const valid: RtStatus[] = ['idle', 'connecting', 'connected', 'reconnecting', 'offline'];
    const obj = payload as { networkId?: unknown; status?: unknown };
    const networkId = typeof obj.networkId === 'string' ? obj.networkId : null;
    const statusStr = typeof obj.status === 'string' ? obj.status : null;
    if (networkId === null || statusStr === null) return;
    const next: RtStatus = valid.includes(statusStr as RtStatus)
      ? (statusStr as RtStatus)
      : 'offline';
    const map = { ...store.state.rtStatusByNetwork, [networkId]: next };
    const active = store.state.networkId;
    const activeStatus =
      active !== null && map[active] !== undefined ? map[active]! : next;
    store.update({ rtStatusByNetwork: map, rtStatus: activeStatus });
  });

  etn.realtime.onStale((payload) => {
    // Q2: payload is `{networkId, lastSeq}` from TabRealtimePool.
    const obj = payload as { networkId?: unknown; lastSeq?: unknown };
    const networkId = typeof obj.networkId === 'string' ? obj.networkId : null;
    if (networkId === null) return;
    // UI-wide "stale" applies to the active network — non-active tabs lose
    // access silently (Q3/Q5 will surface them with the dirty marker).
    if (networkId !== store.state.networkId) return;
    effects.onStale();
  });

  etn.realtime.onEvent((raw: unknown) => {
    if (!isRealtimeEvent(raw)) return;
    const evt = raw;
    store.update({ lastEvent: describeEvent(evt) });
    scheduleEventHide();

    // Q4: mark every tab whose network received this event with a dirty
    // marker «*». The active tab also gets the marker (cleared on activation).
    const networkId = evt.network_id;
    for (const tab of store.state.tabs) {
      if (tab.network_id === networkId) markTabDirty(tab.tab_id);
    }

    // Derived effects (04-realtime.md §7, G8 applier contracts).
    if (evt.type === 'thought.deleted' && store.state.focus?.focused.id === evt.data.id) {
      effects.onFocusLost();
    }
    if (evt.type === 'network.deleted') {
      effects.onNetworkLost();
    }
    if (evt.type === 'member.removed' && store.state.me?.id === evt.data.user_id) {
      effects.onNetworkLost();
    }
    for (const listener of eventListeners) listener(evt);
  });
}

/** Hides the status-bar event text after the TTL. */
function scheduleEventHide(): void {
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    store.update({ lastEvent: null });
    hideTimer = null;
  }, EVENT_TEXT_TTL_MS);
}

/** True when the realtime connection is up (H19: saves allowed). */
export function isConnected(): boolean {
  return store.state.rtStatus === 'connected';
}
