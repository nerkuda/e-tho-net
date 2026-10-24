/**
 * Тесты единой модели отбора и единого конвертера (задача 3742dd59, версия
 * 0.8.2).
 *
 * Проверяется то, ради чего конструктор сводился к одному модулю:
 *
 *  1. сохранённый отбор каждого из пяти мест читается и пишется ОДНОЙ моделью
 *     (`FilterCriteriaState` и её экранные расширения из `lib/filter-builder.ts`)
 *     — чтение ранее сохранённого не теряет условий;
 *  2. конвертер даёт для одинакового отбора одинаковый запрос (детерминизм и
 *     идемпотентность round-trip);
 *  3. выравненные возможности доступны там, где их раньше не было: полный
 *     набор сортировок, корзина, операторы автора `empty`/`not_empty`,
 *     массив типов у строки поиска.
 *
 * Чистые функции без DOM — обычный Node-прогон.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';
import { FILTER_AST_VERSION } from '@etn/shared';

import {
  ACTIVITY_ACTION_FILTERS,
  AUTHOR_OP_LABELS,
  FILTER_ORDERS,
  FILTER_SORTS,
  authorFilterActive,
  buildChronicleWire,
  buildSearchAst,
  buildSearchCriteriaWire,
  buildWireFilter,
  compileActivityCriteriaToAst,
  compileActivityCriteriaToAstDetailed,
  compileFlatCriteriaToAst,
  defaultActivityCriteriaState,
  defaultChronicleCriteriaState,
  defaultFilterCriteriaState,
  defaultSearchCriteriaState,
  filterTreeIdsByKind,
  isTrashedDefaultLeaf,
  parseActivityCriteria,
  parseChronicleCriteria,
  parseFilterDefinition,
  parseFilterDefinitionTree,
  parseSearchCriteria,
  searchCriteriaToStored,
  type FilterCriteriaState,
  type FilterTreeLeaf,
  type FilterTreeNode,
  type SearchCriteriaState,
} from '../src/renderer/lib/filter-builder.js';

const EMPTY_REGISTRY = new Map<string, NetworkProperty>();

const REGISTRY = new Map<string, NetworkProperty>([
  [
    'p-text',
    {
      id: 'p-text',
      network_id: 'n',
      name: 'Заметка',
      value_type: 'text',
      config: null,
      description: null,
      created_at: '',
      updated_at: '',
    } as unknown as NetworkProperty,
  ],
]);

// ---------------------------------------------------------------------------
// 1. Одна модель: сохранение и чтение в каждом месте
// ---------------------------------------------------------------------------

describe('единая модель состояния переживает сохранение и чтение', () => {
  it('«Структуры»: wire → parse → wire даёт тот же запрос', () => {
    const state = {
      ...defaultFilterCriteriaState(),
      keywords: 'счет*',
      typeIds: ['t1', 't2'],
      linkTypeIds: ['l1'],
      properties: [{ propertyId: 'p-text', op: 'contains' as const, values: ['вод'] }],
      trashed: true,
      authorOp: 'empty' as const,
      createdAfter: '2024-01-01T00:00:00',
    };
    const wire1 = buildWireFilter(state, REGISTRY, { activeMode: 'structures', showInactive: true });
    const back = parseFilterDefinition(wire1);
    const wire2 = buildWireFilter(back, REGISTRY, { activeMode: 'structures', showInactive: true });
    assert.deepEqual(wire2, wire1, 'повторный проход конвертера обязан дать тот же запрос');
    assert.equal(wire1.trashed, true, 'корзина сохраняется');
    assert.equal(wire1.created_by_op, 'empty', 'оператор автора empty выражается без значения');
  });

  it('«Дневник»: определение → модель → определение идемпотентно', () => {
    const saved = {
      keywords: 'x',
      keyword_scope: ['title', 'synonyms'] as const,
      date_from: '2024-01-01',
      date_to: '2024-02-01',
      targets: { type_ids: ['t1'], link_type_ids: ['l1'], parent_ids: ['p1'] },
      created_by: 'u1',
      updated_by: 'u2',
      order: 'desc' as const,
    };
    const state = parseChronicleCriteria(saved);
    const wire1 = buildChronicleWire(state);
    const wire2 = buildChronicleWire(parseChronicleCriteria(wire1));
    assert.deepEqual(wire2, wire1, 'ранее сохранённый отбор читается без потерь');
    assert.deepEqual(state.targets.typeIds, ['t1']);
    assert.deepEqual(state.targets.parentIds, ['p1']);
    assert.equal(state.keywordInComment, false);
  });

  it('«Дневник»: пустой отбор даёт минимальное определение', () => {
    const wire = buildChronicleWire(defaultChronicleCriteriaState());
    assert.equal(wire.keywords, undefined);
    assert.equal(wire.targets, undefined);
    assert.equal(wire.link_scope, undefined);
    assert.equal(wire.order, 'asc');
  });

  it('«События»: старый формат L4 читается общей моделью', () => {
    const state = parseActivityCriteria({
      keywords: 'мысль',
      fromMs: '2024-06-01',
      toMs: '2024-06-30',
      userOp: 'in',
      userIds: ['u1', 'u2'],
      entityTypes: ['thought'],
      actions: ['created'],
    });
    assert.equal(state.createdAfter, '2024-06-01');
    assert.equal(state.createdBefore, '2024-06-30');
    assert.equal(state.authorOp, 'in');
    assert.deepEqual(state.authorIds, ['u1', 'u2']);
    assert.deepEqual(state.entityTypes, ['thought']);
    assert.deepEqual(state.actions, ['created']);
  });

  it('строка поиска карты: настройки переживают сохранение (мыслевые — AST, корпусные — плоские)', () => {
    const state: SearchCriteriaState = {
      ...defaultSearchCriteriaState(),
      onlyLinks: true,
      linkTypeIds: ['l1'],
      authorId: 'u1',
      tree: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } },
          { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } },
          {
            kind: 'leaf',
            entity: { kind: 'type' },
            operator: 'in_hierarchy',
            value: { kind: 'list', items: ['t1', 't2'] },
          },
          {
            kind: 'leaf',
            entity: { kind: 'parents' },
            operator: 'in_hierarchy',
            mode: 'all_links',
            value: { kind: 'list', items: ['root-1', 'root-2'] },
          },
        ],
      },
    };
    const back = parseSearchCriteria(searchCriteriaToStored(state));
    assert.deepEqual(back, state, 'записанное читается тем же парсером');
  });

  it('строка поиска карты: прежний плоский снимок мигрирует в дерево редактора', () => {
    const back = parseSearchCriteria({
      subtree: true,
      subrootId: 'root-1',
      typeIds: ['t1'],
      showInactive: false,
      trashed: false,
      onlyLinks: true,
    });
    // Одиночный `subrootId` — корень из одной мысли; строка подкорня хранит
    // только «Родители в иерархии» (корень добавит buildSearchAst).
    assert.deepEqual(back.tree, {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } },
        { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } },
        { kind: 'leaf', entity: { kind: 'type' }, operator: 'in_hierarchy', value: { kind: 'list', items: ['t1'] } },
        {
          kind: 'leaf',
          entity: { kind: 'parents' },
          operator: 'in_hierarchy',
          mode: 'all_links',
          value: { kind: 'list', items: ['root-1'] },
        },
      ],
    });
    assert.equal(back.onlyLinks, true, 'корпусные ключи читаются как прежде');
  });

  it('строка поиска карты: `subtree` с ПУСТЫМ набором корней сохраняет строку подкорня (фолбэк на фокус)', () => {
    const back = parseSearchCriteria({ subtree: true, subrootIds: [] });
    // Строка подкорня ОБЯЗАНА остаться: ограничение включено, мысль не выбрана —
    // значение `none`, фокус подставит buildSearchAst/expandSearchSubtreeRoots.
    assert.deepEqual(back.tree, {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } },
        { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: false } },
        {
          kind: 'leaf',
          entity: { kind: 'parents' },
          operator: 'in_hierarchy',
          mode: 'all_links',
          value: { kind: 'none' },
        },
      ],
    });
    // И при сборке AST корнем становится ТЕКУЩИЙ ФОКУС (прежнее поведение
    // `searchSubtreeRoots` → `[focusId]` → `in=subtree`+`from_thought_id=focusId`).
    const ast = buildSearchAst(back, 'focus-1');
    assert.deepEqual(ast?.filter, {
      op: 'and',
      children: [
        { entity: { kind: 'active' }, operator: 'eq', value: true },
        { entity: { kind: 'trashed' }, operator: 'eq', value: false },
        {
          op: 'or',
          children: [
            { entity: { kind: 'id' }, operator: 'in', value: ['focus-1'] },
            { entity: { kind: 'parents' }, operator: 'in_hierarchy', mode: 'all_links', value: ['focus-1'] },
          ],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 1b. AST мыслевых настроек строки поиска (задача 8f3b2cf2)
// ---------------------------------------------------------------------------

describe('AST мыслевых настроек строки поиска', () => {
  it('пустое дерево — AST нет (сервер применяет дефолты видимости сам)', () => {
    const state = { ...defaultSearchCriteriaState(), tree: null };
    assert.equal(buildSearchAst(state, 'focus-1'), undefined);
  });

  it('дефолт — только актуальные и без корзины (паритет прежних плоских флагов)', () => {
    const ast = buildSearchAst(defaultSearchCriteriaState(), null);
    assert.deepEqual(ast?.filter, {
      op: 'and',
      children: [
        { entity: { kind: 'active' }, operator: 'eq', value: true },
        { entity: { kind: 'trashed' }, operator: 'eq', value: false },
      ],
    });
  });

  it('подкорень расширяется до «ИЛИ(id в [корни], parents in_hierarchy [корни] all_links)»', () => {
    const state: FilterCriteriaState = {
      ...defaultSearchCriteriaState(),
      tree: {
        kind: 'group',
        op: 'and',
        children: [
          {
            kind: 'leaf',
            entity: { kind: 'parents' },
            operator: 'in_hierarchy',
            mode: 'all_links',
            value: { kind: 'list', items: ['a', 'b'] },
          },
        ],
      },
    };
    const ast = buildSearchAst(state, null);
    assert.deepEqual(ast?.filter, {
      op: 'and',
      children: [
        {
          op: 'or',
          children: [
            { entity: { kind: 'id' }, operator: 'in', value: ['a', 'b'] },
            { entity: { kind: 'parents' }, operator: 'in_hierarchy', mode: 'all_links', value: ['a', 'b'] },
          ],
        },
      ],
    });
  });

  it('пустая строка подкорня берёт текущий фокус (прежнее поведение)', () => {
    const state: FilterCriteriaState = {
      ...defaultSearchCriteriaState(),
      tree: {
        kind: 'group',
        op: 'and',
        children: [
          {
            kind: 'leaf',
            entity: { kind: 'parents' },
            operator: 'in_hierarchy',
            mode: 'all_links',
            value: { kind: 'none' },
          },
        ],
      },
    };
    const withFocus = buildSearchAst(state, 'focus-1');
    assert.deepEqual(withFocus?.filter, {
      op: 'and',
      children: [
        {
          op: 'or',
          children: [
            { entity: { kind: 'id' }, operator: 'in', value: ['focus-1'] },
            { entity: { kind: 'parents' }, operator: 'in_hierarchy', mode: 'all_links', value: ['focus-1'] },
          ],
        },
      ],
    });
    const withoutFocus = buildSearchAst(state, null);
    // Пустой подкорень и без фокуса — ограничение не задано: строку не создаём,
    // мыслевых условий не осталось → AST нет (поиск без ограничения, bug 46047836).
    assert.equal(withoutFocus, undefined);
  });

  it('единственная строка — пустой подкорень без фокуса: AST нет (bug 46047836)', () => {
    const state: FilterCriteriaState = {
      ...defaultSearchCriteriaState(),
      tree: {
        kind: 'group',
        op: 'and',
        children: [
          {
            kind: 'leaf',
            entity: { kind: 'parents' },
            operator: 'in_hierarchy',
            mode: 'all_links',
            value: { kind: 'list', items: [] },
          },
        ],
      },
    };
    assert.equal(buildSearchAst(state, null), undefined);
    // С фокусом — прежнее поведение: корень = фокус, строка остаётся.
    const withFocus = buildSearchAst(state, 'focus-1');
    assert.deepEqual(withFocus?.filter, {
      op: 'and',
      children: [
        {
          op: 'or',
          children: [
            { entity: { kind: 'id' }, operator: 'in', value: ['focus-1'] },
            { entity: { kind: 'parents' }, operator: 'in_hierarchy', mode: 'all_links', value: ['focus-1'] },
          ],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Один конвертер: одинаковый отбор → одинаковый запрос
// ---------------------------------------------------------------------------

describe('единый конвертер отбора', () => {
  it('одинаковое состояние даёт одинаковый wire в обоих проходах', () => {
    const state = defaultFilterCriteriaState();
    assert.deepEqual(
      buildWireFilter(state, EMPTY_REGISTRY, { activeMode: 'view' }),
      buildWireFilter(state, EMPTY_REGISTRY, { activeMode: 'view' }),
    );
    assert.deepEqual(
      buildChronicleWire(defaultChronicleCriteriaState()),
      buildChronicleWire(defaultChronicleCriteriaState()),
    );
  });

  it('компилятор «Событий» переводит плоский пресет в AST детерминированно', () => {
    const state = {
      ...defaultActivityCriteriaState(),
      entityTypes: ['thought' as const],
      actions: ['created' as const],
      createdAfter: '2024-06-01',
    };
    const ast1 = compileActivityCriteriaToAst(state);
    const ast2 = compileActivityCriteriaToAst(
      parseActivityCriteria({ entityTypes: ['thought'], actions: ['created'], fromMs: '2024-06-01' }),
    );
    assert.deepEqual(ast2, ast1, 'плоский пресет и его повторное чтение дают то же дерево');
    assert.notEqual(ast1, undefined);
    assert.equal(compileActivityCriteriaToAst(defaultActivityCriteriaState()), undefined, 'пустой отбор — без AST');
  });
});

// ---------------------------------------------------------------------------
// 3. Выравненные возможности
// ---------------------------------------------------------------------------

describe('выравненные возможности отбора', () => {
  it('единый набор сортировок полон и содержит дату изменения', () => {
    const sorts = FILTER_SORTS.map((o) => o.v);
    assert.deepEqual(sorts, ['alpha', 'created', 'viewed', 'updated']);
    assert.deepEqual(FILTER_ORDERS.map((o) => o.v), ['asc', 'desc']);
  });

  it('операторы автора empty/not_empty доступны везде', () => {
    assert.equal(AUTHOR_OP_LABELS.empty, 'не заполнено');
    assert.equal(AUTHOR_OP_LABELS.not_empty, 'заполнено');
    assert.equal(authorFilterActive('empty', '', []), true, 'empty — условие без значения');
    assert.equal(authorFilterActive('not_empty', '', []), true);
  });

  it('«События»: автор — только eq/ne/in/not_in; empty/not_empty отбрасываются профилем', () => {
    assert.deepEqual(
      [...ACTIVITY_ACTION_FILTERS],
      ['created', 'updated', 'deleted', 'trashed', 'restored'],
    );
    // Требование 1765e659: автор события — «равно», «в списке», под-выборка.
    // Прежние пресеты с `empty`/`not_empty` профиль «события» не выражает —
    // условие отбрасывается общим правилом миграции, а НЕ порождает лист
    // `user is_empty` (который сервер отверг бы с VALIDATION_ERROR).
    const empty = compileActivityCriteriaToAstDetailed({
      ...defaultActivityCriteriaState(),
      authorOp: 'empty',
    });
    assert.equal(empty.ast, undefined, 'единственное условие отброшено — критериев не осталось');
    assert.deepEqual(empty.dropped, [{ entity: { kind: 'user' }, operator: 'is_empty' }]);
    assert.equal(compileActivityCriteriaToAst({ ...defaultActivityCriteriaState(), authorOp: 'empty' }), undefined);
    // `not_in` и `ne` — выразимы, остаются.
    const notInAst = compileActivityCriteriaToAst({
      ...defaultActivityCriteriaState(),
      authorOp: 'not_in',
      authorIds: ['u1', 'u2'],
    });
    assert.deepEqual(notInAst?.filter, {
      entity: { kind: 'user' },
      operator: 'not_in',
      value: ['u1', 'u2'],
    });
    const neAst = compileActivityCriteriaToAst({
      ...defaultActivityCriteriaState(),
      authorOp: 'ne',
      authorId: 'u3',
    });
    assert.deepEqual(neAst?.filter, { entity: { kind: 'user' }, operator: 'ne', value: 'u3' });
  });

  it('строка поиска: корпусной wire несёт только тип связи и автор/редактор', () => {
    const wire = buildSearchCriteriaWire({
      ...defaultSearchCriteriaState(),
      typeIds: ['t1', 't2'],
      linkTypeIds: ['l1', 'l2'],
      authorId: 'u1',
      editorId: 'u2',
    });
    // Мыслевые настройки (типы мыслей, подкорень, видимость) в AST, а НЕ в
    // плоских параметрах (требование b91336e7: `ast` XOR плоские мыслевые).
    assert.deepEqual(wire, { link_type_id: ['l1', 'l2'], author_id: 'u1', editor_id: 'u2' });
  });

  // Задача 77923b49: настройка «Показывать содержимое корзины» гасит критерий
  // «Помечено на удаление» в панели «Структур» — ровно так же, как «Показывать
  // неактуальное» гасит «Актуальность» (иначе явный флаг отбора возвращал бы
  // на экран то, что настройка прячет).
  it('«Структуры»: выключенная настройка корзины выбрасывает критерий trashed', () => {
    const state = { ...defaultFilterCriteriaState(), trashed: true };
    const on = buildWireFilter(state, EMPTY_REGISTRY, {
      activeMode: 'structures',
      showTrash: true,
    });
    assert.equal(on.trashed, true, 'настройка включена — критерий едет в запрос');
    const off = buildWireFilter(state, EMPTY_REGISTRY, {
      activeMode: 'structures',
      showTrash: false,
    });
    assert.equal(off.trashed, undefined, 'настройка выключена — критерий не проходит');
    const absent = buildWireFilter(state, EMPTY_REGISTRY, { activeMode: 'structures' });
    assert.equal(
      absent.trashed,
      true,
      'без явной настройки поведение прежнее',
    );
    // Отбор типа мысли — другой экран: настройку видимости он не получает,
    // критерий едет как раньше.
    assert.equal(
      buildWireFilter(state, EMPTY_REGISTRY, { activeMode: 'view' }).trashed,
      true,
    );
  });
});

describe('плоские датовые границы: токен уходит в AST канонической формой (99e7889d)', () => {
  /** Листья дерева AST глубоко (в порядке обхода). */
  function astLeaves(node: unknown): Array<{ entity: { kind: string }; operator: string; value?: unknown }> {
    const out: Array<{ entity: { kind: string }; operator: string; value?: unknown }> = [];
    const walk = (current: unknown): void => {
      const row = current as { op?: string; children?: unknown[]; entity?: unknown };
      if (row.entity !== undefined) {
        out.push(current as (typeof out)[number]);
        return;
      }
      for (const child of row.children ?? []) walk(child);
    };
    walk(node);
    return out;
  }

  it('«Дата изменений между $weekStart и $today»: границы — формой `{ token }`', () => {
    // Плоская форма хранит токен СТРОКОЙ (`updatedAfter: '$weekStart'`) — поле
    // периода принимает опоры. Без канонизации сырая строка уезжала исполнителю
    // литералом и сравнивалась с колонкой как текст («отбор исполнялся, но с
    // неверными датами»), а незаполненная вторая граница приходила пустой
    // строкой — «Граница даты должна быть непустой строкой ISO-8601».
    const state: FilterCriteriaState = {
      ...defaultFilterCriteriaState(),
      updatedAfter: '$weekStart',
      updatedBefore: '$today',
      createdAfter: '2026-01-01',
    };
    const ast = compileFlatCriteriaToAst(state, EMPTY_REGISTRY, { activeMode: 'view' });
    assert.notEqual(ast, undefined, 'условия есть — AST собран');
    const leaves = astLeaves(ast!.filter);
    const updated = leaves.filter((leaf) => leaf.entity.kind === 'updated_at');
    assert.deepEqual(
      updated.map((leaf) => [leaf.operator, leaf.value]),
      [
        ['gte', { token: '$weekStart' }],
        ['lte', { token: '$today' }],
      ],
      'обе границы «Дата изменений» — в форме AST-токена, а не сырой строкой',
    );
    assert.deepEqual(
      leaves.find((leaf) => leaf.entity.kind === 'created_at')?.value,
      '2026-01-01',
      'конкретная дата остаётся литералом — токеном становится только «$…»',
    );
  });
});

