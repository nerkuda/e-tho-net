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

    describe('queryThoughts: empty filter', () => {
      it('returns only the HOME thought', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const home = seedThought(ndb, { title: 'Home', is_root: 1 });
          seedThought(ndb, { title: 'Other' });
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
            has_outgoing: false,
          });
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
          const created = createSavedFilter(ndb, USER, 'Мои счёта', definition);
          assert.equal(created.name, 'Мои счёта');
          assert.deepEqual(listSavedFilters(ndb, USER).map((f) => f.id), [created.id]);

          assert.throws(
            () => createSavedFilter(ndb, USER, 'мои СЧЁТА', definition),
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
            () => createSavedFilter(ndb, USER, '   ', parseSavedFilterDefinition({ sort: 'alpha', order: 'asc' })),
            (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
          );
        } finally {
          ndb.close();
        }
      });
    });
  },
);
