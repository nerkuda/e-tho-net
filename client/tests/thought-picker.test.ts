/**
 * Unit tests for the inline `thought_ref` candidate search
 * (client/src/renderer/editor/thought-picker.ts).
 *
 * Regression guard for the plain-Enter bug: the keydown handler only matched
 * Ctrl+Enter, so pressing Enter over the candidate highlighted with ↓ did
 * nothing — only a mouse click picked the row. Enter (and Ctrl+Enter) must
 * pick the highlighted row with the same effect as a click.
 *
 * Runs the REAL wireThoughtRefSearch under Node with a minimal DOM shim and a
 * fake `window.etn` (the same approach as renderer-properties.test.ts). The
 * window object is created once and mutated per test: lib/etn.ts captures
 * `window` at module-import time, so replacing it between tests would leave
 * the etn proxy reading a stale object.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal class list with real toggle/contains state (the picker paints rows). */
class ShimClassList {
  private tokens = new Set<string>();
  add(...names: string[]): void {
    names.forEach((n) => this.tokens.add(n));
  }
  remove(...names: string[]): void {
    names.forEach((n) => this.tokens.delete(n));
  }
  contains(name: string): boolean {
    return this.tokens.has(name);
  }
  toggle(name: string, force?: boolean): void {
    const next = force ?? !this.tokens.has(name);
    if (next) this.tokens.add(name);
    else this.tokens.delete(name);
  }
}

/** Smallest element stub that survives the picker render + keyboard path. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  parent: ShimElement | null = null;
  style: Record<string, string> = {};
  textContent = '';
  value = '';
  title = '';
  placeholder = '';
  type = '';
  isConnected = true;
  classList = new ShimClassList();
  dataset: Record<string, string> = {};
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
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
    this.children = nodes;
    for (const node of nodes) node.parent = this;
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  contains(node: ShimElement | null): boolean {
    if (node === null) return false;
    return node === this || this.children.some((child) => child.contains(node));
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((fn) => fn !== listener),
    );
  }

  /** Test helper: dispatch a synthetic event to the registered listeners. */
  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  click(): void {
    this.emit('click');
  }

  /** Class-selector query in document order (the only form the picker uses). */
  querySelectorAll(selector: string): ShimElement[] {
    const token = selector.startsWith('.') ? selector.slice(1) : selector;
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      if (node.className.split(/\s+/).includes(token)) hits.push(node);
      node.children.forEach(walk);
    };
    this.children.forEach(walk);
    return hits;
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 10, top: 10, right: 210, bottom: 34, width: 200, height: 24 };
  }

  scrollIntoView(): void {
    /* not needed without a layout engine */
  }
}

/** Keydown-like event with the exact shape the picker reads. */
function key(name: string, mods: Record<string, boolean> = {}): any {
  return {
    key: name,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {},
  };
}

/** A duplicate-search hit as returned by the server (the fields the picker reads). */
interface Hit {
  id: string;
  title: string;
  matched_on: string;
}

/**
 * Installs fresh document/window shims. `window` is created once and mutated:
 * lib/etn.ts binds to whatever `window` was present at import time.
 */
function installShim(): {
  input: ShimElement;
  dropdownRoots: () => ShimElement[];
  setHits: (hits: Hit[]) => void;
  queries: string[];
} {
  const queries: string[] = [];
  let nextHits: Hit[] = [];
  const input = new ShimElement('input');
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    body,
  };
  let win = (globalThis as any).window;
  if (win === undefined) {
    win = {};
    (globalThis as any).window = win;
  }
  Object.assign(win, {
    innerWidth: 1200,
    innerHeight: 800,
    // The debounce runs synchronously so tests need no real timers.
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    etn: {
      thoughts: {
        findDuplicates: async (_networkId: string, query: string): Promise<Hit[]> => {
          queries.push(query);
          return nextHits;
        },
      },
    },
  });
  return {
    input,
    dropdownRoots: () => body.children as ShimElement[],
    setHits: (hits: Hit[]) => {
      nextHits = hits;
    },
    queries,
  };
}

