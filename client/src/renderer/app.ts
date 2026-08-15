/**
 * Application controller: boot, connection, network opening, focus switching.
 *
 * Owns the top-level flows that span modules:
 *  - boot: pick the active profile → networks screen, or onboarding;
 *  - `openNetwork` (H3): network meta + L3/L4 state + initial focus;
 *  - `setFocus`/`refreshFocus` (H5): focus switching with history rotation;
 *  - `disconnect` (H18): back to onboarding.
 *
 * The canvas/editor/statusbar render from the store and subscribe to changes;
 * this module only mutates the store.
 */

import type { FocusResponse, Thought } from '@etn/shared';

import { closeDialog } from './lib/dialog.js';
import { etn } from './lib/etn.js';
import { closeMenu } from './lib/menu.js';
import { UI_STATE_KEY, PREF_KEY } from '@etn/shared';
import { applyCanvasZoom } from './canvas/canvas-zoom.js';
import {
  parseCanvasLayout,
  parseCanvasZoom,
  parseCollapsedGroups,
  parseCloudGap,
  parseCloudWidth,
  parseLinkTypeId,
  parseWindowLayout,
} from './lib/pure.js';
import { initRealtime, onRealtimeEvent, setRealtimeEffects } from './realtime.js';
import { applyRealtimeToUi } from './realtime-ui.js';
import { invalidateIndicators, invalidateRef } from './canvas/canvas.js';
import { invalidateHistoryBar } from './screens/history-bar.js';
import { showScreen } from './screens/screens.js';
import { store } from './state.js';

/** Debounce for coalescing realtime-triggered refreshes, ms. */
const REFRESH_DEBOUNCE_MS = 200;

let refreshTimer: number | null = null;

/**
 * Finds the protected HOME (root) thought of a freshly opened network. The API
 * has no dedicated root endpoint on MVP, so the client searches for candidates
 * titled HOME and picks the one with `is_root = 1`.
 */
async function findRootThought(networkId: string): Promise<Thought> {
  const result = await etn.thoughts.search(networkId, { q: 'HOME', scope: 'names', limit: 20 });
  const ids = result.by_names.map((hit) => hit.thought_id);
  for (const id of ids) {
    try {
      const thought = await etn.thoughts.get(networkId, id);
      if (thought.is_root) return thought;
    } catch {
      // Candidate disappeared — keep looking.
    }
  }
  throw new Error('Не удалось найти корневую мысль HOME в этой сети.');
}

/**
 * Opens a network (H3): loads L2 meta, L3 preferences and L4 ui_state, picks
 * the initial focus (stored focus → HOME) and mounts the workspace.
 */
export async function openNetwork(networkId: string): Promise<void> {
  const network = await etn.networks.open(networkId);
  const prefs = await etn.networks.getPreferences(networkId);
  const showInactivePref = prefs.find((p) => p.key === PREF_KEY.SHOW_INACTIVE);
  const showInactive =
    typeof showInactivePref?.value === 'boolean' ? showInactivePref.value : false;

  const [cloudWidthRaw, cloudGapRaw, posRaw, collapsedRaw, focusRaw, linkTypeRaw, layoutRaw, canvasLayoutRaw, canvasZoomRaw] =
    await Promise.all([
      etn.ui.getState(networkId, UI_STATE_KEY.CLOUD_WIDTH),
      etn.ui.getState(networkId, UI_STATE_KEY.CLOUD_GAP),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_POSITION),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_COLLAPSED_GROUPS),
      etn.ui.getState(networkId, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID),
      etn.ui.getState(networkId, UI_STATE_KEY.LAST_USED_LINK_TYPE_ID),
      etn.ui.getState(networkId, UI_STATE_KEY.WINDOW_LAYOUT),
      etn.ui.getState(networkId, UI_STATE_KEY.CANVAS_LAYOUT),
      etn.ui.getState(networkId, UI_STATE_KEY.CANVAS_ZOOM),
    ]);

  const editorPosition = (
    ['left', 'right', 'top', 'bottom', 'hidden'].includes(posRaw ?? '') ? posRaw : 'right'
  ) as 'left' | 'right' | 'top' | 'bottom' | 'hidden';

  const editorSize = parseWindowLayout(layoutRaw);
  const canvasLayout = parseCanvasLayout(canvasLayoutRaw);

  const [linkTypes, thoughtTypes] = await Promise.all([
    etn.types.listLinkTypes(networkId),
    etn.types.listThoughtTypes(networkId),
  ]);

  store.update({
    network,
    networkId,
    showInactive,
    cloudWidth: parseCloudWidth(cloudWidthRaw),
    cloudGap: parseCloudGap(cloudGapRaw),
    canvasZoom: parseCanvasZoom(canvasZoomRaw),
    editorPosition,
    editorW: editorSize.w,
    editorH: editorSize.h,
    zoneTopSplit: canvasLayout.topSplit,
    zoneChildrenShare: canvasLayout.childrenShare,
    collapsedGroups: parseCollapsedGroups(collapsedRaw),
    linkTypes,
    thoughtTypes,
    lastUsedLinkTypeId: parseLinkTypeId(linkTypeRaw),
    focus: null,
    selection: [],
    editorTarget: null,
  });

  showScreen('workspace');

  // Initial focus: stored L4 focus or the HOME thought.
  let initial: Thought | null = null;
  if (focusRaw !== null && focusRaw !== '') {
    try {
      initial = await etn.thoughts.get(networkId, focusRaw);
    } catch {
      initial = null; // stored focus vanished — fall through to HOME
    }
  }
  const targetId = initial?.id ?? (await findRootThought(networkId)).id;
  await setFocus(targetId);
}

