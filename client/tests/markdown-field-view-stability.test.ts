/**
 * Просмотр комментария не перерисовывается на ПОВТОР с тем же содержимым
 * (0.16.1, живая приёмка, пачка 3, пункт 2).
 *
 * Симптом: длинный комментарий с прокруткой, задача внизу — отметка чекбокса
 * в просмотре перематывала текст к первой строке. Причина — realtime-эхо
 * СВОЕЙ правки (`comment.updated`) вызывало `setMarkdownField`, а тот
 * пересобирал DOM просмотра (`replaceChildren`), сбрасывая прокрутку.
 *
 * Контракт: `set` с тем же `md`/`html` не трогает DOM; с изменённым — рисует
 * заново. Проверяется по числу `replaceChildren` у `.md-field-view`: DOM-шим
 * не считает layout, но пересборку узла видит точно.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function installShim(): void {
  const styleStub = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
    getPropertyValue: () => '',
  };
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: styleStub },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.etn = { ui: { getState: async () => null, setState: async () => undefined } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  win.cancelAnimationFrame = (id: number) => clearTimeout(id);
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const ls = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() {
      return ls.size;
    },
  };
}

installShim();

const { store } = await import('../src/renderer/state.js');
store.update({ networkId: 'net-1' });

const { createMarkdownField, setMarkdownField } =
  await import('../src/renderer/editor/markdown-field.js');

/** Число пересборок просмотра `.md-field-view` с момента сброса счётчика. */
let repaints = 0;
const originalReplaceChildren = ShimElement.prototype.replaceChildren;
ShimElement.prototype.replaceChildren = function patched(this: ShimElement, ...args: any[]) {
  if (this.classList?.contains('md-field-view')) repaints += 1;
  return originalReplaceChildren.apply(this, args as any);
};

/** Дождаться асинхронной дорисовки поля (резолв wiki-ссылок/трансклюзий). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('поле markdown: повтор с тем же содержимым просмотр не пересобирает (пункт 2)', () => {
  it('set(md, html) с теми же значениями — DOM просмотра не тронут', async () => {
    const field = createMarkdownField({
      md: 'длинный текст\n\n- [ ] задача',
      html: '<p>длинный текст</p><p><input type="checkbox" disabled></p>',
    }) as unknown as HTMLElement;
    await settle();
    repaints = 0;

    setMarkdownField(
      field,
      'длинный текст\n\n- [ ] задача',
      '<p>длинный текст</p><p><input type="checkbox" disabled></p>',
    );
    assert.equal(repaints, 0, 'эхо своей правки с тем же содержимым прокрутку не сбрасывает');
  });

  it('set с изменённым html — просмотр перерисован', async () => {
    const field = createMarkdownField({
      md: 'текст',
      html: '<p>текст</p>',
    }) as unknown as HTMLElement;
    await settle();
    repaints = 0;

    setMarkdownField(field, 'новый текст', '<p>новый текст</p>');
    assert.equal(repaints, 1, 'внешнее изменение текста по-прежнему рисуется');
  });
});
