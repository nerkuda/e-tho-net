/**
 * Предопределённые наборы отборов (задача 347b307e; арбитраж оркестратора
 * 2026-10-14).
 *
 * Доказательства:
 *   • канонизатор условий (`filter-canonical.ts`): порядок детей `И`/`ИЛИ` и
 *     форма токена (`$week.start` ↔ `$weekStart`) не меняют канон, подписи
 *     (`labels`) в сравнение не входят, пустое дерево — пустая строка;
 *   • посев (`predefined-filters.ts`): первое открытие создаёт все наборы;
 *     повторное — без дублей; переименованный эквивалент не дублируется;
 *     изменённые условия дают НОВЫЙ набор рядом; конфликт имени — свободное имя
 *     (`duplicateFilterName`), без падения;
 *   • наборы обеих панелей — по перечню заказчика, собираются единым
 *     конструктором и проходят профиль СТРОГО (сборка и проверка профиля здесь;
 *     ИСПОЛНЕНИЕ тел наборов реальным запросом — `server/tests/predefined-sets-execute.test.ts`);
 *   • «Мои записи за неделю» несёт `record_author eq $user` (токен, не литерал).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import type {
  FilterTreeGroup,
  FilterTreeLeaf,
  FilterTreeNode,
  FilterTreeValue,
} from '../src/renderer/lib/filter-builder.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

installShim();

const canonicalMod = await import('../src/renderer/lib/filter-canonical.js');
const seedMod = await import('../src/renderer/lib/predefined-filters.js');
const builder = await import('../src/renderer/lib/filter-builder.js');
const structures = await import('../src/renderer/screens/structures/filter-panel.js');
const chronicle = await import('../src/renderer/screens/chronicle/filter-panel.js');

type TreeNode = FilterTreeNode;

/** Лист дерева-группы. */
function leaf(entity: string, operator: string, value?: FilterTreeValue): TreeNode {
  return {
    kind: 'leaf',
    entity: { kind: entity } as FilterTreeLeaf['entity'],
    operator: operator as FilterTreeLeaf['operator'],
    value: value ?? { kind: 'none' },
  };
}

function group(op: 'and' | 'or', children: TreeNode[]): TreeNode {
  return { kind: 'group', op, children };
}

/** Определение-«строка» беззначного сравнения прогнать через ридер панели. */
function canonStructures(def: unknown): string {
  return structures.canonicalDefinition(def);
}

