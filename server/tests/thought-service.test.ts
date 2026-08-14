/**
 * Unit tests for the thought domain service (task C3).
 *
 * Covers: title normalisation, CRUD with optimistic version checks, protection
 * of the HOME thought, synonym handling, focus (view mark + neighbours), and
 * the inactive filter. Skipped entirely when the `better-sqlite3` native binding
 * is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  addSynonyms,
  createThought,
  deleteThought,
  focus,
  getNeighbors,
  getThought,
  normalizeTitle,
  parseSynonyms,
  removeSynonym,
  replaceSynonyms,
  resolveThoughts,
  updateThought,
} from '../src/domain/thought-service.js';

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

/** Insert a thought row directly, bypassing the service (e.g. HOME seeding). */
function seedThought(
  ndb: NetworkDb,
  overrides: Partial<{
    id: string;
    title: string;
    is_protected: number;
    is_root: number;
    active: number;
  }> = {},
): string {
  const id = overrides.id ?? randomUUID();
  const title = overrides.title ?? 'Seed';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(
      id,
      title,
      title.toLowerCase(),
      overrides.active ?? 1,
      overrides.is_protected ?? 0,
      overrides.is_root ?? 0,
    );
  return id;
}

/** Insert a raw link row between two seeded thoughts. */
function seedLink(ndb: NetworkDb, sourceId: string, targetId: string, active = 1): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, ?, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, active);
}

