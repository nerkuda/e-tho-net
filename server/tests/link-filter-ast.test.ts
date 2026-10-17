/**
 * Фильтр типов связей и `link_filter` на общий AST (задача f7da04d6, требование
 * 8c131cff; ADR 3fd7507f, ADR df23db45).
 *
 * Проверяется: (1) плоский `link_filter` компилируется в канонический AST-лист
 * «Тип связи»; (2) клауза обхода (neighbors/subgraph/edges/path) исполняет этот
 * лист и даёт ТОТ ЖЕ результат, что прежняя плоская семантика (независимый
 * эталон); (3) тот же лист исполним общим движком мыслей («у мысли есть
 * инцидентная связь типа»), включая «в иерархии типов связей» и `is_empty`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError, FILTER_AST_VERSION, linkFilterToAst, parseLinkTypeFilterValue, type FilterAst } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { queryThoughts } from '../src/domain/query-service.js';
import { linkTypeFilterClause } from '../src/domain/type-hierarchy.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, NULL, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

function seedLinkType(ndb: NetworkDb, nameF: string, nameR: string, parent: string | null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               parent_id, version, created_at, updated_at, created_by)
       VALUES (?, ?, lower(?), ?, lower(?), ?, 1, '2024', '2024', 'u')`,
    )
    .run(id, nameF, nameF, nameR, nameR, parent);
  return id;
}

function seedLink(ndb: NetworkDb, source: string, target: string, typeId: string | null): string {
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

/** id рёбер, прошедших клаузу обхода (независимое исполнение SQL-фрагмента). */
function edgesMatching(
  ndb: NetworkDb,
  filter: Parameters<typeof linkTypeFilterClause>[1],
): string[] | null {
  const clause = linkTypeFilterClause(ndb, filter, 'l');
  if (clause === null) return null;
  const rows = ndb
    .prepare(`SELECT id FROM links_v l WHERE l.active = 1 AND ${clause.sql} ORDER BY id`)
    .all(...clause.params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

describe('link_filter на общий AST (задача f7da04d6)', { skip: !nativeAvailable() }, () => {
  it('linkFilterToAst: плоский фильтр → канонический AST-лист (независимый эталон)', () => {
    // Эталоны захардкожены (не выведены из билдера) — отключение ветки краснеет.
    assert.deepEqual(
      linkFilterToAst({ type_ids: ['T1', 'T2'], include_structural: true }),
      {
        op: 'or',
        children: [
          { entity: { kind: 'link_type' }, operator: 'in_hierarchy', value: ['T1', 'T2'] },
          { entity: { kind: 'link_type' }, operator: 'is_empty' },
        ],
      },
      'типы (в иерархии) OR структурные',
    );
    assert.deepEqual(
      linkFilterToAst({ type_ids: ['T1'] }),
      { entity: { kind: 'link_type' }, operator: 'in_hierarchy', value: ['T1'] },
      'только типы',
    );
    assert.deepEqual(
      linkFilterToAst({ include_structural: true }),
      { entity: { kind: 'link_type' }, operator: 'is_empty' },
      'только структурные',
    );
    assert.equal(linkFilterToAst(undefined), undefined);
    assert.equal(linkFilterToAst({}), undefined, 'пустой фильтр — не применяется');
  });

  it('клауза обхода исполняет канонический лист: прежняя семантика (идентичность)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const a = seedThought(ndb, 'A');
      const b = seedThought(ndb, 'B');
      const parentType = seedLinkType(ndb, 'Родительский', 'Родительский', null);
      const childType = seedLinkType(ndb, 'Дочерний', 'Дочерний', parentType);
      // Ребро родительского типа, дочернего типа и структурное (без типа).
      const lParent = seedLink(ndb, a, b, parentType);
      const lChild = seedLink(ndb, b, a, childType);
      const lStruct = seedLink(ndb, a, b, null);

      // Эталонные наборы — из прежней плоской семантики (тип + потомки L21,
      // структурные — type_id IS NULL).
      const cases: Array<{ filter: Parameters<typeof linkTypeFilterClause>[1]; expected: string[] | null }> = [
        { filter: undefined, expected: null },
        { filter: { type_ids: [parentType] }, expected: [lParent, lChild].sort() },
        { filter: { type_ids: [childType] }, expected: [lChild] },
        { filter: { include_structural: true }, expected: [lStruct] },
        { filter: { type_ids: [parentType], include_structural: true }, expected: [lParent, lChild, lStruct].sort() },
        { filter: { type_ids: ['11111111-1111-1111-1111-111111111111'] }, expected: [] },
        {
          filter: { type_ids: ['11111111-1111-1111-1111-111111111111'], include_structural: true },
          expected: [lStruct],
        },
      ];
      for (const { filter, expected } of cases) {
        assert.deepEqual(
          edgesMatching(ndb, filter),
          expected,
          `фильтр ${JSON.stringify(filter)} сохранён прежним`,
        );
      }
    } finally {
      ndb.close();
    }
  });

  it('тот же лист в движке мыслей: «есть инцидентная связь типа» (+ иерархия, is_empty)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const a = seedThought(ndb, 'A');
      const b = seedThought(ndb, 'B');
      const lonely = seedThought(ndb, 'Одинокая');
      const parentType = seedLinkType(ndb, 'Родительский', 'Родительский', null);
      const childType = seedLinkType(ndb, 'Дочерний', 'Дочерний', parentType);
      seedLink(ndb, a, b, childType);

      const run = (filter: FilterAst['filter']): string[] =>
        queryThoughts(
          ndb,
          'u',
          {
            sort: 'alpha',
            order: 'asc',
            limit: 100,
            offset: 0,
            ast: { version: FILTER_AST_VERSION, filter },
          },
          { emptyFilterMode: 'all' },
        )
          .items.map((i) => i.title)
          .sort();

      // «В иерархии» по родительскому типу — ребро дочернего типа попадает (L21).
      assert.deepEqual(
        run({ entity: { kind: 'link_type' }, operator: 'in_hierarchy', value: [parentType] }),
        ['A', 'B'],
      );
      // Точный дочерний тип — то же ребро.
      assert.deepEqual(run({ entity: { kind: 'link_type' }, operator: 'in', value: [childType] }), ['A', 'B']);
      // `is_empty` — нет типизированных инцидентных связей (одинокая мысль).
      assert.deepEqual(run({ entity: { kind: 'link_type' }, operator: 'is_empty' }), ['Одинокая']);
      // `not_empty` — есть типизированная связь.
      assert.deepEqual(run({ entity: { kind: 'link_type' }, operator: 'not_empty' }), ['A', 'B']);
      void lonely;
    } finally {
      ndb.close();
    }
  });

  it('пустой link_filter — запрет применения (VALIDATION_ERROR), отсутствие — «все рёбра»', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      // Отсутствие/пустая форма не дают условия — прежний обход по всем рёбрам.
      assert.equal(linkTypeFilterClause(ndb, undefined, 'l'), null);
      assert.equal(linkTypeFilterClause(ndb, {}, 'l'), null);
      // Явно переданный пустой фильтр отвергается доменным парсером (не молча).
      assert.throws(
        () => parseLinkTypeFilterValue({}),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
    } finally {
      ndb.close();
    }
  });
});
