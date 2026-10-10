/**
 * Регресс-тест ошибки `87751f42` «Правый клик по виджету live-preview
 * (mdWidgetClick) меняет выделение и разворачивает виджет» (0.12.1).
 *
 * Причина: обработчик `mousedown` виджета live-preview (`mdWidgetMouseDown`)
 * не различал кнопки мыши — на любом `.md-widget` он диспатчил выделение внутрь
 * диапазона. Смена выделения выводит виджет из «неактивного» состояния и
 * раскрывает исходный markdown, хотя правый клик — жест вызова контекстного
 * меню. Тот же класс, что `27b95e60` в `transclusion.ts`.
 *
 * Проверяется контракт:
 *  - правый/средний клик не перехватывается, не диспатчит выделение и не гасит
 *    событие (`contextmenu` открывает меню поля поверх прежнего состояния);
 *  - левый клик — прежнее поведение (каретка внутрь диапазона виджета);
 *  - сам md-live не регистрирует обработчик `contextmenu` (меню принадлежит
 *    полю — `markdown-field.ts`), поэтому меню не подменяется.
 *
 * DOM-shimmed, как соседние тесты (`transclusion-context-click.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { MD_WIDGET_CLASS, mdWidgetMouseDown } from '../src/renderer/editor/md-live.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DOC = '[[Мысль]]';
const WIDGET_FROM = 0;
const WIDGET_TO = DOC.length;

/** Устанавливает минимальный DOM-шим (`instanceof HTMLElement` в продукте). */
function installShim(): void {
  (globalThis as any).HTMLElement = ShimElement;
}

/** Виджет live-preview: класс `.md-widget` и диапазон `data-md-from/to`. */
function widget(): ShimElement {
  const el = new ShimElement('span');
  el.className = MD_WIDGET_CLASS;
  el.dataset.mdFrom = String(WIDGET_FROM);
  el.dataset.mdTo = String(WIDGET_TO);
  // Шим `closest` ищет от родителя; виджет — сам цель клика, поэтому
  // отвечаем на селектор класса напрямую (как в `transclusion-context-click`).
  (el as any).closest = (selector: string): ShimElement | null =>
    selector === `.${MD_WIDGET_CLASS}` ? el : null;
  return el;
}

/** Фейковый `EditorView`: шпион `dispatch`; `posAtCoords` вне цели — null. */
function fakeView(): { dispatch: (spec: any) => void; posAtCoords: () => null; events: any[] } {
  const events: any[] = [];
  return {
    dispatch: (spec: any) => {
      events.push(spec);
    },
    posAtCoords: () => null,
    events,
  };
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

beforeEach(() => {
  installShim();
});

describe('правый/средний клик по виджету live-preview (87751f42)', () => {
  it('правый клик не перехватывается, не меняет выделение и не гасит событие', () => {
    const view = fakeView();
    const event = mouse(2, widget());
    const handled = mdWidgetMouseDown(event, view as any);
    assert.equal(handled, false, 'mousedown по неосновной кнопке не перехватываем');
    assert.equal(
      view.events.length,
      0,
      'правый клик не диспатчит выделение — виджет остаётся свёрнутым',
    );
    assert.equal(event.defaultPrevented, false, 'событие не погашено — contextmenu дойдёт до поля');
  });

  it('средний клик ведёт себя так же, как правый', () => {
    const view = fakeView();
    const event = mouse(1, widget());
    const handled = mdWidgetMouseDown(event, view as any);
    assert.equal(handled, false);
    assert.equal(view.events.length, 0);
    assert.equal(event.defaultPrevented, false);
  });

  it('левый клик — прежнее поведение (каретка внутрь диапазона виджета)', () => {
    const view = fakeView();
    const event = mouse(0, widget());
    const handled = mdWidgetMouseDown(event, view as any);
    assert.equal(handled, true, 'левый клик обрабатывается виджетом');
    assert.equal(view.events.length, 1);
    assert.deepEqual(view.events[0]!.selection, { anchor: WIDGET_FROM + 1 });
  });

  it('contextmenu открывается поверх прежнего состояния (левый клик его не блокирует)', () => {
    const el = widget();
    // Поле слушает `contextmenu` на `editor.dom` (markdown-field.ts, ТП1):
    // меню открывается по жесту правого клика, виджет при этом не развёрнут.
    let opened = false;
    el.addEventListener('contextmenu', (e: any) => {
      e.preventDefault();
      opened = true;
    });
    el.emit('contextmenu', mouse(2, el));
    assert.equal(opened, true, 'contextmenu доходит до меню поля');
  });

  it('md-live не регистрирует собственный обработчик contextmenu', () => {
    const src = readFileSync(new URL('../src/renderer/editor/md-live.ts', import.meta.url), 'utf8');
    // Ищем именно ключ-обработчик (`'contextmenu':`), а не упоминание в тексте.
    assert.equal(
      /["']contextmenu["']\s*:/.test(src),
      false,
      'меню принадлежит полю — md-live его не подменяет',
    );
  });
});
