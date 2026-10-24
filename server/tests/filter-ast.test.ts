/**
 * Тесты модели AST отбора, валидации формы и единого исполнителя (задача
 * 9c156b8c, тех.проект «Ядро AST и операторы»).
 *
 * Покрывают:
 *   * строгую валидацию формы (`parseFilterAst`) — неизвестные поля на каждом
 *     уровне, аричность групп, версия формы, формы значений;
 *   * булеву свёртку дерева единым исполнителем (`queryThoughts` + `ast`) и
 *     трансляцию листьев по операндам (тип/свойство/родители);
 *   * пограничный сценарий 82187004 — пустая группа, группа из одного условия,
 *     НЕ над группой, вложенные И/ИЛИ/НЕ.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { parseFilterAst } from '../src/domain/filter-ast.js';
import {
  queryThoughts,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';
import { EtnError, FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

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
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), opts.type_id ?? null, opts.active ?? 1);
  return id;
}

function seedLink(ndb: NetworkDb, sourceId: string, targetId: string, typeId: string | null = null): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, typeId);
}

function seedLinkType(ndb: NetworkDb, nameForward: string, nameReverse: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               version, created_at, updated_at, created_by)
       VALUES (?, ?, lower(?), ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, nameForward, nameForward, nameReverse, nameReverse);
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

function seedPropertyDefinition(ndb: NetworkDb, name: string, valueType: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), ?, NULL, NULL, '2024', '2024')`,
    )
    .run(id, name, name, valueType);
  return id;
}

function seedPropertyValue(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/** Собрать корень AST из узла (версия подставляется автоматически). */
function ast(filter: FilterAstNode, sort?: FilterAst['sort']): FilterAst {
  return sort === undefined ? { version: FILTER_AST_VERSION, filter } : { version: FILTER_AST_VERSION, filter, sort };
}

/** Прогнать AST через единый исполнитель и вернуть отсортированные заголовки. */
function runAst(ndb: NetworkDb, tree: FilterAst): { titles: string[]; total: number | null } {
  const req: CanonicalQueryRequest = { sort: 'alpha', order: 'asc', limit: 200, offset: 0, count: true, ast: tree };
  const res = queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 200 });
  return { titles: res.items.map((i) => i.title).sort(), total: res.total };
}

/** Лист-условие по типу: «Тип в списке [...]». */
function typeIn(ids: string[], operator: 'in' | 'not_in' = 'in'): FilterAstNode {
  return { entity: { kind: 'type' }, operator, value: ids };
}

/** Лист-условие по свойству. */
function propertyEq(propertyId: string, value: string): FilterAstNode {
  return { entity: { kind: 'property', property_id: propertyId }, operator: 'eq', value };
}

