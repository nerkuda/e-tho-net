/**
 * Тесты чистого переупорядочения чипов поля выбора сущностей (0.11.1, задача
 * a3cfc018): drag-перемещение чипа задаёт порядок значений (`reorderable` в
 * `lib/entity-picker.ts`, замечание проверки «порядок перетаскиванием»).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
}

async function reorder(): Promise<
  typeof import('../src/renderer/lib/entity-picker.js').reorderValues
> {
  return (await import('../src/renderer/lib/entity-picker.js')).reorderValues;
}

describe('reorderValues (entity-picker)', () => {
  it('перемещает значение перед указанной целью', async () => {
    shimDom();
    const reorderValues = await reorder();
    assert.deepEqual(reorderValues(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
    assert.deepEqual(reorderValues(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
  });

  it('null-цель (брошено за пределы) уводит значение в конец', async () => {
    shimDom();
    const reorderValues = await reorder();
    assert.deepEqual(reorderValues(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
  });

  it('неизвестное значение или цель — порядок не меняется', async () => {
    shimDom();
    const reorderValues = await reorder();
    assert.deepEqual(reorderValues(['a', 'b'], 'x', 'a'), ['a', 'b']);
    assert.deepEqual(reorderValues(['a', 'b'], 'a', 'x'), ['b', 'a']);
    assert.deepEqual(reorderValues(['a', 'b'], 'a', 'a'), ['a', 'b']);
  });
});
