/**
 * Tab accessibility checks (08-ui-spec.md §1.1, workplan Q5).
 *
 * After connecting to a server (or when realtime drops a `network.deleted` /
 * `member.removed` for our `user_id`), every tab whose `network_id` is no
 * longer in `etn.networks.list()` must be marked inaccessible:
 *  - tab title rendered with `opacity: 0.5` («блеклый»);
 *  - activation shows the «Нет доступа» placeholder, not the network
 *    contents;
 *  - the user can only close the tab.
 */
import { etn } from '../../lib/etn.js';
import { store } from '../../state.js';
import {
  clearTabInaccessible,
  getTabById,
  markTabInaccessible,
} from './tab-state.js';

/**
 * Walks every saved tab and checks whether its network is still visible to
 * the user. Marks inaccessible tabs; clears stale marks. Cheap to call —
 * does one `networks.list()` round-trip and a per-tab local check.
 */
export async function refreshTabAccessibility(): Promise<void> {
  const tabs = store.state.tabs;
  if (tabs.length === 0) return;
  let visibleNetworks: Set<string> | null = null;
  try {
    const list = await etn.networks.list();
    visibleNetworks = new Set(list.map((n) => n.id));
  } catch {
    // Network unreachable — leave existing marks alone; nothing to update.
    return;
  }
  for (const tab of tabs) {
    const accessible = visibleNetworks.has(tab.network_id);
    if (accessible) {
      clearTabInaccessible(tab.tab_id);
    } else {
      markTabInaccessible(tab.tab_id);
    }
  }
}

/**
 * Marks the tab(s) for `networkId` as inaccessible. Called from the realtime
 * `networkLost` handler (Q2 broadcast `realtime:networkLost`).
 */
export function onNetworkLost(networkId: string): void {
  for (const tab of store.state.tabs) {
    if (tab.network_id === networkId) markTabInaccessible(tab.tab_id);
  }
}

/** Returns `true` if the active tab is inaccessible. */
export function isActiveTabInaccessible(): boolean {
  const id = store.state.activeTabId;
  if (id === null) return false;
  return store.state.inaccessibleTabIds.has(id);
}

/**
 * Looks up a tab's accessibility. Used by the placeholder check before
 * rendering the workspace body.
 */
export function isTabInaccessible(tabId: string): boolean {
  return store.state.inaccessibleTabIds.has(tabId);
}

/** Helper used by the workspace placeholder — returns the active tab's id. */
export function getActiveTabIdOrNull(): string | null {
  return store.state.activeTabId;
}

/** Re-export of the tab lookup for callers that only need this helper. */
export { getTabById };
