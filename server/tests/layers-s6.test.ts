/**
 * Tests for layer-aware full-text search (task S6, docs/13-layers.md §9):
 *
 * - the names index carries one FTS row per PHYSICAL thought row, so the
 *   search joins it with `thoughts_v` by the winner row's rowid: an
 *   overridden thought is found by the layer's text only (the ancestor's
 *   stale revision never matches), a thought of a sibling layer never leaks,
 *   and a tombstone hides the row even though the base text still matches;
 * - comment-text groups (`by_texts`/`by_links`/`by_chrono`) follow the same
 *   rowid join through `comments_v` (landed in S3) — here the scenarios of
 *   §9 are pinned end-to-end: two variants of one thought with different
 *   texts, deletion in a layer, chronology;
 * - pagination and `meta.total_in_group` run AFTER the layer visibility
 *   filter and the per-logical-id deduplication (a `LIMIT` is never pushed
 *   into the FTS scan): a thought shadowed in the layer yields exactly one
 *   hit, not one per layer's FTS row;
 * - synonyms: the names text is `title + synonyms of the same layer`, so a
 *   synonym edit in a working layer materialises the thought shadow (its FTS
 *   row is rebuilt by the triggers) and tombstoned synonyms stay out of the
 *   aggregate (migration 026).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createComment, updateComment } from '../src/domain/comment-service.js';
import { createLink, deleteLink } from '../src/domain/link-service.js';
import { search } from '../src/domain/search-service.js';
import {
  addSynonyms,
  createThought,
  deleteThought,
  removeSynonym,
  replaceSynonyms,
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

/** The layer ids: A (child of base), B (child of A), C (sibling of A). */
const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_B = '22222222-2222-4222-8222-222222222222';
const LAYER_C = '33333333-3333-4333-8333-333333333333';

