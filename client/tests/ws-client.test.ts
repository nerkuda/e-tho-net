/**
 * Unit tests for {@link RealtimeClient} (task G6).
 *
 * A real `ws` {@link WebSocketServer} is spun up on an ephemeral port so the
 * handshake, resume handshake, event/last_seq propagation, `resume.stale`,
 * ping/pong and the close-code branching (4401/4404 vs reconnect) are exercised
 * end-to-end without any real ETN server. The 7f4cef31 block additionally
 * covers the receive-idle watchdog (half-open sockets after OS sleep) and
 * `forceReconnect` (system resume / network online). `LocalDb` is stubbed
 * in-memory so the tests do not depend on the better-sqlite3 native build.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { WebSocketServer, type WebSocket } from 'ws';

import { RealtimeClient, normaliseWsUrl } from '../src/main/net/ws-client.js';
import type { LocalDb } from '../src/main/db/local-db.js';

/** In-memory `LocalDb` stub: only `getMeta`/`setMeta` are used by the WS client. */
function makeFakeDb(initial: Record<string, string> = {}): LocalDb {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getMeta: (key: string) => store.get(key) ?? null,
    setMeta: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as LocalDb;
}

/** Promise that resolves after `ms` (used to let async socket events settle). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves once `cond()` turns true, polling every 15 ms (deadline `ms`).
 * Used instead of fixed sleeps where a watchdog/reconnect races with asserts.
 */
async function until(cond: () => boolean, ms = 1_500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${ms}ms`);
    }
    await wait(15);
  }
}

/** Builds a client pointing at `serverUrl`. */
function makeClient(
  serverUrl: string,
  db: LocalDb,
  networkId: string | null = 'net1',
  opts: { random?: () => number; idleTimeoutMs?: number } = {},
): RealtimeClient {
  return new RealtimeClient({
    baseUrl: serverUrl,
    getApiKey: async () => 'etn_testkey',
    getClientId: () => 'cid-aaa',
    getNetworkId: () => networkId,
    localDb: db,
    random: opts.random ?? (() => 0),
    idleTimeoutMs: opts.idleTimeoutMs,
  });
}

/** Spins up a WebSocket server on an ephemeral port. */
function startServer(): Promise<{
  server: WebSocketServer;
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    server.on('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        url: `ws://127.0.0.1:${port}`,
        // Force-close every live connection first, otherwise `server.close()`
        // hangs waiting for lingering sockets and the test process never exits.
        close: () => {
          for (const ws of server.clients) ws.terminate();
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}

/**
 * Resolves with the next server-side socket once the client connects. MUST be
 * created before calling `connect()`. The returned socket has a `messages` array
 * collecting every text frame the client sends (e.g. the `resume` handshake).
 */
function nextConnection(server: WebSocketServer): Promise<WebSocket & { messages: string[] }> {
  return new Promise((resolve) => {
    server.once('connection', (ws) => {
      const messages: string[] = [];
      ws.on('message', (data) => messages.push(data.toString()));
      resolve(Object.assign(ws, { messages }) as WebSocket & { messages: string[] });
    });
  });
}

/** Tracks every server-side socket opened so a test can force-close them. */
function trackSockets(server: WebSocketServer): WebSocket[] {
  const sockets: WebSocket[] = [];
  server.on('connection', (ws) => sockets.push(ws));
  return sockets;
}

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardowns.length) {
    const fn = teardowns.pop()!;
    await fn();
  }
});

describe('RealtimeClient — handshake & resume', () => {
  it('sends resume with the stored last_seq on open', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({ last_seq: JSON.stringify({ net1: 41 }) });

    const conn = nextConnection(server);
    const client = makeClient(url, db);
    client.connect();
    const ws = await conn;
    await wait(20);

    const resumes = ws.messages.map((m) => JSON.parse(m) as { type: string; last_seq: number });
    assert.ok(
      resumes.some((m) => m.type === 'resume' && m.last_seq === 41),
      `${JSON.stringify(resumes)}`,
    );
    client.disconnect();
  });

  it('sends last_seq=0 when the client has no prior position', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});

    const conn = nextConnection(server);
    const client = makeClient(url, db);
    client.connect();
    const ws = await conn;
    await wait(20);

    const resumes = ws.messages.map((m) => JSON.parse(m) as { type: string; last_seq: number });
    assert.ok(resumes.some((m) => m.type === 'resume' && m.last_seq === 0));
    client.disconnect();
  });

  it('forwards Authorization and Client-Id headers and network_id query', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});

    const connInfo = new Promise<{
      url: string;
      auth: string | undefined;
      cid: string | undefined;
    }>((resolve) => {
      server.once('connection', (_ws, req) => {
        resolve({
          url: req.url ?? '',
          auth: req.headers['authorization'],
          cid: req.headers['client-id'],
        });
      });
    });

    const client = makeClient(url, db, 'net-xyz');
    client.connect();
    const info = await connInfo;
    assert.ok(info.url.includes('network_id=net-xyz'), info.url);
    assert.ok(info.url.includes('client_id=cid-aaa'), info.url);
    assert.equal(info.auth, 'Bearer etn_testkey');
    assert.equal(info.cid, 'cid-aaa');
    client.disconnect();
  });
});

