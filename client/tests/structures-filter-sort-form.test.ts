/**
 * Тесты формы запроса панели «Структур» по сортировке и чтения L4-снимка
 * (ошибка ca864656, требование 8334b54a «Сборку отбора панель отдаёт
 * исполнителю целиком», ADR 23fab347).
 *
 * Доказательства требуемого поведения:
 *   * пустое дерево БЕЗ ключей сортировки по-прежнему уходит плоским пустым
 *     отбором без `ast` — контракт «нет критериев → HOME + сироты» (§15.3)
 *     держится на отсутствии `ast`;
 *   * единственный ключ сортировки не теряется: ключ-свойство (и имя стороны
 *     свойства-связи) уходит `ast.sort` из одного элемента, выразимый плоской
 *     парой ключ уходит парой с ключом и направлением ЧИПА, а не легаси-полей;
 *   * многоуровневая сортировка — `ast.sort` в порядке чипов;
 *   * снимок модели (`structures_state`) переживает запись/чтение: условия
 *     дерева и ключи сортировки возвращаются как были (раньше снимок всегда
 *     прогонялся через плоские поля, и дерево терялось молча);
 *   * чтение определения даёт ту же форму запроса: плоское определение с парой
 *     `sort`/`order` → ключ-легаси, AST-определение с ключом-свойством →
 *     `ast.sort`.
 *
 * Панель монтируется на минимальном DOM-шиме (как `structures-filter-terms`).
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Installs the minimal DOM/window shims the panel and its imports need. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: { getItem: () => null, setItem: () => undefined },
    etn: {
      admin: { listUsers: async () => [] },
      propertyRegistry: { list: async () => [] },
      savedFilters: {
        list: async () => [],
        create: async () => ({}),
        update: async () => ({}),
        remove: async () => undefined,
      },
      structures: {
        query: async () => ({ items: [], total: 0 }),
        queryIds: async () => ({ ids: [], total: 0 }),
      },
      thoughts: { resolve: async () => [], findDuplicates: async () => [] },
    },
  };
}

let panel: typeof import('../src/renderer/screens/structures/filter-panel.js');
let stateMod: typeof import('../src/renderer/state.js');

/** Ключ-свойство (id реестра) — плоской парой `sort`/`order` не выражается. */
const PROPERTY_KEY = '1e70b1d4-8ecc-4790-910a-181052ac72b8';

/** Пустая группа-корень — «отбор без условий». */
const EMPTY_TREE = { kind: 'group', op: 'and', children: [] } as const;

/** Строка «Есть слова» дерева (условие, чтобы проверять его сохранность). */
const KEYWORDS_LEAF = {
  kind: 'leaf',
  entity: { kind: 'keywords' },
  operator: 'matches',
  value: { kind: 'scalar', value: 'кот' },
} as const;

/** Поставить состояние панели: пустое дерево + указанные ключи сортировки. */
function setSort(sortKeys: Array<{ key: string; order: 'asc' | 'desc' }>, tree: unknown = EMPTY_TREE): void {
  panel.setFilterState({
    ...panel.getFilterState(),
    tree,
    sortKeys,
  } as any);
}

before(async () => {
  installShim();
  stateMod = await import('../src/renderer/state.js');
  stateMod.store.state.networkId = '00000000-0000-4000-8000-0000000000aa';
  panel = await import('../src/renderer/screens/structures/filter-panel.js');
  panel.mountFilterPanel(new ShimElement('div') as unknown as HTMLElement, {
    onApply: () => undefined,
    onStatePersist: () => undefined,
    onCommands: () => undefined,
  });
});

describe('ca864656: форма запроса панели по сортировке', () => {
  it('пустое дерево без ключей → плоский пустой отбор без AST (HOME + сироты, §15.3)', () => {
    setSort([]);
    const filter = panel.buildQueryFilter() as any;
    assert.equal(filter.ast, undefined, 'пустое дерево без ключей уходит без ast');
    assert.equal(filter.sort, 'created');
    assert.equal(filter.order, 'asc');
  });

  it('единственный ключ-свойство не теряется: сортировку несёт ast.sort', () => {
    setSort([{ key: PROPERTY_KEY, order: 'asc' }]);
    const filter = panel.buildQueryFilter() as any;
    assert.notEqual(filter.ast, undefined, 'ключ-свойство выражает только AST-форма');
    assert.deepEqual(filter.ast.sort, [{ key: PROPERTY_KEY, order: 'asc' }]);
    assert.equal(filter.sort, undefined, 'плоская пара ключ не несёт');
  });

  it('единственное имя обратной стороны свойства-связи тоже уходит ast.sort', () => {
    setSort([{ key: 'нужен для', order: 'desc' }]);
    const filter = panel.buildQueryFilter() as any;
    assert.deepEqual(filter.ast?.sort, [{ key: 'нужен для', order: 'desc' }]);
  });

  it('единственный выразимый ключ → плоская пара с ключом и направлением ЧИПА, режим HOME сохранён', () => {
    setSort([{ key: 'updated_at', order: 'desc' }]);
    const filter = panel.buildQueryFilter() as any;
    assert.equal(filter.ast, undefined, 'выразимый ключ сохраняет плоский пустой отбор');
    assert.equal(filter.sort, 'updated', 'легаси-пара берёт ключ чипа, а не значение по умолчанию');
    assert.equal(filter.order, 'desc', 'направление — из чипа');
  });

  it('два ключа → ast.sort в порядке чипов', () => {
    setSort([
      { key: PROPERTY_KEY, order: 'asc' },
      { key: 'created_at', order: 'desc' },
    ]);
    const filter = panel.buildQueryFilter() as any;
    assert.deepEqual(filter.ast?.sort, [
      { key: PROPERTY_KEY, order: 'asc' },
      { key: 'created_at', order: 'desc' },
    ]);
  });

  it('условие дерева + один ключ-свойство: дерево и порядок в одной AST-форме', () => {
    setSort([{ key: PROPERTY_KEY, order: 'asc' }], {
      kind: 'group',
      op: 'and',
      children: [KEYWORDS_LEAF],
    });
    const filter = panel.buildQueryFilter() as any;
    assert.deepEqual(filter.ast?.sort, [{ key: PROPERTY_KEY, order: 'asc' }]);
    assert.ok(
      JSON.stringify(filter.ast.filter).includes('"keywords"'),
      'условие дерева на месте',
    );
  });
});

