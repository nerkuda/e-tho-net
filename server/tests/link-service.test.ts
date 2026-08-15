/**
 * Unit tests for the link domain service (task C4).
 *
 * Covers: self-loop rejection, endpoint/type existence checks, duplicate
 * detection (typed and untyped), optimistic version checks, and the grouped
 * editor view. Skipped entirely when the `better-sqlite3` native binding is
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
  createLink,
  deleteLink,
  getLink,
  listLinksByThought,
  updateLink,
} from '../src/domain/link-service.js';

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

/** Seed a thought row directly. Returns its id. */
function seedThought(ndb: NetworkDb, title: string, active = 1): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, '2024-01-01', 'u', '2024-01-01', 'u')`,
    )
    .run(id, title, title.toLowerCase(), active);
  return id;
}

/** Seed a link type row directly. Returns its id. */
function seedLinkType(ndb: NetworkDb, nameForward = 'fwd', nameReverse = 'rev'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_reverse, style, width, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 'solid', 1, 1, '2024-01-01', '2024-01-01', 'u')`,
    )
    .run(id, nameForward, nameReverse);
  return id;
}

describe(
  'link-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('rejects a self-loop with VALIDATION_ERROR', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        assert.throws(
          () => createLink(ndb, { source_id: a, target_id: a }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('rejects an unknown endpoint with NOT_FOUND', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        assert.throws(
          () => createLink(ndb, { source_id: a, target_id: 'missing' }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('creates a link and reads it back', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        assert.equal(link.source_id, a);
        assert.equal(link.target_id, b);
        assert.equal(link.active, true);
        assert.equal(getLink(ndb, link.id)?.target_id, b);
      } finally {
        ndb.close();
      }
    });

    it('rejects a duplicate typed link with DUPLICATE', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const t = seedLinkType(ndb);
        createLink(ndb, { source_id: a, target_id: b, type_id: t }, USER);
        assert.throws(
          () => createLink(ndb, { source_id: a, target_id: b, type_id: t }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('rejects a duplicate untyped link (NULL type_id)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        createLink(ndb, { source_id: a, target_id: b }, USER);
        assert.throws(
          () => createLink(ndb, { source_id: a, target_id: b }, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('allows two differently typed links on the same pair', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const t1 = seedLinkType(ndb, 'f1', 'r1');
        const t2 = seedLinkType(ndb, 'f2', 'r2');
        createLink(ndb, { source_id: a, target_id: b, type_id: t1 }, USER);
        assert.doesNotThrow(() =>
          createLink(ndb, { source_id: a, target_id: b, type_id: t2 }, USER),
        );
      } finally {
        ndb.close();
      }
    });

    it('updateLink bumps version and rejects stale If-Match', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        const updated = updateLink(ndb, link.id, { active: false }, link.version, USER);
        assert.equal(updated.active, false);
        assert.equal(updated.version, 2);

        assert.throws(
          () => updateLink(ndb, link.id, { active: true }, link.version, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VERSION_CONFLICT',
        );
      } finally {
        ndb.close();
      }
    });

    it('updateLink swaps the endpoints (inversion) and bumps the version', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        const inverted = updateLink(
          ndb,
          link.id,
          { source_id: link.target_id, target_id: link.source_id },
          link.version,
          USER,
        );
        assert.equal(inverted.source_id, b);
        assert.equal(inverted.target_id, a);
        assert.equal(inverted.version, 2);
        const stored = getLink(ndb, link.id);
        assert.equal(stored?.source_id, b);
        assert.equal(stored?.target_id, a);
      } finally {
        ndb.close();
      }
    });

    it('updateLink rejects a one-sided endpoint change', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        assert.throws(
          () => updateLink(ndb, link.id, { source_id: b }, link.version, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });

    it('updateLink rejects an inversion onto an existing reverse duplicate', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        createLink(ndb, { source_id: b, target_id: a }, USER);
        assert.throws(
          () =>
            updateLink(
              ndb,
              link.id,
              { source_id: link.target_id, target_id: link.source_id },
              link.version,
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
        );
      } finally {
        ndb.close();
      }
    });

    it('updateLink rejects an endpoint change to an unknown thought', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        assert.throws(
          () => updateLink(ndb, link.id, { source_id: 'missing', target_id: a }, link.version, USER),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );
      } finally {
        ndb.close();
      }
    });

    it('deleteLink honors If-Match', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = createLink(ndb, { source_id: a, target_id: b }, USER);
        assert.throws(
          () => deleteLink(ndb, link.id, 999),
          (e: unknown) => e instanceof EtnError && e.code === 'VERSION_CONFLICT',
        );
        deleteLink(ndb, link.id, 1);
        assert.equal(getLink(ndb, link.id), null);
      } finally {
        ndb.close();
      }
    });

    it('listLinksByThought groups typed and untyped links', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const focus = seedThought(ndb, 'Focus');
        const parent = seedThought(ndb, 'Parent');
        const child = seedThought(ndb, 'Child');
        const inactiveChild = seedThought(ndb, 'Inactive', 0);
        const t = seedLinkType(ndb, 'related', 'rel-of');
        // typed: focus -> child
        createLink(ndb, { source_id: focus, target_id: child, type_id: t }, USER);
        // untyped parent: parent -> focus
        createLink(ndb, { source_id: parent, target_id: focus }, USER);
        // inactive child, hidden by default
        createLink(ndb, { source_id: focus, target_id: inactiveChild }, USER);

        const grouped = listLinksByThought(ndb, focus);
        assert.equal(grouped.by_type.length, 1);
        assert.equal(grouped.by_type[0]!.type_name, 'related');
        assert.equal(grouped.by_type[0]!.items.length, 1);
        assert.equal(grouped.by_type[0]!.items[0]!.target_thought.id, child);

        assert.equal(grouped.untyped_parents.length, 1);
        assert.equal(grouped.untyped_parents[0]!.source_thought?.id, parent);
        assert.equal(grouped.untyped_children.length, 0, 'inactive child hidden by default');

        const all = listLinksByThought(ndb, focus, { showInactive: true });
        assert.equal(all.untyped_children.length, 1);
        assert.equal(all.untyped_children[0]!.target_thought.id, inactiveChild);
      } finally {
        ndb.close();
      }
    });
  },
);
