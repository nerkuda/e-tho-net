/**
 * Unit tests for the structures-view domain service (L15).
 *
 * Covers: the empty-filter → HOME shortcut, the keywords mini-syntax (wildcards
 * and exclusions against titles and synonyms), type/link-type/property
 * conditions, sort + paging, hierarchy expansion with per-branch dedup, and
 * the saved-filter CRUD. Skipped entirely when the `better-sqlite3` native
 * binding is unavailable (see AGENTS.md §10).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError, typeNameKey } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  createSavedFilter,
  deleteSavedFilter,
  getHierarchy,
  listSavedFilters,
  parseSavedFilterDefinition,
  queryThoughtIds,
  queryThoughts,
  updateSavedFilter,
} from '../src/domain/structure-service.js';

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
function seedThought(
  ndb: NetworkDb,
  overrides: Partial<{
    id: string;
    title: string;
    type_id: string | null;
    active: number;
    is_root: number;
    created_at: string;
  }> = {},
): string {
  const id = overrides.id ?? randomUUID();
  const title = overrides.title ?? 'Seed';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'u', ?, 'u')`,
    )
    .run(
      id,
      title,
      title.toLowerCase(),
      overrides.type_id ?? null,
      overrides.active ?? 1,
      overrides.is_root ?? 0,
      overrides.is_root ?? 0,
      overrides.created_at ?? '2024-01-01T00:00:00Z',
      overrides.created_at ?? '2024-01-01T00:00:00Z',
    );
  return id;
}

/** Insert a synonym row for a thought. */
function seedSynonym(ndb: NetworkDb, thoughtId: string, synonym: string): void {
  ndb
    .prepare(
      'INSERT INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
    )
    .run(thoughtId, synonym, synonym.toLowerCase());
}

/** Insert a link row (optionally typed). */
function seedLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  overrides: Partial<{ type_id: string | null; active: number }> = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'u', 'u')`,
    )
    .run(id, sourceId, targetId, overrides.type_id ?? null, overrides.active ?? 1);
  return id;
}

/** Insert a thought-type row and return its id. */
function seedThoughtType(ndb: NetworkDb, name: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, name, typeNameKey(name));
  return id;
}

/** Insert a link-type row and return its id. */
function seedLinkType(ndb: NetworkDb, forward: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, forward, typeNameKey(forward), `${forward}-rev`, typeNameKey(`${forward}-rev`));
  return id;
}

/** Insert a thought-type property definition and return its id. */
function seedProperty(ndb: NetworkDb, ownerId: string, key: string, valueType: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO type_properties (id, owner_type, owner_id, key, value_type, position)
       VALUES (?, 'thought_type', ?, ?, ?, 0)`,
    )
    .run(id, ownerId, key, valueType);
  return id;
}

/** Insert a comment row for a thought owner (`permanent` or `chronological`). */
function seedComment(
  ndb: NetworkDb,
  thoughtId: string,
  kind: 'permanent' | 'chronological',
  bodyMd = 'x',
): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, ?, ?, '<p>x</p>', '2024-01-01T00:00:00Z', 1,
               '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'u', 'u')`,
    )
    .run(randomUUID(), thoughtId, kind, bodyMd);
}

