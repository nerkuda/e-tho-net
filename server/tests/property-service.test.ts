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
  createTypeProperty,
  deletePropertyValue,
  getPropertyValues,
  setPropertyValue,
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
  },
);
