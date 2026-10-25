/**
 * Крестик всплывающего сообщения закрывает КОНКРЕТНЫЙ тост (ошибка 90ef5cfa).
 *
 * Симптом заказчика: крестик не закрывает сообщение, «тень уплотняется с
 * каждым кликом». Причина: закрытие висело только на `click`, а `click`
 * браузер шлёт общему предку целей mousedown и mouseup — если над крестиком
 * успевает появиться новый тост (повторяемое уведомление), mouseup попадает в
 * него, `click` уходит мимо кнопки, и нажатый тост остаётся. Нажатие
 * (`pointerdown`) закрывает тост сразу и не зависит от того, что окажется под
 * курсором к моменту отпускания.
 *
 * Проверяются обязательства исправления:
 * 1. `pointerdown` на крестике удаляет свой тост из стека;
 * 2. закрывается именно нажатый тост, остальные остаются, счётчик узлов стека
 *    только уменьшается;
 * 3. автозакрытие по таймеру (4 с) не задето.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShimElement } from './dom-shim.js';

/* ------------------------------------------------------------------ *
 * DOM-шим: notice() рисует тост в document.body и ставит TTL через window
 * ------------------------------------------------------------------ */

const body = new ShimElement('body');
const timers: Array<{ callback: () => void; ms: number }> = [];
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).document = {
  createElement: (tag: string) => new ShimElement(tag),
  createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  documentElement: new ShimElement('html'),
  body,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  querySelector: () => null,
};
const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
win['setTimeout'] = (callback: () => void, ms: number) => {
  timers.push({ callback, ms });
  return timers.length;
};
win['clearTimeout'] = () => undefined;
win['addEventListener'] = () => undefined;
win['removeEventListener'] = () => undefined;
/* eslint-enable @typescript-eslint/no-explicit-any */

import { notice } from '../src/renderer/lib/notice.js';

/** Тост-корень по индексу в стеке `document.body`. */
function toastAt(index: number): ShimElement {
  const box = body.children[index];
  assert.ok(box !== undefined, `тост #${index} отсутствует в стеке`);
  return box;
}

/** Крестик тоста (`.notice-close` — единственная кнопка в нём). */
function closeButtonOf(box: ShimElement): ShimElement {
  const close = box.children.find((child) => child.classList.contains('notice-close'));
  assert.ok(close !== undefined, 'у тоста нет крестика .notice-close');
  return close;
}

/** Текст тоста — для проверки, ЧТО именно осталось в стеке. */
function textOf(box: ShimElement): string {
  return box.children.find((child) => child.classList.contains('notice-text'))?.textContent ?? '';
}

// ---------------------------------------------------------------------------
// 1. Нажатие на крестик закрывает тост
// ---------------------------------------------------------------------------

test('pointerdown на крестике закрывает тост (click может уйти мимо)', () => {
  notice('Ошибка сохранения', 'error');
  assert.equal(body.childElementCount, 1, 'тост показан');

  const box = toastAt(0);
  const close = closeButtonOf(box);
  // Событие НАЖАТИЯ, а не click: именно его шлёт браузер до того, как над
  // крестиком может появиться новый тост (исходный дефект).
  close.dispatch('pointerdown', { target: close });

  assert.equal(body.childElementCount, 0, 'нажатый тост закрыт');
});

// ---------------------------------------------------------------------------
// 2. Закрывается конкретный тост; счётчик стека не растёт
// ---------------------------------------------------------------------------

test('крестик закрывает свой тост из стека, остальные не задеты', () => {
  notice('первое');
  notice('второе');
  notice('третье');
  assert.equal(body.childElementCount, 3, 'три тоста в стеке');

  // Нажимаем крестик ВТОРОГО (среднего) тоста.
  const middle = toastAt(1);
  closeButtonOf(middle).dispatch('pointerdown', { target: middle });

  assert.equal(body.childElementCount, 2, 'счётчик стека уменьшился, а не вырос');
  assert.deepEqual(
    body.children.map(textOf),
    ['первое', 'третье'],
    'закрыт именно нажатый тост',
  );

  // Закрываем оставшиеся — стек пуст.
  for (const box of [...body.children]) {
    closeButtonOf(box).dispatch('pointerdown', { target: box });
  }
  assert.equal(body.childElementCount, 0, 'все тосты закрываются своими крестиками');
});

// ---------------------------------------------------------------------------
// 3. Автозакрытие по таймеру не задето
// ---------------------------------------------------------------------------

test('тост сам снимается по таймеру 4 с', () => {
  timers.length = 0;
  notice('самоисчезающий');
  assert.equal(body.childElementCount, 1);

  assert.equal(timers.length, 1, 'TTL поставлен');
  assert.equal(timers[0]!.ms, 4000, 'задержка автозакрытия — 4 с');

  timers[0]!.callback();
  assert.equal(body.childElementCount, 0, 'по таймеру тост исчез');
});
