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
  NetworkDb,
  closeAll,
  closeNetworkDb,
  createInMemoryNetworkDb,
  getOpenNetworkDb,
  openNetworkDb,
  registerMigrationHelpers,
} from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';

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

    it('профиль прагм соединения применяется при открытии (ADR ff2ee606)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.equal(
          (ndb.pragma('busy_timeout') as { timeout: number }[])[0]?.timeout,
          5000,
          'busy_timeout из профиля должен быть выставлен',
        );
        assert.equal(
          (ndb.pragma('cache_size') as { cache_size: number }[])[0]?.cache_size,
          -65536,
          'cache_size из профиля должен быть выставлен',
        );
        assert.equal(
          (ndb.pragma('temp_store') as { temp_store: number }[])[0]?.temp_store,
          2,
          'temp_store=MEMORY (2) из профиля должен быть выставлен',
        );
        assert.equal(
          (ndb.pragma('synchronous') as { synchronous: number }[])[0]?.synchronous,
          1,
          'synchronous=NORMAL (1) из профиля должен быть выставлен',
        );
      } finally {
        ndb.close();
      }
    });

    it('после миграций собрана статистика и целевые индексы (требования 239be851/7da6de92)', () => {
      const networkId = randomUUID();
      const ndb = openNetworkDb(tmpDataDir, networkId);
      try {
        const statRow = ndb
          .prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'")
          .get() as { name: string } | undefined;
        assert.ok(statRow, 'ANALYZE в конце миграций обязан создать sqlite_stat1');

        const indexes = new Set(
          (ndb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
            (r) => r.name,
          ),
        );
        assert.ok(indexes.has('idx_links_target_live'), 'нет idx_links_target_live');
        assert.ok(indexes.has('idx_links_source_live'), 'нет idx_links_source_live');
        assert.equal(indexes.has('idx_links_active'), false, 'idx_links_active должен быть снесён');
        assert.equal(indexes.has('idx_thoughts_active'), false, 'idx_thoughts_active должен быть снесён');
      } finally {
        closeNetworkDb(networkId);
      }
    });

    it('закрытие соединения выполняет PRAGMA optimize ровно один раз (требование 1119cbec)', () => {
      // Точка наблюдаемости: `NetworkDb.close` обязан вызвать
      // `optimizeStatisticsBeforeClose`, который делает `PRAGMA optimize`.
      class RecordingNetworkDb extends NetworkDb {
        optimizeCalls = 0;
        protected override optimizeStatisticsBeforeClose(): void {
          this.optimizeCalls += 1;
          super.optimizeStatisticsBeforeClose();
        }
      }

      const db = new DatabaseConstructor(':memory:');
      db.pragma('foreign_keys = ON');
      registerMigrationHelpers(db);
      runMigrations(db, networkMigrationsDir());
      const ndb = new RecordingNetworkDb(db, 'lifecycle-test', ':memory:');
      ndb.close();
      assert.equal(ndb.optimizeCalls, 1, 'close() обязан один раз выполнить PRAGMA optimize');
      ndb.close();
      assert.equal(ndb.optimizeCalls, 1, 'повторный close() идемпотентен и optimize не повторяет');
      assert.equal(ndb.isClosed, true);
    });
  },
);