describe('RealtimeClient — events & last_seq', () => {
  it('emits received events and advances last_seq in the store', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db);

    const events: unknown[] = [];
    client.onTyped('event', (e) => events.push(e));

    const conn = nextConnection(server);
    client.connect();
    const ws = await conn;

    const evt = {
      type: 'thought.created',
      seq: 7,
      ts: '2026-08-13T00:00:00.000Z',
      actor: { user_id: 'u1', client_id: 'other' },
      network_id: 'net1',
      audience: 'network',
      data: { thought: { id: 't1' } },
    };
    ws.send(JSON.stringify(evt));
    await wait(30);

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], evt);
    assert.equal(client.getLastSeq('net1'), 7);
    client.disconnect();
  });

  it('never rewinds last_seq on an out-of-order (older) seq', () => {
    const db = makeFakeDb({ last_seq: JSON.stringify({ net1: 10 }) });
    const client = makeClient('ws://127.0.0.1:1', db); // no real connect needed
    client.setLastSeq('net1', 5); // older
    assert.equal(client.getLastSeq('net1'), 10);
  });

  it('answers an application-level ping with pong', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db);

    const conn = nextConnection(server);
    client.connect();
    const ws = await conn;
    // Let the client send its resume first so the only remaining frame is the pong.
    await wait(20);
    ws.messages.length = 0;

    ws.send(JSON.stringify({ type: 'ping' }));
    await wait(30);

    const replies = ws.messages.map((m) => JSON.parse(m) as { type: string });
    assert.ok(
      replies.some((m) => m.type === 'pong'),
      JSON.stringify(replies),
    );
    client.disconnect();
  });

  it('emits stale on resume.stale and advances last_seq to the server head', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db);

    let staleSeq: number | undefined;
    client.onTyped('stale', (seq) => (staleSeq = seq));

    const conn = nextConnection(server);
    client.connect();
    const ws = await conn;

    ws.send(JSON.stringify({ type: 'resume.stale', last_seq: 9001 }));
    await wait(30);

    assert.equal(staleSeq, 9001);
    assert.equal(client.getLastSeq('net1'), 9001);
    client.disconnect();
  });
});

describe('RealtimeClient — close codes & reconnect', () => {
  it('emits unauthorized and does NOT reconnect on close 4401', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db);

    const sockets = trackSockets(server);
    const events: string[] = [];
    client.onTyped('unauthorized', () => events.push('unauthorized'));
    client.onTyped('status', (s) => events.push(`status:${s}`));

    const conn = nextConnection(server);
    client.connect();
    await conn;

    sockets[0]!.close(4401, 'nope');
    await wait(50);

    assert.ok(events.includes('unauthorized'));
    assert.ok(events.includes('status:offline'));
    assert.equal(sockets.length, 1);
    assert.equal(client.getStatus(), 'offline');
  });

  it('emits not-found and does NOT reconnect on close 4404', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db);

    const sockets = trackSockets(server);
    let notFound = false;
    client.onTyped('not-found', () => (notFound = true));

    const conn = nextConnection(server);
    client.connect();
    await conn;

    sockets[0]!.close(4404, 'gone');
    await wait(50);

    assert.equal(notFound, true);
    assert.equal(sockets.length, 1);
    assert.equal(client.getStatus(), 'offline');
  });

  it('reconnects with a fresh resume after a non-terminal close', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({ last_seq: JSON.stringify({ net1: 33 }) });
    const client = makeClient(url, db, 'net1', { random: () => 0 }); // jitter=0 → instant

    const connections = trackSockets(server);
    const resumes: number[] = [];
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type: string; last_seq?: number };
        if (msg.type === 'resume' && typeof msg.last_seq === 'number') {
          resumes.push(msg.last_seq);
        }
      });
    });

    const firstConn = nextConnection(server);
    client.connect();
    await firstConn;
    assert.equal(connections.length, 1);

    // Force a non-terminal close. Client must reconnect and resend resume(33).
    connections[0]!.close(1001, 'server restart');
    await wait(80);

    assert.ok(resumes.includes(33), `expected resume with last_seq=33, got ${resumes.join(',')}`);
    assert.ok(
      connections.length >= 2,
      `expected a reconnect, saw ${connections.length} connections`,
    );
    client.disconnect();
  });
});

