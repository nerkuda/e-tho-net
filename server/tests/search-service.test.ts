/**
 * Unit tests for the search service (task C9): full-text search across the four
 * groups, subtree/type filters, duplicate detection and mentions.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { findDuplicates, findMentions, search } from '../src/domain/search-service.js';

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

/** Insert a thought row directly. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { type_id?: string; active?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase(), opts.type_id ?? null, opts.active ?? 1);
  return id;
}

/** Insert a synonym for a thought. */
function seedSynonym(ndb: NetworkDb, thoughtId: string, synonym: string): void {
  ndb
    .prepare(
      'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
    )
    .run(thoughtId, synonym, synonym.toLowerCase());
}

/** Insert a thought-owned comment directly. */
function seedThoughtComment(
  ndb: NetworkDb,
  thoughtId: string,
  body: string,
  kind: 'permanent' | 'chronological' = 'chronological',
  validFrom = '2024-01-01',
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, ?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, thoughtId, kind, body, body, validFrom);
  return id;
}

/** Insert two thoughts + a link between them and return the link id. */
function seedLink(ndb: NetworkDb, sourceId: string, targetId: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId);
  return id;
}

/** Insert a link-owned comment directly. */
function seedLinkComment(ndb: NetworkDb, linkId: string, body: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'link', ?, 'chronological', ?, ?, '2024-01-01', 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, linkId, body, body);
  return id;
}

describe(
  'search-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('search returns names hits with highlighted snippets', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Alpha dog');
        seedThought(ndb, 'Beta cat');
        const res = search(ndb, { q: 'alpha' });
        assert.equal(res.by_names.length, 1);
        assert.equal(res.by_names[0]!.title, 'Alpha dog');
        assert.ok(res.by_names[0]!.snippet.includes('<mark>'));
        assert.equal(res.meta.total_in_group.names, 1);
      } finally {
        ndb.close();
      }
    });

    it('search finds thought comment bodies in by_texts', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'Owner');
        seedThoughtComment(ndb, t, 'remember the milk');
        const res = search(ndb, { q: 'milk' });
        assert.equal(res.by_texts.length, 1);
        assert.equal(res.by_texts[0]!.thought_id, t);
        assert.equal(res.by_texts[0]!.title, 'Owner');
        assert.ok(res.by_texts[0]!.snippet.includes('<mark>'));
      } finally {
        ndb.close();
      }
    });

    it('search finds link comment bodies in by_links', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        const link = seedLink(ndb, a, b);
        seedLinkComment(ndb, link, 'the wire');
        const res = search(ndb, { q: 'wire' });
        assert.equal(res.by_links.length, 1);
        assert.equal(res.by_links[0]!.link_id, link);
      } finally {
        ndb.close();
      }
    });

    it('search by_chrono only returns chronological comments', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'T');
        seedThoughtComment(ndb, t, 'chrono notes about gamma', 'chronological');
        seedThoughtComment(ndb, t, 'permanent text about gamma', 'permanent');
        const res = search(ndb, { q: 'gamma', scope: 'chronology' });
        assert.equal(res.by_chrono.length, 1, 'permanent excluded from chrono group');
        assert.equal(res.by_chrono[0]!.owner, 'thought');
        assert.equal(res.by_chrono[0]!.owner_id, t);
      } finally {
        ndb.close();
      }
    });

    it('scope filter restricts populated groups', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Theta');
        const res = search(ndb, { q: 'theta', scope: 'links' });
        assert.equal(res.by_names.length, 0, 'names skipped under scope=links');
        assert.equal(res.meta.total_in_group.names, 0);
      } finally {
        ndb.close();
      }
    });

    it('in_subtree_of restricts results to the subtree', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = seedThought(ndb, 'Parent');
        const child = seedThought(ndb, 'Child has secret');
        seedLink(ndb, parent, child);
        const other = seedThought(ndb, 'Other has secret');
        // Without subtree: both children match.
        const all = search(ndb, { q: 'secret' });
        assert.equal(all.by_names.length, 2);
        // With subtree rooted at parent: only the matching child in the subtree
        // is returned (the seed itself does not match "secret"; the unrelated
        // 'Other' thought is excluded).
        const sub = search(ndb, { q: 'secret', in: 'subtree', from_thought_id: parent });
        assert.deepEqual(
          sub.by_names.map((h) => h.thought_id),
          [child],
          'subtree restricts matches to the seed subtree',
        );
        assert.ok(!sub.by_names.some((h) => h.thought_id === other));
      } finally {
        ndb.close();
      }
    });

    it('show_inactive surfaces inactive thoughts', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Ghost', { active: 0 });
        const hidden = search(ndb, { q: 'ghost' });
        assert.equal(hidden.by_names.length, 0, 'inactive hidden by default');
        const shown = search(ndb, { q: 'ghost', show_inactive: true });
        assert.equal(shown.by_names.length, 1);
      } finally {
        ndb.close();
      }
    });

    it('type_id filter narrows the names group', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // thought_types rows must exist before they can be referenced (FK).
        for (const [id, name] of [
          ['type-a', 'A'],
          ['type-b', 'B'],
        ] as const) {
          ndb
            .prepare(
              `INSERT INTO thought_types (id, name, version, created_at, updated_at, created_by)
               VALUES (?, ?, 1, '2024', '2024', 'u')`,
            )
            .run(id, name);
        }
        seedThought(ndb, 'Red', { type_id: 'type-a' });
        seedThought(ndb, 'Red too', { type_id: 'type-b' });
        const res = search(ndb, { q: 'red', type_id: ['type-a'] });
        assert.equal(res.by_names.length, 1);
      } finally {
        ndb.close();
      }
    });

    it('rejects an empty query', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.throws(
          () => search(ndb, { q: '   ' }),
          (e: unknown) => (e as Error).message.includes('q must be'),
        );
      } finally {
        ndb.close();
      }
    });

    it('findDuplicates matches by title, synonym and partial', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'Cats');
        seedSynonym(ndb, a, 'Felines');
        const b = seedThought(ndb, 'Domestic cats');
        const hits = findDuplicates(ndb, 'cats');
        const ids = hits.map((h) => h.id);
        assert.ok(ids.includes(a), 'exact title match');
        assert.ok(ids.includes(b), 'partial match on "cat"');
        const aHit = hits.find((h) => h.id === a)!;
        assert.equal(aHit.matched_on, 'title');
        assert.ok(aHit.synonyms.includes('Felines'));

        const synHits = findDuplicates(ndb, 'felines');
        const synHit = synHits.find((h) => h.id === a);
        assert.ok(synHit && synHit.matched_on === 'synonym');
      } finally {
        ndb.close();
      }
    });

    it('findMentions finds the title in other comments', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedThought(ndb, 'ProjectX');
        const other = seedThought(ndb, 'Notes');
        seedThoughtComment(ndb, other, 'see ProjectX for details');
        const mentions = findMentions(ndb, target);
        assert.equal(mentions.length, 1);
        assert.equal(mentions[0]!.owner_type, 'thought');
        assert.equal(mentions[0]!.owner_id, other);
        assert.equal(mentions[0]!.comment_id !== '', true);
        assert.ok(mentions[0]!.snippet.includes('<mark>'));
      } finally {
        ndb.close();
      }
    });

    it('findMentions excludes the target thought itself', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedThought(ndb, 'Self');
        seedThoughtComment(ndb, target, 'Self reference here');
        const mentions = findMentions(ndb, target);
        assert.equal(mentions.length, 0, 'a thought does not "mention" itself in its own comments');
      } finally {
        ndb.close();
      }
    });
  },
);
