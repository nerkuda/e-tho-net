/**
 * Unit tests for the pinned-thoughts domain service (L18).
 *
 * Covers: the initial empty list, replace semantics with position = array
 * index, reordering, duplicate rejection, the 20-entry limit, unknown-thought
 * rejection, per-user isolation and the ON DELETE CASCADE cleanup when a
 * thought is deleted. Skipped entirely when the `better-sqlite3` native
 * binding is unavailable (see AGENTS.md §10).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError, PINNED_THOUGHTS_LIMIT } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { listPinnedThoughts, setPinnedThoughts } from '../src/domain/pin-service.js';
import { deleteThought } from '../src/domain/thought-service.js';

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

/** Insert a thought row directly, bypassing the service. */
function seedThought(ndb: NetworkDb, title = 'Seed'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

// Test user for authorship columns (task 5ef8b5bb)
const USER = 'test-user';

describe(
  'pin-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER_A = 'user-a';
    const USER_B = 'user-b';

    it('returns an empty list initially', () => {
      const ndb = createInMemoryNetworkDb();
      assert.deepEqual(listPinnedThoughts(ndb, USER_A), []);
    });

    it('assigns positions by array order and persists them', () => {
      const ndb = createInMemoryNetworkDb();
      const a = seedThought(ndb);
      const b = seedThought(ndb);
      const c = seedThought(ndb);
      const result = setPinnedThoughts(ndb, USER_A, [a, b, c]);
      assert.deepEqual(result, [
        { thought_id: a, position: 0 },
        { thought_id: b, position: 1 },
        { thought_id: c, position: 2 },
      ]);
      assert.deepEqual(listPinnedThoughts(ndb, USER_A), result);
    });

    it('reorders on repeated set (replace semantics)', () => {
      const ndb = createInMemoryNetworkDb();
      const a = seedThought(ndb);
      const b = seedThought(ndb);
      const c = seedThought(ndb);
      setPinnedThoughts(ndb, USER_A, [a, b, c]);
      setPinnedThoughts(ndb, USER_A, [c, a]); // b removed, c moved to front
      assert.deepEqual(listPinnedThoughts(ndb, USER_A), [
        { thought_id: c, position: 0 },
        { thought_id: a, position: 1 },
      ]);
    });

    it('rejects duplicate ids', () => {
      const ndb = createInMemoryNetworkDb();
      const a = seedThought(ndb);
      assert.throws(
        () => setPinnedThoughts(ndb, USER_A, [a, a]),
        (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
      );
      assert.deepEqual(listPinnedThoughts(ndb, USER_A), []);
    });

    it(`rejects lists longer than ${PINNED_THOUGHTS_LIMIT}`, () => {
      const ndb = createInMemoryNetworkDb();
      const ids = Array.from({ length: PINNED_THOUGHTS_LIMIT + 1 }, () => seedThought(ndb));
      assert.throws(
        () => setPinnedThoughts(ndb, USER_A, ids),
        (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
      );
      // The whole write is atomic — nothing is stored.
      assert.deepEqual(listPinnedThoughts(ndb, USER_A), []);
    });

    it('rejects unknown thought ids with NOT_FOUND', () => {
      const ndb = createInMemoryNetworkDb();
      assert.throws(
        () => setPinnedThoughts(ndb, USER_A, [randomUUID()]),
        (err: unknown) => err instanceof EtnError && err.code === 'NOT_FOUND',
      );
    });

    it('isolates lists between users', () => {
      const ndb = createInMemoryNetworkDb();
      const a = seedThought(ndb);
      const b = seedThought(ndb);
      setPinnedThoughts(ndb, USER_A, [a, b]);
      setPinnedThoughts(ndb, USER_B, [b]);
      assert.deepEqual(listPinnedThoughts(ndb, USER_A), [
        { thought_id: a, position: 0 },
        { thought_id: b, position: 1 },
      ]);
      assert.deepEqual(listPinnedThoughts(ndb, USER_B), [
        { thought_id: b, position: 0 },
      ]);
    });

    it('cascades pins when a pinned thought is deleted', () => {
      const ndb = createInMemoryNetworkDb();
      const a = seedThought(ndb);
      const b = seedThought(ndb);
      setPinnedThoughts(ndb, USER_A, [a, b]);
      deleteThought(ndb, a, undefined);
      assert.deepEqual(listPinnedThoughts(ndb, USER_A), [
        { thought_id: b, position: 1 },
      ]);
    });
  },
);
