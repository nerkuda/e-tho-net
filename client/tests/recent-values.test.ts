/**
 * Unit tests for the recent-values suggestions of property editors
 * (client/src/renderer/editor/recent-values.ts).
 *
 * Covers the pure history helpers (add / dedup-lift / cap at 10 — the
 * acceptance criteria of the «Помощь с заполнением значений свойств» task),
 * the localStorage roundtrip (key = network id + property id) and the
 * dropdown wiring: focus on an empty field opens the list, typing closes it,
 * clearing reopens it, ↑/↓ + Enter pick, Escape/outside/blur close without
 * touching the field.
 *
 * Runs the REAL module under Node with a minimal DOM shim (the same approach
 * as thought-picker.test.ts / renderer-properties.test.ts). The window object
 * is created once and mutated per test: lib/etn.ts captures `window` at
 * module-import time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal class list with real toggle/contains state (the wiring paints rows). */
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

/** Smallest element stub that survives the dropdown render + keyboard path. */
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

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { left: 10, top: 10, right: 210, bottom: 34, width: 200, height: 24 };
  }

  scrollIntoView(): void {
    /* not needed without a layout engine */
  }
}

/** Keydown-like event with the exact shape the wiring reads. */
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

/** The simplest Storage stand-in (a Map with the two methods used). */
class ShimStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/**
 * Installs fresh document/window shims. `window` is created once and mutated:
 * lib/etn.ts binds to whatever `window` was present at import time.
 */
function installShim(): { input: ShimElement; body: ShimElement } {
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
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return { input, body };
}

let recentModule: any = null;
async function loadRecent(): Promise<any> {
  if (recentModule === null) {
    recentModule = await import('../src/renderer/editor/recent-values.js');
  }
  return recentModule;
}

/** Lets the wiring's async open() chain settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The rows of the currently mounted dropdown (skipping the muted header). */
function rowLabels(body: ShimElement): string[] {
  const list = body.children.find((c) => c.className === 'type-combo-list');
  if (list === undefined) return [];
  return list.children
    .filter((c) => c.className === 'type-combo-item')
    .map((row) => row.children[0]?.textContent ?? '');
}

