/**
 * Приём перетаскиваемых значений строкой условия (этап 3 задачи 31b228f0,
 * критерии приёмки 5 и 6).
 *
 * Проверяется поведением, а не якорями исходников (якоря — только на
 * обязанность каркаса зарегистрировать строку):
 *   • совместимость вида значения — ЕДИНСТВЕННЫЙ предикат
 *     `filterValueAcceptsPayload` (мысль в `entity`/свойство-связь — да; в
 *     дату/число/перечисление — нет);
 *   • приёмник ячейки и строки зарегистрирован в реальной разметке дерева и
 *     побеждает приёмник панели «Структур» (`walkDropField` — ближайший предок);
 *   • совместимый бросок пишет модель тем же путём (`api.setValue`/`touch`),
 *     несовместимый — не меняет модель и показывает объяснение.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), модули импортируются
 * ПОСЛЕ установки шима (конвенция `filter-value.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import type { FilterTreeHandle } from '../src/renderer/lib/filter-tree.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');
const readText = (rel: string): string => readFileSync(resolve(RENDERER, rel), 'utf8');

/** Заглушка `window.etn`: любой путь — разрешающий вызов с пустым списком. */
function etnStub(): unknown {
  const target = async (): Promise<unknown[]> => [];
  return new Proxy(target as unknown as Record<string, unknown>, {
    get: (obj, prop) =>
      prop === 'then' ? undefined : prop in obj ? (obj as any)[prop] : etnStub(),
    apply: () => Promise.resolve([]),
  });
}

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  // Не исполняем отложенные callback'и: notice снимал бы себя сразу.
  win['setTimeout'] = () => 1;
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win['etn'] = etnStub();
}

let builder: typeof import('../src/renderer/lib/filter-builder.js');
let treeMod: typeof import('../src/renderer/lib/filter-tree.js');
let valueMod: typeof import('../src/renderer/lib/filter-value.js');
let dropMod: typeof import('../src/renderer/lib/thought-drop.js');

before(async () => {
  installShim();
  builder = await import('../src/renderer/lib/filter-builder.js');
  treeMod = await import('../src/renderer/lib/filter-tree.js');
  valueMod = await import('../src/renderer/lib/filter-value.js');
  dropMod = await import('../src/renderer/lib/thought-drop.js');
});

/** Строка реестра свойства. */
function prop(id: string, name: string, valueType: NetworkProperty['value_type']): NetworkProperty {
  return {
    id,
    network_id: 'n',
    name,
    value_type: valueType,
    config: null,
    description: null,
    created_at: '',
    updated_at: '',
  } as unknown as NetworkProperty;
}

const REGISTRY = new Map<string, NetworkProperty>([
  ['p-text', prop('p-text', 'Заметка', 'text')],
  ['p-num', prop('p-num', 'Вес', 'number')],
  ['p-date', prop('p-date', 'Срок', 'date')],
  ['p-link', prop('p-link', 'Место', 'link')],
]);

function valueCtx(): any {
  return {
    networkId: 'net-1',
    profile: 'thoughts',
    data: { registry: REGISTRY, linkTypes: [], thoughtTypes: [] },
  };
}

function leaf(entity: any, operator: any, value: any = { kind: 'none' }): any {
  return { kind: 'leaf', entity, operator, value };
}

// ---------------------------------------------------------------------------
// 1. Совместимость — один предикат (критерий 5)
// ---------------------------------------------------------------------------

