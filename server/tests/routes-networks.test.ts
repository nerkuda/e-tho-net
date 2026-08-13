/**
 * Integration tests for /networks routes (task B13) via app.inject.
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise. Because the
 * real NetworkService (task C10) is a stub that throws, networks + memberships
 * are seeded directly into `_system.db`, then GET/PATCH/members/preferences
 * flows are exercised.
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

interface SeededUser {
  userId: string;
  key: string;
}

/** Build the app with an admin and (optionally) a seeded network. */
async function buildApp(): Promise<{
  app: FastifyInstance;
  sys: SystemDb;
  db: Database.Database;
  admin: SeededUser;
}> {
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
  return { app, sys, db, admin: { userId: adminId, key: gen.key } };
}

/** Seed a network + owner membership directly. */
function seedNetwork(db: Database.Database, ownerId: string): string {
  const networkId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO networks (id, display_name, owner_id, description, created_at, updated_at) VALUES (?, 'Net', ?, 'desc', ?, ?)",
  ).run(networkId, ownerId, now, now);
  db.prepare(
    "INSERT INTO network_members (network_id, user_id, role, added_at, added_by) VALUES (?, ?, 'owner', ?, ?)",
  ).run(networkId, ownerId, now, ownerId);
  return networkId;
}

/** Seed a non-owner user + key + membership in a network. */
function seedMember(
  sys: SystemDb,
  db: Database.Database,
  networkId: string,
  addedBy: string,
  username: string,
): SeededUser {
  const userId = randomUUID();
  sys.createUser({ id: userId, username, displayName: username });
  const gen = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'p',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  db.prepare(
    "INSERT INTO network_members (network_id, user_id, role, added_at, added_by) VALUES (?, ?, 'member', ?, ?)",
  ).run(networkId, userId, new Date().toISOString(), addedBy);
  return { userId, key: gen.key };
}

describe(
  '/networks routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('lists networks the user belongs to', async () => {
      const { app, sys, db, admin } = await buildApp();
      seedNetwork(db, admin.userId);
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(res.statusCode, 200);
        const data = res.json().data as Array<{ id: string; role: string; members_count: number }>;
        assert.equal(data.length, 1);
        assert.equal(data[0].role, 'owner');
        assert.equal(data[0].members_count, 1);
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('rejects a non-member from reading a network (403)', async () => {
      const { app, sys, db, admin } = await buildApp();
      const networkId = seedNetwork(db, admin.userId);
      const outsider = randomUUID();
      sys.createUser({ id: outsider, username: 'out', displayName: 'Out' });
      const gen = generateApiKey();
      sys.createApiKey({
        id: randomUUID(),
        userId: outsider,
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${networkId}`,
          headers: { authorization: `Bearer ${gen.key}` },
        });
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().error.code, 'FORBIDDEN');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('POST /networks hits the C10 stub (500 until C10)', async () => {
      const { app, sys, admin } = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { display_name: 'Brand new' },
        });
        assert.equal(res.statusCode, 500);
        assert.equal(res.json().error.code, 'INTERNAL');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('owner adds and removes a member, and lists them', async () => {
      const { app, sys, db, admin } = await buildApp();
      const networkId = seedNetwork(db, admin.userId);
      const other = randomUUID();
      sys.createUser({ id: other, username: 'other', displayName: 'Other' });
      try {
        const add = await app.inject({
          method: 'POST',
          url: `/api/v1/networks/${networkId}/members`,
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { user_id: other },
        });
        assert.equal(add.statusCode, 201);
        assert.equal(add.json().data.role, 'member');

        const list = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${networkId}/members`,
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(list.statusCode, 200);
        assert.equal((list.json().data as unknown[]).length, 2);

        const del = await app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${networkId}/members/${other}`,
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(del.statusCode, 204);

        const list2 = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${networkId}/members`,
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal((list2.json().data as unknown[]).length, 1);
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('transfers ownership atomically', async () => {
      const { app, sys, db, admin } = await buildApp();
      const networkId = seedNetwork(db, admin.userId);
      const member = seedMember(sys, db, networkId, admin.userId, 'member1');
      try {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${networkId}/members/${member.userId}`,
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { role: 'owner' },
        });
        assert.equal(res.statusCode, 204);
        // The previous owner is now a member; the network owner_id changed.
        const net = sys.getNetworkById(networkId);
        assert.equal(net!.owner_id, member.userId);
        assert.equal(sys.getMemberRole(admin.userId, networkId), 'member');
        assert.equal(sys.getMemberRole(member.userId, networkId), 'owner');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('sets and reads a preference (show_inactive)', async () => {
      const { app, sys, db, admin } = await buildApp();
      const networkId = seedNetwork(db, admin.userId);
      try {
        const put = await app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${networkId}/preferences/show_inactive`,
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { value: true },
        });
        assert.equal(put.statusCode, 200);
        const get = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${networkId}/preferences`,
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(get.statusCode, 200);
        const prefs = get.json().data as Array<{ key: string; value: unknown }>;
        const si = prefs.find((p) => p.key === 'show_inactive');
        assert.ok(si);
        assert.equal(si!.value, true);
      } finally {
        await app.close();
        sys.close();
      }
    });
  },
);