/** Insert a URL attachment row for a thought owner. */
function seedAttachment(ndb: NetworkDb, thoughtId: string): void {
  ndb
    .prepare(
      `INSERT INTO attachments (id, owner_type, owner_id, kind, url, position, created_at, created_by)
       VALUES (?, 'thought', ?, 'url', 'https://example.com', 0, '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(randomUUID(), thoughtId);
}

/** Insert a property value row for a thought owner. */
function seedPropertyValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  column: 'value_text' | 'value_date' | 'value_number' | 'value_bool' | 'value_thought_ref',
  value: string | number,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024-01-01T00:00:00Z')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Base query with no criteria defaults filled in by the caller. */
function query(filter: Partial<Parameters<typeof queryThoughts>[2]> = {}) {
  return {
    sort: 'alpha' as const,
    order: 'asc' as const,
    limit: 100,
    offset: 0,
    ...filter,
  };
}

describe(
  'structure-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    describe('queryThoughtIds: ids-only variant (L22)', () => {
      it('returns the same candidate set and ordering as queryThoughts, HOME first', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const home = seedThought(ndb, { title: 'Home', is_root: 1 });
          const orphanA = seedThought(ndb, { title: 'А-Сирота' });
          const orphanB = seedThought(ndb, { title: 'Б-Сирота' });
          const child = seedThought(ndb, { title: 'В-Ребёнок' });
          seedLink(ndb, home, child); // not an orphan

          const refs = queryThoughts(ndb, USER, query());
          const ids = queryThoughtIds(ndb, USER, query());
          assert.equal(ids.total, refs.total);
          assert.deepEqual(ids.ids, refs.items.map((t) => t.id));
          assert.deepEqual(ids.ids, [home, orphanA, orphanB]);

          // Paging walks the same list with the raised ceiling.
          const page = queryThoughtIds(ndb, USER, query({ limit: 2000, offset: 1 }));
          assert.deepEqual(page.ids, [orphanA, orphanB]);
          assert.equal(page.total, 3);
        } finally {
          ndb.close();
        }
      });

      it('applies the keyword criteria exactly like the ref query', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const home = seedThought(ndb, { title: 'Home', is_root: 1 });
          seedThought(ndb, { title: 'Счетчик электричества' });
          seedThought(ndb, { title: 'Счета за воду' });
          const refs = queryThoughts(ndb, USER, query({ keywords: 'счет* -вод*' }));
          const ids = queryThoughtIds(ndb, USER, query({ keywords: 'счет* -вод*' }));
          assert.deepEqual(ids.ids, refs.items.map((t) => t.id));
          assert.ok(!ids.ids.includes(home));
          assert.equal(ids.total, 1);
        } finally {
          ndb.close();
        }
      });
    });

    describe('queryThoughts: empty filter', () => {
      it('returns HOME alone when the network has no orphans', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const home = seedThought(ndb, { title: 'Home', is_root: 1 });
          const other = seedThought(ndb, { title: 'Other' });
          seedLink(ndb, home, other); // Other has a parent → not an orphan
          const result = queryThoughts(ndb, USER, query());
          assert.equal(result.total, 1);
          assert.deepEqual(
            result.items.map((t) => t.id),
            [home],
          );
          // The page carries the direction flags — the tree fills the root
          // ellipses right after the query, before any expansion.
          assert.deepEqual(result.directions[home], {
            has_incoming: false,
            has_outgoing: true,
          });
        } finally {
          ndb.close();
        }
      });

      it('returns HOME first plus orphans (no active parent link), paged and sorted', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const home = seedThought(ndb, { title: 'Home', is_root: 1 });
          const parent = seedThought(ndb, { title: 'А-Родитель' }); // source, no parents → orphan
          const orphan = seedThought(ndb, { title: 'М-Сирота' });
          const inactiveLinked = seedThought(ndb, { title: 'Я-Формальная' });
          seedLink(ndb, parent, inactiveLinked, { active: 0 }); // inactive link ≠ parent
          const child = seedThought(ndb, { title: 'П-Ребёнок' });
          seedLink(ndb, parent, child); // has an active parent → not an orphan
          const sleepingOrphan = seedThought(ndb, { title: 'Б-Спящая', active: 0 });

          // HOME is pinned first, then the active orphans in the requested sort
          // (NOCASE/binary: Latin before Cyrillic).
          const result = queryThoughts(ndb, USER, query());
          assert.deepEqual(
            result.items.map((t) => t.id),
            [home, parent, orphan, inactiveLinked],
          );
          assert.equal(result.total, 4);

          // desc flips the orphans but keeps HOME first.
          const desc = queryThoughts(ndb, USER, query({ order: 'desc' }));
          assert.deepEqual(
            desc.items.map((t) => t.id),
            [home, inactiveLinked, orphan, parent],
          );

          // Pagination walks the combined list.
          const page = queryThoughts(ndb, USER, query({ limit: 2, offset: 1 }));
          assert.deepEqual(page.items.map((t) => t.id), [parent, orphan]);
          assert.equal(page.total, 4);

          // show_inactive adds the inactive orphan (HOME stays first).
          const withInactive = queryThoughts(ndb, USER, query({ show_inactive: true }));
          assert.deepEqual(
            withInactive.items.map((t) => t.id),
            [home, parent, sleepingOrphan, orphan, inactiveLinked],
          );
          assert.equal(withInactive.total, 5);

          // Orphans without parents show empty incoming flags; the link source
          // shows the outgoing one — the tree root ellipses depend on these.
          assert.deepEqual(result.directions[orphan], { has_incoming: false, has_outgoing: false });
          assert.equal(result.directions[parent]?.has_outgoing, true);
        } finally {
          ndb.close();
        }
      });
    });

    describe('queryThoughts: keywords', () => {
      it('matches titles case-insensitively with AND semantics', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const a = seedThought(ndb, { title: 'Счетчик электричества' });
          seedThought(ndb, { title: 'счета за воду' });
          seedThought(ndb, { title: 'Электричество' });

          // Strict infix match: «электричество» does not match the inflected
          // «электричества» — the `*` wildcard covers the rest of the word.
          const strict = queryThoughts(ndb, USER, query({ keywords: 'счет электричество' }));
          assert.deepEqual(strict.items, []);

          const result = queryThoughts(ndb, USER, query({ keywords: 'счет электричеств*' }));
          assert.deepEqual(
            result.items.map((t) => t.id),
            [a],
          );
        } finally {
          ndb.close();
        }
      });

      it('supports the * wildcard and the - exclusion over titles and synonyms', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const a = seedThought(ndb, { title: 'Счетчик электричества' });
          seedThought(ndb, { title: 'счета за воду' });
          // Synonym participates both in include and exclude matching.
          const s = seedThought(ndb, { title: 'Показания' });
          seedSynonym(ndb, s, 'счетчик газа');

          const result = queryThoughts(ndb, USER, query({ keywords: 'счет* -вод*' }));
          assert.deepEqual(
            result.items.map((t) => t.id).sort(),
            [a, s].sort(),
          );

          const onlySynonym = queryThoughts(ndb, USER, query({ keywords: 'показания' }));
          assert.deepEqual(
            onlySynonym.items.map((t) => t.id),
            [s],
          );
        } finally {
          ndb.close();
        }
      });

      it('escapes LIKE wildcards inside keywords', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const a = seedThought(ndb, { title: '100% роста' });
          seedThought(ndb, { title: '100X роста' });

          const result = queryThoughts(ndb, USER, query({ keywords: '100% роста' }));
          assert.deepEqual(
            result.items.map((t) => t.id),
            [a],
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('queryThoughts: keyword_scope (bug fix 0.5.5)', () => {
      it('defaults to title+synonyms and ignores comment text when keyword_scope is absent', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const inComment = seedThought(ndb, { title: 'Абонемент' });
          seedComment(ndb, inComment, 'permanent', 'домашние счета за электричество');

          const result = queryThoughts(ndb, USER, query({ keywords: 'счета' }));
          assert.deepEqual(result.items, []);
        } finally {
          ndb.close();
        }
      });

      it('an empty keyword_scope array falls back to the default title+synonyms scope', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const a = seedThought(ndb, { title: 'Счетчик электричества' });

          const result = queryThoughts(ndb, USER, query({ keywords: 'счет*', keyword_scope: [] }));
          assert.deepEqual(
            result.items.map((t) => t.id),
            [a],
          );
        } finally {
          ndb.close();
        }
      });

      it('searches the permanent comment when "comment" is in keyword_scope, case-insensitively', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const withComment = seedThought(ndb, { title: 'Абонемент' });
          seedComment(ndb, withComment, 'permanent', 'Домашние Счета за Электричество');
          seedThought(ndb, { title: 'Без комментария' });

          const result = queryThoughts(
            ndb,
            USER,
            query({ keywords: 'счета', keyword_scope: ['comment'] }),
          );
          assert.deepEqual(
            result.items.map((t) => t.id),
            [withComment],
          );
        } finally {
          ndb.close();
        }
      });

      it('does not match a chronological comment, only the permanent one', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const chronoOnly = seedThought(ndb, { title: 'Хроника' });
          seedComment(ndb, chronoOnly, 'chronological', 'счета за воду');

          const result = queryThoughts(
            ndb,
            USER,
            query({ keywords: 'счета', keyword_scope: ['comment'] }),
          );
          assert.deepEqual(result.items, []);
        } finally {
          ndb.close();
        }
      });

      it('OR-combines several scopes: title OR synonyms OR comment', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const byTitle = seedThought(ndb, { title: 'Счетчик воды' });
          const bySynonym = seedThought(ndb, { title: 'Показания' });
          seedSynonym(ndb, bySynonym, 'счетчик газа');
          const byComment = seedThought(ndb, { title: 'Абонемент' });
          seedComment(ndb, byComment, 'permanent', 'счетчик тепла');
          seedThought(ndb, { title: 'Не подходит' });

          const result = queryThoughts(
            ndb,
            USER,
            query({ keywords: 'счетчик', keyword_scope: ['title', 'synonyms', 'comment'] }),
          );
          assert.deepEqual(
            result.items.map((t) => t.id).sort(),
            [byTitle, bySynonym, byComment].sort(),
          );
        } finally {
          ndb.close();
        }
      });

      it('- exclusion applies to the selected scope only', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const kept = seedThought(ndb, { title: 'Счетчик электричества' });
          const excludedByComment = seedThought(ndb, { title: 'Счетчик газа' });
          seedComment(ndb, excludedByComment, 'permanent', 'счета за воду');

          const result = queryThoughts(
            ndb,
            USER,
            query({ keywords: 'счет* -вод*', keyword_scope: ['title', 'comment'] }),
          );
          assert.deepEqual(
            result.items.map((t) => t.id),
            [kept],
          );
        } finally {
          ndb.close();
        }
      });

      it('queryThoughtIds applies the same keyword_scope as queryThoughts', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const byComment = seedThought(ndb, { title: 'Абонемент' });
          seedComment(ndb, byComment, 'permanent', 'счета за электричество');

          const refs = queryThoughts(
            ndb,
            USER,
            query({ keywords: 'счета', keyword_scope: ['comment'] }),
          );
          const ids = queryThoughtIds(
            ndb,
            USER,
            query({ keywords: 'счета', keyword_scope: ['comment'] }),
          );
          assert.deepEqual(ids.ids, refs.items.map((t) => t.id));
          assert.deepEqual(ids.ids, [byComment]);
        } finally {
          ndb.close();
        }
      });
    });

    describe('queryThoughts: type / link-type / property conditions', () => {
      it('filters by thought type (OR inside the list)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const t1 = seedThoughtType(ndb, 'Документ');
          const t2 = seedThoughtType(ndb, 'Событие');
          const a = seedThought(ndb, { title: 'Акт', type_id: t1 });
          const b = seedThought(ndb, { title: 'Встреча', type_id: t2 });
          seedThought(ndb, { title: 'Без типа' });

          const result = queryThoughts(ndb, USER, query({ type_ids: [t1, t2] }));
          assert.deepEqual(
            result.items.map((t) => t.id).sort(),
            [a, b].sort(),
          );
        } finally {
          ndb.close();
        }
      });

      it('matches thoughts having an active link of the selected types in either direction', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const lt = seedLinkType(ndb, 'содержит');
          const src = seedThought(ndb, { title: 'Источник' });
          const tgt = seedThought(ndb, { title: 'Назначение' });
          seedThought(ndb, { title: 'Свидетель' });
          seedLink(ndb, src, tgt, { type_id: lt });
          // An inactive typed link does not match.
          const inactive = seedThought(ndb, { title: 'Спящая' });
          seedLink(ndb, inactive, src, { type_id: lt, active: 0 });

          const result = queryThoughts(ndb, USER, query({ link_type_ids: [lt] }));
          assert.deepEqual(
            result.items.map((t) => t.id).sort(),
            [src, tgt].sort(),
          );
          // Direction flags of the page reflect the actual links: src has an
          // outgoing link, tgt an incoming one.
          assert.equal(result.directions[src]?.has_outgoing, true);
          assert.equal(result.directions[tgt]?.has_incoming, true);
        } finally {
          ndb.close();
        }
      });

      it('applies text contains/eq/in/not_in and number gt/lt conditions', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Лицо');
          const city = seedProperty(ndb, type, 'город', 'text');
          const age = seedProperty(ndb, type, 'возраст', 'number');

          const msk = seedThought(ndb, { title: 'Москва', type_id: type });
          const vor = seedThought(ndb, { title: 'Воронеж', type_id: type });
          const tam = seedThought(ndb, { title: 'Тамбов', type_id: type });
          seedPropertyValue(ndb, msk, city, 'value_text', 'Москва');
          seedPropertyValue(ndb, vor, city, 'value_text', 'Воронеж');
          seedPropertyValue(ndb, tam, city, 'value_text', 'Тамбов');
          seedPropertyValue(ndb, msk, age, 'value_number', 30);
          seedPropertyValue(ndb, vor, age, 'value_number', 45);
          seedPropertyValue(ndb, tam, age, 'value_number', 60);

          const inList = queryThoughts(ndb, USER, query({
            properties: [{ property_id: city, op: 'in', value: ['Москва', 'Воронеж'] }],
          }));
          assert.deepEqual(
            inList.items.map((t) => t.id).sort(),
            [msk, vor].sort(),
          );

          const notIn = queryThoughts(ndb, USER, query({
            properties: [{ property_id: city, op: 'not_in', value: ['Тамбов'] }],
          }));
          // not_in also passes thoughts without the property value (Home).
          const home = (
            ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1').get() as { id: string }
          ).id;
          assert.deepEqual(
            notIn.items.map((t) => t.id).sort(),
            [home, msk, vor].sort(),
          );

          const gt = queryThoughts(ndb, USER, query({
            properties: [{ property_id: age, op: 'gt', value: 40 }],
          }));
          assert.deepEqual(
            gt.items.map((t) => t.id).sort(),
            [vor, tam].sort(),
          );

          const eq = queryThoughts(ndb, USER, query({
            properties: [{ property_id: city, op: 'eq', value: 'Москва' }],
          }));
          assert.deepEqual(
            eq.items.map((t) => t.id),
            [msk],
          );
        } finally {
          ndb.close();
        }
      });

      it('thought_ref eq/in/not_in also match ids inside multiple-ref arrays', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Проект');
          const team = seedProperty(ndb, type, 'команда', 'thought_ref');

          const dev1 = seedThought(ndb, { title: 'Разработчик 1' });
          const dev2 = seedThought(ndb, { title: 'Разработчик 2' });
          // A multiple thought_ref value — a JSON array of ids
          // (02-data-model.md §3.5); a single bare id for the other owner.
          const multi = seedThought(ndb, { title: 'Проект А', type_id: type });
          const single = seedThought(ndb, { title: 'Проект Б', type_id: type });
          seedPropertyValue(ndb, multi, team, 'value_thought_ref', JSON.stringify([dev1, dev2]));
          seedPropertyValue(ndb, single, team, 'value_thought_ref', dev2);

          const eq = queryThoughts(ndb, USER, query({
            properties: [{ property_id: team, op: 'eq', value: dev1 }],
          }));
          assert.deepEqual(eq.items.map((t) => t.id), [multi]);

          const inList = queryThoughts(ndb, USER, query({
            properties: [{ property_id: team, op: 'in', value: [dev1, dev2] }],
          }));
          assert.deepEqual(
            inList.items.map((t) => t.id).sort(),
            [multi, single].sort(),
          );

          // not_in excludes a thought only when NONE of its ids is listed;
          // thoughts without the property value (Home, dev1, dev2) pass.
          const notIn = queryThoughts(ndb, USER, query({
            properties: [{ property_id: team, op: 'not_in', value: [dev1] }],
          }));
          const home = (
            ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1').get() as { id: string }
          ).id;
          assert.deepEqual(
            notIn.items.map((t) => t.id).sort(),
            [home, dev1, dev2, single].sort(),
          );
        } finally {
          ndb.close();
        }
      });

      it('rejects an operator incompatible with the value type and ignores deleted properties', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Лицо');
          const num = seedProperty(ndb, type, 'возраст', 'number');
          seedThought(ndb, { title: 'Кто-то' });

          assert.throws(
            () =>
              queryThoughts(ndb, USER, query({
                properties: [{ property_id: num, op: 'contains', value: 'x' }],
              })),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );

          // A condition referencing a deleted property definition is skipped.
          const result = queryThoughts(ndb, USER, query({
            keywords: 'Кто-то',
            properties: [{ property_id: randomUUID(), op: 'eq', value: 'x' }],
          }));
          assert.equal(result.items.length, 1);
        } finally {
          ndb.close();
        }
      });
    });

    describe('queryThoughts: parent_ids scoping', () => {
      it('restricts the candidate set to the union of the given subtrees, roots excluded', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const rootA = seedThought(ndb, { title: 'Корень А' });
          const rootB = seedThought(ndb, { title: 'Корень Б' });
          const childA = seedThought(ndb, { title: 'Ребёнок А' });
          const grandA = seedThought(ndb, { title: 'Внук А' });
          const childB = seedThought(ndb, { title: 'Ребёнок Б' });
          const outside = seedThought(ndb, { title: 'Снаружи' });
          seedLink(ndb, rootA, childA);
          seedLink(ndb, childA, grandA);
          seedLink(ndb, rootB, childB);

          const scoped = queryThoughts(ndb, USER, query({ parent_ids: [rootA] }));
          assert.deepEqual(
            scoped.items.map((t) => t.id).sort(),
            [childA, grandA].sort(),
          );
          // The root itself and unrelated thoughts are not «подчинённые».
          assert.ok(!scoped.items.some((t) => t.id === rootA || t.id === outside));

          const union = queryThoughts(ndb, USER, query({ parent_ids: [rootA, rootB] }));
          assert.deepEqual(
            union.items.map((t) => t.id).sort(),
            [childA, grandA, childB].sort(),
          );

          const unknown = queryThoughts(ndb, USER, query({ parent_ids: [randomUUID()] }));
          assert.deepEqual(unknown.items, []);
        } finally {
          ndb.close();
        }
      });

      it('terminates on a cyclic subtree via the depth cap', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const a = seedThought(ndb, { title: 'А' });
          const b = seedThought(ndb, { title: 'Б' });
          seedLink(ndb, a, b);
          seedLink(ndb, b, a); // cycle
          const result = queryThoughts(ndb, USER, query({ parent_ids: [a] }));
          assert.deepEqual(result.items.map((t) => t.id).sort(), [a, b].sort());
        } finally {
          ndb.close();
        }
      });
    });

    describe('queryThoughts: has_* tri-state filters', () => {
      it('filters by presence/absence of properties, comment, attachments and chronology', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Лицо');
          const prop = seedProperty(ndb, type, 'город', 'text');
          const withProp = seedThought(ndb, { title: 'СПроп', type_id: type });
          seedPropertyValue(ndb, withProp, prop, 'value_text', 'Москва');
          const withComment = seedThought(ndb, { title: 'СКоммент' });
          seedComment(ndb, withComment, 'permanent');
          const withChrono = seedThought(ndb, { title: 'СХроникой' });
          seedComment(ndb, withChrono, 'chronological');
          const withAttachment = seedThought(ndb, { title: 'СВложением' });
          seedAttachment(ndb, withAttachment);
          const bare = seedThought(ndb, { title: 'Пустая' });

          assert.deepEqual(
            queryThoughts(ndb, USER, query({ has_properties: true })).items.map((t) => t.id),
            [withProp],
          );
          assert.deepEqual(
            queryThoughts(ndb, USER, query({ has_comment: true })).items.map((t) => t.id),
            [withComment],
          );
          assert.deepEqual(
            queryThoughts(ndb, USER, query({ has_chronology: true })).items.map((t) => t.id),
            [withChrono],
          );
          assert.deepEqual(
            queryThoughts(ndb, USER, query({ has_attachments: true })).items.map((t) => t.id),
            [withAttachment],
          );
          const noneOf = queryThoughts(
            ndb,
            USER,
            query({ has_comment: false, keywords: 'Пустая' }),
          );
          assert.deepEqual(noneOf.items.map((t) => t.id), [bare]);
        } finally {
          ndb.close();
        }
      });

      it('filters by «Актуальность» overriding the show_inactive default', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const _on = seedThought(ndb, { title: 'Живая' });
          const off = seedThought(ndb, { title: 'Спящая', active: 0 });

          // show_inactive: true includes everything — the default «не важно».
          const any = queryThoughts(ndb, USER, query({ show_inactive: true, keywords: '*' }));
          assert.deepEqual(any.items.map((t) => t.title).sort(), ['Home', 'Живая', 'Спящая'].sort());

          // active: true narrows an inclusive query to active-only…
          const onlyActive = queryThoughts(
            ndb,
            USER,
            query({ show_inactive: true, active: true, keywords: '*' }),
          );
          assert.deepEqual(onlyActive.items.map((t) => t.title).sort(), ['Home', 'Живая'].sort());

          // …and active: false selects the inactive ones alone.
          const onlyInactive = queryThoughts(ndb, USER, query({ active: false, keywords: '*' }));
          assert.deepEqual(onlyInactive.items.map((t) => t.id), [off]);
        } finally {
          ndb.close();
        }
      });
    });

    describe('queryThoughts: sort & paging', () => {
      it('sorts by title asc/desc and pages with total', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          seedThought(ndb, { title: 'Банан' });
          seedThought(ndb, { title: 'Апельсин' });
          seedThought(ndb, { title: 'Вишня' });

          const asc = queryThoughts(ndb, USER, query({ keywords: '*' }));
          // NOCASE collation sorts Latin before Cyrillic.
          assert.deepEqual(
            asc.items.map((t) => t.title),
            ['Home', 'Апельсин', 'Банан', 'Вишня'],
          );
          assert.equal(asc.total, 4);

          const desc = queryThoughts(ndb, USER, query({ keywords: '*', order: 'desc' }));
          assert.deepEqual(
            desc.items.map((t) => t.title),
            ['Вишня', 'Банан', 'Апельсин', 'Home'],
          );

          const page = queryThoughts(ndb, USER, query({ keywords: '*', limit: 2, offset: 2 }));
          assert.deepEqual(
            page.items.map((t) => t.title),
            ['Банан', 'Вишня'],
          );
          assert.equal(page.total, 4);
        } finally {
          ndb.close();
        }
      });
    });

    describe('getHierarchy', () => {
      it('returns children/parents with per-branch dedup applied before the limit', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = seedThought(ndb, { title: 'A' });
          const b = seedThought(ndb, { title: 'Б' });
          const v = seedThought(ndb, { title: 'В' });
          const g = seedThought(ndb, { title: 'Г' });
          seedLink(ndb, a, b);
          seedLink(ndb, a, v);
          seedLink(ndb, b, v);
          seedLink(ndb, b, g);

          const childrenOfB = getHierarchy(ndb, b, 'children', { excludeIds: [a, b, v] });
          // В is already shown in the A branch → only Г is fresh.
          assert.deepEqual(
            childrenOfB.neighbors.map((t) => t.id),
            [g],
          );
          assert.equal(childrenOfB.truncated, false);
          // The edge Б → Г is returned; the edge to the excluded В is not.
          assert.deepEqual(
            childrenOfB.edges.map((e) => `${e.source_id}>${e.target_id}`),
            [`${b}>${g}`],
          );

          const parentsOfG = getHierarchy(ndb, g, 'parents', {});
          assert.deepEqual(
            parentsOfG.neighbors.map((t) => t.id),
            [b],
          );
          // Direction flags drive the tree ellipse fill: Г has parents, Б has children.
          assert.equal(parentsOfG.directions[g]?.has_incoming, true);
          assert.equal(parentsOfG.directions[b]?.has_outgoing, true);
        } finally {
          ndb.close();
        }
      });

      it('marks truncation when the node has more than the limit of fresh neighbors', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const root = seedThought(ndb, { title: 'Root' });
          for (let i = 0; i < 105; i += 1) {
            seedLink(ndb, root, seedThought(ndb, { title: `Ребёнок ${String(i).padStart(3, '0')}` }));
          }
          const data = getHierarchy(ndb, root, 'children', {});
          assert.equal(data.neighbors.length, 100);
          assert.equal(data.truncated, true);
          assert.equal(data.has_more, true);

          const nextPage = getHierarchy(ndb, root, 'children', { offset: 100 });
          assert.equal(nextPage.neighbors.length, 5);
          assert.equal(nextPage.has_more, false);
          assert.equal(nextPage.truncated, false);
          // The two pages together cover every fresh neighbor exactly once.
          const ids = new Set([...data.neighbors, ...nextPage.neighbors].map((n) => n.id));
          assert.equal(ids.size, 105);
        } finally {
          ndb.close();
        }
      });

      it('throws NOT_FOUND for an unknown thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          assert.throws(
            () => getHierarchy(ndb, randomUUID(), 'children', {}),
            (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('saved filters', () => {
      it('CRUDs per-user definitions and rejects duplicate names', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const definition = parseSavedFilterDefinition({
            keywords: 'счет*',
            sort: 'created',
            order: 'desc',
          });
          const created = createSavedFilter(ndb, USER, 'structures', 'Мои счёта', definition);
          assert.equal(created.name, 'Мои счёта');
          assert.deepEqual(listSavedFilters(ndb, USER).map((f) => f.id), [created.id]);

          assert.throws(
            () => createSavedFilter(ndb, USER, 'structures', 'мои СЧЁТА', definition),
            (e: unknown) => e instanceof EtnError && e.code === 'DUPLICATE',
          );

          // Another user neither sees nor edits the filter.
          assert.deepEqual(listSavedFilters(ndb, 'user-2'), []);
          assert.throws(
            () => updateSavedFilter(ndb, 'user-2', created.id, { name: 'Чужое' }),
            (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
          );

          const renamed = updateSavedFilter(ndb, USER, created.id, { name: 'Счета' });
          assert.equal(renamed.name, 'Счета');

          const redefined = updateSavedFilter(ndb, USER, created.id, {
            definition: parseSavedFilterDefinition({ keywords: 'вода', sort: 'alpha', order: 'asc' }),
          });
          assert.equal(redefined.definition.keywords, 'вода');

          deleteSavedFilter(ndb, USER, created.id);
          assert.deepEqual(listSavedFilters(ndb, USER), []);
          assert.throws(
            () => deleteSavedFilter(ndb, USER, created.id),
            (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
          );
        } finally {
          ndb.close();
        }
      });

      it('validates the definition shape and name length', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          assert.throws(
            () => parseSavedFilterDefinition({ sort: 'manual', order: 'asc' }),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
          assert.throws(
            () => createSavedFilter(ndb, USER, 'structures', '   ', parseSavedFilterDefinition({ sort: 'alpha', order: 'asc' })),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });
    });
  },
);
