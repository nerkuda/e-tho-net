/**
 * Перетаскивание условий и групп в дереве отбора (задача 31b228f0, этап 2;
 * критерии 1–4 и 7).
 *
 * Проверяется ПРОВОДКА жеста к модели: захват за индикатор `И`/`ИЛИ`,
 * адресация строк путём, перенос внутри/между группами, бросок в пустую группу,
 * `Shift`-копирование, отказ модели (цикл/арность `НЕ`) без мусора и
 * клавиатурный путь (`Alt+↑/↓/←/→`). Сам канал жеста и модель дерева покрыты
 * отдельно (`drag-tree.test.ts`, `filter-tree-model.test.ts`).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`); прямоугольники строк
 * задаются вручную, потому что цель броска считается по геометрии.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import type { LinkType, NetworkProperty } from '@etn/shared';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement, type ShimRect } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Минимальный DOM/window-шим (как в `filter-tree.test.ts`). */
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
  // Сообщение об отказе проверяется до автоснятия: таймер не срабатывает.
  win['setTimeout'] = () => 1;
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

const CITY = {
  id: 'p-city',
  name: 'Город',
  value_type: 'text',
  config: { options: ['Москва'], multiple: false },
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const DATE = {
  id: 'p-date',
  name: 'Дата',
  value_type: 'date',
  config: null,
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const LINK_TYPE = {
  id: 'lt-1',
  name_forward: 'Место покупки',
  name_reverse: 'Покупки здесь',
} as unknown as LinkType;

const REGISTRY: ReadonlyMap<string, NetworkProperty> = new Map([
  [CITY.id, CITY],
  [DATE.id, DATE],
]);

const DATA = { registry: REGISTRY, linkTypes: [LINK_TYPE] };

let leafOf: (entity: Record<string, unknown>) => any = () => null;
let builder: any;

const rect = (top: number, bottom: number, left = 0, right = 100): ShimRect => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

function setRect(node: ShimElement, top: number, bottom: number): void {
  node.rect = rect(top, bottom);
}

/** Все элементы с точным классом. */
function exact(root: ShimElement, cls: string): ShimElement[] {
  return root.findAll((node) => node.classList.contains(cls));
}

/** Элемент `.ft-item` по ключу пути. */
function itemAt(root: ShimElement, path: string): ShimElement {
  const found = exact(root, 'ft-item').find((node) => node.dataset['path'] === path);
  assert.ok(found !== undefined, `есть строка с путём ${path}`);
  return found!;
}

/** Ручка-индикатор строки (первый ребёнок `.ft-item`). */
function handleOf(item: ShimElement): ShimElement {
  const handle = item.children.find((child) => child.classList.contains('ft-connector'));
  assert.ok(handle !== undefined, 'у строки есть ручка И/ИЛИ');
  return handle!;
}

/** Тело группы по ключу пути (пустой ключ — корень). */
function bodyAt(root: ShimElement, path: string): ShimElement {
  const found = exact(root, 'ft-group__body').find((node) => node.dataset['groupPath'] === path);
  assert.ok(found !== undefined, `есть тело группы ${path}`);
  return found!;
}

/** pointerdown → pointermove → pointerup (с необязательным Shift). */
function drag(
  handle: ShimElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  shift = false,
): void {
  handle.emit('pointerdown', {
    button: 0,
    clientX: from.x,
    clientY: from.y,
    pointerId: 1,
    preventDefault: () => undefined,
  });
  handle.emit('pointermove', { clientX: to.x, clientY: to.y, pointerId: 1, shiftKey: shift });
  handle.emit('pointerup', { clientX: to.x, clientY: to.y, pointerId: 1, shiftKey: shift });
}

/** Нажать команду переноса без мыши на строке в фокусе. */
function key(root: ShimElement, item: ShimElement, name: string): boolean {
  root.emit('focusin', {});
  let prevented = false;
  const handled = keymap.dispatchKeyEvent({
    key: name,
    altKey: true,
    target: item,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as KeyboardEvent);
  root.emit('focusout', { relatedTarget: null });
  return handled || prevented;
}

/** Идентификаторы свойств листьев корневой группы. */
function rootLeafIds(state: any): Array<string | undefined> {
  return state.tree.children.map((node: any) =>
    node.kind === 'leaf' ? node.entity.property_id : `group:${node.children.length}`,
  );
}

before(async () => {
  installShim();
  builder = await import('../src/renderer/lib/filter-builder.js');
  leafOf = (entity) => builder.defaultFilterTreeLeaf(entity as any);
});

beforeEach(() => keymap.keymapInternals.reset());

describe('дерево отбора: адресация и ручка перетаскивания (31b228f0)', () => {
  it('строкам дан data-path, телам групп — data-group-path, индикатор — ручка', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        { kind: 'group', op: 'or', children: [leafOf({ kind: 'property', property_id: DATE.id })] },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;

    assert.equal(itemAt(root, '0').dataset['kind'], 'leaf');
    assert.equal(itemAt(root, '1').dataset['kind'], 'group');
    assert.equal(bodyAt(root, '').dataset['groupPath'], '', 'у корневого тела пустой путь');
    assert.equal(bodyAt(root, '1').dataset['groupPath'], '1');
    assert.equal(itemAt(root, '0').tabIndex, 0, 'строка достижима фокусом');
    assert.equal(itemAt(root, '0').getAttribute('tabindex'), '0', 'фокус задан и в разметке');
    assert.equal(handleOf(itemAt(root, '0')).getAttribute('aria-hidden'), 'true');
  });
});

describe('дерево отбора: перенос указателем (31b228f0)', () => {
  it('перенос внутри группы меняет последовательность', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        leafOf({ kind: 'property', property_id: DATE.id }),
        leafOf({ kind: 'property', property_id: 'p-other' }),
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;

    setRect(bodyAt(root, ''), 0, 200);
    setRect(itemAt(root, '0'), 0, 20);
    setRect(itemAt(root, '1'), 20, 40);
    setRect(itemAt(root, '2'), 40, 60);

    drag(handleOf(itemAt(root, '0')), { x: 10, y: 5 }, { x: 10, y: 55 });

    assert.deepEqual(rootLeafIds(state), [DATE.id, 'p-other', CITY.id]);
  });

  it('бросок в пустую группу добавляет условие именно в неё', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        { kind: 'group', op: 'and', children: [] },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;

    setRect(bodyAt(root, ''), 0, 200);
    setRect(itemAt(root, '0'), 0, 20);
    setRect(bodyAt(root, '1'), 100, 150);

    drag(handleOf(itemAt(root, '0')), { x: 10, y: 5 }, { x: 10, y: 120 });

    assert.equal(state.tree.children.length, 1, 'условие ушло из корня');
    const group = state.tree.children[0];
    assert.equal(group.kind, 'group');
    assert.equal(group.children.length, 1, 'условие в пустой группе');
    assert.equal(group.children[0].entity.property_id, CITY.id);
  });

  it('перенос группы между группами тянет всё содержимое', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'group', op: 'and', children: [leafOf({ kind: 'property', property_id: CITY.id })] },
        { kind: 'group', op: 'or', children: [leafOf({ kind: 'property', property_id: DATE.id })] },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;

    setRect(bodyAt(root, ''), 0, 200);
    setRect(itemAt(root, '0'), 0, 30);
    setRect(bodyAt(root, '0'), 0, 30);
    setRect(bodyAt(root, '1'), 40, 100);
    setRect(itemAt(root, '1.0'), 50, 70);

    drag(handleOf(itemAt(root, '0')), { x: 10, y: 5 }, { x: 10, y: 90 });

    assert.equal(state.tree.children.length, 1, 'перенесённая группа ушла из корня');
    const target = state.tree.children[0];
    assert.equal(target.kind, 'group');
    assert.equal(target.children.length, 2, 'группа вошла в приёмник целиком');
    const moved = target.children[1];
    assert.equal(moved.kind, 'group', 'перенесена группа, а не лист');
    assert.equal(moved.children[0].entity.property_id, CITY.id, 'содержимое группы сохранено');
  });

  it('Shift-копирование оставляет исходник и добавляет глубокую копию', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        leafOf({ kind: 'property', property_id: DATE.id }),
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;

    setRect(bodyAt(root, ''), 0, 200);
    setRect(itemAt(root, '0'), 0, 20);
    setRect(itemAt(root, '1'), 20, 40);

    drag(handleOf(itemAt(root, '0')), { x: 10, y: 5 }, { x: 10, y: 35 }, true);

    assert.equal(state.tree.children.length, 3, 'исходник остался, копия добавлена');
    assert.equal(state.tree.children[0].entity.property_id, CITY.id);
    assert.equal(state.tree.children[2].entity.property_id, CITY.id);
    assert.notEqual(state.tree.children[0], state.tree.children[2], 'копия — новый узел');
    assert.notEqual(
      state.tree.children[0].entity,
      state.tree.children[2].entity,
      'копия не делит сущность с исходником',
    );
  });

  it('цикл отклоняется: модель не меняется, причина видна', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'group',
          op: 'and',
          children: [leafOf({ kind: 'property', property_id: CITY.id })],
        },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;
    const before = JSON.stringify(state.tree);

    setRect(bodyAt(root, ''), 0, 200);
    setRect(itemAt(root, '0'), 0, 100);
    setRect(bodyAt(root, '0'), 0, 100);
    setRect(itemAt(root, '0.0'), 10, 30);

    const source = itemAt(root, '0');
    drag(handleOf(source), { x: 10, y: 5 }, { x: 10, y: 50 });

    assert.equal(JSON.stringify(state.tree), before, 'модель не изменилась');
    assert.ok(source.classList.contains('ft-item--drop-rejected'), 'строка подсвечена');
    const reason = exact(source, 'ft-drop-reject')[0];
    assert.ok(reason !== undefined, 'причина отказа показана');
    assert.match(reason!.flatText(), /саму себя|потомка/);
  });

  it('арность НЕ: второе условие в группу НЕ не вставляется, модель цела', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        {
          kind: 'group',
          op: 'not',
          children: [leafOf({ kind: 'property', property_id: DATE.id })],
        },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    const root = tree.root as unknown as ShimElement;
    const before = JSON.stringify(state.tree);

    setRect(bodyAt(root, ''), 0, 200);
    setRect(itemAt(root, '0'), 0, 20);
    setRect(itemAt(root, '1'), 40, 80);
    setRect(bodyAt(root, '1'), 40, 80);
    setRect(itemAt(root, '1.0'), 50, 70);

    const source = itemAt(root, '0');
    drag(handleOf(source), { x: 10, y: 5 }, { x: 10, y: 75 });

    assert.equal(JSON.stringify(state.tree), before, 'модель не изменилась');
    const reason = exact(source, 'ft-drop-reject')[0];
    assert.ok(reason !== undefined, 'причина отказа показана');
    assert.match(reason!.flatText(), /НЕ/);
    assert.equal(state.tree.children[1].children.length, 1, 'у НЕ по-прежнему один ребёнок');
  });
});

