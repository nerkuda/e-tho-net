/**
 * Тесты оператора «в иерархии»/«не в иерархии» двух режимов (задача e62aa4db,
 * этап 2 поверх T1/T2/T3; требование aa7a2aea, ADR df23db45/9a356460/588be3f3).
 *
 * Покрывают:
 *   * режим «по структурным связям» (structural) — корни + потомки по живым
 *     нетипизированным рёбрам;
 *   * режим «по всем типам связей» (all_links) — любая живая связь считается
 *     родительской (типизированные рёбра тоже);
 *   * многородительство и циклы графа — обход завершается (visited-set);
 *   * глубину > 20 — обход останавливается на лимите;
 *   * операнд «Тип» — тип и его подтипы;
 *   * свойство-ссылку — «хотя бы одно значение входит в поддерево»;
 *   * ресурсный бюджет обхода — явная ошибка, без молчаливого усечения
 *     (ADR 58b501d8);
 *   * валидацию параметра листа `mode` и честный `unsupported` для чужих
 *     операндов.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { parseFilterAst } from '../src/domain/filter-ast.js';
import { collectHierarchySubtree } from '../src/domain/graph-traversal.js';
import {
  queryThoughts,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';
import { EtnError, FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

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

function seedLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  opts: { type_id?: string | null; active?: number; trashed?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId, opts.type_id ?? null, opts.active ?? 1, opts.trashed ?? 0);
  return id;
}

function seedLinkProperty(
  ndb: NetworkDb,
  name: string,
  config: Record<string, unknown>,
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), 'link', ?, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, JSON.stringify(config));
  return id;
}

/** Собрать корень AST из узла (версия подставляется автоматически). */
function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Прогнать AST через единый исполнитель и вернуть отсортированные заголовки. */
function runAst(ndb: NetworkDb, tree: FilterAst): string[] {
  const req: CanonicalQueryRequest = { sort: 'alpha', order: 'asc', limit: 200, offset: 0, count: true, ast: tree };
  const res = queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 200 });
  return res.items.map((i) => i.title).sort();
}

/** Лист-условие по операнду (без labels). */
function leaf(entity: Record<string, unknown>, operator: string, value?: unknown, mode?: string): FilterAstNode {
  const base: Record<string, unknown> = { entity, operator };
  if (value !== undefined) base['value'] = value;
  if (mode !== undefined) base['mode'] = mode;
  return base as unknown as FilterAstNode;
}

