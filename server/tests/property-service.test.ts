/**
 * Unit tests for the property-value API (task C6).
 *
 * Covers: resolution of a value through the owner's type, per-value_type
 * validation, the single-column write rule, thought_ref type enforcement, and
 * upsert/delete. Skipped entirely when the `better-sqlite3` native binding is
 * unavailable.
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
  setPropertyValue,
  setPropertyValues,
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
          (v) => typeof v.value === 'object' && v.value !== null && v.value.title === null,
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
