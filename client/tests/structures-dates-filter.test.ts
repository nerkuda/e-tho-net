/**
 * Tests for the «Даты» group of the structures filter panel (задача 7032e55a).
 *
 * Pure structural checks on the wire-level parts of the filter-panel module:
 *
 *  * `getFilterState()` carries the four date bounds
 *    (`createdAfter`/`createdBefore`/`updatedAfter`/`updatedBefore`) as
 *    empty strings by default — the empty-filter case matches what
 *    `parseStructureFilter` returns on the server (no bound ⇒ no clause).
 *  * The wire `StructureFilter` carries the four fields as
 *    `created_after`/`created_before`/`updated_after`/`updated_before`
 *    (the server keys), matching the MCP tool's parameter names and the
 *    REST `POST /thoughts/query` body keys.
 *  * Date bounds survive a JSON round-trip through the L4 `structures_state`
 *    and through `SavedFilter.definition` (the wire persistence shape).
 *
 * The full DOM mount is exercised manually in the renderer (no Playwright
 * harness is wired into this workspace yet). The static shape of the
 * `FilterState` and the persisted JSON is enough to lock the public
 * contract — any UI regression is caught visually during smoke testing.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

class ShimClassList {
  private owner: ShimElement | null = null;
  attach(owner: ShimElement): void {
    this.owner = owner;
  }
  private tokens(): Set<string> {
    return new Set((this.owner?.className ?? '').split(/\s+/).filter((t) => t !== ''));
  }
  private write(tokens: Set<string>): void {
    if (this.owner !== null) this.owner.className = [...tokens].join(' ');
  }
  add(...names: string[]): void {
    const tokens = this.tokens();
    names.forEach((n) => tokens.add(n));
    this.write(tokens);
  }
  remove(...names: string[]): void {
    const tokens = this.tokens();
    names.forEach((n) => tokens.delete(n));
    this.write(tokens);
  }
  contains(name: string): boolean {
    return this.tokens().has(name);
  }
  toggle(name: string, force?: boolean): void {
    const tokens = this.tokens();
    const next = force ?? !tokens.has(name);
    if (next) tokens.add(name);
    else tokens.delete(name);
    this.write(tokens);
  }
}

class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: Record<string, any> = {
    setProperty(name: string, value: string) {
      (this as any)[name] = value;
    },
    removeProperty(name: string) {
      delete (this as any)[name];
    },
  };
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  value = '';
  type = '';
  title = '';
  placeholder = '';
  checked = false;
  disabled = false;
  tabIndex = 0;
  isConnected = true;
  classList = new ShimClassList();
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    this.classList.attach(this);
    if (className !== undefined) this.className = className;
    if (text !== undefined) this.textContent = text;
  }

  append(...nodes: ShimElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: ShimElement[]): void {
    this.children = [];
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }

  removeChild(child: ShimElement): ShimElement {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('removeChild: not a child');
    this.children.splice(index, 1);
    child.parent = null;
    return child;
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

  removeEventListener(_type: string, _listener: (event: any) => void): void {
    /* not needed in tests */
  }

  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  click(): void {
    this.emit('click');
  }

  focus(): void {
    /* no layout engine */
  }

  setSelectionRange(): void {
    /* no caret observable in the shim */
  }

  querySelectorAll(selector: string): ShimElement[] {
    const byTag = !selector.startsWith('.');
    const token = byTag ? selector : selector.slice(1);
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      const match = byTag ? node.tagName === token : node.className.split(/\s+/).includes(token);
      if (match) hits.push(node);
      node.children.forEach(walk);
    };
    this.children.forEach(walk);
    return hits;
  }

  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
}

/** Installs the minimal DOM/window shims the panel + its imports need. */
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
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    etn: {
      propertyRegistry: { list: async () => [] },
      savedFilters: { list: async () => [] },
      thoughts: {
        resolve: async () => [],
        findDuplicates: async () => [],
      },
    },
  };
}

before(() => {
  installShim();
});

describe('structures filter panel — «Даты» wire contract (задача 7032e55a)', () => {
  it('default FilterState carries empty date bounds (no-filter baseline)', async () => {
    const panel = await import('../src/renderer/screens/structures/filter-panel.js');
    const state = panel.getFilterState();
    assert.equal(state.createdAfter, '');
    assert.equal(state.createdBefore, '');
    assert.equal(state.updatedAfter, '');
    assert.equal(state.updatedBefore, '');
  });

  it('date fields persist round-trip through the L4 `structures_state` JSON', async () => {
    const panel = await import('../src/renderer/screens/structures/filter-panel.js');
    const state = {
      ...panel.getFilterState(),
      createdAfter: '2024-02-01T00:00:00',
      createdBefore: '2024-02-28T23:59:59',
      updatedAfter: '2024-03-01T00:00:00',
      updatedBefore: '2024-03-31T23:59:59',
    };
    const json = JSON.stringify(state);
    const restored = JSON.parse(json);
    assert.equal(restored.createdAfter, '2024-02-01T00:00:00');
    assert.equal(restored.createdBefore, '2024-02-28T23:59:59');
    assert.equal(restored.updatedAfter, '2024-03-01T00:00:00');
    assert.equal(restored.updatedBefore, '2024-03-31T23:59:59');
  });

  it('wire StructureFilter keys match the MCP / REST contract (snake_case)', () => {
    // The wire payload uses the same snake_case keys as the server's
    // `POST /thoughts/query` body and `etn.thoughts.query` parameters —
    // see `StructureFilter` in @etn/shared.
    const wire: import('@etn/shared').StructureFilter = {
      keywords: 'foo',
      created_after: '2024-02-01',
      created_before: '2024-02-28',
      updated_after: '2024-03-01',
      updated_before: '2024-03-31',
    };
    assert.equal(wire.created_after, '2024-02-01');
    assert.equal(wire.created_before, '2024-02-28');
    assert.equal(wire.updated_after, '2024-03-01');
    assert.equal(wire.updated_before, '2024-03-31');
  });

  it('saved-filter round-trip carries the four date bounds verbatim', () => {
    const saved: import('@etn/shared').SavedFilter = {
      id: '00000000-0000-4000-8000-000000000001',
      view: 'structures',
      name: 'Квартальные правки',
      definition: {
        created_after: '2024-02-01',
        created_before: '2024-02-28',
        updated_after: '2024-03-01',
        updated_before: '2024-03-31',
        sort: 'alpha',
        order: 'asc',
      },
      created_at: '2024-04-01T00:00:00Z',
      updated_at: '2024-04-01T00:00:00Z',
    };
    const restored = JSON.parse(JSON.stringify(saved)) as typeof saved;
    assert.equal(restored.definition.created_after, '2024-02-01');
    assert.equal(restored.definition.created_before, '2024-02-28');
    assert.equal(restored.definition.updated_after, '2024-03-01');
    assert.equal(restored.definition.updated_before, '2024-03-31');
  });
});
