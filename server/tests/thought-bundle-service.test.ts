/**
 * Unit tests for the composite "unit of knowledge" bundle service (task O1).
 *
 * Covers: happy path (thought + comment + properties + link + attachment in
 * one call), atomicity on a mid-bundle failure, all three `on_duplicate`
 * policies, and the explicit `thought_id` augmentation path. Skipped entirely
 * when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import { upsertThoughtBundle } from '../src/domain/thought-bundle-service.js';

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
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

const USER = 'user-1';

describe(
  'thought-bundle-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('writes thought + comment + properties + link + attachment in one call', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedThought(ndb, 'HOME');
        const tt = createThoughtType(ndb, { name: 'Книга' }, USER);
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' });

        const result = upsertThoughtBundle(
          ndb,
          {
            thought: { title: 'Дюна', type_id: tt.id },
            comment: { body_md: 'Роман Фрэнка Герберта.' },
            properties: { year: 1965 },
            links: [{ direction: 'parent', target_thought_id: home }],
            attachments: [{ kind: 'url', url: 'https://example.com/dune' }],
          },
          USER,
        );

        assert.equal(result.thought.title, 'Дюна');
        assert.equal(result.thought_action, 'created');
        assert.equal(result.matched_on, null);
        assert.equal(result.comment?.body_md, 'Роман Фрэнка Герберта.');
        assert.equal(result.comment_action, 'created');
        assert.equal(result.properties?.year?.value, 1965);
        assert.equal(result.links?.length, 1);
        // direction: 'parent' — HOME (target) sources a link to the bundle thought.
        assert.equal(result.links?.[0]?.source_id, home);
        assert.equal(result.links?.[0]?.target_id, result.thought.id);
        assert.equal(result.attachments?.length, 1);

        const counts = ndb
          .prepare(
            'SELECT (SELECT COUNT(*) FROM thoughts) AS thoughts, (SELECT COUNT(*) FROM comments) AS comments, ' +
              '(SELECT COUNT(*) FROM links) AS links, (SELECT COUNT(*) FROM attachments) AS attachments',
          )
          .get() as { thoughts: number; comments: number; links: number; attachments: number };
        assert.equal(counts.thoughts, 2); // HOME + Дюна
        assert.equal(counts.comments, 1);
        assert.equal(counts.links, 1);
        assert.equal(counts.attachments, 1);
      } finally {
        ndb.close();
      }
    });

    it('rolls back the whole transaction when a middle step fails (atomicity)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        assert.throws(
          () =>
            upsertThoughtBundle(
              ndb,
              {
                thought: { title: 'Атомарный тест' },
                comment: { body_md: 'Должно откатиться.' },
                links: [{ direction: 'child', target_thought_id: randomUUID() }], // unknown target
              },
              USER,
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
        );

        const counts = ndb
          .prepare(
            'SELECT (SELECT COUNT(*) FROM thoughts) AS thoughts, (SELECT COUNT(*) FROM comments) AS comments',
          )
          .get() as { thoughts: number; comments: number };
        assert.equal(counts.thoughts, 0, 'the thought must not have been created');
        assert.equal(counts.comments, 0, 'the comment must not have been created');
      } finally {
        ndb.close();
      }
    });

    describe('on_duplicate policy', () => {
      it("'fail' (default) errors with candidates and writes nothing", () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const existing = upsertThoughtBundle(ndb, { thought: { title: 'Конкуренты 1С' } }, USER);

          assert.throws(
            () =>
              upsertThoughtBundle(
                ndb,
                { thought: { title: 'Конкуренты 1С' }, comment: { body_md: 'Не должно записаться.' } },
                USER,
              ),
            (e: unknown) => {
              assert.ok(e instanceof EtnError);
              assert.equal(e.code, 'DUPLICATE');
              const candidates = (e.details as { candidates: Array<{ id: string }> }).candidates;
              assert.equal(candidates[0]?.id, existing.thought.id);
              return true;
            },
          );

          const count = ndb.prepare('SELECT COUNT(*) AS c FROM thoughts').get() as { c: number };
          assert.equal(count.c, 1, 'no second thought was created');
          const comments = ndb.prepare('SELECT COUNT(*) AS c FROM comments').get() as { c: number };
          assert.equal(comments.c, 0);
        } finally {
          ndb.close();
        }
      });

      it("'reuse' attaches parts to the existing thought without changing its fields", () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const existing = upsertThoughtBundle(ndb, { thought: { title: 'Конкуренты 1С' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            {
              thought: { title: 'Конкуренты 1С', active: false },
              on_duplicate: 'reuse',
              comment: { body_md: 'Добавлено при повторном импорте.' },
            },
            USER,
          );

          assert.equal(result.thought.id, existing.thought.id);
          assert.equal(result.thought_action, 'reused');
          assert.equal(result.matched_on, 'title');
          assert.equal(result.thought.title, 'Конкуренты 1С');
          assert.equal(result.thought.active, true, 'reuse must not touch the thought fields');
          assert.equal(result.thought.version, 1, 'no update was issued to the thought');
          assert.equal(result.comment?.body_md, 'Добавлено при повторном импорте.');

          const count = ndb.prepare('SELECT COUNT(*) AS c FROM thoughts').get() as { c: number };
          assert.equal(count.c, 1);
        } finally {
          ndb.close();
        }
      });

      it("'update' also patches the existing thought's fields", () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const existing = upsertThoughtBundle(ndb, { thought: { title: 'Конкуренты 1С' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            {
              thought: { title: 'Конкуренты 1С', synonyms: ['конкуренты'], active: false },
              on_duplicate: 'update',
            },
            USER,
          );

          assert.equal(result.thought.id, existing.thought.id);
          assert.equal(result.thought_action, 'updated');
          assert.equal(result.matched_on, 'title');
          assert.equal(result.thought.active, false);
          assert.deepEqual(result.thought.synonyms, ['конкуренты']);
          assert.equal(result.thought.version, 2);

          const count = ndb.prepare('SELECT COUNT(*) AS c FROM thoughts').get() as { c: number };
          assert.equal(count.c, 1);
        } finally {
          ndb.close();
        }
      });
    });

    describe('explicit thought_id (augment in place)', () => {
      it('without `thought` only augments — no title/version change', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const created = upsertThoughtBundle(ndb, { thought: { title: 'Существующая' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            {
              thought_id: created.thought.id,
              properties: {},
              comment: { body_md: 'Дополнение.' },
            },
            USER,
          );

          assert.equal(result.thought.id, created.thought.id);
          assert.equal(result.thought_action, 'reused');
          assert.equal(result.thought.version, 1);
          assert.equal(result.comment?.body_md, 'Дополнение.');
        } finally {
          ndb.close();
        }
      });

      it('with `thought` patches the addressed thought (no dedup check)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const created = upsertThoughtBundle(ndb, { thought: { title: 'Существующая' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            { thought_id: created.thought.id, thought: { title: 'Переименованная' } },
            USER,
          );

          assert.equal(result.thought.id, created.thought.id);
          assert.equal(result.thought_action, 'updated');
          assert.equal(result.thought.title, 'Переименованная');
          assert.equal(result.thought.version, 2);
        } finally {
          ndb.close();
        }
      });

      it('throws NOT_FOUND for an unknown thought_id', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          assert.throws(
            () => upsertThoughtBundle(ndb, { thought_id: randomUUID() }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
          );
        } finally {
          ndb.close();
        }
      });
    });
  },
);