describe('RealtimeClient — receive-idle watchdog & forceReconnect (defect 7f4cef31)', () => {
  it('terminates a silent (half-open) socket after the idle timeout and reconnects with resume', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({ last_seq: JSON.stringify({ net1: 12 }) });
    const client = makeClient(url, db, 'net1', { idleTimeoutMs: 120 });

    const statuses: string[] = [];
    client.onTyped('status', (s) => statuses.push(s));
    const errors: Error[] = [];
    client.onTyped('error', (e) => errors.push(e));
    const events: unknown[] = [];
    client.onTyped('event', (e) => events.push(e));

    const connections = trackSockets(server);
    const conn1 = nextConnection(server);
    const conn2 = nextConnection(server); // collects frames from the reconnect
    const evt = {
      type: 'thought.created',
      seq: 13,
      ts: '2026-08-26T00:00:00.000Z',
      actor: { user_id: 'u1', client_id: 'other' },
      network_id: 'net1',
      audience: 'network',
      data: { thought: { id: 't1' } },
    };
    // The replacement connection must be fully functional: deliver an event
    // the moment it opens (no race with the next watchdog cycle — the frame
    // goes out at handshake time, milliseconds after the client's `open`).
    server.on('connection', (ws) => {
      if (connections.indexOf(ws) === 1) ws.send(JSON.stringify(evt));
    });
    client.connect();
    await conn1;
    await wait(20);
    assert.equal(connections.length, 1);
    assert.equal(client.getStatus(), 'connected');

    // The server stays SILENT — simulating a half-open socket after OS sleep:
    // no close frame ever arrives and no frames are delivered, so neither
    // 'close' nor 'error' would fire without the watchdog.
    await until(() => connections.length >= 2);
    assert.ok(statuses.includes('reconnecting'), statuses.join(','));
    assert.ok(
      errors.some((e) => /half-open/i.test(e.message)),
      errors.map((e) => e.message).join('; '),
    );

    // A fresh resume with the persisted last_seq was sent on the new socket,
    // and the replayed event went through: emitted and last_seq advanced.
    const ws2 = await conn2;
    await until(() => ws2.messages.some((m) => m.includes('"resume"')));
    await until(() => events.length >= 1);
    assert.equal(client.getLastSeq('net1'), 13);
    client.disconnect();
  });

  it('does NOT kill the connection while frames keep arriving', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db, 'net1', { idleTimeoutMs: 100 });

    const connections = trackSockets(server);
    const conn = nextConnection(server);
    client.connect();
    const ws = await conn;
    await wait(15);

    // Any frame resets the watchdog — the app-level ping is answered with pong.
    let ticks = 0;
    const iv = setInterval(() => {
      ticks += 1;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 30);
    await wait(250); // ~8 frames, each well within the 100 ms window
    clearInterval(iv);
    assert.ok(ticks >= 6, `expected frames to flow, saw ${ticks}`);
    assert.equal(connections.length, 1); // watchdog never fired

    // Silence resumes the countdown → the watchdog fires now.
    await until(() => connections.length >= 2);
    client.disconnect();
  });

  it('forceReconnect drops a live socket immediately and resumes without backoff', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({ last_seq: JSON.stringify({ net1: 5 }) });
    const client = makeClient(url, db);

    const connections = trackSockets(server);
    const conn1 = nextConnection(server);
    const conn2 = nextConnection(server);
    client.connect();
    await conn1;
    await wait(15);
    assert.equal(connections.length, 1);

    client.forceReconnect(); // e.g. powerMonitor 'resume'
    const ws2 = await conn2;
    await wait(20);

    assert.equal(connections.length, 2);
    assert.equal(client.getStatus(), 'connected');
    const resumes = ws2.messages.map((m) => JSON.parse(m) as { type: string; last_seq?: number });
    assert.ok(
      resumes.some((m) => m.type === 'resume' && m.last_seq === 5),
      JSON.stringify(resumes),
    );
    client.disconnect();
  });

  it('forceReconnect is a no-op after a user-initiated disconnect', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db);

    const connections = trackSockets(server);
    const conn1 = nextConnection(server);
    client.connect();
    await conn1;
    await wait(10);
    client.disconnect(); // e.g. the last tab of the network closed
    await wait(50);

    client.forceReconnect();
    await wait(80);

    assert.equal(connections.length, 1); // nothing resurrected
    assert.equal(client.getStatus(), 'idle');
  });

  it('forceReconnect is a no-op after a terminal 4401 close', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const db = makeFakeDb({});
    const client = makeClient(url, db);

    const connections = trackSockets(server);
    const conn1 = nextConnection(server);
    client.connect();
    const ws1 = await conn1;
    await wait(10);
    ws1.close(4401, 'membership lost');
    await wait(50);

    client.forceReconnect();
    await wait(80);

    assert.equal(connections.length, 1); // no futile retry on a lost membership
    assert.equal(client.getStatus(), 'offline');
  });
});

describe('normaliseWsUrl', () => {
  it('rewrites http(s) to ws(s) and strips trailing slashes', () => {
    assert.equal(normaliseWsUrl('http://localhost:3000'), 'ws://localhost:3000');
    assert.equal(normaliseWsUrl('https://etn.example.com/'), 'wss://etn.example.com');
    assert.equal(normaliseWsUrl('ws://h:1///'), 'ws://h:1');
    assert.equal(normaliseWsUrl('wss://h'), 'wss://h');
  });
});
