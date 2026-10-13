/**
 * Тесты панели отбора «Структур» после пересборки на единый редактор
 * (задача 213bd2d2, требование 54cba705, ADR fc23f9c1 «судьба спец-секций»).
 *
 * Доказательства требуемого поведения:
 *   * спец-секций в экране нет — панель смонтирована КОРНЕМ редактора (`.fe`),
 *     групп «Ключевые слова» / «Выбирать потомков по связям» в разметке нет;
 *   * пустое дерево даёт ПЛОСКИЙ пустой отбор без `ast` — контракт «нет
 *     критериев → HOME + сироты» (§15.3) держится на отсутствии `ast`;
 *   * прежний плоский отбор («Родительские мысли» + «Выбирать потомков по
 *     связям») читается тем же конвертером и переводится в строку
 *     «Родители в иерархии» с режимом «по всем связям» (решение 2026-10-12);
 *   * политика видимости плоского контракта (только актуальные, без помеченных)
 *     впекается в AST как обычные листья и снимается явным условием дерева или
 *     настройкой «Показывать неактуальные».
 *
 * Панель монтируется на минимальном DOM-шиме (как `structures-dates-filter`).
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
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    etn: {
      admin: { listUsers: async () => [] },
      propertyRegistry: { list: async () => [] },
      savedFilters: { list: async () => [], create: async () => ({}), update: async () => ({}), remove: async () => undefined },
      structures: { query: async () => ({ items: [], total: 0 }), queryIds: async () => ({ ids: [], total: 0 }) },
      thoughts: {
        resolve: async () => [],
        findDuplicates: async () => [],
      },
    },
  };
}

let panel: typeof import('../src/renderer/screens/structures/filter-panel.js');
let stateMod: typeof import('../src/renderer/state.js');
let host: ShimElement;

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const LINK_TYPE_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Листья дерева модели (`kind: 'leaf'`) или узла AST (нет `children`) в порядке
 * обхода — обе формы различаются наличием `children`.
 */
function leaves(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node.children)) {
    for (const child of node.children) leaves(child, out);
    return out;
  }
  out.push(node);
  return out;
}

/** Concatenated text of a subtree (the shim keeps text per node). */
function textOf(node: ShimElement): string {
  let out = node.textContent;
  for (const child of node.children) out += ` ${textOf(child)}`;
  return out.trim();
}

before(async () => {
  installShim();
  stateMod = await import('../src/renderer/state.js');
  stateMod.store.state.networkId = '00000000-0000-4000-8000-0000000000aa';
  panel = await import('../src/renderer/screens/structures/filter-panel.js');
  host = new ShimElement('div');
  panel.mountFilterPanel(host as unknown as HTMLElement, {
    onApply: () => undefined,
    onStatePersist: () => undefined,
    onCommands: () => undefined,
  });
});

