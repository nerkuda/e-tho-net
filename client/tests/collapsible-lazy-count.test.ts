/**
 * Сворачиваемая группа: ленивый счётчик при развёрнутой по умолчанию группе.
 *
 * 0.14.1 (задача 626b29bd): группа «Свойства вне типа» стала развёрнутой по
 * умолчанию, а её счётчик — ленивый. «Первое раскрытие» для уже показанной
 * группы наступает сразу: бейдж не должен оставаться на «…» до ручного
 * сворачивания/раскрытия. У свёрнутой по умолчанию группы прежняя семантика —
 * счётчик запрашивается при первом раскрытии.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function shimDom(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win['addEventListener'] ??= () => undefined;
  win['removeEventListener'] ??= () => undefined;
  win['dispatchEvent'] ??= () => undefined;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function badgeOf(root: ShimElement): ShimElement | undefined {
  return root.querySelector('.ui-collapsible-count') ?? root.querySelector('.ui-badge--quiet') ?? undefined;
}

describe('сворачиваемая группа: ленивый счётчик (0.14.1, 626b29bd)', () => {
  it('развёрнутая по умолчанию группа читает счётчик сразу', async () => {
    shimDom();
    const { collapsibleSection } = await import('../src/renderer/lib/ui/collapsible.js');
    let calls = 0;
    const section = collapsibleSection({
      title: 'Свойства вне типа',
      lazyCount: true,
      collapsed: false,
      classes: {
        root: 'group',
        header: 'group-header',
        title: 'group-title',
        count: 'ui-badge ui-badge--quiet',
        caret: 'group-caret',
        body: 'group-body',
        actions: 'group-actions',
      },
      loadCount: async () => {
        calls += 1;
        return '(2)';
      },
      buildBody: () => new ShimElement('div') as unknown as HTMLElement,
    });
    await tick();
    assert.equal(calls, 1, 'loadCount вызван без ручного раскрытия');
    assert.equal(badgeOf(section.root as unknown as ShimElement)?.textContent, '(2)');
  });

  it('свёрнутая по умолчанию группа откладывает счётчик до раскрытия', async () => {
    shimDom();
    const { collapsibleSection } = await import('../src/renderer/lib/ui/collapsible.js');
    let calls = 0;
    const section = collapsibleSection({
      title: 'Группа',
      lazyCount: true,
      collapsed: true,
      loadCount: async () => {
        calls += 1;
        return '(3)';
      },
      buildBody: () => new ShimElement('div') as unknown as HTMLElement,
    });
    await tick();
    assert.equal(calls, 0, 'до раскрытия счётчик не читается');
    section.setCollapsed(false);
    await tick();
    assert.equal(calls, 1, 'раскрытие запускает ленивый счётчик');
  });
});
