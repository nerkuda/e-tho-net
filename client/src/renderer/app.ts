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

import { closeDialog, errorDialog } from './lib/dialog.js';
import { hasTextSelection } from './lib/dom.js';
import { etn } from './lib/etn.js';
import { closeMenu } from './lib/menu.js';
import { notice } from './lib/notice.js';
import { logUiEvent } from './lib/ui-log.js';
import { UI_STATE_KEY, PREF_KEY } from '@etn/shared';
import { applyCanvasZoom } from './canvas/canvas-zoom.js';
import { getCanvasCursor, resetCanvasCursor } from './canvas/kbd-nav.js';
import {
  defaultEventAreaW,
  parseCanvasLayout,
  parseCanvasZoom,
  parseCollapsedGroups,
  parseCloudGap,
  parseCloudWidth,
  parseLinkTypeId,
  parseListHeights,
  parseWindowLayout,
  pickMostRecentTab,
} from './lib/pure.js';
import { initListClamps } from './editor/list-heights.js';
import { noteThoughtRemoved, noteThoughtWillOpen } from './history.js';
import { initRealtime, onRealtimeEvent, setRealtimeEffects } from './realtime.js';
import { applyRealtimeToUi } from './realtime-ui.js';
import { initTheme } from './lib/theme.js';
import { initLayerTheme } from './lib/layer-colors.js';
import { initLockCache } from './lib/lock-cache.js';
import { scheduleChronicleRefresh } from './screens/chronicle/chronicle.js';
import { invalidateAllRefs, invalidateIndicators, invalidateRef } from './canvas/canvas.js';
import { invalidateHistoryBar } from './screens/history-bar.js';
import { refreshTabAccessibility } from './screens/tabs/tab-accessibility.js';
import { refreshSearchIfVisible } from './search/search.js';
import {
  invalidateStructuresThought,
  scheduleStructuresRefresh,
} from './screens/structures/structures.js';
import { showScreen } from './screens/screens.js';
import { store, type WorkspaceView } from './state.js';
import { syncLayersForTab } from './screens/layers.js';

/** Debounce for coalescing realtime-triggered refreshes, ms. */
const REFRESH_DEBOUNCE_MS = 200;

let refreshTimer: number | null = null;

/**
 * Finds the protected HOME (root) thought of a freshly opened network. The root
 * is identified by the `is_root` flag, not by its title — the home thought may
 * be renamed (e.g. to the network's own name), so a title search would miss it.
 * The structural query with an empty filter returns exactly the root thought
 * (03-server-api.md §6.10).
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
 * Opens a network (H3): loads L2 meta, L3 preferences and L4 ui_state, picks
 * the initial focus (stored focus → HOME) and mounts the workspace.
 *
 * When called with `tabId`, the per-tab snapshot (focus_id, view_mode)
 * takes priority over the legacy network-level L4 keys — duplicates of the
 * same network each get their own snapshot, and switching tabs inside the
 * workspace restores the right focus / view.
 */
