/**
 * Red/green gate for defect 50fe8807 («Разрыв соединения не отменяет поздний
 * `openNetwork`»): the main-process connection lifecycle and its epoch.
 *
 * `client/src/main/ipc/register.ts` cannot be loaded under `node --test` (it
 * pulls `electron` in via `safe-storage.js`), so the lifecycle was extracted to
 * the Electron-free `connection-lifecycle.ts` (precedent —
 * `connect-active-profile.ts`). These tests drive that module directly with
 * injected fakes; the whole point is the staleness decision, not the HTTP.
 *
 * Mutations that must turn a targeted case red:
 *   - drop `this.openNetworkSeq += 1` from `disconnect()`  → case 1 (late
 *     answer publishes `currentNetworkId` and acquires the pool);
 *   - drop the epoch bump from `activate()`                → case 4 (answer of
 *     the OLD server lands in the NEW profile);
 *   - bump the epoch in `forceReconnectRealtime()`         → case 3 (a
 *     legitimate open across a resume is discarded);
 *   - drop the `restAtCall !== this.rest` identity check   → case 4's second
 *     line of defence, already covered by the epoch itself (documented as
 *     depth, not as the primary gate).
 *
 * Regression cases (2, 3) were green BEFORE the fix as well: the last-click
 * rule of defect 58c55bb9 and the resume path of 7f4cef31 must keep working.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Network } from '@etn/shared';

import { ConnectionLifecycle } from '../src/main/ipc/connection-lifecycle.js';

/** Network stub: only `id` is load-bearing for the lifecycle. */
function network(id: string): Network {
  return { id, display_name: `Сеть ${id}` } as unknown as Network;
}

/** One pending `getNetwork` call: the test decides when and how it settles. */
interface PendingCall {
  networkId: string;
  resolve: (value: Network) => void;
  reject: (error: unknown) => void;
}

/** REST-client fake: every call stays pending until the test settles it. */
class FakeRest {
  readonly calls: PendingCall[] = [];

  getNetwork(networkId: string): Promise<Network> {
    return new Promise<Network>((resolve, reject) => {
      this.calls.push({ networkId, resolve, reject });
    });
  }

  /** Settle the pending call for `networkId` successfully. */
  async resolveCall(networkId: string): Promise<void> {
    const call = this.calls.find((c) => c.networkId === networkId);
    assert.ok(call !== undefined, `getNetwork(${networkId}) must be in flight`);
    call.resolve(network(networkId));
    await flushMicrotasks();
  }
}

/** Realtime-pool fake: records the observable side effects. */
class FakePool {
  readonly acquireCalls: string[] = [];
  shutdownCalls = 0;
  forceReconnectCalls = 0;

  acquire(networkId: string): void {
    this.acquireCalls.push(networkId);
  }

  shutdown(): void {
    this.shutdownCalls += 1;
  }

  forceReconnectAll(): void {
    this.forceReconnectCalls += 1;
  }
}

interface UiStateWrite {
  profileId: string;
  networkId: string;
  key: string;
  value: string;
}

/** Test bed: lifecycle + fakes + the recorded `setUiState` writes. */
function makeBed(): {
  lifecycle: ConnectionLifecycle<FakeRest, FakePool, { id: string }, { id: string }>;
  rest: FakeRest;
  pool: FakePool;
  uiState: UiStateWrite[];
} {
  const uiState: UiStateWrite[] = [];
  const lifecycle = new ConnectionLifecycle<FakeRest, FakePool, { id: string }, { id: string }>({
    setUiState: (profileId, networkId, key, value) => {
      uiState.push({ profileId, networkId, key, value });
    },
  });
  const rest = new FakeRest();
  const pool = new FakePool();
  lifecycle.activate({
    rest,
    pool,
    profile: { id: 'profile-a' },
    currentUser: { id: 'user-a' },
  });
  return { lifecycle, rest, pool, uiState };
}

