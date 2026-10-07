/**
 * Клавиатурный контракт разделителя `lib/ui/splitter` (задача e45ca252,
 * усиление из находки A2 тех.проекта: гриф фокусируем, стрелки двигают
 * разделитель на шаг, Home/End — в край, Enter/Esc — завершение/отмена).
 *
 * Проверяем поведение без настоящего браузера — общий DOM-шим
 * (`./dom-shim.js`), конвенция `lib-ui-table.test.ts`: гриф получает
 * `tabindex`, стрелки по оси двигают метрику шагом, поперечные стрелки
 * игнорируются, Home/End прыгают в границы, Enter коммитит, Esc возвращает
 * стартовую метрику, потеря фокуса завершает сессию.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import * as keymap from '../src/renderer/lib/keymap.js';
import { ShimElement } from './dom-shim.js';

// Клавиатура грифа идёт через диспетчер контекстов: между тестами стек
// контекстов сбрасываем, иначе контекст прошлого грифа перехватит событие.
beforeEach(() => keymap.keymapInternals.reset());

function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (_text: string) => new ShimElement('#text') as any,
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

type SplitterModule = typeof import('../src/renderer/lib/ui/splitter.js');

async function load(): Promise<SplitterModule> {
  shimDom();
  return import('../src/renderer/lib/ui/splitter.js');
}

const keydown = (key: string): any => ({ key, preventDefault: () => undefined });

interface Harness {
  element: HTMLElement;
  applied: number[];
  commits: Array<{ value: number; moved: boolean }>;
  press(key: string): void;
  blur(): void;
}

/** Монтирует разделитель-заглушку и пишет вызовы apply/commit. */
function harness(mod: SplitterModule, axis: 'x' | 'y'): Harness {
  const element = new ShimElement('div') as unknown as HTMLElement;
  const applied: number[] = [];
  const commits: Array<{ value: number; moved: boolean }> = [];
  mod.wireSplitter(element, {
    ariaLabel: 'test',
    step: 8,
    plan: () => ({ axis, sign: 1, start: 300, min: 100, max: 500 }),
    apply: (value) => {
      applied.push(value);
    },
    commit: (value, _plan, moved) => {
      commits.push({ value, moved });
    },
  });
  return {
    element,
    applied,
    commits,
    press: (key) => {
      // Фокус кладёт контекст грифа на вершину стека, событие идёт через
      // единственный слушатель диспетчера (`lib/keymap.ts`).
      (element as any).focus();
      return keymap.dispatchKeyEvent(keydown(key) as KeyboardEvent);
    },
    blur: () => (element as any).emit('blur', {}),
  };
}

describe('guard: клавиатурный контракт разделителя lib/ui (e45ca252)', () => {
  it('гриф фокусируем (tabindex=0) и имеет роль разделителя', async () => {
    const mod = await load();
    const h = harness(mod, 'y');
    assert.equal(h.element.getAttribute('tabindex'), '0', 'гриф обязан быть в порядке табуляции');
    assert.equal(h.element.getAttribute('role'), 'separator');
  });

  it('стрелки по оси двигают на шаг, поперечные игнорируются', async () => {
    const mod = await load();
    const h = harness(mod, 'y');
    h.press('ArrowDown');
    h.press('ArrowDown');
    h.press('ArrowUp');
    assert.deepEqual(h.applied, [308, 316, 308], 'по оси Y: ArrowDown растёт, ArrowUp убывает');
    h.press('ArrowLeft');
    h.press('ArrowRight');
    assert.deepEqual(h.applied, [308, 316, 308], 'поперечные стрелки метрику не меняют');
  });

  it('Home/End прыгают в границы плана', async () => {
    const mod = await load();
    const h = harness(mod, 'y');
    h.press('Home');
    h.press('End');
    assert.deepEqual(h.applied, [100, 500]);
  });

  it('Enter завершает сессию и коммитит со сдвигом', async () => {
    const mod = await load();
    const h = harness(mod, 'y');
    h.press('ArrowDown');
    h.press('Enter');
    assert.deepEqual(h.commits, [{ value: 308, moved: true }]);
  });

  it('Escape возвращает стартовую метрику и не отмечает сдвиг', async () => {
    const mod = await load();
    const h = harness(mod, 'y');
    h.press('ArrowDown');
    h.applied.length = 0;
    h.press('Escape');
    assert.deepEqual(h.applied, [300], 'Esc возвращает стартовую метрику');
    assert.deepEqual(h.commits, [{ value: 300, moved: false }]);
  });

  it('Enter/Esc без активной сессии ничего не делают', async () => {
    const mod = await load();
    const h = harness(mod, 'y');
    h.press('Enter');
    h.press('Escape');
    assert.deepEqual(h.applied, []);
    assert.deepEqual(h.commits, []);
  });

  it('потеря фокуса завершает сессию коммитом сдвига', async () => {
    const mod = await load();
    const h = harness(mod, 'y');
    h.press('ArrowDown');
    h.blur();
    assert.deepEqual(h.commits, [{ value: 308, moved: true }]);
  });

  it('ось X: ArrowRight растёт, ArrowUp игнорируется', async () => {
    const mod = await load();
    const h = harness(mod, 'x');
    h.press('ArrowRight');
    h.press('ArrowUp');
    assert.deepEqual(h.applied, [308]);
  });
});
