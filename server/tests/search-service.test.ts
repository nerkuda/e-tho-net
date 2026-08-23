/**
 * Unit tests for the search service (task C9): full-text search across the four
 * groups, subtree/type filters, duplicate detection and mentions.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { typeNameKey } from '@etn/shared';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { findDuplicates, findMentions, findMentionsInTexts, makeSnippet, search } from '../src/domain/search-service.js';

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
              `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
               VALUES (?, ?, ?, 1, '2024', '2024', 'u')`,
            )
            .run(id, name, typeNameKey(name));
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

    it('findDuplicates carries icon/style and one parent_title per candidate', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        ndb
          .prepare(
            `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
             VALUES ('type-a', 'A', 'a', 1, '2024', '2024', 'u')`,
          )
          .run();
        const parent = seedThought(ndb, 'Parent');
        const child = seedThought(ndb, 'Cats', { type_id: 'type-a' });
        ndb
          .prepare(
            `UPDATE thoughts SET icon = '🐱', icon_kind = 'emoji', fg_color = '#123456',
                    font_bold = 1, font_manual = 1 WHERE id = ?`,
          )
          .run(child);
        seedLink(ndb, parent, child);
        const [hit] = findDuplicates(ndb, 'cats');
        assert.equal(hit?.id, child);
        assert.equal(hit?.type_id, 'type-a');
        assert.equal(hit?.icon, '🐱');
        assert.equal(hit?.icon_kind, 'emoji');
        assert.equal(hit?.fg_color, '#123456');
        assert.equal(hit?.font_bold, true);
        // Unset style overrides stay null (inherit the type defaults).
        assert.equal(hit?.font_italic, null);
        assert.equal(hit?.parent_title, 'Parent');
      } finally {
        ndb.close();
      }
    });

    it('findDuplicates filters candidates by thought types (thought_ref pickers)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // thought_types rows must exist before they can be referenced (FK).
        for (const [id, name] of [
          ['type-a', 'A'],
          ['type-b', 'B'],
        ] as const) {
          ndb
            .prepare(
              `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
               VALUES (?, ?, ?, 1, '2024', '2024', 'u')`,
            )
            .run(id, name, typeNameKey(name));
        }
        const a = seedThought(ndb, 'Cats', { type_id: 'type-a' });
        seedThought(ndb, 'Cats again', { type_id: 'type-b' });
        const filtered = findDuplicates(ndb, 'cats', [], ['type-a']);
        assert.deepEqual(filtered.map((h) => h.id), [a]);
        // Without the filter both candidates are returned.
        assert.equal(findDuplicates(ndb, 'cats').length, 2);
        // An unknown type id filters everything out.
        assert.equal(findDuplicates(ndb, 'cats', [], ['type-zzz']).length, 0);
      } finally {
        ndb.close();
      }
    });

    it('findDuplicates matches wildcard synonyms (`*` inside a word)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'Петров Игорь');
        seedSynonym(ndb, a, 'Петров* Игор*');
        seedSynonym(ndb, a, 'Игорян*');
        // Single-word pattern: `Игорян*` covers the whole input word.
        const single = findDuplicates(ndb, 'Игорянский');
        const singleHit = single.find((h) => h.id === a);
        assert.ok(singleHit, 'wildcard synonym matches the input word');
        assert.equal(singleHit!.matched_on, 'synonym');
        assert.equal(singleHit!.matched_synonym, 'Игорян*');
        // Multi-word pattern: adjacent words in the given order.
        const phrase = findDuplicates(ndb, 'Петрова Игоря');
        const phraseHit = phrase.find((h) => h.id === a);
        assert.ok(phraseHit, 'multi-word wildcard synonym matches adjacent words');
        assert.equal(phraseHit!.matched_synonym, 'Петров* Игор*');
        // `*` must not cross word boundaries.
        assert.equal(
          findDuplicates(ndb, 'Петрович передал Игорю').some((h) => h.id === a),
          false,
          'words must stay adjacent — `*` does not span the gap',
        );
        // The pattern word must cover a whole input word.
        assert.equal(
          findDuplicates(ndb, 'СИгорянский').some((h) => h.id === a),
          false,
          'a pattern matches words starting with the pattern only',
        );
      } finally {
        ndb.close();
      }
    });

    it('findDuplicates finds partial matches inside synonyms (08-ui-spec §4.4)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = seedThought(ndb, 'Cats');
        seedSynonym(ndb, a, 'Felines');
        const hits = findDuplicates(ndb, 'line');
        const hit = hits.find((h) => h.id === a);
        assert.ok(hit, 'input substring of a synonym is a partial candidate');
        assert.equal(hit!.matched_on, 'partial');
      } finally {
        ndb.close();
      }
    });

    it('search supports the keywords mini-syntax (-word exclusions)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Alpha dog');
        seedThought(ndb, 'Alpha cat');
        // `-word` excludes the thoughts containing the word.
        const negated = search(ndb, { q: 'alpha -dog' });
        assert.deepEqual(
          negated.by_names.map((h) => h.title),
          ['Alpha cat'],
          'excluded word filters out its thoughts',
        );
        // Words are AND-matched regardless of order/adjacency.
        const reordered = search(ndb, { q: 'cat alpha' });
        assert.equal(reordered.by_names.length, 1);
        // A query of pure exclusions matches nothing (no unary NOT in FTS5).
        const pure = search(ndb, { q: '-dog' });
        assert.equal(pure.by_names.length, 0);
        assert.equal(pure.by_texts.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('search folds `*` wildcards into prefix phrases', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Счетчик электричества');
        seedThought(ndb, 'счета за воду');
        const res = search(ndb, { q: 'счет* -вод*' });
        assert.deepEqual(
          res.by_names.map((h) => h.title),
          ['Счетчик электричества'],
          '`счет* -вод*` matches the §6.10 example',
        );
        // The highlighter uses the folded include word, not the raw `счет*`.
        assert.ok(res.by_names[0]!.snippet.includes('<mark>'));
      } finally {
        ndb.close();
      }
    });

    it('findDuplicates matches every include word, not the whole phrase', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const spread = seedThought(ndb, 'Ivan Petrovich Sidorov');
        seedSynonym(ndb, spread, 'Ваня');
        // Words in the input occur in the title but not as the typed phrase.
        const hits = findDuplicates(ndb, 'ivan sidorov');
        assert.ok(
          hits.some((h) => h.id === spread),
          'all words present (anywhere) → a candidate',
        );
        // One of the words may sit in a synonym while others sit in the title.
        const mixed = findDuplicates(ndb, 'sidorov ваня');
        assert.ok(mixed.some((h) => h.id === spread), 'words may come from the synonyms');
        // A word that is nowhere → not a candidate.
        assert.equal(
          findDuplicates(ndb, 'ivan sidorov smith').some((h) => h.id === spread),
          false,
        );
      } finally {
        ndb.close();
      }
    });

    it('findDuplicates honours `*` wildcards and -word exclusions (§6.10)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const meter = seedThought(ndb, 'Счетчик электричества');
        seedThought(ndb, 'счета за воду');
        const hits = findDuplicates(ndb, 'счет* -вод*');
        assert.deepEqual(
          hits.map((h) => h.id),
          [meter],
          '`счет* -вод*` matches the §6.10 example',
        );
        assert.equal(hits[0]!.matched_on, 'partial');
        // A pure negative query has nothing to anchor to → no candidates.
        assert.equal(findDuplicates(ndb, '-вод').length, 0);
      } finally {
        ndb.close();
      }
    });

    it('findMentions finds wildcard synonyms with word-boundary semantics', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // The title must stay out of the picture (prefix title matching is a
        // separate, looser behavior) so the assertions test the synonym paths.
        const target = seedThought(ndb, 'Объект');
        seedSynonym(ndb, target, 'Петров* Игор*');
        seedSynonym(ndb, target, 'Игорян*');
        // One owning thought per case (mentions collapse per owner).
        const goodOwner = seedThought(ndb, 'Заметки');
        const good = seedThoughtComment(ndb, goodOwner, 'Петрова Игоря видели вчера');
        const badOwner = seedThought(ndb, 'Дневник');
        const bad = seedThoughtComment(ndb, badOwner, 'Петрович передал Игорю');
        const singleOwner = seedThought(ndb, 'Письма');
        const single = seedThoughtComment(ndb, singleOwner, 'Игорянский пришёл');

        const mentions = findMentions(ndb, target);
        const ids = mentions.map((m) => m.comment_id);
        assert.ok(ids.includes(good), 'multi-word wildcard synonym matches adjacent words');
        assert.ok(ids.includes(single), 'single-word wildcard synonym matches');
        assert.ok(
          !ids.includes(bad),
          'words must stay adjacent — `*` does not span the gap',
        );
      } finally {
        ndb.close();
      }
    });

    it('findMentions wildcard synonyms cover mid-word `*` and link comments', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedThought(ndb, 'Х');
        seedSynonym(ndb, target, 'И*ян');
        const other = seedThought(ndb, 'Заметки');
        seedThoughtComment(ndb, other, 'в тексте есть Игорян');
        seedThoughtComment(ndb, other, 'а тут только Иван');
        const link = seedLink(ndb, target, other);
        seedLinkComment(ndb, link, 'ссылка на Игорян');

        const mentions = findMentions(ndb, target);
        assert.equal(mentions.length, 2, 'mid-word `*` matches both owners');
        assert.ok(mentions.some((m) => m.owner_type === 'thought'));
        assert.ok(mentions.some((m) => m.owner_type === 'link'));
      } finally {
        ndb.close();
      }
    });

    it('findMentions carries the owner active flag for thoughts and links', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedThought(ndb, 'Объект');
        const activeOwner = seedThought(ndb, 'Живой');
        seedThoughtComment(ndb, activeOwner, 'тут упомянут Объект');
        const inactiveOwner = seedThought(ndb, 'Архивный', { active: 0 });
        seedThoughtComment(ndb, inactiveOwner, 'и тут Объект');
        const link = seedLink(ndb, target, activeOwner);
        ndb.prepare('UPDATE links SET active = 0 WHERE id = ?').run(link);
        seedLinkComment(ndb, link, 'связь с Объект');

        const mentions = findMentions(ndb, target);
        assert.equal(mentions.length, 3);
        const byOwner = new Map(mentions.map((m) => [`${m.owner_type}:${m.owner_id}`, m]));
        assert.equal(byOwner.get(`thought:${activeOwner}`)!.active, true);
        assert.equal(byOwner.get(`thought:${inactiveOwner}`)!.active, false);
        assert.equal(byOwner.get(`link:${link}`)!.active, false);
      } finally {
        ndb.close();
      }
    });

    it('findMentions matches a multi-word name as a phrase, not separate words', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedThought(ndb, 'Петров Василий');
        seedSynonym(ndb, target, 'Вас*');
        seedSynonym(ndb, target, 'Петров* Вас*');
        // One owning thought per case (mentions collapse per owner).
        const dativeOwner = seedThought(ndb, 'Заметки');
        const dative = seedThoughtComment(ndb, dativeOwner, 'Отдал Петрову Васе');
        const genitiveOwner = seedThought(ndb, 'Дневник');
        const genitive = seedThoughtComment(ndb, genitiveOwner, 'Видел Петрова Василия');
        const singleOwner = seedThought(ndb, 'Письма');
        const single = seedThoughtComment(ndb, singleOwner, 'Васю пригласили');
        // Only one word of the phrase — must NOT match (regression: the title
        // used to be split into OR-tokens, so «Петрову Игорю» was found via
        // the token «Петров» of the title «Петров Василий»).
        const otherPersonOwner = seedThought(ndb, 'Справка');
        const otherPerson = seedThoughtComment(ndb, otherPersonOwner, 'Петрову Игорю');
        const otherFamilyOwner = seedThought(ndb, 'Фото');
        const otherFamily = seedThoughtComment(ndb, otherFamilyOwner, 'Петрова Марина');

        const mentions = findMentions(ndb, target);
        const ids = mentions.map((m) => m.comment_id);
        assert.ok(ids.includes(dative), 'multi-word wildcard synonym matches the phrase');
        assert.ok(ids.includes(genitive), 'title phrase matches');
        assert.ok(ids.includes(single), 'single-word wildcard synonym matches');
        assert.ok(!ids.includes(otherPerson), 'a single word of the phrase must not match');
        assert.ok(!ids.includes(otherFamily), 'a single word of the phrase must not match');
      } finally {
        ndb.close();
      }
    });

    it('findMentions returns one hit per owning thought, not per comment', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const target = seedThought(ndb, 'Петров Василий');
        seedSynonym(ndb, target, 'Петров* Вас*');
        const other = seedThought(ndb, 'Заметки');
        // Two comments of the same thought both mention the target.
        seedThoughtComment(ndb, other, 'Петрову Васе передали привет');
        seedThoughtComment(ndb, other, 'Видел Петрова Василия вчера');
        const mentions = findMentions(ndb, target);
        assert.equal(mentions.length, 1, 'several matching comments collapse into one hit');
        assert.equal(mentions[0]!.owner_id, other);
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

    // -------------------------------------------------------------------
    // findMentionsInTexts (§21, L24) — reverse direction: many thoughts
    // scanned against one caller-supplied text.
    // -------------------------------------------------------------------

    it('findMentionsInTexts matches a plain thought title', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'ProjectX');
        const [matches] = findMentionsInTexts(ndb, ['see ProjectX for details'], {
          showInactive: false,
        });
        assert.equal(matches!.length, 1);
        assert.equal(matches![0]!.thoughts[0]!.id, t);
        assert.equal(matches![0]!.start, 4);
        assert.equal(matches![0]!.end, 12);
      } finally {
        ndb.close();
      }
    });

    it('findMentionsInTexts matches each part of a compound title separately (§2.2.3)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'ETN, План разработки');
        const [matches] = findMentionsInTexts(
          ndb,
          ['Обсудили ETN и План разработки сегодня'],
          { showInactive: false },
        );
        assert.equal(matches!.length, 2, 'both compound-title parts match independently');
        assert.ok(matches!.every((m) => m.thoughts.some((th) => th.id === t)));
      } finally {
        ndb.close();
      }
    });

    it('findMentionsInTexts matches wildcard synonyms (docs/02-data-model.md §3.2)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'Петров Игорь');
        seedSynonym(ndb, t, 'Петров* Игор*');
        seedSynonym(ndb, t, 'Игорян*');
        const [phrase] = findMentionsInTexts(
          ndb,
          ['Сегодня обсудили с Петровым Игорем стратегию развития продукта.'],
          { showInactive: false },
        );
        assert.equal(phrase!.length, 1);
        assert.equal(phrase![0]!.thoughts[0]!.id, t);
        const [single] = findMentionsInTexts(ndb, ['Занял Игоряну 100 рублей до пятницы'], {
          showInactive: false,
        });
        assert.equal(single!.length, 1);
        assert.equal(single![0]!.thoughts[0]!.id, t);
      } finally {
        ndb.close();
      }
    });

    it('findMentionsInTexts respects excludeThoughtId', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'Alpha');
        const [matches] = findMentionsInTexts(ndb, ['about Alpha'], {
          showInactive: false,
          excludeThoughtId: t,
        });
        assert.equal(matches!.length, 0);
      } finally {
        ndb.close();
      }
    });

    it('findMentionsInTexts hides inactive thoughts unless showInactive', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Ghost', { active: 0 });
        const hidden = findMentionsInTexts(ndb, ['a Ghost story'], { showInactive: false });
        assert.equal(hidden[0]!.length, 0);
        const shown = findMentionsInTexts(ndb, ['a Ghost story'], { showInactive: true });
        assert.equal(shown[0]!.length, 1);
        assert.equal(shown[0]![0]!.thoughts[0]!.active, false);
      } finally {
        ndb.close();
      }
    });

    it('findMentionsInTexts prefers the longest match on overlap', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Игорь');
        const long = seedThought(ndb, 'Игорь Петров');
        const [matches] = findMentionsInTexts(ndb, ['встретил Игорь Петров вчера'], {
          showInactive: false,
        });
        assert.equal(matches!.length, 1, 'the shorter overlapping match is dropped');
        assert.deepEqual(
          matches![0]!.thoughts.map((t) => t.id),
          [long],
        );
      } finally {
        ndb.close();
      }
    });

    it('findMentionsInTexts groups same-span matches and caps at 5 thoughts', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        for (const title of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
          const id = seedThought(ndb, title);
          seedSynonym(ndb, id, 'Общее');
        }
        const [matches] = findMentionsInTexts(ndb, ['тут есть Общее слово'], {
          showInactive: false,
        });
        assert.equal(matches!.length, 1, 'all candidates share the same matched span');
        assert.equal(matches![0]!.thoughts.length, 5, 'capped at 5 candidates');
        assert.deepEqual(
          matches![0]!.thoughts.map((t) => t.title),
          ['T1', 'T2', 'T3', 'T4', 'T5'],
        );
      } finally {
        ndb.close();
      }
    });

    it('findMentionsInTexts scans multiple texts independently, in the same order', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb, 'Alpha');
        const results = findMentionsInTexts(
          ndb,
          ['no match here', 'about Alpha', 'Alpha again'],
          { showInactive: false },
        );
        assert.equal(results.length, 3);
        assert.equal(results[0]!.length, 0);
        assert.equal(results[1]!.length, 1);
        assert.equal(results[1]![0]!.thoughts[0]!.id, t);
        assert.equal(results[2]!.length, 1);
      } finally {
        ndb.close();
      }
    });
  },
);

describe('makeSnippet — окно не разрезает wiki-ссылки (pure)', () => {
  const ID = '6c3f9836-6b68-4d95-bec1-35ef35cefe19';
  const OTHER = 'b82df9ab-ab1e-4540-b846-bff2b77dd0e0';

  it('левая граница окна внутри соседней [[#<id>]] → окно расширяется до [[', () => {
    // Сценарий из баг-репорта: соседняя ссылка (60..101) пересекает левую
    // границу окна (105-40=65) — без выравнивания сниппет начинался бы с
    // обрывка «…b82df…]]».
    const body = `${'а'.repeat(60)}[[#${OTHER}]] [[#${ID}]]${'б'.repeat(200)}`;
    const snippet = makeSnippet(body, [ID]);
    assert.ok(/^…\[\[#/.test(snippet), `эллипсис сразу перед полной ссылкой: ${snippet}`);
    assert.ok(snippet.includes(`[[#${OTHER}]]`), snippet);
    assert.ok(snippet.includes(`[[#<mark>${ID}</mark>]]`), snippet);
    assert.ok(!/…[0-9a-f-]{8,}\]\]/.test(snippet), `обрывка uuid нет: ${snippet}`);
  });

  it('правая граница окна внутри [[#<id>]] → окно расширяется до ]]', () => {
    // Вторая ссылка начинается на 301, окно заканчивалось на 323 — внутри
    // неё. После выравнивания сниппет заканчивается полной ссылкой.
    const body = `${'а'.repeat(200)}[[#${ID}]]${'б'.repeat(60)}[[#${ID}]]${'в'.repeat(50)}`;
    const snippet = makeSnippet(body, [ID]);
    assert.ok(snippet.endsWith(`[[#<mark>${ID}</mark>]]…`), snippet);
  });

  it('без wiki-ссылок окно ведёт себя как раньше', () => {
    const body = `${'х'.repeat(100)} слово ${'х'.repeat(200)}`;
    const snippet = makeSnippet(body, ['слово']);
    assert.ok(snippet.startsWith('…'), snippet);
    assert.ok(snippet.endsWith('…'), snippet);
    assert.ok(!snippet.includes('[['), snippet);
  });
});
