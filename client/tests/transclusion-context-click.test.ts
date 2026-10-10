/**
 * Регресс-тест ошибки `27b95e60` «Правый клик по ссылке трансклюзии меняет
 * выделение» (0.12.1, ТП2). Свёрнутой ссылки после задачи `68591b8a` нет —
 * ссылка правится чипом-шапкой, — но контракт кнопок мыши сохранён: правый и
 * средний клик по БЛОКУ трансклюзии — жест контекстного меню, выделение не
 * меняется; левый клик по блоку входит во вложенный редактор (задача 73ae1d4b),
 * а не двигает выделение контейнера.
 *
 * Дополнительно: шапка-чип блока (элемент `7a479549`) на `mousedown` не двигает
 * каретку — клик открывает поповер, а не переставляет выделение.
 *
 * Проверяется контракт:
 *  - правый/средний клик по блоку не перехватывается и не меняет выделение
 *    (dispatch не вызывается);
 *  - левый клик по блоку обрабатывается (вход в блок), выделение не двигается;
 *  - клик по шапке-чипу не меняет выделение (чип обрабатывает себя сам);
 *  - правый клик по блоку открывает контекстное меню блока; вне блока — нет.
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
  TRANSCLUSION_HEAD_CLASS,
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
 * Виджет трансклюзии с заданным классом. Селектор близости задаётся явно: шим
 * не разбирает составной CSS-селектор.
 */
