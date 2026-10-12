/**
 * Тесты значений-под-выборок («в (выборке)»/«не в (выборке)»/«все в (выборке)»)
 * в едином AST-исполнителе (задача 8914ac36, этап 2 поверх T1 модель / T3
 * операторы / T2 токены / T4 иерархия; требования 485ff29e, c088f9e1, 64c90b05,
 * ADR b0cf5433/58b501d8, сущность 489c394f).
 *
 * Покрывают:
 *   * три оператора-квантификатора на свойстве-ссылке (обе стороны);
 *   * структурные «Родители»/«Потомки»;
 *   * одиночный «Тип» (in/not_in; «все в» отклонён как для одиночного);
 *   * пограничный сценарий c76f688b: пустая под-выборка и вакуумное «все в»;
 *   * релевантность операндов: нерелевантные отвергаются, отложенные
 *     (вложения/дневник/цели/тип связи) — честный `unsupported`;
 *   * сценарий спеки «куплено тут в (выборке: тип=вещь и создано≥$yearStart)»;
 *   * токены внутри под-выборки — тем же `tokenContext`;
 *   * ресурсные предохранители: глубина вложенности и ширина набора — явная
 *     ошибка с `reason`, без молчаливого усечения (ADR 58b501d8).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { parseFilterAst } from '../src/domain/filter-ast.js';
import {
  AST_SUBQUERY_MAX_DEPTH,
  AST_SUBQUERY_MAX_NODES,
  queryThoughts,
  type AstTokenContext,
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
  opts: { type_id?: string; created_at?: string } = {},
): string {
  const id = randomUUID();
  const createdAt = opts.created_at ?? '2024-01-01T00:00:00.000Z';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), opts.type_id ?? null, createdAt, createdAt);
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
  opts: { type_id?: string | null } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId, opts.type_id ?? null);
  return id;
}

function seedLinkProperty(ndb: NetworkDb, name: string, config: Record<string, unknown>): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), 'link', ?, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, JSON.stringify(config));
  return id;
}

function seedScalarProperty(ndb: NetworkDb, name: string, valueType: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), ?, NULL, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, valueType);
  return id;
}

/** Собрать корень AST из узла (версия подставляется автоматически). */
function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Прогнать AST через единый исполнитель и вернуть отсортированные заголовки. */
function runAst(ndb: NetworkDb, tree: FilterAst, tokenContext?: AstTokenContext): string[] {
  const req: CanonicalQueryRequest = { sort: 'alpha', order: 'asc', limit: 200, offset: 0, count: true, ast: tree };
  const res = queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 200, tokenContext });
  return res.items.map((i) => i.title).sort();
}

/** Лист-условие по операнду (без labels). */
function leaf(entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode {
  const base: Record<string, unknown> = { entity, operator };
  if (value !== undefined) base['value'] = value;
  return base as unknown as FilterAstNode;
}

/** Под-выборка как значение с указанным квантификатором. */
function sub(query: FilterAstNode, operator: 'in' | 'not_in' | 'all_in'): Record<string, unknown> {
  return { query, operator };
}

function expectEtnError(fn: () => unknown, reason?: string): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return (
      e instanceof EtnError &&
      e.code === 'VALIDATION_ERROR' &&
      (reason === undefined || (e.details as { reason?: string }).reason === reason)
    );
  }
}

