/**
 * Integration tests for DELETE /admin/users/{id} when the target user is
 * an author/last-editor of network entities (task d37b4f43, requirement
 * 4c67149e «запрет физического удаления пользователя-автора»).
 *
 * Covers:
 *   - 422 + details.network_id/table when the user authored a row in any of
 *     the nine authorship-bearing tables (thoughts, links, thought_types,
 *     link_types, properties, comments, attachments, layers, property_values);
 *   - cascade DELETE works as before for a user without authorship;
 *   - PATCH { disabled: true } is NOT blocked by the authorship guard;
 *   - the check scans every network (a user authoring in network B is
 *     protected even when the admin only looks at network A).
 *
 * Requires `better-sqlite3` native binding; skipped otherwise. Drives the
 * real Fastify app over an in-memory `_system.db` and a throwaway `dataDir`,
 * with entities created through the production domain services so the
 * authorship columns (`created_by`/`updated_by`) get populated exactly the
 * same way the REST API does (the schema for some tables is too branchy for
 * raw INSERTs to keep up with — `comment-service`, `attachment-service` and
 * `property-service` each route ownership through helper tables).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import { BASE_LAYER_ID } from '@etn/shared';

import type { ServerConfig } from '../src/config.js';
import { SystemDb } from '../src/db/system-db.js';
import { closeAll as closeAllNetworkDbs, openNetworkDb } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';
import { NetworkServiceImpl } from '../src/domain/network-service.js';
import { createThought } from '../src/domain/thought-service.js';
import { createLink } from '../src/domain/link-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import {
  createNetworkProperty,
  createTypeProperty,
  setPropertyValue,
} from '../src/domain/property-service.js';
import { createComment } from '../src/domain/comment-service.js';
import { createAttachment } from '../src/domain/attachment-service.js';
import { createLayer } from '../src/domain/layer-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

interface SeededUser {
  userId: string;
  key: string;
}

interface World {
  app: FastifyInstance;
  sys: SystemDb;
  dataDir: string;
  admin: SeededUser;
  author: SeededUser;
  outsider: SeededUser;
}

const TEST_CONFIG_BASE: ServerConfig = {
  dataDir: '/tmp/etn-test',
  host: '127.0.0.1',
  port: 0,
  tls: null,
  logLevel: 'silent',
  mcp: { enabled: false, port: null },
};

/**
 * Seed: an admin, an `author` user we will try to delete, and an `outsider`
 * user with no authorship anywhere. Creates two real networks on a temp
 * data directory so the guard's per-network walk is exercised end-to-end.
 */
async function buildWorld(): Promise<World> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-user-del-'));
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);

  const admin = makeUser(sys, 'admin', true);
  const author = makeUser(sys, 'author', false);
  const outsider = makeUser(sys, 'outsider', false);

  // Two networks so we can verify "scan every network" — see the test that
  // plants authorship only in network B.
  const svc = new NetworkServiceImpl(sys, dataDir, createLogger('silent'));
  await svc.createNetwork(admin.userId, 'Net A');
  await svc.createNetwork(admin.userId, 'Net B');

  const app = await createServer({
    config: { ...TEST_CONFIG_BASE, dataDir },
    systemDb: sys,
    logger: createLogger('silent'),
  });

  return { app, sys, dataDir, admin, author, outsider };
}

