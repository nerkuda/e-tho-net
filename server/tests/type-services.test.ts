/**
 * Unit tests for the thought-type and link-type services and the type-property
 * definitions API (task C5).
 *
 * Covers: type CRUD, unique-name/pair enforcement, the protective delete rule
 * (422 without force, nulling with force), and property definition
 * create/update/delete/reorder. Skipped entirely when the `better-sqlite3`
 * native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  createLinkType,
  deleteLinkType,
  getLinkType,
  listLinkTypes,
  updateLinkType,
} from '../src/domain/link-type-service.js';
import {
  createTypeProperty,
  deleteTypeProperty,
  getTypeProperty,
  listTypeProperties,
  reorderTypeProperties,
  setPropertyValue,
  updateTypeProperty,
} from '../src/domain/property-service.js';
import {
  createThoughtType,
  deleteThoughtType,
  getThoughtType,
  listThoughtTypes,
  updateThoughtType,
} from '../src/domain/thought-type-service.js';

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

/** Seed a thought row directly so we can attach a type to it. */
function seedThought(ndb: NetworkDb, typeId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024-01-01', 'u', '2024-01-01', 'u')`,
    )
    .run(id, 'T' + id.slice(0, 4), 't', typeId);
  return id;
}

describe(
  'type-services',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    describe('thought types', () => {
      it('creates, lists, updates and deletes a type; description persists', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Person', description: 'A human being' }, USER);
          assert.equal(tt.description, 'A human being');
          // The migration seeds the hierarchy root «основной тип» (L21), so
          // the catalogue holds root + Person.
          assert.equal(listThoughtTypes(ndb).length, 2);
          assert.equal(tt.parent_id, listThoughtTypes(ndb).find((t) => t.is_root)?.id ?? null);
          assert.equal(tt.is_root, false);

          const updated = updateThoughtType(
            ndb,
            tt.id,
            { name: 'People', bg_color: '#abc' },
            tt.version,
          );
          assert.equal(updated.name, 'People');
          assert.equal(updated.bg_color, '#abc');
          assert.equal(updated.version, 2);

          deleteThoughtType(ndb, tt.id, 2);
          assert.equal(getThoughtType(ndb, tt.id), null);
        } finally {
          ndb.close();
        }
      });

      it('rejects a duplicate name with DUPLICATE', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          createThoughtType(ndb, { name: 'X' }, USER);
          assert.throws(
            () => createThoughtType(ndb, { name: 'X' }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );
        } finally {
          ndb.close();
        }
      });

      it('rejects a duplicate name ignoring case; renames to a case-variant of itself', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Задача' }, USER);
          // `Тип` = `тип` = `ТИП` — lower/upper variants collide.
          assert.throws(
            () => createThoughtType(ndb, { name: 'задача' }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );
          assert.throws(
            () => createThoughtType(ndb, { name: '  ЗАДАЧА ' }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );
          // Renaming a type to a case-variant of its own name is allowed…
          const updated = updateThoughtType(ndb, tt.id, { name: 'задача' }, tt.version);
          assert.equal(updated.name, 'задача');
          // …but renaming onto another type's name (ignoring case) is not.
          createThoughtType(ndb, { name: 'Отчёт' }, USER);
          assert.throws(
            () => updateThoughtType(ndb, tt.id, { name: 'ОТЧЁТ' }, updated.version),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );
        } finally {
          ndb.close();
        }
      });

      it('refuses to delete a type in use without force, detaches with force', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Used' }, USER);
          const thoughtId = seedThought(ndb, tt.id);
          assert.throws(
            () => deleteThoughtType(ndb, tt.id, 1),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
          // Type still present.
          assert.ok(getThoughtType(ndb, tt.id));

          deleteThoughtType(ndb, tt.id, 1, { force: true, actorUserId: USER });
          assert.equal(getThoughtType(ndb, tt.id), null);
          // Thought's type_id nulled.
          const t = ndb.prepare('SELECT type_id FROM thoughts WHERE id = ?').get(thoughtId) as {
            type_id: string | null;
          };
          assert.equal(t.type_id, null);
        } finally {
          ndb.close();
        }
      });

      it('deleting a type cascades its property definitions and stored values', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Cascade' }, USER);
          createTypeProperty(ndb, 'thought_type', tt.id, { key: 'author', value_type: 'text' });
          const thoughtId = seedThought(ndb, tt.id);
          setPropertyValue(ndb, 'thought', thoughtId, 'author', 'Jane');

          deleteThoughtType(ndb, tt.id, 1, { force: true, actorUserId: USER });

          assert.equal(listTypeProperties(ndb, 'thought_type', tt.id).length, 0);
          const leftover = ndb.prepare('SELECT COUNT(*) AS c FROM property_values').get() as {
            c: number;
          };
          assert.equal(leftover.c, 0);
        } finally {
          ndb.close();
        }
      });
    });

    describe('link types', () => {
      it('creates and rejects a duplicate name pair', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          createLinkType(ndb, { name_forward: 'parent', name_reverse: 'child' }, USER);
          assert.throws(
            () => createLinkType(ndb, { name_forward: 'parent', name_reverse: 'child' }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );
          // Same forward, different reverse is allowed.
          assert.doesNotThrow(() =>
            createLinkType(ndb, { name_forward: 'parent', name_reverse: 'other' }, USER),
          );
          // Root link type (migration seed, L21) + the two created types.
          assert.equal(listLinkTypes(ndb).length, 3);
        } finally {
          ndb.close();
        }
      });

      it('rejects a duplicate name pair ignoring case; swapped pair is a new type', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          createLinkType(ndb, { name_forward: 'Родитель', name_reverse: 'Ребёнок' }, USER);
          assert.throws(
            () =>
              createLinkType(ndb, { name_forward: 'родитель', name_reverse: 'ребёнок' }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );
          // The pair is directional: swapping forward/reverse names is a new type.
          assert.doesNotThrow(() =>
            createLinkType(ndb, { name_forward: 'ребёнок', name_reverse: 'родитель' }, USER),
          );
        } finally {
          ndb.close();
        }
      });

      it('rejects an invalid style', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          assert.throws(
            () =>
              createLinkType(
                ndb,
                { name_forward: 'a', name_reverse: 'b', style: 'wavy' as never },
                USER,
              ),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });

      it('updates width/color and bumps version', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const lt = createLinkType(
            ndb,
            { name_forward: 'rel', name_reverse: 'rel-of', width: 1 },
            USER,
          );
          const updated = updateLinkType(ndb, lt.id, { width: 3, color: '#f00' }, lt.version);
          assert.equal(updated.width, 3);
          assert.equal(updated.color, '#f00');
          assert.equal(updated.version, 2);
        } finally {
          ndb.close();
        }
      });

      it('deletes with force detaches links', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const lt = createLinkType(ndb, { name_forward: 'f', name_reverse: 'r' }, USER);
          const a = seedThought(ndb);
          const b = seedThought(ndb);
          ndb
            .prepare(
              `INSERT INTO links (id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
               VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
            )
            .run(randomUUID(), a, b, lt.id);
          assert.throws(
            () => deleteLinkType(ndb, lt.id, 1),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
          deleteLinkType(ndb, lt.id, 1, { force: true });
          assert.equal(getLinkType(ndb, lt.id), null);
          const link = ndb.prepare('SELECT type_id FROM links').get() as { type_id: string | null };
          assert.equal(link.type_id, null);
        } finally {
          ndb.close();
        }
      });

      it('deleting a link type cascades its property definitions and values', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const lt = createLinkType(ndb, { name_forward: 'f', name_reverse: 'r' }, USER);
          createTypeProperty(ndb, 'link_type', lt.id, { key: 'weight', value_type: 'number' });
          const a = seedThought(ndb);
          const b = seedThought(ndb);
          const linkId = randomUUID();
          ndb
            .prepare(
              `INSERT INTO links (id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
               VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
            )
            .run(linkId, a, b, lt.id);
          setPropertyValue(ndb, 'link', linkId, 'weight', 5);

          deleteLinkType(ndb, lt.id, 1, { force: true });

          assert.equal(listTypeProperties(ndb, 'link_type', lt.id).length, 0);
          const leftover = ndb.prepare('SELECT COUNT(*) AS c FROM property_values').get() as {
            c: number;
          };
          assert.equal(leftover.c, 0);
        } finally {
          ndb.close();
        }
      });
    });

    describe('type properties', () => {
      it('creates, updates, reorders and deletes definitions', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Doc' }, USER);
          const p1 = createTypeProperty(ndb, 'thought_type', tt.id, {
            key: 'author',
            value_type: 'text',
          });
          const p2 = createTypeProperty(ndb, 'thought_type', tt.id, {
            key: 'year',
            value_type: 'number',
            required: true,
          });
          assert.equal(p1.position, 0);
          assert.equal(p2.position, 1);

          // Duplicate key rejected.
          assert.throws(
            () =>
              createTypeProperty(ndb, 'thought_type', tt.id, { key: 'author', value_type: 'text' }),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );

          // Update flips required and stores config as JSON.
          const updated = updateTypeProperty(ndb, p1.id, {
            required: true,
            config: { note: 'free-form author name' },
          });
          assert.equal(updated.required, true);
          assert.equal(updated.config?.note, 'free-form author name');

          // Reorder: year first.
          const reordered = reorderTypeProperties(ndb, 'thought_type', tt.id, [p2.id, p1.id]);
          assert.deepEqual(
            reordered.map((p) => p.key),
            ['year', 'author'],
          );

          deleteTypeProperty(ndb, p1.id);
          assert.equal(getTypeProperty(ndb, p1.id), null);
          assert.equal(listTypeProperties(ndb, 'thought_type', tt.id).length, 1);
        } finally {
          ndb.close();
        }
      });
    });
  },
);
