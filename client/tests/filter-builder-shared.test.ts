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

import {
  ACTIVITY_ACTION_FILTERS,
  AUTHOR_OP_LABELS,
  FILTER_ORDERS,
  FILTER_SORTS,
  authorFilterActive,
  buildChronicleWire,
  buildSearchCriteriaWire,
  buildWireFilter,
  compileActivityCriteriaToAst,
  compileActivityCriteriaToAstDetailed,
  defaultActivityCriteriaState,
  defaultChronicleCriteriaState,
  defaultFilterCriteriaState,
  defaultSearchCriteriaState,
  parseActivityCriteria,
  parseChronicleCriteria,
  parseFilterDefinition,
  parseSearchCriteria,
  searchCriteriaToStored,
  searchSubtreeRoots,
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

  it('строка поиска карты: набор настроек переживает сохранение', () => {
    const state = {
      ...defaultSearchCriteriaState(),
      subtree: true,
      subrootIds: ['root-1', 'root-2'],
      onlyLinks: true,
      typeIds: ['t1', 't2'],
      linkTypeIds: ['l1'],
      trashed: true,
      authorId: 'u1',
    };
    const back = parseSearchCriteria(searchCriteriaToStored(state));
    assert.deepEqual(back, state, 'записанное читается тем же парсером');
  });

  it('строка поиска карты: одиночный `subrootId` прошлых версий читается набором', () => {
    const back = parseSearchCriteria({ subtree: true, subrootId: 'root-1' });
    assert.equal(back.subtree, true);
    assert.deepEqual(back.subrootIds, ['root-1'], 'старый ключ — набор из одной мысли');
  });
});

// ---------------------------------------------------------------------------
// 1b. Мысли-подкорни запроса поиска (задача a3247f84)
// ---------------------------------------------------------------------------

describe('мысли-подкорни запроса поиска', () => {
  it('выключенный флажок — поиск без подкорня', () => {
    const state = { ...defaultSearchCriteriaState(), subrootIds: ['a', 'b'] };
    assert.deepEqual(searchSubtreeRoots(state, 'focus-1'), [null]);
  });

  it('пустой набор при включённом флажке — запасной вариант «текущий фокус»', () => {
    const state = { ...defaultSearchCriteriaState(), subtree: true };
    assert.deepEqual(searchSubtreeRoots(state, 'focus-1'), ['focus-1']);
    assert.deepEqual(searchSubtreeRoots(state, null), [null]);
  });

  it('выбранные мысли — по запросу на каждую (объединение поддеревьев)', () => {
    const state = {
      ...defaultSearchCriteriaState(),
      subtree: true,
      subrootIds: ['a', 'b'],
    };
    assert.deepEqual(searchSubtreeRoots(state, 'focus-1'), ['a', 'b']);
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

  it('строка поиска хранит типы массивом (а не одним id)', () => {
    const wire = buildSearchCriteriaWire({
      ...defaultSearchCriteriaState(),
      typeIds: ['t1', 't2'],
      linkTypeIds: ['l1', 'l2'],
    });
    assert.deepEqual(wire.type_id, ['t1', 't2']);
    assert.deepEqual(wire.link_type_id, ['l1', 'l2']);
  });

  // Задача 77923b49: настройка «Показывать содержимое корзины» гасит критерий
  // «Корзина» в панели «Структур» — ровно так же, как «Показывать
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
