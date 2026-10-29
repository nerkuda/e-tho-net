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

/**
 * Finds an already-open tab pointing at `networkId` — the last one, when
 * several tabs show the same network. Cross-network wiki-links (bug
 * bcdb3dc6) reuse this tab instead of always opening a new one; `null` means
 * the target network is not open in any tab, so a new tab is warranted.
 */
export function findTabForNetwork(tabs: TabDto[], networkId: string): TabDto | null {
  const matches = tabs.filter((t) => t.network_id === networkId);
  return matches.at(-1) ?? null;
}

/** Returns the network id of the active tab (or `null`). */
export function getActiveNetworkId(): string | null {
  return getActiveTab()?.network_id ?? null;
}

// ---------------------------------------------------------------------------
// Пер-вкладочные снимки экранов принадлежат СЕТИ вкладки (ошибка 58c55bb9)
// ---------------------------------------------------------------------------
//
// `structures_state`/`chronicle_state`/`activity_state` — состояние ЭКРАНА в
// конкретной сети. Панель отбора одной сети, применённая к другой, отправляет
// на сервер чужие типы/свойства и получает 422 «Тип … удалён из сети».
// Поэтому «чей это снимок» решается ОДНИМ помощником для всех экранов и
// отложенных повторов, а не проверкой `tab.network_id` в каждом месте.

/** Поля строки вкладки, несущие снимки экранов (пер-вкладочное состояние). */
export const TAB_SCREEN_STATE_FIELDS = [
  'structures_state',
  'chronicle_state',
  'activity_state',
] as const;
export type TabScreenStateField = (typeof TAB_SCREEN_STATE_FIELDS)[number];

/** Пара «сеть + вкладка», которой принадлежит состояние экрана. */
export interface ScreenPair {
  networkId: string;
  tabId: string | null;
}

/** Текущая пара «сеть + вкладка» из store (`null` — сеть не открыта). */
export function currentScreenPair(): ScreenPair | null {
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  return { networkId, tabId: store.state.activeTabId };
}

/** Совпадает ли пара с текущей (сеть И вкладка) — сторож отложенных путей. */
export function isCurrentScreenPair(pair: ScreenPair): boolean {
  return store.state.networkId === pair.networkId && store.state.activeTabId === pair.tabId;
}

/**
 * Относится ли вкладка к этой сети. Снимки экранов адресуются парой
 * «сеть + вкладка»: и чтение, и запись снимка обязаны сверять сеть вкладки
 * (ошибка 58c55bb9).
 */
export function tabBelongsToNetwork(networkId: string, tabId: string | null): boolean {
  if (tabId === null) return false;
  return getTabById(tabId)?.network_id === networkId;
}

/**
 * Снимок экрана из строки вкладки — только если вкладка относится к ЭТОЙ сети.
 * Вкладка чужой сети (окно переключения в `openNetwork`, «осиротевшая» пара)
 * снимка не даёт: применять его к текущей сети нельзя (ошибка 58c55bb9).
 */
export function readTabScreenState(
  networkId: string,
  tabId: string | null,
  field: TabScreenStateField,
): string | null {
  if (!tabBelongsToNetwork(networkId, tabId)) return null;
  if (tabId === null) return null;
  return getTabById(tabId)?.[field] ?? null;
}

/**
 * Вкладка, в которую разрешено открыть сеть: только вкладка ЭТОЙ сети.
 * Вкладка другой сети не переиспользуется — иначе её пер-вкладочные снимки
 * (и подпись на полосе) принадлежали бы чужой сети (ошибка 58c55bb9);
 * вызывающий открывает новую вкладку.
 */
export function findOpenTargetTab(
  tabs: TabDto[],
  tabId: string | undefined,
  networkId: string,
): TabDto | null {
  if (tabId === undefined) return null;
  const target = tabs.find((t) => t.tab_id === tabId) ?? null;
  return target !== null && target.network_id === networkId ? target : null;
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

/**
 * Picks the tab that should become active after closing the tab at
 * `closedIndex` in `tabs` (the list BEFORE removal): the left neighbour,
 * else the right one, else `null` when none remain (bug cace2597 — closing
 * the active tab used to leave `activeTabId` at `null` with no replacement
 * picked, so the just-closed network's workspace stayed on screen).
 */
export function pickNeighborTab(tabs: TabDto[], closedIndex: number): TabDto | null {
  if (closedIndex > 0) return tabs[closedIndex - 1] ?? null;
  return tabs[closedIndex + 1] ?? null;
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
