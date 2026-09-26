/**
 * Юнит-тест адаптера табличного фасада `lib/ui/table-grid.ts` (требование
 * 93115633, ошибка d1a009fa).
 *
 * Сторож контракта: двойной клик по строке адаптер собирает из СЧЁТЧИКА НАЖАТИЙ
 * (`MouseEvent.detail`), а не из нативного `dblclick`. Причина — фасад на смене
 * текущей строки перерисовывает ячейки (`setActive` → `clearCache`), узел
 * строки между двумя кликами заменяется, и нативный `dblclick` до слушателя не
 * доходит: выбор в пикере свойств не подтверждался.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`); элемент сетки
 * подставляется через `document.createElement`, как настоящий `<vaadin-grid>`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Элемент сетки с `getEventContext`, как у настоящего `<vaadin-grid>`. */
class GridElement extends ShimElement {
  getEventContext(event: any): { index?: number } | null {
    return event.gridContext ?? null;
  }
}

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) =>
      tag === 'vaadin-grid' ? new GridElement(tag) : new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

type GridModule = typeof import('../src/renderer/lib/ui/table-grid.js');

async function gridModule(): Promise<GridModule> {
  installShim();
  return import('../src/renderer/lib/ui/table-grid.js');
}

/** Клик по строке `index` со счётчиком нажатий `detail`. */
function click(index: number, detail: number): any {
  return {
    detail,
    clientX: 10,
    clientY: 20,
    gridContext: { index },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

describe('lib/ui/table-grid: двойной клик из счётчика нажатий (d1a009fa)', () => {
  it('первый клик — onRowClick, второй (detail=2) — ещё и onRowDblClick', async () => {
    const { vaadinGridAdapter } = await gridModule();
    const adapter = vaadinGridAdapter();
    const clicks: number[] = [];
    const dbls: number[] = [];
    adapter.onRowClick((index) => clicks.push(index));
    adapter.onRowDblClick((index) => dbls.push(index));

    const grid = adapter.element as unknown as ShimElement;
    grid.emit('click', click(1, 1));
    assert.deepEqual(clicks, [1], 'одиночный клик — onRowClick');
    assert.deepEqual(dbls, [], 'одиночный клик не активирует строку');

    grid.emit('click', click(1, 2));
    assert.deepEqual(clicks, [1, 1], 'второй клик тоже обновляет текущую строку');
    assert.deepEqual(dbls, [1], 'второй клик подтверждает выбор (эквивалент Enter)');
  });

  it('нативный dblclick не требуется: событие `dblclick` адаптер не слушает', async () => {
    const { vaadinGridAdapter } = await gridModule();
    const adapter = vaadinGridAdapter();
    const dbls: number[] = [];
    adapter.onRowDblClick((index) => dbls.push(index));
    // Даже если браузер прислал бы нативный dblclick — двойного срабатывания нет.
    (adapter.element as unknown as ShimElement).emit('dblclick', click(0, 2));
    assert.deepEqual(dbls, [], 'двойной клик распознаётся только из click.detail');
  });
});
