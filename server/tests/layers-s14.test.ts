/**
 * Tests for the S14 semantics of link changes inside a working layer
 * (docs/13-layers.md §6.1, §5.2, §6 — карточка S14 пп. 1–7):
 *
 * - re-pointing a link (source/target change) in a layer is NOT an UPDATE:
 *   the old row gets a tombstone carrying the base-layer version as
 *   `base_version` (п.7), a new link appears under a new `id` (version 1,
 *   no ancestor), and the dependants of the old identity follow it into the
 *   grave (same cascade as a layer deletion, §5.2). In the base layer the
 *   same PATCH stays an in-place UPDATE with a stable id;
 * - a type/style change (and any other non-endpoint field) is an UPDATE of
 *   the shadow row: same id, `version` bumps, `base_version` stays frozen
 *   at the ancestor version captured on materialisation;
 * - a PATCH that repeats the current endpoint values does not re-point the
 *   link (identity must not flip for a no-op);
 * - the endpoints' thought rows are NOT copied into the layer (п.5 — a
 *   re-point materialises only the link rows);
 * - `position` (T1) is a field of the link row and moves with it through a
 *   re-point (п.6);
 * - the unique triple (source, target, type) is enforced among LIVE rows of
 *   a layer only (migration 029): a tombstone frees its triple, so creating
 *   or re-pointing a link onto a triple occupied by a tombstone of the same
 *   layer works (п.9 in the layer-write scope), while a live duplicate is
 *   still rejected with 409 DUPLICATE;
 * - two sibling layers can hold the same triple under different ids (п.2
 *   precondition — the merge, S8, collapses them by triple);
 * - a link to a thought marked for deletion (in the trash, S13) is still
 *   created (п.3 precondition of the merge semantics).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { closeAll, createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createLink, deleteLink, getLink, updateLink } from '../src/domain/link-service.js';
import { createThought, updateThought } from '../src/domain/thought-service.js';
import { EtnError } from '@etn/shared';

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

const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_B = '33333333-3333-4333-8333-333333333333';
const USER = 'u';

/** Seed `layers` with A and B, both children of the base. */
function insertSiblingLayers(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  const ins = ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
    );
  ins.run(LAYER_A, BASE_LAYER_ID, 'Слой A', USER, now, now);
  ins.run(LAYER_B, BASE_LAYER_ID, 'Слой B', USER, now, now);
}

/** Physical row of a link (id, layer): deleted/base_version/version/position. */
function linkRow(ndb: NetworkDb, id: string, layerId: string) {
  return ndb
    .prepare(
      'SELECT deleted, base_version, version, position FROM links WHERE id = ? AND layer_id = ?',
    )
    .get(id, layerId) as
    | { deleted: number; base_version: number; version: number; position: number }
    | undefined;
}

/** Insert a link type directly into the base layer and return its id. */
function insertLinkType(ndb: NetworkDb, id: string, name: string): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO link_types (id, layer_id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               is_root, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, BASE_LAYER_ID, name, name, name, name, now, now, USER);
}

/** Insert a permanent comment owned by a link; returns the comment id. */
function insertLinkComment(ndb: NetworkDb, linkId: string): string {
  const now = new Date().toISOString();
  const id = `c-${linkId}`;
  ndb
    .prepare(
      `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, 'link', ?, 'permanent', 'текст', '<p>текст</p>', ?, 1, ?, ?, ?, ?)`,
    )
    .run(id, BASE_LAYER_ID, linkId, now, now, now, USER, USER);
  return id;
}

