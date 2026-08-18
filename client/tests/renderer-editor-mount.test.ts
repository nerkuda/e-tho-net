/**
 * Regression test for duplicate «Основное» sections (editor, renderer).
 *
 * The editor registers its sections, tabs and the attachments-changed document
 * listener inside `mountEditor`. The workspace screen is rebuilt from scratch
 * on every network open («Открыть сеть (список)» → openNetwork → showScreen),
 * so `mountEditor` runs again per open. The registrations must be one-time:
 * before the fix each open appended another «Свойства» and «Комментарий»
 * group to the append-only section registry.
 *
 * Runs the REAL `mountEditor` under Node with a minimal DOM shim.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal element stub that survives the mountEditor path. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  isConnected = true;
  innerHTML = '';
  parent: ShimElement | null = null;
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined,
    contains: () => false,
  };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }
  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }
  append(...nodes: ShimElement[]): void {
    for (const node of nodes) node.parent = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ShimElement[]): void {
    this.children = [...nodes];
    for (const node of nodes) node.parent = this;
  }
  removeChild(node: ShimElement): void {
    this.children = this.children.filter((c) => c !== node);
  }
  remove(): void {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
    }
    this.parent = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  closest(): ShimElement | null {
    return null;
  }
  querySelector(): ShimElement | null {
    return null;
  }
  setAttribute(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

/** Minimal `document`/`window` shims (CodeMirror probing handled upstream). */
function shimDom(): void {
  // `render` runs `activeElement instanceof HTMLElement` — provide the class.
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  (globalThis as any).window = {
    etn: { ui: { setState: async () => undefined } },
    setTimeout,
    clearTimeout,
    dispatchEvent: () => undefined,
  };
}

describe('editor mount (DOM-shimmed)', () => {
  it('registers «Основное» sections only once across network re-opens', async () => {
    shimDom();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: 'n1', focus: null } as any);

    mountEditor(new ShimElement('div') as any);
    const countAfterFirstMount = editorInternals.mainSectionCount();
    assert.equal(countAfterFirstMount, 2, '«Свойства» + «Комментарий» on the first mount');

    // Two more network opens rebuild the workspace and re-run mountEditor.
    mountEditor(new ShimElement('div') as any);
    mountEditor(new ShimElement('div') as any);
    assert.equal(
      editorInternals.mainSectionCount(),
      countAfterFirstMount,
      'section registry must not grow per mount',
    );
  });
});
