/**
 * Integration tests for the idempotency middleware (task B11).
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise. Builds a
 * minimal Fastify app (a mutating POST route with a side-effecting counter),
 * registers the idempotency preHandler + onSend hook, and verifies cache replay
 * semantics via `app.inject`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';

import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createLogger } from '../src/logger.js';
import { createIdempotencyMiddleware, registerIdempotencyHooks } from '../src/http/idempotency.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Build a minimal Fastify app whose POST / echoes a body and bumps a counter. */
async function buildApp(
  systemDb: SystemDb,
): Promise<{ app: FastifyInstance; calls: { value: number } }> {
  const calls = { value: 0 };
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.decorateRequest('idempotency', null);
  const mw = createIdempotencyMiddleware(systemDb, createLogger('silent'));
  registerIdempotencyHooks(app, systemDb, createLogger('silent'));
  app.post('/', { preHandler: [mw.preHandler] }, async (req, reply) => {
    calls.value += 1;
    return reply
      .code(201)
      .send({ ok: true, n: calls.value, seen: (req.body as { x?: number } | null)?.x ?? null });
  });
  // NOTE: do not call app.ready() here — the test adds a global preHandler
  // (to populate request.auth) before the first inject triggers ready().
  return { app, calls };
}

describe(
  'idempotency middleware',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    function openDb(): Database.Database {
      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, systemMigrationsDir());
      return db;
    }

    it('replays the cached 2xx response on a repeated Client-Request-Id', async () => {
      const db = openDb();
      const sys = new SystemDb(db);
      const { app, calls } = await buildApp(sys);
      try {
        const userId = randomUUID();
        const requestId = randomUUID();
        // Simulate auth: preHandler expects request.auth populated by an earlier hook.
        app.addHook('preHandler', async (req) => {
          req.auth = {
            user: { id: userId },
            keyId: 'k',
            keyReadOnly: false,
            keyPrefix: 'p',
            clientId: null,
          } as never;
        });

        const first = await app.inject({
          method: 'POST',
          url: '/',
          headers: { 'client-request-id': requestId },
          payload: { x: 1 },
        });
        assert.equal(first.statusCode, 201);
        assert.deepEqual(first.json(), { ok: true, n: 1, seen: 1 });
        assert.equal(calls.value, 1, 'handler ran once');

        const replay = await app.inject({
          method: 'POST',
          url: '/',
          headers: { 'client-request-id': requestId },
          payload: { x: 999 },
        });
        assert.equal(replay.statusCode, 201);
        assert.deepEqual(
          replay.json(),
          { ok: true, n: 1, seen: 1 },
          'replayed the original body, ignoring the new payload',
        );
        assert.equal(calls.value, 1, 'handler did NOT run on replay');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('does not cache non-2xx responses', async () => {
      const db = openDb();
      const sys = new SystemDb(db);
      const app = Fastify();
      app.decorateRequest('auth', null);
      app.decorateRequest('idempotency', null);
      const mw = createIdempotencyMiddleware(sys, createLogger('silent'));
      registerIdempotencyHooks(app, sys, createLogger('silent'));
      const userId = randomUUID();
      app.addHook('preHandler', async (req) => {
        req.auth = { user: { id: userId } } as never;
      });
      app.post('/err', { preHandler: [mw.preHandler] }, async (_req, reply) => {
        return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'nope' } });
      });
      try {
        const requestId = randomUUID();
        const r1 = await app.inject({
          method: 'POST',
          url: '/err',
          headers: { 'client-request-id': requestId },
          payload: {},
        });
        assert.equal(r1.statusCode, 422);
        const r2 = await app.inject({
          method: 'POST',
          url: '/err',
          headers: { 'client-request-id': requestId },
          payload: {},
        });
        assert.equal(r2.statusCode, 422);
        // No cached entry should exist.
        assert.equal(sys.findCachedResponse(requestId, userId), null);
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('ignores GET requests and requests without the header', async () => {
      const db = openDb();
      const sys = new SystemDb(db);
      const { app, calls } = await buildApp(sys);
      try {
        const userId = randomUUID();
        app.addHook('preHandler', async (req) => {
          req.auth = { user: { id: userId } } as never;
        });
        app.get('/g', { preHandler: [] }, async (_req, reply) =>
          reply.code(200).send({ ok: true }),
        );
        // GET with the header: no caching.
        const g = await app.inject({
          method: 'GET',
          url: '/g',
          headers: { 'client-request-id': randomUUID() },
        });
        assert.equal(g.statusCode, 200);
        // POST without the header: handler runs normally, not cached.
        const p = await app.inject({ method: 'POST', url: '/', payload: { x: 7 } });
        assert.equal(p.statusCode, 201);
        assert.equal(calls.value, 1);
      } finally {
        await app.close();
        sys.close();
      }
    });
  },
);
