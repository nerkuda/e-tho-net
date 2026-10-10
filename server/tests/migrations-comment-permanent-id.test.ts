/**
 * Migration 048 — normalising legacy permanent-comment ids onto the owner's
 * deterministic id (bug 086cb735, version 0.12.1).
 *
 * Before the write-side fix (bug 46b93145, commit dff9ed4f) a child layer and
 * the base could each mint a permanent comment for the SAME owner with a
 * DIFFERENT random id (the uniqueness enforced by `idx_comments_permanent_one`
 * is per layer, and the duplicate check reads only the current visibility).
 * The write-side fix converges NEW writes on the deterministic UUIDv5 of the
 * owner (`db/comment-permanent-id.ts`) but leaves already-diverged rows alone —
 * this migration rewrites them, and synchronously rewrites every reference to
 * `comments.id`.
 *
 * Covers:
 *   * a seeded legacy pair (layer + base, two random ids) collapses onto ONE
 *     deterministic id, the nearest-layer row staying the visible winner;
 *   * `comment_targets.comment_id` and `activity_log.entity_id` are rewritten;
 *   * a clean database is a no-op, and a second run changes nothing;
 *   * a row whose deterministic id is already taken in its layer is left
 *     untouched (no crash) and reported through `etn_migration_warn`.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { permanentCommentId } from '../src/db/comment-permanent-id.js';
import { runMigrations } from '../src/db/migrator.js';
import { getPermanentFull } from '../src/domain/comment-service.js';
import { networkMigrationsDir } from '../src/paths.js';
import { networkMigrationFilesFrom } from './migration-files.js';

/** Migration file under test. */
const MIGRATION = '048_comment_permanent_deterministic_id.sql';

/**
 * Ожидание первого прогона из состояния «строго до 048» — сам файл 048 и все
 * последующие (сейчас 049), выводится из каталога (задача 8816c01f).
 */
const EXPECTED_APPLIED_FROM_048 = networkMigrationFilesFrom(MIGRATION);

const LAYER_A = '11111111-1111-4111-8111-111111111111';
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function nativeAvailable(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply every migration EXCEPT 048 (copied into a temp dir, as the migrator
 * reads a whole directory), so legacy rows can be seeded before 048 runs.
 */
function pre048Db(warnings: string[]): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), 'etn-mig-048-'));
  for (const f of readdirSync(networkMigrationsDir()).filter(
    (f) => f.endsWith('.sql') && f < MIGRATION,
  )) {
    cpSync(path.join(networkMigrationsDir(), f), path.join(dir, f));
  }
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db, { warn: (m) => warnings.push(m) });
  runMigrations(db, dir);
  rmSync(dir, { recursive: true, force: true });
  return db;
}