describe('recent-values history helpers (pure)', () => {
  it('recentValuesStorageKey includes the network id and the property id', async () => {
    const { recentValuesStorageKey } = await loadRecent();
    assert.equal(recentValuesStorageKey('net-1', 'p-2'), 'props.recent.net-1.p-2');
  });

  it('parseRecentValues: null/invalid JSON/non-array → [], strings only, capped at 10', async () => {
    const { parseRecentValues } = await loadRecent();
    assert.deepEqual(parseRecentValues(null), []);
    assert.deepEqual(parseRecentValues('not json'), []);
    assert.deepEqual(parseRecentValues('{"a":1}'), []);
    assert.deepEqual(parseRecentValues('["a",1,null,"","b"]'), ['a', 'b']);
    const eleven = JSON.stringify(Array.from({ length: 12 }, (_, i) => `v${i}`));
    const parsed = parseRecentValues(eleven);
    assert.equal(parsed.length, 10, 'history never exceeds 10 entries');
    assert.deepEqual(parsed, ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
  });

  it('mergeRecentValue: new value first, repeat lifts without duplicates', async () => {
    const { mergeRecentValue } = await loadRecent();
    assert.deepEqual(mergeRecentValue(['b', 'c'], 'a'), ['a', 'b', 'c']);
    assert.deepEqual(mergeRecentValue(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
    assert.deepEqual(mergeRecentValue(['a'], 'a'), ['a']);
    // The value is trimmed; whitespace-only leaves the history unchanged.
    assert.deepEqual(mergeRecentValue(['a'], '  b  '), ['b', 'a']);
    assert.deepEqual(mergeRecentValue(['a'], '   '), ['a']);
    // The previous array is never mutated.
    const prev = ['a', 'b'];
    mergeRecentValue(prev, 'c');
    assert.deepEqual(prev, ['a', 'b']);
  });

  it('mergeRecentValue: caps at 10, the oldest entry drops out', async () => {
    const { mergeRecentValue, RECENT_VALUES_MAX } = await loadRecent();
    assert.equal(RECENT_VALUES_MAX, 10);
    let history: string[] = [];
    for (let i = 1; i <= 11; i += 1) history = mergeRecentValue(history, `v${i}`);
    assert.equal(history.length, 10);
    assert.equal(history[0], 'v11', 'the newest value is first');
    assert.ok(!history.includes('v1'), 'the oldest of 11 entries drops out');
  });
});

describe('recent-values localStorage roundtrip', () => {
  it('recordRecentValue/loadRecentValues: roundtrip, isolated per network and property', async () => {
    const { recordRecentValue, loadRecentValues } = await loadRecent();
    const previous = (globalThis as any).localStorage;
    (globalThis as any).localStorage = new ShimStorage();
    try {
      recordRecentValue('net-1', 'p-1', 'Москва');
      recordRecentValue('net-1', 'p-1', 'СПб');
      // A repeat lifts to the top without duplicates.
      recordRecentValue('net-1', 'p-1', 'Москва');
      assert.deepEqual(loadRecentValues('net-1', 'p-1'), ['Москва', 'СПб']);
      // Other properties / other networks have their own history.
      assert.deepEqual(loadRecentValues('net-1', 'p-2'), []);
      assert.deepEqual(loadRecentValues('net-2', 'p-1'), []);
      recordRecentValue('net-1', 'p-2', 'Казань');
      assert.deepEqual(loadRecentValues('net-1', 'p-1'), ['Москва', 'СПб']);
      assert.deepEqual(loadRecentValues('net-1', 'p-2'), ['Казань']);
      // Whitespace-only values are never recorded.
      recordRecentValue('net-1', 'p-2', '   ');
      assert.deepEqual(loadRecentValues('net-1', 'p-2'), ['Казань']);
    } finally {
      (globalThis as any).localStorage = previous;
    }
  });
});

describe('wireRecentValues dropdown', () => {
  /** Wires an input over the given entries; returns the pick recorder. */
  async function wire(
    entries: Array<{ value: string; label: string }>,
  ): Promise<{ input: ShimElement; body: ShimElement; picked: any[] }> {
    const { input, body } = installShim();
    const picked: any[] = [];
    const { wireRecentValues } = await loadRecent();
    wireRecentValues(input as any, {
      load: () => entries,
      onPick: (entry: any) => picked.push(entry),
    });
    return { input, body, picked };
  }

  it('focus on an empty field opens the list of recent values', async () => {
    const { input, body } = await wire([
      { value: 'Москва', label: 'Москва' },
      { value: 'СПб', label: 'СПб' },
    ]);
    input.emit('focus');
    await flush();
    assert.deepEqual(rowLabels(body), ['Москва', 'СПб'], 'entries shown in history order');
    const list = body.children.find((c) => c.className === 'type-combo-list');
    assert.equal(list?.children[0]?.className, 'muted type-combo-empty');
  });

  it('focus on a filled field opens nothing; empty history opens nothing', async () => {
    const filled = await wire([{ value: 'Москва', label: 'Москва' }]);
    filled.input.value = 'СПб';
    filled.input.emit('focus');
    await flush();
    assert.equal(filled.body.children.length, 0, 'no dropdown for a filled field');

    const empty = await wire([]);
    empty.input.emit('focus');
    await flush();
    assert.equal(empty.body.children.length, 0, 'no dropdown without history');
  });

  it('typing closes the list, clearing the field reopens it', async () => {
    const { input, body } = await wire([
      { value: 'Москва', label: 'Москва' },
      { value: 'СПб', label: 'СПб' },
    ]);
    input.emit('focus');
    await flush();
    assert.equal(rowLabels(body).length, 2);

    input.value = 'Мос';
    input.emit('input');
    assert.equal(body.children.length, 0, 'typing closes the recent list');

    input.value = '';
    input.emit('input');
    await flush();
    assert.deepEqual(rowLabels(body), ['Москва', 'СПб'], 'clearing reopens the list');
  });

  it('↑/↓ move the highlight, Enter picks the highlighted row', async () => {
    const { input, body, picked } = await wire([
      { value: 'v1', label: 'Раз' },
      { value: 'v2', label: 'Два' },
      { value: 'v3', label: 'Три' },
    ]);
    input.emit('focus');
    await flush();
    const list = body.children.find((c) => c.className === 'type-combo-list');
    const rows = list?.children.filter((c) => c.className === 'type-combo-item') ?? [];

    input.emit('keydown', key('ArrowDown'));
    assert.ok(rows[0]?.classList.contains('active'), '↓ highlights the first row');
    input.emit('keydown', key('ArrowDown'));
    assert.ok(rows[1]?.classList.contains('active'), 'second ↓ moves the highlight');
    assert.ok(!rows[0]?.classList.contains('active'));
    input.emit('keydown', key('ArrowUp'));
    assert.ok(rows[0]?.classList.contains('active'), '↑ moves back');

    const enter = key('Enter');
    input.emit('keydown', enter);
    assert.ok(enter.defaultPrevented, 'Enter is consumed while the list is open');
    assert.deepEqual(picked, [{ value: 'v1', label: 'Раз' }]);
    assert.equal(body.children.length, 0, 'the dropdown closes after the pick');
  });

  it('Enter without a highlight picks the first row (the candidate-search rule)', async () => {
    const { input, picked } = await wire([{ value: 'v1', label: 'Раз' }]);
    input.emit('focus');
    await flush();
    input.emit('keydown', key('Enter'));
    assert.deepEqual(picked, [{ value: 'v1', label: 'Раз' }]);
  });

  it('Escape and blur close the list without picking', async () => {
    const { input, body, picked } = await wire([{ value: 'v1', label: 'Раз' }]);
    input.emit('focus');
    await flush();
    const escape = key('Escape');
    input.emit('keydown', escape);
    assert.ok(escape.stopPropagation !== undefined);
    assert.equal(body.children.length, 0, 'Escape closes the dropdown');

    input.emit('focus');
    await flush();
    assert.equal(rowLabels(body).length, 1, 'focus reopens the list');
    input.emit('keydown', key('ArrowDown'));
    input.emit('blur');
    assert.equal(body.children.length, 0, 'blur closes the dropdown');
    assert.equal(input.value, '', 'the field is left untouched');

    const enter = key('Enter');
    input.emit('keydown', enter);
    assert.ok(!enter.defaultPrevented, 'Enter over a closed list is not consumed');
    assert.deepEqual(picked, []);
  });

  it('clicking a row picks it and keeps the focus in the input', async () => {
    const { input, body, picked } = await wire([
      { value: 'v1', label: 'Раз' },
      { value: 'v2', label: 'Два' },
    ]);
    input.emit('focus');
    await flush();
    const list = body.children.find((c) => c.className === 'type-combo-list');
    const rows = list?.children.filter((c) => c.className === 'type-combo-item') ?? [];

    const mousedown = { defaultPrevented: false, preventDefault(): void {
      this.defaultPrevented = true;
    } };
    rows[1]?.emit('mousedown', mousedown);
    assert.ok(mousedown.defaultPrevented, 'mousedown is prevented — no blur while picking');
    rows[1]?.click();
    assert.deepEqual(picked, [{ value: 'v2', label: 'Два' }]);
    assert.equal(body.children.length, 0, 'the dropdown closes after the pick');
  });

  it('a load that settles after typing never opens the list', async () => {
    const { input, body } = installShim();
    const { wireRecentValues } = await loadRecent();
    let resolveLoad: (entries: Array<{ value: string; label: string }>) => void = () => undefined;
    const gate = new Promise<Array<{ value: string; label: string }>>((resolve) => {
      resolveLoad = resolve;
    });
    wireRecentValues(input as any, { load: () => gate, onPick: () => undefined });

    input.emit('focus');
    input.value = 'Мос';
    input.emit('input');
    resolveLoad([{ value: 'Москва', label: 'Москва' }]);
    await flush();
    assert.equal(body.children.length, 0, 'typing won the race — no list');
  });

  it('a load that settles after blur never opens the list', async () => {
    const { input, body } = installShim();
    const { wireRecentValues } = await loadRecent();
    let resolveLoad: (entries: Array<{ value: string; label: string }>) => void = () => undefined;
    const gate = new Promise<Array<{ value: string; label: string }>>((resolve) => {
      resolveLoad = resolve;
    });
    wireRecentValues(input as any, { load: () => gate, onPick: () => undefined });

    input.emit('focus');
    input.emit('blur');
    resolveLoad([{ value: 'Москва', label: 'Москва' }]);
    await flush();
    assert.equal(body.children.length, 0, 'blur won the race — no list');
  });
});
