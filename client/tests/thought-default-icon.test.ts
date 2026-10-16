/**
 * Unit-тесты дефолтной иконки мысли
 * (client/src/renderer/lib/ui/thought-default-icon.ts, задача 26006db4).
 *
 * Проверяют контракт рендера после задачи 54c82d64: форма v1 (два элемента —
 * контур-путь и кружок-хвостик) не меняется, а цвет контура задан приглушённым
 * серым токеном `--text-dim` инлайн-стилем: `var()` в presentation-атрибутах
 * SVG не работает, поэтому атрибута `stroke` у элементов нет.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  THOUGHT_DEFAULT_ICON_STROKE,
  THOUGHT_DEFAULT_ICON_VIEW_BOX,
  renderDefaultThoughtIcon,
} from '../src/renderer/lib/ui/thought-default-icon.js';
import { ShimElement } from './dom-shim.js';

(globalThis as Record<string, unknown>).HTMLElement = ShimElement;
(globalThis as Record<string, unknown>).document = {
  createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
};

/** Рендерит облачко в свежий host и отдаёт его. */
function render(): ShimElement {
  const host = new ShimElement('span');
  renderDefaultThoughtIcon(host as unknown as HTMLElement);
  return host;
}

describe('дефолтная иконка мысли — приглушённый серый контур (задача 54c82d64)', () => {
  it('токен контура — `--text-dim` (серый в обеих темах)', () => {
    assert.equal(THOUGHT_DEFAULT_ICON_STROKE, 'var(--text-dim)');
  });

  it('svg один, класс icon, форма v1 (viewBox и два элемента) сохранены', () => {
    const host = render();
    assert.equal(host.children.length, 1, 'один <svg> вместо прежнего содержимого');
    const svg = host.children[0];
    assert.ok(svg !== undefined);
    assert.equal(svg.tagName, 'svg');
    assert.ok(svg.classList.contains('icon'));
    assert.equal(svg.getAttribute('viewBox'), THOUGHT_DEFAULT_ICON_VIEW_BOX);
    assert.equal(svg.children.length, 2);
    const [cloud, tail] = svg.children;
    assert.equal(cloud?.tagName, 'path');
    assert.equal(tail?.tagName, 'circle');
  });

  it('оба элемента красятся токеном инлайн-стилем, а не атрибутом stroke', () => {
    const svg = render().children[0];
    assert.ok(svg !== undefined);
    const [cloud, tail] = svg.children;
    assert.equal(cloud?.style.stroke, 'var(--text-dim)');
    assert.equal(tail?.style.stroke, 'var(--text-dim)');
    assert.equal(cloud?.getAttribute('stroke'), null, 'presentation-атрибут stroke не используется');
    assert.equal(tail?.getAttribute('stroke'), null, 'presentation-атрибут stroke не используется');
  });

  it('геометрия и толщина штриха не изменились', () => {
    const svg = render().children[0];
    assert.ok(svg !== undefined);
    const [cloud, tail] = svg.children;
    assert.equal(cloud?.getAttribute('stroke-width'), '1');
    assert.equal(cloud?.getAttribute('stroke-linecap'), 'round');
    assert.equal(cloud?.getAttribute('stroke-linejoin'), 'round');
    assert.notEqual(cloud?.getAttribute('d'), null, 'путь контура сохранён');
    assert.equal(tail?.getAttribute('stroke-width'), '0.9');
    assert.equal(tail?.getAttribute('cx'), '3.4');
    assert.equal(tail?.getAttribute('cy'), '13.3');
    assert.equal(tail?.getAttribute('r'), '0.85');
  });
});