/** Child layer A (parent = base). */
function insertLayerA(db: Database.Database): void {
  db.prepare(
    `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
     VALUES (?, ?, 'Слой А', 0, 1, 'u', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(LAYER_A, BASE_LAYER_ID);
}

/** Seed a thought (the polymorphic comment owner) in the base layer. */
function seedThought(db: Database.Database): void {
  db.prepare(
    `INSERT INTO thoughts (id, layer_id, title, title_norm, active, is_protected, is_root,
                           version, created_at, created_by, updated_at, updated_by,
                           created_at_ms, updated_at_ms)
     VALUES (?, ?, 'Владелец', 'владелец', 1, 0, 0, 1,
             '2026-01-01T00:00:00Z', 'u', '2026-01-01T00:00:00Z', 'u', 0, 0)`,
  ).run(OWNER, BASE_LAYER_ID);
}

/** Physically insert a permanent comment row into a layer with an arbitrary id. */
function seedPermanent(
  db: Database.Database,
  id: string,
  layerId: string,
  bodyMd: string,
  deleted = 0,
): void {
  db.prepare(
    `INSERT INTO comments (id, layer_id, deleted, base_version, owner_type, owner_id,
                           kind, title, body_md, body_html, valid_from, valid_to, use_time,
                           version, created_at, updated_at, created_by, updated_by,
                           created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 0, 'thought', ?, 'permanent', NULL, ?, '<p>x</p>',
             '2026-01-01T00:00:00Z', NULL, 0, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
             'u', 'u', 0, 0)`,
  ).run(id, layerId, deleted, OWNER, bodyMd);
}

/** Physically insert a chronological comment row (used to occupy an id). */
function seedChronological(db: Database.Database, id: string, layerId: string): void {
  db.prepare(
    `INSERT INTO comments (id, layer_id, deleted, base_version, owner_type, owner_id,
                           kind, title, body_md, body_html, valid_from, valid_to, use_time,
                           version, created_at, updated_at, created_by, updated_by,
                           created_at_ms, updated_at_ms)
     VALUES (?, ?, 0, 0, 'thought', ?, 'chronological', 't', 'x', '<p>x</p>',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 1,
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'u', 'u', 0, 0)`,
  ).run(id, layerId, OWNER);
}

/** Seed a comment_targets row (own row identity, comment_id = logical comment). */
function seedTarget(db: Database.Database, commentId: string, layerId: string): void {
  db.prepare(
    `INSERT INTO comment_targets (id, layer_id, deleted, base_version, comment_id, owner_type, owner_id)
     VALUES (?, ?, 0, 0, ?, 'thought', ?)`,
  ).run(`target-${commentId}-${layerId}`, layerId, commentId, OWNER);
}

/** Seed an activity_log entry for a comment. */
function seedActivity(db: Database.Database, entityId: string): void {
  db.prepare(
    `INSERT INTO activity_log (id, network_id, user_id, action, entity_type, entity_id,
                               entity_title, layer_id, occurred_at_ms)
     VALUES (?, 'net', 'u', 'created', 'comment', ?, 'комментарий', NULL, 0)`,
  ).run(`act-${entityId}`, entityId);
}

describe(
  'migration 048 — legacy permanent-comment id normalisation (bug 086cb735)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('collapses a legacy layer+base pair onto the deterministic id and rewrites references', () => {
      const warnings: string[] = [];
      const db = pre048Db(warnings);
      try {
        insertLayerA(db);
        seedThought(db);

        // Pre-fix shape: two DISTINCT random logical ids, one per layer.
        const layerId = '0f0f0f0f-1111-4111-8111-111111111111';
        const baseId = '0f0f0f0f-2222-4222-8222-222222222222';
        seedPermanent(db, layerId, LAYER_A, 'версия слоя');
        seedPermanent(db, baseId, BASE_LAYER_ID, 'версия основы');
        seedTarget(db, layerId, LAYER_A);
        seedTarget(db, baseId, BASE_LAYER_ID);
        seedActivity(db, layerId);
        seedActivity(db, baseId);

        const res = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res.applied, EXPECTED_APPLIED_FROM_048);

        const det = permanentCommentId('thought', OWNER);
        const rows = db
          .prepare(
            `SELECT id, layer_id, body_md, deleted FROM comments
              WHERE owner_id = ? ORDER BY layer_id`,
          )
          .all(OWNER) as Array<{ id: string; layer_id: string; body_md: string; deleted: number }>;
        assert.equal(rows.length, 2);
        assert.deepEqual(
          rows.map((r) => r.id),
          [det, det],
          'both legacy rows converge on the deterministic id',
        );
        assert.deepEqual(
          rows.map((r) => [r.layer_id, r.body_md]),
          [
            [BASE_LAYER_ID, 'версия основы'],
            [LAYER_A, 'версия слоя'],
          ],
          'bodies and layers are preserved',
        );

        // References rewritten.
        const targets = db
          .prepare('SELECT comment_id FROM comment_targets WHERE owner_id = ? ORDER BY layer_id')
          .all(OWNER) as Array<{ comment_id: string }>;
        assert.equal(targets.length, 2);
        assert.deepEqual(
          targets.map((t) => t.comment_id),
          [det, det],
        );
        const acts = db
          .prepare("SELECT entity_id FROM activity_log WHERE entity_type = 'comment' ORDER BY entity_id")
          .all() as Array<{ entity_id: string }>;
        assert.equal(acts.length, 2);
        assert.deepEqual(
          acts.map((a) => a.entity_id),
          [det, det],
        );
        assert.equal(warnings.length, 0, 'no conflicts expected');

        // Nearest layer stays the visible winner: one permanent comment in a
        // context whose chain sees both layers.
        const ndb = new NetworkDb(db, 'net', ':memory:', LAYER_A);
        const visible = ndb
          .prepare(
            `SELECT COUNT(*) AS c FROM comments_v
              WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'`,
          )
          .get(OWNER) as { c: number };
        assert.equal(visible.c, 1, 'exactly one visible permanent comment');
        assert.equal(getPermanentFull(ndb, 'thought', OWNER)?.body_md, 'версия слоя');
        assert.equal(getPermanentFull(ndb, 'thought', OWNER)?.id, det);
      } finally {
        db.close();
      }
    });

    it('is a no-op on a clean database and idempotent on a second run', () => {
      const warnings: string[] = [];
      const db = pre048Db(warnings);
      try {
        insertLayerA(db);
        seedThought(db);
        const layerId = '0f0f0f0f-3333-4333-8333-333333333333';
        const baseId = '0f0f0f0f-4444-4444-8444-444444444444';
        seedPermanent(db, layerId, LAYER_A, 'версия слоя');
        seedPermanent(db, baseId, BASE_LAYER_ID, 'версия основы');
        seedTarget(db, layerId, LAYER_A);

        runMigrations(db, networkMigrationsDir());
        const det = permanentCommentId('thought', OWNER);
        const afterFirst = db
          .prepare('SELECT pk, id, layer_id FROM comments WHERE owner_id = ? ORDER BY pk')
          .all(OWNER) as Array<{ pk: number; id: string; layer_id: string }>;
        assert.ok(afterFirst.every((r) => r.id === det));

        // Direct replay: forget the bookkeeping row and run the catalogue again.
        db.prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION);
        const res2 = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res2.applied, [MIGRATION]);
        const afterSecond = db
          .prepare('SELECT pk, id, layer_id FROM comments WHERE owner_id = ? ORDER BY pk')
          .all(OWNER) as Array<{ pk: number; id: string; layer_id: string }>;
        assert.deepEqual(afterSecond, afterFirst, 'a second run changes nothing');
        assert.equal(warnings.length, 0);
      } finally {
        db.close();
      }
    });

    it('a clean database without permanent comments gets no DML at all', () => {
      const warnings: string[] = [];
      const db = pre048Db(warnings);
      try {
        const before = db.prepare('SELECT COUNT(*) AS c FROM comments').get() as { c: number };
        const res = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res.applied, EXPECTED_APPLIED_FROM_048);
        const after = db.prepare('SELECT COUNT(*) AS c FROM comments').get() as { c: number };
        assert.deepEqual(after, before);
        assert.equal(warnings.length, 0);
      } finally {
        db.close();
      }
    });

    it('leaves a row alone and warns when its deterministic id is already taken in the layer', () => {
      const warnings: string[] = [];
      const db = pre048Db(warnings);
      try {
        insertLayerA(db);
        seedThought(db);
        const det = permanentCommentId('thought', OWNER);
        const legacyId = '0f0f0f0f-5555-4555-8555-555555555555';

        // The deterministic id is occupied in layer A by a foreign row (here a
        // chronological comment) — renaming the legacy permanent row would
        // violate UNIQUE (id, layer_id).
        seedChronological(db, det, LAYER_A);
        seedPermanent(db, legacyId, LAYER_A, 'версия слоя');
        seedTarget(db, legacyId, LAYER_A);
        seedActivity(db, legacyId);

        const res = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res.applied, EXPECTED_APPLIED_FROM_048);

        const permanent = db
          .prepare("SELECT id FROM comments WHERE owner_id = ? AND kind = 'permanent'")
          .get(OWNER) as { id: string };
        assert.equal(permanent.id, legacyId, 'conflicting row is left untouched');
        const target = db
          .prepare('SELECT comment_id FROM comment_targets WHERE owner_id = ?')
          .get(OWNER) as { comment_id: string };
        assert.equal(target.comment_id, legacyId, 'its reference is not rewritten either');
        const act = db
          .prepare("SELECT entity_id FROM activity_log WHERE entity_type = 'comment'")
          .get() as { entity_id: string };
        assert.equal(act.entity_id, legacyId);
        assert.equal(warnings.length, 1, 'the conflict is reported');
        assert.match(warnings[0]!, /048: постоянный комментарий/);
        assert.match(warnings[0]!, /оставлен без нормализации/);
      } finally {
        db.close();
      }
    });
  },
);
