/**
 * Unit tests for the fix of bug cace2597: «Ошибка закрытия вкладок
 * мыслесетей» — closing the ACTIVE tab left `activeTabId` at `null`
 * (`removeTab` only clears it) and nothing picked a replacement, so the
 * just-closed network's workspace stayed on screen.
 *
 * Covered:
 *  - `pickNeighborTab` — the pure neighbour-selection rule (left, else
 *    right, else none);
 *  - `closeTab` — wiring: closing a non-active tab leaves `activeTabId`
 *    untouched and never activates anything; closing the active tab
 *    activates the left neighbour, else the right one; closing the last
 *    remaining tab opens the network picker instead.
 *
 * `activateTab` (called by `closeTab` for the picked neighbour) routes
 * through `app.openNetwork`, which is far too heavy to run under Node. The
 * mocked `networks.open` below throws immediately (same trick as
 * `tab-accessibility.test.ts`), so `openNetwork` fails on its very first
 * await — caught by `activateTab`'s try/catch — but only AFTER
 * `etn.tabs.activate(tabId)` already ran, so `etnCalls` still tells us which
 * tab `closeTab` tried to activate.
 *
 * Runs under Node — `window` must be installed BEFORE the first import of
 * `lib/etn.js` (its live Proxy captures the global at module-evaluation
 * time).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TabDto } from '../src/main/ipc/contract.js';

const etnCalls: string[] = [];

function tab(tabId: string, networkId: string, slotIdx: number): TabDto {
  return {
    tab_id: tabId,
    slot_idx: slotIdx,
    network_id: networkId,
    focus_id: null,
    view_mode: null,
    structures_state: null,
    chronicle_state: null,
    activity_state: null,
    layer_id: null,
    last_active_at: '2026-09-09T00:00:00.000Z',
  };
}

(globalThis as { window?: unknown }).window = {
  innerWidth: 1200,
  etn: {
    networks: {
      list: async (): Promise<unknown[]> => [],
      open: async (networkId: string): Promise<never> => {
        etnCalls.push(`networks.open:${networkId}`);
        throw new Error('NETWORK_NOT_FOUND');
      },
    },
    tabs: {
      close: async (tabId: string): Promise<null> => {
        etnCalls.push(`tabs.close:${tabId}`);
        return null;
      },
      activate: async (tabId: string): Promise<null> => {
        etnCalls.push(`tabs.activate:${tabId}`);
        return null;
      },
    },
  },
};

const { pickNeighborTab } = await import('../src/renderer/screens/tabs/tab-state.js');
const { closeTab } = await import('../src/renderer/screens/tabs/tabs.js');
const { store } = await import('../src/renderer/state.js');

function resetStore(patch: { tabs: TabDto[]; activeTabId: string | null }): void {
  store.update({
    tabs: patch.tabs,
    activeTabId: patch.activeTabId,
    inaccessibleTabIds: new Set<string>(),
    pickerOpen: false,
    networkId: null,
    networkList: [],
  });
  etnCalls.length = 0;
}

describe('pickNeighborTab (cace2597, чистое правило)', () => {
  const tabs = [tab('t1', 'n1', 0), tab('t2', 'n2', 1), tab('t3', 'n3', 2)];

  it('средний таб — сосед слева', () => {
    assert.equal(pickNeighborTab(tabs, 1)?.tab_id, 't1');
  });

  it('первый таб — сосед справа (слева никого нет)', () => {
    assert.equal(pickNeighborTab(tabs, 0)?.tab_id, 't2');
  });

  it('последний таб — сосед слева', () => {
    assert.equal(pickNeighborTab(tabs, 2)?.tab_id, 't2');
  });

  it('единственный таб — соседа нет', () => {
    assert.equal(pickNeighborTab([tab('t1', 'n1', 0)], 0), null);
  });
});

describe('closeTab (cace2597)', () => {
  it('закрытие НЕактивного таба не трогает activeTabId и никого не активирует', async () => {
    resetStore({ tabs: [tab('t1', 'n1', 0), tab('t2', 'n2', 1)], activeTabId: 't1' });

    await closeTab('t2');

    assert.equal(store.state.activeTabId, 't1');
    assert.deepEqual(etnCalls, ['tabs.close:t2']);
    assert.equal(store.state.tabs.some((t) => t.tab_id === 't2'), false);
  });

  it('закрытие активного среднего таба активирует соседа слева', async () => {
    resetStore({
      tabs: [tab('t1', 'n1', 0), tab('t2', 'n2', 1), tab('t3', 'n3', 2)],
      activeTabId: 't2',
    });

    await closeTab('t2');

    // `activateTab('t1')` proceeds into `openNetworkTab` → `openNetwork`,
    // which fails on its very first await (`networks.open` throws, mocked
    // above) and is swallowed by `activateTab`'s try/catch — but only AFTER
    // `tabs.activate:t1` already ran, which is the signal we care about here.
    assert.deepEqual(etnCalls, ['tabs.close:t2', 'tabs.activate:t1', 'networks.open:n1']);
    assert.equal(store.state.pickerOpen, false);
  });

  it('закрытие активного первого таба активирует соседа справа', async () => {
    resetStore({ tabs: [tab('t1', 'n1', 0), tab('t2', 'n2', 1)], activeTabId: 't1' });

    await closeTab('t1');

    assert.deepEqual(etnCalls, ['tabs.close:t1', 'tabs.activate:t2', 'networks.open:n2']);
  });

  it('закрытие последнего оставшегося таба открывает пикер, а не молчит', async () => {
    resetStore({ tabs: [tab('t1', 'n1', 0)], activeTabId: 't1' });

    await closeTab('t1');

    assert.deepEqual(etnCalls, ['tabs.close:t1']);
    assert.equal(store.state.pickerOpen, true);
  });
});
