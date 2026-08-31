/**
 * Context-aware deletion-check in working layers (bug 0.5.4: a thought added
 * in a layer blocked its own «Удалить совсем»; docs/03-server-api.md §6.5a).
 *
 * The session's own shadow row is the very row being deleted, so it must not
 * hold; a live base row, on the other hand, must hold when the check runs in
 * a working layer — the «delete» there is only a tombstone (13-layers.md
 * §5.2), and the dialog must offer marking instead. The base-context check
 * keeps its pre-layer behaviour: any live shadow in a non-base layer blocks.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createLink, checkLinkDeletion } from '../src/domain/link-service.js';
import {
  checkThoughtDeletion,
  createThought,
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

const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_B = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();

/** Inserts two sibling working layers over the base. */
function insertLayers(ndb: NetworkDb): void {
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at, version)
       VALUES (?, ?, 'A', 0, 1, 'u', ?, ?, 1)`,
    )
    .run(LAYER_A, BASE_LAYER_ID, now, now);
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at, version)
       VALUES (?, ?, 'B', 0, 1, 'u', ?, ?, 1)`,
    )
    .run(LAYER_B, BASE_LAYER_ID, now, now);
}

describe(
  'deletion-check in working layers (0.5.4 bug)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('a thought created in the layer does not hold itself — «Удалить совсем» allowed', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        ndb.useLayer(LAYER_A);
        const t = createThought(ndb, { title: 'Только в слое' }, 'u');
        const check = checkThoughtDeletion(ndb, t.id);
        assert.equal(check.blocked, false);
        assert.equal(check.blocking.properties, 0);
        assert.deepEqual(check.blocking.layers, []);
      } finally {
        ndb.close();
      }
    });

    it('in a layer a thought with a live base row is blocked with «Основа»', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = createThought(ndb, { title: 'В основе' }, 'u');
        insertLayers(ndb);
        ndb.useLayer(LAYER_A);
        const check = checkThoughtDeletion(ndb, t.id);
        assert.equal(check.blocked, true);
        assert.deepEqual(check.blocking.layers, [{ id: BASE_LAYER_ID, title: 'Основа' }]);
      } finally {
        ndb.close();
      }
    });

    it('in a layer: another layer shadow + base row — both hold', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = createThought(ndb, { title: 'В основе' }, 'u');
        insertLayers(ndb);
        ndb.useLayer(LAYER_B);
        updateThought(ndb, t.id, { title: 'Правка в B' }, undefined, 'u'); // live shadow in B
        ndb.useLayer(LAYER_A);
        const check = checkThoughtDeletion(ndb, t.id);
        assert.equal(check.blocked, true);
        assert.deepEqual(check.blocking.layers, [
          { id: BASE_LAYER_ID, title: 'Основа' },
          { id: LAYER_B, title: 'B' },
        ]);
      } finally {
        ndb.close();
      }
    });

    it('base context keeps blocking on another layer shadow (no self-hold regression)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = createThought(ndb, { title: 'В основе' }, 'u');
        insertLayers(ndb);
        ndb.useLayer(LAYER_B);
        updateThought(ndb, t.id, { title: 'Правка в B' }, undefined, 'u');
        ndb.useLayer(BASE_LAYER_ID);
        const check = checkThoughtDeletion(ndb, t.id);
        assert.equal(check.blocked, true);
        assert.deepEqual(check.blocking.layers, [{ id: LAYER_B, title: 'B' }]);
      } finally {
        ndb.close();
      }
    });

    it('a link created in the layer does not hold itself', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThought(ndb, { title: 'A' }, 'u');
        const b = createThought(ndb, { title: 'B' }, 'u');
        insertLayers(ndb);
        ndb.useLayer(LAYER_A);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, 'u');
        const check = checkLinkDeletion(ndb, link.id);
        assert.equal(check.blocked, false);
        assert.deepEqual(check.blocking.layers, []);
      } finally {
        ndb.close();
      }
    });

    it('in a layer a link with a live base row is blocked with «Основа»', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThought(ndb, { title: 'A' }, 'u');
        const b = createThought(ndb, { title: 'B' }, 'u');
        const link = createLink(ndb, { source_id: a.id, target_id: b.id }, 'u');
        insertLayers(ndb);
        ndb.useLayer(LAYER_A);
        const check = checkLinkDeletion(ndb, link.id);
        assert.equal(check.blocked, true);
        assert.deepEqual(check.blocking.layers, [{ id: BASE_LAYER_ID, title: 'Основа' }]);
      } finally {
        ndb.close();
      }
    });

    it('purge in a layer: base-held marked row is skipped, layer-only row is deleted', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const baseThought = createThought(ndb, { title: 'Помечена в основе' }, 'u');
        updateThought(ndb, baseThought.id, { marked_for_deletion: true }, undefined, 'u');
        insertLayers(ndb);
        ndb.useLayer(LAYER_A);
        const layerThought = createThought(ndb, { title: 'Только в слое' }, 'u');
        updateThought(ndb, layerThought.id, { marked_for_deletion: true }, undefined, 'u');

        // The trash in the layer sees both, with the base-held one locked.
        const trash = listTrash(ndb);
        const byId = new Map(trash.thoughts.map((t) => [t.id, t]));
        assert.equal(byId.get(baseThought.id)?.blocked, true);
        assert.equal(byId.get(layerThought.id)?.blocked, false);

        const { purged, skipped } = purgeTrash(ndb);
        assert.equal(purged, 1);
        assert.equal(skipped, 1);
        assert.equal(getThought(ndb, layerThought.id), null); // tombstoned in A
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getThought(ndb, baseThought.id)?.marked_for_deletion, true);
        assert.equal(getThought(ndb, layerThought.id), null, 'layer-only row never existed in base');
      } finally {
        ndb.close();
      }
    });
  },
);