describe('под-выборки как значения — квантификация (8914ac36)', { skip: !nativeAvailable() }, () => {
  it('свойство-ссылка: «в»/«не в»/«все в» по набору под-выборки', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'куплено тут', 'купили здесь');
    const prop = seedLinkProperty(ndb, 'куплено тут', { link_type_id: lt, direction: 'out' });
    const v = seedThoughtType(ndb, 'вещь');
    const u = seedThoughtType(ndb, 'место');

    const a = seedThought(ndb, 'a', { type_id: v }); // в наборе (тип вещь)
    const z = seedThought(ndb, 'z', { type_id: u }); // вне набора
    const s1 = seedThought(ndb, 's1'); // → a (входит)
    const s2 = seedThought(ndb, 's2'); // → z (не входит)
    const s3 = seedThought(ndb, 's3'); // → a и z (смешанный)
    seedThought(ndb, 's0'); // без значений
    seedLink(ndb, s1, a, { type_id: lt });
    seedLink(ndb, s2, z, { type_id: lt });
    seedLink(ndb, s3, a, { type_id: lt });
    seedLink(ndb, s3, z, { type_id: lt });

    const set = leaf({ kind: 'type' }, 'in', [v]);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'in', sub(set, 'in')))), [
      's1',
      's3',
    ]);
    // «не в» истинно и у мыслей без значений (ни одно не входит — вакуумно).
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'not_in', sub(set, 'not_in')))), [
      'a',
      's0',
      's2',
      'z',
    ]);
    // «все в»: значения s2/s3 (z) вне набора → ложь; без значений — вакуумно истинно.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'all_of', sub(set, 'all_in')))), [
      'a',
      's0',
      's1',
      'z',
    ]);
  });

  it('свойство-ссылка: обратная сторона (entity.direction = in) адресует цели рёбер', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'куплено тут', 'купили здесь');
    const prop = seedLinkProperty(ndb, 'куплено тут', { link_type_id: lt, direction: 'out' });
    const v = seedThoughtType(ndb, 'вещь');
    const a = seedThought(ndb, 'a', { type_id: v });
    const w = seedThought(ndb, 'w'); // источник ребра a → w
    seedLink(ndb, a, w, { type_id: lt });

    // Обратная сторона (direction: in): значение операнда — источник ребра.
    // Для мысли w (цели ребра a → w) значение = a (в наборе) → проходит.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property_id: prop, direction: 'in' }, 'in', sub(leaf({ kind: 'type' }, 'in', [v]), 'in')))),
      ['w'],
    );
  });

  it('структурные «Родители»/«Потомки»: квантификация по поддереву', () => {
    const ndb = createInMemoryNetworkDb();
    const v = seedThoughtType(ndb, 'вещь');
    const a = seedThought(ndb, 'a', { type_id: v });
    const z = seedThought(ndb, 'z');
    const p1 = seedThought(ndb, 'p1'); // родитель a (в наборе)
    const p2 = seedThought(ndb, 'p2'); // родитель z (вне набора)
    const p3 = seedThought(ndb, 'p3'); // родители a и z
    seedThought(ndb, 'p0'); // без родителей
    seedLink(ndb, a, p1);
    seedLink(ndb, z, p2);
    seedLink(ndb, a, p3);
    seedLink(ndb, z, p3);

    const set = leaf({ kind: 'type' }, 'in', [v]);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'in', sub(set, 'in')))), ['p1', 'p3']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'not_in', sub(set, 'not_in')))), [
      'a',
      'p0',
      'p2',
      'z',
    ]);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'all_of', sub(set, 'all_in')))), [
      'a',
      'p0',
      'p1',
      'z',
    ]);
  });

  it('одиночный «Тип»: in/not_in; «все в» отклонён как для одиночного операнда', () => {
    const ndb = createInMemoryNetworkDb();
    const v = seedThoughtType(ndb, 'вещь');
    const u = seedThoughtType(ndb, 'место');
    seedThought(ndb, 'tv', { type_id: v });
    seedThought(ndb, 'tu', { type_id: u });
    seedThought(ndb, 'tnull');

    const set = leaf({ kind: 'type' }, 'in', [v]);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'in', sub(set, 'in')))), ['tv']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'not_in', sub(set, 'not_in')))), ['tnull', 'tu']);
    assert.ok(
      expectEtnError(() => runAst(ndb, ast(leaf({ kind: 'type' }, 'all_of', sub(set, 'all_in'))))),
      '«все в (выборке)» на одиночном «Тип» — ошибка валидации',
    );
  });

  it('пограничный сценарий c76f688b: пустая под-выборка — «в» ложно, «не в» истинно', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'куплено тут', 'купили здесь');
    const prop = seedLinkProperty(ndb, 'куплено тут', { link_type_id: lt, direction: 'out' });
    const v = seedThoughtType(ndb, 'вещь');
    const a = seedThought(ndb, 'a', { type_id: v });
    const s1 = seedThought(ndb, 's1');
    seedLink(ndb, s1, a, { type_id: lt });

    // Под-выборка пуста (тип, которого нет ни у одной мысли).
    const emptySet = leaf({ kind: 'type' }, 'in', ['11111111-1111-4111-8111-111111111111']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'in', sub(emptySet, 'in')))), []);
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'not_in', sub(emptySet, 'not_in')))),
      ['a', 's1'],
    );
    // «Все в» без значений операнда — истинно (вакуумно): s1 имеет значение вне
    // пустого набора → ложно; мысль без рёбер вакуумно истинна.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'all_of', sub(emptySet, 'all_in')))),
      ['a'],
    );
  });

  it('нерелевантные операнды отвергаются внятной ошибкой', () => {
    const ndb = createInMemoryNetworkDb();
    const text = seedScalarProperty(ndb, 'статус', 'text');
    seedThought(ndb, 'x');
    const set = leaf({ kind: 'type' }, 'in', ['22222222-2222-4222-8222-222222222222']);

    // Скалярное свойство — не ссылка.
    assert.ok(expectEtnError(() => runAst(ndb, ast(leaf({ kind: 'property', property_id: text }, 'in', sub(set, 'in'))))));
    // Автор/Есть слова/служебные предикаты.
    assert.ok(expectEtnError(() => runAst(ndb, ast(leaf({ kind: 'author' }, 'in', sub(set, 'in'))))));
    assert.ok(expectEtnError(() => runAst(ndb, ast(leaf({ kind: 'keywords', scope: ['title'] }, 'in', sub(set, 'in'))))));
    assert.ok(expectEtnError(() => runAst(ndb, ast(leaf({ kind: 'active' }, 'eq', sub(set, 'in'))))));
  });

  it('отложенные операнды (вложения/дневник/цели/тип связи) — честный unsupported', () => {
    const ndb = createInMemoryNetworkDb();
    seedThought(ndb, 'x');
    const set = leaf({ kind: 'type' }, 'in', ['33333333-3333-4333-8333-333333333333']);
    for (const kind of ['attachments', 'chronology', 'targets', 'link_type'] as const) {
      assert.ok(
        expectEtnError(() => runAst(ndb, ast(leaf({ kind }, 'in', sub(set, 'in'))))),
        `операнд ${kind} вне модели — честный unsupported`,
      );
    }
  });

  it('сценарий спеки: «куплено тут в (выборке: тип=вещь и создано≥$yearStart)»', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'куплено тут', 'купили здесь');
    const prop = seedLinkProperty(ndb, 'куплено тут', { link_type_id: lt, direction: 'out' });
    const v = seedThoughtType(ndb, 'вещь');
    // Вещь этого года — в наборе; прошлогодняя — вне.
    const fresh = seedThought(ndb, 'свежая', { type_id: v, created_at: '2024-05-01T00:00:00.000Z' });
    const stale = seedThought(ndb, 'прошлогодняя', { type_id: v, created_at: '2023-05-01T00:00:00.000Z' });
    const s1 = seedThought(ndb, 's1');
    const s2 = seedThought(ndb, 's2');
    seedLink(ndb, s1, fresh, { type_id: lt });
    seedLink(ndb, s2, stale, { type_id: lt });

    const cond: FilterAstNode = {
      op: 'and',
      children: [
        leaf({ kind: 'type' }, 'in', [v]),
        leaf({ kind: 'created_at' }, 'gte', { token: '$yearStart' }),
      ],
    };
    const tokenContext: AstTokenContext = { nowMs: Date.UTC(2024, 6, 1) };
    assert.deepEqual(
      runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'in', sub(cond, 'in'))),
        tokenContext,
      ),
      ['s1'],
      'токены внутри под-выборки резолвятся тем же tokenContext',
    );
  });

  it('ресурс: глубина вложенности сверх предохранителя — явная ошибка, не усечение', () => {
    const ndb = createInMemoryNetworkDb();
    const v = seedThoughtType(ndb, 'вещь');
    seedThought(ndb, 'x', { type_id: v });

    const nest = (depth: number): FilterAstNode => {
      let node: FilterAstNode = leaf({ kind: 'type' }, 'in', [v]);
      for (let i = 0; i < depth; i += 1) {
        node = leaf({ kind: 'type' }, 'in', sub(node, 'in'));
      }
      return node;
    };
    // Небольшая вложенность работает.
    assert.deepEqual(runAst(ndb, ast(nest(3))), ['x']);
    // Глубже предохранителя — явная ошибка с reason.
    assert.ok(
      expectEtnError(() => runAst(ndb, ast(nest(AST_SUBQUERY_MAX_DEPTH + 1))), 'subquery_depth'),
      'глубина сверх AST_SUBQUERY_MAX_DEPTH → ошибка',
    );
  });

  it('ресурс: суммарный бюджет ширины по двум под-выборкам — явная ошибка', () => {
    const ndb = createInMemoryNetworkDb();
    const per = Math.floor(AST_SUBQUERY_MAX_NODES * 0.75); // 1500 — ниже одиночного лимита
    for (let i = 0; i < per; i += 1) seedThought(ndb, `m${i}`);
    const wide = leaf({ kind: 'active' }, 'eq', true);
    const two = {
      op: 'and',
      children: [
        leaf({ kind: 'parents' }, 'in', sub(wide, 'in')),
        leaf({ kind: 'children' }, 'in', sub(wide, 'in')),
      ],
    } as FilterAstNode;
    assert.ok(
      expectEtnError(() => runAst(ndb, ast(two)), 'subquery_budget'),
      `каждая под-выборка ~${per}, суммарно > ${AST_SUBQUERY_MAX_NODES} → ошибка бюджета`,
    );
  });

  it('ресурс: ширина набора сверх бюджета — явная ошибка, не молчаливое усечение', () => {
    const ndb = createInMemoryNetworkDb();
    for (let i = 0; i <= AST_SUBQUERY_MAX_NODES; i += 1) seedThought(ndb, `w${i}`);
    // Под-выборка «все активные» возвращает > бюджета id-набор.
    const wide = leaf({ kind: 'active' }, 'eq', true);
    assert.ok(
      expectEtnError(() => runAst(ndb, ast(leaf({ kind: 'parents' }, 'in', sub(wide, 'in')))), 'subquery_budget'),
      `>${AST_SUBQUERY_MAX_NODES} id в под-выборке → ошибка бюджета`,
    );
  });
});

