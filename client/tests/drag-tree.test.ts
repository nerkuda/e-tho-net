/**
 * Поведенческие тесты кросс-группового drag-фасада `lib/ui/drag-tree.ts`
 * (задача 31b228f0, этап 1; ADR 442e7ff5/e538090f).
 *
 * DOM-события эмулируются общим шимом (`dom-shim.ts`), ректанглы строк задаются
 * вручную. Проверяется только канал жеста: порог, цель/индекс, Shift, Escape,
 * очистка на pointerup/pointercancel/потере захвата. Ключи и пути — данные
 * вызывающего; их разбор — вне фасада.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import {
  createDragTree,
  DRAG_TREE_OVER_EMPTY_CLASS,
  resolveDragTreeRowTarget,
  type DragTreeAdapter,
  type DragTreeDropEvent,
  type DragTreeItem,
  type DragTreeResolveRequest,
  type DragTreeRow,
  type DragTreeTarget,
} from '../src/renderer/lib/ui/drag-tree.js';
import { DRAG_ACTIVE_CLASS, DRAG_OVER_BEFORE_CLASS } from '../src/renderer/lib/ui/drag-list.js';
import { ShimElement, type ShimRect } from './dom-shim.js';

beforeEach(() => keymap.keymapInternals.reset());

const rect = (top: number, bottom: number): ShimRect => ({
  left: 0,
  top,
  right: 100,
  bottom,
  width: 100,
  height: bottom - top,
});

/** Узел-строка вместе с шим-элементом и ручкой. */
interface Row {
  item: DragTreeItem;
  element: ShimElement;
  handle: ShimElement;
}

function makeRow(key: string, top: number, bottom: number, explicitHandle = true): Row {
  const element = new ShimElement('div');
  element.setAttribute('data-key', key);
  const handle = new ShimElement('span', 'grip');
  element.append(handle);
  element.rect = rect(top, bottom);
  const item: DragTreeItem = {
    key,
    element: element as unknown as HTMLElement,
    ...(explicitHandle ? { handle: handle as unknown as HTMLElement } : {}),
  };
  return { item, element, handle };
}

/** Установка фасада: строки, цель, журналы дропа/отмены. */
function setup(
  rows: Row[],
  options: {
    handleSelector?: string;
    emptyElement?: ShimElement;
    resolveTarget?: (request: DragTreeResolveRequest) => DragTreeTarget | null;
  } = {},
) {
  const root = new ShimElement('div');
  const drops: DragTreeDropEvent[] = [];
  const cancels: DragTreeItem[] = [];
  const groupBody: HTMLElement = (options.emptyElement ??
    new ShimElement('div')) as unknown as HTMLElement;
  const adapter: DragTreeAdapter = {
    items: () => rows.map((row) => row.item),
    resolveTarget:
      options.resolveTarget ??
      (({ clientY }: DragTreeResolveRequest): DragTreeTarget => {
        const target = resolveDragTreeRowTarget(
          rows.map((row): DragTreeRow => ({ key: row.item.key, element: row.item.element })),
          clientY,
        );
        return {
          groupId: 'g',
          index: target.index,
          position: target.position,
          element: target.row?.element ?? groupBody,
        };
      }),
    onDrop: (event) => drops.push(event),
    onCancel: (source) => cancels.push(source),
  };
  const tree = createDragTree(root as unknown as HTMLElement, adapter, {
    handleSelector: options.handleSelector ?? '.grip',
  });
  tree.refresh();
  return { root, tree, drops, cancels, groupBody };
}

/** pointerdown → серия pointermove → pointerup. */
function drag(
  handle: ShimElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: { shiftKey?: boolean } = {},
): void {
  handle.emit('pointerdown', {
    button: 0,
    clientX: from.x,
    clientY: from.y,
    pointerId: 1,
    preventDefault: () => undefined,
  });
  handle.emit('pointermove', {
    clientX: to.x,
    clientY: to.y,
    pointerId: 1,
    ...modifiers,
  });
  handle.emit('pointerup', { clientX: to.x, clientY: to.y, pointerId: 1, ...modifiers });
}

