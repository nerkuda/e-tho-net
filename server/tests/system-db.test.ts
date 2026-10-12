/**
 * Unit tests for {@link SystemDb} (task B4).
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Open an in-memory migrated connection to build a {@link SystemDb} on. */
function openDb(): Database.Database {
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  return db;
}

describe(
  'SystemDb',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('creates and looks up a user by id and username', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const id = randomUUID();
        const u = sys.createUser({
          id,
          username: 'alice',
          displayName: 'Alice',
          isAdmin: true,
          isFirstUser: true,
        });
        assert.equal(u.id, id);
        assert.equal(u.is_admin, true);
        assert.equal(u.is_first_user, true);
        assert.equal(u.disabled, false);

        const byId = sys.getUserById(id);
        assert.equal(byId?.username, 'alice');
        assert.equal(byId?.is_admin, true);

        const byName = sys.getUserByUsername('alice');
        assert.equal(byName?.id, id);

        assert.equal(sys.getUserById('does-not-exist'), null);
        assert.equal(sys.getUserByUsername('nobody'), null);
      } finally {
        sys.close();
      }
    });

    it('rejects a duplicate username via the unique index', () => {
      const sys = new SystemDb(openDb());
      try {
        sys.createUser({ id: randomUUID(), username: 'dup', displayName: null });
        assert.throws(() =>
          sys.createUser({ id: randomUUID(), username: 'dup', displayName: null }),
        );
      } finally {
        sys.close();
      }
    });

    it('creates a key and finds it by hash with the owner', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const uid = randomUUID();
        sys.createUser({ id: uid, username: 'bob', displayName: null });
        const kid = randomUUID();
        const key = sys.createApiKey({
          id: kid,
          userId: uid,
          label: 'desktop',
          keyHash: 'deadbeef'.repeat(8),
          keyPrefix: 'deadbeef',
          readOnly: false,
        });
        assert.equal(key.prefix, 'deadbeef');
        assert.equal(key.read_only, false);

        const found = sys.findApiKeyByHash('deadbeef'.repeat(8));
        assert.ok(found);
        assert.equal(found!.apiKey.id, kid);
        assert.equal(found!.user.id, uid);
        assert.equal(found!.user.username, 'bob');

        assert.equal(sys.findApiKeyByHash('00'.repeat(32)), null);
      } finally {
        sys.close();
      }
    });

    it('stores and updates a per-key write rate limit override (O8)', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const uid = randomUUID();
        sys.createUser({ id: uid, username: 'o8', displayName: null });
        const kid = randomUUID();
        const key = sys.createApiKey({
          id: kid,
          userId: uid,
          label: 'bulk-import',
          keyHash: '0a'.repeat(32),
          keyPrefix: '0a0a0a0a',
          maxWritesPerMinute: 1000,
        });
        assert.equal(key.max_writes_per_minute, 1000);

        const found = sys.getApiKeyById(kid);
        assert.equal(found?.max_writes_per_minute, 1000);
        assert.equal(sys.findApiKeyByHash('0a'.repeat(32))?.apiKey.max_writes_per_minute, 1000);

        // Clear the override → back to null (server default).
        sys.updateApiKeyMaxWrites(kid, null);
        assert.equal(sys.getApiKeyById(kid)?.max_writes_per_minute, null);

        sys.updateApiKeyMaxWrites(kid, 5);
        assert.equal(sys.getApiKeyById(kid)?.max_writes_per_minute, 5);
      } finally {
        sys.close();
      }
    });

    it('does not return a disabled key', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const uid = randomUUID();
        sys.createUser({ id: uid, username: 'c', displayName: null });
        const kid = randomUUID();
        const hash = '01'.repeat(32);
        sys.createApiKey({
          id: kid,
          userId: uid,
          label: null,
          keyHash: hash,
          keyPrefix: '01010101',
        });
        db.prepare('UPDATE api_keys SET disabled = 1 WHERE id = ?').run(kid);
        assert.equal(sys.findApiKeyByHash(hash), null);
      } finally {
        sys.close();
      }
    });

    it('does not return a key whose owner is disabled', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const uid = randomUUID();
        sys.createUser({ id: uid, username: 'd', displayName: null });
        const hash = '02'.repeat(32);
        sys.createApiKey({
          id: randomUUID(),
          userId: uid,
          label: null,
          keyHash: hash,
          keyPrefix: '02020202',
        });
        db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(uid);
        assert.equal(sys.findApiKeyByHash(hash), null);
      } finally {
        sys.close();
      }
    });

    it('touches last_used_at and writes audit log', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const uid = randomUUID();
        sys.createUser({ id: uid, username: 'e', displayName: null });
        const kid = randomUUID();
        const hash = '03'.repeat(32);
        sys.createApiKey({
          id: kid,
          userId: uid,
          label: null,
          keyHash: hash,
          keyPrefix: '03030303',
        });

        sys.touchApiKeyUsed(kid);
        const lastUsed = (
          db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(kid) as {
            last_used_at: string | null;
          }
        ).last_used_at;
        assert.ok(lastUsed);

        sys.insertAuditLog({ category: 'system', action: 'init', actorUserId: uid });
        const cnt = (db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
        assert.equal(cnt, 1);
      } finally {
        sys.close();
      }
    });

    it('reports whether a first user already exists', () => {
      const sys = new SystemDb(openDb());
      try {
        assert.equal(sys.hasFirstUser(), false);
        sys.createUser({
          id: randomUUID(),
          username: 'root',
          displayName: 'Root',
          isFirstUser: true,
        });
        assert.equal(sys.hasFirstUser(), true);
      } finally {
        sys.close();
      }
    });

    it('rolls back the whole transaction on throw', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const before = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
        assert.throws(() =>
          sys.transaction(() => {
            sys.createUser({ id: randomUUID(), username: 'tmp', displayName: null });
            throw new Error('boom');
          }),
        );
        const after = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
        assert.equal(after, before);
      } finally {
        sys.close();
      }
    });
  },
);

