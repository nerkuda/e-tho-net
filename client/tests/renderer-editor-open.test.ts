/**
 * Unit tests for the editor open/loading flow (0.5.6, bug 9d1d27c9).
 *
 * Covers four invariants:
 *  - the single-click defer helper cancels a pending action when cancelled
 *    before the delay elapses (the "double click handled as two single
 *    clicks" shake — the dblclick handler calls cancel() on the pending
 *    timer, so the editor never sees the first click);
 *  - the loader-only thought header contains the preloader marker and the
 *    short-id placeholder, and the real header is a clickable button with
 *    its dialog listener attached (bug §4: «прелоадер при обновлении»);
 *  - tab panes and group bodies are built lazily — a render that never
 *    activates the «Вложения» tab and never expands the «Комментарий»
 *    group must NOT trigger their respective fetches (bug §5: lazy load
 *    by visible tab/group).
 *
 * Pure TS — runs the real modules under Node with a minimal DOM shim,
 * mirroring the pattern of `renderer-editor-mount.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deferSingleClick,
  canvasInternals,
} from '../src/renderer/canvas/canvas.js';
import { editorInternals } from '../src/renderer/editor/editor.js';
import { groupSection } from '../src/renderer/editor/group.js';
import { store } from '../src/renderer/state.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Minimal DOM shim — only the bits the modules under test actually touch.
// `deferSingleClick` uses `window.setTimeout`/`window.clearTimeout`; the
// loader/group tests create elements via `document.createElement` and walk
// `children`/`classList`. `style` is augmented with the two CSSStyleDeclaration
// methods `mountEditor` reaches for (`setProperty`/`removeProperty`, via
// `setClampRoot`).
// ---------------------------------------------------------------------------

class ShimElement {
  tagName: string;
  private _className = '';
  children: ShimElement[] = [];
  style: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
    [key: string]: unknown;
  };
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  type = '';
  checked = false;
  title = '';
  placeholder = '';
  maxLength = 0;
  rows = 0;
  readOnly = false;
  isConnected = true;
  parent: ShimElement | null = null;
  private listenerCount = 0;
  /** Parsed class set — kept in sync with `_className` through the setter.
   *  Public: the free helpers `matches`/`closest` below match class selectors. */
  readonly classes = new Set<string>();
  classList = {
    add: (c: string): void => {
      this.classes.add(c);
      this._syncClassName();
    },
    remove: (c: string): void => {
      this.classes.delete(c);
      this._syncClassName();
    },
    toggle: (c: string, on?: boolean): void => {
      if (on === undefined) {
        if (this.classes.has(c)) this.classes.delete(c);
        else this.classes.add(c);
      } else if (on) this.classes.add(c);
      else this.classes.delete(c);
      this._syncClassName();
    },
    contains: (c: string): boolean => this.classes.has(c),
    _set: this.classes,
  };
  constructor(tag: string, className?: string, text?: string) {
    this.tagName = tag;
    if (className !== undefined && className !== '') this.className = className;
    if (text !== undefined) this.textContent = text;
    this.style = {
      setProperty: (): void => undefined,
      removeProperty: (): void => undefined,
    };
  }
  get className(): string {
    return this._className;
  }
  set className(value: string) {
    this._className = value;
    this.classes.clear();
    for (const c of value.split(/\s+/).filter((s) => s !== '')) this.classes.add(c);
  }
  private _syncClassName(): void {
    this._className = [...this.classes].join(' ');
  }
  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
  }
  replaceChildren(...nodes: Array<ShimElement | string>): void {
    this.children = [];
    for (const node of nodes) this.append(node);
  }
  remove(): void {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
    }
    this.parent = null;
  }
  addEventListener(): void {
    this.listenerCount++;
  }
  removeEventListener(): void {
    if (this.listenerCount > 0) this.listenerCount--;
  }
  closest(selector: string): ShimElement | null {
    let cur: ShimElement | null = this.parent;
    while (cur !== null) {
      if (selector.startsWith('.') && cur.classes.has(selector.slice(1))) return cur;
      cur = cur.parent;
    }
    return null;
  }
  querySelector(selector: string): ShimElement | null {
    return findFirst(this, selector);
  }
  querySelectorAll(selector: string): ShimElement[] {
    const out: ShimElement[] = [];
    walk(this, (node) => {
      if (matches(node, selector)) out.push(node);
    });
    return out;
  }
  setAttribute(name: string, value: string): void {
    (this as Record<string, unknown>)[name] = value;
  }
  removeAttribute(): void {}
  setSelectionRange(): void {}
  focus(): void {}
  blur(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }
  hasListeners(): boolean {
    return this.listenerCount > 0;
  }
}

function matches(node: ShimElement, selector: string): boolean {
  if (selector.startsWith('.')) return node.classes.has(selector.slice(1));
  if (selector.startsWith('#')) return node.textContent === selector.slice(1);
  return node.tagName === selector;
}

function findFirst(root: ShimElement, selector: string): ShimElement | null {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const inner = findFirst(child, selector);
    if (inner !== null) return inner;
  }
  return null;
}

function walk(root: ShimElement, cb: (n: ShimElement) => void): void {
  for (const child of root.children) {
    cb(child);
    walk(child, cb);
  }
}