describe(
  'thought-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    describe('normalisation & synonyms parsing', () => {
      it('normalizeTitle trims, NFC-normalises and lowercases', () => {
        assert.equal(normalizeTitle('  HÉLLO  '), 'héllo');
        // NFD (e + combining accent) collapses to NFC é.
        assert.equal(normalizeTitle('Cafe\u0301'), 'café');
      });

      it('parseSynonyms splits comma strings and dedups by normalised form', () => {
        assert.deepEqual(parseSynonyms('Alpha, beta , ALPHA'), ['Alpha', 'beta']);
        assert.deepEqual(parseSynonyms(['X', ' x ', '', 'y']), ['X', 'y']);
        assert.deepEqual(parseSynonyms(undefined), []);
      });
    });

    describe('createThought', () => {
      it('generates title_norm and persists synonyms', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: '  Café  ', synonyms: 'espresso, java' }, USER);
          assert.equal(t.title, 'Café');
          assert.equal(t.version, 1);
          assert.deepEqual(t.synonyms.sort(), ['espresso', 'java']);

          const row = ndb.prepare('SELECT title_norm FROM thoughts WHERE id = ?').get(t.id) as {
            title_norm: string;
          };
          assert.equal(row.title_norm, 'café');
        } finally {
          ndb.close();
        }
      });

      it('rejects an empty or over-long title', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          assert.throws(
            () => createThought(ndb, { title: '   ' }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
          assert.throws(
            () => createThought(ndb, { title: 'x'.repeat(500) }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });

      it('creates an inline child link atomically', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const parent = createThought(ndb, { title: 'Parent' }, USER);
          const child = createThought(
            ndb,
            { title: 'Child', create_link: { direction: 'child', target_thought_id: parent.id } },
            USER,
          );
          const link = ndb.prepare('SELECT source_id, target_id FROM links').get() as {
            source_id: string;
            target_id: string;
          };
          assert.equal(link.source_id, parent.id);
          assert.equal(link.target_id, child.id);
        } finally {
          ndb.close();
        }
      });

      it('rolls back the thought when an inline link target is missing', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          assert.throws(
            () =>
              createThought(
                ndb,
                { title: 'X', create_link: { direction: 'parent', target_thought_id: 'nope' } },
                USER,
              ),
            (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
          );
          assert.equal(
            (ndb.prepare('SELECT COUNT(*) AS c FROM thoughts').get() as { c: number }).c,
            0,
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('updateThought', () => {
      it('updates only the supplied fields and bumps version', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'Original', icon: '🔧' }, USER);
          const updated = updateThought(
            ndb,
            t.id,
            { title: 'Renamed', active: false },
            t.version,
            USER,
          );
          assert.equal(updated.title, 'Renamed');
          assert.equal(updated.active, false);
          assert.equal(updated.icon, '🔧', 'icon untouched');
          assert.equal(updated.version, t.version + 1);
        } finally {
          ndb.close();
        }
      });

      it('returns VERSION_CONFLICT when expectedVersion does not match', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'V' }, USER);
          assert.throws(
            () => updateThought(ndb, t.id, { title: 'Other' }, t.version + 5, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'VERSION_CONFLICT',
          );
          assert.equal(getThought(ndb, t.id)?.title, 'V');
        } finally {
          ndb.close();
        }
      });

      it('forbids deactivating the root thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const homeId = seedThought(ndb, { title: 'HOME', is_root: 1, is_protected: 1 });
          assert.throws(
            () => updateThought(ndb, homeId, { active: false }, 1, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'PROTECTED_ENTITY',
          );
        } finally {
          ndb.close();
        }
      });

      it('replaces synonyms when the field is present', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'T', synonyms: ['old'] }, USER);
          const updated = updateThought(ndb, t.id, { synonyms: 'new1, new2' }, t.version, USER);
          assert.deepEqual(updated.synonyms.sort(), ['new1', 'new2']);
        } finally {
          ndb.close();
        }
      });
    });

    describe('deleteThought', () => {
      it('refuses to delete a protected thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const homeId = seedThought(ndb, { title: 'HOME', is_root: 1, is_protected: 1 });
          assert.throws(
            () => deleteThought(ndb, homeId, 1),
            (e: unknown) => e instanceof EtnError && e.code === 'PROTECTED_ENTITY',
          );
        } finally {
          ndb.close();
        }
      });

      it('cascades synonyms, links and polymorphic owners', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = createThought(ndb, { title: 'A', synonyms: ['syn'] }, USER);
          const b = createThought(ndb, { title: 'B' }, USER);
          seedLink(ndb, a.id, b.id);
          // Polymorphic owner without SQL FK on the thought.
          ndb
            .prepare(
              "INSERT INTO comments (id,owner_type,owner_id,kind,body_md,body_html,valid_from,version,created_at,updated_at,created_by,updated_by) VALUES ('c1','thought',?,'chronological','x','x','2024',1,'2024','2024','u','u')",
            )
            .run(a.id);
          deleteThought(ndb, a.id, 1);
          assert.equal(getThought(ndb, a.id), null);
          assert.equal(
            (ndb.prepare('SELECT COUNT(*) AS c FROM thought_synonyms').get() as { c: number }).c,
            0,
          );
          assert.equal(
            (ndb.prepare('SELECT COUNT(*) AS c FROM links').get() as { c: number }).c,
            0,
            'links cascade-deleted',
          );
          assert.equal(
            (ndb.prepare('SELECT COUNT(*) AS c FROM comments').get() as { c: number }).c,
            0,
            'comments on the thought cleaned up',
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('synonym helpers', () => {
      it('adds, removes and replaces synonyms', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'T', synonyms: ['one'] }, USER);
          assert.deepEqual(addSynonyms(ndb, t.id, 'two, three'), ['one', 'three', 'two']);
          assert.deepEqual(removeSynonym(ndb, t.id, 'TWO'), ['one', 'three']);
          assert.deepEqual(replaceSynonyms(ndb, t.id, 'only'), ['only']);
        } finally {
          ndb.close();
        }
      });
    });

    describe('focus & neighbours', () => {
      it('records a view mark and returns parents/children/siblings', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          // Graph: P -> FOCUS, FOCUS -> C1, FOCUS -> C2(inactive), P -> SIB.
          const p = seedThought(ndb, { title: 'Parent' });
          const focusId = seedThought(ndb, { title: 'Focus' });
          const c1 = seedThought(ndb, { title: 'Child1' });
          const c2 = seedThought(ndb, { title: 'Child2', active: 0 });
          const sib = seedThought(ndb, { title: 'Sibling' });
          seedLink(ndb, p, focusId);
          seedLink(ndb, focusId, c1);
          seedLink(ndb, focusId, c2);
          seedLink(ndb, p, sib);

          const res = focus(ndb, USER, focusId);
          assert.equal(res.focused.id, focusId);
          assert.deepEqual(
            res.parents.map((n) => n.id),
            [p],
          );
          assert.deepEqual(
            res.children.map((n) => n.id),
            [c1],
            'inactive child hidden by default',
          );
          assert.deepEqual(
            res.siblings.map((n) => n.id),
            [sib],
          );
          // Per-zone sort defaults to 'created' when no preference is set.
          assert.deepEqual(res.sorts, { parents: 'created', children: 'created' });

          // Edges among visible thoughts include focus↔neighbour and
          // neighbour↔neighbour (P→SIB). C2 is inactive and hidden, so its edge
          // is absent until showInactive.
          const pairs = (r: typeof res) =>
            r.edges.map((e) => `${e.source_id}->${e.target_id}`).sort();
          assert.deepEqual(pairs(res), [`${p}->${focusId}`, `${focusId}->${c1}`, `${p}->${sib}`].sort());

          const view = ndb
            .prepare(
              'SELECT last_viewed_at FROM thought_views WHERE user_id = ? AND thought_id = ?',
            )
            .get(USER, focusId) as { last_viewed_at: string } | undefined;
          assert.ok(view?.last_viewed_at);

          // showInactive surfaces the inactive child.
          const resAll = focus(ndb, USER, focusId, { showInactive: true });
          assert.deepEqual(resAll.children.map((n) => n.id).sort(), [c1, c2].sort());
          // With C2 visible, its edge from the focus is included too.
          assert.deepEqual(pairs(resAll), [
            `${p}->${focusId}`,
            `${focusId}->${c1}`,
            `${focusId}->${c2}`,
            `${p}->${sib}`,
          ].sort());
        } finally {
          ndb.close();
        }
      });

      it('getNeighbors honours the dir parameter', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = seedThought(ndb, { title: 'A' });
          const b = seedThought(ndb, { title: 'B' });
          seedLink(ndb, a, b);
          assert.deepEqual(
            getNeighbors(ndb, b, 'parents').map((n) => n.id),
            [a],
          );
          assert.deepEqual(
            getNeighbors(ndb, a, 'children').map((n) => n.id),
            [b],
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('resolveThoughts', () => {
      it('returns metadata for known ids and drops unknown', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'R' }, USER);
          const refs = resolveThoughts(ndb, [t.id, 'unknown']);
          assert.equal(refs.length, 1);
          assert.equal(refs[0]!.id, t.id);
        } finally {
          ndb.close();
        }
      });
    });
  },
);
