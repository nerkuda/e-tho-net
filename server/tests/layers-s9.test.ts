/**
 * Integration tests for real-time + `etn.changes.list` layer visibility
 * (task S9, docs/13-layers.md §12, docs/04-realtime.md §11).
 *
 *   * a write materialised in a non-base layer never reaches a subscriber
 *     sitting on a different layer (including the base);
 *   * a base write reaches every subscriber whose layer has not overridden
 *     the row, and stops reaching a subscriber the moment it does override
 *     it;
 *   * switching a session's layer (REST `POST .../layers/:id/select`) forces
 *     a resync on the connections of that exact `(user_id, client_id)`:
 *     a `layer.switched` control frame while connected, and `resume.stale`
 *     on `resume` even when the requested `last_seq` is inside the retained
 *     window;
 *   * `etn.changes.list` mirrors both rules — layer-filtered events and
 *     `truncated: true` once the session's layer switched past `since_seq`.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import { BASE_LAYER_ID, type McpChangesListResult } from '@etn/shared';

import type { ServerConfig } from '../src/config.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';
import { closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import { createLayer, setSessionLayer } from '../src/domain/layer-service.js';
import { PubSub } from '../src/realtime/pubsub.js';
import { connectMcpClient, toolJson } from './mcp-helpers.js';

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
  dataDir: '',
  host: '127.0.0.1',
  port: 0,
  tls: null,
  logLevel: 'silent',
  mcp: { enabled: false, port: null },
};

interface SeededUser {
  userId: string;
  key: string;
  /** `api_keys.id` — needed to reproduce the MCP layer client id (S10). */
  keyId: string;
}

interface RunningApp {
  app: FastifyInstance;
  sys: SystemDb;
  db: Database.Database;
  dataDir: string;
  port: number;
  networkId: string;
  owner: SeededUser;
  sockets: WebSocket[];
}

/** Build a server on an ephemeral port + a real per-network `data.db` on a temp dir. */
async function buildApp(): Promise<RunningApp> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-s9-'));

  const db: Database.Database = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);
  const ownerId = randomUUID();
  sys.createUser({ id: ownerId, username: 'owner', displayName: 'Owner', isAdmin: true });
  const gen = generateApiKey();
  const ownerKeyId = randomUUID();
  sys.createApiKey({
    id: ownerKeyId,
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
    config: { ...TEST_CONFIG, dataDir },
    systemDb: sys,
    logger: createLogger('silent'),
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
    dataDir,
    port: address.port,
    networkId,
    owner: { userId: ownerId, key: gen.key, keyId: ownerKeyId },
    sockets: [],
  };
}

