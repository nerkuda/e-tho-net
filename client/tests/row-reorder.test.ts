/**
 * Поведенческие тесты библиотечной компоненты `lib/row-reorder.ts`
 * (0.14.1, задача 223f7d50; ADR cce0ce7c, требование fdb872ee).
 *
 * DOM-события эмулируются общим шимом (`dom-shim.ts`), ректанглы строк
 * задаются вручную. Проверяются все три способа порядка (перетаскивание,
 * `Alt+↑/↓`, пункты меню), зона захвата, маркер вставки, авто-прокрутка,
 * отмена `Escape` и единый колбэк `onMove(from, to)`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import {
  createRowReorder,
  rowReorderMenuItems,
  type RowReorderHandle,
  type RowReorderRow,
} from '../src/renderer/lib/row-reorder.js';
import {
  DRAG_ACTIVE_CLASS,
  DRAG_OVER_AFTER_CLASS,
} from '../src/renderer/lib/ui/drag-list.js';
import { ShimElement, type ShimRect } from './dom-shim.js';

// Клавиатурный диспетчер между тестами пуст.
beforeEach(() => keymap.keymapInternals.reset());

const rect = (top: number, bottom: number): ShimRect => ({
  left: 0,
  top,
  right: 100,
  bottom,
  width: 100,
  height: bottom - top,
});

interface Entry {
  key: string;
  name: ShimElement;
  value: ShimElement;
}

interface Row {
  entry: Entry;
  row: RowReorderRow<Entry>;
  element: ShimElement;
  name: ShimElement;
  value: ShimElement;
}

function makeRow(key: string, top: number, bottom: number): Row {
  const element = new ShimElement('div');
  const name = new ShimElement('span', 'name');
  const value = new ShimElement('span', 'value');
  element.append(name, value);
  element.rect = rect(top, bottom);
  const entry: Entry = { key, name, value };
  return {
    entry,
    row: { entry, key, element: element as unknown as HTMLElement },
    element,
    name,
    value,
  };
}

interface Setup {
  root: ShimElement;
  moves: Array<[number, number]>;
  reorder: RowReorderHandle;
}

function setup(
  rows: Row[],
  options: {
    token?: string | null;
    captureOf?: (row: RowReorderRow<Entry>) => HTMLElement | null;
    scrollHost?: () => HTMLElement | null;
  } = {},
): Setup {
  const root = new ShimElement('div');
  const moves: Array<[number, number]> = [];
  const reorder = createRowReorder<Entry>(
    root as unknown as HTMLElement,
    {
      rows: () => rows.map((row) => row.row),
      onMove: (from, to) => {
        moves.push([from, to]);
        const [moved] = rows.splice(from, 1);
        if (moved !== undefined) rows.splice(to, 0, moved);
      },
    },
    {
      currentKey: () => options.token ?? null,
      ...(options.captureOf !== undefined ? { captureOf: options.captureOf } : {}),
      ...(options.scrollHost !== undefined ? { scrollHost: options.scrollHost } : {}),
    },
  );
  reorder.refresh();
  return { root, moves, reorder };
}

/** Pointerdown, серия pointermove и pointerup по узлу захвата. */
function drag(
  handle: ShimElement,
  downY: number,
  moveYs: number[],
  finish: 'up' | 'cancel' = 'up',
): void {
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
  if (finish === 'up') handle.emit('pointerup', { pointerId: 1 });
  else handle.emit('pointercancel', { pointerId: 1 });
}

/** Alt+↑/↓ через общеклиентский диспетчер (фокус внутри корня). */
function pressChart(root: ShimElement, key: string, altKey = false): void {
  root.emit('focusin', {});
  keymap.dispatchKeyEvent({
    key,
    altKey,
    preventDefault: () => undefined,
  } as unknown as KeyboardEvent);
  root.emit('focusout', {});
}

describe('row-reorder: единый канал перестановки', () => {
  it('Alt+↓ и Alt+↑ двигают текущую строку через ядро nav-core', () => {
    const first = makeRow('a', 0, 20);
    const second = makeRow('b', 20, 40);
    const third = makeRow('c', 40, 60);
    const { root, moves } = setup([first, second, third], { token: 'b' });

    pressChart(root, 'ArrowDown', true);
    assert.deepEqual(moves, [[1, 2]]);
    pressChart(root, 'ArrowUp', true);
    assert.deepEqual(moves, [
      [1, 2],
      [2, 1],
    ]);

    // Без Alt порядок не трогается (это навигация, не перестановка).
    pressChart(root, 'ArrowDown', false);
    assert.equal(moves.length, 2);
  });

  it('у края списка Alt-сдвиг не вызывает onMove', () => {
    const first = makeRow('a', 0, 20);
    const second = makeRow('b', 20, 40);
    const top = setup([first, second], { token: 'a' });
    pressChart(top.root, 'ArrowUp', true);
    assert.deepEqual(top.moves, []);
  });
});

