/**
 * Тесты модели состояния дерева отбора и её конвертера в wire-AST (задача
 * 6ae062a9, требование 5ce18fcf, ADR 30ff83bb, версия 0.13.1).
 *
 * Проверяется то, ради чего дерево сведено к единой модели `FilterCriteriaState`
 * и единственному конвертеру `lib/filter-builder.ts`:
 *
 *  1. дерево любой глубины (группы И/ИЛИ/НЕ + листья) собирается в wire-AST без
 *     потерь и читается обратно той же моделью;
 *  2. ВСЕ операторы ядра и ВСЕ виды операндов и значения (скаляр/список/токен/
 *     под-выборка/пусто) переживают round-trip `модель → AST → модель → AST`;
 *  3. многоуровневая сортировка едет ключами `{ key, order }` и читается обратно;
 *  4. профиль контекста — параметр конвертера: состав операндов/операторов берётся
 *     из общего реестра `@etn/shared`, проверка дерева не заводит второго словаря.
 *
 * Чистые функции без DOM — обычный Node-прогон.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FILTER_AST_ENTITY_KINDS,
  FILTER_AST_OPERATORS,
  type FilterAst,
  type FilterAstEntity,
  type FilterAstEntityKind,
  type FilterAstGroupOp,
  type FilterAstOperator,
} from '@etn/shared';

import {
  buildFilterAst,
  defaultFilterCriteriaState,
  defaultFilterTreeGroup,
  defaultFilterTreeLeaf,
  filterAstSortKeyLabel,
  filterLeafDefaultValue,
  filterLeafImplicitOperator,
  filterLeafImplicitValue,
  filterProfileOperands,
  filterProfileOperators,
  filterProfileTokenFamilies,
  filterTreeHasAnyCriteria,
  isFilterAstWire,
  parseFilterAstState,
  parseFilterDefinition,
  validateFilterTree,
  type FilterCriteriaState,
  type FilterTreeGroup,
  type FilterTreeLeaf,
  type FilterTreeNode,
} from '../src/renderer/lib/filter-builder.js';

/** Лист дерева по операнду — краткая запись условий в тестах. */
function leaf(
  entity: FilterAstEntity,
  operator: FilterAstOperator,
  value: FilterTreeLeaf['value'],
  extra: Partial<FilterTreeLeaf> = {},
): FilterTreeLeaf {
  return { kind: 'leaf', entity, operator, value, ...extra };
}

/** Группа дерева с детьми — краткая запись условий в тестах. */
function group(op: FilterAstGroupOp, children: FilterTreeNode[]): FilterTreeGroup {
  return { kind: 'group', op, children };
}

/** Состояние с деревом и явной сортировкой. */
function treeState(root: FilterTreeNode, sortKeys: FilterCriteriaState['sortKeys'] = []): FilterCriteriaState {
  return { ...defaultFilterCriteriaState(), tree: root, sortKeys };
}

// ---------------------------------------------------------------------------
// 1. Дерево любой глубины: сборка в AST и обратно
// ---------------------------------------------------------------------------

