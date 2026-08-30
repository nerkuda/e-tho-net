/**
 * Layer control frames over the realtime socket (task S11, 13-layers.md §12,
 * §2.4): the server sends `layer.switched` / `layer.deleted` — both must reach
 * subscribers as a typed `layer-control` emission so the renderer resyncs the
 * visible state instead of showing a stale layer.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { WebSocketServer, type WebSocket } from 'ws';

import { RealtimeClient } from '../src/main/net/ws-client.js';
import type { LocalDb } from '../src/main/db/local-db.js';

/** In-memory `LocalDb` stub (mirrors ws-client.test.ts). */
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

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
});

describe('RealtimeClient layer control frames (S11)', () => {
  it('layer.switched and layer.deleted emit typed layer-control events', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const frames: Array<{ kind: string; layer: { id: string; title: string } }> = [];
    const client = new RealtimeClient({
      baseUrl: `ws://127.0.0.1:${port}`,
      getApiKey: async () => 'etn_testkey',
      getClientId: () => 'cid-aaa',
      getNetworkId: () => 'net1',
      localDb: makeFakeDb(),
      random: () => 0,
    });
    client.onTyped('layer-control', (payload) => {
      frames.push(payload);
    });
    // A regular event must NOT surface through the layer-control channel.
    client.onTyped('event', () => {
      assert.fail('control frames must not be re-emitted as events');
    });

    let serverSocket: WebSocket | null = null;
    server.on('connection', (socket) => {
      sockets.push(socket);
      serverSocket = socket;
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === 'resume') {
          socket.send(
            JSON.stringify({ type: 'layer.switched', layer: { id: 'l1', title: 'Правки' } }),
          );
          socket.send(JSON.stringify({ type: 'layer.deleted', layer: { id: 'base', title: 'Основа' } }));
        }
      });
    });

    await client.connect();
    await until(() => serverSocket !== null);
    await until(() => frames.length === 2);

    assert.deepEqual(frames[0], { kind: 'switched', layer: { id: 'l1', title: 'Правки' } });
    assert.deepEqual(frames[1], { kind: 'deleted', layer: { id: 'base', title: 'Основа' } });

    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ignores malformed layer control frames', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const frames: Array<{ kind: string }> = [];
    const client = new RealtimeClient({
      baseUrl: `ws://127.0.0.1:${port}`,
      getApiKey: async () => 'etn_testkey',
      getClientId: () => 'cid-aaa',
      getNetworkId: () => 'net1',
      localDb: makeFakeDb(),
      random: () => 0,
    });
    client.onTyped('layer-control', (payload) => {
      frames.push(payload);
    });

    server.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === 'resume') {
          socket.send(JSON.stringify({ type: 'layer.switched' })); // no layer
          socket.send(JSON.stringify({ type: 'layer.deleted', layer: 42 })); // wrong shape
        }
      });
    });

    await client.connect();
    await wait(120);
    assert.equal(frames.length, 0);

    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