describe('«в иерархии» — два режима и обход с visited-set (e62aa4db)', { skip: !nativeAvailable() }, () => {
  it('structural: родители/потомки входят в поддерево корней; чужой родитель не проходит', () => {
    const ndb = createInMemoryNetworkDb();
    const root = seedThought(ndb, 'root');
    const a = seedThought(ndb, 'a');
    const b = seedThought(ndb, 'b');
    const z = seedThought(ndb, 'z'); // вне поддерева root
    const x = seedThought(ndb, 'x'); // родитель — b
    const y = seedThought(ndb, 'y'); // родитель — z (вне поддерева)
    const p = seedThought(ndb, 'p'); // потомок — b
    seedLink(ndb, root, a);
    seedLink(ndb, a, b);
    seedLink(ndb, z, y);
    seedLink(ndb, b, x); // b — родитель x
    seedLink(ndb, p, b); // b — потомок p

    // a (родитель root) и b (родитель a) тоже попадают: их родитель в поддереве.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [root]))), ['a', 'b', 'x']);
    // Потомки: root→a, a→b, b→x, p→b — потомок в поддереве {root,a,b,x} есть у root, a, b, p.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'in_hierarchy', [root]))), ['a', 'b', 'p', 'root']);
    // Отрицание: проходят мысли без родителя либо с родителем вне поддерева.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'not_in_hierarchy', [root]))),
      ['p', 'root', 'y', 'z'],
    );
  });

  it('all_links: типизированные рёбра считаются родительскими (structural — нет)', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'зависит от', 'нужен для');
    const root = seedThought(ndb, 'root');
    const t1 = seedThought(ndb, 't1');
    const x2 = seedThought(ndb, 'x2');
    seedLink(ndb, root, t1, { type_id: lt });
    seedLink(ndb, t1, x2, { type_id: lt });

    // Structural: типизированные рёбра не образуют иерархию → пусто.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [root]))), []);
    // All_links: любая живая связь родительская → t1 (родитель root) и x2 (родитель t1).
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [root], 'all_links'))),
      ['t1', 'x2'],
    );
  });

  it('цикл графа и многородительство: обход завершается, узлы не дублируются', () => {
    const ndb = createInMemoryNetworkDb();
    const root = seedThought(ndb, 'root');
    const a = seedThought(ndb, 'a');
    const b = seedThought(ndb, 'b');
    seedLink(ndb, root, a);
    seedLink(ndb, a, b);
    seedLink(ndb, b, a); // цикл a↔b
    const m = seedThought(ndb, 'm'); // два родителя: a и b
    seedLink(ndb, a, m);
    seedLink(ndb, b, m);

    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [root]))), ['a', 'b', 'm']);
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [root], 'all_links'))),
      ['a', 'b', 'm'],
    );

    // Ветвящийся цикл: r → a → c → a, r → b → c. Обход с visited-set обязан
    // собрать каждый узел ровно один раз и не обрезаться по бюджету. Снятие
    // visited-заслонов (`graph-traversal.ts`, страж в queue и добавлении) даёт
    // дубликаты и упирается в бюджет — тест краснеет (мутация M6).
    const r = seedThought(ndb, 'r');
    const ca = seedThought(ndb, 'ca');
    const cb = seedThought(ndb, 'cb');
    const cc = seedThought(ndb, 'cc');
    seedLink(ndb, r, ca);
    seedLink(ndb, r, cb);
    seedLink(ndb, ca, cc);
    seedLink(ndb, cb, cc);
    seedLink(ndb, cc, ca); // цикл ca ↔ cc

    const walk = collectHierarchySubtree(ndb, [r], 'structural');
    assert.equal(walk.truncated, false, 'цикл не должен упираться в бюджет обхода');
    assert.deepEqual([...walk.ids].sort(), [r, ca, cb, cc].sort(), 'полнота обхода: все узлы и только они');
    assert.equal(new Set(walk.ids).size, walk.ids.length, 'ids обхода не должны содержать дубликатов');
  });

  it('глубина > 20: обход останавливается на 20 уровне', () => {
    const ndb = createInMemoryNetworkDb();
    const chain: string[] = [seedThought(ndb, 'n0')];
    for (let i = 1; i <= 22; i += 1) {
      const node = seedThought(ndb, `n${i}`);
      seedLink(ndb, chain[i - 1]!, node);
      chain.push(node);
    }
    const x20 = seedThought(ndb, 'x20'); // родитель n20 (в пределах лимита)
    const x21 = seedThought(ndb, 'x21'); // родитель n21 (за лимитом)
    seedLink(ndb, chain[20]!, x20);
    seedLink(ndb, chain[21]!, x21);

    const got = new Set(runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [chain[0]!]))));
    assert.ok(got.has('x20'), 'родитель на 20 уровне входит в поддерево');
    assert.ok(got.has('n21'), 'мысль с родителем на 20 уровне входит');
    assert.ok(!got.has('x21'), 'родитель на 21 уровне за лимитом — не входит');
    assert.ok(!got.has('n22'), 'родитель на 21 уровне — не входит');
    assert.ok(!got.has('n0'), 'корень без родителей — не входит');
  });

  it('операнд «Тип»: тип и его подтипы; not_in_hierarchy отрицает', () => {
    const ndb = createInMemoryNetworkDb();
    const t = seedThoughtType(ndb, 'T');
    const t1 = seedThoughtType(ndb, 'T1', t);
    const u = seedThoughtType(ndb, 'U');
    seedThought(ndb, 'thinkT1', { type_id: t1 });
    seedThought(ndb, 'thinkT', { type_id: t });
    seedThought(ndb, 'thinkU', { type_id: u });

    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'in_hierarchy', [t]))), ['thinkT', 'thinkT1']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'not_in_hierarchy', [t]))), ['thinkU']);
  });

  it('свойство-ссылка: хотя бы одно значение входит в поддерево', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'входит в', 'включает');
    const prop = seedLinkProperty(ndb, 'входит в', { link_type_id: lt, direction: 'out' });
    const root = seedThought(ndb, 'root');
    const a = seedThought(ndb, 'a');
    const z = seedThought(ndb, 'z'); // вне поддерева
    seedLink(ndb, root, a);
    const s1 = seedThought(ndb, 's1'); // P → a (в поддереве)
    const s2 = seedThought(ndb, 's2'); // P → z (вне поддерева)
    seedLink(ndb, s1, a, { type_id: lt });
    seedLink(ndb, s2, z, { type_id: lt });

    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'in_hierarchy', [root]))),
      ['s1'],
    );
  });

  it('операнд «Мысль» (id): «в иерархии» — сами мысли и всё их поддерево; паритет с OR-группой', () => {
    const ndb = createInMemoryNetworkDb();
    const x = seedThought(ndb, 'x');
    const y = seedThought(ndb, 'y');
    const z = seedThought(ndb, 'z');
    const q = seedThought(ndb, 'q');
    const far = seedThought(ndb, 'far');
    seedLink(ndb, x, y); // x → y (поддерево x)
    seedLink(ndb, y, z); // y → z
    seedLink(ndb, q, far); // q → far (второе поддерево)

    // R = {x, q}: сами выбранные мысли + ВСЕ их потомки по структурным связям.
    const inHierarchy = runAst(ndb, ast(leaf({ kind: 'id' }, 'in_hierarchy', [x, q])));
    assert.deepEqual(inHierarchy, ['far', 'q', 'x', 'y', 'z']);

    // Паритет с OR-группой из двух условий: «id в R» ИЛИ «родители в иерархии R»
    // (второе условие — потомки корней). Тот же результат (задача a577875b, DoD).
    const parity = {
      op: 'or',
      children: [
        leaf({ kind: 'id' }, 'in', [x, q]),
        leaf({ kind: 'parents' }, 'in_hierarchy', [x, q]),
      ],
    } as unknown as FilterAstNode;
    assert.deepEqual(runAst(ndb, ast(parity)), inHierarchy, 'паритет «id в иерархии» ↔ OR(id, родители)');

    // Отрицание: вне R и вне их поддеревьев — остаётся только второе поддерево {q, far} минус корни вне R.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'id' }, 'not_in_hierarchy', [x]))), ['far', 'q']);

    // Пустое значение: «в иерархии» — ничего, «не в иерархии» — всё.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'id' }, 'in_hierarchy', []))), []);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'id' }, 'not_in_hierarchy', []))), ['far', 'q', 'x', 'y', 'z']);

    // Режим связей для «Мысли» неприменим: типизированное ребро иерархию НЕ
    // образует, `mode: all_links` игнорируется (структурный обход).
    const lt = seedLinkType(ndb, 'зависит от', 'нужен для');
    const t = seedThought(ndb, 't');
    seedLink(ndb, x, t, { type_id: lt });
    assert.ok(!runAst(ndb, ast(leaf({ kind: 'id' }, 'in_hierarchy', [x]))).includes('t'),
      'типизированное ребро не входит в структурную иерархию «Мысли»');
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'id' }, 'in_hierarchy', [x], 'all_links'))),
      runAst(ndb, ast(leaf({ kind: 'id' }, 'in_hierarchy', [x]))),
      'mode для «Мысли» игнорируется — обход только структурный',
    );
  });

  it('рёбра корзины и неактивные в иерархию не входят', () => {
    const ndb = createInMemoryNetworkDb();
    const root = seedThought(ndb, 'root');
    const a = seedThought(ndb, 'a');
    const b = seedThought(ndb, 'b');
    const c = seedThought(ndb, 'c');
    seedLink(ndb, root, a);
    seedLink(ndb, a, b, { trashed: 1 }); // ребро в корзине
    seedLink(ndb, root, c, { active: 0 }); // неактивное ребро
    const xb = seedThought(ndb, 'xb'); // родитель b (ребро a→b в корзине)
    const xc = seedThought(ndb, 'xc'); // родитель c (ребро root→c неактивно)
    seedLink(ndb, b, xb);
    seedLink(ndb, c, xc);

    const got = new Set(runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [root]))));
    assert.ok(!got.has('xb'), 'потомок по ребру из корзины не входит');
    assert.ok(!got.has('xc'), 'потомок по неактивному ребру не входит');
  });

  it('ресурсный бюджет: превышение — явная ошибка, без молчаливого усечения', () => {
    const ndb = createInMemoryNetworkDb();
    const root = seedThought(ndb, 'root');
    for (let i = 0; i < 2001; i += 1) {
      const child = seedThought(ndb, `c${i}`);
      seedLink(ndb, root, child);
    }
    assert.throws(
      () => runAst(ndb, ast(leaf({ kind: 'parents' }, 'in_hierarchy', [root]))),
      (e: unknown) =>
        e instanceof EtnError &&
        e.code === 'VALIDATION_ERROR' &&
        (e.details as { reason?: string }).reason === 'hierarchy_budget',
    );
  });

  it('неподдерживаемые операнды дают unsupported, а не ложный результат', () => {
    const ndb = createInMemoryNetworkDb();
    assert.throws(
      () => runAst(ndb, ast(leaf({ kind: 'attachments' }, 'in_hierarchy', ['x']))),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
  });
});

describe('валидация параметра листа `mode` (e62aa4db)', { skip: !nativeAvailable() }, () => {
  it('принимает structural/all_links, отклоняет неизвестный режим', () => {
    const ok = parseFilterAst({
      version: FILTER_AST_VERSION,
      filter: { entity: { kind: 'parents' }, operator: 'in_hierarchy', value: ['r'], mode: 'all_links' },
    });
    assert.equal(ok.filter && 'mode' in ok.filter ? ok.filter.mode : undefined, 'all_links');

    assert.throws(
      () =>
        parseFilterAst({
          version: FILTER_AST_VERSION,
          filter: { entity: { kind: 'parents' }, operator: 'in_hierarchy', value: ['r'], mode: 'bogus' },
        }),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
  });
});
