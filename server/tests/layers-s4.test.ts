/**
 * Tests for the application-level delete cascade and tombstones (task S4,
 * docs/13-layers.md §5.2–§5.3):
 *
 * - deleting a thought in a layer materialises tombstones over its whole
 *   dependent subtree (links both ways, comments, attachments, property
 *   values, synonyms) and hides the entity in that layer and its descendants,
 *   while the base row and every other layer stay intact — "удаление в слое
 *   не видно в основе";
 * - children are NOT deleted: the cascade hits link rows, the child thought
 *   survives but loses the parent link;
 * - a link whose endpoint is tombstoned in the layer's chain is invisible by
 *   itself (no dangling edges), even when the link row itself is untouched;
 * - physical deletion in the base (the trash path) is blocked by a live layer
 *   shadow, proceeds after the layer tombstones it, and leaves no dangling
 *   rows in any layer — "удаление в основе не оставляет висячих строк в слоях";
 * - a shared attachment file is only removed from disk once no live binding in
 *   ANY layer references it — "файл жив, пока есть ссылки" (§5.3);
 * - version rules of §5.1–§5.2: a tombstone/shadow carries the ancestor's
 *   version as `base_version`, the edit bumps `version`, repeated deletion is
 *   a no-op, and a base-layer edit never rewrites a layer's shadow row.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { closeAll, createInMemoryNetworkDb, openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { deleteAttachment, createAttachment, getAttachment } from '../src/domain/attachment-service.js';
import { getPermanentPreview, listComments } from '../src/domain/comment-service.js';
import { checkLinkDeletion, deleteLink, getLink } from '../src/domain/link-service.js';
import {
  checkThoughtDeletion,
  createThought,
  deleteThought,
  getNeighbors,
  getThought,
  updateThought,
} from '../src/domain/thought-service.js';
import { listTrash, purgeTrash } from '../src/domain/trash-service.js';

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

/** The layer ids of the three-level hierarchy (base → A → B). */
const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_B = '22222222-2222-4222-8222-222222222222';

