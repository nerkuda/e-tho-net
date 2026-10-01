/**
 * Unit tests for the mark-for-deletion / trash domain logic (task S13).
 *
 * Covers: the deletion check's "использование в свойствах" blocking arm and
 * orphaned-children report, the DELETE refusal, mark/restore, usage clearing,
 * and the trash list + purge. Layer-based holding (0.5.2) is out of scope here
 * — `blocking.layers` is expected to stay empty. Skipped when the
 * `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, BASE_LAYER_ID } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLayer } from '../src/domain/layer-service.js';
import {
  addShelfItem,
  createPublication,
  createShelf,
  getPublication,
  getShelf,
  listShelves,
  trashPublication,
  trashShelf,
  updatePublication,
} from '../src/domain/publication-service.js';
import { seedThoughtRefProperty } from './seed-thought-ref.js';
import {
  clearThoughtRefUsages,
  setPropertyValue,
} from '../src/domain/property-service.js';
import {
  checkThoughtDeletion,
  createThought,
  deleteThought,
  updateThought,
} from '../src/domain/thought-service.js';
import { checkLinkDeletion, createLink, updateLink } from '../src/domain/link-service.js';
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

// Test user for authorship columns (task 5ef8b5bb)
const USER = 'test-user';

describe(
  'trash-service (S13)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('blocks physical deletion while a thought_ref property references the thought', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Проект' }, 'u');
        seedThoughtRefProperty(ndb, 'thought_type', type.id, 'см. также', {}, USER);
        const a = createThought(ndb, { title: 'A' }, 'u');
        const b = createThought(ndb, { title: 'B', type_id: type.id }, 'u');
        setPropertyValue(ndb, 'thought', b.id, 'см. также', a.id, USER);

        const check = checkThoughtDeletion(ndb, a.id);
        assert.equal(check.blocked, true);
        assert.equal(check.blocking.properties, 1);
        assert.deepEqual(check.blocking.layers, []);

        assert.throws(
          () => deleteThought(ndb, a.id, undefined, USER),
          (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
        );
        // The thought survives the refused delete.
        assert.ok(updateThought(ndb, a.id, { title: 'A' }, undefined, 'u'));

        // Clearing the usage unblocks it.
        assert.equal(clearThoughtRefUsages(ndb, a.id), 1);
        assert.equal(checkThoughtDeletion(ndb, a.id).blocked, false);
      } finally {
        ndb.close();
      }
    });

    it('reports future orphans among children', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();
      try {
        const parent = createThought(ndb, { title: 'P' }, 'u');
        const child = createThought(ndb, { title: 'C' }, 'u');
        createLink(ndb, { source_id: parent.id, target_id: child.id }, 'u');

        assert.equal(checkThoughtDeletion(ndb, parent.id).orphaned_children, 1);

        // A second parent makes the child no longer an orphan.
        const other = createThought(ndb, { title: 'O' }, 'u');
        createLink(ndb, { source_id: other.id, target_id: child.id }, 'u');
        assert.equal(checkThoughtDeletion(ndb, parent.id).orphaned_children, 0);
      } finally {
        ndb.close();
      }
    });

    it('marks, lists and purges through the trash', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();
      try {
        const type = createThoughtType(ndb, { name: 'Задача' }, 'u');
        seedThoughtRefProperty(ndb, 'thought_type', type.id, 'исполнитель', {}, USER);
        const target = createThought(ndb, { title: 'T' }, 'u');
        const ref = createThought(ndb, { title: 'R', type_id: type.id }, 'u');
        setPropertyValue(ndb, 'thought', ref.id, 'исполнитель', target.id, USER);

        const marked = updateThought(ndb, target.id, { marked_for_deletion: true }, undefined, 'u');
        assert.equal(marked.marked_for_deletion, true);
        assert.ok(marked.marked_for_deletion_at !== null);

        const trash = listTrash(ndb);
        assert.equal(trash.thoughts.length, 1);
        assert.equal(trash.thoughts[0]!.id, target.id);
        assert.equal(trash.thoughts[0]!.blocked, true);

        // Blocked row is skipped, not an error.
        assert.deepEqual(
          (() => {
            const { purged, skipped } = purgeTrash(ndb).result;
            return { purged, skipped };
          })(),
          { purged: 0, skipped: 1 },
        );

        // Unblock and purge.
        clearThoughtRefUsages(ndb, target.id);
        assert.deepEqual(
          (() => {
            const { purged, skipped } = purgeTrash(ndb).result;
            return { purged, skipped };
          })(),
          { purged: 1, skipped: 0 },
        );
        assert.equal(listTrash(ndb).thoughts.length, 0);

        // Restoring clears the mark columns.
        const restored = updateThought(ndb, ref.id, { marked_for_deletion: false }, undefined, 'u');
        assert.equal(restored.marked_for_deletion, false);
        assert.equal(restored.marked_for_deletion_at, null);
      } finally {
        ndb.close();
      }
    });

    it('marks and purges links (never blocked before 0.5.2)', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();
      try {
        const src = createThought(ndb, { title: 'S' }, 'u');
        const dst = createThought(ndb, { title: 'D' }, 'u');
        const link = createLink(ndb, { source_id: src.id, target_id: dst.id }, 'u');

        const marked = updateLink(ndb, link.id, { marked_for_deletion: true }, undefined, 'u');
        assert.equal(marked.marked_for_deletion, true);

        assert.equal(checkLinkDeletion(ndb, link.id).blocked, false);

        const trash = listTrash(ndb);
        assert.equal(trash.links.length, 1);
        assert.equal(trash.links[0]!.id, link.id);

        assert.deepEqual(
          (() => {
            const { purged, skipped } = purgeTrash(ndb).result;
            return { purged, skipped };
          })(),
          { purged: 1, skipped: 0 },
        );
        assert.equal(listTrash(ndb).links.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('purges only the listed ids; unlisted/unmarked requested ids are skipped (8b4b7a7e)', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();
      try {
        const a = createThought(ndb, { title: 'A' }, 'u');
        const b = createThought(ndb, { title: 'B' }, 'u'); // purged; no links touch it
        const live = createThought(ndb, { title: 'live' }, 'u');
        const d = createThought(ndb, { title: 'D' }, 'u');
        // Both links avoid b, so deleting the thought cannot cascade them away.
        const linkKeep = createLink(ndb, { source_id: a.id, target_id: d.id }, 'u');
        const linkGone = createLink(ndb, { source_id: a.id, target_id: live.id }, 'u');
        updateThought(ndb, a.id, { marked_for_deletion: true }, undefined, 'u');
        updateThought(ndb, b.id, { marked_for_deletion: true }, undefined, 'u');
        updateLink(ndb, linkKeep.id, { marked_for_deletion: true }, undefined, 'u');
        updateLink(ndb, linkGone.id, { marked_for_deletion: true }, undefined, 'u');
        assert.equal(listTrash(ndb).thoughts.length, 2);
        assert.equal(listTrash(ndb).links.length, 2);

        // Targeted sweep: b + linkGone + one id that is not in the trash at all.
        const outcome = purgeTrash(ndb, [b.id, linkGone.id, live.id]).result;
        assert.equal(outcome.purged, 2);
        assert.equal(outcome.skipped, 1); // `live` is not marked
        assert.deepEqual(outcome.deleted_thought_ids, [b.id]);
        assert.deepEqual(outcome.deleted_link_ids, [linkGone.id]);

        // Everything unlisted survives the sweep.
        const rest = listTrash(ndb);
        assert.deepEqual(
          rest.thoughts.map((t) => t.id),
          [a.id],
        );
        assert.deepEqual(
          rest.links.map((l) => l.id),
          [linkKeep.id],
        );

        // A full purge afterwards still cleans the remainder.
        assert.equal(purgeTrash(ndb).result.purged, 2);
        assert.equal(listTrash(ndb).thoughts.length + listTrash(ndb).links.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('публикации и полки в корзине: список, блокировки, purge и видимость слоя', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();
      try {
        // --- основа: свободная публикация и пустая полка ---------------------
        const pub = createPublication(ndb, { title: 'Свободная' }, USER);
        const shelf = createShelf(ndb, { title: 'Полка' }, USER);
        trashPublication(ndb, pub.id, USER);
        trashShelf(ndb, shelf.id, USER);

        const trash = listTrash(ndb);
        const pubEntry = trash.publications.find((p) => p.id === pub.id);
        assert.ok(pubEntry !== undefined, 'публикация видна в корзине');
        assert.equal(pubEntry.blocked, false);
        assert.equal(pubEntry.blocking.properties, 0);
        const shelfEntry = trash.shelves.find((s) => s.id === shelf.id);
        assert.ok(shelfEntry !== undefined, 'полка видна в корзине');
        assert.equal(shelfEntry.blocked, false);
        assert.equal(shelfEntry.blocking.items, 0);
        // Пометка скрывает полку из библиотеки.
        assert.equal(listShelves(ndb).length, 0);

        const sweep = purgeTrash(ndb);
        assert.equal(sweep.result.purged, 2);
        assert.equal(sweep.result.skipped, 0);
        assert.deepEqual(sweep.result.deleted_publication_ids, [pub.id]);
        assert.deepEqual(sweep.result.deleted_shelf_ids, [shelf.id]);
        assert.ok(sweep.events?.some((e) => e.type === 'publication.purged'));
        assert.ok(sweep.events?.some((e) => e.type === 'shelf.deleted'));
        assert.equal(getPublication(ndb, pub.id), null);
        assert.equal(getShelf(ndb, shelf.id), null);

        // --- непустая полка блокирована --------------------------------------
        const pubOnShelf = createPublication(ndb, { title: 'На полке' }, USER);
        const busy = createShelf(ndb, { title: 'Занятая' }, USER);
        addShelfItem(ndb, busy.id, pubOnShelf.id, 1, USER);
        trashShelf(ndb, busy.id, USER);
        const busyEntry = listTrash(ndb).shelves.find((s) => s.id === busy.id);
        assert.equal(busyEntry?.blocked, true);
        assert.equal(busyEntry?.blocking.items, 1);
        // Публикация не помечена — переживает проход; полка остаётся помеченной
        // и по-прежнему не пуста.
        const sweep2 = purgeTrash(ndb);
        assert.notEqual(getShelf(ndb, busy.id), null);
        assert.ok(sweep2.result.skipped >= 1);

        // --- удерживающий слой блокирует purge в основе ----------------------
        const held = createPublication(ndb, { title: 'Удерживаемая' }, USER);
        const layer = createLayer(ndb, {
          parentId: BASE_LAYER_ID,
          title: 'Слой',
          createdBy: USER,
        });
        ndb.useLayer(layer.id);
        updatePublication(ndb, held.id, { subtitle: 'правка слоя' }, USER);
        ndb.useLayer(BASE_LAYER_ID);
        trashPublication(ndb, held.id, USER);

        const heldEntry = listTrash(ndb).publications.find((p) => p.id === held.id);
        assert.equal(heldEntry?.blocked, true);
        assert.ok((heldEntry?.blocking.layers.length ?? 0) >= 1);
        const sweep3 = purgeTrash(ndb, [held.id]);
        assert.equal(sweep3.result.purged, 0);
        assert.equal(sweep3.result.skipped, 1);
        assert.notEqual(getPublication(ndb, held.id), null);

        // --- в рабочем слое публикация заблокирована (purge только в основе) --
        ndb.useLayer(layer.id);
        const inLayer = createPublication(ndb, { title: 'Слоевая' }, USER);
        trashPublication(ndb, inLayer.id, USER);
        const layerEntry = listTrash(ndb).publications.find((p) => p.id === inLayer.id);
        assert.equal(layerEntry?.blocked, true);
        const sweep4 = purgeTrash(ndb, [inLayer.id]);
        assert.equal(sweep4.result.purged, 0);
        assert.equal(sweep4.result.skipped, 1);
        assert.notEqual(getPublication(ndb, inLayer.id), null);
      } finally {
        ndb.close();
      }
    });
  },
);
