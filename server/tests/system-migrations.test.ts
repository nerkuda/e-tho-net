/**
 * Tests for the bundled `_system.db` migrations (task B3).
 *
 * The first group is a filesystem-only inventory check (no native binding
 * required) and always runs. The second group actually applies the migrations
 * to an in-memory database and is skipped when `better-sqlite3` is unavailable.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';

const EXPECTED_FILES = [
  '001_users.sql',
  '002_api_keys.sql',
  '003_networks.sql',
  '004_network_members.sql',
  '005_user_preferences.sql',
  '006_audit_log.sql',
  '007_client_request_cache.sql',
  '008_settings.sql',
  '009_event_log.sql',
];

/** All `_system.db` tables that must exist after migration. */
const EXPECTED_TABLES = [
  '_migrations',
  'users',
  'api_keys',
  'networks',
  'network_members',
  'user_preferences',
  'audit_log',
  'client_request_cache',
  'settings',
  'event_log',
  'network_seq',
];

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

describe('system migrations (filesystem)', () => {
  it('ships all expected migration files in sorted order', () => {
    const files = readdirSync(systemMigrationsDir())
      .filter((f) => f.endsWith('.sql'))
      .sort();
    assert.deepEqual(files, EXPECTED_FILES);
  });
});

describe(
  'system migrations (apply)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('creates every _system.db table and seeds settings', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      try {
        const res = runMigrations(db, systemMigrationsDir());
        assert.equal(res.skipped.length, 0);
        assert.equal(res.applied.length, EXPECTED_FILES.length);

        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
        for (const t of EXPECTED_TABLES) {
          assert.ok(tables.includes(t), `missing table: ${t}`);
        }

        // read_only column exists on api_keys (Phase-A delta, 06-auth.md §6.3).
        const apiCols = (db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[]).map(
          (r) => r.name,
        );
        assert.ok(apiCols.includes('read_only'), 'api_keys.read_only missing');

        // Settings seeded with all 7 defaults (5 SETTING_KEY + 2 traversal.*).
        const n = (db.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number }).c;
        assert.equal(n, 7);

        // Re-running is idempotent.
        const res2 = runMigrations(db, systemMigrationsDir());
        assert.equal(res2.applied.length, 0);
        assert.equal(res2.skipped.length, EXPECTED_FILES.length);
      } finally {
        db.close();
      }
    });
  },
);
