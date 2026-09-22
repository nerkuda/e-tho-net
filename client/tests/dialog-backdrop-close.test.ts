/**
 * Клик по подложке НЕ закрывает диалог (задача c9353ce1, отменяет правило
 * ошибки cc28ee10).
 *
 * Что закрепляем (каркас `lib/dialog.ts`):
 *   1. Клик по затемнённой подложке мимо тела диалога НЕ закрывает диалог —
 *      ни верхний, ни нижний в стеке.
 *   2. Клик по телу диалога (сам бокс и его содержимое) диалог не закрывает.
 *   3. Клик по подложке всё равно гасится (`preventDefault` + `stopPropagation`)
 *      и не проваливается на холст и панели, закрывающиеся кликом вне себя.
 *   4. Штатные пути закрытия не сломаны: Esc, × и кнопка футера закрывают.
 *   5. Опции `closeOnBackdrop` больше нет — клик мимо не путь закрытия ни у
 *      одного диалога.
 *
 * Дом — минимальный шим (конвенция `dialog-entity-dedupe.test.ts`): поведение
 * каркаса наблюдаемо только с DOM, поэтому шим, а не якоря исходника.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/** Слушатели `window` (каркас вешает туда Esc) — для проверки пути Esc. */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

/** Нажатие Esc — штатный путь каркаса (capture-слушатель `keydown`). */
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

const { closeDialog, showDialog } = await import('../src/renderer/lib/dialog.js');

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Открытые backdrop'и в DOM (порядок = порядок отрисовки). */
function backdrops(): ShimElement[] {
  return body().children.filter((child) => child.classList.contains('dialog-backdrop'));
}

/** Реальный клик по подложке: цель события — сама подложка. */
function clickBackdrop(backdrop: ShimElement): { defaultPrevented: boolean; propagated: boolean } {
  const result = { defaultPrevented: false, propagated: false };
  backdrop.emit('click', {
    target: backdrop,
    preventDefault: () => {
      result.defaultPrevented = true;
    },
    stopPropagation: () => {
      result.propagated = true;
    },
  });
  return result;
}

/** Клик по телу диалога: цель — сам бокс (содержимое), не подложка. */
function clickBox(backdrop: ShimElement): void {
  const box = backdrop.querySelector('.dialog-box');
  assert.ok(box !== null, 'в диалоге есть тело');
  backdrop.emit('click', { target: box, preventDefault: () => undefined, stopPropagation: () => undefined });
}

/** Открывает диалог и возвращает его backdrop. */
function openDialog(title: string): ShimElement {
  const dialogBody = new ShimElement('div', 'dialog-body');
  showDialog({ title, body: dialogBody as unknown as HTMLElement });
  return backdrops()[backdrops().length - 1]!;
}

describe('клик по подложке НЕ закрывает диалог (c9353ce1)', () => {
  it('клик мимо тела диалога не закрывает его', () => {
    installShim();
    const backdrop = openDialog('Диалог');
    assert.equal(backdrops().length, 1);
    clickBackdrop(backdrop);
    assert.equal(backdrops().length, 1, 'клик по подложке оставил диалог открытым');
    closeDialog();
  });

  it('клик по подложке не снимает ни верхний, ни нижний диалог стека', () => {
    installShim();
    const lower = openDialog('Нижний');
    const top = openDialog('Верхний');
    assert.equal(backdrops().length, 2);
    clickBackdrop(top);
    assert.equal(backdrops().length, 2, 'клик по подложке верхнего диалога не закрыл стек');
    clickBackdrop(lower);
    assert.equal(backdrops().length, 2, 'клик по подложке нижнего диалога тоже не закрывает');
    closeDialog();
    closeDialog();
  });

  it('клик по телу диалога не закрывает его', () => {
    installShim();
    const backdrop = openDialog('Диалог');
    clickBox(backdrop);
    assert.equal(backdrops().length, 1, 'клик по телу диалога — не отмена');
    closeDialog();
  });

  it('клик по подложке гасит событие — оно не проваливается на холст и панели', () => {
    installShim();
    const backdrop = openDialog('Диалог');
    const seen = clickBackdrop(backdrop);
    assert.equal(seen.defaultPrevented, true, 'preventDefault помечает клик потреблённым');
    assert.equal(seen.propagated, true, 'stopPropagation не пускает клик к холсту/панелям');
    closeDialog();
  });

  it('Esc по-прежнему закрывает диалог', () => {
    installShim();
    openDialog('Диалог');
    pressEscape();
    assert.equal(backdrops().length, 0, 'Esc закрывает диалог');
  });

  it('× по-прежнему закрывает диалог', () => {
    installShim();
    const backdrop = openDialog('Диалог');
    const closeBtn = backdrop.querySelector('.dialog-close');
    assert.ok(closeBtn !== null, 'в заголовке есть ×');
    closeBtn!.click();
    assert.equal(backdrops().length, 0, '× закрывает диалог');
  });

  it('кнопка футера по-прежнему закрывает диалог', () => {
    installShim();
    const dialogBody = new ShimElement('div', 'dialog-body');
    showDialog({
      title: 'Диалог',
      body: dialogBody as unknown as HTMLElement,
      buttons: [{ label: 'Закрыть', primary: true }],
    });
    const backdrop = backdrops()[backdrops().length - 1]!;
    const btn = backdrop.querySelectorAll('button').find((b) => b.textContent === 'Закрыть');
    assert.ok(btn !== undefined, 'в футере есть кнопка «Закрыть»');
    btn!.click();
    assert.equal(backdrops().length, 0, 'кнопка футера закрывает диалог');
  });

  it('клик по подложке не мешает последующему закрытию кнопкой', () => {
    installShim();
    const dialogBody = new ShimElement('div', 'dialog-body');
    showDialog({
      title: 'Диалог',
      body: dialogBody as unknown as HTMLElement,
      buttons: [{ label: 'Отмена' }],
    });
    const backdrop = backdrops()[backdrops().length - 1]!;
    clickBackdrop(backdrop);
    assert.equal(backdrops().length, 1, 'клик мимо не закрыл диалог');
    const btn = backdrop.querySelectorAll('button').find((b) => b.textContent === 'Отмена');
    assert.ok(btn !== undefined, 'в футере есть кнопка «Отмена»');
    btn!.click();
    assert.equal(backdrops().length, 0, 'кнопка закрыла оставшийся диалог');
  });
});
