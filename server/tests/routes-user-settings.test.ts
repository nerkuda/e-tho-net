/**
 * Integration tests for the L3s server-level user settings API
 * (task f57524ab, ADR 3a829d25, spec «/api/v1/users/me/settings»).
 *
 *   GET  /api/v1/users/me/settings        — map «key → value» of the own user
 *   PUT  /api/v1/users/me/settings/:key   — set one key
 *
 * Covers save/read round-trip, isolation between users, last-write-wins and
 * value validation. Requires the `better-sqlite3` native binding; skipped
 * otherwise.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { DEFAULT_MCP_SESSION_IDLE_TTL_MS } from '../src/config.js';
import type { ServerConfig } from '../src/config.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';

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
  mcp: { enabled: false, port: null, sessionIdleTtlMs: DEFAULT_MCP_SESSION_IDLE_TTL_MS },
  readerPool: { size: 1, taskTimeoutMs: 30000 },
};

interface SeededUser {
  userId: string;
  key: string;
}

/** Seed a user + one API key; returns the plaintext key for Authorization. */
function seedUser(sys: SystemDb, username: string): SeededUser {
  const userId = randomUUID();
  sys.createUser({ id: userId, username, displayName: username });
  const gen = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'primary',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  return { userId, key: gen.key };
}

/** Build the app with two independent users. */
async function buildApp(): Promise<{
  app: FastifyInstance;
  sys: SystemDb;
  db: Database.Database;
  alice: SeededUser;
  bob: SeededUser;
}> {
  const db: Database.Database = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);
  const alice = seedUser(sys, 'alice');
  const bob = seedUser(sys, 'bob');
  const app = await createServer({
    config: TEST_CONFIG,
    systemDb: sys,
    logger: createLogger('silent'),
  });
  return { app, sys, db, alice, bob };
}

/** GET settings as the given user. */
async function getSettings(app: FastifyInstance, user: SeededUser) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/users/me/settings',
    headers: { authorization: `Bearer ${user.key}` },
  });
}

/** PUT one setting as the given user. */
async function putSetting(
  app: FastifyInstance,
  user: SeededUser,
  key: string,
  value: unknown,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/users/me/settings/${key}`,
    headers: { authorization: `Bearer ${user.key}` },
    payload: { value },
  });
}

describe(
  '/users/me/settings routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('PUT then GET round-trips comment_hotkeys for the same user', async () => {
      const { app, alice } = await buildApp();
      const hotkeys = { bold: 'Ctrl+B', italic: 'Ctrl+I' };

      const put = await putSetting(app, alice, 'comment_hotkeys', hotkeys);
      assert.equal(put.statusCode, 200);
      assert.deepEqual(put.json().data, { key: 'comment_hotkeys', value: hotkeys });

      const get = await getSettings(app, alice);
      assert.equal(get.statusCode, 200);
      assert.deepEqual(get.json().data, { comment_hotkeys: hotkeys });
    });

    it('settings are isolated per user (server-level, no network)', async () => {
      const { app, alice, bob } = await buildApp();
      await putSetting(app, alice, 'comment_hotkeys', { bold: 'Ctrl+B' });

      const bobGet = await getSettings(app, bob);
      assert.equal(bobGet.statusCode, 200);
      assert.deepEqual(bobGet.json().data, {});

      // Bob writes his own value; Alice is unaffected.
      await putSetting(app, bob, 'comment_hotkeys', { bold: 'Meta+B' });
      const aliceGet = await getSettings(app, alice);
      assert.deepEqual(aliceGet.json().data, { comment_hotkeys: { bold: 'Ctrl+B' } });
      const bobGet2 = await getSettings(app, bob);
      assert.deepEqual(bobGet2.json().data, { comment_hotkeys: { bold: 'Meta+B' } });
    });

    it('PUT is last-write-wins per key', async () => {
      const { app, alice } = await buildApp();
      await putSetting(app, alice, 'comment_hotkeys', { bold: 'Ctrl+B' });
      await putSetting(app, alice, 'comment_hotkeys', { bold: 'Alt+B' });
      const get = await getSettings(app, alice);
      assert.deepEqual(get.json().data, { comment_hotkeys: { bold: 'Alt+B' } });
    });

    it('unknown keys are accepted as-is (future server settings)', async () => {
      const { app, alice } = await buildApp();
      const put = await putSetting(app, alice, 'future_setting', { nested: [1, 2, 3] });
      assert.equal(put.statusCode, 200);
      const get = await getSettings(app, alice);
      assert.deepEqual(get.json().data, { future_setting: { nested: [1, 2, 3] } });
    });

    it('rejects a missing value field', async () => {
      const { app, alice } = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/users/me/settings/comment_hotkeys',
        headers: { authorization: `Bearer ${alice.key}` },
        payload: {},
      });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR');
      assert.equal(res.json().error.details.field, 'value');
    });

    it('rejects a non-object comment_hotkeys value', async () => {
      const { app, alice } = await buildApp();
      const res = await putSetting(app, alice, 'comment_hotkeys', 'Ctrl+B');
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    });

    it('rejects a comment_hotkeys combination that is not a string', async () => {
      const { app, alice } = await buildApp();
      const res = await putSetting(app, alice, 'comment_hotkeys', { bold: 42 });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    });

    it('requires authentication', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/settings',
      });
      assert.equal(res.statusCode, 401);
    });
  },
);