describe('валидация формы значения-под-выборки (8914ac36)', { skip: !nativeAvailable() }, () => {
  it('принимает {query, operator} и отвергает чужой оператор/лишние ключи', () => {
    const good = parseFilterAst({
      version: FILTER_AST_VERSION,
      filter: {
        entity: { kind: 'type' },
        operator: 'all_of',
        value: { query: { entity: { kind: 'type' }, operator: 'in', value: ['t'] }, operator: 'all_in' },
      },
    });
    assert.ok(good.filter);
    for (const bad of [
      { query: { entity: { kind: 'type' }, operator: 'in', value: ['t'] }, operator: 'bogus' },
      { query: { entity: { kind: 'type' }, operator: 'in', value: ['t'] }, operator: 'in', extra: 1 },
      { operator: 'in' },
    ]) {
      assert.ok(
        expectEtnError(() =>
          parseFilterAst({
            version: FILTER_AST_VERSION,
            filter: { entity: { kind: 'type' }, operator: 'in', value: bad },
          }),
        ),
        `некорректная под-выборка отвергнута: ${JSON.stringify(bad)}`,
      );
    }
  });

  it('рассогласование leaf.operator и value.operator отвергается', () => {
    const mk = (leafOp: string, valueOp: string): Record<string, unknown> => ({
      version: FILTER_AST_VERSION,
      filter: {
        entity: { kind: 'type' },
        operator: leafOp,
        value: { query: { entity: { kind: 'type' }, operator: 'in', value: ['t'] }, operator: valueOp },
      },
    });
    // Согласованные пары принимаются.
    for (const [leafOp, valueOp] of [
      ['in', 'in'],
      ['not_in', 'not_in'],
      ['all_of', 'all_in'],
    ] as const) {
      assert.ok(parseFilterAst(mk(leafOp, valueOp)).filter, `согласованная пара ${leafOp}+${valueOp}`);
    }
    // Рассогласование — VALIDATION_ERROR (in+all_in, not_in+in и обратные).
    for (const [leafOp, valueOp] of [
      ['in', 'all_in'],
      ['not_in', 'in'],
      ['all_of', 'in'],
      ['in', 'not_in'],
    ] as const) {
      assert.ok(expectEtnError(() => parseFilterAst(mk(leafOp, valueOp))), `рассогласование ${leafOp}+${valueOp}`);
    }
  });
});