describe('AST validation (9c156b8c)', () => {
  const validTree: FilterAstNode = {
    op: 'and',
    children: [
      { op: 'not', children: [typeIn(['t1'])] },
      { entity: { kind: 'property', property_id: 'p1' }, operator: 'eq', value: 'x', labels: { entity: 'Статус', value: 'x' } },
    ],
  };

  it('accepts a well-formed tree with labels and sort', () => {
    const parsed = parseFilterAst(ast(validTree, [{ key: 'created_at', order: 'desc' }]));
    assert.equal(parsed.version, FILTER_AST_VERSION);
    assert.deepEqual(parsed.sort, [{ key: 'created_at', order: 'desc' }]);
  });

  it('accepts labels.values (карта id → имя набора) и отвергает нестроковые подписи', () => {
    // Ошибка 4258e694 п.12б: несколько выбранных значений-ссылок несут имена
    // картой `labels.values`; сервер обязан её принять и проверить.
    const tree: FilterAstNode = {
      entity: { kind: 'id' },
      operator: 'in',
      value: ['aaa', 'bbb'],
      labels: { entity: 'Мысль', values: { aaa: 'Первая', bbb: 'Вторая' } },
    };
    const parsed = parseFilterAst(ast(tree));
    const leaf = parsed.filter as { labels?: { values?: Record<string, string> } };
    assert.deepEqual(leaf.labels?.values, { aaa: 'Первая', bbb: 'Вторая' });

    const bad: unknown[] = [
      { version: FILTER_AST_VERSION, filter: { ...tree, labels: { values: { aaa: 1 } } } },
      { version: FILTER_AST_VERSION, filter: { ...tree, labels: { values: 'не карта' } } },
    ];
    for (const input of bad) {
      assert.throws(
        () => parseFilterAst(input),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
    }
  });

  it('accepts the service marker of a place-injected leaf and keeps it (9ddc488e)', () => {
    // Метка `service: true` — «лист впечён местом применения, не пользователем»
    // (редактор отбора типа мысли снимает его при переоткрытии). Сервер обязан
    // принять метку и сохранить форму; любое другое значение — ошибка формы.
    const tree: FilterAstNode = {
      op: 'and',
      children: [
        { entity: { kind: 'keywords', scope: ['title', 'synonyms'] }, operator: 'matches', value: 'смета' },
        { entity: { kind: 'trashed' }, operator: 'eq', value: false, service: true },
      ],
    };
    const parsed = parseFilterAst(ast(tree));
    const group = parsed.filter as { children: Array<{ service?: true }> };
    assert.equal(group.children[1]?.service, true, 'метка служебного листа сохранена при разборе');

    const bad: unknown[] = [
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'trashed' }, operator: 'eq', value: false, service: false } },
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'trashed' }, operator: 'eq', value: false, service: 'yes' } },
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'trashed' }, operator: 'eq', value: false, service: 1 } },
    ];
    for (const input of bad) {
      assert.throws(() => parseFilterAst(input), (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR');
    }
  });

  it('rejects unknown fields at every level', () => {
    const cases: unknown[] = [
      { ...ast(validTree), extra: 1 },
      { version: FILTER_AST_VERSION, filter: { op: 'and', children: [], extra: 1 } },
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'type' }, operator: 'in', value: ['a'], extra: 1 } },
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'type', extra: 1 }, operator: 'in', value: ['a'] } },
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'property', property_id: 'p', extra: 1 }, operator: 'eq', value: 'x' } },
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'type' }, operator: 'in', value: ['a'], labels: { extra: 'x' } } },
      { version: FILTER_AST_VERSION, filter: validTree, sort: [{ key: 'title', order: 'asc', extra: 1 }] },
    ];
    for (const input of cases) {
      assert.throws(() => parseFilterAst(input), (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR');
    }
  });

  it('rejects arity/op/version/entity/value defects', () => {
    const bad: unknown[] = [
      { version: 99, filter: validTree }, // чужая версия формы
      { version: FILTER_AST_VERSION }, // нет дерева
      { version: FILTER_AST_VERSION, filter: { op: 'xor', children: [] } }, // недопустимая группа
      { version: FILTER_AST_VERSION, filter: { op: 'not', children: [typeIn(['a']), typeIn(['b'])] } }, // not с 2 детьми
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'unknown' }, operator: 'in', value: ['a'] } }, // незнакомый операнд
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'type' }, operator: 'nope', value: ['a'] } }, // недопустимый оператор
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'type' }, operator: 'in', value: [{ oops: 1 }] } }, // список не из скаляров
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'property' }, operator: 'eq', value: 'x' } }, // свойство без адреса
      { version: FILTER_AST_VERSION, filter: { entity: { kind: 'keywords', scope: ['nowhere'] }, operator: 'matches', value: 'x' } },
    ];
    for (const input of bad) {
      assert.throws(() => parseFilterAst(input), (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR');
    }
  });

  it('accepts token and subquery value shapes', () => {
    const parsed = parseFilterAst({
      version: FILTER_AST_VERSION,
      filter: {
        op: 'or',
        children: [
          { entity: { kind: 'created_at' }, operator: 'gte', value: { token: '$today' } },
          { entity: { kind: 'property', property_id: 'p' }, operator: 'in', value: { query: typeIn(['t']), operator: 'in' } },
        ],
      },
    });
    assert.ok(parsed.filter);
  });
});