describe('дерево условий: сборка в wire-AST и чтение обратно', () => {
  const tree: FilterTreeGroup = {
    kind: 'group',
    op: 'and',
    children: [
      {
        kind: 'group',
        op: 'or',
        children: [
          leaf({ kind: 'type' }, 'in', { kind: 'list', items: ['t1', 't2'] }),
          {
            kind: 'group',
            op: 'not',
            children: [leaf({ kind: 'property', property_id: 'p1' }, 'is_empty', { kind: 'none' })],
          },
        ],
      },
      leaf(
        { kind: 'created_at' },
        'between',
        { kind: 'list', items: [{ token: '$monthStart' }, { token: '$monthEnd' }] },
      ),
      leaf(
        { kind: 'property', property_id: 'p2', direction: 'in' },
        'eq',
        { kind: 'scalar', value: 42 },
        { labels: { entity: 'Размер', value: '42' }, mode: 'all_links' },
      ),
      leaf(
        { kind: 'parents' },
        'in',
        {
          kind: 'subquery',
          operator: 'all_in',
          node: {
            kind: 'group',
            op: 'and',
            children: [
              leaf({ kind: 'keywords', scope: ['title'] }, 'matches', { kind: 'scalar', value: 'счет*' }),
            ],
          },
        },
      ),
    ],
  };

  const expected: FilterAst = {
    version: 1,
    filter: {
      op: 'and',
      children: [
        {
          op: 'or',
          children: [
            { entity: { kind: 'type' }, operator: 'in', value: ['t1', 't2'] },
            {
              op: 'not',
              children: [{ entity: { kind: 'property', property_id: 'p1' }, operator: 'is_empty' }],
            },
          ],
        },
        {
          entity: { kind: 'created_at' },
          operator: 'between',
          value: [{ token: '$monthStart' }, { token: '$monthEnd' }],
        },
        {
          entity: { kind: 'property', property_id: 'p2', direction: 'in' },
          operator: 'eq',
          value: 42,
          labels: { entity: 'Размер', value: '42' },
          mode: 'all_links',
        },
        {
          entity: { kind: 'parents' },
          operator: 'in',
          value: {
            query: {
              op: 'and',
              children: [
                { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'счет*' },
              ],
            },
            operator: 'all_in',
          },
        },
      ],
    },
    sort: [
      { key: 'title', order: 'asc' },
      { key: 'created_at', order: 'desc' },
    ],
  };

  it('трёхуровневое дерево даёт эталонный AST (операнд/оператор/значение/labels/mode + сортировка)', () => {
    const ast = buildFilterAst(
      treeState(tree, [
        { key: 'title', order: 'asc' },
        { key: 'created_at', order: 'desc' },
      ]),
    );
    assert.deepEqual(ast, expected);
  });

  it('AST → модель → AST не теряет ни одного узла (round-trip)', () => {
    const back = parseFilterAstState(expected);
    assert.notEqual(back.tree, null);
    assert.deepEqual(buildFilterAst(back), expected, 'дерево любой глубины читается без потерь');
    assert.deepEqual(back.sortKeys, expected.sort);
  });

  it('пустое состояние даёт валидный AST без условий (пустая группа И)', () => {
    assert.deepEqual(buildFilterAst(defaultFilterCriteriaState()), {
      version: 1,
      filter: { op: 'and', children: [] },
      sort: [{ key: 'created_at', order: 'asc' }],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Весь словарь ядра: операторы, операнды, значения
// ---------------------------------------------------------------------------

describe('весь словарь ядра выражается моделью без потерь', () => {
  it('каждый оператор ядра сериализуется и читается обратно', () => {
    for (const operator of FILTER_AST_OPERATORS) {
      const value = operator === 'is_empty' || operator === 'not_empty' || operator === 'has' || operator === 'not_has'
        ? ({ kind: 'none' } as const)
        : ({ kind: 'scalar', value: 'x' } as const);
      const ast = buildFilterAst(treeState(group('and', [leaf({ kind: 'active' }, operator, value)])));
      const root = ast.filter;
      assert.ok('children' in root, `оператор ${operator}: корень — группа`);
      const child = root.children[0];
      assert.ok(child !== undefined && !('op' in child), `оператор ${operator}: узел — лист`);
      assert.equal(child.operator, operator);
      assert.deepEqual(buildFilterAst(parseFilterAstState(ast)), ast, `оператор ${operator} без потерь`);
    }
  });

  it('каждый вид операнда (вид + адрес свойства + область) читается обратно', () => {
    for (const kind of FILTER_AST_ENTITY_KINDS) {
      const entity = entityForKind(kind);
      const ast = buildFilterAst(treeState(group('and', [leaf(entity, 'eq', { kind: 'none' })])));
      const back = parseFilterAstState(ast);
      assert.deepEqual(buildFilterAst(back), ast, `операнд ${kind} без потерь`);
    }
  });

  it('значения: пусто/скаляр/список (в т.ч. из одного)/токен/под-выборка различаются', () => {
    const cases: Array<{ value: FilterTreeLeaf['value']; expected: unknown }> = [
      { value: { kind: 'none' }, expected: undefined },
      { value: { kind: 'scalar', value: 'a' }, expected: 'a' },
      { value: { kind: 'scalar', value: false }, expected: false },
      { value: { kind: 'list', items: ['a'] }, expected: ['a'] },
      { value: { kind: 'list', items: [{ token: '$weekStart' }, '$today'] }, expected: [{ token: '$weekStart' }, '$today'] },
      { value: { kind: 'token', token: '$today' }, expected: { token: '$today' } },
      {
        value: {
          kind: 'subquery',
          operator: 'not_in',
          node: group('and', [leaf({ kind: 'active' }, 'eq', { kind: 'scalar', value: true })]),
        },
        expected: {
          query: { op: 'and', children: [{ entity: { kind: 'active' }, operator: 'eq', value: true }] },
          operator: 'not_in',
        },
      },
    ];
    for (const { value, expected } of cases) {
      const ast = buildFilterAst(treeState(group('and', [leaf({ kind: 'type' }, 'in', value)])));
      const root = ast.filter;
      assert.ok('children' in root);
      const child = root.children[0];
      assert.ok(child !== undefined && !('op' in child));
      assert.deepEqual(child.value, expected, `значение ${value.kind} в wire`);
      assert.deepEqual(buildFilterAst(parseFilterAstState(ast)), ast, `значение ${value.kind} без потерь`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Сортировка
// ---------------------------------------------------------------------------

describe('многоуровневая сортировка и плоская пара', () => {
  it('пустые sortKeys дают ключ из плоской пары sort/order', () => {
    const ast = buildFilterAst({ ...defaultFilterCriteriaState(), sort: 'alpha', order: 'desc' });
    assert.deepEqual(ast.sort, [{ key: 'title', order: 'desc' }]);
  });

  it('сортировка «по просмотру» ключа в AST не имеет — sort не выставляется', () => {
    const ast = buildFilterAst({ ...defaultFilterCriteriaState(), sort: 'viewed' });
    assert.equal(ast.sort, undefined);
  });

  it('сохранённый AST отдаёт плоской панели известный ключ, а свойство — оставляет в sortKeys', () => {
    const state = parseFilterAstState({
      version: 1,
      filter: { entity: { kind: 'active' }, operator: 'eq', value: true },
      sort: [{ key: 'updated_at', order: 'desc' }],
    });
    assert.equal(state.sort, 'updated');
    assert.equal(state.order, 'desc');

    const propKey = parseFilterAstState({
      version: 1,
      filter: { entity: { kind: 'active' }, operator: 'eq', value: true },
      sort: [{ key: 'p-size', order: 'asc' }],
    });
    assert.deepEqual(propKey.sortKeys, [{ key: 'p-size', order: 'asc' }]);
    assert.equal(propKey.sort, 'created', 'неизвестный ключ не подменяет плоскую сортировку');
  });

  it('подпись ключа сортировки: известный — из единого набора, иначе как есть', () => {
    assert.equal(filterAstSortKeyLabel('title'), 'по названию');
    assert.equal(filterAstSortKeyLabel('updated_at'), 'по дате изменения');
    assert.equal(filterAstSortKeyLabel('p-size'), 'p-size');
  });
});

// ---------------------------------------------------------------------------
// 4. Единый парсер читает AST
// ---------------------------------------------------------------------------

describe('parseFilterDefinition понимает обе формы отбора', () => {
  const ast: FilterAst = {
    version: 1,
    filter: { op: 'and', children: [{ entity: { kind: 'active' }, operator: 'eq', value: true }] },
    sort: [{ key: 'created_at', order: 'asc' }],
  };

  it('AST-форма ложится в tree/sortKeys и считается непустым отбором', () => {
    const state = parseFilterDefinition(ast);
    assert.deepEqual(state.tree, {
      kind: 'group',
      op: 'and',
      children: [{ kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } }],
    });
    assert.deepEqual(state.sortKeys, [{ key: 'created_at', order: 'asc' }]);
    assert.equal(filterTreeHasAnyCriteria(state.tree ?? null), true);
  });

  it('плоское definition v1 читается прежним путём и не считается AST', () => {
    assert.equal(isFilterAstWire({ sort: 'alpha', type_ids: ['t1'] }), false);
    const state = parseFilterDefinition({ sort: 'alpha', type_ids: ['t1'] });
    assert.deepEqual(state.typeIds, ['t1']);
    assert.equal(state.tree, null);
  });

  it('битая под-выборка в значении отклоняет весь отбор, а не теряет условие (та же ось строгости)', () => {
    // Тот же принцип, что у нераспознанного ребёнка группы: «молча искажённый
    // отбор хуже пустого». Иначе лист получил бы `{kind:'none'}` и при
    // пересохранении условие с под-выборкой исчезло бы молча.
    const brokenQuery = parseFilterAstState({
      version: 1,
      filter: {
        op: 'and',
        children: [
          {
            entity: { kind: 'parents' },
            operator: 'in',
            value: { query: { op: 'xor', children: [] }, operator: 'in' },
          },
          { entity: { kind: 'active' }, operator: 'eq', value: true },
        ],
      },
    });
    assert.equal(brokenQuery.tree, null, 'нераспознанное под-дерево под-выборки — отбор пуст');

    // Тот же лист, но нераспознан оператор самой под-выборки.
    const brokenOperator = parseFilterAstState({
      version: 1,
      filter: {
        entity: { kind: 'parents' },
        operator: 'in',
        value: {
          query: { op: 'and', children: [{ entity: { kind: 'active' }, operator: 'eq', value: true }] },
          operator: 'all_in',
        },
      },
    });
    assert.equal(
      filterTreeHasAnyCriteria(brokenOperator.tree ?? null),
      true,
      'корректная под-выборка читается как прежде',
    );

    const badOperator = parseFilterAstState({
      version: 1,
      filter: {
        entity: { kind: 'parents' },
        operator: 'in',
        value: {
          query: { op: 'and', children: [{ entity: { kind: 'active' }, operator: 'eq', value: true }] },
          operator: 'bogus',
        },
      },
    });
    assert.equal(badOperator.tree, null, 'нераспознанный оператор под-выборки — отбор пуст');
  });

  it('битая форма AST не выдумывает условие', () => {
    const state = parseFilterAstState({ version: 1, filter: { op: 'xor', children: [] } });
    assert.equal(state.tree, null);
    assert.equal(filterTreeHasAnyCriteria(state.tree ?? null), false);
  });

  it('неизвестный ребёнок группы отклоняет ВСЮ группу, а не выпадает из неё (обязательство f07cf978)', () => {
    // Иначе `and[BOGUS, keywords]` при пересохранении стал бы `and[keywords]` —
    // отбор расширился бы молча (верхний уровень уже читается пустым: строгость
    // чтения обязана быть симметричной на любой глубине).
    const broken = parseFilterAstState({
      version: 1,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'active' }, operator: 'BOGUS', value: true },
          { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'счёт*' },
        ],
      },
    });
    assert.equal(broken.tree, null, 'нераспознанный ребёнок — весь отбор пуст');
    assert.equal(filterTreeHasAnyCriteria(broken.tree ?? null), false);

    // Глубже: неизвестный лист в под-дереве тоже отклоняет корень.
    const deep = parseFilterAstState({
      version: 1,
      filter: {
        op: 'and',
        children: [
          {
            op: 'or',
            children: [
              { entity: { kind: 'active' }, operator: 'eq', value: true },
              { entity: { kind: 'active' }, operator: 'BOGUS', value: true },
            ],
          },
        ],
      },
    });
    assert.equal(deep.tree, null, 'строгость держится на любой глубине');

    // Здоровая форма рядом с тем же словом читается как прежде.
    const healthy = parseFilterAstState({
      version: 1,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'active' }, operator: 'eq', value: true },
          { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'счёт*' },
        ],
      },
    });
    assert.equal(filterTreeHasAnyCriteria(healthy.tree ?? null), true);
  });
});

// ---------------------------------------------------------------------------
// 5. Профиль контекста как параметр конвертера
// ---------------------------------------------------------------------------

describe('профиль контекста задаёт словарь операндов и операторов', () => {
  it('состав берётся из общего реестра @etn/shared', () => {
    assert.deepEqual(filterProfileOperands('thoughts').includes('type'), true);
    assert.equal(filterProfileOperands('chronicle').includes('type'), false);
    assert.equal(filterProfileOperands('events').includes('entity_id'), true);
    assert.deepEqual(filterProfileOperators('thoughts', 'type').includes('in_hierarchy'), true);
    assert.deepEqual(filterProfileOperators('events', 'entity_id'), ['eq', 'ne', 'in', 'not_in', 'all_of']);
    assert.deepEqual(filterProfileOperators('chronicle', 'record_time').includes('between'), true);
    assert.deepEqual(filterProfileTokenFamilies('chronicle').includes('time'), true);
    assert.deepEqual(filterProfileTokenFamilies('thoughts'), ['calendar']);
  });

  it('под-выборочные и наборные операторы — только на релевантных операндах (c088f9e1)', () => {
    // Предикаты и скалярные характеристики: триада без наборов и «в иерархии».
    for (const kind of ['active', 'trashed', 'comment', 'keywords', 'author', 'editor', 'created_at', 'properties'] as const) {
      const ops = filterProfileOperators('thoughts', kind);
      for (const op of ['any_of', 'all_of', 'none_of', 'in_hierarchy'] as const) {
        assert.ok(!ops.includes(op), `${kind}: нерелевантный оператор ${op}`);
      }
    }
    // Булев предикат — ровно «равно»/«не равно» (триада «да/нет/не важно»).
    assert.deepEqual(filterProfileOperators('thoughts', 'active'), ['eq', 'ne']);
    // «Есть слова» — только matches.
    assert.deepEqual(filterProfileOperators('thoughts', 'keywords'), ['matches']);
    // Структурные «Родители»/«Потомки» и «Тип» — релевантны под-выборке.
    for (const kind of ['parents', 'children'] as const) {
      for (const op of ['all_of', 'any_of', 'none_of', 'in_hierarchy'] as const) {
        assert.ok(filterProfileOperators('thoughts', kind).includes(op), `${kind}: ${op}`);
      }
    }
    assert.ok(filterProfileOperators('thoughts', 'type').includes('any_of'));
    assert.ok(!filterProfileOperators('thoughts', 'type').includes('all_of'), '«Тип» одиночный');
    // «Тип связи» — иерархия есть, под-выборка исполнителем отложена.
    assert.ok(filterProfileOperators('thoughts', 'link_type').includes('in_hierarchy'));
    assert.ok(!filterProfileOperators('thoughts', 'link_type').includes('all_of'));
  });

  it('состав свойства — по природе (9bdddad6): скаляр без «все в выборке», ссылка с ним', () => {
    // Скаляры: даты/числа — сравнения без наборов; булево — только равно/не равно.
    assert.ok(filterProfileOperators('thoughts', 'property', 'date').includes('between'));
    assert.ok(!filterProfileOperators('thoughts', 'property', 'date').includes('all_of'));
    assert.ok(!filterProfileOperators('thoughts', 'property', 'number').includes('all_of'));
    assert.deepEqual(filterProfileOperators('thoughts', 'property', 'bool'), ['eq', 'ne']);
    // Свойство-ссылка: наборные («все в выборке») и «в иерархии».
    for (const op of ['in', 'not_in', 'any_of', 'all_of', 'none_of', 'in_hierarchy'] as const) {
      assert.ok(filterProfileOperators('thoughts', 'property', 'link').includes(op), `link: ${op}`);
    }
    // Природа неизвестна — объединённый набор операнда (не пустой, содержит наборы).
    const union = filterProfileOperators('thoughts', 'property');
    assert.ok(union.includes('all_of') && union.includes('contains'));
    // Профиль другой сущности отдаёт свой состав, а не состав свойства.
    assert.deepEqual(filterProfileOperators('chronicle', 'record_title'), ['eq', 'ne', 'contains', 'not_contains', 'matches']);
    assert.ok(!filterProfileOperators('chronicle', 'record_title').includes('all_of'));
  });

  it('проверка дерева по профилю: недоступный операнд, оператор, арность НЕ', () => {
    const node: FilterTreeGroup = {
      kind: 'group',
      op: 'and',
      children: [
        leaf({ kind: 'type' }, 'eq', { kind: 'none' }),
        leaf({ kind: 'entity_id' }, 'gt', { kind: 'none' }),
        { kind: 'group', op: 'not', children: [leaf({ kind: 'action' }, 'eq', { kind: 'none' }), leaf({ kind: 'user' }, 'eq', { kind: 'none' })] },
      ],
    };
    const events = validateFilterTree(node, 'events');
    const messages = events.map((issue) => issue.message).join(' | ');
    assert.match(messages, /операнд «type» недоступен/, 'опечатка: операнд чужого профиля');
    assert.match(messages, /оператор «gt» недоступен для операнда «entity_id»/);
    assert.match(messages, /группа «не» обязана иметь ровно одного ребёнка/);
    assert.equal(validateFilterTree(node, 'thoughts').some((i) => i.message.includes('«гt»')), false);
  });

  it('strict-сборка отклоняет отбор вне профиля, свободная — собирает', () => {
    const state = treeState(group('and', [leaf({ kind: 'type' }, 'eq', { kind: 'none' })]));
    assert.deepEqual(buildFilterAst(state, { profile: 'thoughts' }).filter, {
      op: 'and',
      children: [{ entity: { kind: 'type' }, operator: 'eq' }],
    });
    assert.throws(
      () => buildFilterAst(state, { profile: 'chronicle', strict: true }),
      /профилю «chronicle»/,
    );
    assert.throws(
      () =>
        parseFilterAstState(
          { version: 1, filter: { entity: { kind: 'type' }, operator: 'eq' } },
          { profile: 'chronicle', strict: true },
        ),
      /профилю «chronicle»/,
    );
  });

  it('под-выборка проверяется по тому же профилю', () => {
    const node = leaf(
      { kind: 'targets' },
      'in',
      {
        kind: 'subquery',
        operator: 'in',
        node: group('and', [leaf({ kind: 'record_body' }, 'matches', { kind: 'scalar', value: 'x' })]),
      },
    );
    assert.equal(validateFilterTree(node, 'chronicle').length, 0, 'запись дневника видна в под-выборке');
    assert.match(
      validateFilterTree(node, 'thoughts').map((i) => i.message).join(' | '),
      /операнд «targets» недоступен/,
    );
  });
});

// ---------------------------------------------------------------------------
// Хелперы модели
// ---------------------------------------------------------------------------

describe('хелперы модели дерева', () => {
  it('конструкторы заготовок и признак непустого дерева', () => {
    assert.deepEqual(defaultFilterTreeGroup('or'), { kind: 'group', op: 'or', children: [] });
    assert.deepEqual(defaultFilterTreeLeaf({ kind: 'active' }), {
      kind: 'leaf',
      entity: { kind: 'active' },
      operator: 'eq',
      value: { kind: 'none' },
    });
    assert.equal(filterTreeHasAnyCriteria(group('and', [group('or', [])])), false);
    assert.equal(filterTreeHasAnyCriteria(group('and', [defaultFilterTreeLeaf({ kind: 'active' })])), true);
    assert.equal(filterTreeHasAnyCriteria(null), false);
  });

  it('неявное значение булевых триад (ошибка 609deba0 п.3)', () => {
    // Триада «да/нет» показывает «да», и значение обязано попасть в модель —
    // иначе проверка «условие без значения» висит при видимом «= да».
    const active = defaultFilterTreeLeaf({ kind: 'active' });
    assert.deepEqual(filterLeafImplicitValue(active), { kind: 'scalar', value: true });
    active.operator = 'ne';
    assert.deepEqual(filterLeafImplicitValue(active), { kind: 'scalar', value: true });
    // Другие операнды/операторы неявного значения не имеют.
    assert.equal(filterLeafImplicitValue(defaultFilterTreeLeaf({ kind: 'id' })), null);
    assert.deepEqual(
      filterLeafImplicitValue({ ...defaultFilterTreeLeaf({ kind: 'trashed' }), value: { kind: 'scalar', value: false } }),
      { kind: 'scalar', value: true },
    );
    const comment = { ...defaultFilterTreeLeaf({ kind: 'comment' }), operator: 'is_empty' as const };
    assert.equal(filterLeafImplicitValue(comment), null);
  });

  it('неявный ОПЕРАТОР наличия коллекции: «да» уходит в модель, а не в подпись пустого условия (ошибки 23c7d3e9 п. D1 / 609deba0 п. A3)', () => {
    // Вид «(да) (нет)» наличия коллекции — это ОПЕРАТОР (`not_empty` — «да»),
    // значения у него нет. Пока лист несёт `eq`, подпись «не задано значение
    // условия» висит при видимом «да», а клик по «нет» прятал переключатели.
    for (const kind of ['comment', 'attachments', 'chronology'] as const) {
      assert.equal(filterLeafImplicitOperator(defaultFilterTreeLeaf({ kind })), 'not_empty', `${kind}: «да» — not_empty`);
      assert.equal(
        filterLeafImplicitOperator({ ...defaultFilterTreeLeaf({ kind }), operator: 'ne' }),
        'not_empty',
        `${kind}: сравнение без значения тоже сводится к «да»`,
      );
      // Оператор уже выражает выбор — подменять нечего.
      assert.equal(
        filterLeafImplicitOperator({ ...defaultFilterTreeLeaf({ kind }), operator: 'is_empty' }),
        null,
        `${kind}: «нет» не переписывается`,
      );
      assert.equal(
        filterLeafImplicitOperator({ ...defaultFilterTreeLeaf({ kind }), operator: 'not_empty' }),
        null,
        `${kind}: «да» уже в модели`,
      );
      // Значения у предиката наличия нет — автоподстановка значения не полагается.
      assert.equal(filterLeafDefaultValue(defaultFilterTreeLeaf({ kind })), null, `${kind}: значение не подставляется`);
    }
    // Операнды другого вида автоподстановки оператора не имеют.
    assert.equal(filterLeafImplicitOperator(defaultFilterTreeLeaf({ kind: 'active' })), null);
    assert.equal(filterLeafImplicitOperator(defaultFilterTreeLeaf({ kind: 'id' })), null);
    assert.equal(filterLeafImplicitOperator(defaultFilterTreeLeaf({ kind: 'properties' })), null);
  });

  it('«Есть комментарий» round-trip: условие «да» едет в AST оператором not_empty', () => {
    const node = { ...defaultFilterTreeLeaf({ kind: 'comment' }) };
    const implicit = filterLeafImplicitOperator(node);
    if (implicit !== null) node.operator = implicit;
    const state = { ...defaultFilterCriteriaState(), tree: group('and', [node]) };
    const ast = buildFilterAst(state, { profile: 'thoughts' });
    const back = parseFilterAstState(ast, { profile: 'thoughts', strict: true });
    const leafBack = (back.tree as FilterTreeGroup).children[0] as FilterTreeLeaf;
    assert.equal(leafBack.operator, 'not_empty');
    assert.equal(leafBack.value.kind, 'none');
  });

  it('автоподстановка значения снимает признак пустого условия (ошибка 609deba0 п. A3)', () => {
    // Булева триада: «да» попадает в модель.
    assert.deepEqual(filterLeafDefaultValue(defaultFilterTreeLeaf({ kind: 'active' })), {
      kind: 'scalar',
      value: true,
    });
    // Датовый ОПЕРАНД: ячейка даты показывает «$today».
    assert.deepEqual(filterLeafDefaultValue(defaultFilterTreeLeaf({ kind: 'created_at' })), {
      kind: 'token',
      token: '$today',
    });
    // «Между» у датового операнда — пара опор-границ.
    assert.deepEqual(
      filterLeafDefaultValue({ ...defaultFilterTreeLeaf({ kind: 'occurred_at' }), operator: 'between' }),
      { kind: 'list', items: [{ token: '$today' }, { token: '$today' }] },
    );
    // Датовое СВОЙСТВО (nature из реестра): «= $today».
    assert.deepEqual(
      filterLeafDefaultValue(
        { ...defaultFilterTreeLeaf({ kind: 'property', property_id: 'p' }), operator: 'eq' },
        'date',
      ),
      { kind: 'token', token: '$today' },
    );
    // Непустое значение не подменяется — явно выбранную дату обобщение не трогает.
    assert.equal(
      filterLeafDefaultValue({
        ...defaultFilterTreeLeaf({ kind: 'created_at' }),
        value: { kind: 'scalar', value: '2026-01-01' },
      }),
      null,
    );
    // Операторам без значения и не-датовым операндам дефолт не полагается.
    assert.equal(
      filterLeafDefaultValue({ ...defaultFilterTreeLeaf({ kind: 'created_at' }), operator: 'is_empty' }),
      null,
    );
    assert.equal(filterLeafDefaultValue(defaultFilterTreeLeaf({ kind: 'keywords' })), null);
  });
});

/** Операнд каждого вида для round-trip-теста операндов. */
function entityForKind(kind: FilterAstEntityKind): FilterAstEntity {
  switch (kind) {
    case 'property':
      return { kind: 'property', property_id: 'p-size', property: 'Размер', direction: 'out' };
    case 'keywords':
      return { kind: 'keywords', scope: ['title', 'comment'] };
    default:
      return { kind } as FilterAstEntity;
  }
}
