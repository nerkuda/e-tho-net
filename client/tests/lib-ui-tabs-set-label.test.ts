/**
 * Юнит-тест `TabsHandle.setLabel` (задача 7e5099ed п. 4).
 *
 * Метод появился для живой смены языка открытого диалога: подпись вкладки
 * меняется на месте, бейдж счётчика `(N)` не теряется. До этого теста
 * сохранение бейджа подтверждалось только GUI-пробой верификатора, хотя это
 * публичный метод фасада `lib/ui/tabs.ts`.
 *
 * Закрепляем:
 *   1. подпись меняется, бейдж с числом остаётся и сохраняет значение;
 *   2. `setCount(id, undefined)` скрывает бейдж, подпись при этом остаётся
 *      обновляемой, а последующий `setCount` возвращает число;
 *   3. порядок потомков стабилен: текст подписи первым, бейдж вторым, и это
 *      тот же DOM-узел (бейдж не пересоздаётся);
 *   4. чужой/неизвестный id — no-op, подписи остальных вкладок не меняются.
 *
 * Дом — общий DOM-шим (`dom-shim.ts`); `window` нужен модулю `lib/dom.ts`
 * через цепочку импортов, как в `dialog-focus-stack.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const { uiTabs } = await import('../src/renderer/lib/ui/tabs.js');

/** Кнопки вкладок полосы в порядке объявления. */
function tabButtons(root: ShimElement): ShimElement[] {
  return root.querySelectorAll('.ui-tab');
}

/** Бейдж счётчика вкладки — span `.ui-tab-count` внутри кнопки. */
function badgeOf(btn: ShimElement): ShimElement {
  const badge = btn.children.find((c) => c.classList.contains('ui-tab-count'));
  assert.ok(badge !== undefined, 'бейдж вкладки существует');
  return badge!;
}

describe('uiTabs.setLabel: смена подписи сохраняет бейдж (7e5099ed)', () => {
  it('меняет подпись, сохраняя число бейджа', () => {
    const tabs = uiTabs({
      tabs: [
        { id: 'a', label: 'A', count: 3, content: new ShimElement('div') as any },
        { id: 'b', label: 'B', content: new ShimElement('div') as any },
      ],
    });
    const root = tabs.root as unknown as ShimElement;
    const [btn] = tabButtons(root);
    assert.ok(btn !== undefined);
    const badge = badgeOf(btn!);
    assert.equal(btn!.textContent, 'A(3)');

    tabs.setLabel('a', 'Alpha');

    assert.equal(btn!.textContent, 'Alpha(3)', 'подпись обновлена, бейдж сохранён');
    assert.equal(badge.textContent, '(3)', 'значение бейджа не потеряно');
    assert.equal(badgeOf(btn!), badge, 'бейдж — тот же DOM-узел, не пересоздан');
  });

  it('сохраняет скрытый бейдж при count=undefined и принимает число позже', () => {
    const tabs = uiTabs({
      tabs: [{ id: 'a', label: 'A', content: new ShimElement('div') as any }],
    });
    const root = tabs.root as unknown as ShimElement;
    const [btn] = tabButtons(root);
    assert.ok(btn !== undefined);
    const badge = badgeOf(btn!);
    assert.equal(badge.classList.contains('hidden'), true, 'без счётчика бейдж скрыт');

    tabs.setLabel('a', 'Alpha');
    assert.equal(btn!.textContent, 'Alpha');
    assert.equal(badge.classList.contains('hidden'), true, 'скрытость сохранена');

    tabs.setCount('a', 7);
    assert.equal(btn!.textContent, 'Alpha(7)');
    assert.equal(badge.classList.contains('hidden'), false);
    assert.equal(badgeOf(btn!), badge, 'тот же узел бейджа');

    tabs.setCount('a', undefined);
    assert.equal(btn!.textContent, 'Alpha', 'после скрытия счётчика подпись на месте');
    assert.equal(badge.classList.contains('hidden'), true);
  });

  it('порядок потомков: текст подписи первым, бейдж вторым', () => {
    const tabs = uiTabs({
      tabs: [
        { id: 'a', label: 'A', count: 2, content: new ShimElement('div') as any },
        { id: 'b', label: 'B', content: new ShimElement('div') as any },
      ],
    });
    const root = tabs.root as unknown as ShimElement;
    const [btn] = tabButtons(root);
    assert.ok(btn !== undefined);

    tabs.setLabel('a', 'Alpha');

    const kinds = btn!.childNodes.map((child) => (child.isTextNode ? 'text' : child.tagName));
    assert.deepEqual(kinds, ['text', 'span'], 'текст подписи идёт до бейджа');
    assert.equal(btn!.childNodes[0]!.textContent, 'Alpha');
    assert.equal(btn!.children[0]!.classList.contains('ui-tab-count'), true);
  });

  it('неизвестный id — no-op: чужие подписи не меняются', () => {
    const tabs = uiTabs({
      tabs: [
        { id: 'a', label: 'A', content: new ShimElement('div') as any },
        { id: 'b', label: 'B', count: 1, content: new ShimElement('div') as any },
      ],
    });
    const root = tabs.root as unknown as ShimElement;
    const [first, second] = tabButtons(root);

    assert.doesNotThrow(() => tabs.setLabel('no-such-tab', 'Ghost'));
    assert.equal(first!.textContent, 'A');
    assert.equal(second!.textContent, 'B(1)', 'чужая подпись и бейдж не тронуты');
  });
});
