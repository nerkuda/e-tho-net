/**
 * Точное совпадение ссылочных значений в AST отбора (ошибка aa98f3f9,
 * ADR 9779dd21 «равно — строгое сравнение», ADR 9a356460 «поддерево — только
 * через „в иерархии“», требование aa7a2aea).
 *
 * Проверяется по КАЖДОМУ виду ссылки:
 *   * тип мысли («Тип»): `eq/ne/in/not_in`/`any_of/none_of` — точный тип;
 *     `in_hierarchy/not_in_hierarchy` — тип + подтипы;
 *   * тип связи («Тип связи»): `eq/ne/in/not_in` — точный тип связи;
 *     `in_hierarchy/not_in_hierarchy` — тип связи + подтипы `link_types`;
 *   * мысль-цель значения (свойство-связь): `eq/ne/in/not_in` — точная цель;
 *     `in_hierarchy/not_in_hierarchy` — цель + её структурные потомки;
 *   * тождественность мысли (`id`): контрольный вид ссылки — наборные
 *     операторы точны и до фикса; иерархические — поддерево.
 *
 * Мутационная проба (проверена вручную при сдаче): возврат
 * `expandTypeIdsToSubtree` в наборные ветки «Тип»/«Тип связи» (`query-service.ts`)
 * красит тесты групп «Тип» и «Тип связи» — подтип попадает в точный отбор.
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

const BASE_LAYER = '00000000-0000-4000-8000-0000000000ba5e';

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

function seedThoughtType(ndb: NetworkDb, name: string, parentId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, parent_id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, parentId, name, name);
  return id;
}

function seedLinkType(ndb: NetworkDb, name: string, parentId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               parent_id, version, created_at, updated_at, created_by)
       VALUES (?, ?, lower(?), ?, lower(?), ?, 1, '2024-01-01T00:00:00.000Z',
               '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, name, name, name, name, parentId);
  return id;
}

function seedLink(ndb: NetworkDb, sourceId: string, targetId: string, typeId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId, typeId);
  return id;
}

function seedLinkProperty(ndb: NetworkDb, name: string, linkTypeId: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), 'link', ?, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, JSON.stringify({ link_type_id: linkTypeId, direction: 'out' }));
  return id;
}

/** Корень AST из узла (версия подставляется автоматически). */
function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Лист-условие по операнду (без labels). */
function leaf(entity: Record<string, unknown>, operator: string, value?: unknown, mode?: string): FilterAstNode {
  const base: Record<string, unknown> = { entity, operator };
  if (value !== undefined) base['value'] = value;
  if (mode !== undefined) base['mode'] = mode;
  return base as unknown as FilterAstNode;
}

/** Прогнать AST через единый исполнитель и вернуть отсортированные заголовки. */
function runAst(ndb: NetworkDb, tree: FilterAst): string[] {
  const req: CanonicalQueryRequest = { sort: 'alpha', order: 'asc', limit: 200, offset: 0, ast: tree };
  return queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 200 })
    .items.map((i) => i.title)
    .sort();
}

