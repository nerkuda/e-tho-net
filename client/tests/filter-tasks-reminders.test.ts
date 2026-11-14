/**
 * Тесты условий отбора по задачам и напоминаниям мысли (0.16.1, задача
 * 4cfc6257, требование daf152d8; приписка модели AST — 489c394f).
 *
 * Проверяется то, за что отвечает клиентский конструктор отбора:
 *   • операнды «Есть задачи», «Есть напоминание», «Дата напоминания» входят в
 *     профиль мыслей, список «Что» даёт им подписи и смысловые значки;
 *   • вид ячейки значения: у наличия — «(да)/(нет)» (предикат), у даты
 *     напоминания — ячейка даты либо две границы;
 *   • «Дата напоминания» — датовый операнд: пары операторов, природа токенов и
 *     подменю периодов как у прочих дат;
 *   • круговой рейс wire: дерево → AST → дерево без потерь, у предикатов
 *     наличия значения в AST нет;
 *   • неявные подстановки редактора: оператор наличия и опора `$today` у даты.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `filter-value.test.ts`; модули импортируются ПОСЛЕ установки шима.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный DOM/window-шим, которого требуют фасады дизайн-системы. */
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
  // `window.etn` — контракт preload: модули живого поиска/пикеров читают его
  // на этапе сборки виджета. Разрешающий заглушечный прокси: любой вызов даёт
  // пустой список (тесты проверяют ячейку значения, а не выдачу сервера).
  win['etn'] = etnStub();
}

/** Разрешающий заглушечный `window.etn`: любой путь — вызываемое значение. */
function etnStub(): unknown {
  const target = async (): Promise<unknown[]> => [];
  return new Proxy(target as unknown as Record<string, unknown>, {
    get: (obj, prop) =>
      prop === 'then' ? undefined : prop in obj ? (obj as any)[prop] : etnStub(),
    apply: () => Promise.resolve([]),
  });
}

installShim();
const builder = await import('../src/renderer/lib/filter-builder.js');
const tree = await import('../src/renderer/lib/filter-tree.js');
const value = await import('../src/renderer/lib/filter-value.js');
const tokens = await import('../src/renderer/lib/filter-tokens.js');

type FilterTreeLeaf = import('../src/renderer/lib/filter-builder.js').FilterTreeLeaf;
type FilterCriteriaState = import('../src/renderer/lib/filter-builder.js').FilterCriteriaState;
type FilterValueContext = import('../src/renderer/lib/filter-value.js').FilterValueContext;
type FilterTreeValueSlotApi = import('../src/renderer/lib/filter-tree.js').FilterTreeValueSlotApi;
type FilterTreeOperandEntry = import('../src/renderer/lib/filter-tree.js').FilterTreeOperandEntry;

const EMPTY_REGISTRY = new Map<string, NetworkProperty>();

const CTX: FilterValueContext = {
  networkId: 'net-1',
  profile: 'thoughts',
  data: { registry: EMPTY_REGISTRY, linkTypes: [], thoughtTypes: [] },
};

/** Лист модели с операндом/оператором/значением. */
function leaf(
  entity: FilterTreeLeaf['entity'],
  operator: FilterTreeLeaf['operator'],
  leafValue: FilterTreeLeaf['value'] = { kind: 'none' },
): FilterTreeLeaf {
  return { kind: 'leaf', entity, operator, value: leafValue };
}

/** Слот значения: запоминает записанные моделью значения. */
function slot(): { api: FilterTreeValueSlotApi; writes: FilterTreeLeaf['value'][] } {
  const writes: FilterTreeLeaf['value'][] = [];
  return { api: { setValue: (next) => writes.push(next) }, writes };
}

/** Сборка ячейки значения (шим-узел). */
function render(node: FilterTreeLeaf, api: FilterTreeValueSlotApi): ShimElement {
  return value.renderFilterValue(node, api, CTX) as unknown as ShimElement;
}

