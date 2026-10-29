/**
 * Пул realtime-сокетов и IPC-гейт (ошибка de34b35b):
 *  - повторный `acquire` отдаёт renderer снапшот текущего статуса сети;
 *  - `statusSnapshot()`/`realtime.getStatuses` возвращают карту по сетям;
 *  - `probeLiveness(networkId)` доходит до сокета;
 *  - централизованный гейт отклоняет изменяющий вызов при не-`connected`,
 *    но пропускает чтения.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { ServerProfileRow } from '../src/main/db/local-db.js';
import { RealtimeClient } from '../src/main/net/ws-client.js';
import { RealtimeState } from '../src/main/realtime/applier.js';
import { TabRealtimePool } from '../src/main/realtime/tab-rt-pool.js';
import {
  actionProbeNetwork,
  blockedMutationNetwork,
  createHandlers,
  type HandlerDeps,
} from '../src/main/ipc/handlers.js';

const NET = '123e4567-e89b-12d3-a456-426614174000';

const teardowns: Array<() => void> = [];
afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()!();
});

function profile(): ServerProfileRow {
  return {
    id: 'p1',
    label: 'test',
    // Refused port: the socket fails fast, no real server is involved.
    base_url: 'http://127.0.0.1:1',
    api_key_encrypted: null,
    user_id: null,
    is_active: 1,
    created_at: new Date(0).toISOString(),
  };
}

function makePool(): {
  pool: TabRealtimePool;
  broadcasts: Array<{ channel: string; payload: unknown }>;
  statuses: string[];
} {
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const statuses: string[] = [];
  const pool = new TabRealtimePool({
    profile: profile(),
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    getApiKey: async () => 'etn_testkey',
    localDb: {} as never,
    rtState: new RealtimeState(),
    getCurrentUserId: () => null,
    removeFromFocusHistoryEverywhere: () => undefined,
    getCurrentFocusId: () => null,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    onStatus: (networkId, status) => statuses.push(`${networkId}:${status}`),
  });
  teardowns.push(() => pool.shutdown());
  return { pool, broadcasts, statuses };
}

describe('TabRealtimePool — статусы и снапшот (de34b35b)', () => {
  it('repeated acquire pushes the current status snapshot to the renderer', () => {
    const { pool, broadcasts } = makePool();
    pool.acquire(NET);
    const before = broadcasts.length;
    pool.acquire(NET);

    const snapshots = broadcasts
      .slice(before)
      .filter((b) => b.channel === 'realtime:status')
      .map((b) => b.payload as { networkId: string; status: string });
    assert.ok(snapshots.length >= 1, 'повторный acquire обязан отдать снапшот');
    assert.equal(snapshots.at(-1)!.networkId, NET);
    assert.ok(typeof snapshots.at(-1)!.status === 'string');
  });

  it('statusSnapshot returns one entry per pooled network', () => {
    const { pool } = makePool();
    pool.acquire(NET);
    const snapshot = pool.statusSnapshot();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]!.networkId, NET);
    assert.ok(['connecting', 'reconnecting', 'offline'].includes(snapshot[0]!.status));
  });

  it('probeLiveness delegates to the pooled client', () => {
    const { pool } = makePool();
    pool.acquire(NET);
    const probes: string[] = [];
    const original = RealtimeClient.prototype.probeLiveness;
    RealtimeClient.prototype.probeLiveness = function (trigger): void {
      probes.push(`${trigger}:${this.getStatus()}`);
    };
    try {
      pool.probeLiveness(NET);
    } finally {
      RealtimeClient.prototype.probeLiveness = original;
    }
    assert.deepEqual(probes, ['action:connecting']);
  });
});

describe('IPC: realtime.getStatuses и гейт изменяющих вызовов (de34b35b)', () => {
  it('realtime.getStatuses returns the pool snapshot', async () => {
    const snapshot = [{ networkId: NET, status: 'connected' }];
    const handlers = createHandlers({
      getRealtimePool: () => ({ statusSnapshot: () => snapshot }) as never,
    } as unknown as HandlerDeps);
    const handler = handlers.get('realtime.getStatuses');
    assert.ok(handler !== undefined);
    const result = await handler!([], { signal: new AbortController().signal });
    assert.deepEqual(result, snapshot);
  });

  it('mutation gate rejects a mutating call while reconnecting and lets a read through', () => {
    const has = (networkId: string): boolean => networkId === NET;
    // Mutating channel at `reconnecting`.
    assert.equal(
      blockedMutationNetwork('thoughts.update', [NET, 'id', {}], has, () => 'reconnecting'),
      NET,
    );
    // Reading the same network is never blocked.
    assert.equal(
      blockedMutationNetwork('thoughts.get', [NET, 'id'], has, () => 'reconnecting'),
      null,
    );
    // A network not held by the pool is not gated either.
    assert.equal(
      blockedMutationNetwork('thoughts.update', ['other', 'id', {}], has, () => 'offline'),
      null,
    );
    // Connected mutating call passes.
    assert.equal(
      blockedMutationNetwork('thoughts.update', [NET, 'id', {}], has, () => 'connected'),
      null,
    );
  });

  it('actionProbeNetwork picks the first UUID arg, else the active network', () => {
    assert.equal(actionProbeNetwork('thoughts.get', [NET, 'id'], 'other'), NET);
    assert.equal(actionProbeNetwork('thoughts.get', [], 'active-net'), 'active-net');
    assert.equal(actionProbeNetwork('server.listProfiles', [], 'active-net'), null);
    assert.equal(actionProbeNetwork('thoughts.get', [], null), null);
  });
});