describe('Точное совпадение ссылочных значений AST (aa98f3f9)', { skip: !nativeAvailable() }, () => {
  it('«Тип»: наборные операторы точны, «в иерархии» — тип + подтипы', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const group = seedThoughtType(ndb, 'Коллекция');
      const child = seedThoughtType(ndb, 'Коллекция эталонов', group);
      const other = seedThoughtType(ndb, 'Ошибка');
      seedThought(ndb, 'exactGroup', group);
      seedThought(ndb, 'exactChild', child);
      seedThought(ndb, 'exactOther', other);

      // «равно»/«в списке» по ГРУППЕ типов — только сам тип, без подчинённых.
      assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'eq', group))), ['exactGroup'], 'eq — точный тип');
      assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'in', [group]))), ['exactGroup'], 'in — точный тип');
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'any_of', [group]))),
        ['exactGroup'],
        'any_of — точный тип',
      );
      // Инверсии: подчинённый тип и чужой тип проходят, сам тип группы — нет.
      assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'ne', group))), ['exactChild', 'exactOther'], 'ne — точный тип');
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'not_in', [group]))),
        ['exactChild', 'exactOther'],
        'not_in — точный тип',
      );
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'none_of', [group]))),
        ['exactChild', 'exactOther'],
        'none_of — точный тип',
      );

      // «В иерархии» — тот же операнд, но по поддереву; не тронут фиксом.
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'in_hierarchy', [group]))),
        ['exactChild', 'exactGroup'],
        'in_hierarchy — тип + подтипы',
      );
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'not_in_hierarchy', [group]))),
        ['exactOther'],
        'not_in_hierarchy — вне поддерева',
      );

      // Точный дочерний тип в «в иерархии» даёт только его поддерево.
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'type' }, 'in_hierarchy', [child]))),
        ['exactChild'],
        'in_hierarchy по листу — только лист',
      );
    } finally {
      ndb.close();
    }
  });

  it('«Тип связи»: наборные операторы точны, «в иерархии» — тип связи + подтипы', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const parentLinkType = seedLinkType(ndb, 'зависит от');
      const childLinkType = seedLinkType(ndb, 'регулируется из', parentLinkType);
      const unrelated = seedLinkType(ndb, 'см. также');
      // Субъекты отбора — тип S, цели рёбер — тип D: условие «Тип связи»
      // действует на ОБА конца ребра («есть инцидентная связь»), поэтому
      // юниверс сужаем типом субъекта — иначе цели тоже попадут в ожидания.
      const subjectType = seedThoughtType(ndb, 'S');
      const targetType = seedThoughtType(ndb, 'D');

      const a = seedThought(ndb, 'ltParent', subjectType);
      const b = seedThought(ndb, 'ltChild', subjectType);
      const c = seedThought(ndb, 'ltOther', subjectType);
      seedThought(ndb, 'ltNone', subjectType);
      const target = seedThought(ndb, 'ltTarget', targetType);
      seedLink(ndb, a, target, parentLinkType);
      seedLink(ndb, b, target, childLinkType);
      seedLink(ndb, c, target, unrelated);

      /** Условие «Тип связи» в юниверсе субъектов. */
      const run = (operator: string, value: string | string[]): string[] =>
        runAst(
          ndb,
          ast({
            op: 'and',
            children: [
              leaf({ kind: 'link_type' }, operator, value),
              leaf({ kind: 'type' }, 'eq', subjectType),
            ],
          }),
        );

      // «равно»/«в списке» по родительскому типу связи — только его рёбра.
      assert.deepEqual(run('eq', parentLinkType), ['ltParent'], 'eq — точный тип связи');
      assert.deepEqual(run('in', [parentLinkType]), ['ltParent'], 'in — точный тип связи');
      // Инверсии: мысль с ребром подчинённого типа проходит, с ребром родителя — нет.
      assert.deepEqual(
        run('ne', parentLinkType),
        ['ltChild', 'ltNone', 'ltOther'],
        'ne — точный тип связи',
      );
      assert.deepEqual(
        run('not_in', [parentLinkType]),
        ['ltChild', 'ltNone', 'ltOther'],
        'not_in — точный тип связи',
      );

      // «В иерархии» — тип связи + подтипы (L21); не тронут фиксом.
      assert.deepEqual(
        run('in_hierarchy', [parentLinkType]),
        ['ltChild', 'ltParent'],
        'in_hierarchy — тип связи + подтипы',
      );
      assert.deepEqual(
        run('not_in_hierarchy', [parentLinkType]),
        ['ltNone', 'ltOther'],
        'not_in_hierarchy — вне поддерева типа связи',
      );
    } finally {
      ndb.close();
    }
  });

  it('Свойство-связь: «равно» по мысли-цели точно, «в иерархии» — цель + потомки', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const propLinkType = seedLinkType(ndb, 'входит в');
      const prop = seedLinkProperty(ndb, 'Входит в', propLinkType);
      // Субъекты — тип S, цели свойства — тип D (юниверс сужаем типом субъекта).
      const subjectType = seedThoughtType(ndb, 'S');
      const referenceType = seedThoughtType(ndb, 'D');

      const root = seedThought(ndb, 'refRoot', referenceType);
      const child = seedThought(ndb, 'refChild', referenceType);
      seedLink(ndb, root, child); // структурное ребро: root → child
      const toRoot = seedThought(ndb, 'toRoot', subjectType);
      const toChild = seedThought(ndb, 'toChild', subjectType);
      seedLink(ndb, toRoot, root, propLinkType);
      seedLink(ndb, toChild, child, propLinkType);

      /** Условие свойства-связи в юниверсе субъектов. */
      const run = (operator: string, value: string | string[]): string[] =>
        runAst(
          ndb,
          ast({
            op: 'and',
            children: [
              leaf({ kind: 'property', property_id: prop }, operator, value),
              leaf({ kind: 'type' }, 'eq', subjectType),
            ],
          }),
        );

      assert.deepEqual(run('eq', root), ['toRoot'], 'eq — точная цель свойства-связи');
      assert.deepEqual(run('in', [root]), ['toRoot'], 'in — точная цель свойства-связи');
      assert.deepEqual(run('ne', root), ['toChild'], 'ne — точная цель свойства-связи');
      assert.deepEqual(run('not_in', [root]), ['toChild'], 'not_in — точная цель свойства-связи');

      assert.deepEqual(
        run('in_hierarchy', [root]),
        ['toChild', 'toRoot'],
        'in_hierarchy — цель и её структурные потомки',
      );
      assert.deepEqual(
        run('not_in_hierarchy', [root]),
        [],
        'not_in_hierarchy — обе цели в поддереве',
      );
    } finally {
      ndb.close();
    }
  });

  it('«Мысль» (id): наборные операторы точны, «в иерархии» — поддерево (контроль)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const root = seedThought(ndb, 'idRoot');
      const child = seedThought(ndb, 'idChild');
      seedLink(ndb, root, child);
      seedThought(ndb, 'idOther');

      assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'id' }, 'eq', root))), ['idRoot'], 'eq — точная мысль');
      assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'id' }, 'in', [root]))), ['idRoot'], 'in — точная мысль');
      assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'id' }, 'ne', root))), ['idChild', 'idOther'], 'ne — точная мысль');
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'id' }, 'not_in', [root]))),
        ['idChild', 'idOther'],
        'not_in — точная мысль',
      );
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'id' }, 'in_hierarchy', [root]))),
        ['idChild', 'idRoot'],
        'in_hierarchy — мысль и потомки',
      );
      assert.deepEqual(
        runAst(ndb, ast(leaf({ kind: 'id' }, 'not_in_hierarchy', [root]))),
        ['idOther'],
        'not_in_hierarchy — вне поддерева',
      );
    } finally {
      ndb.close();
    }
  });
});