function makeUser(sys: SystemDb, username: string, isAdmin: boolean): SeededUser {
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

async function teardown(w: World): Promise<void> {
  await w.app.close();
  closeAllNetworkDbs();
  w.sys.close();
  fs.rmSync(w.dataDir, { recursive: true, force: true });
}

/**
 * Plant one row owned by `userId` in `table` of `networkId` using the
 * production domain services — they fill all authorship columns exactly
 * the same way the REST handlers do.
 *
 * `otherUserId` is used as the author of any auxiliary rows the table
 * needs (e.g. `links` requires source/target thoughts that must NOT be
 * authored by the user under test, otherwise the guard would short-circuit
 * on `thoughts` first and the `links` test would mis-attribute the hit).
 */
function plantAuthorship(
  dataDir: string,
  networkId: string,
  userId: string,
  table:
    | 'thoughts'
    | 'links'
    | 'thought_types'
    | 'link_types'
    | 'properties'
    | 'comments'
    | 'attachments'
    | 'layers'
    | 'property_values',
  otherUserId: string,
): void {
  const ndb = openNetworkDb(dataDir, networkId);
  try {
    switch (table) {
      case 'thoughts':
        createThought(ndb, { title: `t-${userId.slice(0, 4)}` }, userId);
        return;
      case 'links': {
        // Endpoints owned by another user, then the link itself authored by
        // `userId` so the only row carrying the user's authorship is in
        // the `links` table.
        const src = createThought(ndb, { title: `src-${randomUUID().slice(0, 4)}` }, otherUserId);
        const tgt = createThought(ndb, { title: `tgt-${randomUUID().slice(0, 4)}` }, otherUserId);
        createLink(ndb, { source_id: src.id, target_id: tgt.id }, userId);
        return;
      }
      case 'thought_types':
        createThoughtType(ndb, { name: `tt-${userId.slice(0, 4)}` }, userId);
        return;
      case 'link_types':
        createLinkType(
          ndb,
          {
            name_forward: `lt-fwd-${userId.slice(0, 4)}`,
            name_reverse: `lt-rev-${userId.slice(0, 4)}`,
          },
          userId,
        );
        return;
      case 'properties':
        createNetworkProperty(
          ndb,
          { name: `p-${userId.slice(0, 4)}`, value_type: 'text' },
          userId,
        );
        return;
      case 'comments': {
        // Comments hang off thoughts owned by anyone; user is only in `comments`.
        const t = createThought(ndb, { title: `cmt-host-${randomUUID().slice(0, 4)}` }, otherUserId);
        createComment(
          ndb,
          'thought',
          t.id,
          { kind: 'permanent', body_md: `cmt-${userId.slice(0, 4)}` },
          userId,
        );
        return;
      }
      case 'attachments': {
        // Same trick as comments — attach to a thought owned by another user.
        const t = createThought(
          ndb,
          { title: `att-host-${randomUUID().slice(0, 4)}` },
          otherUserId,
        );
        createAttachment(
          ndb,
          'thought',
          t.id,
          { kind: 'url', url: `https://example.test/${userId.slice(0, 4)}` },
          userId,
        );
        return;
      }
      case 'layers':
        createLayer(ndb, {
          parentId: BASE_LAYER_ID,
          title: `L-${userId.slice(0, 4)}`,
          createdBy: userId,
        });
        return;
      case 'property_values': {
        // property_values requires the registry property to be attached to
        // the owning thought's type; build a tiny type-graph where the only
        // authorship on `property_values` (the row we want to verify) is the
        // user's. Type and registry property are owned by `otherUserId` so
        // the guard's first-table-wins logic still reports `property_values`.
        const tt = createThoughtType(
          ndb,
          { name: `pv-tt-${randomUUID().slice(0, 4)}` },
          otherUserId,
        );
        const prop = createNetworkProperty(
          ndb,
          { name: `pv-${userId.slice(0, 4)}`, value_type: 'text' },
          otherUserId,
        );
        createTypeProperty(ndb, 'thought_type', tt.id, { key: prop.name, value_type: 'text' }, otherUserId);
        const host = createThought(
          ndb,
          { title: `pv-host-${randomUUID().slice(0, 4)}`, type_id: tt.id },
          otherUserId,
        );
        setPropertyValue(ndb, 'thought', host.id, prop.name, 'hello', userId);
        return;
      }
    }
  } finally {
    // Keep the connection cached — closing it here would force a re-open on
    // every subsequent `openNetworkDb` call. closeAllNetworkDbs() in
    // teardown will dispose of it.
  }
}

describe(
  'DELETE /admin/users/:id authorship guard (task d37b4f43)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('422 when the user authored a thought in any network', async () => {
      const w = await buildWorld();
      try {
        const networkId = w.sys.listAllNetworkIds()[0]!;
        plantAuthorship(w.dataDir, networkId, w.author.userId, 'thoughts', w.admin.userId);

        const res = await w.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${w.author.userId}`,
          headers: { authorization: `Bearer ${w.admin.key}` },
        });
        assert.equal(res.statusCode, 422, `body=${res.payload}`);
        const body = res.json();
        assert.equal(body.error.code, 'VALIDATION_ERROR');
        assert.equal(body.error.details.table, 'thoughts');
        assert.equal(body.error.details.network_id, networkId);
        // The author is still present.
        assert.ok(w.sys.getUserById(w.author.userId) !== null);
      } finally {
        await teardown(w);
      }
    });

    it('cascade DELETE works as before for a user without authorship', async () => {
      const w = await buildWorld();
      try {
        const res = await w.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${w.outsider.userId}`,
          headers: { authorization: `Bearer ${w.admin.key}` },
        });
        assert.equal(res.statusCode, 204, `body=${res.payload}`);
        assert.equal(w.sys.getUserById(w.outsider.userId), null);
      } finally {
        await teardown(w);
      }
    });

    it('PATCH { disabled: true } is NOT blocked by the authorship guard', async () => {
      const w = await buildWorld();
      try {
        const networkId = w.sys.listAllNetworkIds()[0]!;
        plantAuthorship(w.dataDir, networkId, w.author.userId, 'comments', w.admin.userId);

        const patch = await w.app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/users/${w.author.userId}`,
          headers: { authorization: `Bearer ${w.admin.key}` },
          payload: { disabled: true },
        });
        assert.equal(patch.statusCode, 200, `body=${patch.payload}`);
        assert.equal(patch.json().data.disabled, true);
        // Author is still present (disabling does NOT lift authorship).
        assert.ok(w.sys.getUserById(w.author.userId) !== null);
      } finally {
        await teardown(w);
      }
    });

    it('the guard scans every network (author in network B blocks delete even if network A is empty)', async () => {
      const w = await buildWorld();
      try {
        const ids = w.sys.listAllNetworkIds();
        assert.ok(ids.length >= 2);
        const [, networkB] = ids as [string, string];
        // Plant authorship ONLY in network B.
        plantAuthorship(w.dataDir, networkB, w.author.userId, 'links', w.admin.userId);

        const res = await w.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${w.author.userId}`,
          headers: { authorization: `Bearer ${w.admin.key}` },
        });
        assert.equal(res.statusCode, 422, `body=${res.payload}`);
        assert.equal(res.json().error.details.network_id, networkB);
        assert.equal(res.json().error.details.table, 'links');
      } finally {
        await teardown(w);
      }
    });

    it('check covers all nine authorship tables (parity)', async () => {
      const tables = [
        'thoughts',
        'links',
        'thought_types',
        'link_types',
        'properties',
        'comments',
        'attachments',
        'layers',
        'property_values',
      ] as const;

      for (const table of tables) {
        // Fresh world per table so planted rows from a previous iteration
        // don't carry over.
        const w = await buildWorld();
        try {
          const networkId = w.sys.listAllNetworkIds()[0]!;
          plantAuthorship(w.dataDir, networkId, w.author.userId, table, w.admin.userId);

          const res = await w.app.inject({
            method: 'DELETE',
            url: `/api/v1/admin/users/${w.author.userId}`,
            headers: { authorization: `Bearer ${w.admin.key}` },
          });
          assert.equal(
            res.statusCode,
            422,
            `table ${table} should block DELETE; body=${res.payload}`,
          );
          const body = res.json();
          assert.equal(body.error.code, 'VALIDATION_ERROR');
          // The guard reports the FIRST table found; planting authorship in
          // table `X` may also plant rows in other tables (e.g. a `links`
          // test creates thoughts as endpoints). The check is: `X` is among
          // the reported tables OR the test's other network has it.
          const reported = body.error.details.table;
          const reportedNet = body.error.details.network_id;
          assert.ok(
            reportedNet === networkId,
            `reported network ${reportedNet} should be ${networkId}`,
          );
          // For some tables the planted row is the only user-authored row in
          // that table on this network — assert exact match. For others the
          // guard short-circuits on a table checked earlier in the UNION
          // ALL — verify the guard still found something authored.
          const userId = w.author.userId;
          const tablesWithAuthorship = new Set<string>();
          const dbPath = path.join(w.dataDir, 'networks', networkId, 'data.db');
          const db = new DatabaseConstructor(dbPath, { readonly: true });
          try {
            for (const t of [
              'thoughts',
              'links',
              'thought_types',
              'link_types',
              'properties',
              'comments',
              'attachments',
              'layers',
              'property_values',
            ] as const) {
              const row = db
                .prepare(`SELECT 1 FROM ${t} WHERE created_by = ? OR updated_by = ? LIMIT 1`)
                .get(userId, userId);
              if (row !== undefined) tablesWithAuthorship.add(t);
            }
          } finally {
            db.close();
          }
          assert.ok(
            tablesWithAuthorship.has(reported),
            `reported table ${reported} should be in planted set ${[...tablesWithAuthorship].join(',')}`,
          );
          assert.ok(
            tablesWithAuthorship.has(table),
            `planted table ${table} should have authorship rows`,
          );
        } finally {
          await teardown(w);
        }
      }
    });

    it('updated_by alone (no created_by hit) is enough to block delete', async () => {
      const w = await buildWorld();
      try {
        const networkId = w.sys.listAllNetworkIds()[0]!;
        // Plant as admin, then bump updated_by to `author` so the row is
        // attributed to a different user on update — the guard cares about
        // EITHER `created_by` or `updated_by`.
        const ndb = openNetworkDb(w.dataDir, networkId);
        const t = createThought(ndb, { title: `idea-${randomUUID().slice(0, 4)}` }, w.admin.userId);
        ndb
          .prepare('UPDATE thoughts SET updated_by = ?, updated_at_ms = ? WHERE id = ?')
          .run(w.author.userId, Date.now(), t.id);

        const res = await w.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${w.author.userId}`,
          headers: { authorization: `Bearer ${w.admin.key}` },
        });
        assert.equal(res.statusCode, 422, `body=${res.payload}`);
        assert.equal(res.json().error.details.table, 'thoughts');
      } finally {
        await teardown(w);
      }
    });

    it('unit: SystemDb.findUserAuthorship returns the first hit across networks and tables', async () => {
      const w = await buildWorld();
      try {
        // No rows at all → null.
        assert.equal(w.sys.findUserAuthorship(w.author.userId, w.dataDir), null);

        // Plant in network B (second id) on `thoughts`.
        const ids = w.sys.listAllNetworkIds();
        const [, networkB] = ids as [string, string];
        plantAuthorship(w.dataDir, networkB, w.author.userId, 'thoughts', w.admin.userId);
        const hit = w.sys.findUserAuthorship(w.author.userId, w.dataDir);
        assert.deepEqual(hit, { network_id: networkB, table: 'thoughts' });
      } finally {
        await teardown(w);
      }
    });
  },
);
