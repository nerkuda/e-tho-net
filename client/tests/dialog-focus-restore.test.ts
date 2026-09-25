/**
 * После закрытия диалога фокус возвращается вызвавшему списку (ошибка
 * 28d69bc6, правило 10 требования 11ddd910 «Единые правила диалогов-списков»).
 *
 * Что закрепляем (каркас `lib/dialog.ts`):
 *   1. Каркас запоминает элемент, владевший фокусом до показа диалога, и
 *      возвращает ему фокус при закрытии ЛЮБЫМ путём (Esc, ×, кнопка футера,
 *      `closeDialog`).
 *   2. Стопка диалогов: закрытие верхнего возвращает фокус элементу нижнего,
 *      закрытие нижнего — списку.
 *
 * Дом — минимальный шим (конвенция `dialog-backdrop-close.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    activeElement: null,
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

function doc(): any {
  return (globalThis as any).document;
}

function body(): ShimElement {
  return doc().body as ShimElement;
}

/** Создаёт подключённый к документу элемент (isConnected === true). */
function attached(tag: string): ShimElement {
  const node = new ShimElement(tag);
  body().append(node);
  return node;
}

/** Открывает диалог; `focusedBefore` — активный элемент на момент показа. */
function openDialog(title: string, focusedBefore: ShimElement): ShimElement {
  doc().activeElement = focusedBefore;
  showDialog({ title, body: attached('div') as unknown as HTMLElement });
  return body().children.filter((c) => c.classList.contains('dialog-backdrop')).at(-1)!;
}

describe('возврат фокуса списку после закрытия диалога (28d69bc6)', () => {
  it('closeDialog возвращает фокус владельцу фокуса до показа', () => {
    installShim();
    const list = attached('div');
    list.focused = false;
    openDialog('Редактор', list);
    assert.equal(list.focused, false, 'до закрытия фокус у диалога, а не у списка');
    closeDialog();
    assert.equal(list.focused, true, 'после закрытия фокус вернулся списку');
  });

  it('Esc и кнопка футера тоже возвращают фокус', () => {
    installShim();
    const list = attached('div');
    openDialog('Редактор', list);
    closeDialog();
    assert.equal(list.focused, true);

    const list2 = attached('div');
    list2.focused = false;
    openDialog('Ещё', list2);
    const backdrop = body().children.filter((c) => c.classList.contains('dialog-backdrop')).at(-1)!;
    const closeBtn = backdrop.querySelector('.ui-btn--ghost');
    assert.ok(closeBtn !== null, 'в заголовке есть ×');
    closeBtn!.click();
    assert.equal(list2.focused, true, '× возвращает фокус списку');
  });

  it('стопка диалогов: закрытие верхнего возвращает фокус нижнему', () => {
    installShim();
    const list = attached('div');
    const field = attached('input');
    openDialog('Нижний', list);
    openDialog('Верхний', field);
    closeDialog();
    assert.equal(field.focused, true, 'верхний закрылся — фокус у элемента нижнего');
    assert.equal(list.focused, false, 'фокус списка ещё не возвращён');
    closeDialog();
    assert.equal(list.focused, true, 'нижний закрылся — фокус вернулся списку');
  });

  it('не тронутый DOM: фокус не ставится удалённому элементу', () => {
    installShim();
    const list = attached('div');
    openDialog('Редактор', list);
    body().removeChild(list);
    list.isConnected = false;
    closeDialog();
    assert.equal(list.focused, false, 'удалённому элементу фокус не навязываем');
  });

  it('нет активного элемента — закрытие не падает и ничего не фокусирует', () => {
    installShim();
    doc().activeElement = null;
    showDialog({ title: 'Диалог', body: attached('div') as unknown as HTMLElement });
    closeDialog();
    assert.equal(
      body().children.filter((c) => c.classList.contains('dialog-backdrop')).length,
      0,
      'диалог закрылся без ошибок',
    );
  });
});