function widget(className: string, ref: TransclusionRef): ShimElement {
  const el = new ShimElement('div');
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

describe('кнопки мыши по блоку трансклюзии (27b95e60)', () => {
  it('правый клик не перехватывается и не меняет выделение', () => {
    const view = fakeView(SRC);
    const handled = transclusionMouseDown(mouse(2, widget(TRANSCLUSION_BLOCK_CLASS, REF)), view as any);
    assert.equal(handled, false, 'mousedown по неосновной кнопке не перехватываем');
    assert.equal(view.events.length, 0, 'правый клик не диспатчит выделение');
  });

  it('средний клик ведёт себя так же, как правый', () => {
    const view = fakeView(SRC);
    const handled = transclusionMouseDown(mouse(1, widget(TRANSCLUSION_BLOCK_CLASS, REF)), view as any);
    assert.equal(handled, false);
    assert.equal(view.events.length, 0);
  });

  it('левый клик по блоку обрабатывается как вход в блок, выделение не двигается (73ae1d4b)', () => {
    // View без фасета хранилища: вход во вложенный редактор — no-op, но клик
    // перехвачен (не двигает выделение контейнера). Полный вход с монтированием
    // вложенного редактора — в transclusion.test.ts.
    const view = fakeView(SRC);
    const handled = transclusionMouseDown(mouse(0, widget(TRANSCLUSION_BLOCK_CLASS, REF)), view as any);
    assert.equal(handled, true, 'левый клик по блоку обрабатывается трансклюзией');
    assert.equal(view.events.length, 0, 'клик не двигает выделение контейнера — вход в блок');
  });

  it('левый клик по шапке-чипу выделение не меняет (чип обрабатывает себя сам)', () => {
    const view = fakeView(SRC);
    // Цель — чип внутри шапки: closest('.transclusion-head') не пуст.
    const target = new ShimElement('button');
    target.className = 'ui-btn transclusion-chip';
    (target as any).closest = (selector: string): ShimElement | null =>
      selector.includes(TRANSCLUSION_HEAD_CLASS) ? new ShimElement('div') : null;
    const handled = transclusionMouseDown(mouse(0, target), view as any);
    assert.equal(handled, true, 'клик по чипу перехвачен трансклюзией (не доходит до выделения)');
    assert.equal(view.events.length, 0, 'каретку/выделение не двигаем — откроется поповер');
  });

  it('левый клик внутри смонтированного вложенного редактора не гасится контейнером (e2c6c66c)', () => {
    const view = fakeView(SRC);
    // Корень контейнера — свой `.cm-editor`; вложенный редактор — ДРУГОЙ корень.
    const containerRoot = new ShimElement('div');
    containerRoot.className = 'cm-editor';
    (view as any).dom = containerRoot;
    const nestedRoot = new ShimElement('div');
    nestedRoot.className = 'cm-editor';
    const nestedContent = new ShimElement('div');
    nestedContent.className = 'cm-content';
    nestedRoot.append(nestedContent);
    (nestedContent as any).closest = (selector: string): ShimElement | null =>
      selector === '.cm-editor' ? nestedRoot : null;

    const event = mouse(0, nestedContent);
    const handled = transclusionMouseDown(event, view as any);
    assert.equal(handled, true, 'жест принадлежит вложенному инстансу');
    assert.equal(
      event.defaultPrevented,
      true,
      'событие погашено, чтобы встроенный mousedown CM6 контейнера не снял фокус вложенного редактора',
    );
    assert.equal(view.events.length, 0, 'выделение контейнера не двигается');
  });

  it('клик по СВОЕМУ тексту вложенного редактора не трактует внешний блок как цель (e2c6c66c, раунд 2)', () => {
    // Вложенный инстанс: стек трансклюзий тот же, `closest` от его текста находит
    // ВНЕШНИЙ блок-виджет (предок), но это чужая цель — жест обязан уйти
    // собственному тексту вложенного CM, контейнерный preventDefault не нужен.
    const outerBlock = widget(TRANSCLUSION_BLOCK_CLASS, REF);
    const nestedRoot = new ShimElement('div');
    nestedRoot.className = 'cm-editor';
    const nestedContent = new ShimElement('div');
    nestedContent.className = 'cm-content';
    nestedRoot.append(nestedContent);
    outerBlock.append(nestedRoot); // внешний блок — предок вложенного редактора

    const view: any = fakeView('строка один\nстрока два\nстрока три');
    view.dom = nestedRoot;
    (nestedContent as any).closest = (selector: string): ShimElement | null => {
      if (selector === '.cm-editor') return nestedRoot;
      if (selector === `.${TRANSCLUSION_BLOCK_CLASS}`) return outerBlock;
      return null;
    };

    const event = mouse(0, nestedContent);
    const handled = transclusionMouseDown(event, view);
    assert.equal(handled, false, 'собственный текст вложенного редактора — жест не контейнерный');
    assert.equal(event.defaultPrevented, false, 'выделение вложенного CM не глушится');
    assert.equal(view.events.length, 0, 'внешний блок как цель не выделяется и не активируется');
  });

  it('клик по блоку ВНУТРИ самого вложенного редактора обрабатывается (e2c6c66c, раунд 2)', () => {
    // Обратный край: блок, лежащий внутри DOM вложенного инстанса, — своя цель.
    const nestedRoot = new ShimElement('div');
    nestedRoot.className = 'cm-editor';
    const innerBlock = new ShimElement('div');
    innerBlock.className = TRANSCLUSION_BLOCK_CLASS;
    innerBlock.dataset.mdFrom = String(REF.start);
    innerBlock.dataset.mdTo = String(REF.end);
    nestedRoot.append(innerBlock);

    const view: any = fakeView(SRC);
    view.dom = nestedRoot;
    (innerBlock as any).closest = (selector: string): ShimElement | null => {
      if (selector === '.cm-editor') return nestedRoot;
      if (selector === `.${TRANSCLUSION_BLOCK_CLASS}`) return innerBlock;
      return null;
    };

    const handled = transclusionMouseDown(mouse(0, innerBlock), view);
    assert.equal(handled, true, 'свой блок вложенного редактора — цель обрабатывается');
  });

  it('правый клик в тексте вложенного редактора не открывает меню внешнего блока (e2c6c66c, раунд 2)', () => {
    const outerBlock = widget(TRANSCLUSION_BLOCK_CLASS, REF);
    const nestedRoot = new ShimElement('div');
    nestedRoot.className = 'cm-editor';
    const nestedContent = new ShimElement('div');
    nestedRoot.append(nestedContent);
    outerBlock.append(nestedRoot);

    const view: any = fakeView('строка один\nстрока два');
    view.dom = nestedRoot;
    (nestedContent as any).closest = (selector: string): ShimElement | null => {
      if (selector === `.${TRANSCLUSION_BLOCK_CLASS}`) return outerBlock;
      return null;
    };

    const event = mouse(0, nestedContent);
    assert.equal(
      transclusionContextMenuHandler(event, view),
      false,
      'внешний блок меню не открывает — обрабатывает поле',
    );
  });

  it('правый клик внутри вложенного редактора: контейнер не открывает меню внешнего блока (a8b74fd6)', () => {
    // Внешний блок лежит ВНУТРИ DOM контейнера (blockInViewDom пропускает его),
    // поэтому одной этой проверки мало: контейнерный обработчик обязан
    // распознать, что цель — во ВНУТРЕННЕМ редакторе, и отдать жест меню поля.
    const containerRoot = new ShimElement('div');
    containerRoot.className = 'cm-editor';
    const outerBlock = widget(TRANSCLUSION_BLOCK_CLASS, REF);
    containerRoot.append(outerBlock);
    const nestedRoot = new ShimElement('div');
    nestedRoot.className = 'cm-editor';
    outerBlock.append(nestedRoot);
    const nestedContent = new ShimElement('div');
    nestedContent.className = 'cm-content';
    nestedRoot.append(nestedContent);

    const view: any = fakeView(SRC); // документ контейнера — ссылка на месте
    view.dom = containerRoot;
    (nestedContent as any).closest = (selector: string): ShimElement | null => {
      if (selector === '.cm-editor') return nestedRoot;
      if (selector === `.${TRANSCLUSION_BLOCK_CLASS}`) return outerBlock;
      return null;
    };

    const event = mouse(2, nestedContent);
    assert.equal(
      transclusionContextMenuHandler(event, view),
      false,
      'правый клик по тексту вложенного редактора — меню поля, не блока',
    );
    assert.equal(event.defaultPrevented, false, 'событие не гасится — доходит до меню поля');
  });

  it('правый клик на глубине ≥2: меню внешнего блока не открывается (a8b74fd6)', () => {
    const containerRoot = new ShimElement('div');
    containerRoot.className = 'cm-editor';
    const outerBlock = widget(TRANSCLUSION_BLOCK_CLASS, REF);
    containerRoot.append(outerBlock);
    const midRoot = new ShimElement('div');
    midRoot.className = 'cm-editor';
    outerBlock.append(midRoot);
    const midBlock = new ShimElement('div');
    midBlock.className = TRANSCLUSION_BLOCK_CLASS;
    midBlock.dataset.mdFrom = '0';
    midBlock.dataset.mdTo = '1';
    midRoot.append(midBlock);
    const deepRoot = new ShimElement('div');
    deepRoot.className = 'cm-editor';
    midBlock.append(deepRoot);
    const deepContent = new ShimElement('div');
    deepContent.className = 'cm-content';
    deepRoot.append(deepContent);

    const view: any = fakeView(SRC);
    view.dom = containerRoot;
    (deepContent as any).closest = (selector: string): ShimElement | null => {
      if (selector === '.cm-editor') return deepRoot;
      if (selector === `.${TRANSCLUSION_BLOCK_CLASS}`) return midBlock;
      return null;
    };

    assert.equal(
      transclusionContextMenuHandler(mouse(2, deepContent), view),
      false,
      'на любой глубине контейнер не открывает меню своего блока для чужого текста',
    );
  });
});

describe('контекстное меню блока открывается правым кликом', () => {
  it('contextmenu по блоку открывает меню блока', () => {
    const view = fakeView(SRC);
    const event = mouse(2, widget(TRANSCLUSION_BLOCK_CLASS, REF));
    const handled = transclusionContextMenuHandler(event as any, view as any);
    assert.equal(handled, true, 'правый клик по блоку перехвачен меню блока');
    assert.equal(event.defaultPrevented, true, 'родное меню поля погашено');
    const body = (globalThis as any).document.body as ShimElement;
    assert.ok(body.children.length > 0, 'меню добавлено в документ');
  });

  it('contextmenu вне блока не перехватывается', () => {
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
