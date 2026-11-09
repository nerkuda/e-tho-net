/**
 * Unit tests for the renderer object-lock cache (task 4f141756 — «Захваты в
 * клиенте: авто-захват, индикация, ручной сброс»).
 *
 * Pure-logic tests only: the cache itself never reaches the network or DOM.
 * Realtime updates flow through `__setForTests` / `__resetForTests` (the
 * production path uses `edit.acquired` / `edit.released` / `edit.cleared`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LockRow } from '@etn/shared';

import {
  __resetForTests,
  __setForTests,
  broadcastSeq,
  getLock,
  getLockByKey,
  holderNameByUserId,
  initLockCache,
  listLocks,
  lockKey,
  otherHolder,
  parseLockKey,
  refresh,
  subscribeLockCache,
} from '../src/renderer/lib/lock-cache.js';
import { resetEventRouter, routeRealtimeEvent } from '../src/renderer/lib/live/event-router.js';

function row(overrides: Partial<LockRow> = {}): LockRow {
  return {
    id: overrides.id ?? 'lock-1',
    entity_type: overrides.entity_type ?? 'thought',
    entity_id: overrides.entity_id ?? 'thought-1',
    user_id: overrides.user_id ?? 'user-A',
    client_id: overrides.client_id ?? null,
    acquired_at_ms: overrides.acquired_at_ms ?? Date.now(),
  };
}

/** Кладёт дублёр моста; `list` — ответ `GET /locks`. */
function installList(rows: LockRow[] | (() => Promise<LockRow[]>)): { calls: () => number } {
  let calls = 0;
  const list = typeof rows === 'function' ? rows : async (): Promise<LockRow[]> => rows;
  const bridge = {
    locks: {
      list: async (...args: unknown[]): Promise<LockRow[]> => {
        calls += 1;
        void args;
        return list();
      },
    },
  };
  (globalThis as unknown as { etn: unknown }).etn = bridge;
  const win = (globalThis as unknown as { window?: { etn: unknown } }).window;
  if (win !== undefined) win.etn = bridge;
  return { calls: () => calls };
}

/** Дать отработать цепочке `refresh()` из сверки с сервером. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface LockEventData {
  entity_type: string;
  entity_id: string;
  lock_id: string;
  user_id: string;
  client_id: string | null;
  acquired_at_ms?: number;
  reason?: 'server_start' | 'ws_disconnect' | 'manual';
}

/** Пропускает событие через production-роутер (тот же путь, что из WS). */
async function feed(
  event: 'edit.released' | 'edit.cleared',
  seq: number,
  data: LockEventData,
): Promise<void> {
  routeRealtimeEvent({ network_id: 'net-1', seq, type: event, data } as never);
  await flush();
}

describe('lock-cache: key helpers', () => {
  it('lockKey + parseLockKey round-trip', () => {
    const key = lockKey('thought', 'abc-123');
    assert.equal(key, 'thought:abc-123');
    assert.deepEqual(parseLockKey(key), { entityType: 'thought', entityId: 'abc-123' });
  });

  it('parseLockKey rejects malformed keys', () => {
    assert.equal(parseLockKey('noseparator'), null);
    assert.equal(parseLockKey(':empty-type'), null);
    assert.equal(parseLockKey('empty-id:'), null);
  });
});

describe('lock-cache: storage', () => {
  it('getLock returns undefined when no row exists', () => {
    __resetForTests();
    assert.equal(getLock('thought', 'missing'), undefined);
    assert.equal(getLockByKey('thought:missing'), undefined);
  });

  it('__setForTests seeds rows and listLocks reflects them', () => {
    __resetForTests();
    __setForTests([
      row({ entity_type: 'thought', entity_id: 'a', user_id: 'user-A' }),
      row({ entity_type: 'link', entity_id: 'b', user_id: 'user-B', id: 'lock-2' }),
    ]);
    const list = listLocks();
    assert.equal(list.length, 2);
    assert.equal(getLock('thought', 'a')?.user_id, 'user-A');
    assert.equal(getLock('link', 'b')?.id, 'lock-2');
  });

  it('subscribeLockCache fires on every transition', () => {
    __resetForTests();
    let calls = 0;
    const unsubscribe = subscribeLockCache(() => {
      calls += 1;
    });
    __setForTests([row()]);
    __setForTests([row({ id: 'lock-2' })]);
    unsubscribe();
    __setForTests([row({ id: 'lock-3' })]);
    assert.equal(calls, 2);
    assert.ok(broadcastSeq() >= 2);
  });
});

describe('lock-cache: otherHolder / holderNameByUserId', () => {
  it('holderNameByUserId falls back to the raw id when the user is unknown', () => {
    __resetForTests();
    // No user cache seeded — the helper returns the id verbatim.
    assert.equal(holderNameByUserId('user-X'), 'user-X');
  });

  it('holderNameByUserId resolves the member name once the network roster loads (cb9b466f)', async () => {
    const users = await import('../src/renderer/lib/users.js');
    const { store } = await import('../src/renderer/state.js');
    users.__resetForTests();
    __resetForTests();
    (globalThis as unknown as { window: unknown }).window = {
      etn: {
        networks: {
          listMembers: async () => [
            {
              network_id: 'net-1',
              user_id: 'user-X',
              role: 'member',
              added_at: '',
              added_by: '',
              username: 'bob',
              display_name: 'Борис',
            },
          ],
        },
      },
    };
    store.update({
      networkId: 'net-1',
      me: { id: 'me-1', username: 'me', display_name: 'Я', is_admin: false },
    });
    // Первый вызов лениво запускает загрузку и пока честно падает на id.
    assert.equal(holderNameByUserId('user-X'), 'user-X');
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(holderNameByUserId('user-X'), 'Борис');
    delete (globalThis as { window?: unknown }).window;
  });

  it('otherHolder returns null when nobody holds the lock', () => {
    __resetForTests();
    assert.equal(otherHolder('thought', 'no-such'), null);
  });
});

