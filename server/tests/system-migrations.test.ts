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
  '010_api_keys_max_writes_per_minute.sql',
  '011_networks_self_description.sql',
  '012_mcp_tool_call_metrics.sql',
  '013_networks_type_roles.sql',
  '014_user_settings.sql',
  '015_networks_first_day_of_week.sql',
  '016_update_jobs.sql',
  '017_networks_language.sql',
  '018_update_jobs_failure_fields.sql',
  '019_user_files.sql',
];

/** All `_system.db` tables that must exist after migration. */
const EXPECTED_TABLES = [
  '_migrations',
  'users',
  'api_keys',
  'networks',
  'network_members',
  'user_preferences',
  'user_settings',
  'audit_log',
  'client_request_cache',
  'settings',
  'event_log',
  'network_seq',
  'mcp_tool_call_metrics',
  'update_jobs',
  'user_files',
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
        assert.ok(
          apiCols.includes('max_writes_per_minute'),
          'api_keys.max_writes_per_minute missing (O8)',
        );

        // Машиночитаемая причина сбоя задания (миграция 018, задача 4f6c972a).
        const jobCols = (
          db.prepare('PRAGMA table_info(update_jobs)').all() as { name: string }[]
        ).map((r) => r.name);
        for (const column of ['reason', 'failed_stage', 'exit_code', 'log_path']) {
          assert.ok(jobCols.includes(column), `update_jobs.${column} missing`);
        }

        // user_files — файлы пользователя в сети (миграция 019, задачи
        // 8e007e63 + 5db41abf, сущность 62fd29b5): состав колонок, PK по
        // (user_id, network_id, kind) как UNIQUE-инвариант и каскад по user_id.
        const fileCols = db.prepare('PRAGMA table_info(user_files)').all() as {
          name: string;
          notnull: number;
          pk: number;
        }[];
        assert.deepEqual(
          fileCols.map((c) => c.name),
          [
            'user_id',
            'network_id',
            'kind',
            'file_path',
            'content_hash',
            'file_size',
            'mime_type',
            'meta',
            'updated_at',
          ],
        );
        for (const column of fileCols) {
          assert.equal(column.notnull, 1, `user_files.${column.name} must be NOT NULL`);
        }
        assert.deepEqual(
          fileCols.filter((c) => c.pk > 0).map((c) => c.name),
          ['user_id', 'network_id', 'kind'],
          'user_files PK must be (user_id, network_id, kind)',
        );

        // Поиск строк удаляемой сети идёт по network_id без префикса user_id —
        // первичный ключ такой запрос не обслуживает (задача 5db41abf).
        const fileIndexes = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_files'")
          .all() as { name: string }[];
        assert.ok(
          fileIndexes.some((index) => index.name === 'idx_user_files_network'),
          'user_files must have an index on network_id',
        );

        const fileFks = db.prepare('PRAGMA foreign_key_list(user_files)').all() as {
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }[];
        assert.equal(fileFks.length, 1, 'user_files must have exactly one FK');
        const fileFk = fileFks.at(0);
        assert.ok(fileFk !== undefined);
        assert.deepEqual(
          { table: fileFk.table, from: fileFk.from, to: fileFk.to, on_delete: fileFk.on_delete },
          { table: 'users', from: 'user_id', to: 'id', on_delete: 'CASCADE' },
        );

        // Каскад работает: удаление пользователя уносит его файловые строки
        // (ревизия итерации 1 к задаче 8e007e63).
        db.prepare(
          "INSERT INTO users (id, username, is_admin, is_first_user, disabled, created_at, updated_at) VALUES ('u-cascade', 'cascade', 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        ).run();
        db.prepare(
          "INSERT INTO user_files (user_id, network_id, kind, file_path, content_hash, file_size, mime_type, meta, updated_at) VALUES ('u-cascade', 'n-1', 'map_wallpaper', '/tmp/x.jpg', 'hash', 1, 'image/jpeg', '{\"width\":1,\"height\":1,\"avg_luminance\":0}', 1)",
        ).run();
        db.prepare("DELETE FROM users WHERE id = 'u-cascade'").run();
        assert.equal(
          (db.prepare('SELECT COUNT(*) AS c FROM user_files').get() as { c: number }).c,
          0,
          'user_files rows must cascade on user deletion',
        );

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