describe('совместимость перетаскиваемого значения с ячейкой условия', () => {
  it('мысль принимают ссылочный операнд-мысль и свойство-связь', () => {
    const ctx = valueCtx();
    for (const kind of ['parents', 'children', 'targets', 'id'] as const) {
      assert.equal(
        valueMod.filterValueAcceptsPayload(leaf({ kind }, 'in'), ctx, { kind: 'thought', id: 't' }),
        true,
        kind,
      );
    }
    assert.equal(
      valueMod.filterValueAcceptsPayload(
        leaf({ kind: 'property', property_id: 'p-link' }, 'in'),
        ctx,
        { kind: 'thought', id: 't' },
      ),
      true,
      'свойство-связь',
    );
  });

  it('мысль НЕ принимают дата, число, текст и перечисление', () => {
    const ctx = valueCtx();
    const cases: Array<[any, string]> = [
      [leaf({ kind: 'created_at' }, 'gte'), 'датовый операнд'],
      [leaf({ kind: 'property', property_id: 'p-date' }, 'gte'), 'свойство-дата'],
      [leaf({ kind: 'property', property_id: 'p-num' }, 'eq'), 'свойство-число'],
      [leaf({ kind: 'property', property_id: 'p-text' }, 'eq'), 'свойство-текст'],
      [leaf({ kind: 'kind' }, 'eq'), 'перечисление (вид вложения)'],
      [leaf({ kind: 'active' }, 'eq'), 'булев предикат'],
    ];
    for (const [node, label] of cases) {
      assert.equal(
        valueMod.filterValueAcceptsPayload(node, ctx, { kind: 'thought', id: 't' }),
        false,
        label,
      );
    }
  });

  it('остальные виды значений совместимы со «своими» ячейками', () => {
    const ctx = valueCtx();
    assert.equal(
      valueMod.filterValueAcceptsPayload(leaf({ kind: 'type' }, 'in'), ctx, { kind: 'type', id: 'tt' }),
      true,
      'тип мысли',
    );
    assert.equal(
      valueMod.filterValueAcceptsPayload(leaf({ kind: 'link_type' }, 'in'), ctx, { kind: 'type', id: 'lt' }),
      true,
      'тип связи',
    );
    assert.equal(
      valueMod.filterValueAcceptsPayload(leaf({ kind: 'created_at' }, 'gte'), ctx, {
        kind: 'date',
        value: '2026-10-17',
      }),
      true,
      'дата',
    );
    assert.equal(
      valueMod.filterValueAcceptsPayload(leaf({ kind: 'property', property_id: 'p-text' }, 'eq'), ctx, {
        kind: 'string',
        value: 'заметка',
      }),
      true,
      'строка',
    );
    // Текстовые НЕ-свойства («Имя вложения», «Заголовок сущности», записи
    // дневника) принимают строку: природа значения — из каталога операндов.
    for (const kind of ['name', 'entity_title', 'record_title', 'record_body'] as const) {
      assert.equal(
        valueMod.filterValueAcceptsPayload(leaf({ kind }, 'contains'), ctx, {
          kind: 'string',
          value: 'слово',
        }),
        true,
        `текстовый операнд ${kind}`,
      );
    }
    // Нетекстовые операнды строку не принимают.
    assert.equal(
      valueMod.filterValueAcceptsPayload(leaf({ kind: 'size' }, 'gt'), ctx, {
        kind: 'string',
        value: '10',
      }),
      false,
      'размер — число',
    );
    // Несовместимые пары.
    assert.equal(
      valueMod.filterValueAcceptsPayload(leaf({ kind: 'parents' }, 'in'), ctx, { kind: 'date', value: '2026-10-17' }),
      false,
    );
    assert.equal(
      valueMod.filterValueAcceptsPayload(leaf({ kind: 'created_at' }, 'gte'), ctx, { kind: 'string', value: 'x' }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Реальная разметка: приоритет приёмника и запись значения (критерий 6)
// ---------------------------------------------------------------------------

/** Собрать дерево из двух условий: `parents in` и дата `gte`. */
function buildTree(): {
  handle: FilterTreeHandle;
  state: any;
  touches: () => number;
  panelAdds: () => number;
} {
  const state = builder.defaultFilterCriteriaState();
  const parentLeaf = leaf({ kind: 'parents' }, 'in');
  const dateLeaf = leaf({ kind: 'created_at' }, 'gte');
  state.tree = { kind: 'group', op: 'and', children: [parentLeaf, dateLeaf] };
  let touches = 0;
  let panelAdds = 0;
  const handle = treeMod.buildFilterTree({
    profile: 'thoughts',
    getState: () => state,
    data: { registry: REGISTRY, linkTypes: [], thoughtTypes: [] },
    renderValue: valueMod.createFilterValueRenderer(valueCtx()),
    touch: () => {
      touches += 1;
    },
  });
  // Приёмник панели «Структур» — ХОСТ вокруг всего дерева (как в filter-panel).
  dropMod.registerThoughtDropField(handle.root, {
    kind: 'filter',
    accept: () => {
      panelAdds += 1;
      return true;
    },
  });
  return { handle, state, touches: () => touches, panelAdds: () => panelAdds };
}

function itemAt(root: ShimElement, path: string): ShimElement {
  const item = root.findAll(
    (node) => node.classList.contains('ft-item') && node.dataset['path'] === path,
  )[0];
  assert.ok(item !== undefined, `строка ${path} отрисована`);
  return item;
}

function valueBox(item: ShimElement): ShimElement {
  const box = item.findAll((node) => node.classList.contains('fv'))[0];
  assert.ok(box !== undefined, 'ячейка значения отрисована');
  return box;
}

describe('приём облачка в условие: ближайший приёмник и запись', () => {
  it('ячейка и строка условия побеждают приёмник панели', () => {
    const { handle } = buildTree();
    const root = handle.root as unknown as ShimElement;
    const item = itemAt(root, '0');
    const box = valueBox(item);
    // С ячейки и со строки находится СВОЙ приёмник, а не хост панели.
    assert.notEqual(dropMod.resolveThoughtDropField(box as any)?.el, handle.root);
    assert.notEqual(dropMod.resolveThoughtDropField(item as any)?.el, handle.root);
    // Приёмник строки зарегистрирован отдельно (критерий 6: и строка, и ячейка).
    assert.notEqual(
      dropMod.resolveThoughtDropField(item as any)?.el,
      dropMod.resolveThoughtDropField(box as any)?.el,
    );
    handle.destroy();
  });

  it('совместимый бросок мысли устанавливает значение и вызывает touch()', () => {
    const { handle, state, touches, panelAdds } = buildTree();
    const root = handle.root as unknown as ShimElement;
    const item = itemAt(root, '0');
    const found = dropMod.resolveThoughtDropField(item as any);
    assert.ok(found !== null);
    assert.equal(found.handlers.kind, 'filter');
    assert.equal(found.handlers.acceptPayload!({ kind: 'thought', id: 'thought-1' }), true);
    // Модель изменилась тем же путём, что ручной выбор значения.
    assert.deepEqual(state.tree.children[0].value, { kind: 'list', items: ['thought-1'] });
    assert.ok(touches() > 0, 'правка значения идёт общим путём touch()');
    assert.equal(panelAdds(), 0, 'корень отбора панелью НЕ добавлен');
    // Повторное облачко — не изменение (перенос не снимает источник впустую).
    const again = dropMod.resolveThoughtDropField(item as any);
    assert.equal(again?.handlers.acceptPayload!({ kind: 'thought', id: 'thought-1' }), false);
    assert.equal(panelAdds(), 0);
    handle.destroy();
  });

  it('несовместимый бросок модель не меняет и объясняет причину', () => {
    const { handle, state, touches, panelAdds } = buildTree();
    const root = handle.root as unknown as ShimElement;
    const item = itemAt(root, '1'); // дата создания
    const before = JSON.stringify(state.tree.children[1]);
    const found = dropMod.resolveThoughtDropField(item as any);
    assert.ok(found !== null);
    assert.equal(found.handlers.acceptPayload!({ kind: 'thought', id: 'thought-1' }), false);
    assert.equal(JSON.stringify(state.tree.children[1]), before, 'модель не изменилась');
    assert.equal(touches(), 0, 'перерисовки/сохранения не было');
    assert.equal(panelAdds(), 0, 'в приёмник панели бросок не провалился');
    // Объяснение — тост с понятной причиной (notice).
    const body = (globalThis as any).document.body as ShimElement;
    const notice = body.findAll((node) => node.className.includes('notice'))[0];
    assert.ok(notice !== undefined, 'объяснение показано');
    assert.match(notice!.flatText(), /не принимает мысль/);
    handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// 2б. Блокер проверки: дроп в строку обновляет виджет для ВСЕХ редакторов
// ---------------------------------------------------------------------------

/**
 * Дерево под матрицу редакторов: свойство-связь, дата, текст, тип. Дроп идёт в
 * ПРИЁМНИК СТРОКИ (`.ft-item`) — именно его находит бросок в `.ft-row__what`,
 * а не виджет ячейки (для не-`entity` он писал модель без перерисовки).
 */
function buildEditorTree(): {
  handle: FilterTreeHandle;
  state: any;
} {
  const state = builder.defaultFilterCriteriaState();
  state.tree = {
    kind: 'group',
    op: 'and',
    children: [
      leaf({ kind: 'property', property_id: 'p-link' }, 'in'),
      leaf({ kind: 'created_at' }, 'gte'),
      leaf({ kind: 'property', property_id: 'p-text' }, 'eq'),
      leaf({ kind: 'type' }, 'in'),
    ],
  };
  const handle = treeMod.buildFilterTree({
    profile: 'thoughts',
    getState: () => state,
    data: { registry: REGISTRY, linkTypes: [], thoughtTypes: [] },
    renderValue: valueMod.createFilterValueRenderer(valueCtx()),
    // Как у РЕАЛЬНОГО хоста (`filter-editor.ts`): правка значения персистится
    // без пересборки дерева. Именно поэтому «лёгкий» путь записи (`api.setValue`)
    // оставлял DOM старым — без `onValueEdit` тест маскировал бы блокер.
    onValueEdit: () => undefined,
  });
  return { handle, state };
}

/** Бросок в строку — тот же приёмник, что находит `.ft-row__what`. */
function dropIntoRow(root: ShimElement, path: string, payload: any): void {
  const item = itemAt(root, path);
  const found = dropMod.resolveThoughtDropField(item as any);
  assert.ok(found !== null, `приёмник строки ${path}`);
  assert.equal(found.handlers.acceptPayload!(payload), true, `бросок в строку ${path} принят`);
}

function inputsOf(el: ShimElement): ShimElement[] {
  return el.findAll((node) => node.tagName === 'input');
}

describe('дроп в строку условия: виджет обновляется для всех видов редактора', () => {
  it('свойство-связь: в строке появляется чип значения', () => {
    const { handle, state } = buildEditorTree();
    const root = handle.root as unknown as ShimElement;
    dropIntoRow(root, '0', { kind: 'thought', id: 'th-1' });
    assert.deepEqual(state.tree.children[0].value, { kind: 'list', items: ['th-1'] });
    const fresh = itemAt(handle.root as unknown as ShimElement, '0');
    const chip = valueBox(fresh).findAll((node) => node.dataset['id'] === 'th-1');
    assert.equal(chip.length, 1, 'чип значения-связи отрисован из модели');
    handle.destroy();
  });

  it('дата: в строке появляется поле с установленной датой', () => {
    const { handle, state } = buildEditorTree();
    const root = handle.root as unknown as ShimElement;
    dropIntoRow(root, '1', { kind: 'date', value: '2026-10-17' });
    assert.deepEqual(state.tree.children[1].value, { kind: 'scalar', value: '2026-10-17' });
    const fresh = itemAt(handle.root as unknown as ShimElement, '1');
    const shown = inputsOf(valueBox(fresh)).filter((input) => input.value === '2026-10-17');
    assert.equal(shown.length, 1, 'дата видна в поле ячейки');
    handle.destroy();
  });

  it('текст: поле значения показывает установленную строку', () => {
    const { handle, state } = buildEditorTree();
    const root = handle.root as unknown as ShimElement;
    dropIntoRow(root, '2', { kind: 'string', value: 'новое' });
    assert.deepEqual(state.tree.children[2].value, { kind: 'scalar', value: 'новое' });
    const fresh = itemAt(handle.root as unknown as ShimElement, '2');
    const shown = inputsOf(valueBox(fresh)).filter((input) => input.value === 'новое');
    assert.equal(shown.length, 1, 'строка видна в поле ячейки');
    handle.destroy();
  });

  it('тип: чип типа появляется в строке', () => {
    const { handle, state } = buildEditorTree();
    const root = handle.root as unknown as ShimElement;
    dropIntoRow(root, '3', { kind: 'type', id: 'tt-1' });
    assert.deepEqual(state.tree.children[3].value, { kind: 'list', items: ['tt-1'] });
    const fresh = itemAt(handle.root as unknown as ShimElement, '3');
    const chip = valueBox(fresh).findAll((node) => node.dataset['id'] === 'tt-1');
    assert.equal(chip.length, 1, 'чип типа отрисован');
    handle.destroy();
  });
});

describe('string-payload: семантика ручного ввода', () => {
  it('множественный текст сохраняет $-токены и порядок, дубль — no-op', () => {
    const state: any = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        {
          ...leaf({ kind: 'property', property_id: 'p-text' }, 'in'),
          value: { kind: 'list', items: ['$thought.created', 'старое'] },
        },
      ],
    };
    const handle = treeMod.buildFilterTree({
      profile: 'thoughts',
      getState: () => state,
      data: { registry: REGISTRY, linkTypes: [], thoughtTypes: [] },
      renderValue: valueMod.createFilterValueRenderer(valueCtx()),
    });
    const root = handle.root as unknown as ShimElement;
    dropIntoRow(root, '0', { kind: 'string', value: 'новое' });
    assert.deepEqual(state.tree.children[0].value, {
      kind: 'list',
      items: ['$thought.created', 'старое', 'новое'],
    });
    // Повтор — не изменение (как у чип-редактора), токены на месте.
    const found = dropMod.resolveThoughtDropField(itemAt(handle.root as unknown as ShimElement, '0') as any);
    assert.equal(found?.handlers.acceptPayload!({ kind: 'string', value: 'новое' }), false);
    assert.deepEqual(state.tree.children[0].value, {
      kind: 'list',
      items: ['$thought.created', 'старое', 'новое'],
    });
    handle.destroy();
  });

  it('одиночный текст с $… становится токеном (как при ручном наборе)', () => {
    const { handle, state } = buildEditorTree();
    const root = handle.root as unknown as ShimElement;
    dropIntoRow(root, '2', { kind: 'string', value: '$thought.title' });
    assert.deepEqual(state.tree.children[2].value, { kind: 'token', token: '$thought.title' });
    handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// 3. Каркас: обязанность зарегистрировать строку (мутационно чувствительно)
// ---------------------------------------------------------------------------

describe('регистрация приёмника в каркасе дерева', () => {
  it('строка `.ft-item` получает приёмник значения от виджета ячейки', () => {
    const src = readText('lib/filter-tree.ts');
    assert.match(src, /api\.acceptDrop !== undefined/);
    assert.match(src, /registerThoughtDropField\(item, \{/);
    assert.match(src, /acceptPayload: acceptDrop,/);
  });

  it('ячейка значения регистрирует приёмник и объявляет тип для строки', () => {
    const src = readText('lib/filter-value.ts');
    assert.match(src, /api\.acceptDrop = acceptPayload;/);
    assert.match(src, /registerThoughtDropField\(box, \{/);
    assert.match(src, /acceptPayload: \(payload: ThoughtDropPayload\)/);
  });
});
