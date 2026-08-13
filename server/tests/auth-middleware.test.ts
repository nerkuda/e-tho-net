/**
 * Integration tests for the authentication preHandler (task B8).
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise. Uses an
 * in-memory migrated `_system.db` and minimal req/reply doubles to exercise
 * the success path, malformed/unknown-key failures, the rate-limit ban, and
 * the `last_used_at` update.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { createLogger } from '../src/logger.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createAuthPreHandler } from '../src/auth/auth-middleware.js';
import { AuthRateLimiter } from '../src/auth/rate-limiter.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Minimal req/reply doubles for exercising a Fastify preHandler. */
interface FakeReply {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  code(c: number): FakeReply;
  header(name: string, value: string): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReq(opts: { authHeader?: string; clientId?: string; ip?: string }) {
  const headers: Record<string, string> = {};
  if (opts.authHeader !== undefined) headers.authorization = opts.authHeader;
  if (opts.clientId !== undefined) headers['client-id'] = opts.clientId;
  return { headers, id: randomUUID(), ip: opts.ip ?? '203.0.113.7', auth: null };
}

function makeReply(): FakeReply {
  const r: FakeReply = {
    statusCode: 200,
    body: undefined,
    headers: {},
    code(c) {
      this.statusCode = c;
      return this;
    },
    header(name, value) {
      this.headers[name] = value;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
  return r;
}

describe(
  'auth preHandler',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    function setup() {
      const db: Database.Database = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, systemMigrationsDir());
      const sys = new SystemDb(db);
      const userId = randomUUID();
      const user = sys.createUser({
        id: userId,
        username: 'alice',
        displayName: 'Alice',
        isAdmin: true,
        isFirstUser: true,
      });
      const gen = generateApiKey();
      sys.createApiKey({
        id: randomUUID(),
        userId,
        label: 'primary',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const rateLimiter = new AuthRateLimiter();
      const preHandler = createAuthPreHandler({
        systemDb: sys,
        rateLimiter,
        logger: createLogger('silent'),
      });
      return { sys, user, key: gen.key, preHandler, rateLimiter };
    }

    it('populates request.auth for a valid bearer key', async () => {
      const { sys, key, user, preHandler } = setup();
      try {
        const req = makeReq({ authHeader: `Bearer ${key}`, clientId: 'client-xyz' });
        const reply = makeReply();
        await preHandler(req as never, reply as never);
        assert.equal(reply.statusCode, 200);
        assert.equal(req.auth?.user.id, user.id);
        assert.equal(req.auth?.clientId, 'client-xyz');
        assert.equal(req.auth?.keyPrefix.length > 0, true);
      } finally {
        sys.close();
      }
    });

    it('returns 401 when the Authorization header is missing', async () => {
      const { sys, preHandler } = setup();
      try {
        const req = makeReq({});
        const reply = makeReply();
        await preHandler(req as never, reply as never);
        assert.equal(reply.statusCode, 401);
        assert.deepEqual((reply.body as { error: { code: string } }).error.code, 'UNAUTHORIZED');
        assert.equal(req.auth, null);
      } finally {
        sys.close();
      }
    });

    it('returns 401 for a malformed token', async () => {
      const { sys, preHandler } = setup();
      try {
        const req = makeReq({ authHeader: 'Bearer not-a-valid-key' });
        const reply = makeReply();
        await preHandler(req as never, reply as never);
        assert.equal(reply.statusCode, 401);
      } finally {
        sys.close();
      }
    });

    it('returns 401 for an unknown key', async () => {
      const { sys, preHandler } = setup();
      try {
        const other = generateApiKey().key;
        const req = makeReq({ authHeader: `Bearer ${other}` });
        const reply = makeReply();
        await preHandler(req as never, reply as never);
        assert.equal(reply.statusCode, 401);
      } finally {
        sys.close();
      }
    });

    it('updates last_used_at asynchronously after success', async () => {
      const { sys, key, preHandler } = setup();
      try {
        const req = makeReq({ authHeader: `Bearer ${key}` });
        await preHandler(req as never, makeReply() as never);
        // The setImmediate callback runs on the next tick of the event loop.
        await new Promise((resolve) => setImmediate(resolve));
        const found = sys.findApiKeyByHash(hashApiKey(key));
        assert.ok(found !== null, 'key should resolve');
        assert.ok(found.apiKey.last_used_at !== null, 'last_used_at should be set after auth');
      } finally {
        sys.close();
      }
    });

    it('returns 429 once the failure threshold is crossed', async () => {
      const { sys } = setup();
      try {
        // Force the threshold down for a fast test: threshold=1 means the 2nd
        // failure bans the bucket, and that request itself gets 429.
        const thinLimiter = new AuthRateLimiter(1, 5);
        const fastPreHandler = createAuthPreHandler({
          systemDb: sys,
          rateLimiter: thinLimiter,
          logger: createLogger('silent'),
        });
        const req = makeReq({ authHeader: 'Bearer malformed' });
        await fastPreHandler(req as never, makeReply() as never); // 1st failure: 401, count=1
        const reply = makeReply();
        await fastPreHandler(req as never, reply as never); // 2nd failure: ban triggered → 429
        assert.equal(reply.statusCode, 429);
        assert.deepEqual((reply.body as { error: { code: string } }).error.code, 'RATE_LIMITED');
        assert.ok(reply.headers['retry-after'] !== undefined);
      } finally {
        sys.close();
      }
    });
  },
);