describe('идентификаторы листьев дерева отбора по виду операнда (a0c071f8)', () => {
  const TYPE_ID = '11111111-1111-4111-8111-111111111111';
  const PARENT_ID = '22222222-2222-4222-8222-222222222222';

  it('плоское определение: `type_ids`/`parent_ids` находятся листьями дерева', () => {
    // Прежний рецепт публикации читался плоскими полями; в новой форме те же
    // адреса лежат листьями дерева (компилятор переводит `type_ids` в «Тип в
    // иерархии», `parent_ids` — в ИЛИ(id, родители в иерархии)) — читатель
    // предзаполнения берёт их оттуда, а не из плоских полей определения.
    const tree = parseFilterDefinitionTree({
      keywords: 'слово',
      type_ids: [TYPE_ID],
      parent_ids: [PARENT_ID],
      sort: 'created',
      order: 'asc',
    }).tree;
    assert.deepEqual(filterTreeIdsByKind(tree ?? null, 'type'), [TYPE_ID]);
    assert.deepEqual(filterTreeIdsByKind(tree ?? null, 'parents'), [PARENT_ID]);
  });

  it('AST-тело: значения берутся из листьев, пустые виды дают пусто', () => {
    const tree = parseFilterDefinitionTree({
      version: FILTER_AST_VERSION,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'type' }, operator: 'in_hierarchy', value: [TYPE_ID] },
          { entity: { kind: 'keywords', scope: ['title'] }, operator: 'matches', value: 'с' },
        ],
      },
    }).tree;
    assert.deepEqual(filterTreeIdsByKind(tree ?? null, 'type'), [TYPE_ID]);
    assert.deepEqual(filterTreeIdsByKind(tree ?? null, 'parents'), []);
  });

  it('значения-токены идентификатором не считаются', () => {
    const tree = {
      kind: 'group' as const,
      op: 'and' as const,
      children: [
        {
          kind: 'leaf' as const,
          entity: { kind: 'parents' as const },
          operator: 'in' as const,
          value: { kind: 'list' as const, items: [PARENT_ID, { token: '$today' }] },
        },
      ],
    };
    assert.deepEqual(filterTreeIdsByKind(tree, 'parents'), [PARENT_ID]);
    assert.deepEqual(filterTreeIdsByKind(null, 'parents'), []);
  });
});

