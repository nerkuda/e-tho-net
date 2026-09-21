/**
 * Unit tests for the shared floating menu's rich-row support
 * (client/src/renderer/lib/menu.ts).
 *
 * `MenuItem.content` lets a caller own the whole row (history / pinned
 * dropdowns pass a thought cloud from the shared factory so the row carries
 * the icon, colours, dim state and trash mark). The classic `icon` + `label`
 * pair must keep working unchanged. Runs under Node with a minimal DOM shim.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): { body: ShimElement } {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    body,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return { body };
}

let menuModule: any = null;
async function loadMenu(): Promise<any> {
  if (menuModule === null) menuModule = await import('../src/renderer/lib/menu.js');
  return menuModule;
}

/** The last menu root mounted on the body. */
function lastMenu(body: ShimElement): ShimElement | undefined {
  return body.children[body.children.length - 1];
}

describe('menu: rich row content', () => {
  it('content заменяет пару «значок + подпись»', async () => {
    const { body } = installShim();
    const { showMenuAt } = await loadMenu();
    const node = new ShimElement('div');
    node.className = 'prop-ref-cloud';
    showMenuAt(10, 10, [{ label: 'Мысль', content: node, dragId: 't1' }]);
    const root = lastMenu(body);
    const row = root?.children[0];
    assert.equal(row?.className, 'menu-item');
    const wrap = row?.children[0];
    assert.equal(wrap?.className, 'menu-item-content', 'узел обёрнут в menu-item-content');
    assert.equal(wrap?.children[0], node, 'переданный узел — содержимое строки');
    assert.ok(
      row?.children.every((c) => c.className !== 'menu-item-label'),
      'голой подписи нет',
    );
    assert.equal(row?.dataset['dragId'], 't1', 'dragId сохраняется');
  });

  it('обычная строка по-прежнему рисует значок и подпись', async () => {
    const { body } = installShim();
    const { showMenuAt } = await loadMenu();
    showMenuAt(10, 10, [{ label: 'Открыть', icon: '📂' }]);
    const row = lastMenu(body)?.children[0];
    assert.equal(row?.children[0]?.className, 'menu-item-icon');
    assert.equal(row?.children[0]?.textContent, '📂');
    assert.equal(row?.children[1]?.className, 'menu-item-label');
    assert.equal(row?.children[1]?.textContent, 'Открыть');
  });
});
