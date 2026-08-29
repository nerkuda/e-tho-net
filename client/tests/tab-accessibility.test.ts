/**
 * Unit tests for Q5 tab accessibility (08-ui-spec.md §1.1) and the fix of
 * defect 8efd5cf8: «Таб недоступной мыслесети не помечается блеклым после
 * перезапуска или переподключения».
 *
 * Covered:
 *  - `computeInaccessibleTabIds`: the pure marking rule;
 *  - `refreshTabAccessibility`: marks/clears tabs from a POPULATED
 *    `store.tabs` (the pre-fix race ran it against an empty list right after
 *    `server.connect`), and keeps marks untouched when `networks.list` fails;
 *  - `activateTab`: clicking an already-marked tab switches `activeTabId`
 *    WITHOUT `openNetwork` (whose failure used to be swallowed, turning the
 *    click into a silent no-op) — the workspace placeholder reacts to the
 *    active-tab change and shows «Нет доступа к сети».
 *
 * Runs under Node. `window` must be installed BEFORE the first import of
 * `lib/etn.js`: its live Proxy captures the global at module-evaluation time
 * (a `null` capture would make every `etn.*` access throw), so the mocked
 * `window.etn` is set up first and the modules under test are imported
 * dynamically afterwards.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkListItem } from '@etn/shared';
import type { TabDto } from '../src/main/ipc/contract.js';

/** IPC calls observed through the `window.etn` mock. */
const etnCalls: string[] = [];

/** Networks returned by the mocked `etn.networks.list()`; mutable per test. */
let mockNetworks: NetworkListItem[] = [];
/** When true, `etn.networks.list()` rejects (server unreachable). */
let mockNetworksFail = false;

function netItem(id: string, name = id): NetworkListItem {
  return {
    id,
    display_name: name,
    owner: { id: 'owner-1', display_name: 'Owner' },
    role: 'member',
    members_count: 1,
    my_focus_thought_id: null,
    description: null,
    when_to_use: null,
  } as NetworkListItem;
}

function tab(tabId: string, networkId: string, slotIdx = 0): TabDto {
  return {
    tab_id: tabId,
    slot_idx: slotIdx,
    network_id: networkId,
    focus_id: null,
    view_mode: null,
    structures_state: null,
    chronicle_state: null,
    last_active_at: '2026-08-29T00:00:00.000Z',
  };
}

// Install the mock BEFORE importing anything that (transitively) evaluates
// `lib/etn.js` — see the file comment.
(globalThis as { window?: unknown }).window = {
  etn: {
    networks: {
      list: async (): Promise<NetworkListItem[]> => {
        etnCalls.push('networks.list');
        if (mockNetworksFail) throw new Error('server unreachable');
        return mockNetworks;
      },
      open: async (networkId: string): Promise<never> => {
        etnCalls.push(`networks.open:${networkId}`);
        throw new Error('NETWORK_NOT_FOUND');
      },
    },
    tabs: {
      activate: async (tabId: string): Promise<null> => {
        etnCalls.push(`tabs.activate:${tabId}`);
        return null;
      },
    },
  },
};

const { computeInaccessibleTabIds, refreshTabAccessibility } = await import(
  '../src/renderer/screens/tabs/tab-accessibility.js'
);
const { activateTab } = await import('../src/renderer/screens/tabs/tabs.js');
const { store } = await import('../src/renderer/state.js');

/** Resets the store fields these tests touch (the store is a singleton). */
function resetStore(patch: {
  tabs?: TabDto[];
  activeTabId?: string | null;
  inaccessibleTabIds?: Set<string>;
  networkId?: string | null;
}): void {
  store.update({
    tabs: patch.tabs ?? [],
    activeTabId: patch.activeTabId ?? null,
    inaccessibleTabIds: patch.inaccessibleTabIds ?? new Set<string>(),
    networkId: patch.networkId ?? null,
    pickerOpen: false,
    networkList: [],
  });
}

