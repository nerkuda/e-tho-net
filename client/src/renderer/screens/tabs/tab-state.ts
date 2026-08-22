/**
 * Tab strip state helpers (08-ui-spec.md §1.1, workplan Q3).
 *
 * `store.tabs` holds the ordered list of open tabs from the main process
 * (07-client-electron.md §3.6). This module adds:
 *  - a `dirtyTabIds` set of tab ids that have unacknowledged realtime events
 *    (Q4 fills it in);
 *  - `inaccessibleTabIds` set of tabs whose network the user no longer
 *    belongs to (Q5);
 *  - selectors: `getActiveTab`, `getTabById`, `getNetworkIdForTab`,
 *    `isTabActive`.
 *
 * The actual DOM lives in `tabs.ts`; this module is pure logic.
 */
import type { TabDto } from '../../../main/ipc/contract.js';
import { store } from '../../state.js';

/** Returns the active tab (currently a single field on the store, Q3 placeholder). */
export function getActiveTab(): TabDto | null {
  const id = store.state.activeTabId;
  if (id === null) return null;
  return store.state.tabs.find((t) => t.tab_id === id) ?? null;
}

/** Looks up a tab by id (returns `null` if the tab has been closed). */
export function getTabById(tabId: string): TabDto | null {
  return store.state.tabs.find((t) => t.tab_id === tabId) ?? null;
}

/** Returns the network id of the active tab (or `null`). */
export function getActiveNetworkId(): string | null {
  return getActiveTab()?.network_id ?? null;
}

/** Replaces the tab list (after `etn.tabs.list` or any tab mutation). */
export function setTabs(tabs: TabDto[]): void {
  store.update({ tabs });
}

/** Appends a tab (after `etn.tabs.open`). Maintains sort by `slot_idx`. */
export function upsertTab(tab: TabDto): void {
  const existing = store.state.tabs.findIndex((t) => t.tab_id === tab.tab_id);
  const next = [...store.state.tabs];
  if (existing >= 0) next[existing] = tab;
  else next.push(tab);
  next.sort((a, b) => a.slot_idx - b.slot_idx);
  store.update({ tabs: next });
}

/** Drops a tab by id (after `etn.tabs.close`). */
export function removeTab(tabId: string): void {
  store.update({
    tabs: store.state.tabs.filter((t) => t.tab_id !== tabId),
    activeTabId: store.state.activeTabId === tabId ? null : store.state.activeTabId,
  });
}

/** Marks a tab as the active one. */
export function setActiveTabId(tabId: string | null): void {
  store.update({ activeTabId: tabId });
}

/** Marks a tab as having unacknowledged realtime events (Q4). */
export function markTabDirty(tabId: string): void {
  if (store.state.dirtyTabIds.has(tabId)) return;
  const next = new Set(store.state.dirtyTabIds);
  next.add(tabId);
  store.update({ dirtyTabIds: next });
}

/** Clears the dirty marker for a tab (called on activation, Q4). */
export function clearTabDirty(tabId: string): void {
  if (!store.state.dirtyTabIds.has(tabId)) return;
  const next = new Set(store.state.dirtyTabIds);
  next.delete(tabId);
  store.update({ dirtyTabIds: next });
}

/** Marks a tab as inaccessible (network no longer visible to the user, Q5). */
export function markTabInaccessible(tabId: string): void {
  if (store.state.inaccessibleTabIds.has(tabId)) return;
  const next = new Set(store.state.inaccessibleTabIds);
  next.add(tabId);
  store.update({ inaccessibleTabIds: next });
}

/** Clears the inaccessible marker (used when the network becomes available again). */
export function clearTabInaccessible(tabId: string): void {
  if (!store.state.inaccessibleTabIds.has(tabId)) return;
  const next = new Set(store.state.inaccessibleTabIds);
  next.delete(tabId);
  store.update({ inaccessibleTabIds: next });
}