/** Seed `layers` with A, B (child of A) and C (child of base, sibling of A). */
function insertHierarchyLayers(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  const ins = ndb.prepare(
    `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
     VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
  );
  ins.run(LAYER_A, BASE_LAYER_ID, 'Слой A', 1, now, now);
  ins.run(LAYER_B, LAYER_A, 'Слой B', 2, now, now);
  ins.run(LAYER_C, BASE_LAYER_ID, 'Слой C', 1, now, now);
}

describe(
  'layers S6 — полнотекстовый поиск по правилам видимости слоя',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('два варианта одной мысли с разными текстами: слой ищет свой текст, основа — свой', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const t = createThought(ndb, { title: 'Альфа-тема' }, USER);
        const cm = createComment(
          ndb,
          'thought',
          t.id,
          { kind: 'permanent', body_md: 'красный маркер тела' },
          USER,
        );

        // Override both the title and the comment body in layer A.
        ndb.useLayer(LAYER_A);
        updateThought(ndb, t.id, { title: 'Бета-тема' }, 1, USER);
        updateComment(ndb, cm.id, { body_md: 'синий маркер тела' }, 1, USER);

        // In A: only the layer's variants are found — the base revision of
        // the same logical rows must not match.
        assert.deepEqual(
          search(ndb, { q: 'альфа', scope: 'names' }).by_names.map((h) => h.thought_id),
          [],
        );
        assert.deepEqual(
          search(ndb, { q: 'бета', scope: 'names' }).by_names.map((h) => h.thought_id),
          [t.id],
        );
        assert.equal(search(ndb, { q: 'бета', scope: 'names' }).by_names[0]?.title, 'Бета-тема');
        assert.equal(search(ndb, { q: 'красный', scope: 'texts' }).by_texts.length, 0);
        assert.deepEqual(
          search(ndb, { q: 'синий', scope: 'texts' }).by_texts.map((h) => h.comment_id),
          [cm.id],
        );

        // The override is inherited by A's descendant (§4.1 chain).
        ndb.useLayer(LAYER_B);
        assert.deepEqual(
          search(ndb, { q: 'бета', scope: 'names' }).by_names.map((h) => h.thought_id),
          [t.id],
        );
        assert.equal(search(ndb, { q: 'синий', scope: 'texts' }).by_texts.length, 1);

        // In the base: the layer's text is invisible, the base's own is found.
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          search(ndb, { q: 'альфа', scope: 'names' }).by_names.map((h) => h.thought_id),
          [t.id],
        );
        assert.equal(search(ndb, { q: 'бета', scope: 'names' }).by_names.length, 0);
        assert.equal(search(ndb, { q: 'красный', scope: 'texts' }).by_texts.length, 1);
        assert.equal(search(ndb, { q: 'синий', scope: 'texts' }).by_texts.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('мысль соседнего слоя не течёт: его текст не ищется ни в основе, ни в братских слоях', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const t = createThought(ndb, { title: 'Каппа-тема' }, USER);

        ndb.useLayer(LAYER_C);
        updateThought(ndb, t.id, { title: 'Лямбда-тема' }, 1, USER);

        // The sibling layer A resolves the base row: C's text is not there.
        ndb.useLayer(LAYER_A);
        assert.deepEqual(
          search(ndb, { q: 'каппа', scope: 'names' }).by_names.map((h) => h.thought_id),
          [t.id],
        );
        assert.equal(search(ndb, { q: 'лямбда', scope: 'names' }).by_names.length, 0);

        // Same for the base; only C itself finds its own variant.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(search(ndb, { q: 'каппа', scope: 'names' }).by_names.length, 1);
        assert.equal(search(ndb, { q: 'лямбда', scope: 'names' }).by_names.length, 0);
        ndb.useLayer(LAYER_C);
        assert.deepEqual(
          search(ndb, { q: 'лямбда', scope: 'names' }).by_names.map((h) => h.thought_id),
          [t.id],
        );
        assert.equal(search(ndb, { q: 'каппа', scope: 'names' }).by_names.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('надгробие исключает строку из выдачи, даже если в основе текст найден (DoD)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const x = createThought(ndb, { title: 'Гамма-тема' }, USER);
        const y = createThought(ndb, { title: 'Дельта-тема' }, USER);
        const link = createLink(ndb, { source_id: x.id, target_id: y.id }, USER);
        createComment(
          ndb,
          'thought',
          x.id,
          { kind: 'permanent', body_md: 'зелёный маркер тела' },
          USER,
        );
        createComment(
          ndb,
          'link',
          link.id,
          { kind: 'permanent', body_md: 'оранжевый маркер тела' },
          USER,
        );

        // Delete everything relevant in layer A: the link first (while its
        // endpoints are still visible), then the thought — the S4 cascade
        // tombstones the comments too.
        ndb.useLayer(LAYER_A);
        deleteLink(ndb, link.id, undefined);
        deleteThought(ndb, x.id, undefined, USER);

        assert.equal(search(ndb, { q: 'гамма', scope: 'names' }).by_names.length, 0);
        assert.equal(search(ndb, { q: 'зелёный', scope: 'texts' }).by_texts.length, 0);
        assert.equal(search(ndb, { q: 'оранжевый', scope: 'links' }).by_links.length, 0);
        assert.equal(search(ndb, { q: 'гамма' }).meta.total_in_group.names, 0);

        // The base keeps every row and finds every text.
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          search(ndb, { q: 'гамма', scope: 'names' }).by_names.map((h) => h.thought_id),
          [x.id],
        );
        assert.equal(search(ndb, { q: 'зелёный', scope: 'texts' }).by_texts.length, 1);
        assert.equal(search(ndb, { q: 'оранжевый', scope: 'links' }).by_links.length, 1);
      } finally {
        ndb.close();
      }
    });

    it('дедупликация и пагинация по логическому id: LIMIT/total после дедупа, не по FTS-строкам', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const t1 = createThought(ndb, { title: 'Дуб Один' }, USER);
        const t2 = createThought(ndb, { title: 'Дуб Два' }, USER);
        const t3 = createThought(ndb, { title: 'Дуб Три' }, USER);

        // t1's new layer title still contains «дуб», so BOTH its FTS rows
        // (base and layer) match the query — the result must stay one hit.
        ndb.useLayer(LAYER_A);
        updateThought(ndb, t1.id, { title: 'Дуб Четыре Слой' }, 1, USER);

        const inA = search(ndb, { q: 'дуб', scope: 'names' });
        assert.equal(inA.meta.total_in_group.names, 3, 'total считается после дедупликации');
        assert.equal(inA.by_names.length, 3);
        const ids = inA.by_names.map((h) => h.thought_id).sort();
        assert.deepEqual(ids, [t1.id, t2.id, t3.id].sort());
        // The overridden thought is served with the layer's title.
        assert.equal(
          inA.by_names.find((h) => h.thought_id === t1.id)?.title,
          'Дуб Четыре Слой',
        );

        // Paging over the deduplicated list: 3 total, pages of 1 cover it.
        const page1 = search(ndb, { q: 'дуб', scope: 'names', limit: 1, offset: 0 });
        const page2 = search(ndb, { q: 'дуб', scope: 'names', limit: 1, offset: 1 });
        const page3 = search(ndb, { q: 'дуб', scope: 'names', limit: 1, offset: 2 });
        const page4 = search(ndb, { q: 'дуб', scope: 'names', limit: 1, offset: 3 });
        assert.equal(page1.meta.total_in_group.names, 3);
        assert.equal(page2.meta.total_in_group.names, 3);
        assert.equal(page1.by_names.length, 1);
        assert.equal(page2.by_names.length, 1);
        assert.equal(page3.by_names.length, 1);
        assert.equal(page4.by_names.length, 0);
        const paged = [page1, page2, page3].flatMap((p) => p.by_names.map((h) => h.thought_id));
        assert.deepEqual(paged.sort(), [t1.id, t2.id, t3.id].sort(), 'each thought exactly once');

        // In the base the layer title does not exist (and no duplicates).
        ndb.useLayer(BASE_LAYER_ID);
        const inBase = search(ndb, { q: 'дуб', scope: 'names' });
        assert.equal(inBase.meta.total_in_group.names, 3);
        assert.equal(
          inBase.by_names.find((h) => h.thought_id === t1.id)?.title,
          'Дуб Один',
        );
        assert.equal(search(ndb, { q: 'четыре', scope: 'names' }).by_names.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('by_texts: total после дедупликации по мысли; перекрытый комментарий ищется своей редакцией', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const a = createThought(ndb, { title: 'Текстовая Раз' }, USER);
        const b = createThought(ndb, { title: 'Текстовая Два' }, USER);
        // Three matching comment rows over TWO thoughts: dedup keeps one hit
        // per thought regardless of the row count (and of layers).
        const perm = createComment(
          ndb,
          'thought',
          a.id,
          { kind: 'permanent', body_md: 'мнд альфа' },
          USER,
        );
        createComment(ndb, 'thought', a.id, { kind: 'chronological', body_md: 'мнд бета' }, USER);
        createComment(ndb, 'thought', b.id, { kind: 'permanent', body_md: 'мнд гамма' }, USER);

        const res = search(ndb, { q: 'мнд', scope: 'texts' });
        assert.equal(res.meta.total_in_group.texts, 2, 'total — по мыслям, не по комментариям');
        assert.equal(res.by_texts.length, 2);
        const page = search(ndb, { q: 'мнд', scope: 'texts', limit: 1, offset: 1 });
        assert.equal(page.meta.total_in_group.texts, 2);
        assert.equal(page.by_texts.length, 1);

        // Override the permanent comment in the layer: A still finds `a` via
        // its chronological comment, but not by the overridden base text.
        ndb.useLayer(LAYER_A);
        updateComment(ndb, perm.id, { body_md: 'мнд дельта' }, 1, USER);
        const inA = search(ndb, { q: 'мнд', scope: 'texts' });
        assert.equal(inA.meta.total_in_group.texts, 2);
        assert.equal(inA.by_texts.length, 2);
        assert.equal(search(ndb, { q: 'альфа', scope: 'texts' }).by_texts.length, 0);
        assert.deepEqual(
          search(ndb, { q: 'дельта', scope: 'texts' }).by_texts.map((h) => h.comment_id),
          [perm.id],
        );

        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(search(ndb, { q: 'альфа', scope: 'texts' }).by_texts.length, 1);
        assert.equal(search(ndb, { q: 'дельта', scope: 'texts' }).by_texts.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('by_chrono: перекрытая в слое хронологическая запись ищется редакцией слоя', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const t = createThought(ndb, { title: 'Хроникёр' }, USER);
        const cm = createComment(
          ndb,
          'thought',
          t.id,
          { kind: 'chronological', body_md: 'репка дедка' },
          USER,
        );

        ndb.useLayer(LAYER_A);
        updateComment(ndb, cm.id, { body_md: 'жучка кошка' }, 1, USER);
        assert.equal(search(ndb, { q: 'репка', scope: 'chronology' }).by_chrono.length, 0);
        assert.deepEqual(
          search(ndb, { q: 'жучка', scope: 'chronology' }).by_chrono.map((h) => h.comment_id),
          [cm.id],
        );

        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          search(ndb, { q: 'репка', scope: 'chronology' }).by_chrono.map((h) => h.comment_id),
          [cm.id],
        );
        assert.equal(search(ndb, { q: 'жучка', scope: 'chronology' }).by_chrono.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('синонимы: правка в слое материализует тень мысли; удалённый в слое синоним не ищется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const s1 = createThought(ndb, { title: 'Синтема', synonyms: ['старый синоним'] }, USER);
        const s2 = createThought(ndb, { title: 'Эпсилон' }, USER);
        const s3 = createThought(ndb, { title: 'Дзета', synonyms: ['хвост'] }, USER);

        // Replace the whole set in the layer: the old (base) synonym must
        // disappear from the layer's search, the new one must appear.
        ndb.useLayer(LAYER_A);
        replaceSynonyms(ndb, s1.id, ['новый синоним']);
        assert.deepEqual(
          search(ndb, { q: 'новый', scope: 'names' }).by_names.map((h) => h.thought_id),
          [s1.id],
        );
        assert.equal(search(ndb, { q: 'старый', scope: 'names' }).by_names.length, 0);

        // Adding a synonym in the layer materialises the thought shadow, so
        // the triggers rebuild the layer's FTS row — the synonym is findable.
        addSynonyms(ndb, s2.id, ['призрак']);
        assert.deepEqual(
          search(ndb, { q: 'призрак', scope: 'names' }).by_names.map((h) => h.thought_id),
          [s2.id],
        );
        assert.equal(search(ndb, { q: 'эпсилон', scope: 'names' }).by_names.length, 1);

        // Removing one synonym in the layer drops it from the layer's text.
        removeSynonym(ndb, s3.id, 'хвост');
        assert.deepEqual(
          search(ndb, { q: 'дзета', scope: 'names' }).by_names.map((h) => h.thought_id),
          [s3.id],
        );
        assert.equal(search(ndb, { q: 'хвост', scope: 'names' }).by_names.length, 0);

        // The base is untouched: its own synonyms are still found there, and
        // the layer-only synonym never leaks back.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(search(ndb, { q: 'старый', scope: 'names' }).by_names.length, 1);
        assert.equal(search(ndb, { q: 'хвост', scope: 'names' }).by_names.length, 1);
        assert.equal(search(ndb, { q: 'новый', scope: 'names' }).by_names.length, 0);
        assert.equal(search(ndb, { q: 'призрак', scope: 'names' }).by_names.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('миграция 026: надгробия синонимов не попадают в агрегат текста fts_thought_names', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertHierarchyLayers(ndb);
        const s = createThought(ndb, { title: 'Омега', synonyms: ['пень'] }, USER);

        ndb.useLayer(LAYER_A);
        replaceSynonyms(ndb, s.id, ['ветка']);

        // Physical FTS rows (test-only direct read): the layer's row text
        // aggregates LIVE synonyms of the layer only — the tombstoned «пень»
        // must not ride along into the index text.
        const ftsText = (layerId: string): string =>
          (
            ndb
              .prepare(
                `SELECT f.text FROM fts_thought_names f
                 JOIN thoughts t ON t.pk = f.rowid
                 WHERE f.thought_id = ? AND f.layer_id = ?`,
              )
              .get(s.id, layerId) as { text: string }
          ).text;
        assert.equal(ftsText(LAYER_A), 'Омега ветка');
        assert.equal(ftsText(BASE_LAYER_ID), 'Омега пень');
      } finally {
        ndb.close();
      }
    });
  },
);
