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

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  computeThoughtCardWarnings,
  createTypeProperty,
  deletePropertyValue,
  findThoughtUsage,
  getPropertyValues,
  getPropertyValuesResolved,
  listEffectiveTypeProperties,
  setPropertyValue,
  setPropertyValues,
  setTypePropertyDefaultOverride,
  setTypePropertyDescriptionOverride,
  updateTypeProperty,
} from '../src/domain/property-service.js';
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'title', value_type: 'text' });
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' });
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'published', value_type: 'bool' });
        const thought = seedTypedThought(ndb, tt.id);

        setPropertyValue(ndb, 'thought', thought, 'title', 'Dune');
        setPropertyValue(ndb, 'thought', thought, 'year', 1965);
        setPropertyValue(ndb, 'thought', thought, 'published', true);

        const row = ndb
          .prepare(
            'SELECT value_text, value_number, value_bool, value_date, value_thought_ref FROM property_values WHERE owner_id = ? AND property_id = (SELECT id FROM type_properties WHERE key = ?)',
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'title', value_type: 'text' });
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' });
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'published', value_type: 'bool' });
        const thought = seedTypedThought(ndb, tt.id);

        const stored = setPropertyValues(ndb, 'thought', thought, {
          title: 'Dune',
          year: 1965,
          published: true,
        });
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'title', value_type: 'text' });
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' });
        const thought = seedTypedThought(ndb, tt.id);

        // 'year' gets a non-number → VALIDATION_ERROR; 'title' must also be absent.
        assert.throws(
          () =>
            setPropertyValues(ndb, 'thought', thought, {
              title: 'Dune',
              year: 'not-a-number' as unknown as number,
            }),
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'count', value_type: 'number' });
        const thought = seedTypedThought(ndb, tt.id);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', thought, 'count', 'not-a-number'),
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
          () => setPropertyValue(ndb, 'thought', thought, 'missing', 'x'),
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
        });
        const goodAuthor = seedTypedThought(ndb, author.id);
        const wrongType = seedTypedThought(ndb, book.id);
        const bookThought = seedTypedThought(ndb, book.id);

        // Correct type passes.
        setPropertyValue(ndb, 'thought', bookThought, 'author', goodAuthor);
        // Wrong type is rejected.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', bookThought, 'author', wrongType),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // Missing target is rejected.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', bookThought, 'author', 'no-such-thought'),
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
        });
        const goodAuthor = seedTypedThought(ndb, author.id);
        const goodEditor = seedTypedThought(ndb, editor.id);
        const wrongType = seedTypedThought(ndb, book.id);
        const bookThought = seedTypedThought(ndb, book.id);

        // Both listed types pass.
        setPropertyValue(ndb, 'thought', bookThought, 'author', goodAuthor);
        setPropertyValue(ndb, 'thought', bookThought, 'author', goodEditor);
        // A type outside the list is rejected.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', bookThought, 'author', wrongType),
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
        });
        const owner = seedTypedThought(ndb, ta.id);
        const other = seedTypedThought(ndb, tb.id);
        setPropertyValue(ndb, 'thought', owner, 'ref', other);
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
        });
        const authorThought = seedTypedThought(ndb, author.id);
        const bookThought = seedTypedThought(ndb, book.id);
        // A plain text value must pass through untouched.
        createTypeProperty(ndb, 'thought_type', book.id, { key: 'note', value_type: 'text' });
        setPropertyValue(ndb, 'thought', bookThought, 'author', authorThought);
        setPropertyValue(ndb, 'thought', bookThought, 'note', 'hello');

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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'note', value_type: 'text' });
        const thought = seedTypedThought(ndb, tt.id);

        setPropertyValue(ndb, 'thought', thought, 'note', 'first');
        setPropertyValue(ndb, 'thought', thought, 'note', 'second');
        const values = getPropertyValues(ndb, 'thought', thought);
        assert.equal(values.length, 1);
        assert.equal(values[0]!.value, 'second');

        deletePropertyValue(ndb, 'thought', thought, 'note');
        assert.equal(getPropertyValues(ndb, 'thought', thought).length, 0);
        assert.throws(
          () => deletePropertyValue(ndb, 'thought', thought, 'note'),
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'site', value_type: 'url' });
        const thought = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', thought, 'site', 'https://example.com');
        assert.equal(getPropertyValues(ndb, 'thought', thought)[0]!.value, 'https://example.com');
        assert.throws(
          () => setPropertyValue(ndb, 'thought', thought, 'site', 5),
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
        const prop = createTypeProperty(ndb, 'thought_type', tt.id, { key: 'num', value_type: 'text' });
        const a = seedTypedThought(ndb, tt.id);
        const b = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', a, 'num', '42');
        setPropertyValue(ndb, 'thought', b, 'num', 'not-a-number');

        updateTypeProperty(ndb, prop.id, { value_type: 'number' });
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
        const prop = createTypeProperty(ndb, 'thought_type', tt.id, { key: 'old', value_type: 'text' });
        const thought = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', thought, 'old', 'kept');

        updateTypeProperty(ndb, prop.id, { key: 'new' });
        // The value is addressed by the new key and still there.
        assert.equal(getPropertyValues(ndb, 'thought', thought)[0]!.value, 'kept');
        assert.throws(
          () => setPropertyValue(ndb, 'thought', thought, 'old', 'x'),
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
        createTypeProperty(ndb, 'thought_type', book.id, { key: 'author', value_type: 'thought_ref' });
        createTypeProperty(ndb, 'thought_type', book.id, { key: 'editor', value_type: 'thought_ref' });
        const target = seedTypedThought(ndb, person.id);
        const other = seedTypedThought(ndb, person.id);
        const b1 = seedTypedThought(ndb, book.id);
        const b2 = seedTypedThought(ndb, book.id);

        setPropertyValue(ndb, 'thought', b1, 'author', target);
        setPropertyValue(ndb, 'thought', b2, 'author', target);
        setPropertyValue(ndb, 'thought', b1, 'editor', target);
        setPropertyValue(ndb, 'thought', b2, 'editor', other);

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
      def: { id: string; key: string };
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
      });
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
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b]);
        assert.deepEqual(JSON.parse(rawRef(ndb, owner, def.id)!), [a, b]);
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
        });
        const good = seedTypedThought(ndb, authorType.id);
        const wrongType = seedTypedThought(ndb, bookType.id);
        const owner = seedTypedThought(ndb, bookType.id);

        // Duplicate ids collapse.
        setPropertyValue(ndb, 'thought', owner, 'authors', [good, good]);
        assert.deepEqual(JSON.parse(rawRef(ndb, owner, def.id)!), [good]);

        // A missing id rejects the whole write.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'authors', [good, 'no-such-thought']),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // An id of a wrong (filtered-out) type rejects too.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'authors', [good, wrongType]),
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'ref', value_type: 'thought_ref' });
        const target = seedTypedThought(ndb, tt.id);
        const owner = seedTypedThought(ndb, tt.id);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'ref', [target]),
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
        setPropertyValue(ndb, 'thought', owner, 'authors', a);
        assert.deepEqual(JSON.parse(rawRef(ndb, owner, def.id)!), [a]);
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [a]);
      } finally {
        ndb.close();
      }
    });

    it('treats an empty array as a clear', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', [a]);
        setPropertyValue(ndb, 'thought', owner, 'authors', []);
        assert.equal(rawRef(ndb, owner, def.id), null);
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
          .run(randomUUID(), owner, def.id, a);
        assert.deepEqual(getPropertyValues(ndb, 'thought', owner)[0]!.value, [a]);
      } finally {
        ndb.close();
      }
    });

    it('resolves multiple values to [{id, title}] with dangling ids as title null', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { def, a, b, owner } = seedMulti(ndb);
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b]);
        // Sneak a dangling id into the stored array (no SQL FK).
        ndb
          .prepare('UPDATE property_values SET value_thought_ref = ? WHERE owner_id = ? AND property_id = ?')
          .run(JSON.stringify([a, 'gone', b]), owner, def.id);

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
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b]);

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
        setPropertyValue(ndb, 'thought', owner, 'authors', [a, b]);
        updateTypeProperty(ndb, def.id, { value_type: 'text' });
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
        });
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
        setPropertyValue(ndb, 'thought', owner, 'refs', [target]);
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
      def: { id: string; key: string };
      owner: string;
    } {
      const tt = createThoughtType(ndb, { name: 'Bookmark' }, USER);
      const def = createTypeProperty(ndb, 'thought_type', tt.id, {
        key: 'sites',
        value_type: 'url',
        config: { multiple: true },
      });
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
        ]);
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.id)!), [
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
        ]);
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.id)!), [
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
        });
        const owner = seedTypedThought(ndb, tt.id);
        assert.throws(
          () => setPropertyValue(ndb, 'thought', owner, 'site', ['https://a.test']),
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
        setPropertyValue(ndb, 'thought', owner, 'sites', 'https://only.test');
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.id)!), ['https://only.test']);
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
        setPropertyValue(ndb, 'thought', owner, 'sites', ['https://a.test']);
        setPropertyValue(ndb, 'thought', owner, 'sites', []);
        assert.equal(rawText(ndb, owner, def.id), null);
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
          .run(randomUUID(), owner, def.id, 'https://legacy.test');
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
        setPropertyValue(ndb, 'thought', owner, 'sites', [tricky, 'https://plain.test']);
        assert.deepEqual(JSON.parse(rawText(ndb, owner, def.id)!), [
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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'body', value_type: 'text' });
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
        });
        const priority = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'priority',
          value_type: 'text',
          required: true,
        });
        const optional = createTypeProperty(ndb, 'thought_type', tt.id, {
          key: 'description',
          value_type: 'text',
        });
        const thought = seedTypedThought(ndb, tt.id);
        // Fill only `status`; `priority` must remain in the warning list.
        setPropertyValue(ndb, 'thought', thought, 'status', 'open');

        const warnings = computeThoughtCardWarnings(ndb, thought);
        assert.equal(warnings.length, 1);
        const w = warnings[0]!;
        assert.equal(w.code, 'REQUIRED_PROPERTY_MISSING');
        assert.equal(w.key, 'priority');
        assert.equal(w.property_id, priority.id);
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
        });
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
        });
        const child = createThoughtType(ndb, { name: 'IssueChild', parent_id: parent.id }, USER);
        createTypeProperty(ndb, 'thought_type', child.id, {
          key: 'severity',
          value_type: 'number',
          required: true,
        });

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
        setPropertyValue(ndb, 'thought', thought, 'owner', 'alice');
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
        });
        const thought = seedTypedThought(ndb, tt.id);
        assert.equal(computeThoughtCardWarnings(ndb, thought).length, 1);
        setPropertyValue(ndb, 'thought', thought, 'flag', true);
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
        });
        const thought = seedTypedThought(ndb, tt.id);
        setPropertyValue(ndb, 'thought', thought, 'note', '');
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
        });
        assert.equal(prop.description, 'путь от корня репозитория');

        const updated = updateTypeProperty(ndb, prop.id, { description: 'абсолютный путь' });
        assert.equal(updated.description, 'абсолютный путь');

        // A blank description normalizes back to null.
        const cleared = updateTypeProperty(ndb, prop.id, { description: '   ' });
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
        });
        const child = createThoughtType(ndb, { name: 'DescChild', parent_id: parent.id }, USER);

        // Inherited as-is: the effective description equals the definition's.
        let effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective.length, 1);
        assert.equal(effective[0]!.description, 'кто отвечает за элемент');
        assert.equal(effective[0]!.description_overridden, false);
        assert.equal(effective[0]!.inherited, true);
        assert.equal(effective[0]!.defined_on, parent.id);

        // The child overrides the description for itself.
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, 'исполнитель задачи');
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.description, 'исполнитель задачи');
        assert.equal(effective[0]!.description_overridden, true);

        // The parent's own list is untouched by the child's override.
        const parentEffective = listEffectiveTypeProperties(ndb, 'thought_type', parent.id);
        assert.equal(parentEffective[0]!.description, 'кто отвечает за элемент');
        assert.equal(parentEffective[0]!.description_overridden, false);

        // Clearing the override falls back to the definition's description.
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, null);
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
        });
        const child = createThoughtType(ndb, { name: 'BothChild', parent_id: parent.id }, USER);

        // Override BOTH the default and the description.
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, 5);
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, 'размер в паллетах');
        let effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.default_value, 5);
        assert.equal(effective[0]!.overridden_here, true);
        assert.equal(effective[0]!.description, 'размер в паллетах');
        assert.equal(effective[0]!.description_overridden, true);

        // Resetting the DEFAULT keeps the description override.
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, null);
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.default_value, 1);
        assert.equal(effective[0]!.overridden_here, false);
        assert.equal(effective[0]!.description, 'размер в паллетах');
        assert.equal(effective[0]!.description_overridden, true);

        // Resetting the DESCRIPTION removes the row entirely (nothing left).
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, null);
        effective = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.equal(effective[0]!.description, 'размер в штуках');
        assert.equal(effective[0]!.description_overridden, false);
        const rows = ndb
          .prepare('SELECT COUNT(*) AS c FROM type_property_overrides')
          .get() as { c: number };
        assert.equal(rows.c, 0);

        // The mirrored order: description first, default reset keeps it.
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, 'размер в ящиках');
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, prop.id, 9);
        setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, prop.id, null);
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
        });
        // Own property of the parent: edited on the definition itself.
        assert.throws(
          () =>
            setTypePropertyDescriptionOverride(ndb, 'thought_type', parent.id, own.id, 'nope'),
          /own defaults are edited on the property definition itself/,
        );

        // A sibling type's property is not in the child's ancestor chain.
        const sibling = createThoughtType(ndb, { name: 'GuardSibling', parent_id: parent.id }, USER);
        const child = createThoughtType(ndb, { name: 'GuardChild', parent_id: parent.id }, USER);
        const sibProp = createTypeProperty(ndb, 'thought_type', sibling.id, {
          key: 'sib',
          value_type: 'text',
        });
        assert.throws(
          () =>
            setTypePropertyDescriptionOverride(ndb, 'thought_type', child.id, sibProp.id, 'nope'),
          /only properties inherited from ancestor types can be overridden/,
        );
      } finally {
        ndb.close();
      }
    });
  },
);