export async function openNetwork(networkId: string, tabId?: string): Promise<void> {
  // The cursor lives on a cloud from the previously open network — drop it
  // before anything else, otherwise a quick Ctrl+V in the new network would
  // target an id that no longer exists on the map.
  resetCanvasCursor();
  const network = await etn.networks.open(networkId);
  const prefs = await etn.networks.getPreferences(networkId);
  const showInactivePref = prefs.find((p) => p.key === PREF_KEY.SHOW_INACTIVE);
  const showInactive =
    typeof showInactivePref?.value === 'boolean' ? showInactivePref.value : false;

  const [cloudWidthRaw, cloudGapRaw, posRaw, collapsedRaw, focusRaw, linkTypeRaw, layoutRaw, canvasLayoutRaw, canvasZoomRaw, activeViewRaw, pinsRaw, heightsRaw, chronicleHeightsRaw] =
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
      etn.ui.getState(networkId, UI_STATE_KEY.ACTIVE_VIEW),
      etn.pins.list(networkId),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_LIST_HEIGHTS),
      etn.ui.getState(networkId, UI_STATE_KEY.CHRONICLE_LIST_HEIGHTS),
    ]);

  const editorPosition = (
    ['left', 'right', 'top', 'bottom', 'hidden'].includes(posRaw ?? '') ? posRaw : 'right'
  ) as 'left' | 'right' | 'top' | 'bottom' | 'hidden';

  const editorSize = parseWindowLayout(layoutRaw);
  // Status-bar event-area width: older payloads have no `e` key (the field
  // was introduced to fix the bottom-bar jitter — see bug de07e690-…). In
  // that case we fall back to the current window's default so the area lands
  // at `max(200px, 18%)` without waiting for the first drag.
  const eventAreaW = editorSize.e ?? defaultEventAreaW(window.innerWidth);
  const canvasLayout = parseCanvasLayout(canvasLayoutRaw);
  // Saved list max-heights (ee745368): both L4 blobs merge into one map —
  // the editor applies its keys as --clamp-* variables on the scroll box,
  // the chronicle screen clamps its areas inline on mount (persistKeys are
  // namespaced: `chronicle.*` vs the editor keys).
  initListClamps({
    ...parseListHeights(heightsRaw),
    ...parseListHeights(chronicleHeightsRaw),
  });

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
    selectionW: editorSize.s,
    eventAreaW,
    zoneTopSplit: canvasLayout.topSplit,
    zoneChildrenShare: canvasLayout.childrenShare,
    collapsedGroups: parseCollapsedGroups(collapsedRaw),
    linkTypes,
    thoughtTypes,
    lastUsedLinkTypeId: parseLinkTypeId(linkTypeRaw),
    focus: null,
    selection: [],
    editorTarget: null,
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
    pins: (pinsRaw ?? []).map((p) => p.thought_id),
  });

  // Q3: refresh tab list and activate the right entry. When the caller
  // supplies `tabId` (the picker / tab activation), that exact tab wins —
  // duplicate opens of the same network don't collapse onto the first
  // existing tab.
  let activeTabId: string | null = null;
  let activeTabView: WorkspaceView | null = null;
  let activeTabFocusId: string | null = null;
  let activeTabLayerId: string | null = null;
  try {
    let tabs = await etn.tabs.list();
    let target: { tab_id: string } | null = null;
    if (tabId !== undefined) {
      target = tabs.find((t) => t.tab_id === tabId) ?? null;
    }
    // No matching tab yet? The networks screen entry opens without a tab —
    // create one so the strip populates. Duplicates are explicit and
    // re-openings of the same network still create a fresh tab.
    if (target === null) {
      const fresh = await etn.tabs.open(networkId);
      tabs = await etn.tabs.list();
      target = tabs.find((t) => t.tab_id === fresh.tab_id) ?? { tab_id: fresh.tab_id };
    }
    const fullTarget = tabs.find((t) => t.tab_id === target!.tab_id) ?? null;
    activeTabId = fullTarget?.tab_id ?? target!.tab_id;
    activeTabView = fullTarget?.view_mode ?? null;
    activeTabFocusId = fullTarget?.focus_id ?? null;
    activeTabLayerId = fullTarget?.layer_id ?? null;
    store.update({
      tabs,
      activeTabId,
    });
  } catch {
    // ignore — workspace still usable without tab strip state
  }

  // S11 (13-layers.md §10.3): the layer is a property of the TAB. Align the
  // server-side session to the tab's layer BEFORE the focus loads — the focus
  // (and every later read/write) must resolve in this tab's layer, not in
  // whatever layer the previous tab left behind. Failures keep the base layer
  // and an empty layer list; the menu recovers on the next open.
  try {
    await syncLayersForTab(networkId, activeTabLayerId);
  } catch {
    // offline / layer deleted elsewhere — the workspace stays usable
  }

  // Q-bugfix: per-tab view_mode takes priority over the legacy L4 key, so
  // switching tabs inside a network actually swaps the view (not just the
  // highlighted tab).
  const viewFromTab = activeTabView;
  const resolvedView: WorkspaceView =
    viewFromTab === 'structures' || viewFromTab === 'chronicle'
      ? viewFromTab
      : activeViewRaw === 'structures' || activeViewRaw === 'chronicle'
        ? activeViewRaw
        : 'map';
  store.update({ activeView: resolvedView });

  showScreen('workspace');

  // Q-bugfix: per-tab focus_id takes priority over the legacy L4 key. The
  // tab's focus was already persisted by the previous `setFocus` call (or by
  // a previous session), so we just LOAD it — `loadFocusForTab` does not
  // rotate the per-tab history and does not re-persist.
  let initial: Thought | null = null;
  const preferredFocusId = activeTabFocusId ?? focusRaw;
  if (preferredFocusId !== null && preferredFocusId !== '') {
    try {
      initial = await etn.thoughts.get(networkId, preferredFocusId);
    } catch {
      initial = null; // stored focus vanished — fall through to HOME
    }
  }
  if (initial !== null) {
    await loadFocusForTab(initial.id, networkId, activeTabId);
  } else {
    const root = await findRootThought(networkId);
    await loadFocusForTab(root.id, networkId, activeTabId);
  }

  // 8efd5cf8 (Q5): `store.tabs` is only populated HERE — the accessibility
  // pass fired right after `server.connect` (boot / restoreSession) runs
  // against an empty tab list and marks nothing, so a tab whose network died
  // while the client was away stays unmarked until the «+» picker happens to
  // open. Re-running the pass at the end of every open covers every path that
  // fills the store (session restore, the networks screen, the picker, tab
  // activation) and also clears stale marks when a network becomes visible
  // again.
  void refreshTabAccessibility();
}