describe('lock-cache: refresh — серверная правда после переподключения (0702efb6)', () => {
  it('успешный refresh заменяет кэш серверным снимком и возвращает true', async () => {
    const { store } = await import('../src/renderer/state.js');
    __resetForTests();
    store.update({ networkId: 'net-1' });
    installList([row({ id: 'lock-server', entity_id: 'b' })]);
    __setForTests([row({ id: 'lock-stale', entity_id: 'a', user_id: 'me' })]);

    assert.equal(await refresh(), true);
    assert.deepEqual(
      listLocks().map((r) => r.id),
      ['lock-server'],
      'фантомная строка прошлой сессии сброшена',
    );
  });

  it('неудачный refresh возвращает false и не трогает кэш', async () => {
    const { store } = await import('../src/renderer/state.js');
    __resetForTests();
    store.update({ networkId: 'net-1' });
    installList(async () => {
      throw new Error('network down');
    });
    __setForTests([row({ id: 'lock-stale', entity_id: 'a', user_id: 'me' })]);

    assert.equal(await refresh(), false);
    assert.equal(listLocks()[0]?.id, 'lock-stale', 'устаревшая картина не выдаётся за снимок');
  });

  it('refresh без открытой сети — false, без сетевого вызова', async () => {
    const { store } = await import('../src/renderer/state.js');
    __resetForTests();
    store.update({ networkId: null });
    let calls = 0;
    installList(async () => {
      calls += 1;
      return [];
    });

    assert.equal(await refresh(), false);
    assert.equal(calls, 0);
  });
});

describe('lock-cache: события с чужим lock_id — сверка с сервером (27f0780a)', () => {
  it('совпавший lock_id снимает строку без сетевого вызова', async () => {
    const { store } = await import('../src/renderer/state.js');
    __resetForTests();
    resetEventRouter();
    store.update({ networkId: 'net-1' });
    const list = installList([]);
    __setForTests([row({ id: 'lock-1', entity_id: 'th-1', user_id: 'me' })]);
    initLockCache();

    await feed('edit.released', 1, {
      entity_type: 'thought',
      entity_id: 'th-1',
      lock_id: 'lock-1',
      user_id: 'me',
      client_id: null,
    });

    assert.equal(getLock('thought', 'th-1'), undefined);
    assert.equal(list.calls(), 0, 'сверка не нужна: id совпал');
  });

  it('несовпавший lock_id вытесняет фантомную строку сверкой с сервером', async () => {
    const { store } = await import('../src/renderer/state.js');
    __resetForTests();
    resetEventRouter();
    store.update({ networkId: 'net-1' });
    const list = installList([]); // сервер уже пуст — строка кэша фантомная
    __setForTests([row({ id: 'lock-dead', entity_id: 'th-1', user_id: 'me' })]);
    initLockCache();

    await feed('edit.released', 1, {
      entity_type: 'thought',
      entity_id: 'th-1',
      lock_id: 'lock-other',
      user_id: 'someone',
      client_id: null,
    });

    assert.equal(getLock('thought', 'th-1'), undefined, 'фантом вытеснен серверной правдой');
    assert.equal(list.calls(), 1, 'расхождение лечится одной сверкой');
  });

  it('несовпавший lock_id не скрывает живой захват, если сервер его отдаёт', async () => {
    const { store } = await import('../src/renderer/state.js');
    __resetForTests();
    resetEventRouter();
    store.update({ networkId: 'net-1' });
    installList([row({ id: 'lock-live', entity_id: 'th-1', user_id: 'other' })]);
    __setForTests([row({ id: 'lock-dead', entity_id: 'th-1', user_id: 'me' })]);
    initLockCache();

    await feed('edit.cleared', 1, {
      entity_type: 'thought',
      entity_id: 'th-1',
      lock_id: 'lock-other',
      user_id: 'me',
      client_id: null,
      reason: 'manual',
    });

    assert.equal(getLock('thought', 'th-1')?.id, 'lock-live', 'живой захват не теряется');
  });

  it('синтетическая pending-строка (LOCKED) не переживает edit.cleared', async () => {
    const { store } = await import('../src/renderer/state.js');
    __resetForTests();
    resetEventRouter();
    store.update({ networkId: 'net-1' });
    const list = installList([]);
    __setForTests([row({ id: 'pending-thought:th-1', entity_id: 'th-1', user_id: 'other' })]);
    initLockCache();

    await feed('edit.cleared', 1, {
      entity_type: 'thought',
      entity_id: 'th-1',
      lock_id: 'lock-real',
      user_id: 'other',
      client_id: null,
      reason: 'manual',
    });

    assert.equal(getLock('thought', 'th-1'), undefined, 'pending-строка не остаётся навсегда');
    assert.equal(list.calls(), 1);
  });
});

describe('lock-cache: __resetForTests wipes between tests', () => {
  it('clears rows, listeners and the realtime wire flag', () => {
    __setForTests([row()]);
    subscribeLockCache(() => undefined);
    __resetForTests();
    assert.equal(listLocks().length, 0);
    assert.equal(getLock('thought', 'thought-1'), undefined);
  });
});
