/**
 * Регресс-тесты восстановления захватов после переподключения (ошибка
 * 0702efb6: «замочек редактируемой мысли остаётся после переподключения и не
 * снимается повторной записью»).
 *
 * Контракт:
 *  - захваты живут только вместе с realtime-сессией — сервер снимает их при
 *    обрыве соединения, поэтому строки кэша и id в {@link LockHandle} после
 *    reconnect — фантомы;
 *  - на переходе статуса сети в `connected` кэш перечитывается с сервера
 *    (`refresh()`), после чего захваты открытых редакторов берутся заново
 *    (`reacquireHeldLocks`), а `releaseHeld` снимает уже новый id;
 *  - подтверждённое освобождение (или `NOT_FOUND` — сервер уже снял захват)
 *    сразу убирает строку кэша, не дожидаясь realtime-события.
 *
 * Реальный DOM не поднимается: нужен лишь минимальный шим для `notice()`.
 * Модуль `lock-guard.ts` тянет `../app.js`, поэтому импорт — динамический,
 * ПОСЛЕ установки шима (как в `lock-guard.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { EtnError } from '@etn/shared';
import type { LockRow } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/** Минимальный `document`/`window` под `notice()` и косвенные чтения модулей. */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

shimDom();

const { store } = await import('../src/renderer/state.js');
const lockCache = await import('../src/renderer/lib/lock-cache.js');
const guard = await import('../src/renderer/lib/lock-guard.js');

/** Строка захвата с дефолтами. */
function row(overrides: Partial<LockRow> = {}): LockRow {
  return {
    id: overrides.id ?? 'lock-1',
    entity_type: overrides.entity_type ?? 'thought',
    entity_id: overrides.entity_id ?? 'thought-1',
    user_id: overrides.user_id ?? 'me',
    client_id: overrides.client_id ?? null,
    acquired_at_ms: overrides.acquired_at_ms ?? 0,
  };
}

interface FakeLocks {
  acquire: (networkId: string, entityType: string, entityId: string) => Promise<LockRow>;
  release: (networkId: string, lockId: string) => Promise<void>;
  list: (networkId: string) => Promise<LockRow[]>;
}

/**
 * Кладёт дублёр моста `etn` (как `lock-guard.test.ts`: `lib/etn.ts` читает
 * мост лениво — из `window.etn`, иначе из `globalThis.etn`).
 */
function installLocks(overrides: Partial<FakeLocks> = {}): FakeLocks {
  const fake: FakeLocks = {
    acquire: async (_net, entityType, entityId) =>
      row({ id: 'lock-fresh', entity_type: entityType, entity_id: entityId, user_id: 'me' }),
    release: async () => undefined,
    list: async () => [],
    ...overrides,
  };
  (globalThis as any).etn = { locks: fake };
  const win = (globalThis as any).window;
  if (win !== undefined) win.etn = { locks: fake };
  return fake;
}

