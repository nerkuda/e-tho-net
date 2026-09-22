/**
 * Тесты общего хелпера заглушки несохранённого типа (задача e7352642):
 * `renderNewTypeHint` живёт в `client/src/renderer/lib/type-editor-hints.ts`
 * и используется обеими вкладками редактора («Свойства» и «Отборы») —
 * единая разметка и одна и та же кнопка «Сохранить» (та же команда, что
 * у «Записать» в футере диалога).
 *
 * Чистый DOM-шим через общий `tests/dom-shim.ts` — без jsdom, по принятому в
 * клиенте соглашению.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Минимальный шим document: `lib/dom.ts` хелперы используют только
 *  `createElement` (и через `dialog.ts` — `window`). */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { renderNewTypeHint } = await import(
  '../src/renderer/lib/type-editor-hints.js'
);

describe('renderNewTypeHint — заглушка несохранённого типа (e7352642)', () => {
  it('без onSave — текст подсказки есть, кнопки нет', () => {
    const hint = renderNewTypeHint({ message: 'Подсказка для теста.' });
    const text = hint.querySelector('.new-type-hint-text') as unknown as ShimElement | null;
    assert.ok(text !== null, 'нет элемента с классом new-type-hint-text');
    assert.equal(text!.textContent, 'Подсказка для теста.');
    // Кнопки быть не должно — без onSave она не рисуется.
    assert.equal(hint.querySelector('button'), null, 'кнопка не должна рисоваться без onSave');
  });

  it('с onSave — рисуется кнопка «Сохранить» класса btn success', () => {
    const hint = renderNewTypeHint({
      message: 'Подсказка.',
      onSave: () => undefined,
    });
    // `lib/dom-shim.ts` понимает только атомарные селекторы (`.class`,
    // `#id`, `tag`); составной `.btn.success` не поддержан — ищем по
    // одному классу `.btn` (он уникален внутри заглушки) и явно
    // проверяем второй класс через `classList`.
    const btn = hint.querySelector('.btn') as unknown as ShimElement;
    assert.ok(btn !== null, 'нет кнопки класса btn');
    assert.equal(btn.tagName, 'button', 'элемент с классом btn должен быть <button>');
    assert.ok(
      btn.classList.contains('success'),
      'кнопка «Сохранить» должна нести класс success',
    );
    assert.equal(btn.textContent, 'Сохранить');
    assert.equal(
      btn.title,
      'Записать тип и не закрывать диалог',
      'title кнопки должен объяснять действие',
    );
    assert.equal(btn.type, 'button', 'кнопка должна быть type=button (не submit)');
  });

  it('клик по кнопке «Сохранить» вызывает переданный onSave', () => {
    let called = 0;
    const hint = renderNewTypeHint({
      message: 'Подсказка.',
      onSave: () => {
        called += 1;
      },
    });
    const btn = hint.querySelector('.btn') as unknown as ShimElement;
    assert.ok(btn !== null);
    btn.click();
    assert.equal(called, 1, 'onSave должен быть вызван ровно один раз');
    btn.click();
    assert.equal(called, 2, 'onSave должен вызываться на каждый клик');
  });

  it('если onSave не передан — кликать по кнопке нельзя (её просто нет)', () => {
    const hint = renderNewTypeHint({ message: 'Подсказка.' });
    // Структурный инвариант: раз кнопки нет, кликать не по чему — сценарий
    // невозможен. Заглушка остаётся стабильной при изменении родительского
    // контракта.
    assert.equal(hint.querySelector('button'), null);
  });
});