describe('дерево отбора: перенос без мыши (критерий 7)', () => {
  it('Alt+↓/↑ двигают условие внутри группы и возвращают фокус', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        leafOf({ kind: 'property', property_id: DATE.id }),
        leafOf({ kind: 'property', property_id: 'p-other' }),
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;

    assert.equal(key(root, itemAt(root, '0'), 'ArrowDown'), true);
    root = tree.root as unknown as ShimElement;
    assert.deepEqual(rootLeafIds(state), [DATE.id, CITY.id, 'p-other']);
    assert.equal(itemAt(root, '1').focused, true, 'фокус переехал вместе с условием');

    assert.equal(key(root, itemAt(root, '1'), 'ArrowUp'), true);
    root = tree.root as unknown as ShimElement;
    assert.deepEqual(rootLeafIds(state), [CITY.id, DATE.id, 'p-other']);
    assert.equal(itemAt(root, '0').focused, true);
  });

  it('Alt+→ вкладывает условие в соседнюю группу', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        leafOf({ kind: 'property', property_id: CITY.id }),
        { kind: 'group', op: 'and', children: [leafOf({ kind: 'property', property_id: DATE.id })] },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;

    assert.equal(key(root, itemAt(root, '0'), 'ArrowRight'), true);
    root = tree.root as unknown as ShimElement;
    assert.equal(state.tree.children.length, 1, 'условие ушло из корня');
    const group = state.tree.children[0];
    assert.equal(group.children.length, 2);
    assert.equal(group.children[1].entity.property_id, CITY.id);
    assert.equal(itemAt(root, '0.1').focused, true, 'фокус — на перенесённом условии');
  });

  it('Alt+← выносит условие из группы на уровень выше', async () => {
    const mod = await import('../src/renderer/lib/filter-tree.js');
    const state = builder.defaultFilterCriteriaState();
    state.tree = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'group',
          op: 'or',
          children: [leafOf({ kind: 'property', property_id: CITY.id })],
        },
      ],
    };
    const tree = mod.buildFilterTree({ profile: 'thoughts', getState: () => state, data: DATA });
    let root = tree.root as unknown as ShimElement;

    assert.equal(key(root, itemAt(root, '0.0'), 'ArrowLeft'), true);
    root = tree.root as unknown as ShimElement;
    assert.equal(state.tree.children.length, 2, 'условие вынесено к родителю');
    assert.equal(state.tree.children[0].kind, 'group');
    assert.equal(state.tree.children[1].kind, 'leaf');
    assert.equal(state.tree.children[1].entity.property_id, CITY.id);
    assert.equal(itemAt(root, '1').focused, true);
  });
});
