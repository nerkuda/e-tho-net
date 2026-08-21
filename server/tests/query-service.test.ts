/**
 * Unit tests for the structured thought query service (task N1):
 * directed subtree walk with depth, type/active/keyword filters, property
 * value conditions (number/bool/text/thought_ref), date ranges, sorting and
 * the max-nodes bound.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  queryThoughts,
  type QueryBounds,
} from '../src/domain/query-service.js';
import type { ThoughtQueryRequest } from '@etn/shared';
import { typeNameKey } from '@etn/shared';

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
  opts: {
    type_id?: string;
    active?: number;
    created_at?: string;
    updated_at?: string;
  } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(
      id,
      title,
      title.normalize('NFC').trim().toLowerCase(),
      opts.type_id ?? null,
      opts.active ?? 1,
      opts.created_at ?? '2024-01-01T00:00:00.000Z',
      opts.updated_at ?? '2024-01-01T00:00:00.000Z',
    );
  return id;
}

/** Insert a directed link source → target. */
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

/** Insert a synonym for a thought. */
function seedSynonym(ndb: NetworkDb, thoughtId: string, synonym: string): void {
  ndb
    .prepare(
      'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
    )
    .run(thoughtId, synonym, synonym.normalize('NFC').trim().toLowerCase());
}

/** Insert a thought type and return its id. */
function seedThoughtType(ndb: NetworkDb, name: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, name, typeNameKey(name));
  return id;
}

