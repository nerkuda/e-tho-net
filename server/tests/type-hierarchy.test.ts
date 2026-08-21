/**
 * Unit tests for the type hierarchy (L21): tree helpers, hierarchy-aware type
 * services (parenting rules, root protection, reparent/delete guards), the
 * effective property list with default-value overrides, subtree expansion of
 * type filters and the root-type assignment ban on thoughts/links.
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  assertLinkTypeAssignable,
  createLinkType,
  deleteLinkType,
  listLinkTypes,
  updateLinkType,
} from '../src/domain/link-type-service.js';
import {
  assertThoughtTypeAssignable,
  createThoughtType,
  deleteThoughtType,
  listThoughtTypes,
  updateThoughtType,
} from '../src/domain/thought-type-service.js';
import {
  createTypeProperty,
  listEffectiveTypeProperties,
  setPropertyValue,
  setTypePropertyDefaultOverride,
} from '../src/domain/property-service.js';
import {
  expandTypeIdsToSubtree,
  subtreeIds,
} from '../src/domain/type-hierarchy.js';

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
  'type hierarchy (L21)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('seeds a root type on migration and attaches new types under it', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const types = listThoughtTypes(ndb);
        const root = types.find((t) => t.is_root);
        assert.ok(root, 'root thought type seeded');
        assert.equal(root?.name, 'основной тип');

        const child = createThoughtType(ndb, { name: 'Персона' }, USER);
        assert.equal(child.parent_id, root!.id);
        assert.equal(child.is_root, false);

        // Link types get their own root.
        const linkRoot = listLinkTypes(ndb).find((t) => t.is_root);
        assert.ok(linkRoot, 'root link type seeded');
        const linkChild = createLinkType(ndb, { name_forward: 'a', name_reverse: 'b' }, USER);
        assert.equal(linkChild.parent_id, linkRoot!.id);
      } finally {
        ndb.close();
      }
    });

    it('rejects assigning the root type to a thought or a link', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const rootId = listThoughtTypes(ndb).find((t) => t.is_root)!.id;
        assert.throws(
          () => assertThoughtTypeAssignable(ndb, rootId),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        const linkRootId = listLinkTypes(ndb).find((t) => t.is_root)!.id;
        assert.throws(
          () => assertLinkTypeAssignable(ndb, linkRootId),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        assert.throws(
          () => assertThoughtTypeAssignable(ndb, 'missing-type'),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('enforces the 4-level nesting cap including the root', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThoughtType(ndb, { name: 'L2' }, USER);
        const b = createThoughtType(ndb, { name: 'L3', parent_id: a.id }, USER);
        const c = createThoughtType(ndb, { name: 'L4', parent_id: b.id }, USER);
        // A fourth level under the root (root → L2 → L3 → L4) is fine; one
        // more (L5) must be rejected.
        assert.throws(
          () => createThoughtType(ndb, { name: 'L5', parent_id: c.id }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('rejects cycles on reparenting', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThoughtType(ndb, { name: 'A' }, USER);
        const b = createThoughtType(ndb, { name: 'B', parent_id: a.id }, USER);
        assert.throws(
          () => updateThoughtType(ndb, a.id, { parent_id: b.id }, a.version),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('locks reparenting while thoughts still use the type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThoughtType(ndb, { name: 'A' }, USER);
        const b = createThoughtType(ndb, { name: 'B' }, USER);
        seedThought(ndb, b.id);
        assert.throws(
          () => updateThoughtType(ndb, b.id, { parent_id: a.id }, b.version),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('refuses to delete a type with subordinate types and the root', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = listThoughtTypes(ndb).find((t) => t.is_root)!;
        const parent = createThoughtType(ndb, { name: 'Родитель' }, USER);
        createThoughtType(ndb, { name: 'Ребёнок', parent_id: parent.id }, USER);
        assert.throws(
          () => deleteThoughtType(ndb, parent.id, parent.version),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        assert.throws(
          () => deleteThoughtType(ndb, root.id, root.version, { force: true }),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('collects the effective property list with inherited definitions and default overrides', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = listThoughtTypes(ndb).find((t) => t.is_root)!;
        const person = createThoughtType(ndb, { name: 'Персона' }, USER);
        const colleague = createThoughtType(ndb, { name: 'Коллега', parent_id: person.id }, USER);

        const rootProp = createTypeProperty(ndb, 'thought_type', root.id, {
          key: 'заметка',
          value_type: 'text',
        });
        const personProp = createTypeProperty(ndb, 'thought_type', person.id, {
          key: 'пол',
          value_type: 'text',
          config: { default_value: 'мужской' },
        });
        createTypeProperty(ndb, 'thought_type', colleague.id, { key: 'кабинет', value_type: 'text' });

        // Коллега sees its own + Персона's + root's properties.
        const effective = listEffectiveTypeProperties(ndb, 'thought_type', colleague.id);
        const keys = effective.map((d) => d.key).sort();
        assert.deepEqual(keys, ['заметка', 'кабинет', 'пол']);

        const inheritedGender = effective.find((d) => d.key === 'пол')!;
        assert.equal(inheritedGender.inherited, true);
        assert.equal(inheritedGender.default_value, 'мужской');
        assert.equal(inheritedGender.overridden_here, false);

        // Override the inherited default on Коллега.
        setTypePropertyDefaultOverride(ndb, 'thought_type', colleague.id, personProp.id, 'женский');
        const overridden = listEffectiveTypeProperties(ndb, 'thought_type', colleague.id).find(
          (d) => d.key === 'пол',
        )!;
        assert.equal(overridden.default_value, 'женский');
        assert.equal(overridden.overridden_here, true);

        // Clearing the override falls back to the definition's own default.
        setTypePropertyDefaultOverride(ndb, 'thought_type', colleague.id, personProp.id, null);
        const reset = listEffectiveTypeProperties(ndb, 'thought_type', colleague.id).find(
          (d) => d.key === 'пол',
        )!;
        assert.equal(reset.default_value, 'мужской');
        assert.equal(reset.overridden_here, false);

        // An own definition cannot be overridden (edit its config instead)…
        const ownCabinet = listEffectiveTypeProperties(ndb, 'thought_type', colleague.id).find(
          (d) => d.key === 'кабинет',
        )!;
        assert.throws(
          () =>
            setTypePropertyDefaultOverride(
              ndb,
              'thought_type',
              colleague.id,
              ownCabinet.id,
              'x',
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // …while a root-level property (an ancestor) can be overridden.
        setTypePropertyDefaultOverride(ndb, 'thought_type', colleague.id, rootProp.id, 'из коллеги');
        const rootOverridden = listEffectiveTypeProperties(ndb, 'thought_type', colleague.id).find(
          (d) => d.key === 'заметка',
        )!;
        assert.equal(rootOverridden.default_value, 'из коллеги');

        // An untyped thought's values resolve against the root's properties.
        const thoughtId = seedThought(ndb, null);
        setPropertyValue(ndb, 'thought', thoughtId, 'заметка', 'из корня');
        assert.equal(ndb.prepare('SELECT value_text AS v FROM property_values').get().v, 'из корня');
      } finally {
        ndb.close();
      }
    });

    it('rejects duplicate property keys inside the ancestor chain / subtree', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'Родитель' }, USER);
        const child = createThoughtType(ndb, { name: 'Ребёнок', parent_id: parent.id }, USER);
        createTypeProperty(ndb, 'thought_type', parent.id, { key: 'пол', value_type: 'text' });
        assert.throws(
          () => createTypeProperty(ndb, 'thought_type', child.id, { key: 'пол', value_type: 'text' }),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
        // …and in the other direction: a child's key cannot appear on an ancestor.
        assert.throws(
          () => createTypeProperty(ndb, 'thought_type', parent.id, { key: 'пол', value_type: 'text' }),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('expands type filters to whole subtrees (thought and link types)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThoughtType(ndb, { name: 'A' }, USER);
        const b = createThoughtType(ndb, { name: 'B', parent_id: a.id }, USER);
        const c = createThoughtType(ndb, { name: 'C', parent_id: b.id }, USER);
        const expanded = expandTypeIdsToSubtree(ndb, 'thought_types', [a.id]);
        assert.deepEqual(new Set(expanded), new Set([a.id, b.id, c.id]));
        assert.deepEqual(subtreeIds(ndb, 'thought_types', b.id).sort(), [b.id, c.id].sort());
        // Unknown ids survive (they match nothing, filters stay restrictive).
        assert.deepEqual(expandTypeIdsToSubtree(ndb, 'thought_types', ['zzz']), ['zzz']);
        // Empty stays empty.
        assert.deepEqual(expandTypeIdsToSubtree(ndb, 'thought_types', []), []);
      } finally {
        ndb.close();
      }
    });

    it('link types inherit line style along the chain', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = listLinkTypes(ndb).find((t) => t.is_root)!;
        // The root resolves the application defaults.
        assert.equal(root.style, null);
        assert.equal(root.width, null);

        const parent = createLinkType(
          ndb,
          { name_forward: 'a', name_reverse: 'b', style: 'dashed', width: 3, color: '#111111' },
          USER,
        );
        const child = createLinkType(
          ndb,
          { name_forward: 'c', name_reverse: 'd', parent_id: parent.id },
          USER,
        );
        // Unset fields inherit: the child's own style/width are null.
        assert.equal(child.style, null);
        assert.equal(child.width, null);
        assert.equal(child.color, null);
        assert.equal(child.parent_id, parent.id);

        // Setting a null style on the parent restores «inherit» (from root).
        const reset = updateLinkType(ndb, parent.id, { style: null }, parent.version);
        assert.equal(reset.style, null);
      } finally {
        ndb.close();
      }
    });

    it('link-type hierarchy guards mirror the thought-type ones', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createLinkType(ndb, { name_forward: 'a', name_reverse: 'b' }, USER);
        const b = createLinkType(
          ndb,
          { name_forward: 'c', name_reverse: 'd', parent_id: a.id },
          USER,
        );
        assert.throws(
          () => updateLinkType(ndb, a.id, { parent_id: b.id }, a.version),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // Deleting a type with children is rejected.
        assert.throws(
          () => deleteLinkType(ndb, a.id, a.version),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('caps the tree depth at MAX_TYPE_DEPTH for link types too', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createLinkType(ndb, { name_forward: 'l2a', name_reverse: 'l2b' }, USER);
        const b = createLinkType(
          ndb,
          { name_forward: 'l3a', name_reverse: 'l3b', parent_id: a.id },
          USER,
        );
        const c = createLinkType(
          ndb,
          { name_forward: 'l4a', name_reverse: 'l4b', parent_id: b.id },
          USER,
        );
        assert.throws(
          () =>
            createLinkType(
              ndb,
              { name_forward: 'l5a', name_reverse: 'l5b', parent_id: c.id },
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
