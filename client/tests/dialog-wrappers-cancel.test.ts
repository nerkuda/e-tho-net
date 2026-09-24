/**
 * Отмена в обёртках promptDialog / confirmDialog резолвит промис (ошибка
 * e0360076 «promptDialog и confirmDialog не резолвят промис при закрытии Esc
 * и ×», 0.8.2).
 *
 * Контракт обёрток `lib/dialog.ts`: `promptDialog` резолвится введённым текстом
 * либо `null` при отмене; `confirmDialog` — `true` при подтверждении либо
 * `false` при отказе. Отмена — ЛЮБОЙ штатный путь закрытия каркаса («Отмена»,
 * Esc, ×): завершение повешено на `onClose`, а не на кнопки футера (та же
 * правка, что 5c47601 для пикера). Клик по подложке диалог НЕ закрывает и
 * промис не резолвит (задача c9353ce1) — отдельный кейс проверяет это.
 *
 * Дом — минимальный шим (конвенция `dialog-entity-dedupe.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function pressEscape(): void {
  const event = {
    key: 'Escape',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  for (const { type, listener } of [...windowListeners]) {
    if (type === 'keydown') listener(event);
  }
}

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

installShim();

const { confirmDialog, promptDialog } = await import('../src/renderer/lib/dialog.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function openBackdrop(): ShimElement {
  const backdrop = body().children.find((c) => c.classList.contains('dialog-backdrop'));
  assert.ok(backdrop !== undefined, 'диалог смонтирован');
  return backdrop;
}

/** Кнопка футера по подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop
    .querySelectorAll('button')
    .find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `в футере есть кнопка «${label}»`);
  return btn!;
}

/** Клик по подложке мимо тела диалога. */
function clickBackdrop(backdrop: ShimElement): void {
  backdrop.emit('click', {
    target: backdrop,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  });
}

/** Клик по × в заголовке. */
function clickClose(backdrop: ShimElement): void {
  const closeBtn = backdrop.querySelector('.ui-btn--ghost');
  assert.ok(closeBtn !== null, 'в заголовке есть ×');
  closeBtn!.emit('click');
}

async function resolvesTo<T>(promise: Promise<T>): Promise<{ value: T | undefined; settled: boolean }> {
  let value: T | undefined;
  let settled = false;
  void promise.then((v) => {
    value = v;
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { value, settled };
}

describe('promptDialog: отмена любым путём закрытия (e0360076)', () => {
  it('Esc резолвит null', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле');
    pressEscape();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён');
    assert.equal(value, null, 'Esc — отмена');
    assert.equal(body().children.length, 0, 'диалог закрыт');
  });

  it('× резолвит null', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле');
    clickClose(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.equal(value, null, '× — отмена');
  });

  it('клик по подложке НЕ закрывает диалог и не резолвит отмену', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле');
    clickBackdrop(openBackdrop());
    const { settled } = await resolvesTo(done);
    assert.equal(settled, false, 'клик мимо не резолвит промис');
    assert.equal(body().children.length, 1, 'диалог остался открыт');
    footerButton(openBackdrop(), 'Отмена').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, null, 'после клика мимо кнопка «Отмена» всё ещё закрывает');
  });

  it('«OK» резолвит введённый текст', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле', 'старт');
    const backdrop = openBackdrop();
    const input = backdrop.querySelector('input');
    assert.ok(input !== null, 'в диалоге есть поле ввода');
    input!.value = 'итог';
    footerButton(backdrop, 'OK').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, 'итог', 'кнопка отдаёт введённый текст');
  });

  it('«Отмена» резолвит null', async () => {
    installShim();
    const done = promptDialog('Вопрос', 'Поле', 'старт');
    footerButton(openBackdrop(), 'Отмена').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, null, 'кнопка отмены — null');
  });
});

describe('confirmDialog: отмена любым путём закрытия (e0360076)', () => {
  it('Esc резолвит false', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    pressEscape();
    const { value } = await resolvesTo(done);
    assert.equal(value, false, 'Esc — отказ');
  });

  it('× резолвит false', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    clickClose(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.equal(value, false, '× — отказ');
  });

  it('клик по подложке НЕ закрывает диалог и не резолвит отказ', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    clickBackdrop(openBackdrop());
    const { settled } = await resolvesTo(done);
    assert.equal(settled, false, 'клик мимо не резолвит промис');
    assert.equal(body().children.length, 1, 'диалог остался открыт');
    footerButton(openBackdrop(), 'Отмена').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, false, 'после клика мимо кнопка «Отмена» всё ещё закрывает');
  });

  it('«Подтвердить» резолвит true', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст');
    footerButton(openBackdrop(), 'Подтвердить').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, true, 'подтверждение — true');
  });

  it('«Отмена» резолвит false', async () => {
    installShim();
    const done = confirmDialog('Вопрос', 'Текст', true);
    footerButton(openBackdrop(), 'Отмена').emit('click');
    const { value } = await resolvesTo(done);
    assert.equal(value, false, 'кнопка отмены — false');
  });
});
