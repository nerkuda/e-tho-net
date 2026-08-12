/**
 * Unit tests for the SQL migration runner (task B2).
 *
 * Exercises: ordering, bookkeeping table creation, transactional apply, and
 * idempotency on re-run. Requires the `better-sqlite3` native binding; if the
 * binding is unavailable on the host, the suite aborts with a clear notice
 * rather than producing misleading per-test failures.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { MigrationError, runMigrations } from '../src/db/migrator.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe(
  'runMigrations',
  // Skip the whole suite when the better-sqlite3 native binding is unavailable
  // (e.g. host without the compiled addon) — see task notes on native build.
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDir: string;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-migr-'));
      fs.writeFileSync(path.join(tmpDir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
      fs.writeFileSync(
        path.join(tmpDir, '002_b.sql'),
        'CREATE TABLE b (y INTEGER); INSERT INTO b VALUES (1);',
      );
    });

    after(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('applies migrations in alphabetical order and records them', () => {
      const db = new Database(':memory:');
      const res = runMigrations(db, tmpDir);
      assert.deepEqual(res.applied.sort(), ['001_a.sql', '002_b.sql']);
      assert.equal(res.skipped.length, 0);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      assert.ok(names.includes('_migrations'));
      assert.ok(names.includes('a'));
      assert.ok(names.includes('b'));
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM b').get() as { c: number }).c, 1);
      db.close();
    });

    it('is idempotent: a second run skips everything', () => {
      const db = new Database(':memory:');
      runMigrations(db, tmpDir);
      const res2 = runMigrations(db, tmpDir);
      assert.equal(res2.applied.length, 0);
      assert.equal(res2.skipped.length, 2);
      db.close();
    });

    it('rolls back a failed migration without recording it', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-migr-fail-'));
      try {
        fs.writeFileSync(path.join(dir, '010_ok.sql'), 'CREATE TABLE ok (z INTEGER);');
        fs.writeFileSync(path.join(dir, '020_bad.sql'), 'THIS IS NOT SQL;');
        const db = new Database(':memory:');
        assert.throws(
          () => runMigrations(db, dir),
          (err: unknown) => err instanceof MigrationError && /020_bad\.sql/.test(err.message),
        );
        // The good migration committed; the bad one neither committed DDL nor a row.
        const names = (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
        assert.ok(names.includes('ok'));
        const recorded = (
          db.prepare('SELECT name FROM _migrations').all() as { name: string }[]
        ).map((r) => r.name);
        assert.deepEqual(recorded, ['010_ok.sql']);
        db.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws MigrationError for a missing directory', () => {
      const db = new Database(':memory:');
      assert.throws(
        () => runMigrations(db, path.join(os.tmpdir(), 'etn-does-not-exist-' + Date.now())),
        (err: unknown) => err instanceof MigrationError && /does not exist/.test(err.message),
      );
      db.close();
    });
  },
);