describe('row-reorder: перетаскивание указателем', () => {
  it('по умолчанию захватывается вся строка; onMove получает from/to', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const c = makeRow('c', 40, 60);
    const { moves } = setup([a, b, c]);
    drag(a.element, 5, [35]);
    assert.deepEqual(moves, [[0, 1]]);
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false);
  });

  it('зона захвата сужается до имени: ячейка значения не тащит строку', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const scoped = setup([a, b], { captureOf: (row) => (row.entry as Entry).name as unknown as HTMLElement });

    drag(a.value, 5, [35]);
    assert.deepEqual(scoped.moves, [], 'значение — не зона захвата');

    drag(a.name, 5, [35]);
    assert.deepEqual(scoped.moves, [[0, 1]], 'имя — зона захвата');
  });

  it('маркер вставки появляется на соседе во время жеста и снимается на дропе', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { moves } = setup([a, b]);
    a.element.emit('pointerdown', {
      button: 0,
      clientY: 5,
      clientX: 0,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    a.element.emit('pointermove', { clientY: 35, clientX: 0, pointerId: 1 });
    assert.equal(
      b.element.classList.contains(DRAG_OVER_AFTER_CLASS),
      true,
      'маркер-линия стоит на соседе',
    );
    a.element.emit('pointerup', { pointerId: 1 });
    assert.deepEqual(moves, [[0, 1]]);
    assert.equal(b.element.classList.contains(DRAG_OVER_AFTER_CLASS), false);
  });

  it('Escape отменяет жест: строка возвращается, onMove не зовётся', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { moves } = setup([a, b]);

    a.element.emit('pointerdown', {
      button: 0,
      clientY: 5,
      clientX: 0,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    a.element.emit('pointermove', { clientY: 35, clientX: 0, pointerId: 1 });
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), true);

    // Контекст отмены взведён вместе с жестом; Escape гасит жест.
    keymap.dispatchKeyEvent({
      key: 'Escape',
      preventDefault: () => undefined,
    } as unknown as KeyboardEvent);
    a.element.emit('pointerup', { pointerId: 1 });

    assert.deepEqual(moves, [], 'порядок не изменился');
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false);
  });

  it('pointercancel тоже отменяет жест (порядок не меняется)', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { moves } = setup([a, b]);
    drag(a.element, 5, [35], 'cancel');
    assert.deepEqual(moves, []);
  });

  it('авто-прокрутка у нижнего края контейнера двигает scrollTop', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const host = new ShimElement('div');
    host.rect = rect(0, 100);
    host.scrollTop = 40;
    setup([a, b], {
      scrollHost: () => host as unknown as HTMLElement,
    });
    // Драг с порогом 4 и указателем в полосе 10px у нижнего края.
    a.element.emit('pointerdown', {
      button: 0,
      clientY: 5,
      clientX: 0,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    a.element.emit('pointermove', { clientY: 95, clientX: 0, pointerId: 1 });
    a.element.emit('pointerup', { pointerId: 1 });
    assert.ok(host.scrollTop > 40, `scrollTop вырос: ${host.scrollTop}`);
  });
});

describe('row-reorder: пункты контекстного меню', () => {
  it('на краях списка пункты disabled и без обработчика', () => {
    const calls: Array<[number, number]> = [];
    const first = rowReorderMenuItems({ index: 0, count: 3, onMove: (f, t) => calls.push([f, t]) });
    assert.equal(first[0]!.label, 'Переместить выше');
    assert.equal(first[0]!.disabled, true);
    assert.equal(first[0]!.onClick, undefined);
    assert.equal(first[1]!.disabled, false);
    first[1]!.onClick?.();
    assert.deepEqual(calls, [[0, 1]]);

    const last = rowReorderMenuItems({ index: 2, count: 3, onMove: (f, t) => calls.push([f, t]) });
    assert.equal(last[0]!.disabled, false);
    assert.equal(last[1]!.disabled, true);
    last[0]!.onClick?.();
    assert.deepEqual(calls, [
      [0, 1],
      [2, 1],
    ]);
  });

  it('подписи можно переопределить (словарь потребителя)', () => {
    const items = rowReorderMenuItems({
      index: 1,
      count: 2,
      onMove: () => undefined,
      labels: { moveUp: 'Вверх', moveDown: 'Вниз' },
    });
    assert.deepEqual(
      items.map((item) => item.label),
      ['Вверх', 'Вниз'],
    );
  });
});
