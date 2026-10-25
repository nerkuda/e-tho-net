/**
 * Реестр всплывающих слоёв, которым принадлежит `Escape` (ошибка 9ff6b606).
 *
 * Контракт `lib/keymap.ts` (ADR `b420b08c` — единственный механизм
 * контекстов/приоритетов):
 *  - открываясь, слой регистрирует обработчик `Escape` ({@link pushKeyOverlay});
 *  - `Escape` получает ВЕРХНИЙ слой (LIFO), нижние не трогаются;
 *  - диалог — такой же слой: регистрируется при показе и снимается при
 *    закрытии, поэтому порядок открытия однозначен для всех участников;
 *  - снятый слой участвовать перестаёт, повторное снятие — no-op;
 *  - `dispatchKeyEvent` отдаёт `Escape` слою ДО разрешения контекстов, поэтому
 *    закрытие панели не достаётся контексту под ней.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const keymap = await import('../src/renderer/lib/keymap.js');

/** Событие Escape: минимум полей, которые читает диспетчер. */
function escapeEvent(init: { repeat?: boolean } = {}): any {
  const event: any = {
    key: 'Escape',
    code: 'Escape',
    repeat: init.repeat === true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault(): void {
      event.defaultPrevented = true;
    },
  };
  return event;
}

beforeEach(() => keymap.keymapInternals.reset());

describe('реестр слоёв Escape (ошибка 9ff6b606)', () => {
  it('без слоёв Escape не разрешается', () => {
    const event = escapeEvent();
    assert.equal(keymap.resolveEscapeOverlay(event), false);
    assert.equal(event.defaultPrevented, false);
  });

  it('Escape получает верхний слой; после его снятия — следующий', () => {
    const calls: string[] = [];
    keymap.pushKeyOverlay({ id: 'lower', onEscape: () => { calls.push('lower'); } });
    const top = keymap.pushKeyOverlay({ id: 'upper', onEscape: () => { calls.push('upper'); } });

    assert.equal(keymap.resolveEscapeOverlay(escapeEvent()), true);
    assert.deepEqual(calls, ['upper'], 'нижний слой не получил нажатие');

    top.release();
    assert.equal(keymap.resolveEscapeOverlay(escapeEvent()), true);
    assert.deepEqual(calls, ['upper', 'lower'], 'после снятия верхнего нажатие у нижнего');
  });

  it('повторное снятие слоя безопасно и не снимает чужой', () => {
    const lower = keymap.pushKeyOverlay({ id: 'lower', onEscape: () => undefined });
    const upper = keymap.pushKeyOverlay({ id: 'upper', onEscape: () => undefined });
    upper.release();
    upper.release();
    assert.deepEqual(keymap.keymapInternals.overlayIds(), ['lower']);
    lower.release();
    assert.deepEqual(keymap.keymapInternals.overlayIds(), []);
  });

  it('снятие среднего слоя не делает верхним нижний: порядок сохраняется', () => {
    const calls: string[] = [];
    keymap.pushKeyOverlay({ id: 'lower', onEscape: () => { calls.push('lower'); } });
    const middle = keymap.pushKeyOverlay({ id: 'middle', onEscape: () => { calls.push('middle'); } });
    const upper = keymap.pushKeyOverlay({ id: 'upper', onEscape: () => { calls.push('upper'); } });

    middle.release();
    assert.deepEqual(keymap.keymapInternals.overlayIds(), ['lower', 'upper']);
    assert.equal(upper.isTop(), true, 'верхний слой остаётся верхним');
    assert.equal(keymap.resolveEscapeOverlay(escapeEvent()), true);
    assert.deepEqual(calls, ['upper'], 'средний слой снят, нижний не получил нажатие');
    upper.release();
    assert.equal(keymap.resolveEscapeOverlay(escapeEvent()), true);
    assert.deepEqual(calls, ['upper', 'lower'], 'после снятия верхнего — следующий по стеку');
  });

  it('слой, открытый раньше, никогда не выше открытого позже (строгий LIFO)', () => {
    const calls: string[] = [];
    const dialog = keymap.pushKeyOverlay({ id: 'dialog', onEscape: () => { calls.push('dialog'); } });
    const menu = keymap.pushKeyOverlay({ id: 'menu', onEscape: () => { calls.push('menu'); } });
    try {
      assert.equal(dialog.isTop(), false, 'меню открыто позже диалога — оно верхнее');
      assert.equal(menu.isTop(), true);
      keymap.resolveEscapeOverlay(escapeEvent());
      assert.deepEqual(calls, ['menu'], 'диалог под меню не получает Escape');
    } finally {
      menu.release();
      dialog.release();
    }
  });

  it('dispatchKeyEvent отдаёт Escape слою ДО контекстов', () => {
    const calls: string[] = [];
    keymap.defineKeyContext({
      id: 'under',
      bindings: [{ command: 'under.close', chord: 'Escape', run: () => { calls.push('context'); } }],
    });
    keymap.pushKeyContext('under');
    const overlay = keymap.pushKeyOverlay({ id: 'panel', onEscape: () => { calls.push('overlay'); } });
    try {
      const event = escapeEvent();
      assert.equal(keymap.dispatchKeyEvent(event), true, 'нажатие обработано');
      assert.deepEqual(calls, ['overlay'], 'контекст под слоем не получил Escape');
      assert.equal(event.defaultPrevented, true, 'диспетчер пометил нажатие обработанным');
    } finally {
      overlay.release();
    }
    const plain = escapeEvent();
    assert.equal(keymap.dispatchKeyEvent(plain), true, 'после снятия слоя — контекст');
    assert.deepEqual(calls, ['overlay', 'context']);
  });

  it('handleEscape раннего слушателя срабатывает только у верхнего слоя', () => {
    const calls: string[] = [];
    const lower = keymap.pushKeyOverlay({ id: 'lower', onEscape: () => { calls.push('lower'); } });
    const upper = keymap.pushKeyOverlay({ id: 'upper', onEscape: () => { calls.push('upper'); } });

    const notMine = escapeEvent();
    assert.equal(lower.handleEscape(notMine), false, 'нижний слой не забирает Escape');
    assert.equal(notMine.defaultPrevented, false);

    const mine = escapeEvent();
    assert.equal(upper.handleEscape(mine), true, 'верхний слой обрабатывает Escape');
    assert.deepEqual(calls, ['upper']);
    assert.equal(mine.defaultPrevented, true);

    upper.release();
    assert.equal(lower.isTop(), true, 'после снятия верхнего нижний становится верхним');
  });

  it('отказ верхнего слоя (false) оставляет нажатие необработанным', () => {
    keymap.pushKeyOverlay({ id: 'declining', onEscape: () => false });
    const event = escapeEvent();
    assert.equal(keymap.resolveEscapeOverlay(event), false);
    assert.equal(event.defaultPrevented, false);
  });

  it('автоповтор Escape диспетчер не раздаёт слоям', () => {
    let handled = 0;
    keymap.pushKeyOverlay({ id: 'menu', onEscape: () => { handled += 1; } });
    assert.equal(keymap.dispatchKeyEvent(escapeEvent({ repeat: true })), false);
    assert.equal(handled, 0);
    assert.equal(keymap.dispatchKeyEvent(escapeEvent()), true);
    assert.equal(handled, 1);
  });
});