/** Insert a property definition (on a fake thought type) and return its id. */
function seedPropertyDefinition(ndb: NetworkDb, key: string, valueType: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO type_properties (id, owner_type, owner_id, key, value_type, config, required, position)
       VALUES (?, 'thought_type', ?, ?, ?, NULL, 0, 0)`,
    )
    .run(id, randomUUID(), key, valueType);
  return id;
}

/** Insert a property value on a thought. */
function seedPropertyValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  valueType: string,
  value: string | number | boolean,
): void {
  const column =
    valueType === 'number'
      ? 'value_number'
      : valueType === 'bool'
        ? 'value_bool'
        : valueType === 'date'
          ? 'value_date'
          : valueType === 'thought_ref'
            ? 'value_thought_ref'
            : 'value_text';
  const bound = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, bound);
}

const BOUNDS: QueryBounds = { maxNodes: 100 };

function run(ndb: NetworkDb, request: ThoughtQueryRequest) {
  return queryThoughts(ndb, request, BOUNDS);
}

describe('query service (N1)', { skip: !nativeAvailable() }, () => {
  it('lists every thought without filters, sorted by title', () => {
    const ndb = createInMemoryNetworkDb();
    seedThought(ndb, 'Beta');
    seedThought(ndb, 'Alpha');
    const res = run(ndb, {});
    assert.equal(res.total, 2);
    assert.deepEqual(
      res.hits.map((h) => h.title),
      ['Alpha', 'Beta'],
    );
    assert.equal(res.hits[0]?.depth, null);
    assert.equal(res.truncated, false);
  });

  it('walks the directed subtree downwards and reports depth', () => {
    const ndb = createInMemoryNetworkDb();
    const root = seedThought(ndb, 'Root');
    const child = seedThought(ndb, 'Child');
    const grandchild = seedThought(ndb, 'Grandchild');
    seedThought(ndb, 'Detached');
    // Grandchild also has an edge back to root (cycle) — must not loop.
    seedLink(ndb, root, child);
    seedLink(ndb, child, grandchild);
    seedLink(ndb, grandchild, root);

    const res = run(ndb, { in_subtree_of: root, max_depth: 10 });
    const byTitle = new Map(res.hits.map((h) => [h.title, h.depth]));
    assert.equal(res.total, 3);
    assert.equal(byTitle.get('Root'), 0);
    assert.equal(byTitle.get('Child'), 1);
    assert.equal(byTitle.get('Grandchild'), 2);
    assert.ok(!byTitle.has('Detached'));
    assert.equal(res.truncated, false);
  });

  it('filters by type, актуальность and keywords (title + synonym)', () => {
    const ndb = createInMemoryNetworkDb();
    const typeA = seedThoughtType(ndb, 'задача');
    const typeB = seedThoughtType(ndb, 'смета');
    const t1 = seedThought(ndb, 'План работ', { type_id: typeA });
    const _t2 = seedThought(ndb, 'План отдыха', { type_id: typeA, active: 0 });
    seedThought(ndb, 'Смета', { type_id: typeB });
    seedSynonym(ndb, t1, 'roadmap');

    const byType = run(ndb, { type_id: [typeA], active: 'any' });
    assert.deepEqual(byType.hits.map((h) => h.title).sort(), ['План отдыха', 'План работ']);

    const onlyActive = run(ndb, { type_id: [typeA], active: 'true' });
    assert.deepEqual(onlyActive.hits.map((h) => h.title), ['План работ']);
    assert.equal(onlyActive.hits[0]?.active, true);

    const onlyInactive = run(ndb, { type_id: [typeA], active: 'false' });
    assert.deepEqual(onlyInactive.hits.map((h) => h.title), ['План отдыха']);

    const anyActive = run(ndb, { type_id: [typeA], active: 'any' });
    assert.equal(anyActive.total, 2);

    const byWord = run(ndb, { keywords: 'план', active: 'any' });
    assert.deepEqual(byWord.hits.map((h) => h.title).sort(), ['План отдыха', 'План работ']);

    const bySynonym = run(ndb, { keywords: 'roadmap' });
    assert.deepEqual(bySynonym.hits.map((h) => h.title), ['План работ']);

    const byExactWord = run(ndb, { keywords: 'смета' });
    assert.deepEqual(byExactWord.hits.map((h) => h.title), ['Смета']);
  });

  it('filters by property values: number, bool, text contains, thought_ref', () => {
    const ndb = createInMemoryNetworkDb();
    const statusDef = seedPropertyDefinition(ndb, 'status', 'text');
    const priorityDef = seedPropertyDefinition(ndb, 'priority', 'number');
    const doneDef = seedPropertyDefinition(ndb, 'done', 'bool');
    const projectDef = seedPropertyDefinition(ndb, 'project', 'thought_ref');

    const project = seedThought(ndb, 'Проект Альфа');
    const open = seedThought(ndb, 'Задача 1');
    const closed = seedThought(ndb, 'Задача 2');
    seedPropertyValue(ndb, open, statusDef, 'text', 'open');
    seedPropertyValue(ndb, open, priorityDef, 'number', 3);
    seedPropertyValue(ndb, open, doneDef, 'bool', false);
    seedPropertyValue(ndb, open, projectDef, 'thought_ref', project);
    seedPropertyValue(ndb, closed, statusDef, 'text', 'closed');
    seedPropertyValue(ndb, closed, priorityDef, 'number', 8);
    seedPropertyValue(ndb, closed, doneDef, 'bool', true);
    seedLink(ndb, project, open);
    seedLink(ndb, project, closed);

    const high = run(ndb, { properties: [{ key: 'priority', operator: 'gte', value: 5 }] });
    assert.deepEqual(high.hits.map((h) => h.title), ['Задача 2']);

    const openTasks = run(ndb, { properties: [{ key: 'status', operator: 'eq', value: 'open' }] });
    assert.deepEqual(openTasks.hits.map((h) => h.title), ['Задача 1']);

    const contains = run(ndb, { properties: [{ key: 'status', operator: 'contains', value: 'clos' }] });
    assert.deepEqual(contains.hits.map((h) => h.title), ['Задача 2']);

    const undone = run(ndb, { properties: [{ key: 'done', operator: 'eq', value: false }] });
    assert.deepEqual(undone.hits.map((h) => h.title), ['Задача 1']);

    const inProject = run(ndb, {
      properties: [{ key: 'project', operator: 'eq', value: project }],
    });
    assert.deepEqual(inProject.hits.map((h) => h.title), ['Задача 1']);

    // A property key that exists on no thought matches nothing.
    const unknown = run(ndb, { properties: [{ key: 'nope', operator: 'eq', value: 'x' }] });
    assert.equal(unknown.total, 0);

    // Combining a property condition with the subtree filter.
    const combined = run(ndb, {
      in_subtree_of: project,
      properties: [{ key: 'priority', operator: 'lt', value: 5 }],
    });
    assert.deepEqual(combined.hits.map((h) => h.title), ['Задача 1']);
  });

  it('filters by creation/update date ranges', () => {
    const ndb = createInMemoryNetworkDb();
    seedThought(ndb, 'Старая', { created_at: '2024-01-01T00:00:00.000Z' });
    seedThought(ndb, 'Новая', { created_at: '2025-06-15T12:00:00.000Z' });
    const res = run(ndb, { created_after: '2025-01-01T00:00:00.000Z' });
    assert.deepEqual(res.hits.map((h) => h.title), ['Новая']);
    const both = run(ndb, { created_before: '2025-01-01T00:00:00.000Z' });
    assert.deepEqual(both.hits.map((h) => h.title), ['Старая']);
  });

  it('sorts by updated_at desc and pages', () => {
    const ndb = createInMemoryNetworkDb();
    seedThought(ndb, 'A', { updated_at: '2024-01-01T00:00:00.000Z' });
    seedThought(ndb, 'B', { updated_at: '2025-01-01T00:00:00.000Z' });
    seedThought(ndb, 'C', { updated_at: '2026-01-01T00:00:00.000Z' });
    const res = run(ndb, { sort: 'updated_at', order: 'desc' });
    assert.deepEqual(res.hits.map((h) => h.title), ['C', 'B', 'A']);
    const page = run(ndb, { limit: 1, offset: 1, sort: 'title' });
    assert.deepEqual(page.hits.map((h) => h.title), ['B']);
  });

  it('reports truncation when the subtree walk hits maxNodes', () => {
    const ndb = createInMemoryNetworkDb();
    const root = seedThought(ndb, 'Root');
    for (let i = 0; i < 5; i++) {
      seedLink(ndb, root, seedThought(ndb, `Leaf ${i}`));
    }
    const res = queryThoughts(ndb, { in_subtree_of: root }, { maxNodes: 3 });
    assert.equal(res.truncated, true);
    assert.equal(res.reason, 'max_nodes');
    assert.ok(res.total <= 3);
  });
});
