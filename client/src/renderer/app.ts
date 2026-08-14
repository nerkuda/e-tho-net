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
import {
  parseCollapsedGroups,
  parseCloudGap,
  parseCloudWidth,
  parseLinkTypeId,
  parseWindowLayout,
} from './lib/pure.js';
import { initRealtime, onRealtimeEvent, setRealtimeEffects } from './realtime.js';
import { applyRealtimeToUi } from './realtime-ui.js';
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

  const [cloudWidthRaw, cloudGapRaw, posRaw, collapsedRaw, focusRaw, linkTypeRaw, layoutRaw] =
    await Promise.all([
      etn.ui.getState(networkId, UI_STATE_KEY.CLOUD_WIDTH),
      etn.ui.getState(networkId, UI_STATE_KEY.CLOUD_GAP),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_POSITION),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_COLLAPSED_GROUPS),
      etn.ui.getState(networkId, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID),
      etn.ui.getState(networkId, UI_STATE_KEY.LAST_USED_LINK_TYPE_ID),
      etn.ui.getState(networkId, UI_STATE_KEY.WINDOW_LAYOUT),
    ]);

  const editorPosition = (
    ['left', 'right', 'top', 'bottom', 'hidden'].includes(posRaw ?? '') ? posRaw : 'right'
  ) as 'left' | 'right' | 'top' | 'bottom' | 'hidden';

  const editorSize = parseWindowLayout(layoutRaw);

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
    editorPosition,
    editorW: editorSize.w,
    editorH: editorSize.h,
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
  store.update({ focus: response, editorTarget: null, selectedLinkId: null, ...zoneStateFromFocus(response) });
  if (oldId !== null && oldId !== id) {
    void etn.history.rotate(oldId, id).catch(() => undefined);
  }
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
 * Boot: initialise realtime plumbing, then route to onboarding (no active
 * profile) or to the network list (active profile connects successfully).
 */
export async function boot(): Promise<void> {
  initRealtime();
  setRealtimeEffects({
    onStale: () => scheduleRefresh(),
    onFocusLost: () => {
      void refreshFocus().catch(() => backToNetworks());
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

/** Global keyboard shortcuts (08-ui-spec.md §13): Ctrl+F, Escape. */
export function initKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      closeDialog();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      if (store.state.screen === 'workspace') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.search-input')?.focus();
      }
    }
  });
}