describe('канонизатор условий отбора (задача 347b307e)', () => {
  it('порядок детей И/ИЛИ не меняет канон, вложенность — сохраняется', () => {
    const a = group('and', [
      leaf('active', 'eq', { kind: 'scalar', value: true }),
      leaf('trashed', 'eq', { kind: 'scalar', value: false }),
    ]);
    const b = group('and', [
      leaf('trashed', 'eq', { kind: 'scalar', value: false }),
      leaf('active', 'eq', { kind: 'scalar', value: true }),
    ]);
    assert.equal(canonicalMod.canonicalFilterTree(a), canonicalMod.canonicalFilterTree(b));

    const nested = group('and', [group('or', [leaf('parents', 'is_empty')]), leaf('active', 'eq', { kind: 'scalar', value: true })]);
    assert.notEqual(
      canonicalMod.canonicalFilterTree(a),
      canonicalMod.canonicalFilterTree(nested),
      'разные условия — разный канон',
    );
  });

  it('токены: $week.start эквивалентен $weekStart, арифметика сохраняется', () => {
    assert.equal(canonicalMod.normalizeFilterToken('$week.start'), '$weekStart');
    assert.equal(canonicalMod.normalizeFilterToken('$week.end+1w'), '$weekEnd+1w');
    assert.equal(canonicalMod.normalizeFilterToken('$month.start-1mo'), '$monthStart-1mo');
    assert.equal(canonicalMod.normalizeFilterToken('$today-30d'), '$today-30d');

    const dotted = group('and', [
      leaf('created_at', 'between', { kind: 'list', items: [{ token: '$week.start' }, { token: '$week.end' }] }),
    ]);
    const camel = group('and', [
      leaf('created_at', 'between', { kind: 'list', items: [{ token: '$weekStart' }, { token: '$weekEnd' }] }),
    ]);
    assert.equal(canonicalMod.canonicalFilterTree(dotted), canonicalMod.canonicalFilterTree(camel));
  });

  it('labels не входят в сравнение, одиночный лист оборачивается в группу, пустота — пустая строка', () => {
    const plain = leaf('trashed', 'eq', { kind: 'scalar', value: true });
    const labelled: FilterTreeLeaf = {
      kind: 'leaf',
      entity: { kind: 'trashed' } as FilterTreeLeaf['entity'],
      operator: 'eq',
      value: { kind: 'scalar', value: true },
      labels: { entity: 'Пометка удаления', value: 'да' },
    };
    assert.equal(canonicalMod.canonicalFilterTree(plain), canonicalMod.canonicalFilterTree(labelled));
    assert.equal(
      canonicalMod.canonicalFilterTree(plain),
      canonicalMod.canonicalFilterTree(group('and', [plain])),
      'одиночный лист = группа И из одного условия',
    );
    assert.equal(canonicalMod.canonicalFilterTree(group('and', [])), '');
    assert.equal(canonicalMod.canonicalFilterTree(null), '');
  });

  it('области поиска «Найти слова» сортируются и дедуплицируются', () => {
    const one = group('and', [leaf('keywords', 'matches', { kind: 'scalar', value: 'x' })]);
    (one as FilterTreeGroup).children[0] = {
      kind: 'leaf',
      entity: { kind: 'keywords', scope: ['title', 'synonyms'] },
      operator: 'matches',
      value: { kind: 'scalar', value: 'x' },
    };
    const two = group('and', [leaf('keywords', 'matches', { kind: 'scalar', value: 'x' })]);
    (two as FilterTreeGroup).children[0] = {
      kind: 'leaf',
      entity: { kind: 'keywords', scope: ['synonyms', 'title', 'title'] },
      operator: 'matches',
      value: { kind: 'scalar', value: 'x' },
    };
    assert.equal(canonicalMod.canonicalFilterTree(one), canonicalMod.canonicalFilterTree(two));
  });
});

describe('посев предопределённых наборов (задача 347b307e)', () => {
  const presets = [
    { name: 'Набор A', definition: { a: 1 } },
    { name: 'Набор B', definition: { b: 2 } },
  ];
  // Канон — по определению (в тесте хелпера — тождество JSON).
  const canonicalOf = (def: unknown): string => (def === null || def === undefined ? '' : JSON.stringify(def));

  it('первое открытие — все наборы, повторное — без дублей', () => {
    const created = seedMod.predefinedFiltersToCreate(presets, [], canonicalOf);
    assert.deepEqual(created.map((c) => c.name), ['Набор A', 'Набор B']);

    const rows = created.map((c, i) => ({ id: `id-${i}`, name: c.name, definition: c.definition }));
    assert.deepEqual(seedMod.predefinedFiltersToCreate(presets, rows, canonicalOf), []);
  });

  it('переименованный эквивалент НЕ дублируется (сопоставление по условиям)', () => {
    const rows = [{ id: 'id-1', name: 'Мой сиротский', definition: { a: 1 } }];
    const created = seedMod.predefinedFiltersToCreate(presets, rows, canonicalOf);
    assert.deepEqual(created.map((c) => c.name), ['Набор B'], 'A найден по условиям, создаётся только B');
  });

  it('изменённые пользователем условия — оригинал добавляется рядом со свободным именем', () => {
    // Имена заняты, но условия изменены: ни один набор не найден, а имена
    // конфликтуют — свободное имя даёт `duplicateFilterName`.
    const rows = [
      { id: 'id-1', name: 'Набор A', definition: { a: 999 } },
      { id: 'id-2', name: 'Набор B', definition: { b: 999 } },
    ];
    const created = seedMod.predefinedFiltersToCreate(presets, rows, canonicalOf);
    assert.deepEqual(created.map((c) => c.name), ['Набор A (копия)', 'Набор B (копия)']);
  });

  it('помечает строки, условия которых совпали с предопределёнными', () => {
    const rows = [
      { id: 'id-1', name: 'Как угодно', definition: { a: 1 } },
      { id: 'id-2', name: 'Чужой', definition: { z: 9 } },
    ];
    const ids = seedMod.predefinedFilterIds(presets, rows, canonicalOf);
    assert.deepEqual([...ids], ['id-1']);
  });

  it('нечитаемое определение не роняет посев', () => {
    const throwing = (): string => {
      throw new Error('boom');
    };
    const rows = [{ id: 'id-1', name: 'Набор A', definition: { a: 1 } }];
    assert.deepEqual(seedMod.predefinedFiltersToCreate(presets, rows, throwing).map((c) => c.name), [
      'Набор A (копия)',
      'Набор B',
    ]);
  });
});