let pickerModule: any = null;
async function loadPicker(): Promise<any> {
  if (pickerModule === null) {
    pickerModule = await import('../src/renderer/editor/thought-picker.js');
  }
  return pickerModule;
}

/** Wires the picker, types a query and lets the debounced search settle. */
async function search(
  env: ReturnType<typeof installShim>,
  hits: Hit[],
): Promise<{ rows: ShimElement[]; picked: string[] }> {
  env.setHits(hits);
  const picked: string[] = [];
  const { wireThoughtRefSearch } = await loadPicker();
  wireThoughtRefSearch(env.input as any, {
    networkId: 'net-1',
    onPick: (id: string) => {
      picked.push(id);
    },
  });
  env.input.value = '0.5.';
  env.input.emit('input');
  await new Promise((resolve) => setImmediate(resolve));
  const list = env.dropdownRoots()[0];
  return { rows: list?.querySelectorAll('.type-combo-item') ?? [], picked };
}

describe('wireThoughtRefSearch keyboard picking', () => {
  it('Enter picks the row highlighted with ↓ (regression: plain Enter was a no-op)', async () => {
    const env = installShim();
    const { rows, picked } = await search(env, [
      { id: 'v1', title: '0.5.1 — фиксы', matched_on: 'partial' },
      { id: 'v2', title: '0.5.2 — слои', matched_on: 'partial' },
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(env.queries, ['0.5.'], 'typing runs the duplicate search');

    env.input.emit('keydown', key('ArrowDown'));
    assert.ok(rows[0]?.classList.contains('active'), '↓ highlights the first row');

    const enter = key('Enter');
    env.input.emit('keydown', enter);
    assert.ok(enter.defaultPrevented, 'Enter is consumed while the list is open');
    assert.deepEqual(picked, ['v1'], 'Enter picks the highlighted row');
    assert.equal(env.input.value, '0.5.1 — фиксы');
    assert.equal(env.dropdownRoots().length, 0, 'dropdown closes after the pick');
  });

  it('Enter without a highlight picks the first row', async () => {
    const env = installShim();
    const { rows, picked } = await search(env, [
      { id: 'v1', title: '0.5.1', matched_on: 'partial' },
      { id: 'v2', title: '0.5.2', matched_on: 'partial' },
    ]);
    assert.equal(rows.length, 2);

    env.input.emit('keydown', key('Enter'));
    assert.deepEqual(picked, ['v1']);
  });

  it('Ctrl+Enter still picks the highlighted row (legacy alias)', async () => {
    const env = installShim();
    const { picked } = await search(env, [
      { id: 'v1', title: '0.5.1', matched_on: 'partial' },
      { id: 'v2', title: '0.5.2', matched_on: 'partial' },
    ]);
    env.input.emit('keydown', key('ArrowDown'));
    env.input.emit('keydown', key('ArrowDown'));
    env.input.emit('keydown', key('Enter', { ctrlKey: true }));
    assert.deepEqual(picked, ['v2']);
  });

  it('Escape closes the list; Enter over a closed list picks nothing', async () => {
    const env = installShim();
    const { rows, picked } = await search(env, [
      { id: 'v1', title: '0.5.1', matched_on: 'partial' },
    ]);
    assert.equal(rows.length, 1);

    const escape = key('Escape');
    env.input.emit('keydown', escape);
    assert.equal(env.dropdownRoots().length, 0, 'Escape closes the dropdown');

    env.input.emit('keydown', key('Enter'));
    assert.deepEqual(picked, [], 'Enter with a closed list does not pick');
  });

  it('blur closes the list and restores the pre-search value', async () => {
    const env = installShim();
    const { picked } = await search(env, [
      { id: 'v1', title: '0.5.1', matched_on: 'partial' },
    ]);
    env.input.emit('keydown', key('ArrowDown'));
    env.input.emit('blur');
    assert.equal(env.dropdownRoots().length, 0, 'blur closes the dropdown');
    assert.equal(env.input.value, '', 'typed text is not a value');
    assert.deepEqual(picked, []);
  });
});