describe('drag-tree: расчёт позиции вставки (31b228f0)', () => {
  it('выше середины — before, ниже — after/следующий индекс, пусто — empty', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const rows: DragTreeRow[] = [
      { key: 'a', element: a.element as unknown as HTMLElement },
      { key: 'b', element: b.element as unknown as HTMLElement },
    ];
    assert.deepEqual(
      { index: resolveDragTreeRowTarget(rows, 5).index, position: resolveDragTreeRowTarget(rows, 5).position },
      { index: 0, position: 'before' },
    );
    assert.deepEqual(
      { index: resolveDragTreeRowTarget(rows, 25).index, position: resolveDragTreeRowTarget(rows, 25).position },
      { index: 1, position: 'before' },
    );
    assert.deepEqual(
      { index: resolveDragTreeRowTarget(rows, 35).index, position: resolveDragTreeRowTarget(rows, 35).position },
      { index: 2, position: 'after' },
    );
    assert.deepEqual(resolveDragTreeRowTarget([], 100), { index: 0, position: 'empty', row: null });
  });
});

describe('drag-tree: канал жеста (31b228f0)', () => {
  it('до порога 4px перетаскивание не начинается и дропа нет', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { drops } = setup([a, b]);
    drag(a.handle, { x: 10, y: 5 }, { x: 10, y: 7 });
    assert.deepEqual(drops, []);
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false);
    assert.equal(b.element.classList.contains(DRAG_OVER_BEFORE_CLASS), false);
  });

  it('дроп отдаёт целевой ключ, индекс позиции вставки и модификаторы', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const c = makeRow('c', 40, 60);
    const { drops } = setup([a, b, c]);
    drag(a.handle, { x: 10, y: 5 }, { x: 10, y: 55 }, { shiftKey: true });
    assert.equal(drops.length, 1);
    const drop = drops[0]!;
    assert.equal(drop.source.key, 'a');
    assert.equal(drop.target.groupId, 'g');
    assert.equal(drop.target.index, 3, 'ниже последней строки — вставка в конец');
    assert.equal(drop.target.position, 'after');
    assert.equal(drop.modifiers.shift, true, 'Shift — признак копирования');
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false, 'активный класс снят');
    assert.equal(c.element.classList.contains(DRAG_OVER_BEFORE_CLASS), false, 'линия вставки снята');
  });

  it('бросок в пустую группу даёт empty/индекс 0 и подсвечивает её', () => {
    const root = new ShimElement('div');
    const source = makeRow('s', 0, 20);
    const groupBody = new ShimElement('div');
    const drops: DragTreeDropEvent[] = [];
    // Цель — пустая группа: адаптер не зависит от строк и сам отдаёт empty.
    const tree = createDragTree(
      root as unknown as HTMLElement,
      {
        items: () => [source.item],
        resolveTarget: () => ({ groupId: 'g', index: 0, position: 'empty', element: groupBody as unknown as HTMLElement }),
        onDrop: (event) => drops.push(event),
      },
      { handleSelector: '.grip' },
    );
    tree.refresh();
    source.handle.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    source.handle.emit('pointermove', { clientX: 10, clientY: 50, pointerId: 1 });
    assert.equal(groupBody.classList.contains(DRAG_TREE_OVER_EMPTY_CLASS), true, 'пустая группа подсвечена');
    source.handle.emit('pointerup', { clientX: 10, clientY: 50, pointerId: 1 });
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.target.position, 'empty');
    assert.equal(drops[0]!.target.index, 0);
    assert.equal(groupBody.classList.contains(DRAG_TREE_OVER_EMPTY_CLASS), false, 'подсветка снята');
  });

  it('Escape отменяет жест: onCancel есть, дропа нет, узел не тащится', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { drops, cancels } = setup([a, b]);
    a.handle.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    a.handle.emit('pointermove', { clientX: 10, clientY: 35, pointerId: 1 });
    keymap.dispatchKeyEvent({ key: 'Escape', preventDefault: () => undefined } as unknown as KeyboardEvent);
    a.handle.emit('pointerup', { clientX: 10, clientY: 35, pointerId: 1 });
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0]!.key, 'a');
    assert.deepEqual(drops, [], 'после Escape бросок не выполняется');
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false);
  });

  it('pointercancel и потеря захвата отменяют жест и чистят состояние', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const first = setup([a, b]);
    a.handle.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    a.handle.emit('pointermove', { clientX: 10, clientY: 35, pointerId: 1 });
    a.handle.emit('pointercancel', { pointerId: 1 });
    assert.equal(first.cancels.length, 1);
    assert.deepEqual(first.drops, []);
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false);

    const c = makeRow('c', 0, 20);
    const second = setup([c]);
    c.handle.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    c.handle.emit('pointermove', { clientX: 10, clientY: 35, pointerId: 1 });
    c.handle.emit('lostpointercapture', { pointerId: 1 });
    assert.equal(second.cancels.length, 1);
    assert.deepEqual(second.drops, []);
  });

  it('ручка находится по селектору, если адаптер не передал её явно', () => {
    const a = makeRow('a', 0, 20, false);
    const b = makeRow('b', 20, 40, false);
    const { drops } = setup([a, b]);
    drag(a.handle, { x: 10, y: 5 }, { x: 10, y: 35 });
    assert.equal(drops.length, 1);
  });

  it('destroy снимает pointerdown-слушатели', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { tree, drops } = setup([a, b]);
    tree.destroy();
    drag(a.handle, { x: 10, y: 5 }, { x: 10, y: 35 });
    assert.deepEqual(drops, []);
  });

  it('делегированный pointerdown на корне находит ручку и запускает жест', () => {
    // Шим не всплывает: событие приходит на корень с `target` = ручка, как
    // реальное всплытие. Per-handle путь при этом молчит — проверяем страховку.
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { root, drops } = setup([a, b]);
    root.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      target: a.handle,
      preventDefault: () => undefined,
    });
    a.handle.emit('pointermove', { clientX: 10, clientY: 35, pointerId: 1 });
    a.handle.emit('pointerup', { clientX: 10, clientY: 35, pointerId: 1 });
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.source.key, 'a');
  });

  it('жест переживает замену ручки: move/up приходят на корень', () => {
    // Перерисовка дерева заменяет `.ft-item` и его ручку; слушатели жеста на
    // корне продолжают вести начатый жест (иначе active «зависал» бы без up).
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { root, drops } = setup([a, b]);
    root.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      target: a.handle,
      preventDefault: () => undefined,
    });
    root.emit('pointermove', { clientX: 10, clientY: 35, pointerId: 1 });
    root.emit('pointerup', { clientX: 10, clientY: 35, pointerId: 1 });
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.source.key, 'a');
  });

  it('destroy снимает объявление клавиатурного контекста: циклы не накапливают записи', () => {
    const contextsOfTree = () =>
      keymap.keymapInternals
        .contextIds()
        .filter((id) => id.startsWith('ui-drag-tree-'));
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const row = makeRow(`a${cycle}`, 0, 20);
      const { tree } = setup([row]);
      assert.equal(contextsOfTree().length, 1, `цикл ${cycle}: контекст объявлен при создании`);
      tree.destroy();
      assert.deepEqual(contextsOfTree(), [], `цикл ${cycle}: destroy снял объявление`);
    }
  });

  it('цель броска пересчитывается по точке pointerup, а не по последнему pointermove', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const c = makeRow('c', 40, 60);
    const { drops } = setup([a, b, c]);
    a.handle.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    // move — выше середины b (перед b, index 1), up — ниже c (в конец, index 3).
    a.handle.emit('pointermove', { clientX: 10, clientY: 25, pointerId: 1 });
    a.handle.emit('pointerup', { clientX: 10, clientY: 55, pointerId: 1 });
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.target.index, 3, 'индекс — по точке отпускания');
    assert.equal(drops[0]!.target.position, 'after');
  });

  it('pointerup вне зоны броска отменяет жест: onCancel без onDrop', () => {
    const a = makeRow('a', 0, 20);
    const b = makeRow('b', 20, 40);
    const { drops, cancels } = setup([a, b], {
      resolveTarget: ({ clientY }) =>
        clientY > 40
          ? null
          : { groupId: 'g', index: 0, position: 'before', element: a.element as unknown as HTMLElement },
    });
    a.handle.emit('pointerdown', {
      button: 0,
      clientX: 10,
      clientY: 5,
      pointerId: 1,
      preventDefault: () => undefined,
    });
    a.handle.emit('pointermove', { clientX: 10, clientY: 25, pointerId: 1 });
    a.handle.emit('pointerup', { clientX: 10, clientY: 55, pointerId: 1 });
    assert.deepEqual(drops, [], 'дропа нет — цель на pointerup не резолвится');
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0]!.key, 'a');
    assert.equal(a.element.classList.contains(DRAG_ACTIVE_CLASS), false, 'состояние жеста очищено');
  });
});
