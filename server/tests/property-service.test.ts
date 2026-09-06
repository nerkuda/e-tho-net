/**
 * Unit tests for the property-value API (task C6).
 *
 * Covers: resolution of a value through the owner's type, per-value_type
 * validation, the single-column write rule, thought_ref type enforcement, and
 * upsert/delete; the multiple `thought_ref` form (config.multiple — arrays of
 * ids stored as JSON in value_thought_ref). Skipped entirely when the
 * `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError, type PropertyDefinition } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  computeThoughtCardWarnings,
  createNetworkProperty,
  createTypeProperty,
  deleteNetworkProperty,
  deletePropertyValue,
  deleteTypeProperty,
  findThoughtUsage,
  getNetworkPropertyByName,
  getPropertyValues,
  getPropertyValuesResolved,
  listEffectiveTypeProperties,
  listNetworkProperties,
  setPropertyValue,
  setPropertyValues,
  setTypePropertyDefaultOverride,
  setTypePropertyDescriptionOverride,
  updateNetworkProperty,
  updateTypeProperty,
} from '../src/domain/property-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';

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

/** Seed a typed thought and return its id. */
function seedTypedThought(ndb: NetworkDb, typeId: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024-01-01', 'u', '2024-01-01', 'u')`,
    )
    .run(id, 'T', 't', typeId);
  return id;
}