describe('предопределённые наборы панели «Структур» (задача 347b307e)', () => {
  it('перечень и условия — по постановке заказчика', () => {
    assert.deepEqual(
      structures.PREDEFINED_FILTERS.map((p) => p.name),
      [
        'Сиротские мысли (без родителей)',
        'Создано на этой неделе',
        'Создано за 30 дней',
        'Помеченные на удаление',
      ],
    );
  });

  it('каждый набор собирается конструктором и проходит профиль `thoughts` СТРОГО (сборка и профиль; ИСПОЛНЕНИЕ тел — server/tests/predefined-sets-execute.test.ts)', () => {
    for (const preset of structures.PREDEFINED_FILTERS) {
      const state = structures.readFilterDefinition(preset.definition);
      // Строгая сборка = тело, которое панель реально отправит в запрос.
      const ast = builder.buildFilterAst(state, { profile: 'thoughts', strict: true });
      assert.equal(ast.version, 1);
    }
  });

  it('«Создано на этой неделе» несёт created_at между $weekStart и $weekEnd + видимость', () => {
    const preset = structures.PREDEFINED_FILTERS.find((p) => p.name === 'Создано на этой неделе')!;
    const ast = builder.buildFilterAst(structures.readFilterDefinition(preset.definition), {
      profile: 'thoughts',
      strict: true,
    });
    const wire = JSON.stringify(ast.filter);
    assert.match(wire, /"kind":"created_at"/);
    assert.match(wire, /\$weekStart/);
    assert.match(wire, /\$weekEnd/);
    assert.match(wire, /"kind":"active"/);
    assert.match(wire, /"kind":"trashed"/);
  });

  it('канонизация по ридеру панели: переименованный эквивалент не дублируется', () => {
    const preset = structures.PREDEFINED_FILTERS[0]!;
    // Та же группа, но условия в другом порядке и с подписями — канон тот же.
    const reordered = {
      version: 1,
      filter: {
        op: 'and',
        children: [
          { entity: { kind: 'trashed' }, operator: 'eq', value: false },
          { entity: { kind: 'active' }, operator: 'eq', value: true },
          { entity: { kind: 'parents' }, operator: 'is_empty', labels: { entity: 'Родители' } },
        ],
      },
    };
    assert.equal(canonStructures(preset.definition), canonStructures(reordered));
    const created = seedMod.predefinedFiltersToCreate(
      [preset],
      [{ id: 'x', name: 'Как угодно', definition: reordered }],
      canonStructures,
    );
    assert.deepEqual(created, []);
  });
});

describe('предопределённые наборы панели «Дневника» (задача 347b307e)', () => {
  it('перечень и условия — по постановке заказчика, «Дата создания» = Период записи', () => {
    assert.deepEqual(
      chronicle.PREDEFINED_FILTERS.map((p) => p.name),
      ['Мои записи за неделю', 'Записи за 30 дней'],
    );
    const week = chronicle.PREDEFINED_FILTERS[0]!;
    const ast = builder.buildFilterAst(chronicle.readFilterDefinition(week.definition), {
      profile: 'chronicle',
      strict: true,
    });
    const wire = JSON.stringify(ast.filter);
    assert.match(wire, /"kind":"record_time"/, 'период — record_time, а не created_at');
    assert.match(wire, /"kind":"record_author"/);
    assert.match(wire, /"token":"\$user"/, 'автор записи — токен $user, не литерал');
    assert.ok(!wire.includes('created_at'), 'новый операнд created_at не заводится');
  });

  it('каждый набор собирается конструктором и проходит профиль `chronicle` СТРОГО', () => {
    for (const preset of chronicle.PREDEFINED_FILTERS) {
      const state = chronicle.readFilterDefinition(preset.definition);
      const ast = builder.buildFilterAst(state, { profile: 'chronicle', strict: true });
      assert.equal(ast.version, 1);
    }
  });
});