/**
 * Derives the per-zone sort and display order from a focus response, so the
 * cloud drag module can decide reorder-vs-bounce-back and rebuild an order.
 */
function zoneStateFromFocus(response: FocusResponse): {
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
 * Focuses a thought (H5): fetches the focus response, rotates local history
 * (H7) and persists the L4 current-focus key.
 */
export async function setFocus(id: string): Promise<void> {
  const networkId = requireNetworkId();
  const oldId = store.state.focus?.focused.id ?? null;
  const response = await etn.thoughts.focus(networkId, id);
  // Rotate the local history BEFORE the store update: the history bar re-renders
  // from store changes, and a fire-and-forget rotate here loses the race — the
  // bar showed a pre-rotation snapshot (the new focus still listed, the
  // previous one missing). Awaiting the local SQLite write costs nothing.
  if (oldId !== null && oldId !== id) {
    await etn.history.rotate(oldId, id).catch(() => undefined);
  }
  store.update({ focus: response, editorTarget: null, selectedLinkId: null, ...zoneStateFromFocus(response) });
  void etn.ui.setState(networkId, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID, id).catch(() => undefined);
}

/**
 * Refetches the current focus without touching the focus history (used for
 * realtime refreshes and `resume.stale`).
 */
export async function refreshFocus(): Promise<void> {
  const networkId = store.state.networkId;
  const focusId = store.state.focus?.focused.id;
  if (networkId === null || focusId === undefined) return;
  const response: FocusResponse = await etn.thoughts.focus(networkId, focusId);
  store.update({ focus: response, ...zoneStateFromFocus(response) });
}

/** Coalesces consecutive refresh requests into one call. */
export function scheduleRefresh(): void {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshFocus().catch(() => undefined);
  }, REFRESH_DEBOUNCE_MS);
}

/** Returns to the network list (e.g. after `network-lost`). */
export function backToNetworks(): void {
  store.resetNetwork();
  showScreen('networks');
}

/** Switches to the network list after a successful connect (H2). */
export function openNetworkScreen(): void {
  showScreen('networks');
}

/** Disconnects the profile and returns to onboarding (H18 user menu). */
export async function disconnect(): Promise<void> {
  await etn.server.disconnect();
  store.resetNetwork();
  store.update({ me: null, profileId: null });
  showScreen('onboarding');
}

/** The current network id, or throws (callers require an open network). */
export function requireNetworkId(): string {
  const id = store.state.networkId;
  if (id === null) throw new Error('Сеть не открыта.');
  return id;
}

/**
 * Actor-side cleanup after deleting a thought (workplan L4). The server never
 * echoes `thought.deleted` to the acting client (04-realtime.md §5), so the
 * deleting client mirrors the applier's handling locally:
 *
 *   * the thought leaves the local focus history (after the rotation that
 *     `setFocus` performs), caches and the selection;
 *   * when the deleted thought was the focus, the focus moves to the freshest
 *     surviving history entry (the "previous" thought) or, failing that, to
 *     the protected root thought (HOME);
 *   * otherwise the canvas just refreshes (the thought leaves its zone).
 */