/**
 * Loads the focus response for `thoughtId` into the store WITHOUT rotating
 * the per-tab history and WITHOUT re-persisting `focus_id` (it was already
 * saved when the user originally navigated there). Used on tab activation
 * and on `openNetwork`'s initial-focus path so the history of one tab does
 * not get polluted with another tab's previous focus.
 */
export async function loadFocusForTab(
  thoughtId: string,
  networkId: string,
  tabId: string | null,
): Promise<void> {
  try {
    const response = await etn.thoughts.focus(networkId, thoughtId);
    store.update({
      focus: response,
      editorTarget: null,
      selectedLinkId: null,
      ...zoneStateFromFocus(response),
    });
  } catch {
    // The persisted thought vanished (deleted, no access) — fall back to a
    // blank focus so the workspace isn't stuck showing the previous network's
    // neighbourhood. The HOME recovery happens via `findRootThought` in
    // `openNetwork` when this returns no focus at all.
    return;
  }
  // Defensive: if the persisted focus_id on the tab row got lost somehow,
  // restore it now — better than a workspace that opens on a stale HOME
  // after every restart.
  if (tabId !== null) {
    const current = store.state.tabs.find((t) => t.tab_id === tabId);
    if (current !== undefined && current.focus_id !== thoughtId) {
      void etn.tabs.updateState(tabId, { focus_id: thoughtId }).catch(() => undefined);
      const updated = store.state.tabs.map((t) =>
        t.tab_id === tabId ? { ...t, focus_id: thoughtId } : t,
      );
      store.update({ tabs: updated });
    }
  }
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
 * Initialise `user_focus_order` for any `manual`-sorted zone whose neighbours
 * all came back with `manual_position === null`. This catches two cases:
 *
 *  1. The user just switched a zone to manual — `setZoneSort` already commits
 *     the current order up-front, but if that call was on an older client
 *     (or the request failed silently), `user_focus_order` may be empty.
 *  2. The zone was already manual before this client started, and no one has
 *     reordered since — the server has no positions to surface.
 *
 * Without this backstop the .cloud-pos indicator (08-ui-spec.md §2.2) stays
 * hidden for every neighbour in the zone, which looks exactly like the
 * feature being broken.
 *
 * Safe to call repeatedly: once positions exist, the second pass is a no-op
 * (no neighbour has `manual_position === null` any more).
 */
async function ensureManualPositionsInitialized(
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
      // Best-effort — if this fails the user can still reorder manually and
      // the next refresh will see the now-existing positions.
    }
  }
}

/**
 * Focuses a thought (H5): fetches the focus response, rotates local history
 * (H7) and persists the L4 current-focus key.
 */
export async function setFocus(id: string): Promise<void> {
  const startedAt = Date.now();
  const networkId = requireNetworkId();
  const tabId = store.state.activeTabId;
  const response = await etn.thoughts.focus(networkId, id);
  // Unified visit history (0.5.5): records whatever thought was current a
  // moment ago (the previous focus, or a thought/link open in the editor
  // without moving the focus) — not necessarily the old focus. Must run
  // before the store update below (same reasoning as before: the history bar
  // re-renders from store changes, so this needs to land first).
  await noteThoughtWillOpen(id);
  const zoneState = zoneStateFromFocus(response);
  store.update({
    focus: response,
    editorTarget: null,
    selectedLinkId: null,
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
    ...zoneState,
  });
  // Milestone journal mark (task 92b89e6f): the focus response has landed and
  // the canvas/store now render it — the closing bracket of the
  // `ui.cloud.click` → `ui.focus.applied` pipeline.
  logUiEvent('ui.focus.applied', { id, ms: Date.now() - startedAt });
  // Q4: persist focus_id on the tab row so it survives restarts and tab
  // switches. Falls back to the legacy ui_state key when no tab is active
  // (shouldn't happen post-Q3, but defensible).
  if (tabId !== null) {
    void etn.tabs.updateState(tabId, { focus_id: id }).catch(() => undefined);
  } else {
    void etn.ui.setState(networkId, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID, id).catch(() => undefined);
  }
  void ensureManualPositionsInitialized(networkId, id, response, zoneState.zoneOrder).catch(() => undefined);
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
  const zoneState = zoneStateFromFocus(response);
  store.update({ focus: response, ...zoneState });
  void ensureManualPositionsInitialized(networkId, focusId, response, zoneState.zoneOrder).catch(() => undefined);
}

