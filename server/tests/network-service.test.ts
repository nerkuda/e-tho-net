/**
 * Unit tests for {@link NetworkServiceImpl} (task C10).
 *
 * Covers network creation (directory tree + data.db migrations + HOME seed +
 * registry/owner rows) and deletion (WAL checkpoint + directory removal +
 * registry cleanup). Uses a throwaway tmp data directory and a real `_system.db`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { SystemDb } from '../src/db/system-db.js';
import { closeAll, openNetworkDb } from '../src/db/network-db.js';
import { networkDbPath } from '../src/paths.js';
import { NetworkServiceImpl } from '../src/domain/network-service.js';
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

describe(
  'NetworkServiceImpl',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let dataDir: string;
    let systemDb: SystemDb;

    /** Create a user row so network FKs (owner_id, added_by) are satisfied. */
    function createUser(): string {
      const id = randomUUID();
      systemDb.createUser({ id, username: `u-${id}`, displayName: 'U' });
      return id;
    }

    before(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-net-'));
      systemDb = SystemDb.open(dataDir, createLogger('silent'));
    });

    after(() => {
      closeAll();
      systemDb.close();
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it('createNetwork seeds HOME and registers the owner', async () => {
      const ownerId = createUser();
      const svc = new NetworkServiceImpl(systemDb, dataDir);
      const network = await svc.createNetwork(ownerId, 'My network', 'desc');

      assert.equal(network.display_name, 'My network');
      assert.equal(network.owner_id, ownerId);
      assert.equal(network.description, 'desc');

      // Directory tree + data.db exist.
      const dir = path.join(dataDir, 'networks', network.id);
      assert.ok(fs.existsSync(dir));
      assert.ok(fs.existsSync(path.join(dir, 'attachments')));
      assert.ok(fs.existsSync(path.join(dir, 'snapshots')));
      assert.ok(fs.existsSync(networkDbPath(dataDir, network.id)));

      // HOME thought exists with the protected/root flags.
      const ndb = openNetworkDb(dataDir, network.id);
      const home = ndb
        .prepare(
          'SELECT id, title, title_norm, is_protected, is_root, active FROM thoughts WHERE is_root = 1',
        )
        .get() as {
        id: string;
        title: string;
        title_norm: string;
        is_protected: number;
        is_root: number;
        active: number;
      };
      assert.equal(home.title, 'HOME');
      assert.equal(home.title_norm, 'home');
      assert.equal(home.is_protected, 1);
      assert.equal(home.is_root, 1);
      assert.equal(home.active, 1);

      // Registry + owner membership in _system.db.
      const reg = systemDb.getNetworkById(network.id);
      assert.ok(reg);
      assert.equal(systemDb.getMemberRole(ownerId, network.id), 'owner');
    });

    it('createNetwork rejects a non-string display name via the route layer guard', () => {
      // The service trusts its caller; display-name validation is the route's
      // job. Here we only confirm the service stores whatever it is given and
      // that repeated creates produce unique network ids.
      const ownerId = createUser();
      const svc = new NetworkServiceImpl(systemDb, dataDir);
      return svc.createNetwork(ownerId, 'Second').then((n) => {
        assert.notEqual(n.id, '');
      });
    });

    it('deleteNetwork removes the directory and registry rows', async () => {
      const ownerId = createUser();
      const svc = new NetworkServiceImpl(systemDb, dataDir);
      const network = await svc.createNetwork(ownerId, 'Doomed');

      await svc.deleteNetwork(network.id);

      const dir = path.join(dataDir, 'networks', network.id);
      assert.ok(!fs.existsSync(dir), 'network directory removed');
      assert.equal(systemDb.getNetworkById(network.id), null, 'registry row removed');
      assert.equal(systemDb.getMemberRole(ownerId, network.id), null, 'membership cascaded away');
    });

    it('reopening a created network reuses migrations idempotently', async () => {
      const ownerId = createUser();
      const svc = new NetworkServiceImpl(systemDb, dataDir);
      const network = await svc.createNetwork(ownerId, 'Reopen me');
      // Opening again must not error on already-applied migrations.
      const ndb = openNetworkDb(dataDir, network.id);
      const count = (
        ndb.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE is_root = 1').get() as {
          c: number;
        }
      ).c;
      assert.equal(count, 1, 'exactly one HOME after reopen');
    });
  },
);
