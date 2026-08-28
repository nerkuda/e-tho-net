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
  /** The real style is a CSSStyleDeclaration; the mount path only writes
   *  custom properties (`--clamp-*`, list-heights.ts) — stub those two. */
  style: Record<string, string> & {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  } = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
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
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      // The real DOM accepts strings in append() (text nodes) — the editor
      // panel title appends its text next to the trash marker (S13).
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      el.parent = this;
      this.children.push(el);
    }
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

/**
 * Minimal `document`/`window` shims (CodeMirror probing handled upstream).
 *
 * `../lib/etn.js` captures `window` in a module-level `liveTarget` on its
 * *first* import (to survive the Vite dev-mode preload race) and never
 * re-reads the `window` global afterwards — only `liveTarget.etn`'s own
 * properties are re-read on every access. Since this whole test file shares
 * one module cache, `etn.ts` is imported once, during the very first
 * `shimDom()` call. Replacing `globalThis.window` with a brand-new object on
 * later calls (as this used to do) would silently orphan that first object —
 * any `window.etn.thoughts` a later test adds would never be seen by the
 * already-imported `etn` proxy. Mutating the same window object in place
 * (falling back to a fresh one only when none exists yet) keeps `liveTarget`
 * valid for every test in the file.
 */
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

/**
 * Regression test for "editor jerks on a repeat click of the same thought"
 * (5b8319bc-c9e5-4409-b7eb-df4132806b19).
 *
 * `openThoughtInEditor` used to unconditionally overwrite `editorTarget` on
 * every call, even when the click landed on the thought already shown in the
 * editor. Re-assigning `{ kind: 'thought', id }` drops the already-loaded
 * `thought` payload, which changes `render()`'s signature (it reads
 * `ctx.thought?.version`) and forces a full DOM rebuild with stale/fallback
 * content; the redundant `etn.thoughts.get` refetch then resolves and forces
 * a *second* rebuild once the entity comes back — two visible re-renders for
 * a click that changed nothing. A repeat click on the thought already
 * targeted (loaded or still in flight) must now be a no-op: same object
 * reference, no extra store notification, no extra fetch.
 */
/**
 * Minimal but *complete* `Thought` shape — a lingering `store.subscribe`
 * callback from the `mountEditor` test above (module-level state shared
 * across this file's `describe` blocks) fires a real, full `render()` on
 * every `store.update`, which reaches `buildThoughtHeader` and reads every
 * field below; a partial mock throws asynchronously after the test ends.
 */
const mockThought = {
  id: 't1',
  title: 'T1',
  type_id: null,
  icon: null,
  icon_kind: 'emoji',
  icon_attachment_id: null,
  active: true,
  is_protected: false,
  is_root: false,
  marked_for_deletion: false,
  fg_color: null,
  bg_color: null,
  font_bold: null,
  font_italic: null,
  font_underline: null,
  font_strike: null,
  synonyms: [],
  version: 1,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

describe('openThoughtInEditor — repeat click on the same thought', () => {
  it('is a no-op while the first fetch is still in flight', async () => {
    shimDom();
    let fetchCount = 0;
    (globalThis as any).window.etn.thoughts = {
      get: async () => {
        fetchCount++;
        return { ...mockThought };
      },
    };
    const { openThoughtInEditor } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: 'n1', focus: null, editorTarget: null, selectedLinkId: null } as any);

    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount++;
    });

    openThoughtInEditor('t1');
    const targetAfterFirstClick = store.state.editorTarget;
    assert.deepEqual(targetAfterFirstClick, { kind: 'thought', id: 't1' });
    const notifyAfterFirstClick = notifyCount;

    // Repeat click on the same (still loading) thought.
    openThoughtInEditor('t1');
    assert.strictEqual(
      store.state.editorTarget,
      targetAfterFirstClick,
      'target object reference must not change on a repeat click',
    );
    assert.equal(notifyCount, notifyAfterFirstClick, 'the store must not be notified again');
    assert.equal(fetchCount, 1, 'the second click must not trigger another fetch');
  });

  it('is a no-op once the thought has already loaded', async () => {
    shimDom();
    (globalThis as any).window.etn.thoughts = {
      get: async () => ({ ...mockThought }),
    };
    const { openThoughtInEditor } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: 'n1', focus: null, editorTarget: null, selectedLinkId: null } as any);

    openThoughtInEditor('t1');
    // Flush the fetch's microtask chain (`.get(...)` then `.then(...)`).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const loadedTarget = store.state.editorTarget as any;
    assert.equal(loadedTarget?.thought?.version, 1, 'precondition: the thought must have loaded');

    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount++;
    });

    openThoughtInEditor('t1');
    assert.strictEqual(
      store.state.editorTarget,
      loadedTarget,
      'a loaded target must survive a repeat click unchanged',
    );
    assert.equal(
      notifyCount,
      0,
      'a repeat click on an already-loaded thought must not notify the store',
    );
  });
});

/**
 * Regression test for the "editor shaking" bug (renaming a thought via Tab).
 *
 * `blur` on the synonyms field used to call `saveThought` unconditionally. A
 * successful title save bumps the entity version and forces a full editor
 * rebuild, which removes the still-focused-but-untouched synonyms input —
 * removing a focused element fires a native `blur` on it — which used to
 * re-save synonyms (a no-op write that still bumps the version), forcing yet
 * another rebuild/blur/save, looping. This exercises the pure guard that now
 * short-circuits an unchanged synonyms field (`editor.ts`'s
 * `parseSynonymsField` + `synonymsEqual`, used by `commitSynonyms`).
 */
describe('editor synonyms field — unchanged-value guard', () => {
  it('treats a re-serialised, untouched value as unchanged (no save)', async () => {
    shimDom();
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const original = ['синоним 1', 'синоним 2'];
    // What the input shows: `thought.synonyms.join(', ')` — parsing it back
    // must round-trip to the same list, so a forced blur triggers no save.
    const raw = original.join(', ');
    const parsed = editorInternals.parseSynonymsField(raw);
    assert.deepEqual(parsed, original);
    assert.equal(
      editorInternals.synonymsEqual(parsed, original),
      true,
      'round-tripped value must compare equal — the blur-on-rebuild guard depends on this',
    );
  });

  it('still detects a real edit as changed (save must proceed)', async () => {
    shimDom();
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const original = ['синоним 1'];
    const parsed = editorInternals.parseSynonymsField('синоним 1, синоним 2');
    assert.equal(editorInternals.synonymsEqual(parsed, original), false);
  });

  it('collapses blank/whitespace-only entries the same way on both sides', async () => {
    shimDom();
    const { editorInternals } = await import('../src/renderer/editor/editor.js');
    const original: string[] = [];
    const parsed = editorInternals.parseSynonymsField('  ,  ,');
    assert.deepEqual(parsed, original);
    assert.equal(editorInternals.synonymsEqual(parsed, original), true);
  });
});