describe('панель «Структур» — единый редактор отбора (задача 213bd2d2)', () => {
  it('спец-секций в экране нет: панель — корень редактора, а не список групп', () => {
    assert.notEqual(host.querySelector('.fe'), null, 'панель смонтирована редактором');
    assert.notEqual(host.querySelector('.fe-foot'), null, 'низ редактора на месте');
    assert.equal(host.querySelector('.st-f-block'), null, 'спец-секций панели не осталось');
    const text = textOf(host);
    for (const gone of [
      'Ключевые слова',
      'Выбирать потомков по связям',
      'Обход по связям',
      'Родительские мысли',
    ]) {
      assert.ok(!text.includes(gone), `секция «${gone}» убрана из экрана`);
    }
  });

  it('пустое дерево → плоский пустой отбор без AST (HOME + сироты, §15.3)', () => {
    panel.setFilterState({
      ...panel.getFilterState(),
      tree: { kind: 'group', op: 'and', children: [] },
      sortKeys: [],
    });
    const filter = panel.buildQueryFilter();
    assert.equal(filter.ast, undefined, 'пустое дерево уходит без ast');
    // Ключа в паре нет: сортировку панели несёт секция чипов, а пустые чипы не
    // воскрешают легаси-поле `state.sort` (ошибка 32fd6125) — порядок по
    // умолчанию сервера (для плоского отбора это `created`).
    assert.equal(filter.sort, undefined);
    assert.equal(filter.order, undefined);
  });

  it('прежний плоский отбор читается конвертером и переводится в «в иерархии по всем связям»', () => {
    // 1) Снимок L4 прежней панели (плоская модель, camelCase).
    const snapshot = JSON.stringify({
      keywords: 'кот',
      parentIds: [PARENT_ID],
      linkFilterTypeIds: [LINK_TYPE_ID],
      linkFilterStructural: true,
      sort: 'alpha',
      order: 'desc',
    });
    const fromSnapshot = leaves(panel.parseFilterState(snapshot).tree);
    const snapshotRoots = fromSnapshot.find((leaf) => leaf.entity.kind === 'parents');
    assert.notEqual(snapshotRoots, undefined, 'строка «Родители» собрана из parent_ids');
    assert.equal(snapshotRoots.operator, 'in_hierarchy');
    assert.equal(snapshotRoots.mode, 'all_links', 'аналог «в иерархии по всем типам связей»');
    assert.deepEqual(snapshotRoots.value, { kind: 'list', items: [PARENT_ID] });
    assert.ok(
      fromSnapshot.some((leaf) => leaf.entity.kind === 'keywords'),
      'ключевые слова стали строкой «Есть слова»',
    );

    // 2) Сохранённый отбор прежней формы (плоское определение v1, snake_case).
    const saved = panel.readFilterDefinition({
      parent_ids: [PARENT_ID],
      link_filter: { type_ids: [LINK_TYPE_ID], include_structural: true },
      type_ids: ['22222222-2222-4222-8222-222222222222'],
    });
    const savedRows = leaves(saved.tree);
    const savedRoots = savedRows.find((leaf) => leaf.entity.kind === 'parents');
    assert.notEqual(savedRoots, undefined, 'сохранённый parent_ids тоже стал строкой');
    assert.equal(savedRoots.mode, 'all_links');
    assert.ok(savedRows.some((leaf) => leaf.entity.kind === 'type'));

    // Плоского фасада в отборе больше нет: запрос уходит деревом.
    panel.setFilterState({ ...panel.getFilterState(), ...saved, savedFilterId: null, panelWidth: null });
    const filter = panel.buildQueryFilter();
    assert.notEqual(filter.ast, undefined, 'непустое дерево уходит AST');
    assert.equal((filter as Record<string, unknown>)['parent_ids'], undefined);
    assert.equal((filter as Record<string, unknown>)['link_filter'], undefined);
  });

  it('политика видимости: только актуальные и без помеченных, снимается настройкой и условием', () => {
    const fresh = panel.getFilterState();
    const withKeyword = {
      ...fresh,
      tree: {
        kind: 'group',
        op: 'and',
        children: [
          {
            kind: 'leaf',
            entity: { kind: 'keywords' },
            operator: 'matches',
            value: { kind: 'scalar', value: 'кот' },
          },
        ],
      },
      sortKeys: [],
    };
    panel.setFilterState(withKeyword as any);
    const filter = panel.buildQueryFilter();
    const astLeaves = leaves({ kind: 'group', op: 'and', children: [filter.ast!.filter] });
    const kinds = astLeaves.map((leaf) => leaf.entity.kind);
    assert.ok(kinds.includes('active'), 'дефолт «только актуальные» впечён листом');
    assert.ok(kinds.includes('trashed'), 'дефолт «без помеченных» впечён листом');
    const active = astLeaves.find((leaf) => leaf.entity.kind === 'active');
    assert.equal(active.value, true);
    const trashed = astLeaves.find((leaf) => leaf.entity.kind === 'trashed');
    assert.equal(trashed.value, false);

    // Явное условие дерева сильнее дефолта: строка «Только актуальные: нет».
    stateMod.store.state.showInactive = true;
    const explicit = {
      ...withKeyword,
      tree: {
        kind: 'group',
        op: 'and' as const,
        children: [
          ...(withKeyword.tree as any).children,
          { kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } },
        ],
      },
    };
    panel.setFilterState(explicit as any);
    const kinds2 = leaves({ kind: 'group', op: 'and', children: [panel.buildQueryFilter().ast!.filter] }).map(
      (leaf) => leaf.entity.kind,
    );
    assert.ok(kinds2.includes('active'));
    // Настройка снимает дефолт «только актуальные», но не подменяет условие.
    assert.equal(kinds2.filter((kind) => kind === 'active').length, 1, 'одно условие по active, без дубля');
    stateMod.store.state.showInactive = false;
  });

  it('пустая настройка видимости: без show_inactive дефолт по active остаётся', () => {
    const only = {
      ...panel.getFilterState(),
      tree: {
        kind: 'group',
        op: 'and' as const,
        children: [
          {
            kind: 'leaf',
            entity: { kind: 'keywords' },
            operator: 'matches',
            value: { kind: 'scalar', value: 'кот' },
          },
        ],
      },
      sortKeys: [],
    };
    panel.setFilterState(only as any);
    const kinds = leaves({ kind: 'group', op: 'and', children: [panel.buildQueryFilter().ast!.filter] }).map(
      (leaf) => leaf.entity.kind,
    );
    assert.ok(kinds.includes('active'), 'актуальность по умолчанию в отборе');
  });

  it('treeHasConditions: пустая группа и null — отбор без условий', () => {
    assert.equal(panel.treeHasConditions(null), false);
    assert.equal(panel.treeHasConditions({ kind: 'group', op: 'and', children: [] }), false);
    assert.equal(
      panel.treeHasConditions({
        kind: 'group',
        op: 'and',
        children: [{ kind: 'group', op: 'or', children: [{ kind: 'leaf', entity: { kind: 'active' }, operator: 'eq', value: { kind: 'scalar', value: true } }] }],
      } as any),
      true,
    );
  });
});
