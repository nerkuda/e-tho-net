/**
 * Regression tests for permanent comments across the layer chain.
 *
 * Bug 46b93145 (version 0.12.1): "Дублирующий постоянный комментарий владельца
 * на стыке слоёв: защита от дубля и уникальный индекс не действуют по цепочке
 * слоёв".
 *
 * Root cause. `idx_comments_permanent_one` is unique only PER
 * `(owner_type, owner_id, layer_id)`, and the duplicate check in
 * `createCommentWithTargets` reads `comments_v` (visible rows of the current
 * context). A child layer "A" and the base cannot see each other's rows, so
 * each independently minted a permanent comment for the SAME owner with a
 * DIFFERENT random logical id. Back in layer A the connection's chain is
 * `[A, base]`, so `comments_v` reported BOTH — two visible permanent comments.
 *
 * Two covers:
 *   * write side (the fix): the permanent comment's logical id is derived
 *     deterministically from the owner natural key
 *     (`db/comment-permanent-id.ts`, like `property_values` / bug dc119240), so
 *     an independent "first write" from the base converges with the row already
 *     held by an invisible child layer into ONE id — exactly one visible winner
 *     per context, "nearest layer wins" (13-layers.md §4.1).
 *   * read side (bug a7d3ef19): `getPermanentRow` deterministically picks the
 *     nearest-layer row even when TWO logical ids for the same owner exist. That
 *     state is no longer reachable through the API after the write-side fix, so
 *     it is seeded directly (physical rows) to keep the read-side regression
 *     covered.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { permanentCommentId } from '../src/db/comment-permanent-id.js';
import {
  createComment,
  getCommentsPreview,
  getPermanentFull,
  getPermanentPreview,
} from '../src/domain/comment-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const LAYER_A = '11111111-1111-4111-8111-111111111111';

/** Seed layer A (child of base). */
function insertLayerA(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
    )
    .run(LAYER_A, BASE_LAYER_ID, 'Слой А', 1, now, now);
}

/** Seed a thought directly (base layer) so the polymorphic owner exists. */
function seedThought(ndb: NetworkDb, title = 'Владелец'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

/**
 * Physically insert a permanent comment row into a specific layer, bypassing
 * the domain guard (used to synthesise the pre-fix "two logical ids" state that
 * the read-side fix must still resolve).
 */
function seedPhysicalPermanent(
  ndb: NetworkDb,
  ownerId: string,
  layerId: string,
  bodyMd: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO comments (id, layer_id, deleted, base_version, owner_type, owner_id,
                             kind, title, body_md, body_html, valid_from, valid_to, use_time,
                             version, created_at, updated_at, created_by, updated_by,
                             created_at_ms, updated_at_ms)
       VALUES (?, ?, 0, 0, 'thought', ?, 'permanent', NULL, ?, '', ?, NULL, 0,
               1, ?, ?, 'u', 'u', 0, 0)`,
    )
    .run(id, layerId, ownerId, bodyMd, bodyMd, now, now);
  return id;
}

/** Live physical permanent rows of the owner (both layers; audit). */
function physicalPermanentBodies(ndb: NetworkDb, ownerId: string): string[] {
  return (
    ndb
      .prepare(
        `SELECT body_md FROM comments
         WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent' AND deleted = 0`,
      )
      .all(ownerId) as Array<{ body_md: string }>
  ).map((r) => r.body_md);
}

/** Visible permanent winners of the owner in the current connection context. */
function visiblePermanentCount(ndb: NetworkDb, ownerId: string): number {
  return (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM comments_v
         WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'`,
      )
      .get(ownerId) as { c: number }
  ).c;
}

describe(
  'permanent comment across layers (bugs 46b93145 / a7d3ef19)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('write side: layer and base converge on ONE logical id (no twin winner)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const ownerId = seedThought(ndb);
        const expectedId = permanentCommentId('thought', ownerId);

        // 1. Layer A: the first permanent comment ever for this owner.
        ndb.useLayer(LAYER_A);
        const layerComment = createComment(
          ndb,
          'thought',
          ownerId,
          { kind: 'permanent', body_md: 'версия слоя' },
          USER,
        );
        assert.equal(layerComment.id, expectedId, 'id is deterministic from the owner');

        // 2. Base: cannot see A's row, so the visibility-based duplicate check
        // passes — but the deterministic id makes it the SAME logical row, not
        // a second one.
        ndb.useLayer(BASE_LAYER_ID);
        const baseComment = createComment(
          ndb,
          'thought',
          ownerId,
          { kind: 'permanent', body_md: 'версия основы' },
          USER,
        );
        assert.equal(baseComment.id, layerComment.id, 'the twin converges on one logical id');
        assert.deepEqual(physicalPermanentBodies(ndb, ownerId).sort(), [
          'версия основы',
          'версия слоя',
        ]);

        // Base context sees its own (only) winner.
        assert.equal(visiblePermanentCount(ndb, ownerId), 1);
        assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.body_md, 'версия основы');

        // 3. Back in layer A the chain is [A, base]: one logical id, nearest
        // layer wins — exactly one visible permanent comment.
        ndb.useLayer(LAYER_A);
        assert.equal(visiblePermanentCount(ndb, ownerId), 1, 'no duplicate winner in layer A');
        assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.body_md, 'версия слоя');
        assert.equal(getPermanentPreview(ndb, 'thought', ownerId)?.id, layerComment.id);
        assert.equal(getCommentsPreview(ndb, 'thought', ownerId).permanent?.body_md, 'версия слоя');
      } finally {
        ndb.close();
      }
    });

    it('write side: a second permanent comment visible in the context is rejected', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const ownerId = seedThought(ndb);

        ndb.useLayer(LAYER_A);
        createComment(ndb, 'thought', ownerId, { kind: 'permanent', body_md: 'версия слоя' }, USER);

        assert.throws(
          () =>
            createComment(ndb, 'thought', ownerId, { kind: 'permanent', body_md: 'ещё' }, USER),
          (err: unknown) => err instanceof EtnError && err.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('read side (a7d3ef19): nearest layer wins among two legacy logical ids', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const ownerId = seedThought(ndb);

        // Synthesise the pre-fix diverged state: two DISTINCT ids, one per layer.
        const layerId = seedPhysicalPermanent(ndb, ownerId, LAYER_A, 'версия слоя');
        seedPhysicalPermanent(ndb, ownerId, BASE_LAYER_ID, 'версия основы');

        // From the base context only its own row is visible.
        assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.body_md, 'версия основы');

        // In layer A both logical ids are visible winners for the same owner.
        ndb.useLayer(LAYER_A);
        assert.equal(visiblePermanentCount(ndb, ownerId), 2);

        // The visible version (nearest layer) wins, deterministically.
        assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.body_md, 'версия слоя');
        assert.equal(getPermanentPreview(ndb, 'thought', ownerId)?.id, layerId);
        assert.equal(getCommentsPreview(ndb, 'thought', ownerId).permanent?.body_md, 'версия слоя');

        // Repeat reads stay stable (no order-dependent flip-flop).
        for (let i = 0; i < 5; i += 1) {
          assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.id, layerId);
        }
      } finally {
        ndb.close();
      }
    });
  },
);
