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

/* eslint-disable @typescript-eslint/no-explicit-any */

class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  type = '';
  classList = {
    add: (...names: string[]): void => {
      for (const name of names) if (!this.has(name)) this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.className.split(/\s+/).filter((c) => c !== '' && c !== name).join(' ');
    },
    toggle: (name: string, force?: boolean): void => {
      const next = force ?? !this.has(name);
      if (next) this.classList.add(name);
      else this.classList.remove(name);
    },
    contains: (name: string): boolean => this.has(name),
  };
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  private has(name: string): boolean {
    return this.className.split(/\s+/).includes(name);
  }

  append(...nodes: ShimElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((fn) => fn !== listener));
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 10, top: 10, right: 210, bottom: 34, width: 200, height: 24 };
  }

  querySelectorAll(): ShimElement[] {
    return [];
  }
}

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
