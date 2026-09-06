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

import { EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import {
  createTypeProperty,
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
        createTypeProperty(ndb, 'thought_type', type.id, {
          key: 'см. также',
          value_type: 'thought_ref',
        }, USER);
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
        createTypeProperty(ndb, 'thought_type', type.id, { key: 'исполнитель', value_type: 'thought_ref' }, USER);
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
            const { purged, skipped } = purgeTrash(ndb);
            return { purged, skipped };
          })(),
          { purged: 0, skipped: 1 },
        );

        // Unblock and purge.
        clearThoughtRefUsages(ndb, target.id);
        assert.deepEqual(
          (() => {
            const { purged, skipped } = purgeTrash(ndb);
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
            const { purged, skipped } = purgeTrash(ndb);
            return { purged, skipped };
          })(),
          { purged: 1, skipped: 0 },
        );
        assert.equal(listTrash(ndb).links.length, 0);
      } finally {
        ndb.close();
      }
    });
  },
);
