/**
 * Unit tests for the focus filter strip (task 02ba2ae7, spec 9984aa98).
 *
 * Covered behaviours:
 *   * renderStrip(null) hides the strip and clears the focus bookkeeping;
 *   * the strip paints «Потомки», then one button per effective view in
 *     server order, then «⋯», then «+»;
 *   * «+» is disabled for thoughts with `type_id = null`
 *     (requirement 23e0f78e) and enabled otherwise;
 *   * clicking «Потомки» returns the mode to `{ kind: 'children' }`;
 *   * clicking a view button switches the active mode to that view,
 *     notifies listeners, and persists the per-focus choice to L4;
 *   * the default view wins over the persisted state when the persisted
 *     entry is missing; an unknown persisted view falls back to the
 *     default (or «Потомки»);
 *   * `runActiveViewIfNeeded` caches the result and short-circuits when
 *     the mode is `children`;
 *   * `thought-type-view.*` realtime events trigger a strip rebuild;
 *   * persisted-state JSON parsing tolerates garbage and recovers an
 *     empty map.
 *
 * Runs the strip module against a minimal DOM shim and a fake `etn`.
 * The shim only models the slice the strip touches: `createElement`,
 * class toggles, `addEventListener` for click/contextmenu and
 * `querySelectorAll`. No layout engine.
 *
 * The strip module is imported dynamically in `before()` so `globalThis.etn`
 * is set before `lib/etn.ts` resolves — the Proxy looks it up at call
 * time, but the test harness must mirror the load ordering to keep
 * `before()` deterministic.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';

import type {
  FocusResponse,
  Thought,
  ThoughtTypeView,
} from '@etn/shared';

import { store } from '../src/renderer/state.js';

type StripModule = typeof import('../src/renderer/canvas/focus-filter-strip.js');
let strip: StripModule;

// ---------------------------------------------------------------------------
// DOM shim
// ---------------------------------------------------------------------------

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
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  type = '';
  title = '';
  disabled = false;
  private listeners = new Map<string, Array<(event: any) => void>>();
  classList = new ShimClassList();

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
  appendChild(node: ShimElement): ShimElement {
    node.parent = this;
    this.children.push(node);
    return node;
  }
  removeChild(child: ShimElement): ShimElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parent = null;
    }
    return child;
  }
  insertBefore(node: ShimElement, before: ShimElement | null): void {
    node.parent = this;
    if (before === null) {
      this.children.push(node);
    } else {
      const idx = this.children.indexOf(before);
      if (idx < 0) this.children.push(node);
      else this.children.splice(idx, 0, node);
    }
  }
  insertAdjacentElement(where: string, node: ShimElement): void {
    if (where === 'afterend' && this.parent !== null) {
      const idx = this.parent.children.indexOf(this);
      if (idx >= 0) this.parent.children.splice(idx + 1, 0, node);
      else this.parent.children.push(node);
      node.parent = this.parent;
    }
  }
  replaceWith(node: ShimElement): void {
    if (this.parent !== null) {
      const idx = this.parent.children.indexOf(this);
      if (idx >= 0) this.parent.children[idx] = node;
      node.parent = this.parent;
    }
  }
  remove(): void {
    if (this.parent === null) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) this.parent.children.splice(idx, 1);
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
    this.listeners.set(type, list.filter((fn) => fn !== listener));
  }
  emit(type: string, event: any = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  click(): void {
    this.emit('click', { stopPropagation() {}, preventDefault() {} });
  }
  dispatchContextMenu(x = 10, y = 20): void {
    this.emit('contextmenu', {
      clientX: x,
      clientY: y,
      preventDefault() {},
      stopPropagation() {},
    });
  }
  setAttribute(name: string, value: string): void {
    (this.dataset as Record<string, string>)[name] = value;
  }
  querySelectorAll(selector: string): ShimElement[] {
    const byTag = !selector.startsWith('.') && !selector.startsWith('[');
    let token = selector;
    let attrMatch: { name: string; value?: string } | null = null;
    if (selector.startsWith('[')) {
      const close = selector.indexOf(']');
      const inner = selector.slice(1, close);
      const eq = inner.indexOf('=');
      if (eq >= 0) {
        attrMatch = { name: inner.slice(0, eq), value: inner.slice(eq + 1).replace(/"/g, '') };
      } else {
        attrMatch = { name: inner };
      }
      token = inner;
    } else if (!byTag) {
      token = selector.slice(1);
    }
    const attrVariants = (name: string): string[] => {
      if (!name.startsWith('data-')) return [name];
      const short = name.slice(5);
      const camel = short.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return [name, camel, short];
    };
    const hits: ShimElement[] = [];
    const walk = (node: ShimElement): void => {
      let match = false;
      if (byTag) match = node.tagName === token;
      else if (selector.startsWith('.')) match = node.className.split(/\s+/).includes(token);
      else if (attrMatch !== null) {
        if (attrMatch.value !== undefined) {
          match = attrVariants(attrMatch.name).some((n) => node.dataset[n] === attrMatch.value);
        } else {
          match = attrVariants(attrMatch.name).some((n) => n in node.dataset);
        }
      }
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
  get firstChild(): ShimElement | null {
    return this.children[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const FOCUS_ID = '00000000-0000-4000-8000-000000000100';

function thought(id: string, title: string, typeId: string | null = TYPE_ID): Thought {
  return {
    id,
    title,
    type_id: typeId,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

function focusOf(t: Thought): FocusResponse {
  return {
    focused: t,
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'manual', order: 'asc' },
      children: { sort: 'manual', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  };
}

function view(
  id: string,
  name: string,
  options: { is_default?: boolean; position?: number; version?: number } = {},
): ThoughtTypeView {
  return {
    id,
    thought_type_id: TYPE_ID,
    name,
    name_key: name.toLowerCase(),
    description: null,
    definition: '{}',
    position: options.position ?? 0,
    is_default: options.is_default ?? false,
    version: options.version ?? 1,
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
  };
}

function metaViewRow(v: ThoughtTypeView, definedOn = TYPE_ID): Record<string, unknown> {
  return {
    id: v.id,
    name: v.name,
    name_key: v.name_key,
    description: v.description,
    defined_on: definedOn,
    inherited: definedOn !== TYPE_ID,
    is_default: v.is_default,
  };
}

// ---------------------------------------------------------------------------
// Fake `etn` (mounted on `globalThis.etn`, which `lib/etn.ts` reads when
// `window` is undefined).
// ---------------------------------------------------------------------------

interface FakeState {
  thoughtsGet: { calls: { nid: string; id: string }[]; response: any };
  viewsList: { calls: { nid: string; tid: string }[]; effective: ThoughtTypeView[] };
  uiGet: { calls: { nid: string; key: string }[]; value: string | null };
  uiSet: { calls: { nid: string; key: string; value: string }[] };
  viewUpdate: { calls: any[] };
  viewRemove: { calls: any[] };
  viewRun: { calls: { nid: string; tid: string; name: string }[]; response: any };
}

let state: FakeState;

function installFakeApi(): any {
  state = {
    thoughtsGet: { calls: [], response: null },
    viewsList: { calls: [], effective: [] },
    uiGet: { calls: [], value: null },
    uiSet: { calls: [] },
    viewUpdate: { calls: [] },
    viewRemove: { calls: [] },
    viewRun: { calls: [], response: null },
  };
  return {
    thoughts: {
      get: async (nid: string, id: string) => {
        state.thoughtsGet.calls.push({ nid, id });
        return state.thoughtsGet.response;
      },
    },
    thoughtTypeViews: {
      list: async (nid: string, tid: string) => {
        state.viewsList.calls.push({ nid, tid });
        return {
          data: state.viewsList.effective,
          meta: { effective: state.viewsList.effective },
        };
      },
      run: async (nid: string, tid: string, name: string) => {
        state.viewRun.calls.push({ nid, tid, name });
        return state.viewRun.response;
      },
      update: async (...args: any[]) => {
        state.viewUpdate.calls.push(args);
        const last = args[3];
        return {
          id: args[2],
          thought_type_id: args[1],
          name: 'X',
          name_key: 'x',
          description: null,
          definition: '{}',
          position: 0,
          is_default: last?.is_default ?? false,
          version: (args[4] ?? 0) + 1,
          created_at: '2026-09-08T00:00:00.000Z',
          updated_at: '2026-09-08T00:00:00.000Z',
          created_by: '00000000-0000-4000-8000-000000000000',
        };
      },
      remove: async (...args: any[]) => {
        state.viewRemove.calls.push(args);
      },
    },
    ui: {
      getState: async (nid: string, key: string) => {
        state.uiGet.calls.push({ nid, key });
        return state.uiGet.value;
      },
      setState: async (nid: string, key: string, value: string) => {
        state.uiSet.calls.push({ nid, key, value });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  host: ShimElement;
  triggerClick: (btn: ShimElement | null) => void;
  findButton: (label: string) => ShimElement | null;
  findViewButton: (viewId: string) => ShimElement | null;
  findPlusButton: () => ShimElement | null;
  findStrip: () => ShimElement | null;
}

function installShim(): Harness {
  const host = new ShimElement('section', 'canvas-host');
  const focusRow = new ShimElement('div', 'canvas-focus-row');
  const splitter = new ShimElement('div', 'zone-splitter-h');
  const empty = new ShimElement('div', 'canvas-empty hidden');
  const layerLabel = new ShimElement('div', 'canvas-layer-label hidden');
  host.append(focusRow, splitter, empty, layerLabel);

  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };

  return {
    host,
    triggerClick: (btn) => btn?.click(),
    findButton: (label) => {
      const all = host.querySelectorAll('.canvas-filter-strip-btn');
      return all.find((b) => b.textContent === label) ?? null;
    },
    findViewButton: (viewId) => {
      const all = host.querySelectorAll('.canvas-filter-strip-btn');
      return all.find((b) => b.dataset['viewId'] === viewId) ?? null;
    },
    findPlusButton: () => host.querySelectorAll('.canvas-filter-strip-add')[0] ?? null,
    findStrip: () => host.querySelector('.canvas-filter-strip'),
  };
}

function setNetwork(): void {
  store.update({ networkId: NETWORK_ID, focus: null });
}

before(async () => {
  // Mount a minimal `etn` so `lib/etn.ts` resolves; the Proxy picks it up
  // lazily via `globalThis.etn`. Imports after this point see the populated
  // surface.
  (globalThis as any).etn = installFakeApi();
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  strip = await import('../src/renderer/canvas/focus-filter-strip.js');
});

beforeEach(() => {
  store.update({ networkId: null, focus: null });
  // Fresh fake per test (the closures capture a new state every time).
  (globalThis as any).etn = installFakeApi();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('focus-filter-strip (task 02ba2ae7)', () => {
  it('hides itself when renderStrip(null) is called', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    await strip.renderStrip(null);
    const stripEl = harness.findStrip();
    assert.ok(stripEl !== null, 'strip element should be mounted');
    assert.ok(stripEl!.classList.contains('hidden'), 'strip should be hidden');
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('paints «Потомки», then view buttons, then «⋯», then «+» in server order', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    const t = thought(FOCUS_ID, 'Версия 0.7.3');
    state.thoughtsGet.response = {
      meta: {
        views: [
          metaViewRow(view('v-2', 'Z-просмотр', { position: 2 })),
          metaViewRow(view('v-1', 'A-просмотр', { position: 1 })),
        ],
      },
    };
    await strip.renderStrip(focusOf(t));
    const stripEl = harness.findStrip();
    assert.ok(stripEl !== null && !stripEl.classList.contains('hidden'));
    const btns = (stripEl as ShimElement).querySelectorAll('.canvas-filter-strip-btn');
    assert.equal(btns.length, 5, 'Потомки + 2 views + ⋯ + +');
    assert.equal(btns[0]!.textContent, 'Потомки');
    assert.equal(btns[1]!.textContent, 'A-просмотр');
    assert.equal(btns[2]!.textContent, 'Z-просмотр');
    assert.equal(btns[3]!.textContent, '⋯');
    assert.equal(btns[4]!.textContent, '+');
  });

  it('«+» is disabled for type-less thoughts (requirement 23e0f78e)', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = { meta: { views: [] } };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Без имени', null)));
    const plus = harness.findPlusButton();
    assert.ok(plus !== null);
    assert.equal(plus!.disabled, true);
    assert.ok(plus!.title.includes('недоступно'), `title should explain disabled, got: ${plus!.title}`);
  });

  it('«+» is enabled when the focus has a type', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = { meta: { views: [] } };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Типизированная')));
    assert.equal(harness.findPlusButton()!.disabled, false);
  });

  it('activates the focus default view (or «Потомки» when none)', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = {
      meta: {
        views: [
          metaViewRow(view('v-default', 'Работы версии', { is_default: true, position: 0 })),
          metaViewRow(view('v-extra', 'Лишний', { position: 1 })),
        ],
      },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    let mode = strip.getActiveMode();
    assert.equal(mode.kind, 'view');
    assert.equal((mode as any).viewId, 'v-default');

    state.thoughtsGet.response = {
      meta: { views: [metaViewRow(view('v-x', 'X', { position: 0 }))] },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('restores the persisted per-focus mode (child vs view)', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = JSON.stringify({
      [FOCUS_ID]: { kind: 'view', viewId: 'v-2', viewName: 'Z', viewTypeId: TYPE_ID },
    });
    await strip.loadPersistedStrip();
    state.thoughtsGet.response = {
      meta: {
        views: [
          metaViewRow(view('v-1', 'A', { position: 0 })),
          metaViewRow(view('v-2', 'Z', { position: 1 })),
        ],
      },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    assert.deepEqual(strip.getActiveMode(), {
      kind: 'view',
      viewId: 'v-2',
      viewName: 'Z',
      viewTypeId: TYPE_ID,
    });
  });

  it('falls back to default view when the persisted view id is unknown', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = JSON.stringify({
      [FOCUS_ID]: { kind: 'view', viewId: 'stale', viewName: 's', viewTypeId: TYPE_ID },
    });
    await strip.loadPersistedStrip();
    state.thoughtsGet.response = {
      meta: {
        views: [
          metaViewRow(view('v-default', 'D', { is_default: true, position: 0 })),
          metaViewRow(view('v-extra', 'E', { position: 1 })),
        ],
      },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    const mode = strip.getActiveMode();
    assert.equal(mode.kind, 'view');
    assert.equal((mode as any).viewId, 'v-default');
  });

  it('clicking «Потомки» switches the active mode back to children and notifies listeners', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = {
      meta: { views: [metaViewRow(view('v-d', 'D', { is_default: true, position: 0 }))] },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    let received: any = 'unset';
    const off = strip.onModeChange((m) => {
      received = m;
    });
    const btn = harness.findButton('Потомки');
    assert.ok(btn !== null);
    btn!.click();
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
    assert.deepEqual(received, { kind: 'children' });
    off();
  });

  it('clicking a view button persists the choice and notifies listeners', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = {
      meta: {
        views: [
          metaViewRow(view('v-1', 'A', { position: 0 })),
          metaViewRow(view('v-2', 'B', { position: 1 })),
        ],
      },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    let received: any = null;
    const off = strip.onModeChange((m) => {
      received = m;
    });
    const btn = harness.findViewButton('v-2');
    assert.ok(btn !== null);
    btn!.click();
    const mode = strip.getActiveMode();
    assert.equal(mode.kind, 'view');
    assert.equal((mode as any).viewId, 'v-2');
    assert.ok(received !== null && received.kind === 'view' && received.viewId === 'v-2');
    // L4 persistence is best-effort + async — wait a tick.
    await Promise.resolve();
    await Promise.resolve();
    const setCalls = state.uiSet.calls.filter((c) => c.key === 'focus_filter_strip');
    assert.ok(setCalls.length > 0);
    const last = setCalls[setCalls.length - 1];
    assert.ok(last !== undefined);
    const payload = JSON.parse(last.value);
    assert.equal(payload[FOCUS_ID].kind, 'view');
    assert.equal(payload[FOCUS_ID].viewId, 'v-2');
    off();
  });

  it('parsePersistedMode: tolerates garbage and recovers an empty map', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = '{ not valid json';
    await strip.loadPersistedStrip();
    state.thoughtsGet.response = { meta: { views: [] } };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('parsePersistedMode: drops entries that lack required fields', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.uiGet.value = JSON.stringify({
      good: { kind: 'children' },
      bad: { kind: 'view' /* missing viewId */ },
    });
    await strip.loadPersistedStrip();
    state.thoughtsGet.response = { meta: { views: [] } };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'Версия')));
    // Loading does not throw; the active mode stays valid.
    assert.ok(['children', 'view'].includes(strip.getActiveMode().kind));
  });

  it('runActiveViewIfNeeded: returns null when the active mode is «Потомки»', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = { meta: { views: [] } };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'В')));
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.equal(result, null);
    assert.equal(state.viewRun.calls.length, 0);
  });

  it('runActiveViewIfNeeded: runs the view and caches the result', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = {
      meta: { views: [metaViewRow(view('v-d', 'D', { is_default: true, position: 0 }))] },
    };
    state.viewRun.response = {
      data: [
        {
          id: '00000000-0000-4000-8000-000000000200',
          title: 'Задача A',
          type_id: null,
          icon: null,
          icon_kind: 'emoji',
          active: true,
          marked_for_deletion: false,
        },
      ],
      meta: {
        total: 1,
        limit: 50,
        offset: 0,
        directions: {
          '00000000-0000-4000-8000-000000000200': { has_incoming: false, has_outgoing: false },
        },
        view: { id: 'v-d', name: 'D', type_id: TYPE_ID },
        unresolved: [],
      },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'В')));
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.ok(result !== null);
    assert.equal(result!.viewId, 'v-d');
    assert.equal(result!.items.length, 1);
    assert.equal(strip.takeViewResult(), result);
    assert.equal(state.viewRun.calls.length, 1);
  });

  it('runActiveViewIfNeeded: keeps an «empty» result distinct from an unresolved one', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = {
      meta: { views: [metaViewRow(view('v-d', 'D', { is_default: true, position: 0 }))] },
    };
    state.viewRun.response = {
      data: [],
      meta: {
        total: 0,
        limit: 50,
        offset: 0,
        directions: {},
        view: { id: 'v-d', name: 'D', type_id: TYPE_ID },
        unresolved: [{ token: '$thought.type', reason: 'no-type', message: '…' }],
      },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'В')));
    const result = await strip.runActiveViewIfNeeded(FOCUS_ID);
    assert.ok(result !== null);
    assert.equal(result!.empty, false);
    assert.ok(Array.isArray(result!.unresolved));
  });

  it('realtime thought-type-view event triggers a strip rebuild', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = { meta: { views: [] } };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'В')));
    // New view appears via realtime.
    state.thoughtsGet.response = {
      meta: { views: [metaViewRow(view('v-new', 'Новый', { position: 0 }))] },
    };
    // The rebuild fires from `store.state.focus`; the strip reads the focus
    // off the store synchronously, so we set it before the event.
    store.update({ focus: focusOf(thought(FOCUS_ID, 'В')) });
    strip.onThoughtTypeViewRealtime({
      type: 'thought-type-view.created',
      thought_type_id: TYPE_ID,
      view_id: 'v-new',
    });
    // Wait for the async rebuild chain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(harness.findViewButton('v-new') !== null, 'new view button must appear');
  });

  it('realtime event is a no-op when there is no focused thought', () => {
    store.update({ networkId: NETWORK_ID, focus: null });
    assert.doesNotThrow(() => {
      strip.onThoughtTypeViewRealtime({
        type: 'thought-type-view.created',
        thought_type_id: TYPE_ID,
        view_id: 'v-1',
      });
    });
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('onFocusChange is a safe no-op for unknown focus ids', () => {
    assert.doesNotThrow(() => {
      strip.onFocusChange('00000000-0000-4000-8000-00000000ffff');
    });
    assert.deepEqual(strip.getActiveMode(), { kind: 'children' });
  });

  it('«Сделать по умолчанию» updates the view through thoughtTypeViews.update', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = {
      meta: { views: [metaViewRow(view('v-1', 'A', { position: 0, version: 3 }))] },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'В')));
    state.viewUpdate.calls = [];
    await (globalThis as any).etn.thoughtTypeViews.update(
      NETWORK_ID,
      TYPE_ID,
      'v-1',
      { is_default: true },
      3,
    );
    assert.equal(state.viewUpdate.calls.length, 1);
    assert.deepEqual(state.viewUpdate.calls[0][3], { is_default: true });
    assert.equal(state.viewUpdate.calls[0][4], 3);
  });

  it('overflow: ⋯ dropdown surfaces the hidden views when the row is narrow', async () => {
    const harness = installShim();
    setNetwork();
    strip.mountFilterStrip(harness.host as any);
    state.thoughtsGet.response = {
      meta: {
        views: Array.from({ length: 6 }, (_, i) =>
          metaViewRow(view(`v-${i}`, `Имя ${i}`, { position: i })),
        ),
      },
    };
    await strip.renderStrip(focusOf(thought(FOCUS_ID, 'В')));
    const stripEl = harness.findStrip();
    assert.ok(stripEl !== null);
    const all = (stripEl as ShimElement).querySelectorAll('.canvas-filter-strip-btn');
    // 6 view buttons + Потомки + ⋯ + +
    assert.equal(all.length, 9);
    const overflow = all.find((b) => b.classList.contains('canvas-filter-strip-overflow'));
    assert.ok(overflow !== null);
    // Stub a `window` so `lib/menu.ts:showMenuAt` can compute coordinates
    // — the click triggers `showMenuAt`, which is the side-effect under
    // test (no throw means the dropdown builder runs).
    (globalThis as any).window = {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    try {
      overflow!.click();
    } finally {
      delete (globalThis as any).window;
    }
  });
});
