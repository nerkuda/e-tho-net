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
 *
 * С 0.14.1 (задача 28d22b8a) тосты живут в общем контейнере `.notice-stack`
 * (стек не более пяти, снизу вверх), поэтому счётчики ведутся по нему, а не по
 * `document.body`; внутри стека первый ребёнок — самый новый (нижний).
 */

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ShimElement } from './dom-shim.js';

/* ------------------------------------------------------------------ *
 * DOM-шим: notice() рисует тост в стеке `document.body` и ставит TTL через
 * window
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

/** Контейнер стека тостов (создаётся лениво первым тостом). */
function stackOf(): ShimElement {
  const stack = body.children.find((child) => child.classList.contains('notice-stack'));
  assert.ok(stack !== undefined, 'контейнер .notice-stack не создан');
  return stack;
}

/** Тост-корень по индексу в стеке (0 — самый новый, он внизу). */
function toastAt(index: number): ShimElement {
  const stack = stackOf();
  const box = stack.children[index];
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

// `body` и `timers` — общие на файл; остатки прошлого теста искажали бы
// счётчики стека и число TTL, поэтому каждый тест начинает с чистого листа
// (замечание верификатора к 90ef5cfa).
beforeEach(() => {
  body.replaceChildren();
  timers.length = 0;
});

test('pointerdown на крестике закрывает тост (click может уйти мимо)', () => {
  notice('Ошибка сохранения', 'error');
  assert.equal(stackOf().childElementCount, 1, 'тост показан');

  const box = toastAt(0);
  const close = closeButtonOf(box);
  // Событие НАЖАТИЯ, а не click: именно его шлёт браузер до того, как над
  // крестиком может появиться новый тост (исходный дефект).
  close.dispatch('pointerdown', { target: close });

  assert.equal(stackOf().childElementCount, 0, 'нажатый тост закрыт');
});

// ---------------------------------------------------------------------------
// 2. Закрывается конкретный тост; счётчик стека не растёт
// ---------------------------------------------------------------------------

test('крестик закрывает свой тост из стека, остальные не задеты', () => {
  notice('первое', 'error');
  notice('второе', 'error');
  notice('третье', 'error');
  assert.equal(stackOf().childElementCount, 3, 'три тоста в стеке');
  // Стек растёт снизу вверх: первый ребёнок — самый новый.
  assert.deepEqual(stackOf().children.map(textOf), ['третье', 'второе', 'первое']);

  // Нажимаем крестик СРЕДНЕГО тоста — «второе».
  const middle = toastAt(1);
  closeButtonOf(middle).dispatch('pointerdown', { target: middle });

  assert.equal(stackOf().childElementCount, 2, 'счётчик стека уменьшился, а не вырос');
  assert.deepEqual(
    stackOf().children.map(textOf),
    ['третье', 'первое'],
    'закрыт именно нажатый тост',
  );

  // Закрываем оставшиеся — стек пуст.
  for (const box of [...stackOf().children]) {
    closeButtonOf(box).dispatch('pointerdown', { target: box });
  }
  assert.equal(stackOf().childElementCount, 0, 'все тосты закрываются своими крестиками');
});

// ---------------------------------------------------------------------------
// 3. Автозакрытие по таймеру не задето
// ---------------------------------------------------------------------------

test('тост сам снимается по таймеру 4 с', () => {
  timers.length = 0;
  notice('самоисчезающий', 'warning');
  assert.equal(stackOf().childElementCount, 1);

  assert.equal(timers.length, 1, 'TTL поставлен');
  assert.equal(timers[0]!.ms, 4000, 'задержка автозакрытия — 4 с');

  timers[0]!.callback();
  assert.equal(stackOf().childElementCount, 0, 'по таймеру тост исчез');
});