describe(
  'SystemDb: настройка сети «первый день недели» (0.13.1, задача 0f1b9892)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('createNetworkRow ставит первый день недели (по умолчанию — из ОС сервера)', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const userId = sys.createUser({ id: randomUUID(), username: 'owner', displayName: null }).id;
        const n = sys.createNetworkRow(randomUUID(), userId, 'Сеть', null);
        // Дефолт берётся из локали сервера (ISO 1..7).
        assert.ok(n.first_day_of_week >= 1 && n.first_day_of_week <= 7);
        // Прочитанная строка несёт то же значение.
        assert.equal(sys.getNetworkById(n.id)!.first_day_of_week, n.first_day_of_week);
      } finally {
        sys.close();
      }
    });

    it('existing rows (миграция) по умолчанию — понедельник (1)', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const userId = sys.createUser({ id: randomUUID(), username: 'owner2', displayName: null }).id;
        const id = randomUUID();
        const now = '2026-01-01T00:00:00.000Z';
        // Вставка только обязательных колонок: first_day_of_week берёт DEFAULT 1.
        db.prepare(
          `INSERT INTO networks (id, display_name, owner_id, description, type_roles, created_at, updated_at)
           VALUES (?, 'Легаси', ?, NULL, '{}', ?, ?)`,
        ).run(id, userId, now, now);
        const row = db.prepare('SELECT first_day_of_week AS f FROM networks WHERE id = ?').get(id) as { f: number };
        assert.equal(row.f, 1);
      } finally {
        sys.close();
      }
    });

    it('updateNetwork меняет настройку; без поля — сохраняет текущую', () => {
      const db = openDb();
      const sys = new SystemDb(db);
      try {
        const userId = sys.createUser({ id: randomUUID(), username: 'owner3', displayName: null }).id;
        const n = sys.createNetworkRow(randomUUID(), userId, 'Сеть', null);
        const base = {
          displayName: n.display_name,
          description: n.description,
          when_to_use: n.when_to_use,
          conventions: n.conventions,
          examples: n.examples,
          type_roles: n.type_roles,
        };
        sys.updateNetwork(n.id, { ...base, first_day_of_week: 7 });
        assert.equal(sys.getNetworkById(n.id)!.first_day_of_week, 7);
        // Поле не задано — значение столбца сохраняется (COALESCE).
        sys.updateNetwork(n.id, { ...base });
        assert.equal(sys.getNetworkById(n.id)!.first_day_of_week, 7);
      } finally {
        sys.close();
      }
    });
  },
);