describe('AST executor (9c156b8c)', { skip: !nativeAvailable() }, () => {
  function seedNetwork(): {
    ndb: NetworkDb;
    task: string;
    bug: string;
    status: string;
    t1: string;
    t2: string;
    t3: string;
    t4: string;
    t5: string;
  } {
    const ndb = createInMemoryNetworkDb();
    const task = seedThoughtType(ndb, 'задача');
    const bug = seedThoughtType(ndb, 'ошибка');
    const status = seedPropertyDefinition(ndb, 'Статус', 'text');
    const t1 = seedThought(ndb, 'T1 на согласовании', { type_id: task });
    const t2 = seedThought(ndb, 'T2 закрыта', { type_id: task });
    const t3 = seedThought(ndb, 'B3 расследуется', { type_id: bug });
    const t4 = seedThought(ndb, 'B4 зарегистрирована', { type_id: bug });
    const t5 = seedThought(ndb, 'B5 закрыта', { type_id: bug });
    seedPropertyValue(ndb, t1, status, 'на согласовании');
    seedPropertyValue(ndb, t2, status, 'закрыто');
    seedPropertyValue(ndb, t3, status, 'расследуется');
    seedPropertyValue(ndb, t4, status, 'зарегистрирована');
    seedPropertyValue(ndb, t5, status, 'закрыто');
    return { ndb, task, bug, status, t1, t2, t3, t4, t5 };
  }

  it('evaluates the main OR-of-AND scenario (9255cdcd) by boolean folding', () => {
    const { ndb, task, bug, status } = seedNetwork();
    const tree = ast({
      op: 'or',
      children: [
        { op: 'and', children: [typeIn([task]), propertyEq(status, 'на согласовании')] },
        {
          op: 'and',
          children: [
            typeIn([bug]),
            { entity: { kind: 'property', property_id: status }, operator: 'in', value: ['зарегистрирована', 'расследуется'] },
          ],
        },
      ],
    });
    assert.deepEqual(runAst(ndb, tree).titles, ['B3 расследуется', 'B4 зарегистрирована', 'T1 на согласовании']);
  });

  it('boundary 82187004: empty group is neutral, single-child group is that child, NOT negates the subtree', () => {
    const { ndb, task, status } = seedNetwork();
    // 1. Пустая группа нейтральна: AND-empty — все, OR-empty — никто.
    assert.equal(runAst(ndb, ast({ op: 'and', children: [] })).total, 5);
    assert.equal(runAst(ndb, ast({ op: 'or', children: [] })).total, 0);
    // 2. Группа из одного условия эквивалентна условию.
    assert.deepEqual(runAst(ndb, ast({ op: 'and', children: [typeIn([task])] })).titles, ['T1 на согласовании', 'T2 закрыта']);
    assert.deepEqual(runAst(ndb, ast({ op: 'or', children: [typeIn([task])] })).titles, ['T1 на согласовании', 'T2 закрыта']);
    // 3. НЕ над группой — отрицание всего поддерева.
    const notTask = ast({ op: 'not', children: [{ op: 'or', children: [typeIn([task])] }] });
    assert.deepEqual(runAst(ndb, notTask).titles, ['B3 расследуется', 'B4 зарегистрирована', 'B5 закрыта']);
    // 4. Вложенные И/ИЛИ/НЕ на несколько уровней.
    const nested = ast({
      op: 'and',
      children: [
        { op: 'not', children: [typeIn([task])] },
        { op: 'not', children: [propertyEq(status, 'закрыто')] },
      ],
    });
    assert.deepEqual(runAst(ndb, nested).titles, ['B3 расследуется', 'B4 зарегистрирована']);
  });

  it('filters by type in list and structural parents in list', () => {
    const ndb = createInMemoryNetworkDb();
    const parentA = seedThought(ndb, 'Версия X');
    const parentB = seedThought(ndb, 'Версия Y');
    const child1 = seedThought(ndb, 'Работа 1');
    const child2 = seedThought(ndb, 'Работа 2');
    seedThought(ndb, 'Сирота');
    seedLink(ndb, parentA, child1);
    seedLink(ndb, parentB, child2);
    // «Родители в списке [Версия X]» — у мысли есть родитель из списка.
    const byParents = ast({ entity: { kind: 'parents' }, operator: 'in', value: [parentA] });
    assert.deepEqual(runAst(ndb, byParents).titles, ['Работа 1']);
    // «Потомки не пусты».
    const hasChildren = ast({ entity: { kind: 'children' }, operator: 'not_empty' });
    assert.deepEqual(runAst(ndb, hasChildren).titles, ['Версия X', 'Версия Y']);
  });

  it('structural parents/children count only untyped live edges (blocker 9c156b8c)', () => {
    const ndb = createInMemoryNetworkDb();
    const linkType = seedLinkType(ndb, 'зависит от', 'нужен для');
    const parent = seedThought(ndb, 'Родитель');
    const typedChild = seedThought(ndb, 'Типизированный потомок');
    const untypedChild = seedThought(ndb, 'Структурный потомок');
    // Типизированное ребро НЕ является структурной связью (режим «все типы связей» —
    // отдельная задача e62aa4db).
    seedLink(ndb, parent, typedChild, linkType);
    seedLink(ndb, parent, untypedChild, null);

    const hasChildren = ast({ entity: { kind: 'children' }, operator: 'not_empty' });
    assert.deepEqual(runAst(ndb, hasChildren).titles, ['Родитель']);

    // «Потомки в списке [типизированный потомок]» — не структурная связь → нет.
    const childrenInList = ast({ entity: { kind: 'children' }, operator: 'in', value: [typedChild] });
    assert.deepEqual(runAst(ndb, childrenInList).titles, []);
    // «Потомки в списке [структурный потомок]» — совпадение.
    const childrenInUntyped = ast({ entity: { kind: 'children' }, operator: 'in', value: [untypedChild] });
    assert.deepEqual(runAst(ndb, childrenInUntyped).titles, ['Родитель']);
    // «Родители не пусты» — только у структурного потомка, не у типизированного.
    const hasParents = ast({ entity: { kind: 'parents' }, operator: 'not_empty' });
    assert.deepEqual(runAst(ndb, hasParents).titles, ['Структурный потомок']);
  });

  it('does not impose implicit active/trashed defaults — the tree defines the filter', () => {
    const ndb = createInMemoryNetworkDb();
    const task = seedThoughtType(ndb, 'задача');
    seedThought(ndb, 'Активная', { type_id: task, active: 1 });
    seedThought(ndb, 'Неактивная', { type_id: task, active: 0 });
    assert.equal(runAst(ndb, ast(typeIn([task]))).total, 2);
    assert.deepEqual(runAst(ndb, ast({ entity: { kind: 'active' }, operator: 'eq', value: false })).titles, ['Неактивная']);
  });
});
