/**
 * Integration tests for the audit-log admin route (task B14) via app.inject.
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise.
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
  mcp: { enabled: false, port: null },
};

async function buildApp(): Promise<{ app: FastifyInstance; sys: SystemDb; adminKey: string }> {
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
  // Seed audit rows directly.
  sys.insertAuditLog({
    actorUserId: adminId,
    category: 'system',
    action: 'init',
    targetType: 'user',
    targetId: adminId,
  });
  sys.insertAuditLog({
    actorUserId: adminId,
    category: 'user',
    action: 'api_key.create',
    targetType: 'api_key',
  });
  sys.insertAuditLog({
    actorUserId: adminId,
    category: 'membership',
    action: 'member.add',
    targetType: 'user',
  });
  const app = await createServer({
    config: TEST_CONFIG,
    systemDb: sys,
    logger: createLogger('silent'),
  });
  return { app, sys, adminKey: gen.key };
}

describe(
  'GET /admin/audit',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('returns audit entries with pagination metadata (admin)', async () => {
      const { app, sys, adminKey } = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/audit',
          headers: { authorization: `Bearer ${adminKey}` },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.meta.total, 3);
        assert.equal((body.data as unknown[]).length, 3);
        assert.ok(
          (body.data as Array<{ ts: string }>)[0].ts >= (body.data as Array<{ ts: string }>)[2].ts,
          'newest first',
        );
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('filters by category', async () => {
      const { app, sys, adminKey } = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/audit?category=user',
          headers: { authorization: `Bearer ${adminKey}` },
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.meta.total, 1);
        assert.equal((body.data as Array<{ category: string }>)[0].category, 'user');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('rejects an invalid category with 422', async () => {
      const { app, sys, adminKey } = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/audit?category=bogus',
          headers: { authorization: `Bearer ${adminKey}` },
        });
        assert.equal(res.statusCode, 422);
        assert.equal(res.json().error.code, 'VALIDATION_ERROR');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('forbids a non-admin (403)', async () => {
      const { app, sys } = await buildApp();
      const plebId = randomUUID();
      sys.createUser({ id: plebId, username: 'pleb', displayName: 'Pleb' });
      const gen = generateApiKey();
      sys.createApiKey({
        id: randomUUID(),
        userId: plebId,
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/audit',
          headers: { authorization: `Bearer ${gen.key}` },
        });
        assert.equal(res.statusCode, 403);
      } finally {
        await app.close();
        sys.close();
      }
    });
  },
);
