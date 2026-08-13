/**
 * Unit tests for the {@link NetworkDb} lifecycle (task C1).
 *
 * Covers: directory tree creation, WAL mode, registry reuse, explicit close,
 * {@link closeAll}, and the in-memory test helper. Skipped entirely when the
 * `better-sqlite3` native binding is unavailable (the suite would otherwise
 * report misleading per-test failures).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import {
  closeAll,
  closeNetworkDb,
  createInMemoryNetworkDb,
  getOpenNetworkDb,
  openNetworkDb,
} from '../src/db/network-db.js';

/** True when the `better-sqlite3` native binding loads. */
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
  'NetworkDb',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDataDir: string;

    before(() => {
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-netdb-'));
    });

    after(() => {
      closeAll();
      if (tmpDataDir) {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      }
    });

    it('creates the network directory tree and data.db on first open', () => {
      const networkId = randomUUID();
      const ndb = openNetworkDb(tmpDataDir, networkId);
      try {
        const dir = path.join(tmpDataDir, 'networks', networkId);
        assert.ok(fs.existsSync(dir), 'network dir created');
        assert.ok(fs.existsSync(path.join(dir, 'attachments')), 'attachments/ created');
        assert.ok(fs.existsSync(path.join(dir, 'snapshots')), 'snapshots/ created');
        assert.ok(fs.existsSync(path.join(dir, 'data.db')), 'data.db created');

        // WAL journal mode is requested at open time.
        const mode = ndb.pragma('journal_mode') as { journal_mode?: string }[];
        assert.equal(mode[0]?.journal_mode, 'wal');
      } finally {
        closeNetworkDb(networkId);
      }
    });

    it('creates WAL files after the first write', () => {
      const networkId = randomUUID();
      const ndb = openNetworkDb(tmpDataDir, networkId);
      try {
        ndb.exec('CREATE TABLE IF NOT EXISTS probe (x INTEGER)');
        ndb.prepare('INSERT INTO probe VALUES (?)').run(42);
        // Force WAL flush so the sidecar file is observable on disk.
        ndb.pragma('wal_checkpoint(TRUNCATE)');
        // After a checkpoint the WAL may be emptied back to 0 bytes but the file
        // must exist; re-write and check without checkpoint.
        ndb.prepare('INSERT INTO probe VALUES (?)').run(43);
        const walPath = path.join(tmpDataDir, 'networks', networkId, 'data.db-wal');
        assert.ok(fs.existsSync(walPath), 'data.db-wal created after a write');
      } finally {
        closeNetworkDb(networkId);
      }
    });

    it('reuses the same instance for an already-open network', () => {
      const networkId = randomUUID();
      const first = openNetworkDb(tmpDataDir, networkId);
      const second = openNetworkDb(tmpDataDir, networkId);
      try {
        assert.equal(second, first, 'registry returns the cached instance');
        assert.equal(getOpenNetworkDb(networkId), first);
      } finally {
        closeNetworkDb(networkId);
      }
      assert.equal(getOpenNetworkDb(networkId), undefined, 'registry cleared on close');
    });

    it('closeNetworkDb returns false for an unknown network', () => {
      assert.equal(closeNetworkDb('never-opened-' + randomUUID()), false);
    });

    it('closeAll closes every open network', () => {
      const a = openNetworkDb(tmpDataDir, randomUUID());
      const b = openNetworkDb(tmpDataDir, randomUUID());
      closeAll();
      assert.equal(a.isClosed, true);
      assert.equal(b.isClosed, true);
      assert.equal(getOpenNetworkDb(a.networkId), undefined);
      assert.equal(getOpenNetworkDb(b.networkId), undefined);
    });

    it('transaction rolls back on throw', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        ndb.exec('CREATE TABLE IF NOT EXISTS r (v INTEGER)');
        assert.throws(() =>
          ndb.transaction(() => {
            ndb.prepare('INSERT INTO r VALUES (?)').run(1);
            throw new Error('boom');
          }),
        );
        const c = (ndb.prepare('SELECT COUNT(*) AS c FROM r').get() as { c: number }).c;
        assert.equal(c, 0);
      } finally {
        ndb.close();
      }
    });
  },
);