// ---------------------------------------------------------------------------
// 6. Единый предикат служебного дефолта «Помечено на удаление = нет» (d3a30c3e)
// ---------------------------------------------------------------------------

describe('предикат служебного дефолта «Помечено на удаление = нет» (d3a30c3e)', () => {
  /** Лист формы `trashed eq false`; `service` задаётся только при передаче. */
  function trashedLeaf(service?: true): FilterTreeLeaf {
    return {
      kind: 'leaf',
      entity: { kind: 'trashed' },
      operator: 'eq',
      value: { kind: 'scalar', value: false },
      ...(service === true ? { service: true } : {}),
    };
  }

  it('базовый режим — только ФОРМА: метка service не влияет', () => {
    assert.equal(isTrashedDefaultLeaf(trashedLeaf()), true);
    assert.equal(isTrashedDefaultLeaf(trashedLeaf(true)), true);
  });

  it('unmarked: метку service требуется отсутствовать (плоский путь чтения)', () => {
    assert.equal(isTrashedDefaultLeaf(trashedLeaf(), { unmarked: true }), true);
    assert.equal(isTrashedDefaultLeaf(trashedLeaf(true), { unmarked: true }), false);
  });

  it('другая форма листа дефолтом не считается ни в одном режиме', () => {
    const notDefault: FilterTreeNode[] = [
      { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'eq', value: { kind: 'scalar', value: true } },
      { kind: 'leaf', entity: { kind: 'trashed' }, operator: 'ne', value: { kind: 'scalar', value: false } },
      { kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: false } },
      { kind: 'group', op: 'and', children: [] },
    ];
    for (const node of notDefault) {
      assert.equal(isTrashedDefaultLeaf(node), false, JSON.stringify(node));
      assert.equal(isTrashedDefaultLeaf(node, { unmarked: true }), false, JSON.stringify(node));
    }
  });
});
