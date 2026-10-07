/**
 * Цвет символа иконки в диалоге выбора и растяжение вкладки «Иконки мыслей»
 * (0.12.1, задача 4105bd6a).
 *
 * Проверяется:
 *   1. Источник «Иконки мыслей» с `fill: true` оборачивает сетку в контейнер
 *      `.icon-type-panel` (сетка тянется на всю высоту панели); без `fill`
 *      отдаёт сетку напрямую (встроенный быстрый выбор вкладки «Файл»).
 *   2. Клик по ячейке типа передаёт дальше и цвет символа типа (`icon_color`).
 *   3. Источник «Библиотека» несёт строку выбора цвета: флажок «Свой цвет
 *      символа» + поле цвета, выключенное, пока цвет не задан.
 *   4. CSS-правило растяжения присутствует (вкладка занимает всю высоту).
 *
 * jsdom в проекте нет — минимальный DOM-шим (конвенция `resource-picker.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {},
    setTimeout: (fn: () => void, ms?: number) => (globalThis as any).setTimeout(fn, ms),
    clearTimeout: (handle: any) => (globalThis as any).clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { thoughtIconSourceTab, libraryIconSourceTab } = await import(
  '../src/renderer/editor/resource-picker.js'
);

/** Контекст источника-заглушка. */
function ctx(): any {
  return { close: () => undefined, setReady: () => undefined };
}

/** Тип мысли с иконкой-эмодзи и цветом (минимум для источника). */
function typeWithIcon(iconColor: string | null): any {
  return {
    id: 't1',
    name: 'Тип',
    icon: '⭐',
    icon_kind: 'emoji',
    icon_color: iconColor,
  };
}

describe('вкладка «Иконки мыслей»: растяжение и цвет символа (4105bd6a)', () => {
  beforeEach(() => installShim());

  it('fill: true оборачивает сетку в панель на всю высоту', () => {
    const tab = thoughtIconSourceTab({ types: [typeWithIcon(null)], fill: true, onPick: () => undefined });
    const root = tab.build(ctx()) as unknown as ShimElement;
    assert.ok(root.classList.contains('icon-type-panel'), 'корень — панель растяжения');
    assert.ok(
      root.querySelector('.icon-type-grid') !== null,
      'сетка лежит внутри панели растяжения',
    );
  });

  it('без fill сетка отдаётся напрямую (встроенный выбор вкладки «Файл»)', () => {
    const tab = thoughtIconSourceTab({ types: [typeWithIcon(null)], onPick: () => undefined });
    const root = tab.build(ctx()) as unknown as ShimElement;
    assert.ok(root.classList.contains('icon-type-grid'), 'корень — сама сетка');
    assert.equal(root.querySelector('.icon-type-panel'), null, 'обёртки нет');
  });

  it('клик по ячейке типа передаёт цвет символа типа', () => {
    let picked: { icon: string; kind: string; color: string | null } | null = null;
    const tab = thoughtIconSourceTab({
      types: [typeWithIcon('#ff0000')],
      fill: true,
      onPick: (icon, kind, color) => {
        picked = { icon, kind, color };
      },
    });
    const root = tab.build(ctx()) as unknown as ShimElement;
    const cell = root.querySelector('.icon-type-cell');
    assert.ok(cell !== null, 'ячейка типа построена');
    cell!.emit('click', {});
    assert.deepEqual(picked, { icon: '⭐', kind: 'emoji', color: '#ff0000' });
  });
});

/** Все потомки с данным тегом (шим понимает не все селекторы). */
function findByTag(root: ShimElement, tag: string): ShimElement[] {
  const wanted = tag.toUpperCase();
  const hits: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    for (const child of node.children) {
      if ((child.tagName ?? '').toUpperCase() === wanted) hits.push(child);
      walk(child);
    }
  };
  walk(root);
  return hits;
}

/** Первый `<input>` с данным `type` внутри узла. */
function inputByType(root: ShimElement, type: string): ShimElement | undefined {
  return findByTag(root, 'input').find((el) => (el as any).type === type);
}

describe('вкладка «Библиотека»: поле цвета символа (4105bd6a)', () => {
  beforeEach(() => installShim());

  it('содержит флажок «Свой цвет символа» и поле цвета, выключенное без начального цвета', () => {
    const tab = libraryIconSourceTab({ initialColor: null, onPick: () => undefined });
    const root = tab.build(ctx()) as unknown as ShimElement;
    const row = root.querySelector('.icon-color-row');
    assert.ok(row !== null, 'строка цвета построена');
    const checkbox = inputByType(row!, 'checkbox');
    assert.ok(checkbox !== undefined, 'флажок своего цвета');
    assert.equal(checkbox!.checked, false, 'по умолчанию цвет не задан');
    const color = inputByType(row!, 'color');
    assert.ok(color !== undefined, 'поле выбора цвета');
    assert.equal(color!.disabled, true, 'поле цвета выключено, пока цвет не включён');
  });

  it('с начальным цветом поле цвета активно', () => {
    const tab = libraryIconSourceTab({ initialColor: '#00ff00', onPick: () => undefined });
    const root = tab.build(ctx()) as unknown as ShimElement;
    const row = root.querySelector('.icon-color-row')!;
    const checkbox = inputByType(row, 'checkbox');
    const color = inputByType(row, 'color');
    assert.equal(checkbox!.checked, true);
    assert.equal(color!.disabled, false, 'поле цвета активно при заданном цвете');
  });
});

describe('CSS: растяжение вкладки «Иконки мыслей» (4105bd6a)', () => {
  it('панель-обёртка тянет сетку на всю высоту', () => {
    const css = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'editor.css'),
      'utf8',
    );
    assert.match(css, /\.icon-type-panel\s*\{[^}]*height:\s*100%/s, 'панель занимает высоту');
    assert.match(
      css,
      /\.icon-type-panel\s*>\s*\.icon-type-grid\s*\{[^}]*max-height:\s*none/s,
      'сетка внутри панели не ограничена фиксированной высотой',
    );
  });
});
