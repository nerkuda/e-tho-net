/**
 * Вкладка выбора файла диалога иконки — терминология диалога обложки (ошибка
 * e748e323): вкладка называется «Вложения» (не «Файл»), содержит кнопку
 * «Загрузить из файла» (не «Обзор…»), как вкладка «Вложения» диалога обложки
 * публикации. Контролы — фасады `lib/ui` (`uiButton`), не самодельные.
 *
 * jsdom в проекте нет — минимальный DOM-шим (конвенция `resource-picker.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {},
    setTimeout: (fn: () => void, ms?: number) => (globalThis as any).setTimeout(fn, ms),
    clearTimeout: (handle: any) => (globalThis as any).clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { fileImageSourceTab } = await import('../src/renderer/editor/resource-picker.js');
const { t } = await import('../src/renderer/lib/i18n.js');

/** Все потомки с данным тегом. */
function findByTag(root: ShimElement, tag: string): ShimElement[] {
  const wanted = tag.toUpperCase();
  const hits: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    for (const child of node.children) {
      if ((child.tagName ?? '').toUpperCase() === wanted) hits.push(child);
      walk(child);
    }
  };
  walk(root);
  return hits;
}

describe('вкладка «Вложения» диалога иконки (e748e323)', () => {
  beforeEach(() => installShim());

  function buildTab(): ShimElement {
    const tab = fileImageSourceTab({
      types: [],
      onTypeIcon: () => undefined,
      onFile: () => undefined,
    });
    const ctx: any = { close: () => undefined, setReady: () => undefined };
    return tab.build(ctx) as unknown as ShimElement;
  }

  it('подпись вкладки — «Вложения» (из словаря обложки, не «Файл»)', () => {
    const tab = fileImageSourceTab({ types: [], onTypeIcon: () => undefined, onFile: () => undefined });
    assert.equal(tab.label, t('publication.cover.tab.attachments'));
    assert.equal(tab.label, 'Вложения');
    assert.notEqual(tab.label, 'Файл');
  });

  it('кнопка — «Загрузить из файла» через фасад uiButton', () => {
    const root = buildTab();
    const buttons = findByTag(root, 'BUTTON');
    const upload = buttons.find((b) => b.textContent === 'Загрузить из файла');
    assert.ok(upload !== undefined, 'кнопка «Загрузить из файла» построена');
    assert.ok(
      upload!.className.includes('ui-btn'),
      'кнопка собрана фасадом lib/ui/button, а не самодельным контролом',
    );
    assert.equal(
      buttons.find((b) => b.textContent === 'Обзор…'),
      undefined,
      'старой подписи «Обзор…» нет',
    );
  });
});