describe('ca864656: L4-снимок модели переживает запись/чтение', () => {
  it('условия дерева и ключ-свойство возвращаются как были', () => {
    panel.setFilterState({
      ...panel.getFilterState(),
      tree: { kind: 'group', op: 'and', children: [KEYWORDS_LEAF] },
      sortKeys: [{ key: PROPERTY_KEY, order: 'desc' }],
    } as any);
    const snapshot = JSON.stringify(panel.getFilterState());
    const back = panel.parseFilterState(snapshot);
    assert.ok(
      JSON.stringify(back.tree).includes('"keywords"'),
      'условие дерева не потеряно при чтении снимка',
    );
    assert.deepEqual(back.sortKeys, [{ key: PROPERTY_KEY, order: 'desc' }]);
    assert.deepEqual((back as any).sort, 'created', 'плоская пара не подменяется ключом-свойством');
    // Форма запроса после переоткрытия — та же: ключ-свойство несёт ast.sort.
    panel.setFilterState(back);
    assert.deepEqual((panel.buildQueryFilter() as any).ast?.sort, [
      { key: PROPERTY_KEY, order: 'desc' },
    ]);
  });

  it('снимок без ключей сортировки сохраняет плоскую пару (легаси-режим §15.3)', () => {
    panel.setFilterState({
      ...panel.getFilterState(),
      tree: EMPTY_TREE,
      sortKeys: [],
      sort: 'viewed',
      order: 'asc',
    } as any);
    const back = panel.parseFilterState(JSON.stringify(panel.getFilterState()));
    assert.equal((back as any).sort, 'viewed', 'легаси-значение пары сохранено');
    assert.deepEqual(back.sortKeys, []);
  });

  it('снимок прежней плоской панели (без tree) читается плоским конвертером', () => {
    const back = panel.parseFilterState(
      JSON.stringify({ keywords: 'кот', sort: 'alpha', order: 'desc' }),
    );
    assert.ok(JSON.stringify(back.tree).includes('"keywords"'), 'плоские критерии стали деревом');
    assert.deepEqual(back.sortKeys, [{ key: 'title', order: 'desc' }]);
  });

  it('нечитаемое дерево снимка → откат на плоское чтение, а не падение', () => {
    const back = panel.parseFilterState(
      JSON.stringify({
        tree: { kind: 'group', op: 'and', children: [{ kind: 'leaf', entity: { kind: 'НетТакого' }, operator: 'eq' }] },
        sortKeys: [{ key: PROPERTY_KEY, order: 'asc' }],
      }),
    );
    assert.ok(
      !JSON.stringify(back.tree).includes('НетТакого'),
      'нераспознанный операнд не попадает в модель',
    );
    assert.deepEqual(
      back.sortKeys,
      [{ key: 'created_at', order: 'asc' }],
      'снимок прочитан прежним плоским путём (пара по умолчанию), а не падением',
    );
  });
});

describe('ca864656: чтение определения даёт ту же форму запроса', () => {
  it('плоское определение (пара sort/order) → ключ-легаси → плоская пара', () => {
    const state = panel.readFilterDefinition({ sort: 'alpha', order: 'desc' });
    assert.deepEqual(state.sortKeys, [{ key: 'title', order: 'desc' }]);
    panel.setFilterState({ ...panel.getFilterState(), ...state });
    const filter = panel.buildQueryFilter() as any;
    assert.equal(filter.ast, undefined, 'выразимый ключ остаётся плоской парой');
    assert.equal(filter.sort, 'alpha');
    assert.equal(filter.order, 'desc');
  });

  it('AST-определение с ключом-свойством → ast.sort при запросе', () => {
    const state = panel.readFilterDefinition({
      version: 1,
      filter: { op: 'and', children: [KEYWORDS_LEAF] },
      sort: [{ key: PROPERTY_KEY, order: 'asc' }],
    });
    assert.deepEqual(state.sortKeys, [{ key: PROPERTY_KEY, order: 'asc' }]);
    panel.setFilterState({ ...panel.getFilterState(), ...state });
    assert.deepEqual((panel.buildQueryFilter() as any).ast?.sort, [
      { key: PROPERTY_KEY, order: 'asc' },
    ]);
  });
});