/** Seed `layers` with A (child of base) and B (child of A). */
function insertHierarchyLayers(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  const ins = ndb.prepare(
    `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
     VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
  );
  ins.run(LAYER_A, BASE_LAYER_ID, 'Слой A', 1, now, now);
  ins.run(LAYER_B, LAYER_A, 'Слой B', 2, now, now);
}

/** Physical row of a thought (id, layer) — raw SQL, direct table access. */
function thoughtRow(ndb: NetworkDb, id: string, layerId: string) {
  return ndb
    .prepare('SELECT title, deleted, base_version, version FROM thoughts WHERE id = ? AND layer_id = ?')
    .get(id, layerId) as
    | { title: string; deleted: number; base_version: number; version: number }
    | undefined;
}

describe(
  'layers S4 — tombstone cascade of a thought deletion in a layer',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('hides the whole dependent subtree in the layer and its descendants; base stays intact', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        // All base data is created in the base context (S4: writes follow the
        // connection's layer).
        const parent = createThought(ndb, { title: 'Родитель', synonyms: ['предок'] }, USER);
        const child = createThought(ndb, { title: 'Ребёнок' }, USER);
        const linkId = 'l-parent-child';
        const now = new Date().toISOString();
        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, active, version,
               created_at, updated_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, 1, 1, ?, ?, 'u', 'u')`,
          )
          .run(linkId, BASE_LAYER_ID, parent.id, child.id, now, now);
        // Permanent comment + url attachment owned by the parent thought.
        ndb
          .prepare(
            `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, body_md, body_html, valid_from, version,
               created_at, updated_at, created_by, updated_by)
             VALUES ('cm-parent', ?, 'thought', ?, 'permanent', 'текст', 'текст', ?, 1, ?, ?, 'u', 'u')`,
          )
          .run(BASE_LAYER_ID, parent.id, now, now, now);
        ndb
          .prepare(
            `INSERT INTO comment_targets (comment_id, owner_type, owner_id, layer_id)
             VALUES ('cm-parent', 'thought', ?, ?)`,
          )
          .run(parent.id, BASE_LAYER_ID);
        ndb
          .prepare(
            `INSERT INTO attachments (id, layer_id, owner_type, owner_id, kind, url, position, created_at, created_by)
             VALUES ('att-parent', ?, 'thought', ?, 'url', 'https://example.com/x', 0, ?, 'u')`,
          )
          .run(BASE_LAYER_ID, parent.id, now);

        // Delete the parent in layer A.
        ndb.useLayer(LAYER_A);
        deleteThought(ndb, parent.id, undefined, USER);

        // In A: the thought, its link, comment and attachment are all hidden;
        // the child survives but loses the parent from its parents zone.
        assert.equal(getThought(ndb, parent.id), null);
        assert.equal(getLink(ndb, linkId), null);
        assert.equal(getPermanentPreview(ndb, 'thought', parent.id), null);
        assert.deepEqual(listComments(ndb, 'thought', parent.id), []);
        assert.equal(getAttachment(ndb, 'att-parent'), null);
        assert.notEqual(getThought(ndb, child.id), null);
        assert.deepEqual(getNeighbors(ndb, child.id, 'parents').map((n) => n.id), []);

        // In B (descendant of A): the tombstone is inherited — hidden too.
        ndb.useLayer(LAYER_B);
        assert.equal(getThought(ndb, parent.id), null);
        assert.equal(getLink(ndb, linkId), null);

        // Physical rows: the base rows are alive, A carries tombstones.
        assert.deepEqual(thoughtRow(ndb, parent.id, BASE_LAYER_ID), {
          title: 'Родитель',
          deleted: 0,
          base_version: 0,
          version: 1,
        });
        assert.deepEqual(thoughtRow(ndb, parent.id, LAYER_A), {
          title: 'Родитель',
          deleted: 1,
          base_version: 1,
          version: 2,
        });
        const linkA = ndb
          .prepare('SELECT deleted, base_version, version FROM links WHERE id = ? AND layer_id = ?')
          .get(linkId, LAYER_A) as { deleted: number; base_version: number; version: number };
        assert.deepEqual(linkA, { deleted: 1, base_version: 1, version: 2 });
        const commentA = ndb
          .prepare('SELECT deleted FROM comments WHERE id = ? AND layer_id = ?')
          .get('cm-parent', LAYER_A) as { deleted: number };
        assert.equal(commentA.deleted, 1);
        const attA = ndb
          .prepare('SELECT deleted FROM attachments WHERE id = ? AND layer_id = ?')
          .get('att-parent', LAYER_A) as { deleted: number };
        assert.equal(attA.deleted, 1);
        // The synonym row got a tombstone too (FTS of the layer follows suit).
        const synA = ndb
          .prepare('SELECT deleted FROM thought_synonyms WHERE thought_id = ? AND layer_id = ?')
          .get(parent.id, LAYER_A) as { deleted: number };
        assert.equal(synA.deleted, 1);

        // In the base: everything is still visible and alive.
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getThought(ndb, parent.id), null);
        assert.notEqual(getLink(ndb, linkId), null);
        assert.notEqual(getPermanentPreview(ndb, 'thought', parent.id), null);
        assert.equal(getNeighbors(ndb, child.id, 'parents').length, 1);
        assert.deepEqual(
          getNeighbors(ndb, child.id, 'parents').map((n) => n.id),
          [parent.id],
        );

        // A deletion in a descendant (B) does not affect A: B sees its own
        // tombstone chain, A is untouched by it.
        ndb.useLayer(BASE_LAYER_ID);
        const other = createThought(ndb, { title: 'Другая' }, USER);
        ndb.useLayer(LAYER_B);
        deleteThought(ndb, other.id, undefined, USER);
        assert.equal(getThought(ndb, other.id), null);
        ndb.useLayer(LAYER_A);
        assert.notEqual(getThought(ndb, other.id), null);
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getThought(ndb, other.id), null);
      } finally {
        ndb.close();
      }
    });

    it('a link with a tombstoned endpoint is invisible by itself (no dangling edges)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const x = createThought(ndb, { title: 'X' }, USER);
        const y = createThought(ndb, { title: 'Y' }, USER);
        const now = new Date().toISOString();
        // A link whose target is Y; the link row itself is never touched below.
        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, active, version,
               created_at, updated_at, created_by, updated_by)
             VALUES ('l-xy', ?, ?, ?, 1, 1, ?, ?, 'u', 'u')`,
          )
          .run(BASE_LAYER_ID, x.id, y.id, now, now);

        // Tombstone Y in layer B with raw SQL (isolation: the view filter must
        // hold even when the endpoint tombstone did NOT come from the cascade).
        ndb
          .prepare(
            `INSERT INTO thoughts (id, layer_id, title, title_norm, active, deleted, version,
               created_at, created_by, updated_at, updated_by)
             SELECT id, ?, title, title_norm, active, 1, version + 1, created_at, created_by, updated_at, updated_by
             FROM thoughts WHERE id = ? AND layer_id = ?`,
          )
          .run(LAYER_B, y.id, BASE_LAYER_ID);

        ndb.useLayer(LAYER_B);
        // The link is hidden by the invisible endpoint, not by its own row.
        assert.equal(getLink(ndb, 'l-xy'), null);
        assert.deepEqual(
          ndb.prepare('SELECT id FROM links_v').all(),
          [],
        );
        assert.deepEqual(getNeighbors(ndb, x.id, 'children').map((n) => n.id), []);

        // Deleting the endpoint through the service produces the same picture
        // (cascade tombstones the link as well — both arms agree).
        ndb.useLayer(BASE_LAYER_ID);
        const z = createThought(ndb, { title: 'Z' }, USER);
        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, active, version,
               created_at, updated_at, created_by, updated_by)
             VALUES ('l-xz', ?, ?, ?, 1, 1, ?, ?, 'u', 'u')`,
          )
          .run(BASE_LAYER_ID, x.id, z.id, now, now);
        ndb.useLayer(LAYER_A);
        deleteThought(ndb, z.id, undefined, USER);
        assert.equal(getLink(ndb, 'l-xz'), null);

        // In the base both links are alive (no endpoint is hidden there).
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getLink(ndb, 'l-xy'), null);
        assert.notEqual(getLink(ndb, 'l-xz'), null);
      } finally {
        ndb.close();
      }
    });

    it('physical deletion in the base: blocked by a live layer shadow, sweep after tombstoning', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const m = createThought(ndb, { title: 'M' }, USER);
        const n = createThought(ndb, { title: 'N' }, USER);
        const now = new Date().toISOString();
        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, active, version,
               created_at, updated_at, created_by, updated_by)
             VALUES ('l-mn', ?, ?, ?, 1, 1, ?, ?, 'u', 'u')`,
          )
          .run(BASE_LAYER_ID, m.id, n.id, now, now);

        // A live shadow of the link in layer A (materialised by an edit).
        ndb.useLayer(LAYER_A);
        ndb
          .prepare(
            `INSERT INTO links (id, layer_id, source_id, target_id, active, version, base_version,
               created_at, updated_at, created_by, updated_by)
             SELECT id, ?, source_id, target_id, active, version + 1, version, created_at, updated_at, created_by, updated_by
             FROM links WHERE id = ? AND layer_id = ?`,
          )
          .run(LAYER_A, 'l-mn', BASE_LAYER_ID);

        // Base context: the physical deletion of M is blocked (02 §3.1.2 п.3).
        ndb.useLayer(BASE_LAYER_ID);
        const blocked = checkThoughtDeletion(ndb, m.id);
        assert.equal(blocked.blocked, true);
        assert.equal(blocked.blocking.layers.length, 1);
        assert.equal(blocked.blocking.layers[0]?.id, LAYER_A);
        assert.throws(
          () => deleteThought(ndb, m.id, undefined, USER),
          /used in properties or held by a layer/,
        );

        // The layer drops its shadow (deleting the link in A tombstones it;
        // the layer path needs no blocking check of its own).
        ndb.useLayer(LAYER_A);
        deleteLink(ndb, 'l-mn', undefined);

        // Now the physical deletion succeeds and leaves no dangling rows in
        // any layer: base rows AND layer tombstones/shadows are gone.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(checkThoughtDeletion(ndb, m.id).blocked, false);
        deleteThought(ndb, m.id, undefined, USER);
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS c FROM thoughts WHERE id = ?').get(m.id) as { c: number }).c,
          0,
        );
        assert.equal(
          (ndb.prepare('SELECT COUNT(*) AS c FROM links WHERE id = ?').get('l-mn') as { c: number }).c,
          0,
        );
        ndb.useLayer(LAYER_A);
        assert.equal(getThought(ndb, m.id), null);
        assert.equal(getLink(ndb, 'l-mn'), null);
      } finally {
        ndb.close();
      }
    });

    it('trash interplay: marking in a layer stays in the layer; purge in a layer skips base-held rows', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const t = createThought(ndb, { title: 'Корзинная' }, USER);

        // Mark for deletion in layer A (S13 flag is a plain field — S4
        // materialises the shadow row so the flag stays in the layer).
        ndb.useLayer(LAYER_A);
        updateThought(ndb, t.id, { marked_for_deletion: true }, undefined, USER);
        assert.equal(getThought(ndb, t.id)?.marked_for_deletion, true);
        assert.equal(listTrash(ndb).thoughts.length, 1);

        // The base row is unmarked and not in the base's trash.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getThought(ndb, t.id)?.marked_for_deletion, false);
        assert.equal(listTrash(ndb).thoughts.length, 0);
        assert.notEqual(getThought(ndb, t.id), null);

        // Purge in the layer is layer-aware (bug 0.5.4): the base-held row is
        // skipped (a «delete» there would only be a tombstone — marking is the
        // only allowed step), a layer-only row is tombstoned. The base keeps
        // both: its own row untouched, the layer-only row never existed there.
        ndb.useLayer(LAYER_A);
        const only = createThought(ndb, { title: 'Только в слое' }, USER);
        updateThought(ndb, only.id, { marked_for_deletion: true }, undefined, USER);
        const outcome = purgeTrash(ndb);
        assert.equal(outcome.purged, 1);
        assert.equal(outcome.skipped, 1);
        assert.equal(getThought(ndb, only.id), null);
        assert.equal(getThought(ndb, t.id)?.marked_for_deletion, true);
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getThought(ndb, t.id), null);
        assert.equal(getThought(ndb, only.id), null);
      } finally {
        ndb.close();
      }
    });

    it('version rules (§5.1–§5.2): shadow carries the ancestor version, edits bump, base edits do not touch shadows', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const t = createThought(ndb, { title: 'Версия' }, USER);
        assert.equal(thoughtRow(ndb, t.id, BASE_LAYER_ID)?.version, 1);

        // First edit in layer A: shadow materialised with the ancestor's
        // version as base_version, version bumped by the edit itself.
        ndb.useLayer(LAYER_A);
        updateThought(ndb, t.id, { title: 'Версия в слое' }, 1, USER);
        const shadow = thoughtRow(ndb, t.id, LAYER_A);
        assert.deepEqual(
          { title: shadow?.title, deleted: shadow?.deleted, base_version: shadow?.base_version, version: shadow?.version },
          { title: 'Версия в слое', deleted: 0, base_version: 1, version: 2 },
        );
        assert.equal(getThought(ndb, t.id)?.version, 2);

        // A base edit does not rewrite the shadow (its frozen state survives).
        ndb.useLayer(BASE_LAYER_ID);
        updateThought(ndb, t.id, { title: 'Версия в основе' }, 1, USER);
        assert.equal(thoughtRow(ndb, t.id, LAYER_A)?.title, 'Версия в слое');
        assert.equal(thoughtRow(ndb, t.id, LAYER_A)?.base_version, 1);
        // The base row itself was updated.
        assert.equal(thoughtRow(ndb, t.id, BASE_LAYER_ID)?.title, 'Версия в основе');
        assert.equal(thoughtRow(ndb, t.id, BASE_LAYER_ID)?.version, 2);

        // Deleting in the layer tombstones the shadow: version +1 again,
        // base_version untouched. A repeated deletion is a no-op: the entity
        // is already invisible in this layer (NOT_FOUND), and the row state
        // has not changed.
        ndb.useLayer(LAYER_B);
        deleteThought(ndb, t.id, undefined, USER);
        const tomb = thoughtRow(ndb, t.id, LAYER_B);
        assert.deepEqual(
          { deleted: tomb?.deleted, base_version: tomb?.base_version, version: tomb?.version },
          { deleted: 1, base_version: 2, version: 3 },
        );
        assert.throws(() => deleteThought(ndb, t.id, undefined, USER), /not found/);
        assert.deepEqual(thoughtRow(ndb, t.id, LAYER_B), tomb);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'layers S4 — attachment files: shared by all layers, refcounted over live rows',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDataDir: string;

    before(() => {
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-layers4-'));
    });

    after(() => {
      closeAll();
      if (tmpDataDir) {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      }
    });

    it('deleting in a layer keeps the file; the file dies with the last live reference', () => {
      const networkId = randomUUID();
      const ndbBase = openNetworkDb(tmpDataDir, networkId);
      try {
        insertHierarchyLayers(ndbBase);
        const a = createThought(ndbBase, { title: 'A' }, 'u');
        const b = createThought(ndbBase, { title: 'B' }, 'u');

        // A server-stored file inside the network's attachments/ directory,
        // referenced by TWO attachment rows (the second via the same path).
        const dir = path.join(path.dirname(ndbBase.dbPath), 'attachments');
        mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `doc-${randomUUID().slice(0, 8)}.txt`);
        writeFileSync(filePath, 'payload');
        const att1 = createAttachment(
          ndbBase,
          'thought',
          a.id,
          { kind: 'file', file_path: filePath },
          'u',
        );
        const att2 = createAttachment(
          ndbBase,
          'thought',
          b.id,
          { kind: 'file', file_path: filePath },
          'u',
        );

        // Deleting att1 in layer A tombstones the binding only — the file
        // survives (att2 + the base row of att1 still reference it).
        const ndbA = openNetworkDb(tmpDataDir, networkId, undefined, LAYER_A);
        deleteAttachment(ndbA, att1.id);
        assert.equal(getAttachment(ndbA, att1.id), null);
        assert.equal(existsSync(filePath), true);
        // The base still sees both bindings.
        assert.notEqual(getAttachment(ndbBase, att1.id), null);
        assert.notEqual(getAttachment(ndbBase, att2.id), null);

        // Physical delete of att1 in the base: att2 keeps the file alive.
        deleteAttachment(ndbBase, att1.id);
        assert.equal(existsSync(filePath), true);

        // A tombstoned binding (layer A) does not pin the file either: with
        // att2 physically gone, no live row references the file in any layer.
        deleteAttachment(ndbBase, att2.id);
        assert.equal(existsSync(filePath), false);
      } finally {
        closeAll();
      }
    });
  },
);