function seedUser(running: RunningApp, username: string, asMemberOf?: string): SeededUser {
  const userId = randomUUID();
  running.sys.createUser({ id: userId, username, displayName: username });
  const gen = generateApiKey();
  const keyId = randomUUID();
  running.sys.createApiKey({
    id: keyId,
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
  return { userId, key: gen.key, keyId };
}

function connect(running: RunningApp, key: string, clientId: string): WebSocket {
  const url = new URL(`ws://127.0.0.1:${running.port}/api/v1/realtime`);
  url.searchParams.set('network_id', running.networkId);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}`, 'client-id': clientId } });
  running.sockets.push(ws);
  return ws;
}

function waitForOpen(ws: WebSocket, timeoutMs = 10_000): Promise<void> {
  // Localhost WebSocket upgrades often complete before this helper attaches
  // its `once('open')` listener — `ws` schedules the connect via microtasks,
  // while the Fastify handleConnection finishes in tens of ms and the 101 is
  // already on the wire by the time `await waitForOpen` runs. Check
  // `readyState` first so we don't miss the event and fall through to the
  // timeout — task 2be2c348 (shared helper with realtime-gateway.test.ts).
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
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

interface ReceivedMessage {
  type?: unknown;
  [key: string]: unknown;
}

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
      if (typeof msg !== 'object' || msg === null) return;
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

  next(predicate: (m: ReceivedMessage) => boolean = () => true, timeoutMs = 5000): Promise<ReceivedMessage> {
    const idx = this.queue.findIndex(predicate);
    if (idx >= 0) {
      const [msg] = this.queue.splice(idx, 1);
      return Promise.resolve(msg!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.predicate === predicate);
        if (i >= 0) this.waiters.splice(i, 1);
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

async function selectLayer(running: RunningApp, key: string, layerId: string, clientId: string): Promise<void> {
  const res = await running.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${running.networkId}/layers/${layerId}/select`,
    headers: { authorization: `Bearer ${key}`, 'client-id': clientId },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

async function postThought(
  running: RunningApp,
  key: string,
  clientId: string,
  title: string,
): Promise<{ id: string; version: number }> {
  const res = await running.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${running.networkId}/thoughts`,
    headers: { authorization: `Bearer ${key}`, 'client-id': clientId },
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as { id: string; version: number };
}

async function patchThought(
  running: RunningApp,
  key: string,
  clientId: string,
  id: string,
  version: number,
  title: string,
): Promise<void> {
  const res = await running.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${running.networkId}/thoughts/${id}`,
    headers: { authorization: `Bearer ${key}`, 'client-id': clientId, 'if-match': String(version) },
    payload: { title },
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

describe(
  'layer visibility of real-time + changes.list (S9)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let running: RunningApp | undefined;

    afterEach(async () => {
      if (running === undefined) return;
      const fs = await import('node:fs');
      await closeSockets(...running.sockets);
      await running.app.close();
      closeNetworkDb(running.networkId);
      running.sys.close();
      fs.rmSync(running.dataDir, { recursive: true, force: true });
      running = undefined;
    });

    it('a write in a non-base layer never reaches a base subscriber (13-layers.md §12)', async () => {
      running = await buildApp();
      // A second member sits on the base and watches.
      const member = seedUser(running, 'member', running.networkId);
      const baseWs = connect(running, member.key, 'client-base');
      await waitForOpen(baseWs);
      const baseQ = new MessageQueue(baseWs);
      try {
        const layerRes = await running.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${running.networkId}/layers`,
          headers: { authorization: `Bearer ${running.owner.key}` },
          payload: { title: 'Слой A' },
        });
        assert.equal(layerRes.statusCode, 201);
        const layerId = (layerRes.json().data as { id: string }).id;
        await selectLayer(running, running.owner.key, layerId, 'client-A');

        await postThought(running, running.owner.key, 'client-A', 'Мысль слоя A');

        // The base subscriber must never see it.
        await assert.rejects(baseQ.next((m) => m.type === 'thought.created', 400));
      } finally {
        await closeSockets(baseWs);
      }
    });

    it('a layer-A subscriber does not see a layer-B write, and vice versa', async () => {
      running = await buildApp();
      const layerARes = await running.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${running.networkId}/layers`,
        headers: { authorization: `Bearer ${running.owner.key}` },
        payload: { title: 'A' },
      });
      const layerA = (layerARes.json().data as { id: string }).id;
      const layerBRes = await running.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${running.networkId}/layers`,
        headers: { authorization: `Bearer ${running.owner.key}` },
        payload: { title: 'B' },
      });
      const layerB = (layerBRes.json().data as { id: string }).id;

      // Watcher sessions sit on A and B; writers use their own client ids so
      // the watchers' sockets are not echo-suppressed (04-realtime.md §5, §9 —
      // a connection never receives the events of its own client id).
      await selectLayer(running, running.owner.key, layerA, 'client-A');
      await selectLayer(running, running.owner.key, layerB, 'client-B');
      await selectLayer(running, running.owner.key, layerA, 'writer-A');
      await selectLayer(running, running.owner.key, layerB, 'writer-B');

      const wsA = connect(running, running.owner.key, 'client-A');
      const wsB = connect(running, running.owner.key, 'client-B');
      await waitForOpen(wsA);
      await waitForOpen(wsB);
      const qA = new MessageQueue(wsA);
      const qB = new MessageQueue(wsB);
      try {
        await postThought(running, running.owner.key, 'writer-A', 'В слое A');
        await qA.next((m) => m.type === 'thought.created');
        await assert.rejects(qB.next((m) => m.type === 'thought.created', 400));

        await postThought(running, running.owner.key, 'writer-B', 'В слое B');
        await qB.next((m) => m.type === 'thought.created');
        await assert.rejects(qA.next((m) => m.type === 'thought.created', 400));
      } finally {
        await closeSockets(wsA, wsB);
      }
    });

    it('a base write reaches an unoverridden layer subscriber, but stops once overridden (§4.1, §12)', async () => {
      running = await buildApp();
      const layerRes = await running.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${running.networkId}/layers`,
        headers: { authorization: `Bearer ${running.owner.key}` },
        payload: { title: 'Слой' },
      });
      const layerId = (layerRes.json().data as { id: string }).id;
      await selectLayer(running, running.owner.key, layerId, 'client-L');

      const wsL = connect(running, running.owner.key, 'client-L');
      await waitForOpen(wsL);
      const qL = new MessageQueue(wsL);
      try {
        // A base write from another client — the layer session has not
        // touched this thought yet, so it is transparent (§4.1).
        const t = await postThought(running, running.owner.key, 'client-base', 'Мысль основы');
        const created = await qL.next((m) => m.type === 'thought.created');
        assert.equal((created.data as { thought: { id: string } }).thought.id, t.id);

        // The layer session overrides it — a shadow row materialises. The
        // write comes from a sibling client of the layer session: the watcher
        // socket (`client-L`) would suppress its own echo (04-realtime.md §9).
        await selectLayer(running, running.owner.key, layerId, 'writer-L');
        await patchThought(running, running.owner.key, 'writer-L', t.id, t.version, 'Перекрыто в слое');
        await qL.next((m) => m.type === 'thought.updated');

        // A further base edit of the SAME thought (base client re-fetches to
        // get the current base version) must no longer reach the layer
        // subscriber — the row is overridden.
        const baseGet = await running.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${running.networkId}/thoughts/${t.id}`,
          headers: { authorization: `Bearer ${running.owner.key}`, 'client-id': 'client-base' },
        });
        assert.equal(baseGet.statusCode, 200);
        const baseVersion = (baseGet.json().data as { version: number }).version;
        await patchThought(running, running.owner.key, 'client-base', t.id, baseVersion, 'Ещё правка в основе');
        await assert.rejects(qL.next((m) => m.type === 'thought.updated', 400));
      } finally {
        await closeSockets(wsL);
      }
    });

    it('a physically purged row still reaches a layer subscriber as *.deleted (purge fan-out)', async () => {
      running = await buildApp();
      const layerRes = await running.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${running.networkId}/layers`,
        headers: { authorization: `Bearer ${running.owner.key}` },
        payload: { title: 'Слой' },
      });
      const layerId = (layerRes.json().data as { id: string }).id;
      await selectLayer(running, running.owner.key, layerId, 'client-L');

      const wsL = connect(running, running.owner.key, 'client-L');
      await waitForOpen(wsL);
      const qL = new MessageQueue(wsL);
      try {
        // A base thought the layer subscriber sees transparently (§4.1).
        const t = await postThought(running, running.owner.key, 'client-base', 'На удаление');
        await qL.next((m) => m.type === 'thought.created');

        // Mark it in the base (S13) — visible in the layer as well.
        const markRes = await running.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${running.networkId}/thoughts/${t.id}`,
          headers: {
            authorization: `Bearer ${running.owner.key}`,
            'client-id': 'client-base2',
            'if-match': String(t.version),
          },
          payload: { marked_for_deletion: true },
        });
        assert.equal(markRes.statusCode, 200, markRes.body?.toString());
        await qL.next((m) => m.type === 'thought.updated');

        // Physical purge from a base session: the row disappears from every
        // chain, so the visibility lookup finds nothing — the `*.deleted`
        // fan-out must still reach the layer subscriber (task S9: no row on
        // the chain + `*.deleted` → deliver), or its cache keeps the thought.
        const purgeRes = await running.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${running.networkId}/trash/purge`,
          headers: { authorization: `Bearer ${running.owner.key}`, 'client-id': 'client-base2' },
          payload: {},
        });
        assert.equal(purgeRes.statusCode, 200, purgeRes.body?.toString());
        const deleted = await qL.next((m) => m.type === 'thought.deleted');
        assert.equal((deleted.data as { id: string }).id, t.id);
      } finally {
        await closeSockets(wsL);
      }
    });

    it('switching layer pushes layer.switched to live connections and forces resume.stale (§12)', async () => {
      running = await buildApp();
      const layerRes = await running.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${running.networkId}/layers`,
        headers: { authorization: `Bearer ${running.owner.key}` },
        payload: { title: 'Новый слой' },
      });
      const layerId = (layerRes.json().data as { id: string }).id;

      const ws = connect(running, running.owner.key, 'client-S');
      await waitForOpen(ws);
      const q = new MessageQueue(ws);
      try {
        // A couple of base events raise last_seq before the switch.
        await postThought(running, running.owner.key, 'client-other', 'До переключения 1');
        await postThought(running, running.owner.key, 'client-other', 'До переключения 2');
        await q.next((m) => m.type === 'thought.created');
        const secondSeq = (await q.next((m) => m.type === 'thought.created')).seq as number;

        await selectLayer(running, running.owner.key, layerId, 'client-S');
        const switched = await q.next((m) => m.type === 'layer.switched');
        assert.equal((switched.layer as { id: string }).id, layerId);

        // A `resume` from before the switch is refused even though the seq
        // is still inside the retained window (13-layers.md §12): the cache
        // was built under the old layer's filter, so the delta cannot bridge
        // the switch. Positions at/after `switched_at_seq` are trusted — the
        // `layer.switched` frame above already obliged the client to resync.
        ws.send(JSON.stringify({ type: 'resume', last_seq: secondSeq - 1 }));
        const stale = await q.next((m) => m.type === 'resume.stale');
        assert.ok((stale.last_seq as number) >= secondSeq);
      } finally {
        await closeSockets(ws);
      }
    });

    it('etn.changes.list reports truncated after the session layer switches past since_seq (§12)', async () => {
      running = await buildApp();
      // Two base events establish a baseline seq the agent has "already seen".
      await postThought(running, running.owner.key, 'client-x', 'Раз');
      const t2 = await postThought(running, running.owner.key, 'client-x', 'Два');

      const mcpCtx = {
        sys: running.sys,
        dataDir: running.dataDir,
        pubsub: new PubSub(),
      } as unknown as Parameters<typeof connectMcpClient>[0];
      const handle = await connectMcpClient(mcpCtx, running.owner.key);
      try {
        const baseline = toolJson<McpChangesListResult>(
          await handle.client.callTool({
            name: 'etn.changes.list',
            arguments: { network_id: running.networkId, since_seq: 0 },
          }),
        );
        const seenSeq = baseline.cursor.max_seq ?? 0;
        assert.ok(seenSeq >= 2, `expected at least 2 events, got ${seenSeq}`);

        // No switch yet: replaying from `seenSeq` is not truncated.
        const before = toolJson<McpChangesListResult>(
          await handle.client.callTool({
            name: 'etn.changes.list',
            arguments: { network_id: running.networkId, since_seq: seenSeq },
          }),
        );
        assert.equal(before.truncated, false);

        // Simulate the agent's session switching layer — the same coordinate
        // (`user_id`, `mcp:<keyId>`) `etn.changes.list` resolves via
        // `mcpLayerClientId` (S10, 13-layers.md §7.1). The test drives the
        // domain service directly rather than `etn.layers.select` (exercised
        // separately) to keep this test focused on the delta-feed contract.
        const ndb = openNetworkDb(running.dataDir, running.networkId, undefined);
        const newLayer = createLayer(ndb, {
          parentId: BASE_LAYER_ID,
          title: 'Слой агента',
          createdBy: running.owner.userId,
        });
        setSessionLayer(ndb, running.owner.userId, `mcp:${running.owner.keyId}`, newLayer.id, seenSeq + 1);

        // The old cursor now spans the switch: forced full resync.
        const after = toolJson<McpChangesListResult>(
          await handle.client.callTool({
            name: 'etn.changes.list',
            arguments: { network_id: running.networkId, since_seq: seenSeq },
          }),
        );
        assert.equal(after.truncated, true);

        // A cursor already at/after the switch point is fine again.
        const caughtUp = toolJson<McpChangesListResult>(
          await handle.client.callTool({
            name: 'etn.changes.list',
            arguments: { network_id: running.networkId, since_seq: seenSeq + 1 },
          }),
        );
        assert.equal(caughtUp.truncated, false);
        void t2;
      } finally {
        await handle.close();
      }
    });
  },
);
