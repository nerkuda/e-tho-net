/**
 * Integration tests for /me and /admin/users routes (task B12) via app.inject.
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise. Builds the
 * production Fastify app over an in-memory `_system.db` seeded with an admin and
 * exercises auth, self-service keys and admin user management.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

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
};

/** Seed user + key material. */
interface SeededUser {
  userId: string;
  key: string;
}

/** Build the full app over an in-memory db with one admin seeded. */
async function buildApp(): Promise<{ app: FastifyInstance; sys: SystemDb; admin: SeededUser }> {
  const db: Database.Database = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);
  const adminId = randomUUID();
  sys.createUser({
    id: adminId,
    username: 'admin',
    displayName: 'Admin',
    isAdmin: true,
    isFirstUser: true,
  });
  const gen = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId: adminId,
    label: 'primary',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  const app = await createServer({
    config: TEST_CONFIG,
    systemDb: sys,
    logger: createLogger('silent'),
  });
  return { app, sys, admin: { userId: adminId, key: gen.key } };
}

/** Seed an extra user (admin or not) and return its key. */
function seedUser(sys: SystemDb, username: string, isAdmin: boolean): SeededUser {
  const userId = randomUUID();
  sys.createUser({ id: userId, username, displayName: username, isAdmin });
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

describe(
  '/me and /admin/users routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('rejects anonymous requests with 401', async () => {
      const { app, sys } = await buildApp();
      try {
        const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
        assert.equal(res.statusCode, 401);
        assert.equal(res.json().error.code, 'UNAUTHORIZED');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('GET /me returns the authenticated user', async () => {
      const { app, sys, admin } = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(res.statusCode, 200);
        const data = res.json().data;
        assert.equal(data.username, 'admin');
        assert.equal(data.is_admin, true);
        assert.equal('key' in data, false, 'must not leak key material');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('creates and lists own keys, full key returned once', async () => {
      const { app, sys, admin } = await buildApp();
      try {
        const create = await app.inject({
          method: 'POST',
          url: '/api/v1/me/keys',
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { label: 'laptop', read_only: true },
        });
        assert.equal(create.statusCode, 201);
        const created = create.json().data;
        assert.equal(typeof created.key, 'string');
        assert.match(created.key, /^etn_[0-9a-f]{32}$/);
        assert.equal(created.read_only, true);

        const list = await app.inject({
          method: 'GET',
          url: '/api/v1/me/keys',
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(list.statusCode, 200);
        const items = list.json().data as Array<{ key?: string; prefix: string }>;
        assert.ok(items.length >= 2);
        assert.ok(
          items.every((k) => k.key === undefined),
          'list must not expose full keys',
        );
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('forbids a non-admin from admin endpoints (403)', async () => {
      const { app, sys } = await buildApp();
      const pleb = seedUser(sys, 'pleb', false);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/users',
          headers: { authorization: `Bearer ${pleb.key}` },
        });
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().error.code, 'FORBIDDEN');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('admin creates a user and gets a one-time key', async () => {
      const { app, sys, admin } = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/users',
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { username: 'newuser', display_name: 'New', is_admin: false },
        });
        assert.equal(res.statusCode, 201);
        const data = res.json().data;
        assert.match(data.key, /^etn_[0-9a-f]{32}$/);
        // The new key must authenticate and point to the new user.
        const me = await app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: `Bearer ${data.key}` },
        });
        assert.equal(me.statusCode, 200);
        assert.equal(me.json().data.username, 'newuser');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('rejects duplicate username with 409', async () => {
      const { app, sys, admin } = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/users',
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { username: 'admin' },
        });
        assert.equal(res.statusCode, 409);
        assert.equal(res.json().error.code, 'DUPLICATE');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('refuses to delete or demote the first user (422)', async () => {
      const { app, sys, admin } = await buildApp();
      try {
        const del = await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${admin.userId}`,
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(del.statusCode, 422);
        assert.equal(del.json().error.code, 'PROTECTED_ENTITY');

        const patch = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/users/${admin.userId}`,
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { is_admin: false },
        });
        assert.equal(patch.statusCode, 422);
        assert.equal(patch.json().error.code, 'PROTECTED_ENTITY');
      } finally {
        await app.close();
        sys.close();
      }
    });
  },
);