/** Coalesces consecutive refresh requests into one call. */
export function scheduleRefresh(): void {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshFocus().catch(() => undefined);
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * Full resync of the visible state after the session's layer changed
 * (13-layers.md §12: the layer switch invalidates the client cache as a
 * whole). `refreshFocus` alone is not enough: the editor and the
 * structures/chronicle views carry their own cached snapshots (a thought
 * loaded into `editorTarget`, the active structures thought) that were read
 * in the previous layer's context — drop them and re-read everything the
 * new layer resolves. Called on the local layer switch (`selectLayerForTab`)
 * and on the server-side `layer.switched`/`layer.deleted` control frames.
 */
export async function resyncAfterLayerSwitch(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  // Cloud metadata (trash mark, active, colors) and the indicator counts were
  // resolved in the previous layer's context — drop them so the re-read below
  // re-resolves everything through the new layer chain (13-layers.md §12).
  // A stale trash badge here is exactly bug 0.5.4: a mark lifted in a layer
  // kept hiding on the base cloud after switching back.
  invalidateAllRefs();
  invalidateIndicators(null);
  // Re-read the focus FIRST: the editor follows it once the cached snapshots
  // are dropped below, and this way it renders straight into the new layer's
  // data instead of flashing the old layer's focus for a frame.
  await refreshFocus().catch(() => undefined);
  store.update({
    editorTarget: null,
    selectedLinkId: null,
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
  });
  scheduleStructuresRefresh();
  scheduleChronicleRefresh();
}

/** Returns to the network list (e.g. after `network-lost`). */
export function backToNetworks(): void {
  store.resetNetwork();
  showScreen('networks');
}

/**
 * Restores the saved session after a successful connect: when the profile has
 * locally saved tabs (open networks, per-tab focus / view — the settings of a
 * previous run), drop the user straight into the most recently active one —
 * exactly like a client restart (Q-bugfix). Without saved tabs (first-time
 * connect, cleared cache) the network list offers the choice (H3).
 *
 * Shared by `boot()` and by the onboarding reconnect paths, so reconnecting to
 * a previously used server no longer forces a network re-pick (bug
 * be430215: every re-pick opened a duplicate tab of an already open network).
 */
export async function restoreSession(): Promise<void> {
  // Q5: warm the `networkList` cache early so the first tab-strip render has
  // display_names. The accessibility marking itself re-runs at the end of
  // `openNetwork`, once `store.tabs` is populated — marking here raced an
  // empty tab list and never fired (defect 8efd5cf8).
  void refreshTabAccessibility();
  const tabs = await etn.tabs.list().catch(() => []);
  const mostRecent = pickMostRecentTab(tabs);
  if (mostRecent !== null) {
    const opened = await openNetwork(mostRecent.network_id, mostRecent.tab_id)
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    // The saved tab's network can't be opened (deleted server-side, access
    // revoked) — the network list is the sane fallback, not a blank window.
  }
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
  // The server cascades the pin row (FK ON DELETE CASCADE) without an event —
  // drop it from the local panel here (L18).
  if (store.state.pins.includes(deletedId)) {
    store.update({ pins: store.state.pins.filter((id) => id !== deletedId) });
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
  // setFocus's rotation may have just pushed the deleted id (as the old
  // focus) into the unified history — prune it afterwards so it never
  // lingers in «последние», and drop it from the in-memory tracker too so it
  // is never resurrected as "the previous thought" on the next transition.
  noteThoughtRemoved(deletedId);
  await etn.history.remove(deletedId, store.state.activeTabId).catch(() => undefined);
  invalidateIndicators(deletedId);
  invalidateRef(deletedId);
  invalidateHistoryBar();
  invalidateStructuresThought(deletedId);
  refreshSearchIfVisible();
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
      const entries = await etn.history.list(profileId, networkId, store.state.activeTabId, 10);
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
 * profile) or to the last-active tab (Q-bugfix) — when the user has
 * previously opened tabs, drop them straight into the workspace; otherwise
 * (first-time / cleared cache) show the network list.
 */
export async function boot(): Promise<void> {
  // Theme first (L10): the attribute must be on the root before any screen
  // mounts, otherwise the first paint flashes in the light theme.
  await initTheme();
  // Layer colour indication (0.6.4 §2.2a): one store subscription writing
  // the --layer-* overrides (or clearing them) whenever the current layer,
  // its colours or the theme change.
  initLayerTheme();
  initLockCache();
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
    onLayerControl: (payload) => {
      // S11: the session's layer changed server-side — re-sync layers +
      // overrides and fully re-read the visible state (13-layers.md §12),
      // dropping the cached editor/structures snapshots of the old layer.
      if (payload.networkId !== store.state.networkId) return;
      void syncLayersForTab(store.state.networkId, payload.layer.id).then(() =>
        resyncAfterLayerSwitch(),
      );
    },
  });
  onRealtimeEvent(applyRealtimeToUi);

  const profiles = await etn.server.listProfiles();
  const active = profiles.find((p) => p.isActive);
  if (active !== undefined) {
    try {
      const me = await etn.server.connect(active.id);
      store.update({ profileId: active.id, me });
      // Q-bugfix: restore the previous session — saved tabs go straight to
      // the most recently active one, no forced re-pick from the network list.
      await restoreSession();
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

/** Global keyboard shortcuts (08-ui-spec.md §13): Ctrl+F, Escape, Ctrl+±/0,
 *  and the copy/paste bindings of workplan L26 (Ctrl+C, Ctrl+V). */
export function initKeyboard(): void {
  // Native text copies (the CM6 editor, inputs, text selections outside
  // editables) must supersede the internal thought clipboard — the same
  // "every copy displaces the previous one" rule as the system clipboard
  // (bug 731a9d16). Thought copies never fire a native copy event, so they
  // keep the snapshot.
  void import('./canvas/clipboard.js').then((m) => m.initNativeCopyTracking());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // A dialog that consumed the press (the top dialog's capture handler
      // calls preventDefault) already closed itself — closing again here
      // would pop the dialog below it (L21 fix). Same for a key auto-repeat.
      if (event.defaultPrevented || event.repeat) return;
      closeMenu();
      closeDialog();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      // Copy / paste of thoughts (workplan L26). Only fire when the focus is
      // *not* inside an editable surface — there the native Ctrl+C/V must
      // run (CM6 comment editor, add dialog input, …). Same scope as the
      // canvas kbd-nav handler (canvas/kbd-nav.ts:100).
      const editable = isEditableTarget(event.target);
      if (!editable) {
        // Check `event.code` in addition to `event.key` — some keyboard
        // layouts (notably Cyrillic) report `event.key` as the layout's
        // character (e.g. 'с') while the physical key (event.code = 'KeyC')
        // is stable. Without the code fallback Ctrl+C/V silently stop
        // matching when the user types in a non-Latin layout.
        const isC = event.key.toLowerCase() === 'c' || event.code === 'KeyC';
        const isV = event.key.toLowerCase() === 'v' || event.code === 'KeyV';
        const noMod = !event.shiftKey && !event.altKey;
        if (noMod && isC) {
          // A visible DOM text selection (e.g. inside the comment view mode,
          // b6690109) outranks the thought copy: no preventDefault, the
          // native copy puts the selected text on the system clipboard.
          if (
            store.state.screen === 'workspace' &&
            store.state.networkId !== null &&
            !hasTextSelection(document.getSelection())
          ) {
            event.preventDefault();
            void globalCopy();
            return;
          }
        }
        if (noMod && isV) {
          if (store.state.screen === 'workspace' && store.state.networkId !== null) {
            event.preventDefault();
            void globalPaste();
            return;
          }
        }
      }
      if (event.key.toLowerCase() === 'f') {
        // Ctrl+F focuses the canvas search row — hidden in the structures
        // view (§15.1), so the shortcut does nothing there.
        if (store.state.screen === 'workspace' && store.state.activeView === 'map') {
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

/** True when the keypress landed inside an editable surface the renderer
 *  should leave alone (input, textarea, contenteditable, CM6). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  // CodeMirror 6 puts its editable element inside `.cm-content`.
  if (target.closest('.cm-content') !== null) return true;
  return false;
}

/** Ctrl+C: copy the thought under the dashed cursor frame on the canvas, or —
 *  when no cursor is active — the focused thought. The cursor is updated
 *  synchronously by the cloud click handler, while `store.state.focus.focused`
 *  is only refreshed when `setFocus` runs (single-click only sets
 *  `editorTarget`), so the cursor is the reliable "what the user actually
 *  clicked" signal.
 *
 *  The selection panel is NEVER a source for Ctrl+C (bug 627a0822: with a
 *  non-empty panel the shortcut used to copy the whole panel instead of the
 *  clicked thought, and a later Ctrl+V in a comment editor pasted references
 *  to every panel thought). Copying the panel's thoughts is available only
 *  through the «Скопировать мысли» command of the panel's «Действия» menu —
 *  deliberately without a hotkey. Every thought copy also mirrors the copied
 *  thoughts' wiki-links into the system clipboard (bug 290a50c0). Always
 *  returns a visible notice — silent failures (no focus, fetch error) were
 *  reported as "Ctrl+C does nothing at all" and the user had no way to tell
 *  whether the handler even fired. */
async function globalCopy(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const cursorId = getCanvasCursor();
  const focusId = store.state.focus?.focused.id ?? null;
  const targetId = cursorId ?? focusId;
  if (targetId === null) {
    notice(
      'Не выбрана мысль для копирования. Кликните на мысль на карте, чтобы сфокусировать её.',
      'error',
    );
    return;
  }
  const { buildSingleThoughtSnapshot } = await import('./canvas/clipboard.js');
  try {
    const thought = await etn.thoughts.get(networkId, targetId);
    const { makeSelectionSnapshotDeps } = await import('./selection/selection.js');
    await buildSingleThoughtSnapshot(thought, makeSelectionSnapshotDeps(networkId));
    notice(`Скопировано: «${thought.title}»`);
  } catch (err) {
    errorDialog('Копировать', err);
  }
}

/** Ctrl+V: paste the clipboard under the cloud with the dashed cursor frame
 *  on the canvas, or read the system clipboard's text and apply the "paste
 *  text into cloud" rules. Same cursor-over-focus rule as `globalCopy`: the
 *  cursor is the click-synchronous "where does the new content go" signal,
 *  while the editor focus may still point at a previously focused thought.
 *  With multiple thoughts selected we fall back to the canvas focus. */
async function globalPaste(): Promise<void> {
  const selection = store.state.selection;
  let targetId: string | null = null;
  if (selection.length === 1 && selection[0] !== undefined) {
    targetId = selection[0];
  } else if (selection.length === 0) {
    targetId = getCanvasCursor() ?? store.state.focus?.focused.id ?? null;
  } else {
    targetId = store.state.focus?.focused.id ?? null;
  }
  if (targetId === null) {
    notice(
      'Не выбрана мысль для вставки. Кликните на мысль на карте или выделите её.',
      'error',
    );
    return;
  }
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const { pasteThoughtsTo, hasClipboard, pasteTextToCloud, systemClipboardHasThoughts } =
    await import('./canvas/clipboard.js');
  // Bug 290a50c0: the internal snapshot is only valid while the system
  // clipboard still holds the wiki-links our copy wrote there. When another
  // program (or a native text copy) has overwritten the buffer since, the
  // snapshot is stale — paste the system text by the §4.3.4 rules instead,
  // exactly as when there is no snapshot at all.
  if (hasClipboard() && (await systemClipboardHasThoughts())) {
    await pasteThoughtsTo(targetId);
    scheduleRefresh();
    return;
  }
  // Snapshot absent or stale — the system clipboard text wins (paste into
  // cloud by the §4.3.4 text rules).
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim() === '') return;
    await pasteTextToCloud(text, targetId);
    scheduleRefresh();
  } catch (err) {
    // Clipboard read denied or unavailable — surface the error so the user
    // isn't left wondering why nothing happened.
    notice(
      `Не удалось прочитать системный буфер: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
  }
}

/** Test seam: the global Ctrl+C handler. Guards the regression of bug
 *  627a0822 — Ctrl+C must copy the cursor/focus thought even while the
 *  selection panel holds thoughts, never the panel's contents. */
export const appInternals = { globalCopy };