/** Let promise continuations of `openNetwork` run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const NET_A = '00000000-0000-4000-8000-00000000000a';
const NET_B = '00000000-0000-4000-8000-00000000000b';

describe('ConnectionLifecycle: поздний openNetwork после разрыва (50fe8807)', () => {
  it('openNetwork(A) → disconnect() → поздний ответ не публикует сеть и не открывает сокет', async () => {
    const { lifecycle, rest, pool, uiState } = makeBed();
    const openPromise = lifecycle.openNetwork(NET_A);
    await flushMicrotasks();
    assert.deepEqual(
      rest.calls.map((c) => c.networkId),
      [NET_A],
      'запрос открытия действительно стартовал',
    );

    lifecycle.disconnect();
    // Разрыв сбрасывает сеть синхронно — до того, как ответ вообще пришёл.
    assert.equal(lifecycle.getCurrentNetworkId(), null, 'disconnect сбрасывает сеть сразу');
    await rest.resolveCall(NET_A);

    // Устаревший запуск возвращает сеть (рендерер ждёт значение), но НЕ
    // применяет её: ни currentNetworkId, ни ui_state, ни acquire.
    const late = await openPromise;
    assert.equal(late.id, NET_A, 'устаревший запуск возвращает сеть успешно (ничего не применено)');
    assert.equal(lifecycle.getCurrentNetworkId(), null, 'поздний ответ не выставил currentNetworkId');
    assert.deepEqual(pool.acquireCalls, [], 'поздний ответ не открыл сокет отключённого сервера');
    assert.deepEqual(uiState, [], 'поздний ответ не записал ui_state');
  });

  it('регресс 58c55bb9: begin(A) → begin(B) — побеждает последний клик', async () => {
    const { lifecycle, rest, pool, uiState } = makeBed();
    const openA = lifecycle.openNetwork(NET_A);
    await flushMicrotasks();
    const openB = lifecycle.openNetwork(NET_B);
    await flushMicrotasks();

    await rest.resolveCall(NET_A);
    assert.equal(lifecycle.getCurrentNetworkId(), null, 'ответ A устарел, пока B в полёте');
    await rest.resolveCall(NET_B);

    assert.equal((await openA).id, NET_A, 'устаревший A возвращает свою сеть');
    assert.equal((await openB).id, NET_B, 'актуальный B возвращает свою сеть');
    assert.equal(lifecycle.getCurrentNetworkId(), NET_B, 'побеждает последний клик');
    assert.deepEqual(pool.acquireCalls, [NET_B], 'сокет открыт только для B');
    assert.deepEqual(
      uiState.map((w) => w.networkId),
      [NET_B],
      'ui_state записан только для B',
    );
  });

  it('регресс 7f4cef31: begin(A) → forceReconnectRealtime — открытие остаётся законным', async () => {
    const { lifecycle, rest, pool, uiState } = makeBed();
    const openPromise = lifecycle.openNetwork(NET_A);
    await flushMicrotasks();

    lifecycle.forceReconnectRealtime();
    assert.equal(pool.forceReconnectCalls, 1, 'resume действительно форсирует сокеты');
    await rest.resolveCall(NET_A);

    assert.equal(lifecycle.getCurrentNetworkId(), NET_A, 'resume того же соединения не отменяет открытие');
    assert.deepEqual(pool.acquireCalls, [NET_A], 'сокет открыт законно');
    assert.deepEqual(
      uiState.map((w) => w.networkId),
      [NET_A],
      'ui_state записан законно',
    );
    assert.equal((await openPromise).id, NET_A);
  });

  it('begin(A) → connectProfile(другой сервер): ответ старого сервера устарел', async () => {
    const { lifecycle, rest, pool, uiState } = makeBed();
    const openPromise = lifecycle.openNetwork(NET_A);
    await flushMicrotasks();

    const nextRest = new FakeRest();
    const nextPool = new FakePool();
    lifecycle.activate({
      rest: nextRest,
      pool: nextPool,
      profile: { id: 'profile-b' },
      currentUser: { id: 'user-b' },
    });
    // Смена профиля должна погасить пул прежнего сервера (он не должен
    // пережить переключение).
    assert.equal(pool.shutdownCalls, 1, 'старый пул погашен при активации нового профиля');
    assert.equal(nextPool.shutdownCalls, 0, 'новый пул не гасится');
    assert.equal(lifecycle.getCurrentNetworkId(), null, 'смена профиля сбрасывает сеть');

    await rest.resolveCall(NET_A);
    assert.equal((await openPromise).id, NET_A, 'устаревший запуск возвращает сеть успешно');
    assert.equal(lifecycle.getCurrentNetworkId(), null, 'ответ старого сервера не выставлен');
    assert.deepEqual(nextPool.acquireCalls, [], 'сокет нового сервера не открыт под id старой сети');
    assert.deepEqual(uiState, [], 'ui_state нового профиля не тронут');
  });

  it('openNetwork после disconnect бросает «Not connected»', async () => {
    const { lifecycle } = makeBed();
    lifecycle.disconnect();
    await assert.rejects(lifecycle.openNetwork(NET_A), /Not connected/);
  });

  it('disconnect идемпотентен: повторный разрыв не падает и держит сеть пустой', () => {
    const { lifecycle, pool } = makeBed();
    lifecycle.disconnect();
    lifecycle.disconnect();
    assert.equal(pool.shutdownCalls, 1, 'пул гасится один раз — после первого разрыва его уже нет');
    assert.equal(lifecycle.getRest(), null);
    assert.equal(lifecycle.getPool(), null);
    assert.equal(lifecycle.getProfile(), null);
    assert.equal(lifecycle.getCurrentUser(), null);
    assert.equal(lifecycle.getCurrentNetworkId(), null);
  });
});
