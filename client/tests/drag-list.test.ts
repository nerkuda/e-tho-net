/**
 * Поведенческие тесты общего сортируемого списка `lib/ui/drag-list.ts`
 * (задача d13fd645): клавиатурный сдвиг `Alt+↑/↓`, перетаскивание указателем
 * с порогом и линиями вставки, изоляция групп «соседи одного родителя».
 *
 * DOM-события эмулируются общим шимом (`dom-shim.ts`); ректанглы узлов задаются
 * вручную — цель дропа вычисляется по `getBoundingClientRect`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import {
  createDragList,
  DRAG_ACTIVE_CLASS,
  DRAG_OVER_AFTER_CLASS,
  type DragListHandle,
  type DragListItem,
} from '../src/renderer/lib/ui/drag-list.js';
import { resolveNavAction } from '../src/renderer/lib/ui/nav-core.js';
import { ShimElement, type ShimRect } from './dom-shim.js';

// Клавиатура списка идёт через диспетчер контекстов: стек между тестами пуст.
beforeEach(() => keymap.keymapInternals.reset());

const rect = (top: number, bottom: number): ShimRect => ({
  left: 0,
  top,
  right: 100,
  bottom,
  width: 100,
  height: bottom - top,
});

/** Сущность-заглушка: ключ строки и её `node_key` совпадают. */
interface Row {
  key: string;
}

/** Строка вместе с шим-узлами (для эмуляции событий и ректанглов). */
interface ShimItem {
  item: DragListItem<Row>;
  element: ShimElement;
  handle: ShimElement;
}

function makeItem(key: string, groupKey = 'g', orderKey?: string): ShimItem {
  const element = new ShimElement('div');
  const handle = new ShimElement('span');
  element.append(handle);
  const item: DragListItem<Row> = {
    entry: { key },
    key,
    ...(orderKey !== undefined ? { orderKey } : {}),
    groupKey,
    element: element as unknown as HTMLElement,
    handle: handle as unknown as HTMLElement,
  };
  return { item, element, handle };
}

/** Установка: строки, журнал перестановок и навигация с ключом `token`. */
function setup(
  rows: ShimItem[],
  token: string | null,
): { root: ShimElement; calls: Array<{ group: string; keys: string[] }>; list: DragListHandle } {
  const root = new ShimElement('div');
  const calls: Array<{ group: string; keys: string[] }> = [];
  const list = createDragList<Row>(
    root as unknown as HTMLElement,
    { token: () => token },
    {
      items: () => rows.map((row) => row.item),
      onReorder: (group, keys) => calls.push({ group, keys: [...keys] }),
    },
  );
  list.refresh();
  return { root, calls, list };
}

