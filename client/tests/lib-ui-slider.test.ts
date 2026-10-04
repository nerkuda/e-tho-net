/**
 * Юнит-тесты общего ползунка `lib/ui/slider.ts` (задача ea1b5f14, дополнение
 * пользователя «ползунок ширины текста»): границы диапазона, шаг, начальное
 * значение, кламп при `setValue`, показ текущего значения (подсказка и
 * `aria-valuetext`) и обработчики `onInput`/`onChange`.
 *
 * DOM-shimmed, как соседние lib-ui-тесты.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SLIDER_CLASS, uiSlider } from '../src/renderer/lib/ui/slider.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Устанавливает шим DOM, достаточный для импорта `lib/ui/slider.ts`. */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    body: new ShimElement('body'),
  };
}

describe('lib/ui/slider: ползунок', () => {
  installShim();

  it('строит range-контрол с границами, шагом и начальным значением', () => {
    const slider = uiSlider({ min: 50, max: 100, value: 75, ariaLabel: 'Ширина текста' });
    assert.equal(slider.root.className, SLIDER_CLASS);
    assert.equal((slider.root as any).type, 'range');
    assert.equal((slider.root as any).min, '50');
    assert.equal((slider.root as any).max, '100');
    assert.equal((slider.root as any).value, '75');
    assert.equal(slider.value(), 75);
    assert.equal((slider.root as any).attributes['aria-label'], 'Ширина текста');
  });

  it('значение вне границ клампится при построении и в setValue', () => {
    const slider = uiSlider({ min: 50, max: 100, value: 10, ariaLabel: 'x' });
    assert.equal(slider.value(), 50, 'ниже минимума — минимум');
    slider.setValue(200);
    assert.equal(slider.value(), 100, 'выше максимума — максимум');
    slider.setValue(63.6);
    assert.equal(slider.value(), 64, 'округление до целого');
  });

  it('подсказка и aria-valuetext показывают отформатированное значение', () => {
    const slider = uiSlider({
      min: 50,
      max: 100,
      value: 80,
      ariaLabel: 'x',
      formatValue: (v) => `${v}%`,
    });
    assert.equal((slider.root as any).title, '80%');
    assert.equal((slider.root as any).attributes['aria-valuetext'], '80%');
    slider.setValue(55);
    assert.equal((slider.root as any).title, '55%');
  });

  it('onInput зовётся на движении, onChange — на завершении', () => {
    const inputs: number[] = [];
    const changes: number[] = [];
    const slider = uiSlider({
      min: 50,
      max: 100,
      value: 50,
      ariaLabel: 'x',
      onInput: (v) => inputs.push(v),
      onChange: (v) => changes.push(v),
    });
    (slider.root as any).value = '70';
    (slider.root as any).fire('input');
    (slider.root as any).fire('change');
    assert.deepEqual(inputs, [70]);
    assert.deepEqual(changes, [70]);
  });
});
