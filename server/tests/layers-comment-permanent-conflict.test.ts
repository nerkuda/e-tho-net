/**
 * Repro/regression test for bug a7d3ef19 (version 0.12.1):
 * "Поиск постоянного комментария LIMIT 1 без ORDER BY — недетерминирован при
 * двух видимых комментариях мысли в цепочке слоёв".
 *
 * Scenario: a permanent comment is created for a thought in a child layer "A"
 * FIRST (nothing exists anywhere yet), then a permanent comment for the SAME
 * owner is created from the base layer. The base cannot see A's row, so its
 * duplicate check (over `comments_v`) passes and it independently mints a
 * second logical id — `idx_comments_permanent_one` is unique only PER
 * (owner_type, owner_id, layer_id), not along the layer chain.
 *
 * Back in layer A the connection's chain is `[A, base]`, so `comments_v`
 * reports BOTH rows (different logical ids, one winner each). The old
 * `SELECT … LIMIT 1` without `ORDER BY` picked one arbitrarily; the fix
 * orders by `layer_chain.depth ASC`, so the row from the nearest layer — the
 * version actually visible from this context — wins deterministically.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
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

/** Physical `comments` rows of the owner (bypasses `*_v`; audit of both layers). */
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

describe(
  'permanent comment across layers — deterministic visible winner (bug a7d3ef19)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('nearest layer wins when a layer and the base both hold a permanent comment', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const ownerId = seedThought(ndb);

        // 1. Layer A: the first permanent comment ever for this owner.
        ndb.useLayer(LAYER_A);
        const layerComment = createComment(
          ndb,
          'thought',
          ownerId,
          { kind: 'permanent', body_md: 'версия слоя' },
          USER,
        );

        // 2. Base: cannot see A's row, so its duplicate check over `comments_v`
        // passes — an independent second permanent comment is minted.
        ndb.useLayer(BASE_LAYER_ID);
        const baseComment = createComment(
          ndb,
          'thought',
          ownerId,
          { kind: 'permanent', body_md: 'версия основы' },
          USER,
        );
        assert.notEqual(layerComment.id, baseComment.id);
        assert.deepEqual(physicalPermanentBodies(ndb, ownerId).sort(), [
          'версия основы',
          'версия слоя',
        ]);

        // From the base context only its own row is visible.
        assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.body_md, 'версия основы');

        // 3. Back in layer A the chain is [A, base] — both logical ids are
        // visible winners for the same owner (the precondition of the bug).
        ndb.useLayer(LAYER_A);
        const visibleCount = (
          ndb
            .prepare(
              `SELECT COUNT(*) AS c FROM comments_v
               WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'`,
            )
            .get(ownerId) as { c: number }
        ).c;
        assert.equal(visibleCount, 2, 'both permanent comments must be visible in layer A');

        // The visible version (nearest layer) wins, deterministically.
        assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.body_md, 'версия слоя');
        assert.equal(getPermanentPreview(ndb, 'thought', ownerId)?.id, layerComment.id);
        assert.equal(getCommentsPreview(ndb, 'thought', ownerId).permanent?.body_md, 'версия слоя');

        // Repeat reads stay stable (no order-dependent flip-flop).
        for (let i = 0; i < 5; i += 1) {
          assert.equal(getPermanentFull(ndb, 'thought', ownerId)?.id, layerComment.id);
        }
      } finally {
        ndb.close();
      }
    });
  },
);
