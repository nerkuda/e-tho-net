/**
 * Integration tests for /networks routes (task B13) via app.inject.
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise. Most flows
 * seed networks + memberships directly into `_system.db` and exercise
 * GET/PATCH/members/preferences; the POST test (updated in C10) drives the real
 * {@link NetworkServiceImpl} against a throwaway data directory.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import type { ServerConfig } from '../src/config.js';
import { SystemDb } from '../src/db/system-db.js';
import { closeNetworkDb } from '../src/db/network-db.js';
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
        assert.equal(data[0]?.role, 'owner');
        assert.equal(data[0]?.members_count, 1);
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

    it('POST /networks creates a real network (C10)', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-post-'));
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
        config: { ...TEST_CONFIG, dataDir },
        systemDb: sys,
        logger: createLogger('silent'),
      });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { display_name: 'Brand new' },
        });
        assert.equal(res.statusCode, 201);
        const created = res.json().data as { id: string; display_name: string; owner_id: string };
        assert.equal(created.display_name, 'Brand new');
        assert.equal(created.owner_id, adminId);
        // The per-network directory and data.db were created on disk.
        assert.ok(fs.existsSync(path.join(dataDir, 'networks', created.id, 'data.db')));
        // The owner membership was recorded in _system.db.
        assert.equal(sys.getMemberRole(adminId, created.id), 'owner');
      } finally {
        await app.close();
        sys.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
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

    it('a plain member (not owner, not admin) may only read the member list, not manage it (task 0.4.2)', async () => {
      const { app, sys, db } = await buildApp();
      // A genuinely non-admin owner, so the outcome is not muddied by the
      // separate global-admin bypass (`buildApp`'s own `admin` is a global
      // admin used only to seed the server; the network owner here is not).
      const ownerId = randomUUID();
      sys.createUser({ id: ownerId, username: 'owner', displayName: 'Owner' });
      const ownerGen = generateApiKey();
      sys.createApiKey({
        id: randomUUID(),
        userId: ownerId,
        label: 'p',
        keyHash: hashApiKey(ownerGen.key),
        keyPrefix: ownerGen.keyPrefix,
      });
      const networkId = seedNetwork(db, ownerId);
      const member = seedMember(sys, db, networkId, ownerId, 'member1');
      const other = randomUUID();
      sys.createUser({ id: other, username: 'other', displayName: 'Other' });
      try {
        // The member can list members (read-only).
        const list = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${networkId}/members`,
          headers: { authorization: `Bearer ${member.key}` },
        });
        assert.equal(list.statusCode, 200);
        assert.equal((list.json().data as unknown[]).length, 2);

        // The member cannot add another member.
        const add = await app.inject({
          method: 'POST',
          url: `/api/v1/networks/${networkId}/members`,
          headers: { authorization: `Bearer ${member.key}` },
          payload: { user_id: other },
        });
        assert.equal(add.statusCode, 403);
        assert.equal(add.json().error.code, 'FORBIDDEN');

        // Nor remove one.
        const del = await app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${networkId}/members/${member.userId}`,
          headers: { authorization: `Bearer ${member.key}` },
        });
        assert.equal(del.statusCode, 403);

        // The owner, in contrast, can add.
        const ownerAdd = await app.inject({
          method: 'POST',
          url: `/api/v1/networks/${networkId}/members`,
          headers: { authorization: `Bearer ${ownerGen.key}` },
          payload: { user_id: other },
        });
        assert.equal(ownerAdd.statusCode, 201);
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('a global admin manages membership and reads a network without an explicit membership row (task 0.4.2)', async () => {
      const { app, sys, db, admin } = await buildApp();
      // `admin` is a global admin but is never added to `network_members`.
      const ownerId = randomUUID();
      sys.createUser({ id: ownerId, username: 'owner2', displayName: 'Owner2' });
      const networkId = seedNetwork(db, ownerId);
      const other = randomUUID();
      sys.createUser({ id: other, username: 'other2', displayName: 'Other2' });
      try {
        assert.equal(sys.getMemberRole(admin.userId, networkId), null);

        const read = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${networkId}`,
          headers: { authorization: `Bearer ${admin.key}` },
        });
        assert.equal(read.statusCode, 200);

        const add = await app.inject({
          method: 'POST',
          url: `/api/v1/networks/${networkId}/members`,
          headers: { authorization: `Bearer ${admin.key}` },
          payload: { user_id: other },
        });
        assert.equal(add.statusCode, 201);
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

    it('GET /networks/{id} returns all four markdown self-description fields (O5)', async () => {
      // Real network on disk so `validateNodeSectionType` can see data.db.
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-self-desc-'));
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
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const app = await createServer({
        config: { ...TEST_CONFIG, dataDir },
        systemDb: sys,
        logger: createLogger('silent'),
      });
      let createdId: string | null = null;
      try {
        // Create the network through the real POST endpoint.
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { display_name: 'Self-desc' },
        });
        assert.equal(created.statusCode, 201);
        const createdDto = created.json().data as {
          id: string;
          description: string | null;
          when_to_use: string | null;
          conventions: string | null;
          examples: string | null;
          node_section_type_id: string | null;
          has_structure: boolean;
        };
        createdId = createdDto.id;
        assert.equal(createdDto.description, null);
        assert.equal(createdDto.when_to_use, null);
        assert.equal(createdDto.conventions, null);
        assert.equal(createdDto.examples, null);
        assert.equal(createdDto.node_section_type_id, null);
        assert.equal(createdDto.has_structure, false);

        const get = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${createdDto.id}`,
          headers: { authorization: `Bearer ${gen.key}` },
        });
        assert.equal(get.statusCode, 200);
        const dto = get.json().data as typeof createdDto;
        assert.equal(dto.description, null);
        assert.equal(dto.when_to_use, null);
        assert.equal(dto.conventions, null);
        assert.equal(dto.examples, null);
        assert.equal(dto.node_section_type_id, null);
        assert.equal(dto.has_structure, false);
      } finally {
        await app.close();
        sys.close();
        if (createdId !== null) closeNetworkDb(createdId);
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('PATCH /networks/{id} updates the four markdown fields (O5)', async () => {
      const { app, sys, db, admin } = await buildApp();
      const networkId = seedNetwork(db, admin.userId);
      try {
        const patch = await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${networkId}`,
          headers: { authorization: `Bearer ${admin.key}` },
          payload: {
            display_name: 'Renamed',
            description: 'What the network is about.',
            when_to_use: 'Coding tasks → conventions.',
            conventions: 'Always chronicle changes.',
            examples: 'Good: ... ; Bad: ...',
          },
        });
        assert.equal(patch.statusCode, 200);
        const dto = patch.json().data as {
          display_name: string;
          description: string | null;
          when_to_use: string | null;
          conventions: string | null;
          examples: string | null;
          node_section_type_id: string | null;
          has_structure: boolean;
        };
        assert.equal(dto.display_name, 'Renamed');
        assert.equal(dto.description, 'What the network is about.');
        assert.equal(dto.when_to_use, 'Coding tasks → conventions.');
        assert.equal(dto.conventions, 'Always chronicle changes.');
        assert.equal(dto.examples, 'Good: ... ; Bad: ...');
        assert.equal(dto.has_structure, false);

        // GET round-trip.
        const get = await app.inject({
          method: 'GET',
          url: `/api/v1/networks/${networkId}`,
          headers: { authorization: `Bearer ${admin.key}` },
        });
        const got = get.json().data as typeof dto;
        assert.equal(got.description, 'What the network is about.');
        assert.equal(got.conventions, 'Always chronicle changes.');
      } finally {
        await app.close();
        sys.close();
      }
    });

    it('PATCH /networks/{id} rejects an unknown node_section_type_id (O5)', async () => {
      // Real data directory so the network has a data.db to query.
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-bad-section-'));
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
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const app = await createServer({
        config: { ...TEST_CONFIG, dataDir },
        systemDb: sys,
        logger: createLogger('silent'),
      });
      let nid: string | null = null;
      try {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { display_name: 'Bad section' },
        });
        nid = (created.json().data as { id: string }).id;
        const patch = await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { node_section_type_id: randomUUID() },
        });
        assert.equal(patch.statusCode, 422);
        const err = patch.json().error as { code: string };
        assert.equal(err.code, 'VALIDATION_ERROR');
      } finally {
        await app.close();
        sys.close();
        if (nid !== null) closeNetworkDb(nid);
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('PATCH /networks/{id} accepts a real node_section_type_id and sets has_structure (O5)', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-ok-section-'));
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
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const app = await createServer({
        config: { ...TEST_CONFIG, dataDir },
        systemDb: sys,
        logger: createLogger('silent'),
      });
      let nid: string | null = null;
      try {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { display_name: 'Has structure' },
        });
        nid = (created.json().data as { id: string }).id;

        // Create a thought type inside the network.
        const tt = await app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { name: 'Раздел' },
        });
        assert.equal(tt.statusCode, 201);
        const sectionTypeId = (tt.json().data as { id: string }).id;

        const patch = await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { node_section_type_id: sectionTypeId },
        });
        assert.equal(patch.statusCode, 200);
        const dto = patch.json().data as {
          node_section_type_id: string | null;
          has_structure: boolean;
        };
        assert.equal(dto.node_section_type_id, sectionTypeId);
        assert.equal(dto.has_structure, true);

        // Clearing it back to null flips has_structure back off.
        const clear = await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { node_section_type_id: null },
        });
        assert.equal(clear.statusCode, 200);
        const cleared = clear.json().data as typeof dto;
        assert.equal(cleared.node_section_type_id, null);
        assert.equal(cleared.has_structure, false);
      } finally {
        await app.close();
        sys.close();
        if (nid !== null) closeNetworkDb(nid);
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('DELETE /networks/{id}/thought-types/{tid} refuses the network node-section type (O5)', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-section-guard-'));
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
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const app = await createServer({
        config: { ...TEST_CONFIG, dataDir },
        systemDb: sys,
        logger: createLogger('silent'),
      });
      let nid: string | null = null;
      try {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { display_name: 'Section guard' },
        });
        nid = (created.json().data as { id: string }).id;
        const tt = await app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { name: 'Раздел' },
        });
        const sectionTypeId = (tt.json().data as { id: string }).id;
        // Pin the type as the network's node_section_type_id.
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { node_section_type_id: sectionTypeId },
        });

        // Try to delete with `force=true` — should still be refused.
        const del = await app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/thought-types/${sectionTypeId}?force=true`,
          headers: { authorization: `Bearer ${gen.key}` },
        });
        assert.equal(del.statusCode, 422);
        const err = del.json().error as { code: string };
        assert.equal(err.code, 'VALIDATION_ERROR');

        // After clearing node_section_type_id, deletion must succeed.
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { node_section_type_id: null },
        });
        const delOk = await app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${nid}/thought-types/${sectionTypeId}`,
          headers: { authorization: `Bearer ${gen.key}` },
        });
        assert.equal(delOk.statusCode, 204);
      } finally {
        await app.close();
        sys.close();
        if (nid !== null) closeNetworkDb(nid);
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('GET /networks includes description/when_to_use/has_structure in the list (O5)', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-list-self-'));
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
        label: 'p',
        keyHash: hashApiKey(gen.key),
        keyPrefix: gen.keyPrefix,
      });
      const app = await createServer({
        config: { ...TEST_CONFIG, dataDir },
        systemDb: sys,
        logger: createLogger('silent'),
      });
      let nid: string | null = null;
      try {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { display_name: 'Listed', description: 'Short desc' },
        });
        nid = (created.json().data as { id: string }).id;
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}`,
          headers: { authorization: `Bearer ${gen.key}` },
          payload: { when_to_use: 'Coding → conventions' },
        });

        const list = await app.inject({
          method: 'GET',
          url: '/api/v1/networks',
          headers: { authorization: `Bearer ${gen.key}` },
        });
        assert.equal(list.statusCode, 200);
        const data = list.json().data as Array<{
          id: string;
          description: string | null;
          when_to_use: string | null;
          has_structure: boolean;
          // These two must NOT be present (compact list, O5).
          conventions?: unknown;
          examples?: unknown;
        }>;
        assert.equal(data.length, 1);
        const item = data[0]!;
        assert.equal(item.id, nid);
        assert.equal(item.description, 'Short desc');
        assert.equal(item.when_to_use, 'Coding → conventions');
        assert.equal(item.has_structure, false);
        assert.equal(item.conventions, undefined);
        assert.equal(item.examples, undefined);
      } finally {
        await app.close();
        sys.close();
        if (nid !== null) closeNetworkDb(nid);
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  },
);
