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
import { getThoughtOrThrow } from '../src/domain/thought-service.js';

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
        createTypeProperty(ndb, 'thought_type', tt.id, { key: 'year', value_type: 'number' }, USER);

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
        assert.equal(result.links?.[0]?.link.source_id, home);
        assert.equal(result.links?.[0]?.link.target_id, result.thought.id);
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

    // Bug 21cbafb8-254b-42e3-a884-3832a3cf6ab5: item-level `active` applies
    // to a NEW thought too (with priority over `thought.active`).
    it('applies item-level `active` to a newly created thought', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'HOME');
        const off = upsertThoughtBundle(ndb, { thought: { title: 'Неактуальная' }, active: false }, USER);
        assert.equal(off.thought_action, 'created');
        assert.equal(off.thought.active, false, 'item-level active must reach the created thought');

        const winner = upsertThoughtBundle(
          ndb,
          { thought: { title: 'Приоритет', active: true }, active: false },
          USER,
        );
        assert.equal(winner.thought.active, false, 'item-level active wins over thought.active');
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

    // Задача bf9f46bd: гейт дублей блокирует создание ТОЛЬКО при точном
    // совпадении нормализованного названия новой мысли с названием или
    // ЛИТЕРАЛЬНЫМ синонимом существующей мысли ТОГО ЖЕ типа. Частичное
    // совпадение, wildcard-маска и точное совпадение при чужом типе не
    // блокируют: мысль создаётся, кандидаты возвращаются в
    // `duplicate_candidates`.
    describe('dedup gate: blocking vs non-blocking (bf9f46bd)', () => {
      it('blocking: exact title of the same (untyped) thought still refuses / reuses', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const existing = upsertThoughtBundle(ndb, { thought: { title: 'Конкуренты 1С' } }, USER);
          assert.throws(
            () => upsertThoughtBundle(ndb, { thought: { title: 'Конкуренты 1С' } }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );
          const reused = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Конкуренты 1С' }, on_duplicate: 'reuse' },
            USER,
          );
          assert.equal(reused.thought.id, existing.thought.id);
          assert.equal(reused.thought_action, 'reused');
          assert.equal(reused.matched_on, 'title');
          assert.equal(reused.duplicate_candidates, undefined, 'a blocking match is not a candidate');
        } finally {
          ndb.close();
        }
      });

      it('non-blocking: exact title at a DIFFERENT type creates a new thought with a candidate', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const pod = createThoughtType(ndb, { name: 'Подсистема' }, USER);
          const term = createThoughtType(ndb, { name: 'Термин' }, USER);
          const existing = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Слои', type_id: pod.id } },
            USER,
          );

          const result = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Слои', type_id: term.id } },
            USER,
          );

          assert.equal(result.thought_action, 'created');
          assert.equal(result.matched_on, null);
          assert.notEqual(result.thought.id, existing.thought.id, 'new thought must be created');
          assert.equal(result.thought.type_id, term.id);
          assert.equal(result.duplicate_candidates?.length, 1);
          const cand = result.duplicate_candidates[0]!;
          assert.equal(cand.id, existing.thought.id);
          assert.equal(cand.matched_on, 'title');
          assert.equal(cand.type_id, pod.id);
        } finally {
          ndb.close();
        }
      });

      it('blocking: exact LITERAL synonym of the same type refuses / reuses', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Термин' }, USER);
          const existing = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Слои изменений', synonyms: ['слои'], type_id: tt.id } },
            USER,
          );

          assert.throws(
            () => upsertThoughtBundle(ndb, { thought: { title: 'слои', type_id: tt.id } }, USER),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );

          const reused = upsertThoughtBundle(
            ndb,
            { thought: { title: 'слои', type_id: tt.id }, on_duplicate: 'reuse' },
            USER,
          );
          assert.equal(reused.thought.id, existing.thought.id);
          assert.equal(reused.thought_action, 'reused');
          assert.equal(reused.matched_on, 'synonym');
        } finally {
          ndb.close();
        }
      });

      it('non-blocking: wildcard-mask synonym of the same type never blocks', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Подсистема' }, USER);
          const existing = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Слои изменений', synonyms: ['layer*'], type_id: tt.id } },
            USER,
          );

          const result = upsertThoughtBundle(
            ndb,
            { thought: { title: 'layering', type_id: tt.id } },
            USER,
          );

          assert.equal(result.thought_action, 'created', '`layer*` must not block `layering`');
          assert.notEqual(result.thought.id, existing.thought.id);
          const cand = result.duplicate_candidates?.find((c) => c.id === existing.thought.id);
          assert.ok(cand, 'the wildcard match is reported as a candidate');
          assert.equal(cand.matched_on, 'synonym');
          assert.equal(cand.matched_synonym, 'layer*');
        } finally {
          ndb.close();
        }
      });

      it('non-blocking: `layer*` does not block the Russian «Слои»', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const existing = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Слои изменений', synonyms: ['layer*'] } },
            USER,
          );

          const result = upsertThoughtBundle(ndb, { thought: { title: 'Слои' } }, USER);

          assert.equal(result.thought_action, 'created');
          assert.notEqual(result.thought.id, existing.thought.id);
          assert.equal(result.duplicate_candidates?.[0]?.id, existing.thought.id);
          assert.equal(result.duplicate_candidates?.[0]?.matched_on, 'partial');
        } finally {
          ndb.close();
        }
      });

      it('non-blocking: on_duplicate=reuse at a partial-only match creates a NEW thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const existing = upsertThoughtBundle(ndb, { thought: { title: 'Конкуренты 1С' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            {
              thought: { title: 'Конкуренты' },
              on_duplicate: 'reuse',
              comment: { body_md: 'новая мысль; чужая не тронута' },
            },
            USER,
          );

          assert.equal(result.thought_action, 'created', 'partial match must not be reused');
          assert.notEqual(result.thought.id, existing.thought.id);
          assert.equal(result.thought.title, 'Конкуренты');
          assert.equal(result.duplicate_candidates?.[0]?.id, existing.thought.id);
          assert.equal(result.duplicate_candidates?.[0]?.matched_on, 'partial');
          // The existing thought's card is untouched: no comment, no version bump.
          assert.equal(getThoughtOrThrow(ndb, existing.thought.id).version, existing.thought.version);
          const commentCount = ndb
            .prepare('SELECT COUNT(*) AS c FROM comments WHERE owner_id = ?')
            .get(existing.thought.id) as { c: number };
          assert.equal(commentCount.c, 0, 'the comment must NOT land on the existing thought');
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

      // Bug faf56a02-e884-488b-9b7b-39dfd5d5b275:
      // `etn.thoughts.write` with `thought_id + active` at item level must
      // toggle the existing thought's `active` flag, even when no nested
      // `thought` patch is supplied (absorbs `etn.thoughts.set_active`).
      it('with item-level `active: false` deactivates the addressed thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const created = upsertThoughtBundle(ndb, { thought: { title: 'Активная' } }, USER);
          assert.equal(created.thought.active, true);

          const result = upsertThoughtBundle(
            ndb,
            { thought_id: created.thought.id, active: false },
            USER,
          );

          assert.equal(result.thought.id, created.thought.id);
          assert.equal(result.thought_action, 'updated');
          assert.equal(result.thought.active, false, 'item-level active must toggle off');
          assert.equal(result.thought.title, 'Активная', 'title must be untouched');
          assert.equal(result.thought.version, 2);
        } finally {
          ndb.close();
        }
      });

      it('with item-level `active: true` reactivates an inactive thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const created = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Неактивная', active: false } },
            USER,
          );
          assert.equal(created.thought.active, false);

          const result = upsertThoughtBundle(
            ndb,
            { thought_id: created.thought.id, active: true },
            USER,
          );

          assert.equal(result.thought.active, true, 'item-level active must toggle on');
          assert.equal(result.thought_action, 'updated');
        } finally {
          ndb.close();
        }
      });

      it('item-level `active` wins over `thought.active` when both are set', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const created = upsertThoughtBundle(ndb, { thought: { title: 'Конфликт' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            {
              thought_id: created.thought.id,
              thought: { title: 'Конфликт', active: true },
              active: false,
            },
            USER,
          );

          assert.equal(result.thought.active, false, 'item-level active wins');
        } finally {
          ndb.close();
        }
      });

      // Bug 870c0c0d-dd2d-46b1-a498-780edcf8e18a: item-level `title` /
      // `synonyms` / `type_id` (the rename half of the removed
      // `etn.thoughts.update`) must patch the addressed thought even when no
      // nested `thought` block is supplied.
      it('with item-level `title` renames the addressed thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const created = upsertThoughtBundle(ndb, { thought: { title: 'Старое имя' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            { thought_id: created.thought.id, title: 'Новое имя' },
            USER,
          );

          assert.equal(result.thought.id, created.thought.id);
          assert.equal(result.thought_action, 'updated');
          assert.equal(result.thought.title, 'Новое имя', 'item-level title must rename');
          assert.equal(result.thought.version, 2);
        } finally {
          ndb.close();
        }
      });

      it('with item-level `synonyms` replaces the whole synonym set', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const created = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Синонимы', synonyms: ['старый', 'лишний'] } },
            USER,
          );
          assert.deepEqual(created.thought.synonyms.sort(), ['лишний', 'старый']);

          const result = upsertThoughtBundle(
            ndb,
            { thought_id: created.thought.id, synonyms: ['новый'] },
            USER,
          );

          assert.deepEqual(result.thought.synonyms, ['новый'], 'synonyms must be replaced');
        } finally {
          ndb.close();
        }
      });

      it('item-level `title`/`synonyms`/`type_id` win over their `thought.*` counterparts', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const tt = createThoughtType(ndb, { name: 'Книга' }, USER);
          const created = upsertThoughtBundle(
            ndb,
            { thought: { title: 'Приоритет', synonyms: ['a'] } },
            USER,
          );

          const result = upsertThoughtBundle(
            ndb,
            {
              thought_id: created.thought.id,
              thought: { title: 'Приоритет', synonyms: ['a'], type_id: null },
              title: 'Победитель',
              synonyms: ['b'],
              type_id: tt.id,
            },
            USER,
          );

          assert.equal(result.thought.title, 'Победитель', 'item-level title wins');
          assert.deepEqual(result.thought.synonyms, ['b'], 'item-level synonyms win');
          assert.equal(result.thought.type_id, tt.id, 'item-level type_id wins');
        } finally {
          ndb.close();
        }
      });

      it('rename to a title colliding with another thought is applied (no dedup on update)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = upsertThoughtBundle(ndb, { thought: { title: 'Первая' } }, USER);
          const b = upsertThoughtBundle(ndb, { thought: { title: 'Вторая' } }, USER);

          const result = upsertThoughtBundle(
            ndb,
            { thought_id: b.thought.id, title: 'Первая' },
            USER,
          );

          // Parity with the removed `etn.thoughts.update` and with
          // `PATCH /thoughts/:id`: a rename does not run `find_duplicates`,
          // so a title collision is allowed (duplicate candidates are only
          // refused on the create path via `on_duplicate: 'fail'`). This
          // test pins that behavior so the widening of item-level fields
          // does not silently change it.
          assert.equal(result.thought.title, 'Первая');
          assert.equal(result.thought.id, b.thought.id);
          assert.equal(a.thought.title, 'Первая');
        } finally {
          ndb.close();
        }
      });
    });
  },
);