describe('computeInaccessibleTabIds (Q5, чистая разметка)', () => {
  it('помечает только табы сетей, которых нет в списке доступных', () => {
    const ids = computeInaccessibleTabIds(
      [tab('t1', 'n1'), tab('t2', 'n-gone'), tab('t3', 'n1'), tab('t4', 'n-other')],
      new Set(['n1', 'n-other']),
    );
    assert.deepEqual([...ids].sort(), ['t2']);
  });

  it('возвращает пустое множество, когда доступны все сети табов', () => {
    const ids = computeInaccessibleTabIds(
      [tab('t1', 'n1'), tab('t2', 'n2')],
      new Set(['n1', 'n2', 'n3']),
    );
    assert.equal(ids.size, 0);
  });

  it('пустой список табов ничего не помечает (докризисное состояние store)', () => {
    const ids = computeInaccessibleTabIds([], new Set());
    assert.equal(ids.size, 0);
  });
});

describe('refreshTabAccessibility (8efd5cf8: разметка по заполненному store.tabs)', () => {
  it('помечает таб исчезнувшей сети и чистит устаревшую метку вернувшейся', async () => {
    mockNetworksFail = false;
    mockNetworks = [netItem('n1'), netItem('n2')];
    // t2 — «мёртвый» таб (сети n-gone нет на сервере); t3 носит устаревшую
    // метку, хотя его сеть снова доступна.
    resetStore({
      tabs: [tab('t1', 'n1'), tab('t2', 'n-gone'), tab('t3', 'n2')],
      inaccessibleTabIds: new Set(['t3']),
    });

    await refreshTabAccessibility();

    assert.ok(store.state.inaccessibleTabIds.has('t2'), 't2 помечен блеклым');
    assert.ok(!store.state.inaccessibleTabIds.has('t1'), 't1 доступен');
    assert.ok(!store.state.inaccessibleTabIds.has('t3'), 'устаревшая метка t3 снята');
    // Кэш networkList обновлён — полоса табов знает display_name.
    assert.deepEqual(
      store.state.networkList.map((n) => n.id).sort(),
      ['n1', 'n2'],
    );
  });

  it('не трогает существующие метки, когда networks.list недоступен', async () => {
    mockNetworksFail = true;
    resetStore({
      tabs: [tab('t1', 'n1')],
      inaccessibleTabIds: new Set(['t1']),
    });

    await refreshTabAccessibility();

    assert.ok(store.state.inaccessibleTabIds.has('t1'), 'метка сохранена');
  });
});

describe('activateTab (8efd5cf8: заглушка вместо молчаливого клика)', () => {
  it('клик по недоступному табу делает его активным без openNetwork', async () => {
    mockNetworksFail = false;
    mockNetworks = [netItem('n-live')];
    resetStore({
      tabs: [tab('t-live', 'n-live'), tab('t-dead', 'n-gone')],
      activeTabId: 't-live',
      networkId: 'n-live',
      inaccessibleTabIds: new Set(['t-dead']),
    });
    etnCalls.length = 0;

    await activateTab('t-dead');

    // Таб стал активным — заглушка «Нет доступа к сети» реагирует именно на
    // activeTabId ∈ inaccessibleTabIds (workspace.ts), сеть под ней не грузится.
    assert.equal(store.state.activeTabId, 't-dead');
    assert.equal(store.state.networkId, 'n-live', 'workspace под заглушкой не тронут');
    // Ни переключение таба в локальной БД, ни попытка открыть сеть не выполнялись.
    assert.deepEqual(etnCalls, []);
    // Заглушка и правда видна для этого состояния (условие из workspace.ts).
    assert.ok(
      store.state.activeTabId !== null &&
        store.state.inaccessibleTabIds.has(store.state.activeTabId),
    );
  });

  it('повторный клик по активному недоступному табу ничего не ломает', async () => {
    resetStore({
      tabs: [tab('t-dead', 'n-gone')],
      activeTabId: 't-dead',
      networkId: null,
      inaccessibleTabIds: new Set(['t-dead']),
    });
    etnCalls.length = 0;

    await activateTab('t-dead');

    assert.equal(store.state.activeTabId, 't-dead');
    assert.deepEqual(etnCalls, []);
  });

  it('клик по неизвестному id — тихий no-op', async () => {
    resetStore({ tabs: [tab('t1', 'n1')], activeTabId: 't1' });
    etnCalls.length = 0;

    await activateTab('no-such-tab');

    assert.equal(store.state.activeTabId, 't1');
    assert.deepEqual(etnCalls, []);
  });
});
