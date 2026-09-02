/**
 * Integration tests for the real-time WebSocket gateway (tasks E1–E6,
 * docs/04-realtime.md, docs/11-settings-and-state.md §1, §4).
 *
 * Fastify `inject` cannot drive WebSockets, so the app listens on an ephemeral
 * port and a real `ws` client connects. REST mutations are still issued via
 * `app.inject` against the same instance — events published during the request
 * reach the WS client asynchronously.
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import type { ServerConfig } from '../src/config.js';
import type { RealtimeGatewayOptions } from '../src/realtime/gateway.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';
import { emitDomainEvent } from '../src/realtime/emit.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const TEST_CONFIG: ServerConfig = {
  dataDir: '/tmp/etn-test',
  host: '127.0.0.1',
  port: 0,
  tls: null,
  logLevel: 'silent',
  mcp: { enabled: false, port: null },
};

/** A seeded user with a usable API-key. */
interface SeededUser {
  userId: string;
  key: string;
}

interface RunningApp {
  app: FastifyInstance;
  sys: SystemDb;
  db: Database.Database;
  port: number;
  networkId: string;
  owner: SeededUser;
  /** WS clients opened by the test — closed by the afterEach cleanup hook. */
  sockets: WebSocket[];
}

/** Build a server on an ephemeral port with one network owned by `admin`. */
async function buildApp(realtimeOptions?: Partial<RealtimeGatewayOptions>): Promise<RunningApp> {
  const db: Database.Database = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);
  const ownerId = randomUUID();
  sys.createUser({ id: ownerId, username: 'owner', displayName: 'Owner', isAdmin: true });
  const gen = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId: ownerId,
    label: 'primary',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  const networkId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO networks (id, display_name, owner_id, description, created_at, updated_at) VALUES (?, 'Net', ?, 'desc', ?, ?)",
  ).run(networkId, ownerId, now, now);
  db.prepare(
    "INSERT INTO network_members (network_id, user_id, role, added_at, added_by) VALUES (?, ?, 'owner', ?, ?)",
  ).run(networkId, ownerId, now, ownerId);
  const app = await createServer({
    config: TEST_CONFIG,
    systemDb: sys,
    logger: createLogger('silent'),
    realtimeOptions,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return {
    app,
    sys,
    db,
    port: address.port,
    networkId,
    owner: { userId: ownerId, key: gen.key },
    sockets: [],
  };
}

/** Seed an additional user + key, optionally as a member of the network. */
function seedUser(running: RunningApp, username: string, asMemberOf?: string): SeededUser {
  const userId = randomUUID();
  running.sys.createUser({ id: userId, username, displayName: username });
  const gen = generateApiKey();
  running.sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'p',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  if (asMemberOf !== undefined) {
    running.db
      .prepare(
        "INSERT INTO network_members (network_id, user_id, role, added_at, added_by) VALUES (?, ?, 'member', ?, ?)",
      )
      .run(asMemberOf, userId, new Date().toISOString(), running.owner.userId);
  }
  return { userId, key: gen.key };
}

/** Open a WS client against `/api/v1/realtime` and register it for cleanup. */
function connect(
  running: RunningApp,
  networkId: string,
  key: string,
  clientId?: string,
): WebSocket {
  const url = new URL(`ws://127.0.0.1:${running.port}/api/v1/realtime`);
  url.searchParams.set('network_id', networkId);
  if (clientId !== undefined) {
    url.searchParams.set('client_id', clientId);
  }
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (clientId !== undefined) {
    headers['client-id'] = clientId;
  }
  const ws = new WebSocket(url, { headers });
  running.sockets.push(ws);
  return ws;
}

function waitForOpen(ws: WebSocket, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws: open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`ws: closed with ${code} before open`));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      reject(new Error('ws: already closed'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('ws: close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface ReceivedMessage {
  type?: unknown;
  [key: string]: unknown;
}

/** Buffered inbound-frame queue with predicate-based `next`. */
class MessageQueue {
  private readonly queue: ReceivedMessage[] = [];
  private readonly waiters: Array<{
    predicate: (m: ReceivedMessage) => boolean;
    resolve: (m: ReceivedMessage) => void;
  }> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) {
        return;
      }
      const received = msg as ReceivedMessage;
      const idx = this.waiters.findIndex((w) => w.predicate(received));
      if (idx >= 0) {
        const [waiter] = this.waiters.splice(idx, 1);
        waiter!.resolve(received);
      } else {
        this.queue.push(received);
      }
    });
  }

  /** Resolve with the next message matching `predicate` (default: any). */
  next(
    predicate: (m: ReceivedMessage) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<ReceivedMessage> {
    const idx = this.queue.findIndex(predicate);
    if (idx >= 0) {
      const [msg] = this.queue.splice(idx, 1);
      return Promise.resolve(msg!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.predicate === predicate);
        if (i >= 0) {
          this.waiters.splice(i, 1);
        }
        reject(new Error('ws: message timeout'));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

/** Sleep helper (keeps the event loop busy enough for delivery). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeSockets(...sockets: WebSocket[]): Promise<void> {
  await Promise.all(
    sockets.map((ws) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        return new Promise<void>((resolve) => {
          ws.once('close', () => resolve());
          ws.close();
        });
      }
      return Promise.resolve();
    }),
  );
}

describe(
  'realtime gateway',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    // The app under test of the current test. Cleaned up in `afterEach` so a
    // failure before a test's own `finally` (e.g. a `waitForOpen` timeout
    // under heavy parallel load) cannot leave the Fastify server listening
    // and hang the test process forever.
    let running: RunningApp | undefined;

    afterEach(async () => {
      if (running === undefined) return;
      await closeSockets(...running.sockets);
      await running.app.close();
      running.sys.close();
      running = undefined;
    });

    it('keeps a connection with a valid key open (E1)', async () => {
      running = await buildApp();
      const ws = connect(running, running.networkId, running.owner.key, 'client-1');
      try {
        await waitForOpen(ws);
        await delay(150);
        assert.equal(ws.readyState, WebSocket.OPEN);
      } finally {
        await closeSockets(ws);
        await running.app.close();
        running.sys.close();
      }
    });

    it('closes with 4401 when the API-key is invalid (E1)', async () => {
      running = await buildApp();
      const ws = connect(running, running.networkId, 'etn_badkeybadkey', 'client-1');
      try {
        const closed = await waitForClose(ws);
        assert.equal(closed.code, 4401);
      } finally {
        await running.app.close();
        running.sys.close();
      }
    });

    it('closes with 4404 when the network does not exist (E1)', async () => {
      running = await buildApp();
      const ws = connect(running, randomUUID(), running.owner.key, 'client-1');
      try {
        const closed = await waitForClose(ws);
        assert.equal(closed.code, 4404);
      } finally {
        await running.app.close();
        running.sys.close();
      }
    });

    it('closes with 4401 for a non-member of an existing network (04-realtime.md §2)', async () => {
      running = await buildApp();
      const outsider = seedUser(running, 'outsider');
      const ws = connect(running, running.networkId, outsider.key, 'client-1');
      try {
        const closed = await waitForClose(ws);
        assert.equal(closed.code, 4401);
      } finally {
        await running.app.close();
        running.sys.close();
      }
    });

    it('delivers network.updated to other members and suppresses the echo (E4)', async () => {
      running = await buildApp();
      const member = seedUser(running, 'member', running.networkId);
      const ownerWs = connect(running, running.networkId, running.owner.key, 'client-X');
      const memberWs = connect(running, running.networkId, member.key, 'client-Y');
      await waitForOpen(ownerWs);
      await waitForOpen(memberWs);
      const memberQ = new MessageQueue(memberWs);
      const ownerQ = new MessageQueue(ownerWs);
      try {
        const res = await running.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${running.networkId}`,
          headers: {
            authorization: `Bearer ${running.owner.key}`,
            'client-id': 'client-X',
          },
          payload: { display_name: 'Renamed' },
        });
        assert.equal(res.statusCode, 200);

        const event = await memberQ.next((m) => m.type === 'network.updated');
        assert.equal(event.seq, 1);
        const data = event.data as { display_name?: string };
        assert.equal(data.display_name, 'Renamed');

        // The originating client (client-X) must not receive the echo.
        await assert.rejects(ownerQ.next((m) => m.type === 'network.updated', 400));
      } finally {
        await closeSockets(ownerWs, memberWs);
        await running.app.close();
        running.sys.close();
      }
    });

    it('emits member.added to existing members (E3)', async () => {
      running = await buildApp();
      const member = seedUser(running, 'member', running.networkId);
      const newcomer = seedUser(running, 'newcomer');
      const memberWs = connect(running, running.networkId, member.key, 'client-Y');
      await waitForOpen(memberWs);
      const memberQ = new MessageQueue(memberWs);
      try {
        const res = await running.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${running.networkId}/members`,
          headers: { authorization: `Bearer ${running.owner.key}` },
          payload: { user_id: newcomer.userId },
        });
        assert.equal(res.statusCode, 201);

        const event = await memberQ.next((m) => m.type === 'member.added');
        const data = event.data as { user_id: string; role: string };
        assert.equal(data.user_id, newcomer.userId);
        assert.equal(data.role, 'member');
      } finally {
        await closeSockets(memberWs);
        await running.app.close();
        running.sys.close();
      }
    });

    it('routes audience=user events only to the same user (E4)', async () => {
      running = await buildApp();
      const member = seedUser(running, 'member', running.networkId);
      const ownerX = connect(running, running.networkId, running.owner.key, 'client-X');
      const ownerZ = connect(running, running.networkId, running.owner.key, 'client-Z');
      const memberY = connect(running, running.networkId, member.key, 'client-Y');
      await waitForOpen(ownerX);
      await waitForOpen(ownerZ);
      await waitForOpen(memberY);
      const qX = new MessageQueue(ownerX);
      const qZ = new MessageQueue(ownerZ);
      const qY = new MessageQueue(memberY);
      try {
        const res = await running.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${running.networkId}/preferences/show_inactive`,
          headers: {
            authorization: `Bearer ${running.owner.key}`,
            'client-id': 'client-X',
          },
          payload: { value: true },
        });
        assert.equal(res.statusCode, 200);

        // Another client of the same user receives it.
        const event = await qZ.next((m) => m.type === 'user-preference.updated');
        assert.equal(event.audience, 'user');
        // The acting client does not (echo), the other user does not (audience).
        await assert.rejects(qX.next((m) => m.type === 'user-preference.updated', 400));
        await assert.rejects(qY.next((m) => m.type === 'user-preference.updated', 400));
      } finally {
        await closeSockets(ownerX, ownerZ, memberY);
        await running.app.close();
        running.sys.close();
      }
    });

    it('replays missed events on resume and flags stale positions (E5)', async () => {
      running = await buildApp();
      // History: seq 1..3 already emitted before this client connects.
      for (const id of ['e1', 'e2', 'e3']) {
        emitDomainEvent(
          { systemDb: running.sys, pubsub: running.app.pubsub },
          running.networkId,
          'thought.deleted',
          { id },
          { user_id: running.owner.userId, client_id: 'someone-else' },
        );
      }
      const ws = connect(running, running.networkId, running.owner.key, 'client-1');
      await waitForOpen(ws);
      const q = new MessageQueue(ws);
      try {
        ws.send(JSON.stringify({ type: 'resume', last_seq: 1 }));
        const first = await q.next((m) => m.type === 'thought.deleted');
        const second = await q.next((m) => m.type === 'thought.deleted');
        assert.equal(first.seq, 2);
        assert.equal(second.seq, 3);

        // A position inside the retained window with nothing newer stays quiet.
        ws.send(JSON.stringify({ type: 'resume', last_seq: 3 }));
        await assert.rejects(q.next(() => true, 300));

        // Simulate retention eviction: drop seq 1..3, counter already at 3.
        running.db.prepare('DELETE FROM event_log WHERE seq <= 3').run();
        const evicted = emitDomainEvent(
          { systemDb: running.sys, pubsub: running.app.pubsub },
          running.networkId,
          'thought.deleted',
          { id: 'e4' },
          { user_id: running.owner.userId, client_id: 'someone-else' },
        );
        assert.equal(evicted.seq, 4);
        // seq 4 is retained; a client at 1 has a gap → resume.stale.
        ws.send(JSON.stringify({ type: 'resume', last_seq: 1 }));
        const stale = await q.next((m) => m.type === 'resume.stale');
        assert.equal(stale.last_seq, 3);
        // A client at the last retained-before-gap position gets the events.
        ws.send(JSON.stringify({ type: 'resume', last_seq: 3 }));
        const replayed = await q.next((m) => m.type === 'thought.deleted');
        assert.equal(replayed.seq, 4);
      } finally {
        await closeSockets(ws);
        await running.app.close();
        running.sys.close();
      }
    });

    it('sends periodic pings and answers client pings (E5)', async () => {
      running = await buildApp({ pingIntervalMs: 100, pongTimeoutMs: 60_000 });
      const ws = connect(running, running.networkId, running.owner.key, 'client-1');
      await waitForOpen(ws);
      const q = new MessageQueue(ws);
      try {
        const ping = await q.next((m) => m.type === 'ping');
        assert.ok(ping);
        ws.send(JSON.stringify({ type: 'pong' }));
        ws.send(JSON.stringify({ type: 'ping' }));
        const pong = await q.next((m) => m.type === 'pong');
        assert.ok(pong);
      } finally {
        await closeSockets(ws);
        await running.app.close();
        running.sys.close();
      }
    });

    it('closes a connection that stops answering pings (E5)', async () => {
      running = await buildApp({ pingIntervalMs: 100, pongTimeoutMs: 250 });
      const ws = connect(running, running.networkId, running.owner.key, 'client-1');
      await waitForOpen(ws);
      try {
        const closed = await waitForClose(ws, 3000);
        assert.equal(closed.code, 1001);
      } finally {
        await running.app.close();
        running.sys.close();
      }
    });

    it('streams to two clients of one user independently, with per-client echo (E6)', async () => {
      running = await buildApp();
      const member = seedUser(running, 'member', running.networkId);
      const ownerX = connect(running, running.networkId, running.owner.key, 'client-X');
      const ownerY = connect(running, running.networkId, running.owner.key, 'client-Y');
      await waitForOpen(ownerX);
      await waitForOpen(ownerY);
      const qX = new MessageQueue(ownerX);
      const qY = new MessageQueue(ownerY);
      try {
        // A change made by the *member* (emitted the same way the D-phase
        // routes will emit) reaches both of the owner's clients. Plain REST
        // PATCH is not used here — members may not edit the network.
        emitDomainEvent(
          { systemDb: running.sys, pubsub: running.app.pubsub },
          running.networkId,
          'network.updated',
          { display_name: 'By member' },
          { user_id: member.userId, client_id: 'client-Z' },
        );
        const onX = await qX.next((m) => m.type === 'network.updated');
        const onY = await qY.next((m) => m.type === 'network.updated');
        assert.equal(onX.seq, onY.seq);

        // A change made by client-X reaches client-Y but not client-X itself.
        const res2 = await running.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${running.networkId}`,
          headers: {
            authorization: `Bearer ${running.owner.key}`,
            'client-id': 'client-X',
          },
          payload: { display_name: 'By X' },
        });
        assert.equal(res2.statusCode, 200);
        const onY2 = await qY.next((m) => m.type === 'network.updated');
        assert.equal(onY2.seq, (onX.seq as number) + 1);
        await assert.rejects(qX.next((m) => m.type === 'network.updated', 400));
      } finally {
        await closeSockets(ownerX, ownerY);
        await running.app.close();
        running.sys.close();
      }
    });

    it('accepts a client-id only via the hello frame (11-settings-and-state.md §1.1)', async () => {
      running = await buildApp();
      // Connect without any client-id (header/query).
      const url = new URL(`ws://127.0.0.1:${running.port}/api/v1/realtime`);
      url.searchParams.set('network_id', running.networkId);
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${running.owner.key}` },
      });
      running.sockets.push(ws);
      await waitForOpen(ws);
      const q = new MessageQueue(ws);
      try {
        ws.send(JSON.stringify({ type: 'hello', client_id: 'late-client' }));
        // A ping right after hello: frames are processed in order, so the
        // pong reply proves the server has applied the hello client-id.
        ws.send(JSON.stringify({ type: 'ping' }));
        await q.next((m) => m.type === 'pong');
        // The actor (owner, client 'late-client') emits; echo must be suppressed.
        const res = await running.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${running.networkId}`,
          headers: {
            authorization: `Bearer ${running.owner.key}`,
            'client-id': 'late-client',
          },
          payload: { display_name: 'Hello' },
        });
        assert.equal(res.statusCode, 200);
        await assert.rejects(q.next((m) => m.type === 'network.updated', 400));
      } finally {
        await closeSockets(ws);
        await running.app.close();
        running.sys.close();
      }
    });
  },
);
