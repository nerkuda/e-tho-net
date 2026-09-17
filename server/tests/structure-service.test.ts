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
  parseStructureFilter,
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
    updated_at: string;
  }> = {},
): string {
  const id = overrides.id ?? randomUUID();
  const title = overrides.title ?? 'Seed';
  const createdAt = overrides.created_at ?? '2024-01-01T00:00:00Z';
  const updatedAt = overrides.updated_at ?? createdAt;
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
      createdAt,
      updatedAt,
    );
  return id;
}

/** Overwrite `updated_at` of an already-seeded thought (задача 7032e55a). */
function setUpdatedAt(ndb: NetworkDb, thoughtId: string, updatedAt: string): void {
  ndb
    .prepare(`UPDATE thoughts SET updated_at = ? WHERE id = ?`)
    .run(updatedAt, thoughtId);
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

/** Insert a property into the registry and return its id (property_id). */
function seedProperty(ndb: NetworkDb, _ownerId: string, key: string, valueType: string): string {
  // 0.6.5: `property_values.property_id` references the registry. The previous
  // owner-binding is irrelevant to the structure filter (no `listEffectiveTypeProperties`
  // assertions in this suite), so we skip the binding here.
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), ?, NULL, NULL, '2024', '2024')`,
    )
    .run(id, key, key, valueType);
  return id;
}

/**
 * Insert a registry property whose `config` declares a non-structural
 * property-link: `link_type_id` + `direction` (default `out`). The
 * `structure-service` filter parses `config` through the same helpers as
 * `query-service` (`property-service.linkPropertyDirection` and т. д.), so
 * here достаточно минимума: id типа связи + направление.
 */
function seedLinkProperty(
  ndb: NetworkDb,
  _ownerId: string,
  key: string,
  linkTypeId: string,
  direction: 'out' | 'in' = 'out',
): string {
  const id = randomUUID();
  const config = JSON.stringify({ link_type_id: linkTypeId, direction });
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), 'link', ?, NULL, '2024', '2024')`,
    )
    .run(id, key, key, config);
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

      it('one condition «Статус = согласовано» matches thoughts of any type attaching the registry property (task 171a438e)', () => {
        // Same registry property id, three thought types — the filter must
        // find every thought that carries the value, regardless of the
        // owner's type. The wire filter no longer scopes by (type, key).
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const typeTask = seedThoughtType(ndb, 'задача');
          const typeBug = seedThoughtType(ndb, 'ошибка');
          const typeTech = seedThoughtType(ndb, 'тех.проект');
          const status = seedProperty(ndb, typeTask, 'Статус', 'text');

          const approvedTask = seedThought(ndb, { title: 'Согласованная задача', type_id: typeTask });
          const draftTask = seedThought(ndb, { title: 'Черновик задачи', type_id: typeTask });
          const approvedBug = seedThought(ndb, { title: 'Согласованная ошибка', type_id: typeBug });
          const approvedTech = seedThought(ndb, { title: 'Согласованный тех.проект', type_id: typeTech });

          seedPropertyValue(ndb, approvedTask, status, 'value_text', 'согласовано');
          seedPropertyValue(ndb, draftTask, status, 'value_text', 'черновик');
          seedPropertyValue(ndb, approvedBug, status, 'value_text', 'согласовано');
          seedPropertyValue(ndb, approvedTech, status, 'value_text', 'согласовано');

          // No type_ids filter — the registry id alone must scope the
          // condition to every matching thought.
          const all = queryThoughts(ndb, USER, query({
            properties: [{ property_id: status, op: 'eq', value: 'согласовано' }],
          }));
          assert.equal(all.total, 3);
          assert.deepEqual(
            all.items.map((i) => i.title).sort(),
            ['Согласованная задача', 'Согласованная ошибка', 'Согласованный тех.проект'].sort(),
          );

          // Adding a type filter narrows but does not change the addressing.
          const onlyTasksAndBugs = queryThoughts(ndb, USER, query({
            type_ids: [typeTask, typeBug],
            properties: [{ property_id: status, op: 'eq', value: 'согласовано' }],
          }));
          assert.equal(onlyTasksAndBugs.total, 2);
          assert.deepEqual(
            onlyTasksAndBugs.items.map((i) => i.title).sort(),
            ['Согласованная задача', 'Согласованная ошибка'],
          );
        } finally {
          ndb.close();
        }
      });

      it('is_empty / not_empty: text/date/number presence test (bug fix 0.6.3)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Лицо');
          const city = seedProperty(ndb, type, 'город', 'text');
          const age = seedProperty(ndb, type, 'возраст', 'number');
          const birthday = seedProperty(ndb, type, 'дата рождения', 'date');

          const filled = seedThought(ndb, { title: 'С-данными', type_id: type });
          seedPropertyValue(ndb, filled, city, 'value_text', 'Москва');
          seedPropertyValue(ndb, filled, age, 'value_number', 30);
          seedPropertyValue(ndb, filled, birthday, 'value_date', '2000-01-01');
          const bare = seedThought(ndb, { title: 'Без свойств', type_id: type });
          // Home has no row at all for any of these properties.

          // not_empty «город» = filled only.
          const filledCity = queryThoughts(ndb, USER, query({
            properties: [{ property_id: city, op: 'not_empty', value: '' }],
          }));
          assert.deepEqual(filledCity.items.map((t) => t.id), [filled]);

          // is_empty «город» = everyone except filled (Home + bare).
          const emptyCity = queryThoughts(ndb, USER, query({
            properties: [{ property_id: city, op: 'is_empty', value: '' }],
          }));
          assert.deepEqual(
            emptyCity.items.map((t) => t.id).sort(),
            [bare, (ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1').get() as { id: string }).id].sort(),
          );

          // Same for number and date — sanity check across value types.
          const filledAge = queryThoughts(ndb, USER, query({
            properties: [{ property_id: age, op: 'not_empty', value: '' }],
          }));
          assert.deepEqual(filledAge.items.map((t) => t.id), [filled]);

          const emptyBirthday = queryThoughts(ndb, USER, query({
            properties: [{ property_id: birthday, op: 'is_empty', value: '' }],
          }));
          assert.equal(emptyBirthday.items.length, 2);
          assert.ok(!emptyBirthday.items.some((t) => t.id === filled));
        } finally {
          ndb.close();
        }
      });

      it('is_empty / not_empty: thought_ref treats single id, JSON array, "[]" and "null" as expected (0.6.3)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Проект');
          const team = seedProperty(ndb, type, 'команда', 'thought_ref');

          const dev1 = seedThought(ndb, { title: 'Разработчик 1' });
          const withSingle = seedThought(ndb, { title: 'С-одним', type_id: type });
          seedPropertyValue(ndb, withSingle, team, 'value_thought_ref', dev1);
          const withArray = seedThought(ndb, { title: 'С-массивом', type_id: type });
          seedPropertyValue(ndb, withArray, team, 'value_thought_ref', JSON.stringify([dev1]));
          const withEmptyArray = seedThought(ndb, { title: 'С-пустым', type_id: type });
          seedPropertyValue(ndb, withEmptyArray, team, 'value_thought_ref', '[]');
          const withNullArray = seedThought(ndb, { title: 'С-null', type_id: type });
          seedPropertyValue(ndb, withNullArray, team, 'value_thought_ref', 'null');
          const bare = seedThought(ndb, { title: 'Без свойства', type_id: type });

          // not_empty: at least one filled id → 2 thoughts (single + array).
          const notEmpty = queryThoughts(ndb, USER, query({
            properties: [{ property_id: team, op: 'not_empty', value: '' }],
          }));
          assert.deepEqual(
            notEmpty.items.map((t) => t.id).sort(),
            [withArray, withSingle].sort(),
          );

          // is_empty: no row OR empty array / null array. The untyped dev1
          // has no row either, so it counts as empty too (the panel only
          // surfaces the property when the thought carries the type, but
          // the SQL filter is uniform across the table — same rule that
          // powers `not_in` for thought_ref in the test above).
          const empty = queryThoughts(ndb, USER, query({
            properties: [{ property_id: team, op: 'is_empty', value: '' }],
          }));
          const home = (
            ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1').get() as { id: string }
          ).id;
          assert.deepEqual(
            empty.items.map((t) => t.id).sort(),
            [bare, dev1, home, withEmptyArray, withNullArray].sort(),
          );
        } finally {
          ndb.close();
        }
      });

      it('link eq/in/not_in/is_empty/not_empty route to links_v (bug fix 31a05292)', () => {
        // Тип свойства-связи задаёт направление (`out`) и тип ребра.
        // Значение хранится в `links`, не в `property_values` — фильтр
        // должен идти через `links_v`, иначе мысли не подберутся вообще.
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Задача');
          const lt = seedLinkType(ndb, 'зависит от');
          const dependsOn = seedLinkProperty(ndb, type, 'зависит от', lt, 'out');

          const tgt1 = seedThought(ndb, { title: 'Цель 1' });
          const tgt2 = seedThought(ndb, { title: 'Цель 2' });
          const withTgt1 = seedThought(ndb, { title: 'Зависит от 1', type_id: type });
          seedLink(ndb, withTgt1, tgt1, { type_id: lt });
          const withTgt2 = seedThought(ndb, { title: 'Зависит от 2', type_id: type });
          seedLink(ndb, withTgt2, tgt2, { type_id: lt });
          // Связь другого типа не должна участвовать в отборе.
          const withWrongLink = seedThought(ndb, { title: 'Другая связь', type_id: type });
          const otherLt = seedLinkType(ndb, 'см. также');
          seedLink(ndb, withWrongLink, tgt1, { type_id: otherLt });
          // Неактивная связь нужного типа — тоже мимо.
          const withInactive = seedThought(ndb, { title: 'Спящая', type_id: type });
          seedLink(ndb, withInactive, tgt1, { type_id: lt, active: 0 });
          const bare = seedThought(ndb, { title: 'Без свойства', type_id: type });
          const home = (
            ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1').get() as { id: string }
          ).id;

          // eq конкретной цели.
          const eqTgt1 = queryThoughts(ndb, USER, query({
            properties: [{ property_id: dependsOn, op: 'eq', value: tgt1 }],
          }));
          assert.deepEqual(eqTgt1.items.map((t) => t.id), [withTgt1]);

          // in: в списке целей — обе «зависит от» мысли.
          const inList = queryThoughts(ndb, USER, query({
            properties: [{ property_id: dependsOn, op: 'in', value: [tgt1, tgt2] }],
          }));
          assert.deepEqual(
            inList.items.map((t) => t.id).sort(),
            [withTgt1, withTgt2].sort(),
          );

          // not_in: связь с указанной целью отсутствует (у остальных —
          // либо ребра нет вообще, либо оно ведёт в другую цель, либо
          // не того типа, либо неактивно). withTgt1 — единственный, у
          // кого ребро нужного типа ведёт в tgt1.
          const notInTgt1 = queryThoughts(ndb, USER, query({
            properties: [{ property_id: dependsOn, op: 'not_in', value: [tgt1] }],
          }));
          assert.deepEqual(
            notInTgt1.items.map((t) => t.id).sort(),
            [bare, home, tgt1, tgt2, withInactive, withTgt2, withWrongLink].sort(),
          );

          // not_empty: есть активное ребро нужного типа (withTgt1, withTgt2).
          const notEmpty = queryThoughts(ndb, USER, query({
            properties: [{ property_id: dependsOn, op: 'not_empty', value: '' }],
          }));
          assert.deepEqual(
            notEmpty.items.map((t) => t.id).sort(),
            [withTgt1, withTgt2].sort(),
          );

          // is_empty: нет активного ребра нужного типа — это и просто
          // отсутствие ребра (Home, цели, bare), и ребро не того типа
          // (withWrongLink), и неактивное ребро (withInactive).
          const empty = queryThoughts(ndb, USER, query({
            properties: [{ property_id: dependsOn, op: 'is_empty', value: '' }],
          }));
          assert.deepEqual(
            empty.items.map((t) => t.id).sort(),
            [bare, home, tgt1, tgt2, withInactive, withWrongLink].sort(),
          );
        } finally {
          ndb.close();
        }
      });

      it('link eq/in/not_in honour the property direction (in vs out) (bug fix 31a05292)', () => {
        // Зеркальное свойство (direction: 'in'): значение — входящее ребро,
        // т. е. мысль — цель ребра, а не источник. Условие должно
        // переворачивать колонки сравнения (target ↔ source).
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const lt = seedLinkType(ndb, 'блокирует');
          const blockedBy = seedLinkProperty(ndb, '00000000-0000-4000-8000-0000000000ba6',
                                              'блокирует', lt, 'in');

          const blocker = seedThought(ndb, { title: 'Блокировщик' });
          const blocked = seedThought(ndb, { title: 'Заблокирован' });
          seedLink(ndb, blocker, blocked, { type_id: lt });
          const unrelated = seedThought(ndb, { title: 'Посторонний' });

          // eq конкретного источника: «найди тех, кого блокирует blocker».
          const eqSource = queryThoughts(ndb, USER, query({
            properties: [{ property_id: blockedBy, op: 'eq', value: blocker }],
          }));
          assert.deepEqual(eqSource.items.map((t) => t.id), [blocked]);

          // not_empty: у `blocked` есть входящее ребро нужного типа; у
          // остальных — нет.
          const notEmpty = queryThoughts(ndb, USER, query({
            properties: [{ property_id: blockedBy, op: 'not_empty', value: '' }],
          }));
          assert.deepEqual(notEmpty.items.map((t) => t.id), [blocked]);

          // is_empty — наоборот.
          const empty = queryThoughts(ndb, USER, query({
            properties: [{ property_id: blockedBy, op: 'is_empty', value: '' }],
          }));
          const home = (
            ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1').get() as { id: string }
          ).id;
          assert.deepEqual(
            empty.items.map((t) => t.id).sort(),
            [blocker, home, unrelated].sort(),
          );
        } finally {
          ndb.close();
        }
      });

      it('link eq rejects empty / non-string value with VALIDATION_ERROR (bug fix 31a05292)', () => {
        // Защита от молчаливого провала: пустая строка или число — не
        // валидное id цели, нужно явное сообщение.
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const lt = seedLinkType(ndb, 'X');
          const prop = seedLinkProperty(ndb, 't', 'X', lt);

          for (const bad of ['', 42, true]) {
            assert.throws(
              () =>
                queryThoughts(ndb, USER, query({
                  properties: [{ property_id: prop, op: 'eq', value: bad as string }],
                })),
              (e: unknown) =>
                e instanceof EtnError && e.code === 'VALIDATION_ERROR' &&
                (e as { details?: { field?: string } }).details?.field === 'value',
              `expected VALIDATION_ERROR for eq value=${JSON.stringify(bad)}`,
            );
          }
        } finally {
          ndb.close();
        }
      });

      it('link in / not_in require a non-empty array (bug fix 31a05292)', () => {
        // Та же защита, что у thought_ref ниже — пустой массив даёт
        // VALIDATION_ERROR, иначе SQL `IN ()` невалиден.
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const lt = seedLinkType(ndb, 'Y');
          const prop = seedLinkProperty(ndb, 't', 'Y', lt);

          for (const op of ['in', 'not_in'] as const) {
            assert.throws(
              () =>
                queryThoughts(ndb, USER, query({
                  properties: [{ property_id: prop, op, value: [] }],
                })),
              (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
              `expected VALIDATION_ERROR for ${op} value=[]`,
            );
          }
        } finally {
          ndb.close();
        }
      });

      it('link property with invalid config never matches (bug fix 31a05292)', () => {
        // config без link_type_id и не структурное: условие не должно
        // тихо вернуть «все» или «никого» — мы возвращаем `0`, фильтр
        // отдаёт пустой результат (это безопасный дефолт).
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          // Хак: создаём registry-строку с value_type='link', но
          // пустым config (валидация онтологии это зарежет, но
          // structure-service не должен падать, если такое дошло).
          const id = randomUUID();
          ndb
            .prepare(
              `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
               VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), 'link', NULL, NULL, '2024', '2024')`,
            )
            .run(id, 'broken', 'broken');

          const result = queryThoughts(ndb, USER, query({
            properties: [{ property_id: id, op: 'is_empty', value: '' }],
          }));
          // Ни одна мысль не матчит — `0` в WHERE.
          assert.equal(result.total, 0);
        } finally {
          ndb.close();
        }
      });

      it('is_empty / not_empty are forbidden on bool values (0.6.3)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const type = seedThoughtType(ndb, 'Лицо');
          const active = seedProperty(ndb, type, 'активен', 'bool');

          assert.throws(
            () =>
              queryThoughts(ndb, USER, query({
                properties: [{ property_id: active, op: 'is_empty', value: '' }],
              })),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
          assert.throws(
            () =>
              queryThoughts(ndb, USER, query({
                properties: [{ property_id: active, op: 'not_empty', value: '' }],
              })),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
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

    describe('queryThoughts: created/updated date bounds (задача 7032e55a)', () => {
      it('created_after / created_before сужают отбор по `thoughts.created_at` (включительно)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = seedThought(ndb, { title: 'A', created_at: '2024-01-01T00:00:00Z' });
          const b = seedThought(ndb, { title: 'B', created_at: '2024-02-15T12:00:00Z' });
          const c = seedThought(ndb, { title: 'C', created_at: '2024-03-30T23:59:59Z' });

          // Граница включительная: '2024-02-01' ловит B и C, но не A.
          const after = queryThoughts(ndb, USER, query({ created_after: '2024-02-01' }));
          assert.deepEqual(
            new Set(after.items.map((t) => t.id)),
            new Set([b, c]),
          );

          // До включительно: '2024-02-15T12:00:00Z' ловит A и B, но не C.
          const before = queryThoughts(ndb, USER, query({ created_before: '2024-02-15T12:00:00Z' }));
          assert.deepEqual(
            new Set(before.items.map((t) => t.id)),
            new Set([a, b]),
          );

          // Обе границы — окно: только B.
          const both = queryThoughts(
            ndb,
            USER,
            query({ created_after: '2024-02-01', created_before: '2024-02-28' }),
          );
          assert.deepEqual(both.items.map((t) => t.id), [b]);
        } finally {
          ndb.close();
        }
      });

      it('updated_after / updated_before используют `updated_at`, не `created_at`', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          // Один и тот же `created_at`, разные `updated_at` — обновляем напрямую.
          const x = seedThought(ndb, { title: 'X', created_at: '2024-01-10T00:00:00Z' });
          setUpdatedAt(ndb, x, '2024-04-01T00:00:00Z');
          const y = seedThought(ndb, { title: 'Y', created_at: '2024-01-10T00:00:00Z' });
          setUpdatedAt(ndb, y, '2024-05-15T00:00:00Z');

          // Без ограничения по created_at — `updated_after` отделяет Y от X.
          const after = queryThoughts(ndb, USER, query({ updated_after: '2024-04-15' }));
          assert.deepEqual(after.items.map((t) => t.id), [y]);

          // updated_before=2024-04-15 — только X (обновлён 1 апреля).
          const before = queryThoughts(ndb, USER, query({ updated_before: '2024-04-15' }));
          assert.deepEqual(before.items.map((t) => t.id), [x]);

          // updated_before=2024-04-01T00:00:00Z (ровно в момент X) — X включается.
          const inclusive = queryThoughts(
            ndb,
            USER,
            query({ updated_before: '2024-04-01T00:00:00Z' }),
          );
          assert.deepEqual(inclusive.items.map((t) => t.id), [x]);
        } finally {
          ndb.close();
        }
      });

      it('даты комбинируются с другими критериями по AND', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const taskType = seedThoughtType(ndb, 'задача');
          const a = seedThought(ndb, {
            title: 'A',
            type_id: taskType,
            created_at: '2024-02-01T00:00:00Z',
          });
          const b = seedThought(ndb, {
            title: 'B',
            type_id: taskType,
            created_at: '2024-02-15T00:00:00Z',
          });
          const c = seedThought(ndb, {
            title: 'C',
            created_at: '2024-02-20T00:00:00Z',
          });

          // type=задача AND created_after=2024-02-10 → только B.
          const result = queryThoughts(
            ndb,
            USER,
            query({ type_ids: [taskType], created_after: '2024-02-10' }),
          );
          assert.deepEqual(result.items.map((t) => t.id), [b]);

          // Границы + keywords.
          const withKw = queryThoughts(
            ndb,
            USER,
            query({ keywords: 'A', created_after: '2024-01-01', created_before: '2024-03-01' }),
          );
          assert.deepEqual(withKw.items.map((t) => t.id), [a]);
        } finally {
          ndb.close();
        }
      });

      it('parseStructureFilter отклоняет не-ISO значение с VALIDATION_ERROR', () => {
        for (const field of ['created_after', 'created_before', 'updated_after', 'updated_before']) {
          assert.throws(
            () => parseStructureFilter({ [field]: 'не-дата' }),
            (e: unknown) =>
              e instanceof EtnError &&
              e.code === 'VALIDATION_ERROR' &&
              (e as { details?: { field?: string } }).details?.field === field,
            `${field}: 'не-дата' → VALIDATION_ERROR`,
          );
          assert.throws(
            () => parseStructureFilter({ [field]: '2024-13-40' }),
            (e: unknown) =>
              e instanceof EtnError &&
              e.code === 'VALIDATION_ERROR' &&
              (e as { details?: { field?: string } }).details?.field === field,
            `${field}: '2024-13-40' → VALIDATION_ERROR (несуществующая дата)`,
          );
          // Не строка → VALIDATION_ERROR.
          assert.throws(
            () => parseStructureFilter({ [field]: 42 }),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
            `${field}: число → VALIDATION_ERROR`,
          );
        }
      });

      it('parseStructureFilter принимает YYYY-MM-DD, полный ISO с T и Z, и пустую строку как «не применять»', () => {
        const cases: Array<
          ['created_after' | 'created_before' | 'updated_after' | 'updated_before', string]
        > = [
          ['created_after', '2024-02-01'],
          ['created_before', '2024-02-01T23:59:59Z'],
          ['updated_after', '2024-02-01T12:00:00.000Z'],
          ['updated_before', '2024-02-01T12:00:00+03:00'],
        ];
        for (const [field, value] of cases) {
          const filter = parseStructureFilter({ [field]: value });
          assert.equal(filter[field], value, `${field}=${value} → принято`);
        }
        // Пустая строка — фильтр не применяется, ключ не выставляется.
        const empty = parseStructureFilter({
          created_after: '   ',
          created_before: '',
          updated_after: '',
          updated_before: '',
        });
        assert.equal(empty.created_after, undefined);
        assert.equal(empty.created_before, undefined);
        assert.equal(empty.updated_after, undefined);
        assert.equal(empty.updated_before, undefined);
      });

      it('isFilterEmpty остаётся `true` без заполненных границ дат', () => {
        // Парсер не выставляет ключ при пустой строке → фильтр пуст.
        const empty = parseStructureFilter({
          created_after: '',
          created_before: '   ',
          updated_after: '',
          updated_before: '',
        });
        // Пустой фильтр + дефолты — попадает в HOME-ветку, total = 1.
        const ndb = createInMemoryNetworkDb();
        try {
          seedThought(ndb, { title: 'Home', is_root: 1 });
          const r = queryThoughts(ndb, USER, {
            ...empty,
            sort: 'alpha',
            order: 'asc',
            limit: 100,
            offset: 0,
          });
          assert.equal(r.total, 1);
        } finally {
          ndb.close();
        }
      });

      it('границы работают в queryThoughtIds (ids-only bulk-команды)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = seedThought(ndb, { title: 'A', created_at: '2024-01-01T00:00:00Z' });
          const b = seedThought(ndb, { title: 'B', created_at: '2024-02-15T12:00:00Z' });
          seedThought(ndb, { title: 'C', created_at: '2024-03-30T23:59:59Z' });

          const ids = queryThoughtIds(
            ndb,
            USER,
            query({ created_after: '2024-02-01', created_before: '2024-02-28' }),
          );
          assert.deepEqual(ids.ids, [b]);
          assert.equal(ids.total, 1);

          // sanity check: A выпадает, B попадает.
          assert.ok(!ids.ids.includes(a));
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
