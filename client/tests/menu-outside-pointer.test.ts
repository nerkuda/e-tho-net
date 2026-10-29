/**
 * Меню закрывается по `pointerdown` вне себя (ошибка 50d57b19).
 *
 * Клик по строке свойства начинается с `pointerdown`; фасад перетаскивания
 * гасит его (`preventDefault`), и совместимый `mousedown` в Chromium после
 * этого не приходит. Обработчик «клик вне» только на `mousedown` оставлял меню
 * открытым. Здесь проверяется, что `showMenuAt` слушает и `pointerdown`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

type MenuModule = typeof import('../src/renderer/lib/menu.js');
type Listener = (event: any) => void;

let menu: MenuModule;
let body: ShimElement;
const windowListeners = new Map<string, Set<Listener>>();

function installShim(): void {
  windowListeners.clear();
  body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.addEventListener = (type: string, listener: Listener): void => {
    const set = windowListeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    windowListeners.set(type, set);
  };
  win.removeEventListener = (type: string, listener: Listener): void => {
    windowListeners.get(type)?.delete(listener);
  };
}

/** Прогоняет window-capture слушатели типа события. */
function dispatchWindow(type: string, target: ShimElement): void {
  const event = { type, target, preventDefault: () => undefined };
  for (const listener of [...(windowListeners.get(type) ?? [])]) listener(event);
}

beforeEach(async () => {
  installShim();
  menu = await import('../src/renderer/lib/menu.js');
});

describe('меню: закрытие кликом вне (50d57b19)', () => {
  it('pointerdown вне меню закрывает его (mousedown Chromium может не прислать)', () => {
    menu.showMenuAt(10, 10, [{ label: 'Открыть' }]);
    assert.equal(menu.isMenuOpen(), true, 'меню открыто');

    const outside = new ShimElement('td');
    body.append(outside);
    dispatchWindow('pointerdown', outside);
    assert.equal(menu.isMenuOpen(), false, 'pointerdown вне меню закрывает меню');
  });

  it('pointerdown по строке меню меню не закрывает', () => {
    const root = menu.showMenuAt(10, 10, [{ label: 'Открыть' }]) as unknown as ShimElement;
    assert.equal(menu.isMenuOpen(), true);
    dispatchWindow('pointerdown', root);
    assert.equal(menu.isMenuOpen(), true, 'нажатие внутри меню его не закрывает');
  });
});
