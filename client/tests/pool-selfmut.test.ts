/**
 * Own-mutation flag through the realtime pool (S11, 08-ui-spec.md §2.2):
 *
 * The server echoes every event back to its author, but the applier suppresses
 * own echoes — the renderer would never learn that a layer write just created
 * a shadow row, and the canvas override badge would only appear on the next
 * layer/tab switch. The pool therefore flags own echoes on a dedicated
 * `realtime:selfmut` broadcast (payload `{networkId}`), while foreign events
 * keep flowing through the regular `realtime:event` channel.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ServerProfileRow } from '../src/main/db/local-db.js';
import { RealtimeState } from '../src/main/realtime/applier.js';
import { TabRealtimePool } from '../src/main/realtime/tab-rt-pool.js';
import type { LocalDb } from '../src/main/db/local-db.js';

/** In-memory `LocalDb` stub (mirrors ws-layer-control.test.ts). */
function makeFakeDb(): LocalDb {
  const store = new Map<string, string>();
  return {
    getMeta: (key: string) => store.get(key) ?? null,
    setMeta: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as LocalDb;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(cond: () => boolean, ms = 1_500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await wait(15);
  }
}

interface Broadcast {
  channel: string;
  payload: unknown;
}

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
});

/** Starts a fake realtime server that answers `resume` with `frames`. */
async function startServer(frames: unknown[]): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.on('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type?: string };
      if (msg.type === 'resume') {
        for (const frame of frames) socket.send(JSON.stringify(frame));
      }
    });
  });
  return { server, port };
}

function makePool(port: number, broadcasts: Broadcast[]): TabRealtimePool {
  const profile = {
    id: 'p1',
    label: 'test',
    base_url: `http://127.0.0.1:${port}`,
    api_key_encrypted: null,
    user_id: null,
    is_active: 1,
    created_at: '2026-08-30T00:00:00Z',
  } as unknown as ServerProfileRow;
  return new TabRealtimePool({
    profile,
    getClientId: () => 'cid-self',
    getApiKey: async () => 'etn_testkey',
    localDb: makeFakeDb(),
    rtState: new RealtimeState(),
    getCurrentUserId: () => 'u1',
    removeFromFocusHistoryEverywhere: () => undefined,
    getCurrentFocusId: () => null,
    broadcast: (channel: string, payload: unknown) => {
      broadcasts.push({ channel, payload });
    },
  });
}

describe('TabRealtimePool own-mutation flag (S11)', () => {
  it('an own echo broadcasts realtime:selfmut and never realtime:event', async () => {
    const { server, port } = await startServer([
      {
        type: 'thought.updated',
        seq: 1,
        network_id: 'net1',
        audience: 'network',
        actor: { user_id: 'u1', client_id: 'cid-self' },
        data: { id: 't1', version: 2, changes: { title: 'правка в слое' } },
      },
    ]);
    const broadcasts: Broadcast[] = [];
    const pool = makePool(port, broadcasts);

    pool.acquire('net1');
    try {
      await until(() => broadcasts.some((b) => b.channel === 'realtime:selfmut'));
      const flag = broadcasts.find((b) => b.channel === 'realtime:selfmut');
      assert.deepEqual(flag?.payload, { networkId: 'net1' });
      assert.ok(
        !broadcasts.some((b) => b.channel === 'realtime:event'),
        'own echo must not surface as a regular event',
      );
    } finally {
      pool.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a foreign event broadcasts realtime:event, not realtime:selfmut', async () => {
    const { server, port } = await startServer([
      {
        type: 'thought.updated',
        seq: 1,
        network_id: 'net1',
        audience: 'network',
        actor: { user_id: 'u2', client_id: 'cid-other' },
        data: { id: 't1', version: 2, changes: { title: 'чужая правка' } },
      },
    ]);
    const broadcasts: Broadcast[] = [];
    const pool = makePool(port, broadcasts);

    pool.acquire('net1');
    try {
      await until(() => broadcasts.some((b) => b.channel === 'realtime:event'));
      assert.ok(
        !broadcasts.some((b) => b.channel === 'realtime:selfmut'),
        'foreign events must not raise the self-mutation flag',
      );
    } finally {
      pool.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
