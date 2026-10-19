/**
 * Гейт входа в правку markdown-поля при чужом захвате (ошибка 132c80bd).
 *
 * Симптом: тост говорил «поля заблокированы», а поле оставалось
 * редактируемым (запись падала 409). Контракт: `beforeEdit: () => false`
 * оставляет поле в просмотре — правка не начинается (чтение не блокируется,
 * ADR 705fb6d3).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['etn'] = { ui: { getState: async () => null, setState: async () => undefined } };
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

const { createMarkdownField, editMarkdownField } = await import(
  '../src/renderer/editor/markdown-field.js'
);

describe('markdown-field: beforeEdit блокирует правку при чужом захвате', () => {
  it('false — поле остаётся в просмотре, гейт спрошен', () => {
    let asked = 0;
    const root = createMarkdownField({
      md: 'текст',
      html: '<p>текст</p>',
      beforeEdit: () => {
        asked += 1;
        return false;
      },
    }) as unknown as ShimElement;

    editMarkdownField(root as unknown as HTMLElement);

    assert.equal(asked, 1, 'гейт вызван перед входом в правку');
    assert.ok(!root.classList.contains('md-field--editing'), 'поле не перешло в правку');
  });
});
