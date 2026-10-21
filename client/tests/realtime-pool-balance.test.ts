/**
 * Баланс acquire/release пула realtime-сокетов (ошибка 3cd3f995).
 *
 * Владение — СЕТЬЮ: открытие сети (`networks.open`) и каждый таб (`tabs.open`)
 * описывают одно и то же соединение. Повторный acquire не копит ссылки, и
 * закрытие последнего таба сети обязано опустить счётчик до нуля и закрыть
 * сокет. Проверяются несколько сетей/табов и повторное открытие той же сети.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { LocalDb, NewTab, ServerProfileRow, TabRow } from '../src/main/db/local-db.js';
import { RealtimeState } from '../src/main/realtime/applier.js';
import { TabRealtimePool } from '../src/main/realtime/tab-rt-pool.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';

const PROFILE_ID = 'p1';
const NET_A = '123e4567-e89b-12d3-a456-426614174000';
const NET_B = '123e4567-e89b-12d3-a456-426614174001';

const teardowns: Array<() => void> = [];
afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()!();
});

function profile(): ServerProfileRow {
  return {
    id: PROFILE_ID,
    label: 'test',
    // Refused port: the socket fails fast, no real server is involved.
    base_url: 'http://127.0.0.1:1',
    api_key_encrypted: null,
    user_id: null,
    is_active: 1,
    created_at: new Date(0).toISOString(),
  };
}

function makePool(): TabRealtimePool {
  const pool = new TabRealtimePool({
    profile: profile(),
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    getApiKey: async () => 'etn_testkey',
    localDb: {} as never,
    rtState: new RealtimeState(),
    getCurrentUserId: () => null,
    removeFromFocusHistoryEverywhere: () => undefined,
    getCurrentFocusId: () => null,
    broadcast: () => undefined,
  });
  teardowns.push(() => pool.shutdown());
  return pool;
}

/** Минимальная реализация localDb для обработчиков tabs.*. */
function makeLocalDb(): LocalDb {
  const tabs = new Map<string, TabRow>();
  const db = {
    listTabs: (profileId: string): TabRow[] =>
      [...tabs.values()]
        .filter((row) => row.profile_id === profileId)
        .sort((a, b) => a.slot_idx - b.slot_idx),
    getTab: (profileId: string, tabId: string): TabRow | null => {
      const row = tabs.get(tabId);
      return row !== undefined && row.profile_id === profileId ? row : null;
    },
    upsertTab: (profileId: string, tab: NewTab): void => {
      const previous = tabs.get(tab.tab_id);
      tabs.set(tab.tab_id, {
        profile_id: profileId,
        tab_id: tab.tab_id,
        slot_idx: tab.slot_idx,
        network_id: tab.network_id,
        focus_id: tab.focus_id ?? previous?.focus_id ?? null,
        view_mode: tab.view_mode ?? previous?.view_mode ?? null,
        structures_state: tab.structures_state ?? previous?.structures_state ?? null,
        chronicle_state: tab.chronicle_state ?? previous?.chronicle_state ?? null,
        activity_state: tab.activity_state ?? previous?.activity_state ?? null,
        layer_id: tab.layer_id ?? previous?.layer_id ?? null,
        last_active_at: tab.last_active_at ?? previous?.last_active_at ?? new Date(0).toISOString(),
      });
    },
    deleteTab: (_profileId: string, tabId: string): void => {
      tabs.delete(tabId);
    },
    reorderTabs: (_profileId: string, orderedIds: string[]): void => {
      orderedIds.forEach((tabId, index) => {
        const row = tabs.get(tabId);
        if (row !== undefined) row.slot_idx = index;
      });
    },
  };
  return db as unknown as LocalDb;
}

function makeTabs(pool: TabRealtimePool): {
  open: (networkId: string) => Promise<{ tab_id: string }>;
  close: (tabId: string) => Promise<void>;
} {
  const handlers = createHandlers({
    localDb: makeLocalDb(),
    getRest: () => null,
    getRealtimePool: () => pool,
    getProfile: () => profile(),
    connectProfile: async () => {
      throw new Error('not used');
    },
    addProfile: async () => {
      throw new Error('not used');
    },
    removeProfile: async () => undefined,
    disconnect: () => undefined,
    getCurrentNetworkId: () => null,
    openNetwork: async () => {
      throw new Error('not used');
    },
    broadcastRealtimeEvent: () => undefined,
    broadcastRealtimeStatus: () => undefined,
  } as unknown as HandlerDeps);
  const ctx = { signal: new AbortController().signal };
  return {
    open: async (networkId) =>
      (await handlers.get('tabs.open')!([networkId], ctx)) as { tab_id: string },
    close: async (tabId) => {
      await handlers.get('tabs.close')!([tabId], ctx);
    },
  };
}

describe('TabRealtimePool: баланс acquire/release (3cd3f995)', () => {
  it('повторный acquire одной сети держит одну ссылку, release закрывает', () => {
    const pool = makePool();
    pool.acquire(NET_A);
    pool.acquire(NET_A);
    pool.acquire(NET_A);
    assert.equal(pool.refCount(NET_A), 1, 'сеть — одна ссылка, не счётчик открытий');
    assert.equal(pool.has(NET_A), true);

    pool.release(NET_A);
    assert.equal(pool.refCount(NET_A), 0);
    assert.equal(pool.has(NET_A), false, 'release последнего владельца закрыл сокет');
  });

  it('tabs.open дважды + networks.open: одна ссылка; закрытие последнего таба освобождает', async () => {
    const pool = makePool();
    const tabs = makeTabs(pool);
    // Путь picker: networks.open даёт сеть, tabs.open создаёт таб.
    pool.acquire(NET_A);
    const first = await tabs.open(NET_A);
    const second = await tabs.open(NET_A);
    assert.equal(pool.refCount(NET_A), 1, 'ни networks.open, ни каждый таб не копят ссылки');

    await tabs.close(first.tab_id);
    assert.equal(pool.has(NET_A), true, 'сеть ещё открыта в другом табе');

    await tabs.close(second.tab_id);
    assert.equal(pool.refCount(NET_A), 0);
    assert.equal(pool.has(NET_A), false, 'закрытие последнего таба закрыло сокет');
  });

  it('несколько сетей: закрытие табов одной не трогает сокет другой', async () => {
    const pool = makePool();
    const tabs = makeTabs(pool);
    pool.acquire(NET_A);
    pool.acquire(NET_B);
    const a1 = await tabs.open(NET_A);
    const a2 = await tabs.open(NET_A);
    const b1 = await tabs.open(NET_B);

    await tabs.close(a1.tab_id);
    await tabs.close(a2.tab_id);
    assert.equal(pool.has(NET_A), false, 'сеть A освобождена');
    assert.equal(pool.has(NET_B), true, 'сеть B держит свой сокет');
    assert.equal(pool.refCount(NET_B), 1);

    await tabs.close(b1.tab_id);
    assert.equal(pool.has(NET_B), false);
  });

  it('повторное открытие той же сети после закрытия снова даёт одну ссылку', async () => {
    const pool = makePool();
    const tabs = makeTabs(pool);
    pool.acquire(NET_A);
    const first = await tabs.open(NET_A);
    await tabs.close(first.tab_id);
    assert.equal(pool.has(NET_A), false);

    pool.acquire(NET_A);
    const again = await tabs.open(NET_A);
    assert.equal(pool.refCount(NET_A), 1, 'переоткрытие не копит ссылки');
    await tabs.close(again.tab_id);
    assert.equal(pool.has(NET_A), false, 'и снова освобождается');
  });
});