function keydown(root: ShimElement, key: string, altKey: boolean): { prevented: boolean } {
  // Фокус внутри списка кладёт его контекст на вершину стека диспетчера.
  root.emit('focusin', {});
  let prevented = false;
  keymap.dispatchKeyEvent({
    key,
    altKey,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as KeyboardEvent);
  root.emit('focusout', {});
  return { prevented };
}

describe('drag-list: клавиатурный сдвиг Alt+↑/↓ (d13fd645)', () => {
  it('ядро разбирает Alt+стрелки как перестановку, а обычные — как навигацию', () => {
    assert.equal(resolveNavAction('ArrowUp', { altKey: true }), 'moveUp');
    assert.equal(resolveNavAction('ArrowDown', { altKey: true }), 'moveDown');
    assert.equal(resolveNavAction('ArrowLeft', { altKey: true }), null);
    assert.equal(resolveNavAction('ArrowUp'), 'up');
    assert.equal(resolveNavAction('ArrowDown'), 'down');
  });

  it('Alt+↓ сдвигает текущую строку на соседа вниз внутри её группы', () => {
    const { root, calls } = setup([makeItem('a'), makeItem('b'), makeItem('c')], 'b');
    const { prevented } = keydown(root, 'ArrowDown', true);
    assert.equal(prevented, true);
    assert.deepEqual(calls, [{ group: 'g', keys: ['a', 'c', 'b'] }]);
  });

  it('Alt+↑ сдвигает текущую строку на соседа вверх', () => {
    const { root, calls } = setup([makeItem('a'), makeItem('b'), makeItem('c')], 'b');
    keydown(root, 'ArrowUp', true);
    assert.deepEqual(calls, [{ group: 'g', keys: ['b', 'a', 'c'] }]);
  });

  it('без Alt клавиши курсора порядок не трогают', () => {
    const { root, calls } = setup([makeItem('a'), makeItem('b')], 'b');
    keydown(root, 'ArrowDown', false);
    keydown(root, 'ArrowUp', false);
    assert.deepEqual(calls, []);
  });

  it('у края группы и без соседей сдвига нет', () => {
    const first = setup([makeItem('a'), makeItem('b')], 'a');
    keydown(first.root, 'ArrowUp', true);
    assert.deepEqual(first.calls, []);
    const lone = setup([makeItem('a', 'g1'), makeItem('b', 'g2')], 'a');
    keydown(lone.root, 'ArrowDown', true);
    assert.deepEqual(lone.calls, []);
  });
});

describe('drag-list: перетаскивание указателем (d13fd645)', () => {
  /** Pointerdown на грипе, серия pointermove и pointerup. */
  const drag = (handle: ShimElement, downY: number, moveYs: number[]): void => {
    handle.emit('pointerdown', {
      button: 0,
      clientY: downY,
      clientX: 0,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    for (const clientY of moveYs) {
      handle.emit('pointermove', { clientY, clientX: 0, pointerId: 1 });
    }
    handle.emit('pointerup', { pointerId: 1 });
  };

  it('узел переносится ниже соседа, линия вставки и активный класс снимаются на дропе', () => {
    const a = makeItem('a');
    const b = makeItem('b');
    const c = makeItem('c');
    a.element.getBoundingClientRect = () => rect(0, 20);
    b.element.getBoundingClientRect = () => rect(20, 40);
    c.element.getBoundingClientRect = () => rect(40, 60);
    const { calls } = setup([a, b, c], null);
    drag(a.handle, 5, [35]);
    assert.deepEqual(calls, [{ group: 'g', keys: ['b', 'a', 'c'] }]);
    assert.equal(b.element.classList.contains(DRAG_OVER_AFTER_CLASS), false);
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false);
  });

  it('перетаскивание выше первого соседа ставит узел в начало группы', () => {
    const a = makeItem('a');
    const b = makeItem('b');
    const c = makeItem('c');
    a.element.getBoundingClientRect = () => rect(0, 20);
    b.element.getBoundingClientRect = () => rect(20, 40);
    c.element.getBoundingClientRect = () => rect(40, 60);
    const { calls } = setup([a, b, c], null);
    drag(c.handle, 55, [22]);
    assert.deepEqual(calls, [{ group: 'g', keys: ['a', 'c', 'b'] }]);
  });

  it('до порога перетаскивание не начинается (клик не меняет порядок)', () => {
    const a = makeItem('a');
    const b = makeItem('b');
    a.element.getBoundingClientRect = () => rect(0, 20);
    b.element.getBoundingClientRect = () => rect(20, 40);
    const { calls } = setup([a, b], null);
    drag(a.handle, 5, [7]);
    assert.deepEqual(calls, []);
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false);
  });

  it('дроп через границу группы порядок не меняет', () => {
    const a = makeItem('a', 'g1');
    const b = makeItem('b', 'g2');
    a.element.getBoundingClientRect = () => rect(0, 20);
    b.element.getBoundingClientRect = () => rect(20, 40);
    const { calls } = setup([a, b], null);
    drag(a.handle, 5, [35]);
    assert.deepEqual(calls, []);
  });

  it('дроп работает, когда ключ строки и node_key разведены (реальный адаптер)', () => {
    // Ключ строки (`key`) — ключ вхождения, порядок адресуется `orderKey`
    // (`node_key`). Поиск соседей не должен смотреть `orderKey` в списке,
    // ключованном `key` (регрессия стенда d13fd645).
    const a = makeItem('k-a', 'g', 'A');
    const b = makeItem('k-b', 'g', 'B');
    const c = makeItem('k-c', 'g', 'C');
    a.element.getBoundingClientRect = () => rect(0, 20);
    b.element.getBoundingClientRect = () => rect(20, 40);
    c.element.getBoundingClientRect = () => rect(40, 60);
    const { calls } = setup([a, b, c], null);
    drag(a.handle, 5, [35]);
    assert.deepEqual(calls, [{ group: 'g', keys: ['B', 'A', 'C'] }]);
  });

  it('идентичность строки и node_key разведены (повтор вхождения)', () => {
    const first = makeItem('k1', 'g', 'n');
    const second = makeItem('k2', 'g', 'n');
    const third = makeItem('k3', 'g', 'm');
    const { root, calls } = setup([first, second, third], 'k3');
    keydown(root, 'ArrowUp', true);
    assert.deepEqual(calls, [{ group: 'g', keys: ['m', 'n'] }]);
  });
});
