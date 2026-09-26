/**
 * Отмена в диалоге импорта .etnx резолвит промис (ошибка fd87099b «Диалог
 * импорта .etnx не резолвит промис при закрытии Esc, × и кликом мимо», 0.8.2).
 *
 * Контракт `showImportEtnxDialog`: выбранный файл + срезы при «Импортировать»,
 * иначе `{ filePath: undefined, options: undefined }`. Отмена — штатные пути
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

const { showImportEtnxDialog } = await import('../src/renderer/import-export/import-dialog.js');

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
  const closeBtn = backdrop.querySelector('.ui-btn--ghost');
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

describe('showImportEtnxDialog: отмена любым путём закрытия (fd87099b)', () => {
  it('Esc резолвит отмену и снимает диалог', async () => {
    const { body: b } = installShim();
    const done = showImportEtnxDialog('/tmp/a.etnx');
    pressEscape();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён, а не висит');
    assert.deepEqual(value, { filePath: undefined, options: undefined }, 'Esc — отмена');
    assert.equal(b.children.length, 0, 'диалог закрыт');
  });

  it('× в заголовке резолвит отмену', async () => {
    installShim();
    const done = showImportEtnxDialog('/tmp/a.etnx');
    clickClose(openBackdrop());
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, { filePath: undefined, options: undefined }, '× — отмена');
  });

  it('клик по подложке НЕ закрывает диалог и не резолвит отмену', async () => {
    installShim();
    const done = showImportEtnxDialog('/tmp/a.etnx');
    clickBackdrop(openBackdrop());
    const { settled } = await resolvesTo(done);
    assert.equal(settled, false, 'клик мимо не резолвит промис');
    assert.equal(body().children.length, 1, 'диалог остался открыт');
    footerButton(openBackdrop(), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.deepEqual(
      value,
      { filePath: undefined, options: undefined },
      'после клика мимо кнопка «Отмена» всё ещё закрывает',
    );
  });

  it('«Отмена» резолвит отмену', async () => {
    installShim();
    const done = showImportEtnxDialog('/tmp/a.etnx');
    footerButton(openBackdrop(), 'Отмена').click();
    const { value } = await resolvesTo(done);
    assert.deepEqual(value, { filePath: undefined, options: undefined }, 'кнопка отмены');
  });

  it('«Импортировать» отдаёт файл и срезы и не переигрывается поздним onClose', async () => {
    installShim();
    const done = showImportEtnxDialog('/tmp/a.etnx', { include_chronology: false });
    footerButton(openBackdrop(), 'Импортировать').click();
    const { value, settled } = await resolvesTo(done);
    assert.equal(settled, true, 'промис завершён');
    assert.deepEqual(value, {
      filePath: '/tmp/a.etnx',
      options: { include_types: true, include_attachments: true, include_chronology: false },
    });
  });
});
