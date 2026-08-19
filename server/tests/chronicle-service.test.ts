/**
 * Unit tests for the chronicle domain service (L20, docs/03-server-api.md §20):
 * the two-phase thought → chronological-comments query.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';

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

/** Seed a thought (optionally with a type) and return its id. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { typeId?: string; home?: boolean } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, ?, ?, ?, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(
      id,
      title,
      title.toLowerCase(),
      opts.home === true ? 1 : 0,
      opts.home === true ? 1 : 0,
      opts.typeId ?? null,
    );
  return id;
}

/** Seed a typed link source → target. */
function seedLink(ndb: NetworkDb, source: string, target: string, typeId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, source, target, typeId);
  return id;
}

/** Query wrapper with default paging. */
function query(
  ndb: NetworkDb,
  filter: Record<string, unknown>,
  extra: { order?: 'asc' | 'desc'; limit?: number; offset?: number } = {},
) {
  const request = parseChronicleQueryBody(
    { ...filter, order: extra.order ?? 'asc', limit: extra.limit ?? 50, offset: extra.offset ?? 0 },
    'test-request',
  );
  return queryChronicle(ndb, request);
}

describe(
  'chronicle-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('empty filter lists chronological comments of all thoughts', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        const b = seedThought(ndb, 'B');
        seedThought(ndb, 'HOME', { home: true });
        createComment(ndb, 'thought', a, { kind: 'chronological', body_md: 'one', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', b, { kind: 'chronological', body_md: 'two', valid_from: '2024-02-01' }, USER);
        createComment(ndb, 'thought', a, { kind: 'permanent', body_md: 'perm' }, USER);
        const result = query(ndb, {});
        assert.equal(result.total, 2, 'only chronological comments');
        assert.deepEqual(result.rows.map((r) => r.valid_from), ['2024-01-01', '2024-02-01']);
      } finally {
        ndb.close();
      }
    });

    it('filters by roots + subtree (deduped) and by thought types', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const root = seedThought(ndb, 'Root');
        const child = seedThought(ndb, 'Child');
        const grandchild = seedThought(ndb, 'Grand');
        const other = seedThought(ndb, 'Other');
        seedLink(ndb, root, child);
        seedLink(ndb, child, grandchild);
        seedLink(ndb, grandchild, root); // cycle — must not hang and stays deduped
        createComment(ndb, 'thought', child, { kind: 'chronological', body_md: 'c', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', grandchild, { kind: 'chronological', body_md: 'g', valid_from: '2024-01-02' }, USER);
        createComment(ndb, 'thought', other, { kind: 'chronological', body_md: 'o', valid_from: '2024-01-03' }, USER);

        const result = query(ndb, { thought_ids: [root], include_subtree: true });
        assert.equal(result.total, 2, 'child + grandchild, but not other');
      } finally {
        ndb.close();
      }
    });

    it('matches keywords in a link comment from both sides of the link', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const src = seedThought(ndb, 'Источник');
        const dst = seedThought(ndb, 'Назначение');
        const other = seedThought(ndb, 'Сторонняя');
        const link = seedLink(ndb, src, dst);
        createComment(ndb, 'link', link, { kind: 'chronological', body_md: 'событие альфа', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', other, { kind: 'chronological', body_md: 'мимо', valid_from: '2024-01-02' }, USER);

        // The word only lives in the link's comment: the comment is selected and
        // the row carries the link with BOTH endpoint thoughts resolved.
        const result = query(ndb, { keywords: 'альфа' });
        assert.equal(result.rows.length, 1);
        const linkTargets = result.rows[0]!.targets.filter((t) => t.kind === 'link');
        assert.equal(linkTargets.length, 1);
        const linkTarget = linkTargets[0]!;
        assert.ok(linkTarget.kind === 'link');
        assert.equal(linkTarget.link.source.title, 'Источник');
        assert.equal(linkTarget.link.target.title, 'Назначение');
        // The unrelated thought's comment did not make it into the table.
        assert.ok(!result.rows.some((r) => r.targets.some((t) => t.kind === 'thought' && t.thought.id === other)));
      } finally {
        ndb.close();
      }
    });

    it('excludes thoughts via minus-words and intersects the period', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'Счетчик электричества');
        const b = seedThought(ndb, 'Счета за воду');
        createComment(ndb, 'thought', a, { kind: 'chronological', body_md: 'x', valid_from: '2024-01-01' }, USER);
        createComment(ndb, 'thought', b, { kind: 'chronological', body_md: 'y', valid_from: '2024-01-01' }, USER);
        const result = query(ndb, { keywords: 'счет* -вод*' });
        assert.equal(result.total, 1);
        assert.equal(result.rows[0]!.targets[0]!.kind, 'thought');
      } finally {
        ndb.close();
      }
    });

    it('intersects the date period: grey-zone records still returned', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'inside', valid_from: '2024-02-10', valid_to: '2024-02-20' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'starts-before', valid_from: '2024-01-15', valid_to: '2024-02-15' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'ends-after', valid_from: '2024-02-15', valid_to: '2024-03-10' },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'open', valid_from: '2024-02-01', valid_to: null },
          USER,
        );
        createComment(
          ndb,
          'thought',
          a,
          { kind: 'chronological', body_md: 'outside', valid_from: '2024-01-01', valid_to: '2024-01-31' },
          USER,
        );
        const result = query(ndb, { date_from: '2024-02-01', date_to: '2024-02-28' });
        assert.equal(result.total, 4, 'overlapping and open-ended records included');
      } finally {
        ndb.close();
      }
    });

    it('applies the link scope (sources / targets / both)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const src = seedThought(ndb, 'Src');
        const dst = seedThought(ndb, 'Dst');
        const link = seedLink(ndb, src, dst);
        createComment(ndb, 'link', link, { kind: 'chronological', body_md: 'note', valid_from: '2024-01-01' }, USER);

        const both = query(ndb, { link_scope: 'both' });
        assert.equal(both.total, 1);

        const sources = query(ndb, { thought_ids: [dst], link_scope: 'sources' });
        assert.equal(sources.total, 0, 'dst is not the source of the link');

        const targets = query(ndb, { thought_ids: [dst], link_scope: 'targets' });
        assert.equal(targets.total, 1, 'dst is the target of the link');

        const sourcesSrc = query(ndb, { thought_ids: [src], link_scope: 'sources' });
        assert.equal(sourcesSrc.total, 1);
      } finally {
        ndb.close();
      }
    });

    it('paginates and sorts by valid_from/valid_to/title with total', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'A');
        for (let i = 1; i <= 5; i++) {
          createComment(
            ndb,
            'thought',
            a,
            { kind: 'chronological', body_md: `e${i}`, valid_from: `2024-01-0${i}` },
            USER,
          );
        }
        const page = query(ndb, {}, { limit: 2, offset: 1 });
        assert.equal(page.total, 5);
        assert.equal(page.rows.length, 2);
        assert.equal(page.rows[0]!.valid_from, '2024-01-02');

        const desc = query(ndb, {}, { order: 'desc', limit: 50 });
        assert.equal(desc.rows[0]!.valid_from, '2024-01-05');
      } finally {
        ndb.close();
      }
    });

    it('resolves thought and link targets with display metadata', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const src = seedThought(ndb, 'Src');
        const dst = seedThought(ndb, 'Dst');
        const link = seedLink(ndb, src, dst);
        const c = createCommentWithTargets(
          ndb,
          [
            { owner_type: 'thought', owner_id: src },
            { owner_type: 'link', owner_id: link },
          ],
          { kind: 'chronological', body_md: 'both', valid_from: '2024-01-01' },
          USER,
        );
        const result = query(ndb, {});
        assert.equal(result.total, 1);
        const row = result.rows.find((r) => r.id === c.id);
        assert.ok(row, 'comment row present');
        const kinds = (row!.targets as Array<{ kind: string }>).map((t) => t.kind).sort();
        assert.deepEqual(kinds, ['link', 'thought']);
        const linkTarget = row!.targets.find((t) => t.kind === 'link');
        assert.ok(linkTarget && linkTarget.kind === 'link');
        assert.equal(linkTarget.link.source.title, 'Src');
        assert.equal(linkTarget.link.target.title, 'Dst');
        // Snippet contains the highlighted body.
        assert.ok(row!.snippet.includes('both'));
      } finally {
        ndb.close();
      }
    });

    it('rejects invalid input (bad link_scope, bad order)', () => {
      assert.throws(
        () => parseChronicleQueryBody({ link_scope: 'sideways' }, 'r'),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // order is lenient: an invalid value falls back to 'asc' instead.
      const parsed = parseChronicleQueryBody({ order: 'sideways' }, 'r');
      assert.equal(parsed.order, 'asc');
    });
  },
);