export async function onThoughtDeleted(deletedId: string): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const wasFocus = store.state.focus?.focused.id === deletedId;
  if (store.state.selection.includes(deletedId)) {
    store.update({ selection: store.state.selection.filter((id) => id !== deletedId) });
  }
  if (wasFocus) {
    const nextId = await pickFocusAfterDeletion(networkId, deletedId);
    if (nextId !== null) {
      try {
        await setFocus(nextId);
      } catch {
        // The picked thought vanished between validation and focus — HOME is
        // undeletable, fall back to it.
        try {
          await setFocus((await findRootThought(networkId)).id);
        } catch {
          // Nothing focusable — leave the UI as is (server will reconcile).
        }
      }
    }
  } else {
    scheduleRefresh();
  }
  // setFocus's rotation pushes the deleted id (as the old focus) back into the
  // history — prune it afterwards so it never lingers in «последние».
  await etn.history.remove(deletedId).catch(() => undefined);
  invalidateIndicators(deletedId);
  invalidateRef(deletedId);
  invalidateHistoryBar();
}

/**
 * Picks the next focus after the focused thought was deleted: the freshest
 * history entry that still exists, else the protected root (HOME).
 */
async function pickFocusAfterDeletion(
  networkId: string,
  deletedId: string,
): Promise<string | null> {
  const profileId = store.state.profileId;
  if (profileId !== null) {
    try {
      const entries = await etn.history.list(profileId, networkId, 10);
      for (const entry of entries) {
        if (entry.thoughtId === deletedId) continue;
        try {
          await etn.thoughts.get(networkId, entry.thoughtId);
          return entry.thoughtId;
        } catch {
          // Stale history entry — try the next one.
        }
      }
    } catch {
      // History unavailable — fall back to HOME.
    }
  }
  try {
    return (await findRootThought(networkId)).id;
  } catch {
    return null;
  }
}

/**
 * Boot: initialise realtime plumbing, then route to onboarding (no active
 * profile) or to the network list (active profile connects successfully).
 */
export async function boot(): Promise<void> {
  initRealtime();
  setRealtimeEffects({
    onStale: () => scheduleRefresh(),
    onFocusLost: () => {
      // Another user deleted our focused thought — same recovery as the
      // local delete: previous from the history, else HOME.
      const deletedId = store.state.focus?.focused.id;
      if (deletedId !== undefined) void onThoughtDeleted(deletedId);
    },
    onNetworkLost: () => backToNetworks(),
  });
  onRealtimeEvent(applyRealtimeToUi);

  const profiles = await etn.server.listProfiles();
  const active = profiles.find((p) => p.isActive);
  if (active !== undefined) {
    try {
      const me = await etn.server.connect(active.id);
      store.update({ profileId: active.id, me });
      showScreen('networks');
      return;
    } catch {
      // Connection failed (server down, key revoked) — onboarding offers a retry.
      store.update({ profileId: active.id, me: null });
      showScreen('onboarding');
      return;
    }
  }
  store.update({ profileId: null, me: null });
  showScreen('onboarding');
}

/** Global keyboard shortcuts (08-ui-spec.md §13): Ctrl+F, Escape, Ctrl+±/0. */
export function initKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      closeDialog();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'f') {
        if (store.state.screen === 'workspace') {
          event.preventDefault();
          document.querySelector<HTMLInputElement>('.search-input')?.focus();
        }
        return;
      }
      // Canvas zoom (L9): '+'/'=' (both main-row layouts), numpad 'Add';
      // '-'/'Subtract'; '0' resets. Workspace screen only.
      if (store.state.screen === 'workspace') {
        if (event.key === '+' || event.key === '=' || event.key === 'Add') {
          event.preventDefault();
          applyCanvasZoom('in');
          return;
        }
        if (event.key === '-' || event.key === 'Subtract') {
          event.preventDefault();
          applyCanvasZoom('out');
          return;
        }
        if (event.key === '0') {
          event.preventDefault();
          applyCanvasZoom('reset');
        }
      }
    }
  });
}