describe(
  'property-service (values)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('writes each value only to its matching column', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Book' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'title', value_type: 'text' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'published', value_type: 'bool' }, USER);
        const thought = seedTypedThought(ndb, tt.id);

        setPropertyValue(ndb, 'thought', thought, 'title', 'Dune', USER);
        setPropertyValue(ndb, 'thought', thought, 'year', 1965, USER);
        setPropertyValue(ndb, 'thought', thought, 'published', true, USER);

        const row = ndb
          .prepare(
            'SELECT value_text, value_number, value_bool, value_date, value_thought_ref FROM property_values WHERE owner_id = ? AND property_id = (SELECT id FROM properties WHERE name = ?)',
          )
          .get(thought, 'year') as {
          value_text: string | null;
          value_number: number | null;
          value_bool: number | null;
          value_date: string | null;
          value_thought_ref: string | null;
        };
        assert.equal(row.value_number, 1965);
        assert.equal(row.value_text, null, 'only value_number populated');
        assert.equal(row.value_bool, null);
        assert.equal(row.value_date, null);
        assert.equal(row.value_thought_ref, null);

        const values = getPropertyValues(ndb, 'thought', thought);
        // values carry property_id, not key; the column test above already
        // proved the single-column rule for 'year'.
        assert.equal(values.length, 3);
      } finally {
        ndb.close();
      }
    });

    it('setPropertyValues writes a mixed set in one transaction (O2)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'BookSet' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'title', value_type: 'text' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'published', value_type: 'bool' }, USER);
        const thought = seedTypedThought(ndb, tt.id);

        const stored = setPropertyValues(ndb, 'thought', thought, {
          title: 'Dune',
          year: 1965,
          published: true,
        }, USER);
        assert.equal(stored.title?.value, 'Dune');
        assert.equal(stored.year?.value, 1965);
        assert.equal(stored.published?.value, true);

        const values = getPropertyValues(ndb, 'thought', thought);
        assert.equal(values.length, 3);
      } finally {
        ndb.close();
      }
    });

    it('setPropertyValues rolls back the whole set when one key is invalid (O2)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'AtomicSet' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'title', value_type: 'text' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' }, USER);
        const thought = seedTypedThought(ndb, tt.id);

        // 'year' gets a non-number → VALIDATION_ERROR; 'title' must also be absent.
        assert.throws(
          () =>
            setPropertyValues(ndb, 'thought', thought, {
              title: 'Dune',
              year: 'not-a-number' as unknown as number,
            }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );

        const values = getPropertyValues(ndb, 'thought', thought);
        assert.equal(values.length, 0, 'no value may survive the rollback');
      } finally {
        ndb.close();
      }
    });

    it('rejects a value of the wrong runtime type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'N' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'count', value_type: 'number' }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', thought, 'count', 'not-a-number', USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('returns NOT_FOUND when the property is not defined on the type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Plain' }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', thought, 'missing', 'x', USER),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('thought_ref enforces allowed_type_id from config', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const author = createThoughtType(ndb, { name: 'Author' }, USER);
        const book = createThoughtType(ndb, { name: 'Book2' }, USER);
        createTypeProperty(ndb, 'thought_type', book.id, {
          key: 'author',
          value_type: 'thought_ref',
          config: { allowed_type_id: author.id },
        }, USER);
        const goodAuthor = seedTypedThought(ndb, author.id);
        const wrongType = seedTypedThought(ndb, book.id);
        const bookThought = seedTypedThought(ndb, book.id);

        // Correct type passes.
        setPropertyValue(ndb, 'thought', bookThought, 'author', goodAuthor, USER);
        // Wrong type is rejected.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', bookThought, 'author', wrongType, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // Missing target is rejected.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', bookThought, 'author', 'no-such-thought', USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('thought_ref enforces the allowed_type_ids list from config', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const author = createThoughtType(ndb, { name: 'AuthorL' }, USER);
        const editor = createThoughtType(ndb, { name: 'EditorL' }, USER);
        const book = createThoughtType(ndb, { name: 'BookL' }, USER);
        createTypeProperty(ndb, 'thought_type', book.id, {
          key: 'author',
          value_type: 'thought_ref',
          config: { allowed_type_ids: [author.id, editor.id] },
        }, USER);
        const goodAuthor = seedTypedThought(ndb, author.id);
        const goodEditor = seedTypedThought(ndb, editor.id);
        const wrongType = seedTypedThought(ndb, book.id);
        const bookThought = seedTypedThought(ndb, book.id);

        // Both listed types pass.
        setPropertyValue(ndb, 'thought', bookThought, 'author', goodAuthor, USER);
        setPropertyValue(ndb, 'thought', bookThought, 'author', goodEditor, USER);
        // A type outside the list is rejected.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', bookThought, 'author', wrongType, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('thought_ref with an empty filter list accepts any type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const ta = createThoughtType(ndb, { name: 'AnyA' }, USER);
        const tb = createThoughtType(ndb, { name: 'AnyB' }, USER);
        createTypeProperty(ndb, 'thought_type', ta.id, {
          key: 'ref',
          value_type: 'thought_ref',
          config: { allowed_type_ids: [] },
        }, USER);
        const owner = seedTypedThought(ndb, ta.id);
        const other = seedTypedThought(ndb, tb.id);
        setPropertyValue(ndb, 'thought', owner, 'ref', other, USER);
        assert.equal(getPropertyValues(ndb, 'thought', owner)[0]!.value, other);
      } finally {
        ndb.close();
      }
    });

    it('getPropertyValuesResolved resolves thought_ref to {id, title} (N4)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const author = createThoughtType(ndb, { name: 'AuthorR' }, USER);
        const book = createThoughtType(ndb, { name: 'BookR' }, USER);
        createTypeProperty(ndb, 'thought_type', book.id, {
          key: 'author',
          value_type: 'thought_ref',
        }, USER);
        const authorThought = seedTypedThought(ndb, author.id);
        const bookThought = seedTypedThought(ndb, book.id);
        // A plain text value must pass through untouched.
        createTypeProperty(ndb, 'thought_type', book.id, { key: 'note', value_type: 'text' }, USER);
        setPropertyValue(ndb, 'thought', bookThought, 'author', authorThought, USER);
        setPropertyValue(ndb, 'thought', bookThought, 'note', 'hello', USER);

        const resolved = getPropertyValuesResolved(ndb, 'thought', bookThought);
        assert.equal(resolved.length, 2);
        const ref = resolved.find((v) => typeof v.value === 'object' && v.value !== null);
        const note = resolved.find((v) => v.value === 'hello');
        assert.deepEqual(ref?.value, { id: authorThought, title: 'T' });
        assert.equal(note?.value, 'hello');

        // A dangling reference (no SQL FK) resolves to title: null.
        const orphan = seedTypedThought(ndb, book.id);
        ndb
          .prepare(
            `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_thought_ref, updated_at)
             VALUES (?, 'thought', ?, ?, ?, '2024')`,
          )
          .run(randomUUID(), orphan, ref?.property_id, 'no-such-thought');
        const dangling = getPropertyValuesResolved(ndb, 'thought', orphan).find(
          (v) =>
            !Array.isArray(v.value) &&
            typeof v.value === 'object' &&
            v.value !== null &&
            'title' in v.value &&
            v.value.title === null,
        );
        assert.deepEqual(dangling?.value, { id: 'no-such-thought', title: null });
      } finally {
        ndb.close();
      }
    });

    it('upserts on repeated set and deletes', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Up' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'note', value_type: 'text' }, USER);
        const thought = seedTypedThought(ndb, tt.id);

        setPropertyValue(ndb, 'thought', thought, 'note', 'first', USER);
        setPropertyValue(ndb, 'thought', thought, 'note', 'second', USER);
        const values = getPropertyValues(ndb, 'thought', thought);
        assert.equal(values.length, 1);
        assert.equal(values[0]!.value, 'second');

        deletePropertyValue(ndb, 'thought', thought, 'note', USER);
        assert.equal(getPropertyValues(ndb, 'thought', thought).length, 0);
        assert.throws(
          () => deletePropertyValue(ndb, 'thought', thought, 'note', USER),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('stores url values in value_text and validates them as strings', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Site' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'site', value_type: 'url' }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', thought, 'site', 'https://example.com', USER);
        assert.equal(getPropertyValues(ndb, 'thought', thought)[0]!.value, 'https://example.com');
        assert.throws(
          () => setPropertyValue(ndb, 'thought', thought, 'site', 5, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('changing value_type converts fitting values and clears the rest', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Conv' }, USER);
        const prop = createTypeProperty(ndb, 'thought_type', tt.id, { key: 'num', value_type: 'text' }, USER);
        const a = seedTypedThought(ndb, tt.id);
        const b = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', a, 'num', '42', USER);
        setPropertyValue(ndb, 'thought', b, 'num', 'not-a-number', USER);

        updateTypeProperty(ndb, prop.id, { value_type: 'number' }, USER);
        const values = new Map(
          getPropertyValues(ndb, 'thought', a).concat(getPropertyValues(ndb, 'thought', b)).map((v) => [v.owner_id, v.value]),
        );
        assert.equal(values.get(a), 42);
        assert.equal(values.get(b), undefined); // cleared — not convertible
        assert.equal(getPropertyValues(ndb, 'thought', b).length, 0);
      } finally {
        ndb.close();
      }
    });

    it('renaming the key keeps stored values attached', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Rename' }, USER);
        const prop = createTypeProperty(ndb, 'thought_type', tt.id, { key: 'old', value_type: 'text' }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', thought, 'old', 'kept', USER);

        updateTypeProperty(ndb, prop.id, { key: 'new' }, USER);
        // The value is addressed by the new key and still there.
        assert.equal(getPropertyValues(ndb, 'thought', thought)[0]!.value, 'kept');
        assert.throws(
          () => setPropertyValue(ndb, 'thought', thought, 'old', 'x', USER),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('findThoughtUsage groups referencing thoughts by property (L7)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const person = createThoughtType(ndb, { name: 'Person' }, USER);
        const book = createThoughtType(ndb, { name: 'BookU' }, USER);
        createTypeProperty(ndb, 'thought_type', book.id, { key: 'author', value_type: 'thought_ref' }, USER);
        createTypeProperty(ndb, 'thought_type', book.id, { key: 'editor', value_type: 'thought_ref' }, USER);
        const target = seedTypedThought(ndb, person.id);
        const other = seedTypedThought(ndb, person.id);
        const b1 = seedTypedThought(ndb, book.id);
        const b2 = seedTypedThought(ndb, book.id);

        setPropertyValue(ndb, 'thought', b1, 'author', target, USER);
        setPropertyValue(ndb, 'thought', b2, 'author', target, USER);
        setPropertyValue(ndb, 'thought', b1, 'editor', target, USER);
        setPropertyValue(ndb, 'thought', b2, 'editor', other, USER);

        const usage = findThoughtUsage(ndb, target);
        assert.equal(usage.total, 3);
        assert.equal(usage.groups.length, 2);
        assert.deepEqual(
          usage.groups.map((g) => g.key),
          ['author', 'editor'],
          'groups sorted by property key',
        );
        const authorGroup = usage.groups[0]!;
        assert.deepEqual(
          authorGroup.thoughts.map((t) => t.id).sort(),
          [b1, b2].sort(),
        );
        const editorGroup = usage.groups[1]!;
        assert.equal(editorGroup.thoughts.length, 1);
        assert.equal(editorGroup.thoughts[0]!.id, b1);
        // Refs carry display fields for the client rows.
        assert.equal(authorGroup.thoughts[0]!.title, 'T');
        assert.equal(typeof authorGroup.property_id, 'string');

        // The other referenced thought sees only its own reference.
        const otherUsage = findThoughtUsage(ndb, other);
        assert.equal(otherUsage.total, 1);
        assert.equal(otherUsage.groups[0]!.key, 'editor');
        assert.equal(otherUsage.groups[0]!.thoughts[0]!.id, b2);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'property-service (multiple thought_ref)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    /** Seed a `multiple` thought_ref property and return def + thoughts. */
    function seedMulti(ndb: NetworkDb, config: Record<string, unknown> = {}): {
      def: PropertyDefinition;
      a: string;
      b: string;
      owner: string;
    } {
      const person = createThoughtType(ndb, { name: 'PersonM' }, USER);
      const book = createThoughtType(ndb, { name: 'BookM' }, USER);
      const def = createTypeProperty(ndb, 'thought_type', book.id, {
        key: 'authors',
        value_type: 'thought_ref',
        config: { multiple: true, ...config },
      }, USER);
      return {
        def,
        a: seedTypedThought(ndb, person.id),
        b: seedTypedThought(ndb, person.id),
        owner: seedTypedThought(ndb, book.id),
      };
    }

    /** Raw value_thought_ref of a property value row. */
    function rawRef(ndb: NetworkDb, ownerId: string, propertyId: string): string | null {
      const row = ndb
        .prepare(
          'SELECT value_thought_ref FROM property_values WHERE owner_id = ? AND property_id = ?',
        )
        .get(ownerId, propertyId) as { value_thought_ref: string | null };
      return row.value_thought_ref;
    }

    it('stores an id array as JSON and reads it back as string[]', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, b, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b], USER);
        assert.deepEqual(JSON.parse(rawRef(ndb, owner, def.property_id)!), [a, b]);
        const values = getPropertyValues(ndb, 'thought', owner);
        assert.deepEqual(values[0]!.value, [a, b]);
      } finally {
        ndb.close();
      }
    });

    it('dedupes ids and validates every id (existence + type filter)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const authorType = createThoughtType(ndb, { name: 'AuthorMM' }, USER);
        const bookType = createThoughtType(ndb, { name: 'BookMM' }, USER);
        const def = createTypeProperty(ndb, 'thought_type', bookType.id, {
          key: 'authors',
          value_type: 'thought_ref',
          config: { multiple: true, allowed_type_ids: [authorType.id] },
        }, USER);
        const good = seedTypedThought(ndb, authorType.id);
        const wrongType = seedTypedThought(ndb, bookType.id);
        const owner = seedTypedThought(ndb, bookType.id);

        // Duplicate ids collapse.
        setPropertyValue(ndb, 'thought', owner, 'authors', [good, good], USER);
        assert.deepEqual(JSON.parse(rawRef(ndb, owner, def.property_id)!), [good]);

        // A missing id rejects the whole write.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'authors', [good, 'no-such-thought'], USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // An id of a wrong (filtered-out) type rejects too.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'authors', [good, wrongType], USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // The last successful write is still in place.
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [good]);
      } finally {
        ndb.close();
      }
    });

    it('rejects arrays on definitions without config.multiple', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Single' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'ref', value_type: 'thought_ref' }, USER);
        const target = seedTypedThought(ndb, tt.id);
        const owner = seedTypedThought(ndb, tt.id);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'ref', [target], USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('normalizes a single id to a one-element array on multiple definitions', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', a, USER);
        assert.deepEqual(JSON.parse(rawRef(ndb, owner, def.property_id)!), [a]);
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [a]);
      } finally {
        ndb.close();
      }
    });

    it('treats an empty array as a clear', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', [a], USER);
        setPropertyValue(ndb, 'thought', owner, 'authors', [], USER);
        assert.equal(rawRef(ndb, owner, def.property_id), null);
      } finally {
        ndb.close();
      }
    });

    it('reads a legacy bare id as an array when multiple is on', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, owner } = seedMulti(ndb);
        // A pre-multiple row: a bare id in value_thought_ref.
        ndb
          .prepare(
            `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_thought_ref, updated_at)
             VALUES (?, 'thought', ?, ?, ?, '2024')`,
          )
          .run(randomUUID(), owner, def.property_id, a);
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [a]);
      } finally {
        ndb.close();
      }
    });

    it('resolves multiple values to [{id, title}] with dangling ids as title null', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, b, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b], USER);
        // Sneak a dangling id into the stored array (no SQL FK).
        ndb
          .prepare('UPDATE property_values SET value_thought_ref = ? WHERE owner_id = ? AND property_id = ?')
          .run(JSON.stringify([a, 'gone', b]), owner, def.property_id);

        const resolved = getPropertyValuesResolved(ndb, 'thought', owner);
        assert.deepEqual(resolved[0]!.value, [
          { id: a, title: 'T' },
          { id: 'gone', title: null },
          { id: b, title: 'T' },
        ]);
      } finally {
        ndb.close();
      }
    });

    it('findThoughtUsage matches ids stored inside multi arrays', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { a, b, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b], USER);

        const usageA = findThoughtUsage(ndb, a);
        assert.equal(usageA.total, 1);
        assert.equal(usageA.groups[0]!.key, 'authors');
        assert.equal(usageA.groups[0]!.thoughts[0]!.id, owner);

        // An id that merely prefixes another stored id must NOT match.
        const usage = findThoughtUsage(ndb, `${a}x`);
        assert.equal(usage.total, 0);
      } finally {
        ndb.close();
      }
    });

    it('converting value_type to text joins the ids with commas', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, b, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b], USER);
        updateTypeProperty(ndb, def.id, { value_type: 'text' }, USER);
        assert.equal(getPropertyValues(ndb, 'thought', owner)[0]!.value, `${a}, ${b}`);
      } finally {
        ndb.close();
      }
    });

    it('a required multi property with an (hand-made) empty array still warns', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'ReqMulti' }, USER);
        const def = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'refs',
          value_type: 'thought_ref',
          required: true,
          config: { multiple: true },
        }, USER);
        const target = seedTypedThought(ndb, tt.id);
        const owner = seedTypedThought(ndb, tt.id);
        // Hand-made empty array row (writes normalize empty to a clear).
        ndb
          .prepare(
            `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_thought_ref, updated_at)
             VALUES (?, 'thought', ?, ?, '[]', '2024')`,
          )
          .run(randomUUID(), owner, def.id);
        assert.equal(computeThoughtCardWarnings(ndb, owner).length, 1);
        // A filled array clears the warning.
        setPropertyValue(ndb, 'thought', owner, 'refs', [target], USER);
        assert.deepEqual(computeThoughtCardWarnings(ndb, owner), []);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'property-service (multiple url)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    /** Seed a `multiple` url property and return the definition + owner. */
    function seedMultiUrl(ndb: NetworkDb): {
      def: PropertyDefinition;
      owner: string;
    } {
      const tt = createThoughtType(ndb, { name: 'Bookmark' }, USER);
      const def = createTypeProperty(ndb, 'thought_type', tt.id, {
        key: 'sites',
        value_type: 'url',
        config: { multiple: true },
      }, USER);
      return { def, owner: seedTypedThought(ndb, tt.id) };
    }

    /** Raw value_text of a property value row. */
    function rawText(ndb: NetworkDb, ownerId: string, propertyId: string): string | null {
      const row = ndb
        .prepare('SELECT value_text FROM property_values WHERE owner_id = ? AND property_id = ?')
        .get(ownerId, propertyId) as { value_text: string | null };
      return row.value_text;
    }

    it('stores an array of URLs as JSON and reads it back as string[]', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, owner } = seedMultiUrl(ndb);
        setPropertyValue(ndb, 'thought', owner, 'sites', [
          'https://example.com',
          'https://docs.example.org',
        ], USER);
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.property_id)!), [
          'https://example.com',
          'https://docs.example.org',
        ]);
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [
          'https://example.com',
          'https://docs.example.org',
        ]);
      } finally {
        ndb.close();
      }
    });

    it('dedupes elements of the array', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, owner } = seedMultiUrl(ndb);
        setPropertyValue(ndb, 'thought', owner, 'sites', [
          'https://a.test',
          'https://a.test',
          'https://b.test',
        ], USER);
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.property_id)!), [
          'https://a.test',
          'https://b.test',
        ]);
      } finally {
        ndb.close();
      }
    });

    it('rejects arrays on definitions without config.multiple', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'SingleUrl' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'site',
          value_type: 'url',
        }, USER);
        const owner = seedTypedThought(ndb, tt.id);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'site', ['https://a.test'], USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('normalizes a single string to a one-element array on multiple definitions', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, owner } = seedMultiUrl(ndb);
        setPropertyValue(ndb, 'thought', owner, 'sites', 'https://only.test', USER);
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.property_id)!), ['https://only.test']);
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [
          'https://only.test',
        ]);
      } finally {
        ndb.close();
      }
    });

    it('treats an empty array as a clear', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, owner } = seedMultiUrl(ndb);
        setPropertyValue(ndb, 'thought', owner, 'sites', ['https://a.test'], USER);
        setPropertyValue(ndb, 'thought', owner, 'sites', [], USER);
        assert.equal(rawText(ndb, owner, def.property_id), null);
      } finally {
        ndb.close();
      }
    });

    it('reads a legacy bare string as an array when multiple is on', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, owner } = seedMultiUrl(ndb);
        // A pre-multiple row: a bare URL string in value_text.
        ndb
          .prepare(
            `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
             VALUES (?, 'thought', ?, ?, ?, '2024')`,
          )
          .run(randomUUID(), owner, def.property_id, 'https://legacy.test');
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [
          'https://legacy.test',
        ]);
      } finally {
        ndb.close();
      }
    });

    it('preserves a URL containing a comma end-to-end', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, owner } = seedMultiUrl(ndb);
        // A URL with an embedded comma — the JSON-array payload must keep it
        // intact, whereas a comma-joined `text` value would be ambiguous.
        const tricky = 'https://example.com/?a=1,b=2';
        setPropertyValue(ndb, 'thought', owner, 'sites', [tricky, 'https://plain.test'], USER);
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.property_id)!), [
          tricky,
          'https://plain.test',
        ]);
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [
          tricky,
          'https://plain.test',
        ]);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'computeThoughtCardWarnings (O6)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('returns no warnings for an untyped thought', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const thought = seedTypedThought(ndb, null as unknown as string);
        // Re-seed with NULL type_id — seedTypedThought hard-codes a type.
        ndb.prepare('DELETE FROM thoughts WHERE id = ?').run(thought);
        const id = randomUUID();
        ndb
          .prepare(
            `INSERT INTO thoughts (id, title, title_norm, active, version, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, 1, 1, '2024-01-01', 'u', '2024-01-01', 'u')`,
          )
          .run(id, 'T', 't');
        assert.deepEqual(computeThoughtCardWarnings(ndb, id), []);
      } finally {
        ndb.close();
      }
    });

    it('returns no warnings when the type has no required properties', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Note' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'body', value_type: 'text' }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        assert.deepEqual(computeThoughtCardWarnings(ndb, thought), []);
      } finally {
        ndb.close();
      }
    });

    it('lists required properties that have no stored value', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Issue' }, USER);
        const status = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'status',
          value_type: 'text',
          required: true,
        }, USER);
        const priority = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'priority',
          value_type: 'text',
          required: true,
        }, USER);
        const optional = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'description',
          value_type: 'text',
        }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        // Fill only `status`; `priority` must remain in the warning list.
        setPropertyValue(ndb, 'thought', thought, 'status', 'open', USER);

        const warnings = computeThoughtCardWarnings(ndb, thought);
        assert.equal(warnings.length, 1);
        const w = warnings[0]!;
        assert.equal(w.code, 'REQUIRED_PROPERTY_MISSING');
        assert.equal(w.key, 'priority');
        assert.equal(w.property_id, priority.property_id);
        assert.equal(w.value_type, 'text');
        assert.equal(w.inherited, false);
        assert.equal(w.defined_on, tt.id);
        // Reference for sanity: status was filled, optional is not required.
        assert.notEqual(status.id, priority.id);
        assert.notEqual(optional.id, priority.id);
      } finally {
        ndb.close();
      }
    });

    it('treats defaults (config.default_value / type_property_overrides) as not filled', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Task' }, USER);
        // A `required` property whose `config.default_value` is set — the
        // default applies to future values, not to the existing card; the
        // warning must still fire until the value is stored explicitly.
        createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'state',
          value_type: 'text',
          required: true,
          config: { default_value: 'new' },
        }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        const warnings = computeThoughtCardWarnings(ndb, thought);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]!.key, 'state');
      } finally {
        ndb.close();
      }
    });

    it('walks the L21 chain and reports inherited required properties (parent → child)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'IssueParent' }, USER);
        createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'owner',
          value_type: 'text',
          required: true,
        }, USER);
        const child = createThoughtType(ndb, { name: 'IssueChild', parent_id: parent.id }, USER);
        createTypeProperty(ndb, 'thought_type', child.id, {
          key: 'severity',
          value_type: 'number',
          required: true,
        }, USER);

        const thought = seedTypedThought(ndb, child.id);
        const warnings = computeThoughtCardWarnings(ndb, thought);
        const byKey = new Map(warnings.map((w) => [w.key, w]));
        assert.equal(warnings.length, 2);
        const owner = byKey.get('owner');
        assert.ok(owner !== undefined);
        assert.equal(owner!.defined_on, parent.id);
        assert.equal(owner!.inherited, true);
        const severity = byKey.get('severity');
        assert.ok(severity !== undefined);
        assert.equal(severity!.defined_on, child.id);
        assert.equal(severity!.inherited, false);

        // Filling the inherited gap clears it.
        setPropertyValue(ndb, 'thought', thought, 'owner', 'alice', USER);
        const after = computeThoughtCardWarnings(ndb, thought);
        assert.deepEqual(
          after.map((w) => w.key),
          ['severity'],
        );
      } finally {
        ndb.close();
      }
    });

    it('returns no warnings after every required property is filled', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Filled' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'flag',
          value_type: 'bool',
          required: true,
        }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        assert.equal(computeThoughtCardWarnings(ndb, thought).length, 1);
        setPropertyValue(ndb, 'thought', thought, 'flag', true, USER);
        assert.deepEqual(computeThoughtCardWarnings(ndb, thought), []);
      } finally {
        ndb.close();
      }
    });

    it('an empty string counts as filled (a deliberate value, not an unset one)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'EmptyString' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'note',
          value_type: 'text',
          required: true,
        }, USER);
        const thought = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', thought, 'note', '', USER);
        assert.deepEqual(computeThoughtCardWarnings(ndb, thought), []);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'property definitions: description (own + inherited + override)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('stores and returns the description of a definition (create + update)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'DescOwn' }, USER);
        const prop = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'path',
          value_type: 'text',
          description: '  путь от корня репозитория  ',
        }, USER);
        assert.equal(prop.description, 'путь от корня репозитория');

        const updated = updateTypeProperty(ndb, prop.id, { description: 'абсолютный путь' }, USER);
        assert.equal(updated.description, 'абсолютный путь');

        // A blank description normalizes back to null.
        const cleared = updateTypeProperty(ndb, prop.id, { description: '   ' }, USER);
        assert.equal(cleared.description, null);
      } finally {
        ndb.close();
      }
    });

    it('a child type inherits the description and can override it (description_overridden)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'DescParent' }, USER);
        const prop = createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'owner',
          value_type: 'text',
          description: 'кто отвечает за элемент',
        }, USER);
        const child = createThoughtType(ndb, { name: 'DescChild', parent_id: parent.id }, USER);

        // Inherited as-is: the effective description equals the definition's.
        let effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective.length, 1);
        assert.equal(effective[0]!.description, 'кто отвечает за элемент');
        assert.equal(effective[0]!.description_overridden, false);
        assert.equal(effective[0]!.inherited, true);
        assert.equal(effective[0]!.defined_on, parent.id);

        // The child overrides the description for itself.
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, 'исполнитель задачи', USER);
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.description, 'исполнитель задачи');
        assert.equal(effective[0]!.description_overridden, true);

        // The parent's own list is untouched by the child's override.
        const parentEffective = listEffectiveTypeProperties(ndb, 'thought_type', parent.id);
        assert.equal(parentEffective[0]!.description, 'кто отвечает за элемент');
        assert.equal(parentEffective[0]!.description_overridden, false);

        // Clearing the override falls back to the definition's description.
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, null, USER);
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.description, 'кто отвечает за элемент');
        assert.equal(effective[0]!.description_overridden, false);
      } finally {
        ndb.close();
      }
    });

    it('the override row survives partial clears: description reset keeps the default override and vice versa', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'BothParent' }, USER);
        const prop = createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'size',
          value_type: 'number',
          config: { default_value: 1 },
          description: 'размер в штуках',
        }, USER);
        const child = createThoughtType(ndb, { name: 'BothChild', parent_id: parent.id }, USER);

        // Override BOTH the default and the description.
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, 5, USER);
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, 'размер в паллетах', USER);
        let effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.default_value, 5);
        assert.equal(effective[0]!.overridden_here, true);
        assert.equal(effective[0]!.description, 'размер в паллетах');
        assert.equal(effective[0]!.description_overridden, true);

        // Resetting the DEFAULT keeps the description override.
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, null, USER);
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.default_value, 1);
        assert.equal(effective[0]!.overridden_here, false);
        assert.equal(effective[0]!.description, 'размер в паллетах');
        assert.equal(effective[0]!.description_overridden, true);

        // Resetting the DESCRIPTION removes the row entirely (nothing left).
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, null, USER);
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.description, 'размер в штуках');
        assert.equal(effective[0]!.description_overridden, false);
        const rows = ndb
          .prepare('SELECT COUNT(*) AS c FROM type_property_overrides')
          .get() as { c: number };
        assert.equal(rows.c, 0);

        // The mirrored order: description first, default reset keeps it.
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, 'размер в ящиках', USER);
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, 9, USER);
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, null, USER);
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.default_value, 9);
        assert.equal(effective[0]!.overridden_here, true);
        assert.equal(effective[0]!.description, 'размер в штуках');
        assert.equal(effective[0]!.description_overridden, false);
      } finally {
        ndb.close();
      }
    });

    it('description overrides of own or out-of-chain properties are rejected', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'GuardParent' }, USER);
        const own = createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'own',
          value_type: 'text',
        }, USER);
        // Own property of the parent: edited in the registry (0.6.5).
        assert.throws(
          () =>
            setTypePropertyDescriptionOverride(ndb, 'thought_type', parent.id, own.id, 'nope', USER),
          /собственные свойства правятся в справочнике/,
        );

        // A sibling type's property is not in the child's ancestor chain.
        const sibling = createThoughtType(ndb, { name: 'GuardSibling', parent_id: parent.id }, USER);
        const child = createThoughtType(ndb, { name: 'GuardChild', parent_id: parent.id }, USER);
        const sibProp = createTypeProperty(ndb, 'thought_type', sibling.id, {
          key: 'sib',
          value_type: 'text',
        }, USER);
        assert.throws(
          () =>
            setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, sibProp.id, 'nope', USER),
          /переопределять можно только свойства, подключённые предками/,
        );
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'property registry and bindings (0.6.5)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    /** Count live bindings of a property on a type. */
    function bindingCount(ndb: NetworkDb, ownerId: string, propertyId: string): number {
      return (
        ndb
          .prepare(
            "SELECT COUNT(*) AS c FROM type_properties_v WHERE owner_type = 'thought_type' AND owner_id = ? AND property_id = ?",
          )
          .get(ownerId, propertyId) as { c: number }
      ).c;
    }

    it('one property serves two unrelated thought types and a link type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThoughtType(ndb, { name: 'Книга' }, USER);
        const b = createThoughtType(ndb, { name: 'Статья' }, USER);
        const lt = createLinkType(ndb, { name_forward: 'про', name_reverse: 'касается' }, USER);
        // Three attaches of the SAME name: the registry property is created
        // once and reused.
        createTypeProperty(ndb, 'thought_type', a.id, { key: 'приоритет', value_type: 'number' }, USER);
        const onB = createTypeProperty(ndb, 'thought_type', b.id, {
          key: 'приоритет',
          value_type: 'text', // nature of an existing property is ignored
        }, USER);
        createTypeProperty(ndb, 'link_type', lt.id, { key: 'приоритет', value_type: 'number' }, USER);

        assert.equal(listNetworkProperties(ndb).length, 1, 'one registry property');
        assert.equal(onB.value_type, 'number', 'registry nature wins');
        for (const [ownerType, ownerId] of [
          ['thought_type', a.id],
          ['thought_type', b.id],
          ['link_type', lt.id],
        ] as const) {
          const eff = listEffectiveTypeProperties(ndb, ownerType, ownerId);
          assert.equal(eff.length, 1);
          assert.equal(eff[0]!.key, 'приоритет');
          assert.equal(eff[0]!.value_type, 'number');
        }
      } finally {
        ndb.close();
      }
    });

    it('attaching to an ancestor drops redundant descendant bindings, values untouched', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'Родитель' }, USER);
        const child = createThoughtType(ndb, { name: 'Наследник', parent_id: parent.id }, USER);
        const childBinding = createTypeProperty(ndb, 'thought_type', child.id, {
          key: 'статус',
          value_type: 'text',
        }, USER);
        const th = seedTypedThought(ndb, child.id);
        setPropertyValue(ndb, 'thought', th, 'статус', 'в работе', USER);
        assert.equal(listEffectiveTypeProperties(ndb, 'thought_type', child.id).length, 1);

        // Attach the SAME property to the parent: the child's binding is
        // redundant and must be dropped in the same transaction.
        const parentBinding = createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'статус',
          value_type: 'text',
        }, USER);
        assert.equal(parentBinding.property_id, childBinding.property_id);
        assert.equal(bindingCount(ndb, child.id, childBinding.property_id), 0);
        // The property is still effective for the child — by inheritance now.
        const eff = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(eff.length, 1);
        assert.equal(eff[0]!.inherited, true);
        assert.equal(eff[0]!.defined_on, parent.id);
        // Values did not change and are not outside-type.
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th).map((v) => [v.value, v.outside_type]),
          [['в работе', false]],
        );
        // Re-attaching on the child directly is now a duplicate (inherited).
        assert.throws(
          () =>
            createTypeProperty(ndb, 'thought_type', child.id, {
              key: 'статус',
              value_type: 'text',
            }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('type change keeps the value visible or flags it outside_type; writes follow the attachment', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const withProp = createThoughtType(ndb, { name: 'Свойственный' }, USER);
        const withoutProp = createThoughtType(ndb, { name: 'Пустой' }, USER);
        createTypeProperty(ndb, 'thought_type', withProp.id, { key: 'оценка', value_type: 'number' }, USER);
        const th = seedTypedThought(ndb, withProp.id);
        setPropertyValue(ndb, 'thought', th, 'оценка', 5, USER);

        // Change the type to one that attaches the SAME property: the value
        // stays visible (one registry property, two bindings).
        createTypeProperty(ndb, 'thought_type', withoutProp.id, { key: 'оценка', value_type: 'number' }, USER);
        ndb.prepare('UPDATE thoughts SET type_id = ? WHERE id = ?').run(withoutProp.id, th);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th).map((v) => [v.value, v.outside_type]),
          [[5, false]],
        );

        // Change to a type WITHOUT the property: outside-type value.
        const third = createThoughtType(ndb, { name: 'Третий' }, USER);
        ndb.prepare('UPDATE thoughts SET type_id = ? WHERE id = ?').run(third.id, th);
        const values = getPropertyValues(ndb, 'thought', th);
        assert.deepEqual(
          values.map((v) => [v.value, v.outside_type, v.property_name, v.value_type]),
          [[5, true, 'оценка', 'number']],
        );
        // Writing it is rejected with 422; deleting it works (the only action
        // available for an outside-type value).
        assert.throws(
          () => setPropertyValue(ndb, 'thought', th, 'оценка', 6, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        deletePropertyValue(ndb, 'thought', th, 'оценка', USER);
        assert.equal(getPropertyValues(ndb, 'thought', th).length, 0);
      } finally {
        ndb.close();
      }
    });

    it('detaching a property never deletes stored values', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'Отключение' }, USER);
        const binding = createTypeProperty(ndb, 'thought_type', tt.id, { key: 'поле', value_type: 'text' }, USER);
        const th = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', th, 'поле', 'значение', USER);

        deleteTypeProperty(ndb, binding.id, USER);
        // The value survives as outside-type.
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th).map((v) => [v.value, v.outside_type]),
          [['значение', true]],
        );
        // Re-attaching the property returns the value to the normal table
        // without any data action.
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'поле', value_type: 'text' }, USER);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th).map((v) => [v.value, v.outside_type]),
          [['значение', false]],
        );
      } finally {
        ndb.close();
      }
    });

    it('registry deletion is blocked by bindings and values with both counters (409)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // An unattached, unfilled property deletes cleanly.
        const prop = createNetworkProperty(ndb, { name: 'счётчик', value_type: 'number' }, USER);
        deleteNetworkProperty(ndb, prop.id);
        assert.equal(getNetworkPropertyByName(ndb, 'счётчик'), null);

        // A binding blocks the delete with counters.
        const tt = createThoughtType(ndb, { name: 'Блокировка' }, USER);
        const held = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'счётчик',
          value_type: 'number',
        }, USER);
        assert.throws(
          () => deleteNetworkProperty(ndb, held.property_id),
          (e: unknown) => {
            if (!(e instanceof EtnError) || e.code !== 'DUPLICATE') return false;
            const d = e.details as { types_count: number; values_count: number };
            assert.equal(d.types_count, 1);
            assert.equal(d.values_count, 0);
            return true;
          },
          'a binding must block the delete with counters',
        );

        // Add a value: both counters report (the value is outside-type for the
        // untyped owner — still blocking).
        const th = seedTypedThought(ndb, null as unknown as string);
        ndb.prepare('UPDATE thoughts SET type_id = NULL WHERE id = ?').run(th);
        ndb
          .prepare(
            `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_number, updated_at)
             VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', 'thought', ?, ?, 3, '2024')`,
          )
          .run(randomUUID(), th, held.property_id);
        assert.throws(
          () => deleteNetworkProperty(ndb, held.property_id),
          (e: unknown) => {
            if (!(e instanceof EtnError) || e.code !== 'DUPLICATE') return false;
            const d = e.details as { types_count: number; values_count: number };
            assert.equal(d.types_count, 1);
            assert.equal(d.values_count, 1);
            return true;
          },
          'a value must appear in the counters',
        );

        // Detach + clear the value → delete succeeds.
        deleteTypeProperty(ndb, held.id, USER);
        deletePropertyValue(ndb, 'thought', th, 'счётчик', USER);
        deleteNetworkProperty(ndb, held.property_id);
        assert.equal(listNetworkProperties(ndb).length, 0);
      } finally {
        ndb.close();
      }
    });

    it('registry names are unique per network (case-insensitive) with conflict id in details', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const first = createNetworkProperty(ndb, { name: 'Приоритет', value_type: 'number' }, USER);
        assert.throws(
          () => createNetworkProperty(ndb, { name: 'приоритет', value_type: 'number' }, USER),
          (e: unknown) => {
            if (!(e instanceof EtnError) || e.code !== 'DUPLICATE') return false;
            const d = e.details as { conflict_property_id: string };
            assert.equal(d.conflict_property_id, first.id);
            return true;
          },
        );
        // Rename into an occupied name is rejected too.
        const second = createNetworkProperty(ndb, { name: 'Ранг', value_type: 'number' }, USER);
        assert.throws(
          () => updateNetworkProperty(ndb, second.id, { name: 'ПРИОРИТЕТ' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
        // Renaming to a free name works and keeps values addressable.
        const tt = createThoughtType(ndb, { name: 'Переименование' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'Ранг', value_type: 'number' }, USER);
        const th = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', th, 'Ранг', 1, USER);
        updateNetworkProperty(ndb, second.id, { name: 'Вес' }, USER);
        assert.equal(getPropertyValues(ndb, 'thought', th)[0]!.property_name, 'Вес');
      } finally {
        ndb.close();
      }
    });

    it('value_type change converts every stored value of the property', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const ta = createThoughtType(ndb, { name: 'КонвертА' }, USER);
        const tb = createThoughtType(ndb, { name: 'КонвертБ' }, USER);
        const onA = createTypeProperty(ndb, 'thought_type', ta.id, { key: 'число', value_type: 'text' }, USER);
        // Same property attached to a second type: both types' values convert.
        createTypeProperty(ndb, 'thought_type', tb.id, { key: 'число', value_type: 'text' }, USER);
        const a = seedTypedThought(ndb, ta.id);
        const b = seedTypedThought(ndb, tb.id);
        setPropertyValue(ndb, 'thought', a, 'число', '42', USER);
        setPropertyValue(ndb, 'thought', b, 'число', 'не число', USER);

        updateNetworkProperty(ndb, onA.property_id, { value_type: 'number' }, USER);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', a).map((v) => v.value),
          [42],
        );
        assert.equal(getPropertyValues(ndb, 'thought', b).length, 0, 'unconvertible cleared');
      } finally {
        ndb.close();
      }
    });

    it('default-value overrides are transitive down the chain until re-overridden', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = createThoughtType(ndb, { name: 'Верх' }, USER);
        const mid = createThoughtType(ndb, { name: 'Середина', parent_id: root.id }, USER);
        const leaf = createThoughtType(ndb, { name: 'Лист', parent_id: mid.id }, USER);
        const def = createTypeProperty(ndb, 'thought_type', root.id, {
          key: 'порог',
          value_type: 'number',
          config: { default_value: 1 },
        }, USER);

        // The middle type overrides; the leaf inherits the override.
        setTypePropertyDefaultOverride(ndb, 'thought_type', mid.id, def.id, 5, USER);
        let eff = listEffectiveTypeProperties(ndb, 'thought_type', leaf.id);
        assert.equal(eff[0]!.default_value, 5);
        assert.equal(eff[0]!.overridden_here, false, 'stored on the ancestor, not the leaf');

        // The leaf re-overrides for itself.
        setTypePropertyDefaultOverride(ndb, 'thought_type', leaf.id, def.id, 9, USER);
        eff = listEffectiveTypeProperties(ndb, 'thought_type', leaf.id);
        assert.equal(eff[0]!.default_value, 9);
        assert.equal(eff[0]!.overridden_here, true);

        // The middle keeps its own view.
        eff = listEffectiveTypeProperties(ndb, 'thought_type', mid.id);
        assert.equal(eff[0]!.default_value, 5);
        assert.equal(eff[0]!.overridden_here, true);
      } finally {
        ndb.close();
      }
    });

    it('an untyped owner writes through the root type bindings', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const rootId = (
          ndb.prepare('SELECT id FROM thought_types_v WHERE is_root = 1').get() as { id: string }
        ).id;
        createTypeProperty(ndb, 'thought_type', rootId, { key: 'общее', value_type: 'text' }, USER);
        const untyped = seedTypedThought(ndb, null as unknown as string);
        ndb.prepare('UPDATE thoughts SET type_id = NULL WHERE id = ?').run(untyped);
        setPropertyValue(ndb, 'thought', untyped, 'общее', 'значение без типа', USER);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', untyped).map((v) => v.value),
          ['значение без типа'],
        );
      } finally {
        ndb.close();
      }
    });
  },
);

