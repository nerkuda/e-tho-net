/**
 * Shared workspace view switcher (L15/L20, 08-ui-spec.md §15.1, §17).
 *
 * `setActiveView` is the single entry point for switching between the map,
 * structures and chronicle views: it updates the store, persists the L4
 * `active_view` key and lazily initialises the target view (the structures and
 * chronicle modules keep their own per-network state).
 */

import { UI_STATE_KEY } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { store, type WorkspaceView } from '../state.js';
import { ensureStructuresInitialised } from './structures/structures.js';
import { ensureChronicleInitialised } from './chronicle/chronicle.js';

/** Switches the workspace view and persists the L4 `active_view` key per tab. */
export function setActiveView(view: WorkspaceView): void {
  if (store.state.activeView === view) return;
  store.update({ activeView: view });
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  // Q4: prefer per-tab persistence (`etn.tabs.updateState`); fall back to the
  // legacy `ui_state` key only if there's no active tab (legacy migration).
  if (tabId !== null) {
    void etn.tabs.updateState(tabId, { view_mode: view }).catch(() => undefined);
  } else if (networkId !== null) {
    void etn.ui.setState(networkId, UI_STATE_KEY.ACTIVE_VIEW, view).catch(() => undefined);
  }
  if (view === 'structures') void ensureStructuresInitialised();
  if (view === 'chronicle') void ensureChronicleInitialised();
}
