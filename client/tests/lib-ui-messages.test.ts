/**
 * Словарь строк ошибок `lib/ui/messages.ts` и переход по клику на строку
 * панели кнопок (задача e20761c2, требование 397c5a56).
 *
 * Проверяется: единый вид строк (классы), префикс «Ошибка:» в одном месте,
 * кликабельность строки только при адресе и подключённом переходе, и главная
 * поведенческая гарантия правила — клик по строке ошибки в футере диалога
 * переключает вкладку и ставит фокус в проблемное поле.
 *
 * jsdom в проекте нет — используется общий DOM-шим (`./dom-shim.js`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/** Минимальный DOM-шим (хватает пути showDialog). */
function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

describe('lib/ui/messages: единый вид строк ошибок', () => {
  it('errorLine/errorParagraph/fieldError несут общий класс словаря', async () => {
    shimDom();
    const m = await import('../src/renderer/lib/ui/messages.js');
    assert.ok(m.errorLine('x').classList.contains('error-text'), 'errorLine — класс словаря');
    assert.ok(m.errorParagraph('x').classList.contains('error-text'), 'errorParagraph — класс словаря');
    assert.ok(m.fieldError('x').classList.contains('field-error'), 'fieldError помечен как поле');
    assert.equal(m.errorLine('текст').textContent, 'текст');
  });

  it('префикс «Ошибка:» объявлен один раз — в operationErrorText', async () => {
    shimDom();
    const m = await import('../src/renderer/lib/ui/messages.js');
    assert.equal(m.operationErrorText(new Error('сбой записи')), 'Ошибка: сбой записи');
    assert.equal(
      m.operationErrorText(new Error('сбой'), 'Не удалось загрузить'),
      'Не удалось загрузить: сбой',
    );
    assert.ok(m.operationError(new Error('сбой')).classList.contains('error-text'));
  });
});

describe('footerErrorLine: адрес ошибки и кликабельность', () => {
  it('кликабельна только с адресом и подключённым переходом', async () => {
    shimDom();
    const m = await import('../src/renderer/lib/ui/messages.js');
    const line = m.footerErrorLine();
    assert.equal(line.textContent, '');
    assert.equal(line.classList.contains('error-text--link'), false);

    const seen: unknown[] = [];
    line.setNavigate((address) => seen.push(address));
    // Без адреса — не кликабельна.
    line.show('Просто сообщение');
    assert.equal(line.classList.contains('error-text--link'), false);
    line.click();
    assert.deepEqual(seen, [], 'строка без адреса не ведёт никуда');

    // С адресом — кликабельна и передаёт адрес переходу.
    const address = { tab: 'description' };
    line.show('Укажите имя', address);
    assert.equal(line.textContent, 'Укажите имя');
    assert.equal(line.classList.contains('error-text--link'), true);
    line.click();
    assert.deepEqual(seen, [address]);

    // clear() снимает и текст, и кликабельность.
    line.clear();
    assert.equal(line.textContent, '');
    assert.equal(line.classList.contains('error-text--link'), false);
    line.click();
    assert.equal(seen.length, 1);
  });

  it('без подключённого перехода строка с адресом не кликабельна', async () => {
    shimDom();
    const m = await import('../src/renderer/lib/ui/messages.js');
    const line = m.footerErrorLine();
    line.show('Укажите имя', { tab: 'description' });
    assert.equal(line.classList.contains('error-text--link'), false);
    line.click(); // не должно бросать
  });
});

describe('каркас диалога: клик по строке ошибки ведёт на вкладку и к полю', () => {
  it('переключает вкладку и ставит фокус в проблемное поле', async () => {
    shimDom();
    const { showDialog } = await import('../src/renderer/lib/dialog.js');
    const m = await import('../src/renderer/lib/ui/messages.js');
    const doc = (globalThis as any).document;

    const errorLine = m.footerErrorLine();
    const fieldInput = new ShimElement('input');
    const paneB = new ShimElement('div');
    paneB.append(fieldInput);

    const close = showDialog({
      title: 'Диалог с вкладками',
      size: 'm',
      tabs: [
        { id: 'a', label: 'Первая', content: contentPaneB(new ShimElement('div')) },
        { id: 'b', label: 'Вторая', content: contentPaneB(paneB) },
      ],
      footerError: errorLine as unknown as HTMLElement,
      buttons: [
        { label: 'Отмена' },
        { label: 'Записать', primary: true, keepOpen: true },
      ],
    });

    const backdrop = doc.body.children[0] as ShimElement;
    const tabs = (): ShimElement[] => backdrop.findAll((n) => n.classList.contains('ui-tab'));

    assert.equal(tabs()[1]!.getAttribute('aria-selected'), 'false', 'вторая вкладка неактивна');

    errorLine.show('Ошибка на второй вкладке', { tab: 'b', field: () => fieldInput as unknown as HTMLElement });
    errorLine.click();

    assert.equal(tabs()[1]!.getAttribute('aria-selected'), 'true', 'клик переключил вкладку');
    assert.equal(fieldInput.focused, true, 'фокус перешёл в проблемное поле');
    close();
  });
});

/** Ленивый контент вкладки: отдаёт заранее собранную панель. */
function contentPaneB(pane: ShimElement): () => HTMLElement {
  return (): HTMLElement => pane as unknown as HTMLElement;
}