/** Все потомки с точным классом. */
function all(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

/** Операндная строка списка «Что» по ключу. */
function operandEntry(key: string): FilterTreeOperandEntry {
  return tree
    .filterTreeOperandCatalogue('thoughts', { registry: EMPTY_REGISTRY })
    .find((entry) => entry.key === key)!;
}

/** Плоский список кодов операторов меню (в порядке показа). */
function menuOps(menu: ReturnType<typeof tree.filterTreeOperatorMenu>): string[] {
  return menu.flatMap((section) => section.rows.flatMap((row) => row.cells.map((cell) => cell.op)));
}

/** Листья wire-узла глубоко (в порядке обхода). */
function astLeaves(node: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (current: unknown): void => {
    const row = current as { entity?: unknown; children?: unknown[] };
    if (row.entity !== undefined) {
      out.push(current as Record<string, unknown>);
      return;
    }
    for (const child of row.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

// ---------------------------------------------------------------------------
// 1. Каталог операндов и подписи/значки списка «Что»
// ---------------------------------------------------------------------------

describe('операнды задач и напоминаний в профиле мыслей (4cfc6257)', () => {
  it('профиль мыслей объявляет все три операнда', () => {
    const operands = builder.filterProfileOperands('thoughts');
    for (const kind of ['tasks', 'reminders', 'reminder_at'] as const) {
      assert.ok(operands.includes(kind), `профиль мыслей обязан знать операнд ${kind}`);
    }
  });

  it('список «Что»: подписи и смысловые значки строк', () => {
    const expected: Array<[string, string, string]> = [
      ['tasks', 'Есть задачи', 'list-task'],
      ['reminders', 'Есть напоминание', 'calendar-month'],
      ['reminder_at', 'Дата напоминания', 'value-date'],
    ];
    for (const [key, label, icon] of expected) {
      const entry = operandEntry(key);
      assert.equal(entry.label, label, `${key}: подпись строки`);
      assert.equal(entry.icon, icon, `${key}: смысловой значок`);
      assert.equal(entry.group, 'operands', `${key}: строка идёт в характеристиках`);
      assert.equal((entry.entity as { kind: string }).kind, key);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Вид ячейки значения
// ---------------------------------------------------------------------------

describe('ячейка значения условий по задачам и напоминаниям (4cfc6257)', () => {
  it('наличие задач/напоминания — предикат «(да)/(нет)» при любом операторе', () => {
    for (const kind of ['tasks', 'reminders'] as const) {
      for (const operator of ['eq', 'ne', 'is_empty', 'not_empty'] as const) {
        assert.equal(
          value.filterValueEditor(leaf({ kind }, operator), CTX),
          'predicate',
          `${kind} ${operator}: триада наличия`,
        );
      }
    }
  });

  it('предикат рендерится двумя переключателями и пишет оператор, а не значение', () => {
    const node = leaf({ kind: 'reminders' }, 'is_empty');
    const { api, writes } = slot();
    const box = render(node, api);
    assert.equal(box.dataset['editor'], 'predicate');
    const buttons = box.findAll((n) => n.tagName.toUpperCase() === 'BUTTON');
    assert.equal(buttons.length, 2, 'два переключателя: да/нет');
    assert.equal(buttons[0]!.getAttribute('aria-pressed'), 'false', '«нет» выбран');
    assert.equal(buttons[1]!.getAttribute('aria-pressed'), 'true');
    buttons[0]!.fire('click');
    assert.equal(node.operator, 'not_empty', '«да» — это оператор not_empty');
    assert.deepEqual(writes, [{ kind: 'none' }], 'значение у предиката не задаётся');
  });

  it('дата напоминания: сравнения — ячейка даты, «между» — две границы', () => {
    for (const operator of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const) {
      assert.equal(
        value.filterValueEditor(leaf({ kind: 'reminder_at' }, operator), CTX),
        'date',
        `reminder_at ${operator}: ячейка даты`,
      );
    }
    for (const operator of ['between', 'not_between'] as const) {
      assert.equal(
        value.filterValueEditor(leaf({ kind: 'reminder_at' }, operator), CTX),
        'bounds',
        `reminder_at ${operator}: две границы`,
      );
    }
    const dateBox = render(
      leaf({ kind: 'reminder_at' }, 'gte', { kind: 'token', token: '$today' }),
      slot().api,
    );
    assert.equal(dateBox.dataset['editor'], 'date');
    assert.equal(
      dateBox.findAll((n) => n.dataset['part'] === 'anchor')[0]?.value,
      '$today',
      'опора даты напоминания — канонический токен',
    );
    const boundsBox = render(
      leaf({ kind: 'reminder_at' }, 'between', {
        kind: 'list',
        items: [{ token: '$today' }, { token: '$weekEnd' }],
      }),
      slot().api,
    );
    assert.equal(boundsBox.dataset['editor'], 'bounds');
    assert.ok(all(boundsBox, value.FILTER_VALUE_BOUNDS_CLASS).length > 0, 'границы построены');
  });
});

// ---------------------------------------------------------------------------
// 3. Датовое меню операторов и подменю периодов
// ---------------------------------------------------------------------------

describe('«Дата напоминания» — датовый операнд (4cfc6257)', () => {
  it('природа листа — дата, у наличия — не дата', () => {
    assert.equal(
      tree.filterTreeOperatorValueType(leaf({ kind: 'reminder_at' }, 'gte'), {
        registry: EMPTY_REGISTRY,
      }),
      'date',
    );
    assert.equal(tree.filterTreeIsDateLeaf(leaf({ kind: 'reminder_at' }, 'between')), true);
    assert.equal(tokens.filterTokenNature(leaf({ kind: 'reminder_at' }, 'eq'), CTX), 'date');
    for (const kind of ['tasks', 'reminders'] as const) {
      assert.equal(tree.filterTreeIsDateLeaf(leaf({ kind }, 'not_empty')), false, kind);
      assert.equal(
        tree.filterTreeOperatorValueType(leaf({ kind }, 'eq'), { registry: EMPTY_REGISTRY }),
        undefined,
        kind,
      );
    }
  });

  it('меню операторов: у даты — пары границ, у наличия — триада', () => {
    assert.deepEqual(
      menuOps(tree.filterTreeOperatorMenu('thoughts', 'reminder_at', 'date')),
      ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'between', 'not_between'],
      'датовые пары идут порядком «мин|макс»; состав — набор реестра',
    );
    assert.deepEqual(
      menuOps(tree.filterTreeOperatorMenu('thoughts', 'tasks')),
      ['eq', 'ne', 'not_empty', 'is_empty'],
      'у наличия задач — «да/нет», без сравнений',
    );
    // Состав меню — ровно реестр профиля (второго словаря у редактора нет).
    for (const [kind, valueType] of [
      ['reminder_at', 'date'],
      ['tasks', undefined],
      ['reminders', undefined],
    ] as const) {
      const menu = new Set(menuOps(tree.filterTreeOperatorMenu('thoughts', kind, valueType)));
      assert.deepEqual(
        [...menu].sort(),
        [...builder.filterProfileOperators('thoughts', kind)].sort(),
        `${kind}: меню разошлось с реестром`,
      );
    }
  });

  it('выбор «между» у даты раскрывает подменю периодов, у наличия — ставит оператор', () => {
    const dateLeaf = leaf({ kind: 'reminder_at' }, 'eq');
    const opened: Array<ReturnType<typeof tree.filterTreePeriodMenu>> = [];
    const openedMenu = tree.filterTreeOperatorChoice(dateLeaf, 'between', 'date', (menu) =>
      opened.push(menu),
    );
    assert.equal(openedMenu, true, 'подменю периодов открыто, лист пока не меняется');
    assert.equal(opened.length, 1);
    assert.ok(
      (opened[0]!.groups[0]?.items.length ?? 0) > 1,
      'в подменю есть «задать вручную» и матрица периодов',
    );

    const tasksLeaf = leaf({ kind: 'tasks' }, 'eq');
    const nextOpen = tree.filterTreeOperatorChoice(tasksLeaf, 'not_empty', undefined, () =>
      assert.fail('у предиката наличия подменю нет'),
    );
    assert.equal(nextOpen, false);
    assert.equal(tasksLeaf.operator, 'not_empty');
  });
});

// ---------------------------------------------------------------------------
// 4. Круговой рейс wire: дерево → AST → дерево
// ---------------------------------------------------------------------------

describe('wire-контракт условий по задачам и напоминаниям (4cfc6257)', () => {
  const state: FilterCriteriaState = {
    ...builder.defaultFilterCriteriaState(),
    tree: {
      kind: 'group',
      op: 'and',
      children: [
        leaf({ kind: 'tasks' }, 'not_empty'),
        leaf({ kind: 'reminders' }, 'is_empty'),
        leaf({ kind: 'reminder_at' }, 'between', {
          kind: 'list',
          items: [{ token: '$today' }, { token: '$weekEnd' }],
        }),
      ],
    },
  };

  it('строгая сборка профиля мыслей принимает дерево', () => {
    const ast = builder.buildFilterAst(state, { profile: 'thoughts', strict: true });
    assert.equal(ast.version, 1);
    const leaves = astLeaves(ast.filter);
    const tasksLeaf = leaves.find((row) => (row['entity'] as any).kind === 'tasks')!;
    const remindersLeaf = leaves.find((row) => (row['entity'] as any).kind === 'reminders')!;
    const reminderAtLeaf = leaves.find((row) => (row['entity'] as any).kind === 'reminder_at')!;
    assert.equal(tasksLeaf['operator'], 'not_empty');
    assert.equal('value' in tasksLeaf, false, 'у предиката наличия значения в AST нет');
    assert.equal(remindersLeaf['operator'], 'is_empty');
    assert.equal('value' in remindersLeaf, false);
    assert.deepEqual(reminderAtLeaf['value'], [{ token: '$today' }, { token: '$weekEnd' }]);
  });

  it('чтение AST возвращает то же дерево без потерь', () => {
    const ast = builder.buildFilterAst(state, { profile: 'thoughts' });
    const back = builder.parseFilterAstState(ast);
    assert.deepEqual(back.tree, state.tree);
  });
});

// ---------------------------------------------------------------------------
// 5. Неявные подстановки редактора
// ---------------------------------------------------------------------------

describe('неявные оператор и значение новых условий (4cfc6257)', () => {
  it('наличие: пустой `eq` показывает «да» оператором `not_empty`', () => {
    for (const kind of ['tasks', 'reminders'] as const) {
      assert.equal(
        builder.filterLeafImplicitOperator(leaf({ kind }, 'eq')),
        'not_empty',
        `${kind}: видимое «да» — оператор наличия`,
      );
      assert.equal(builder.filterLeafImplicitOperator(leaf({ kind }, 'not_empty')), null);
    }
  });

  it('дата напоминания: пустая граница подставляет опору `$today`', () => {
    assert.deepEqual(
      builder.filterLeafDefaultValue(leaf({ kind: 'reminder_at' }, 'gte'), undefined),
      { kind: 'token', token: '$today' },
    );
    assert.deepEqual(
      builder.filterLeafDefaultValue(leaf({ kind: 'reminder_at' }, 'between'), undefined),
      { kind: 'list', items: [{ token: '$today' }, { token: '$today' }] },
    );
    // «Не заполнено» значения не требует: подстановки нет.
    assert.equal(
      builder.filterLeafDefaultValue(leaf({ kind: 'reminder_at' }, 'not_empty'), undefined),
      null,
    );
  });
});
