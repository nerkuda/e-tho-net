/**
 * «Заполнено»/«не заполнено» для операнда «Тип» и NULL-семантика отрицательных
 * ссылочных операторов (ошибка a6866689, решение заказчика 2026-10-25).
 *
 * Контракт (спека 489c394f):
 *   * `type` + `not_empty` («заполнено») — мысль имеет ЛЮБОЙ тип
 *     (`thoughts.type_id IS NOT NULL`);
 *   * `type` + `is_empty` («не заполнено») — мысль БЕЗ типа (`type_id IS NULL`);
 *   * `ne`/`not_in`/`none_of` по типу НЕ включают мысли без типа (SQL `NOT IN`
 *     при NULL отсекает строку) — это осознанное поведение, а не дефект:
 *     «значения нет» выражает отдельное `is_empty`;
 *   * `not_in` со значением-под-выборкой по «Типу» подчиняется ЛИСТОВОЙ
 *     семантике (мысли без типа не проходят) — единое поведение «не в списке».
 *
 * Мутационная проба (проверена при сдаче): удаление ветки
 * `is_empty`/`not_empty` в `filterAstLeafClause` (case `type`) красит группу
 * «заполнено/не заполнено»; возврат NULL-включающего `subqueryTypeClause`
 * (`t.type_id IS NULL OR …`) красит группу «под-выборка».
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  queryThoughts,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, title: string, typeId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u',
               '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), typeId);
  return id;
}

function seedThoughtType(ndb: NetworkDb, name: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, name, name);
  return id;
}

/** Корень AST из узла (версия подставляется автоматически). */
function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Лист-условие по операнду (без labels). */
function leaf(entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode {
  const base: Record<string, unknown> = { entity, operator };
  if (value !== undefined) base['value'] = value;
  return base as unknown as FilterAstNode;
}

/** Значение-под-выборка: набор типов из мыслей под-отбора. */
function typeSubquery(operator: 'in' | 'not_in', roots: readonly string[]): FilterAstNode {
  return leaf(
    { kind: 'type' },
    operator,
    {
      query: leaf({ kind: 'id' }, 'in', [...roots]),
      operator,
    },
  );
}

/** Прогнать AST через единый исполнитель и вернуть отсортированные заголовки. */
function runAst(ndb: NetworkDb, tree: FilterAst): string[] {
  const req: CanonicalQueryRequest = { sort: 'alpha', order: 'asc', limit: 200, offset: 0, ast: tree };
  return queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 200 })
    .items.map((i) => i.title)
    .sort();
}

describe('«Заполнено»/«не заполнено» по типу мысли (a6866689)', { skip: !nativeAvailable() }, () => {
  it('not_empty — только мысли с типом, is_empty — только без типа', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const collection = seedThoughtType(ndb, 'Коллекция');
      const error = seedThoughtType(ndb, 'Ошибка');
      seedThought(ndb, 'typedCollection', collection);
      seedThought(ndb, 'typedError', error);
      seedThought(ndb, 'typeless');

      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'not_empty'))),
        ['typedCollection', 'typedError'],
        '«заполнено» — мысли с ЛЮБЫМ типом',
      );
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'is_empty'))),
        ['typeless'],
        '«не заполнено» — только мысли без типа',
      );
      // Значение для этих операторов не требуется; переданное — игнорируется
      // (как у «Типа связи»).
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'is_empty', [collection]))),
        ['typeless'],
        'значение «заполнено/не заполнено» не влияет на клаузу',
      );
    } finally {
      ndb.close();
    }
  });

  it('операторы комбинируются в группах И/ИЛИ/НЕ', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const collection = seedThoughtType(ndb, 'Коллекция');
      const error = seedThoughtType(ndb, 'Ошибка');
      seedThought(ndb, 'typedCollection', collection);
      seedThought(ndb, 'typedError', error);
      seedThought(ndb, 'typeless');

      // «И»: не пусто И тип = Коллекция — сужение до одного типа.
      assert.deepEqual(
        runAst(
          ndb,
          ast({
            op: 'and',
            children: [leaf({ kind: 'type' }, 'not_empty'), leaf({ kind: 'type' }, 'eq', collection)],
          }),
        ),
        ['typedCollection'],
        'И: «заполнено» + «равно»',
      );
      // «ИЛИ»: без типа ИЛИ тип = Ошибка.
      assert.deepEqual(
        runAst(
          ndb,
          ast({
            op: 'or',
            children: [leaf({ kind: 'type' }, 'is_empty'), leaf({ kind: 'type' }, 'eq', error)],
          }),
        ),
        ['typedError', 'typeless'],
        'ИЛИ: «не заполнено» + «равно»',
      );
      // «НЕ»: отрицание «не заполнено» — ровно мысли с типом.
      assert.deepEqual(
        runAst(ndb, ast({ op: 'not', children: [leaf({ kind: 'type' }, 'is_empty')] })),
        ['typedCollection', 'typedError'],
        'НЕ: отрицание «не заполнено»',
      );
    } finally {
      ndb.close();
    }
  });

  it('отрицательные операторы НЕ включают мысли без типа (осознанная семантика)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const collection = seedThoughtType(ndb, 'Коллекция');
      const error = seedThoughtType(ndb, 'Ошибка');
      seedThought(ndb, 'typedCollection', collection);
      seedThought(ndb, 'typedError', error);
      seedThought(ndb, 'typeless');

      for (const [operator, value] of [
        ['ne', collection],
        ['not_in', [collection]],
        ['none_of', [collection]],
      ] as const) {
        assert.deepEqual(
          runAst(ndb, ast(leaf({ kind: 'type' }, operator, value))),
          ['typedError'],
          `${operator} — мысль без типа не проходит (NULL не «не равно»)`,
        );
      }
      // «Нечего исключать»: пустой набор не сужает выдачу.
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'not_in', []))),
        ['typedCollection', 'typedError', 'typeless'],
        'not_in с пустым списком — проходит любая мысль',
      );
    } finally {
      ndb.close();
    }
  });

  it('под-выборка по типу: not_in подчиняется листовой семантике', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const collection = seedThoughtType(ndb, 'Коллекция');
      const error = seedThoughtType(ndb, 'Ошибка');
      const collectionThought = seedThought(ndb, 'typedCollection', collection);
      seedThought(ndb, 'typedError', error);
      seedThought(ndb, 'typeless');

      assert.deepEqual(
        runAst(ndb, ast(typeSubquery('not_in', [collectionThought]))),
        ['typedError'],
        'not_in под-выборки — как листовой: мысль без типа отсекается',
      );
      // Паритет с листом: тот же набор значений через лист и под-выборку.
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'not_in', [collection]))),
        runAst(ndb, ast(typeSubquery('not_in', [collectionThought]))),
        'not_in листа и под-выборки дают один набор',
      );
    } finally {
      ndb.close();
    }
  });
});
