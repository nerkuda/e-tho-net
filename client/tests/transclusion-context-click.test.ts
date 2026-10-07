/**
 * Регресс-тест ошибки `27b95e60` «Правый клик по свёрнутой ссылке трансклюзии
 * меняет выделение и разворачивает её» (0.12.1, ТП2).
 *
 * Причина: обработчик `mousedown` (`transclusionMouseDown`) не различал кнопки
 * мыши — на свёрнутой ссылке он диспатчил выделение внутрь неё при любой
 * кнопке. Смена выделения сбрасывает состояние свёрнутости (так задумано для
 * «выхода за скобки»), поэтому правый клик разворачивал ссылку и сбивал
 * выделение, хотя жест — вызов контекстного меню.
 *
 * Проверяется контракт:
 *  - правый/средний клик по свёрнутой ссылке не перехватывается и не меняет
 *    выделение (dispatch не вызывается) — состояние блока сохраняется;
 *  - левый клик по свёрнутой ссылке — прежнее поведение (каретка внутрь);
 *  - левый клик по блоку — блок неделим (dispatch не вызывается);
 *  - правый клик по ссылке открывает контекстное меню блока (обработчик
 *    `contextmenu` не тронут и работает поверх прежнего состояния).
 *
 * DOM-shimmed, как соседние lib-ui-тесты (`comment-commands.test.ts`).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { EditorState } from '@codemirror/state';

import { parseTransclusions, type TransclusionRef } from '@etn/markdown';

import { ShimElement } from './dom-shim.js';
import {
  TRANSCLUSION_BLOCK_CLASS,
  TRANSCLUSION_LINK_CLASS,
  transclusionContextMenuHandler,
  transclusionMouseDown,
} from '../src/renderer/editor/transclusion.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';

/** Устанавливает минимальный DOM/window-шим (нужен для открытия меню). */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.innerWidth = 1024;
  win.innerHeight = 768;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Фейковый `EditorView`: реальный `EditorState` + шпион `dispatch`. */
function fakeView(doc: string): {
  state: EditorState;
  dispatch: (spec: any) => void;
  posAtCoords: () => null;
  events: any[];
} {
  const events: any[] = [];
  return {
    state: EditorState.create({ doc }),
    dispatch: (spec: any) => {
      events.push(spec);
    },
    posAtCoords: () => null,
    events,
  };
}

/**
 * Виджет трансклюзии. Селектор близости задаётся явно: шим не разбирает
 * составной CSS-селектор `.a, .b`, который использует `transclusionWidgetRefAt`.
 */
function widget(className: string, ref: TransclusionRef): ShimElement {
  const el = new ShimElement('span');
  el.className = className;
  el.dataset.mdFrom = String(ref.start);
  el.dataset.mdTo = String(ref.end);
  (el as any).closest = (selector: string): ShimElement | null => {
    const wanted = selector.split(',').map((part) => part.trim().replace(/^\./, ''));
    return wanted.includes(className) ? el : null;
  };
  return el;
}

/** Событие мыши с заданной кнопкой и целью. */
function mouse(button: number, target: unknown): any {
  return {
    type: 'mousedown',
    button,
    clientX: 5,
    clientY: 6,
    target,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {},
  };
}

const SRC = `![[#${ID_A}]]`;
const REF = parseTransclusions(SRC)[0]!;

beforeEach(() => {
  installShim();
});

describe('правый клик по свёрнутой ссылке трансклюзии (27b95e60)', () => {
  it('правый клик не перехватывается и не меняет выделение', () => {
    const view = fakeView(SRC);
    const handled = transclusionMouseDown(
      mouse(2, widget(TRANSCLUSION_LINK_CLASS, REF)),
      view as any,
    );
    assert.equal(handled, false, 'mousedown по неосновной кнопке не перехватываем');
    assert.equal(
      view.events.length,
      0,
      'правый клик не диспатчит выделение — свёрнутая ссылка остаётся свёрнутой',
    );
  });

  it('средний клик ведёт себя так же, как правый', () => {
    const view = fakeView(SRC);
    const handled = transclusionMouseDown(
      mouse(1, widget(TRANSCLUSION_LINK_CLASS, REF)),
      view as any,
    );
    assert.equal(handled, false);
    assert.equal(view.events.length, 0);
  });

  it('левый клик по свёрнутой ссылке — прежнее поведение (каретка внутрь)', () => {
    const view = fakeView(SRC);
    const handled = transclusionMouseDown(
      mouse(0, widget(TRANSCLUSION_LINK_CLASS, REF)),
      view as any,
    );
    assert.equal(handled, true, 'левый клик обрабатывается трансклюзией');
    assert.equal(view.events.length, 1);
    assert.deepEqual(view.events[0]!.selection, { anchor: REF.start + 1 });
  });

  it('левый клик по блоку оставляет блок неделимым', () => {
    const view = fakeView(SRC);
    const handled = transclusionMouseDown(
      mouse(0, widget(TRANSCLUSION_BLOCK_CLASS, REF)),
      view as any,
    );
    assert.equal(handled, true);
    assert.equal(view.events.length, 0, 'клик по блоку не ставит каретку внутрь');
  });
});

describe('контекстное меню ссылки открывается правым кликом (27b95e60)', () => {
  it('contextmenu по свёрнутой ссылке открывает меню блока', () => {
    const view = fakeView(SRC);
    const event = mouse(2, widget(TRANSCLUSION_LINK_CLASS, REF));
    const handled = transclusionContextMenuHandler(event as any, view as any);
    assert.equal(handled, true, 'правый клик по ссылке перехвачен меню блока');
    assert.equal(event.defaultPrevented, true, 'родное меню поля погашено');
    const body = (globalThis as any).document.body as ShimElement;
    assert.ok(body.children.length > 0, 'меню добавлено в документ');
  });

  it('contextmenu вне виджета трансклюзии не перехватывается', () => {
    const view = fakeView(SRC);
    const event = mouse(2, null);
    const handled = transclusionContextMenuHandler(event as any, view as any);
    assert.equal(handled, false);
    const body = (globalThis as any).document.body as ShimElement;
    assert.equal(body.children.length, 0, 'меню не открывается');
  });
});

/**
 * Меню блока защищено общей `guardMenuFocus` (ошибка `1b847110`): клик по
 * строке не забирает фокус, поэтому поле не уходит из правки в просмотр
 * (`focusout` → `onBlur` → `showView`), а команда применяется к блоку.
 */
describe('меню блока защищено от потери фокуса (1b847110)', () => {
  it('mousedown по строке открытого меню гасится (guardMenuFocus применён)', () => {
    const view = fakeView(SRC);
    const openEvent = mouse(2, widget(TRANSCLUSION_BLOCK_CLASS, REF));
    transclusionContextMenuHandler(openEvent as any, view as any);
    const body = (globalThis as any).document.body as ShimElement;
    const menuRoot = body.children[body.children.length - 1]!;
    assert.ok(menuRoot !== undefined, 'меню добавлено в документ');

    const row = menuRoot.querySelector('.menu-item');
    assert.ok(row !== null, 'в меню есть хотя бы одна строка-команда');

    const down: any = {
      type: 'mousedown',
      button: 0,
      target: row,
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
      stopPropagation(): void {},
    };
    menuRoot.emit('mousedown', down);
    assert.equal(
      down.defaultPrevented,
      true,
      'клик по строке меню блока не должен забирать фокус (иначе поле уходит в просмотр)',
    );
  });
});