describe(
  'layers S14 — link change semantics inside a layer',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('§6.1 п.1: re-pointing in a layer = tombstone of the old row + new link under a new id', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);
        // Bump the base version once so the tombstone's base_version ≠ 1.
        updateLink(ndb, link.id, { color: '#123456' }, undefined, USER);

        ndb.useLayer(LAYER_A);
        const repointed = updateLink(
          ndb,
          link.id,
          { source_id: a.id, target_id: c.id },
          undefined,
          USER,
        );

        // The returned link is a NEW identity.
        assert.notEqual(repointed.id, link.id);
        assert.equal(repointed.source_id, a.id);
        assert.equal(repointed.target_id, c.id);

        // The old row is a tombstone carrying the base version (п.7).
        const oldRow = linkRow(ndb, link.id, LAYER_A);
        assert.notEqual(oldRow, undefined);
        assert.equal(oldRow!.deleted, 1);
        assert.equal(oldRow!.base_version, 2, 'tombstone must carry the base-layer version');
        // The new row is a fresh insert: no ancestor, version 1.
        const newRow = linkRow(ndb, repointed.id, LAYER_A);
        assert.notEqual(newRow, undefined);
        assert.equal(newRow!.deleted, 0);
        assert.equal(newRow!.base_version, 0);
        assert.equal(newRow!.version, 1);

        // Visibility: old id gone, new id visible; the base sees the old row.
        assert.equal(getLink(ndb, link.id), null);
        assert.notEqual(getLink(ndb, repointed.id), null);
        ndb.useLayer(BASE_LAYER_ID);
        const baseLink = getLink(ndb, link.id);
        assert.notEqual(baseLink, null);
        assert.equal(baseLink!.target_id, b.id, 'the base row is untouched by the layer edit');
        assert.equal(getLink(ndb, repointed.id), null);
      } finally {
        ndb.close();
      }
    });

    it('§6.1 п.1: re-pointing in the BASE layer stays an in-place UPDATE with a stable id', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);

        const updated = updateLink(
          ndb,
          link.id,
          { source_id: a.id, target_id: c.id },
          undefined,
          USER,
        );
        assert.equal(updated.id, link.id);
        assert.equal(updated.target_id, c.id);
        // No extra rows: the physical table has exactly one row for this link.
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS n FROM links WHERE id = ?').get(link.id) as { n: number })
            .n,
          1,
        );
      } finally {
        ndb.close();
      }
    });

    it('§6.1: a type change is an UPDATE of the shadow row (same id, base_version frozen)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        insertLinkType(ndb, 'lt1', 'см. также');
        insertLinkType(ndb, 'lt2', 'похоже на');
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id, type_id: 'lt1' }, USER);
        updateLink(ndb, link.id, { width: 3 }, undefined, USER); // base version -> 2

        ndb.useLayer(LAYER_A);
        const retyped = updateLink(ndb, link.id, { type_id: 'lt2' }, undefined, USER);
        assert.equal(retyped.id, link.id, 'a type change must not change the identity');

        const row = linkRow(ndb, link.id, LAYER_A);
        assert.notEqual(row, undefined);
        assert.equal(row!.deleted, 0);
        assert.equal(row!.base_version, 2, 'base_version is captured once, at materialisation');
        assert.equal(row!.version, 3, 'version continues the ancestor numbering');

        // A style change keeps updating the same shadow row.
        updateLink(ndb, link.id, { color: '#abcdef' }, undefined, USER);
        const row2 = linkRow(ndb, link.id, LAYER_A);
        assert.equal(row2!.version, 4);
        assert.equal(row2!.base_version, 2);
        assert.equal(getLink(ndb, link.id)!.type_id, 'lt2');
      } finally {
        ndb.close();
      }
    });

    it('§6.1: a PATCH repeating the current endpoints is a no-op UPDATE, identity intact', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);

        ndb.useLayer(LAYER_A);
        const updated = updateLink(
          ndb,
          link.id,
          { source_id: a.id, target_id: b.id, color: '#00ff00' },
          undefined,
          USER,
        );
        assert.equal(updated.id, link.id, 'same endpoints — same identity');
        assert.equal(updated.color, '#00ff00');
        // No tombstone, no second row.
        const row = linkRow(ndb, link.id, LAYER_A);
        assert.equal(row!.deleted, 0);
      } finally {
        ndb.close();
      }
    });

    it('§5.2 п.7: deleteLink in a layer materialises a tombstone with base_version', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);
        updateLink(ndb, link.id, { width: 2 }, undefined, USER); // version -> 2

        ndb.useLayer(LAYER_A);
        deleteLink(ndb, link.id, undefined);
        const row = linkRow(ndb, link.id, LAYER_A);
        assert.notEqual(row, undefined);
        assert.equal(row!.deleted, 1);
        assert.equal(row!.base_version, 2, 'the tombstone carries the pre-delete base version');
        assert.equal(row!.version, 3, 'deletion bumps the version (§5.2)');
        assert.equal(getLink(ndb, link.id), null);
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getLink(ndb, link.id), null);
      } finally {
        ndb.close();
      }
    });

    it('§6.1: re-pointing hides the old link dependants in the layer, the base keeps them', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);
        const commentId = insertLinkComment(ndb, link.id);

        ndb.useLayer(LAYER_A);
        updateLink(ndb, link.id, { source_id: a.id, target_id: c.id }, undefined, USER);

        // The comment followed the old identity into the layer's grave.
        const commentRow = ndb
          .prepare('SELECT deleted FROM comments WHERE id = ? AND layer_id = ?')
          .get(commentId, LAYER_A) as { deleted: number } | undefined;
        assert.notEqual(commentRow, undefined, 'the comment is materialised as a tombstone');
        assert.equal(commentRow!.deleted, 1);
        // The base comment is intact.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(
          (ndb
            .prepare('SELECT deleted FROM comments WHERE id = ? AND layer_id = ?')
            .get(commentId, BASE_LAYER_ID) as { deleted: number }).deleted,
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('§6.6 п.5: re-pointing copies NO thought rows into the layer', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);

        ndb.useLayer(LAYER_A);
        updateLink(ndb, link.id, { source_id: a.id, target_id: c.id }, undefined, USER);
        const shadows = ndb
          .prepare('SELECT COUNT(*) AS n FROM thoughts WHERE layer_id = ?')
          .get(LAYER_A) as { n: number };
        assert.equal(shadows.n, 0, 'endpoints are not copied into the layer');
      } finally {
        ndb.close();
      }
    });

    it('§6.5 п.6: position is a field of the row and moves with the link through a re-point', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const now = new Date().toISOString();
        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, position, active, version,
                                created_at, updated_at, created_by, updated_by)
             VALUES ('pos-link', ?, ?, ?, 42, 1, 1, ?, ?, ?, ?)`,
          )
          .run(BASE_LAYER_ID, a.id, b.id, now, now, USER, USER);

        ndb.useLayer(LAYER_A);
        const repointed = updateLink(
          ndb,
          'pos-link',
          { source_id: a.id, target_id: c.id },
          undefined,
          USER,
        );
        const row = linkRow(ndb, repointed.id, LAYER_A);
        assert.equal(row!.position, 42, 'the manual order survives the re-point');
      } finally {
        ndb.close();
      }
    });

    it('migration 029 / п.9: a tombstone frees its triple — create and re-point onto it work', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        insertLinkType(ndb, 'lt1', 'см. также');
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id, type_id: 'lt1' }, USER);

        // Delete A→B[lt1] in the layer, then re-create the same triple.
        ndb.useLayer(LAYER_A);
        deleteLink(ndb, link.id, undefined);
        const recreated = createLink(
          ndb,
          { source_id: a.id, target_id: b.id, type_id: 'lt1' },
          USER,
        );
        assert.notEqual(recreated.id, link.id);
        assert.notEqual(getLink(ndb, recreated.id), null);

        // Re-point another link onto a triple occupied by a tombstone:
        // A→C[lt1] is alive in the base; delete A→B[lt1] again, then move
        // A→C onto the freed (A→B) triple.
        const ac = createLink(ndb, { source_id: a.id, target_id: c.id, type_id: 'lt1' }, USER);
        deleteLink(ndb, recreated.id, undefined);
        const moved = updateLink(
          ndb,
          ac.id,
          { source_id: a.id, target_id: b.id },
          undefined,
          USER,
        );
        assert.equal(moved.target_id, b.id);
        assert.notEqual(getLink(ndb, moved.id), null);
      } finally {
        ndb.close();
      }
    });

    it('§6.2 precondition п.2: sibling layers hold the same triple under different ids', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        insertLinkType(ndb, 'lt1', 'см. также');
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);

        ndb.useLayer(LAYER_A);
        const linkA = createLink(ndb, { source_id: a.id, target_id: b.id, type_id: 'lt1' }, USER);
        assert.notEqual(getLink(ndb, linkA.id), null);
        ndb.useLayer(LAYER_B);
        const linkB = createLink(ndb, { source_id: a.id, target_id: b.id, type_id: 'lt1' }, USER);
        assert.notEqual(getLink(ndb, linkB.id), null);
        assert.notEqual(linkA.id, linkB.id);
        // Each layer sees only its own triple instance (siblings do not leak).
        assert.equal(getLink(ndb, linkA.id), null);
        ndb.useLayer(LAYER_A);
        assert.equal(getLink(ndb, linkB.id), null);
      } finally {
        ndb.close();
      }
    });

    it('§6.3 precondition п.3: a link to a trashed thought is still created', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        updateThought(ndb, b.id, { marked_for_deletion: true }, undefined, USER);

        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);
        assert.notEqual(link, null);
      } finally {
        ndb.close();
      }
    });

    it('re-pointing onto a live triple in the layer is rejected with DUPLICATE', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        insertLinkType(ndb, 'lt1', 'см. также');
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        createLink(ndb, { source_id: a.id, target_id: b.id, type_id: 'lt1' }, USER);
        const ac = createLink(ndb, { source_id: a.id, target_id: c.id, type_id: 'lt1' }, USER);

        ndb.useLayer(LAYER_A);
        assert.throws(
          () => updateLink(ndb, ac.id, { source_id: a.id, target_id: b.id }, undefined, USER),
          (err: unknown) => err instanceof EtnError && err.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('re-pointing a shadow that already lives in the layer: tombstone + a third id', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertSiblingLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);
        const c = createThought(ndb, { title: 'C' }, USER);
        const d = createThought(ndb, { title: 'D' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, USER);

        ndb.useLayer(LAYER_A);
        const second = updateLink(ndb, link.id, { source_id: a.id, target_id: c.id }, undefined, USER);
        const third = updateLink(ndb, second.id, { source_id: a.id, target_id: d.id }, undefined, USER);

        assert.notEqual(third.id, second.id);
        // Both previous identities are tombstones in the layer.
        assert.equal(linkRow(ndb, link.id, LAYER_A)!.deleted, 1);
        assert.equal(linkRow(ndb, second.id, LAYER_A)!.deleted, 1);
        assert.equal(getLink(ndb, third.id)!.target_id, d.id);
      } finally {
        ndb.close();
      }
    });
  },
);

void closeAll;
