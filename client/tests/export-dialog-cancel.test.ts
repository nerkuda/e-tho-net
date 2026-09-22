/**
 * Отмена в диалоге экспорта .etnx резолвит промис (ошибка e5ec74de «Диалог
 * экспорта .etnx не резолвит промис при закрытии Esc, × и кликом мимо», 0.8.2).
 *
 * Контракт `showExportEtnxDialog`: выбранные опции + путь при «Экспортировать»,
 * иначе `{ options: undefined, targetPath: undefined }`. Отмена — штатные пути
 * закрытия каркаса («Отмена», Esc, ×): завершение повешено на `onClose` (та же
 * правка, что 5c47601 / 4c7fc0f). Клик по подложке диалог НЕ закрывает и промис
 * не резолвит (задача c9353ce1) — отдельный кейс проверяет это.
 *
 * Дом — минимальный шим (конвенция `add-dialog.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/** Слушатели `window` — каркас диалога вешает сюда Esc. */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): { body: ShimElement } {
  windowListeners.length = 0;
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
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
  return { body };
}

/** Нажатие Esc — реальный путь каркаса. */
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

installShim();

const { showExportEtnxDialog, defaultExportName } = await import(
  '../src/renderer/import-export/export-dialog.js'
);

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function openBackdrop(): ShimElement {
  const backdrop = body().children.find((c) => c.className.split(/\s+/).includes('dialog-backdrop'));
  assert.ok(backdrop !== undefined, 'диалог смонтирован');
  return backdrop!;
}

/** Кнопка футера по подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop.querySelectorAll('button').find((b) => b.textContent === label);
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
  const closeBtn = backdrop.querySelector('.dialog-close');
  assert.ok(closeBtn !== null, 'в заголовке есть ×');
  closeBtn!.click();
}

async function resolvesTo<T>(
  promise: Promise<T>,
): Promise<{ value: T | undefined; settled: boolean }> {
  let value: T | undefined;
  let settled = false;
  void promise.then((v) => {
    value = v;
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { value, settled };
}

const CANCELLED = { options: undefined, targetPath: undefined };

describe('showExportEtnxDialog: отмена любым путём закрытия (e5ec74de)', () => {
  it('Esc резолвит отмену и снимает диалог', async () => {
    const { body: b } = installShim();
    const done = showExportEtnxDialog(3);
    pressEscape();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён, а не висит');
    assert.deepEqual(value, CANCELLED, 'Esc — отмена');
    assert.equal(b.children.length, 0, 'диалог закрыт');
  });

  it('× в заголовке резолвит отмену', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    clickClose(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, CANCELLED, '× — отмена');
  });

  it('клик по подложке НЕ закрывает диалог и не резолвит отмену', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    clickBackdrop(openBackdrop());
    const { settled } = await resolvesTo(done);
    assert.equal(settled, false, 'клик мимо не резолвит промис');
    assert.equal(body().children.length, 1, 'диалог остался открыт');
    footerButton(openBackdrop(), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, CANCELLED, 'после клика мимо кнопка «Отмена» всё ещё закрывает');
  });

  it('«Отмена» резолвит отмену', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    footerButton(openBackdrop(), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, CANCELLED, 'кнопка отмены');
  });

  it('«Экспортировать» отдаёт опции и путь и не переигрывается поздним onClose', async () => {
    installShim();
    const done = showExportEtnxDialog(3);
    footerButton(openBackdrop(), 'Экспортировать').click();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён');
    assert.deepEqual(value, {
      options: {
        include_types: true,
        include_attachments: true,
        include_chronology: true,
        include_subtree: false,
        subtree_depth: 1,
      },
      targetPath: defaultExportName(),
    });
  });
});