/** Дать отработать цепочке `refresh().then(reacquire)` из подписки статуса. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function openNetwork(networkId = 'net-1'): void {
  store.update({
    networkId,
    me: { id: 'me', username: 'me', display_name: 'Я', is_admin: false },
  });
}

beforeEach(() => {
  lockCache.__resetForTests();
  guard.__resetLockGuardForTests();
  store.update({ networkId: null, me: null, rtStatusByNetwork: {} });
});

describe('lock-guard: восстановление захватов после переподключения (0702efb6)', () => {
  it('после refresh старый id мёртв: захват берётся заново и снимается по новому id', async () => {
    const calls: string[] = [];
    installLocks({
      acquire: async (net, entityType, entityId) => {
        calls.push(`acquire:${net}:${entityType}:${entityId}`);
        return row({ id: 'lock-fresh', entity_type: entityType, entity_id: entityId });
      },
      release: async (net, lockId) => {
        calls.push(`release:${net}:${lockId}`);
      },
      list: async () => [],
    });
    openNetwork();
    // Кэш помнит захват, взятый в оборванной сессии.
    lockCache.__setForTests([row({ id: 'lock-stale', entity_id: 'th-1' })]);

    const outcome = await guard.acquireOrShowBlocked('thought', 'th-1');
    assert.equal(outcome.kind, 'self', 'по кэшу — свой захват');
    const handle = guard.lockHandleFromOutcome('thought', 'th-1', outcome);
    assert.equal(handle.lockId, 'lock-stale');

    // Reconnect: серверная правда пуста — сервер снял захваты при обрыве.
    assert.equal(await lockCache.refresh(), true);
    assert.equal(lockCache.listLocks().length, 0, 'фантомная строка сброшена');

    await guard.reacquireHeldLocks('net-1');
    assert.deepEqual(calls, ['acquire:net-1:thought:th-1'], 'захват взят заново');
    assert.equal(handle.lockId, 'lock-fresh', 'handle указывает на живой захват');

    await guard.releaseHeld(handle);
    assert.deepEqual(
      calls,
      ['acquire:net-1:thought:th-1', 'release:net-1:lock-fresh'],
      'снимается новый id, а не мёртвый',
    );
  });

  it('подтверждённое освобождение убирает строку кэша без realtime-события', async () => {
    const released: string[] = [];
    installLocks({
      release: async (_net, lockId) => {
        released.push(lockId);
      },
    });
    openNetwork();
    lockCache.__setForTests([row({ id: 'lock-x', entity_id: 'th-x' })]);

    const outcome = await guard.acquireOrShowBlocked('thought', 'th-x');
    const handle = guard.lockHandleFromOutcome('thought', 'th-x', outcome);
    await guard.releaseHeld(handle);

    assert.deepEqual(released, ['lock-x']);
    assert.equal(handle.lockId, null);
    assert.equal(
      lockCache.getLock('thought', 'th-x'),
      undefined,
      'замочек снят по факту освобождения',
    );
  });

  it('освобождение мёртвого id (NOT_FOUND) тоже снимает фантомную строку', async () => {
    installLocks({
      release: async () => {
        throw new EtnError('NOT_FOUND', 'Захват не найден');
      },
    });
    openNetwork();
    lockCache.__setForTests([row({ id: 'lock-dead', entity_id: 'th-d' })]);

    const outcome = await guard.acquireOrShowBlocked('thought', 'th-d');
    const handle = guard.lockHandleFromOutcome('thought', 'th-d', outcome);
    await guard.releaseHeld(handle);

    assert.equal(lockCache.getLock('thought', 'th-d'), undefined);
  });

  it('если объект забрал другой пользователь, handle перестаёт «держать» захват', async () => {
    let acquires = 0;
    installLocks({
      acquire: async () => {
        acquires += 1;
        throw new EtnError('LOCKED', 'Объект захвачен', {
          holder: { user_id: 'other', client_id: null },
        });
      },
    });
    openNetwork();
    lockCache.__setForTests([row({ id: 'lock-stale', entity_id: 'th-2' })]);

    const outcome = await guard.acquireOrShowBlocked('thought', 'th-2');
    const handle = guard.lockHandleFromOutcome('thought', 'th-2', outcome);
    lockCache.__setForTests([]); // серверная правда после refresh

    await guard.reacquireHeldLocks('net-1');
    assert.equal(acquires, 1);
    assert.equal(handle.lockId, null, 'реального захвата нет');
    assert.equal(handle.ownerUserId, 'other');

    // Повторный reconnect не дёргает сервер: держать больше нечего.
    await guard.reacquireHeldLocks('net-1');
    assert.equal(acquires, 1);
  });

  it('сбой сети при восстановлении не оставляет мёртвый id и повторяется на следующем reconnect', async () => {
    let acquires = 0;
    installLocks({
      acquire: async () => {
        acquires += 1;
        throw new Error('boom');
      },
    });
    openNetwork();
    lockCache.__setForTests([row({ id: 'lock-stale', entity_id: 'th-3' })]);

    const outcome = await guard.acquireOrShowBlocked('thought', 'th-3');
    const handle = guard.lockHandleFromOutcome('thought', 'th-3', outcome);
    lockCache.__setForTests([]);

    await guard.reacquireHeldLocks('net-1');
    assert.equal(handle.lockId, null, 'мёртвый id не выдаётся за живой');
    await guard.reacquireHeldLocks('net-1');
    assert.equal(acquires, 2, 'следующий reconnect пробует снова');
  });

  it('переход статуса в connected перечитывает кэш и восстанавливает захват', async () => {
    const calls: string[] = [];
    installLocks({
      list: async () => {
        calls.push('list');
        return [];
      },
      acquire: async (_net, entityType, entityId) => {
        calls.push(`acquire:${entityId}`);
        return row({ id: 'lock-new', entity_type: entityType, entity_id: entityId });
      },
    });
    store.update({
      networkId: 'net-1',
      me: { id: 'me', username: 'me', display_name: 'Я', is_admin: false },
      rtStatusByNetwork: { 'net-1': 'reconnecting' },
    });
    lockCache.__setForTests([row({ id: 'lock-stale', entity_id: 'th-4' })]);
    const outcome = await guard.acquireOrShowBlocked('thought', 'th-4');
    const handle = guard.lockHandleFromOutcome('thought', 'th-4', outcome);

    guard.initLockReconnect();
    store.update({ rtStatusByNetwork: { 'net-1': 'connected' } });
    await flush();

    assert.deepEqual(calls, ['list', 'acquire:th-4'], 'сначала серверная правда, потом захват');
    assert.equal(handle.lockId, 'lock-new');
  });
});