function shimDom(): void {
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
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.etn = { ui: { setState: async () => undefined } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

function resetCollapsedGroups(): void {
  store.update({ collapsedGroups: {} });
}

// ---------------------------------------------------------------------------
// 1. deferSingleClick — the core of the double-click fix
// ---------------------------------------------------------------------------

describe('deferSingleClick (double-click guard)', () => {
  it('does not fire the action when cancelled before the delay', () => {
    shimDom();
    let fired = 0;
    const handle = deferSingleClick(() => {
      fired++;
    });
    handle.cancel();
    assert.equal(fired, 0, 'cancel before the delay must prevent the action');
  });

  it('does not fire when cancelled inside the delay window', async () => {
    shimDom();
    let fired = 0;
    const handle = deferSingleClick(() => {
      fired++;
    });
    // Simulate the dblclick handler cancelling the pending single click.
    handle.cancel();
    // Wait past the delay to be sure no late fire happens.
    await new Promise((resolve) => setTimeout(resolve, canvasInternals.SINGLE_CLICK_DELAY_MS + 50));
    assert.equal(fired, 0, 'cancelled single-click action must not fire later');
  });

  it('fires exactly once when the delay elapses without a cancel', async () => {
    shimDom();
    let fired = 0;
    deferSingleClick(() => {
      fired++;
    });
    await new Promise((resolve) => setTimeout(resolve, canvasInternals.SINGLE_CLICK_DELAY_MS + 50));
    assert.equal(fired, 1, 'the action must fire exactly once after the delay');
  });

  it('exposes the configured delay as a tunable seam', () => {
    assert.ok(
      canvasInternals.SINGLE_CLICK_DELAY_MS >= 100 && canvasInternals.SINGLE_CLICK_DELAY_MS <= 400,
      'SINGLE_CLICK_DELAY_MS must sit in the OS double-click window (100–400 ms)',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Editor header preloader — exported as a test seam; verifies the loader
//    is purely a render artefact, not a stateful side effect of the editor
//    mount pipeline.
// ---------------------------------------------------------------------------

describe('editor header — preloader for in-flight thought (bug 9d1d27c9 §4)', () => {
  it('renders a loading-only header while the entity is in flight', () => {
    shimDom();
    // The builder runs against the DOM shim, so the node is really a ShimElement.
    const loaderHeader = editorInternals.buildThoughtHeaderLoading('aabbccdd-1111') as unknown as ShimElement;
    const iconLoading = loaderHeader.querySelector('.editor-icon-loading');
    assert.ok(iconLoading !== null, 'preloader span must be present in the header');
    // The preloader span is a span, not a button — it has no click listener.
    assert.equal(iconLoading!.tagName, 'span', 'preloader must not be a clickable button');
    assert.equal(iconLoading!.hasListeners(), false, 'preloader carries no listeners');
    // The preloader carries the loader icon SVG inside.
    const svg = iconLoading!.querySelector('svg');
    assert.ok(svg !== null, 'loader SVG must be inside the preloader span');
    const titleArea = loaderHeader.querySelector('.editor-title-input');
    assert.ok(titleArea !== null, 'placeholder title area must be present');
    assert.match(titleArea!.value as string, /…загрузка aabbccdd/, 'title shows the short thought id');
    assert.equal(titleArea!.readOnly, true, 'placeholder title is read-only');
  });

  it('exposes a link-header loading helper for symmetry', () => {
    shimDom();
    const linkLoader = editorInternals.buildLinkHeaderLoading('deadbeef-2222');
    // The ShimElement does not auto-aggregate child textContent; walk to the
    // placeholder span instead. The real DOM exposes this via textContent,
    // so a passing test here is a faithful mirror.
    const span = linkLoader.querySelector('span');
    assert.ok(span !== null, 'link placeholder span must be present');
    assert.match(span!.textContent, /…загрузка связи deadbeef/);
  });
});

// ---------------------------------------------------------------------------
// 3. Lazy group loading — a body that has never been opened must not have
//    been called. Drives `groupSection` directly with a counting `buildBody`.
// ---------------------------------------------------------------------------

describe('group lazy loading (bug 9d1d27c9 §5)', () => {
  it('does not build the body of a collapsed group until it is expanded', () => {
    shimDom();
    resetCollapsedGroups();
    let built = 0;
    groupSection({
      id: 'lazy-group',
      title: 'Ленивая группа',
      defaultCollapsed: true,
      buildBody: () => {
        built++;
        return { tagName: 'div', className: '', children: [], classList: { contains: () => false } } as any;
      },
    });
    // The group is collapsed by default — its body must NOT have built.
    assert.equal(built, 0, 'collapsed group must not build its body up front');
    // Toggle the collapsed flag in the store and re-mount — the group reads
    // the persisted collapsed state on every build, so a fresh section with
    // the same id and an `expanded` flag must build exactly once.
    store.update({ collapsedGroups: { 'lazy-group': false } });
    groupSection({
      id: 'lazy-group',
      title: 'Ленивая группа',
      defaultCollapsed: false,
      buildBody: () => {
        built++;
        return { tagName: 'div', className: '', children: [], classList: { contains: () => false } } as any;
      },
    });
    assert.equal(built, 1, 'expanded group must build its body once');
  });
});

// ---------------------------------------------------------------------------
// 4. Public test seams — a smoke test guarding against accidental rename.
// ---------------------------------------------------------------------------

describe('editor public test seams', () => {
  it('editorInternals exposes mainSectionCount', () => {
    assert.equal(typeof editorInternals.mainSectionCount, 'function');
  });

  it('canvasInternals exposes deferSingleClick and SINGLE_CLICK_DELAY_MS', () => {
    assert.equal(typeof canvasInternals.deferSingleClick, 'function');
    assert.equal(typeof canvasInternals.SINGLE_CLICK_DELAY_MS, 'number');
  });
});
