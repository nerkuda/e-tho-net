/**
 * Regression tests for bug 627a0822 («Ошибка копирования мысли при открытой
 * панели выделенных мыслей»).
 *
 * The global Ctrl+C handler (`app.ts:globalCopy`) used to dispatch to
 * `selection.ts:copySelection()` whenever the selection panel was non-empty,
 * so the shortcut copied the whole panel instead of the thought the user had
 * just clicked — and a later Ctrl+V inside a comment editor pasted references
 * to every panel thought (`markdown-field.ts` maps the whole clipboard
 * snapshot into wiki-links).
 *
 * Contract under test (08-ui-spec.md §4.5.1, §5.3, §13):
 *  - Ctrl+C copies the thought under the canvas cursor frame, or — with no
 *    cursor — the focused thought; never more than one thought;
 *  - the selection panel's contents never influence Ctrl+C; copying the
 *    panel stays available only via the «Скопировать мысли» menu command
 *    (no hotkey).
 *
 * Runs the REAL `globalCopy` under Node with a minimal DOM shim (same
 * technique as renderer-editor-mount.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal element stub that survives the notice() path. */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style: Record<string, string> & {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  } = { setProperty: () => undefined, removeProperty: () => undefined };
  dataset: Record<string, string> = {};
  textContent = '';
  title = '';
  isConnected = true;
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
  append(...nodes: Array<ShimElement | string>): void {
    for (const node of nodes) {
      const el = typeof node === 'string' ? new ShimElement('#text', undefined, node) : node;
      this.children.push(el);
    }
  }
  remove(): void {
    /* no-op */
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  closest(): ShimElement | null {
    return null;
  }
  querySelector(): ShimElement | null {
    return null;
  }
}

/**
 * Minimal `document`/`window` shims. Must run BEFORE the first dynamic
 * import: `lib/etn.ts` captures the `window` object at import time and the
 * renderer modules read `document` when they build notifications.
 */
function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
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
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/** Full `Thought` shape (the snapshot builder reads every field). */
function thought(id: string): any {
  return {
    id,
    title: `Мысль ${id}`,
    type_id: null,
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

/** Wires the `window.etn` stub; records every `thoughts.get` id. */
function stubEtn(): { fetched: string[] } {
  const fetched: string[] = [];
  const win = (globalThis as any).window;
  win.etn = {
    thoughts: {
      get: async (_networkId: string, id: string) => {
        fetched.push(id);
        return thought(id);
      },
      resolve: async (_networkId: string, ids: string[]) => ids.map((id) => thought(id)),
    },
    comments: { list: async () => [] },
    properties: { get: async () => [] },
    attachments: { list: async () => [] },
    links: { listByThought: async () => null },
    types: { listTypeProperties: async () => [] },
  };
  return { fetched };
}

describe('globalCopy (Ctrl+C) ignores the selection panel — bug 627a0822', () => {
  it('copies the clicked cursor thought, not the panel contents', async () => {
    shimDom();
    const { fetched } = stubEtn();
    const { appInternals } = await import('../src/renderer/app.js');
    const { setCursor } = await import('../src/renderer/canvas/kbd-nav.js');
    const { getClipboard, setClipboard } = await import('../src/renderer/canvas/clipboard.js');
    const { store } = await import('../src/renderer/state.js');

    // Reproduction setup from the bug report: the panel holds several
    // thoughts, the user clicks a non-selected thought on the map.
    store.update({
      networkId: 'n1',
      selection: ['s1', 's2', 's3'],
      focus: { focused: thought('f1') },
    } as any);
    setCursor('clicked');
    setClipboard(null);
    try {
      await appInternals.globalCopy();

      const snap = getClipboard();
      assert.ok(snap !== null, 'a snapshot must be created');
      assert.equal(snap.thoughts.length, 1, 'exactly one thought must be copied');
      const sourceId = (snap.thoughts[0] as any).source_id;
      assert.equal(sourceId, 'clicked', 'the copied thought is the clicked one');
      // The panel thoughts must never be fetched, not even to resolve them.
      assert.ok(
        fetched.every((id) => id === 'clicked'),
        `only the clicked thought may be fetched, got: ${JSON.stringify(fetched)}`,
      );
    } finally {
      setCursor(null);
      setClipboard(null);
      store.update({ selection: [], focus: null } as any);
    }
  });

  it('falls back to the focused thought when no cursor is active', async () => {
    shimDom();
    const { fetched } = stubEtn();
    const { appInternals } = await import('../src/renderer/app.js');
    const { setCursor } = await import('../src/renderer/canvas/kbd-nav.js');
    const { getClipboard, setClipboard } = await import('../src/renderer/canvas/clipboard.js');
    const { store } = await import('../src/renderer/state.js');

    store.update({
      networkId: 'n1',
      selection: ['s1', 's2'],
      focus: { focused: thought('f1') },
    } as any);
    setCursor(null);
    setClipboard(null);
    try {
      await appInternals.globalCopy();

      const snap = getClipboard();
      assert.ok(snap !== null, 'a snapshot must be created');
      assert.equal(snap.thoughts.length, 1, 'exactly one thought must be copied');
      assert.equal((snap.thoughts[0] as any).source_id, 'f1');
      assert.ok(
        fetched.every((id) => id === 'f1'),
        `only the focused thought may be fetched, got: ${JSON.stringify(fetched)}`,
      );
    } finally {
      setClipboard(null);
      store.update({ selection: [], focus: null } as any);
    }
  });

  it('with no cursor and no focus it reports an error and leaves the clipboard empty', async () => {
    shimDom();
    const { fetched } = stubEtn();
    const { appInternals } = await import('../src/renderer/app.js');
    const { setCursor } = await import('../src/renderer/canvas/kbd-nav.js');
    const { getClipboard, setClipboard } = await import('../src/renderer/canvas/clipboard.js');
    const { store } = await import('../src/renderer/state.js');

    // A non-empty panel must NOT become the fallback source for Ctrl+C —
    // before the fix this exact setup copied the panel's thoughts.
    store.update({ networkId: 'n1', selection: ['s1', 's2', 's3'], focus: null } as any);
    setCursor(null);
    setClipboard(null);
    try {
      await appInternals.globalCopy();

      assert.equal(getClipboard(), null, 'nothing must land in the clipboard');
      assert.deepEqual(fetched, [], 'no thought may be fetched');
    } finally {
      store.update({ selection: [], focus: null } as any);
    }
  });
});
