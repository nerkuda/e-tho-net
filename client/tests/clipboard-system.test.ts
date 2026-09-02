/**
 * Regression tests for bug 290a50c0 («Не работает вставка текста,
 * скопированного из другой программы»).
 *
 * The internal thought clipboard used to survive a system-clipboard
 * overwrite done in another program: a Ctrl+V inside a comment editor kept
 * pasting the stale snapshot's wiki-links because nothing invalidated it
 * (initNativeCopyTracking only sees copy/cut events inside our window).
 *
 * Contract under test (08-ui-spec.md §4.5.1, §4.5.5, §4.5.7):
 *  - every thought copy mirrors wiki-links into the SYSTEM clipboard
 *    (`[[#<id>]]`, comma-separated) and remembers the mirrored string;
 *  - a paste into a comment editor inserts the wiki-links ONLY while the
 *    system clipboard still holds that string — after another program
 *    overwrites the buffer, the paste must fall through to the editor's
 *    native text paste (handler returns `false`);
 *  - the multi-thought snapshot («Скопировать мысли» panel command) is
 *    mirrored the same way and never lost;
 *  - the canvas-paste staleness check (`systemClipboardHasThoughts`)
 *    flips to `false` once the buffer is overwritten.
 *
 * Uses the same DOM-shim technique as copy-hotkey.test.ts (markdown-field
 * pulls in the renderer module graph, which reads `window`/`document` at
 * import time). The system clipboard is a stub on `globalThis.navigator`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET_A = '11111111-2222-3333-4444-555555555555';
const NET_B = '66666666-7777-8888-9999-000000000000';
const T1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T2 = 'abcdef01-2345-6789-abcd-ef0123456789';

/** In-memory stand-in for `navigator.clipboard`. */
class FakeSystemClipboard {
  text = '';
  written: string[] = [];
  failWrite = false;
  failRead = false;
  async writeText(text: string): Promise<void> {
    if (this.failWrite) throw new Error('write denied');
    this.text = text;
    this.written.push(text);
  }
  async readText(): Promise<string> {
    if (this.failRead) throw new Error('read denied');
    return this.text;
  }
}

/** Installs the fake as `navigator.clipboard` and returns it. */
function stubSystemClipboard(): FakeSystemClipboard {
  const fake = new FakeSystemClipboard();
  (globalThis.navigator as unknown as { clipboard: unknown }).clipboard = fake;
  return fake;
}

/** Minimal element stub (same technique as copy-hotkey.test.ts). */
class ShimElement {
  tagName: string;
  className = '';
  children: ShimElement[] = [];
  style: {
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

/** Minimal `document`/`window` shims — must run before the first import. */
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

/** A full `ThoughtLike` row the snapshot builder reads. */
function like(id: string): any {
  return {
    id,
    title: `Мысль ${id}`,
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
  };
}

/** All-network SnapshotDeps stub: no comments/props/attachments/links. */
function deps(networkId: string): any {
  return {
    sourceNetworkId: networkId,
    getThought: async () => null,
    getPermanentComment: async () => null,
    getProperties: async () => ({}),
    getAttachments: async () => [],
    getLinksForThought: async () => [],
    getThoughtTypeName: () => null,
    getLinkTypeNames: () => null,
  };
}

/** A ClipboardEvent stub carrying `text` as its plain-text payload. */
function pasteEvent(text: string, fileCount = 0): ClipboardEvent {
  return {
    clipboardData: {
      files: { length: fileCount },
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
    preventDefault: () => undefined,
  } as unknown as ClipboardEvent;
}

/** An MdEditor stub recording everything inserted at the caret. */
function fakeEditor(): { editor: any; inserted: string[] } {
  const inserted: string[] = [];
  return {
    inserted,
    editor: {
      dom: new ShimElement('div'),
      insertAtCaret: (text: string) => {
        inserted.push(text);
      },
    },
  };
}

/** Loads the modules under test (DOM shim first) — memoised per file. */
let modules: Promise<any> | null = null;
function load(): Promise<any> {
  modules ??= (async () => {
    shimDom();
    stubSystemClipboard();
    const clipboard = await import('../src/renderer/canvas/clipboard.js');
    const markdownField = await import('../src/renderer/editor/markdown-field.js');
    const { store } = await import('../src/renderer/state.js');
    return { clipboard, markdownField, store };
  })();
  return modules;
}

/** Resets both clipboards (internal + fake system) between scenarios. */
function reset(fake: FakeSystemClipboard): void {
  const { clipboard, store } = modulesCache;
  clipboard.setClipboard(null);
  fake.text = '';
  fake.written = [];
  fake.failWrite = false;
  fake.failRead = false;
  store.update({ networkId: NET_A } as any);
}

/** Sync access to the loaded modules (populated by `load()`). */
const modulesCache: any = {};

describe('thought copy mirrors wiki-links into the system clipboard (290a50c0)', () => {
  it('single copy (Ctrl+C) writes the thought wiki-link', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard } = modulesCache;

    await clipboard.buildSingleThoughtSnapshot(like(T1), deps(NET_A));

    assert.deepEqual(fake.written, [`[[#${T1}]]`], 'the system buffer must carry the wiki-link');
    assert.equal(clipboard.getClipboard()?.thoughts.length, 1);
    assert.ok(clipboard.systemClipboardMatchesText(fake.text));
  });

  it('multi copy («Скопировать мысли») writes all links and keeps the snapshot', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard } = modulesCache;

    await clipboard.buildMultiThoughtSnapshot([like(T1), like(T2)], deps(NET_A));

    assert.deepEqual(
      fake.written,
      [`[[#${T1}]], [[#${T2}]]`],
      'both links must land in the system buffer',
    );
    const snap = clipboard.getClipboard();
    assert.ok(snap !== null, 'the group snapshot must not be lost');
    assert.equal(snap.thoughts.length, 2);
    assert.ok(clipboard.systemClipboardMatchesText(fake.text));
  });

  it('systemClipboardHasThoughts flips to false after another program overwrites the buffer', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard } = modulesCache;

    await clipboard.buildSingleThoughtSnapshot(like(T1), deps(NET_A));
    assert.equal(
      await clipboard.systemClipboardHasThoughts(),
      true,
      'right after the copy the snapshot is valid',
    );

    // The user copies different text in another program.
    fake.text = 'Текст из другой программы';
    assert.equal(
      await clipboard.systemClipboardHasThoughts(),
      false,
      'an overwritten system buffer must invalidate the snapshot',
    );
  });
});

describe('paste into a comment editor (290a50c0)', () => {
  it('(б) right after copying a thought, Ctrl+V inserts wiki-links', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard, markdownField, store } = modulesCache;
    store.update({ networkId: NET_A } as any);

    await clipboard.buildSingleThoughtSnapshot(like(T1), deps(NET_A));
    const { editor, inserted } = fakeEditor();
    const consumed = markdownField.mdFieldInternals.handleClipboardThoughtsPaste(
      pasteEvent(fake.text),
      editor,
    );

    assert.equal(consumed, true, 'the handler must consume the paste');
    assert.deepEqual(inserted, [`[[#${T1}]]`]);
  });

  it('(б-кросс) the same paste in another network rewrites the links', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard, markdownField, store } = modulesCache;

    await clipboard.buildSingleThoughtSnapshot(like(T1), deps(NET_A));
    store.update({ networkId: NET_B } as any);
    const { editor, inserted } = fakeEditor();
    const consumed = markdownField.mdFieldInternals.handleClipboardThoughtsPaste(
      pasteEvent(fake.text),
      editor,
    );

    assert.equal(consumed, true);
    assert.deepEqual(inserted, [`[[n:${NET_A}#${T1}]]`], 'cross-network links get the prefix');
  });

  it('(а) after another program overwrites the buffer, the paste falls through to native text', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard, markdownField, store } = modulesCache;
    store.update({ networkId: NET_A } as any);

    await clipboard.buildSingleThoughtSnapshot(like(T1), deps(NET_A));
    // Reproduction from the bug report: the user copies text elsewhere.
    fake.text = 'Свежий текст из другой программы';
    const { editor, inserted } = fakeEditor();
    const consumed = markdownField.mdFieldInternals.handleClipboardThoughtsPaste(
      pasteEvent(fake.text),
      editor,
    );

    assert.equal(consumed, false, 'the handler must NOT consume the paste');
    assert.deepEqual(inserted, [], 'no wiki-links may be inserted');
  });

  it('(в) the group snapshot still pastes all links while the buffer is intact', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard, markdownField, store } = modulesCache;
    store.update({ networkId: NET_A } as any);

    await clipboard.buildMultiThoughtSnapshot([like(T1), like(T2)], deps(NET_A));
    const { editor, inserted } = fakeEditor();
    const consumed = markdownField.mdFieldInternals.handleClipboardThoughtsPaste(
      pasteEvent(fake.text),
      editor,
    );

    assert.equal(consumed, true);
    assert.deepEqual(inserted, [`[[#${T1}]], [[#${T2}]]`]);

    // …and stops doing so once the buffer is overwritten by foreign text.
    fake.text = 'другой текст';
    const second = fakeEditor();
    const consumed2 = markdownField.mdFieldInternals.handleClipboardThoughtsPaste(
      pasteEvent(fake.text),
      second.editor,
    );
    assert.equal(consumed2, false);
    assert.deepEqual(second.inserted, []);
  });

  it('a file payload (screenshot) outranks the thought links', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard, markdownField, store } = modulesCache;
    store.update({ networkId: NET_A } as any);

    await clipboard.buildSingleThoughtSnapshot(like(T1), deps(NET_A));
    const { editor, inserted } = fakeEditor();
    const consumed = markdownField.mdFieldInternals.handleClipboardThoughtsPaste(
      pasteEvent(fake.text, 1),
      editor,
    );

    assert.equal(consumed, false, 'the file path (attachments) must take over');
    assert.deepEqual(inserted, []);
  });

  it('an empty internal clipboard never intercepts a paste', async () => {
    Object.assign(modulesCache, await load());
    const fake = stubSystemClipboard();
    reset(fake);
    const { clipboard, markdownField, store } = modulesCache;
    store.update({ networkId: NET_A } as any);

    // Buffer holds ETN-shaped links (e.g. copied long ago, app reloaded).
    fake.text = `[[#${T1}]]`;
    const { editor, inserted } = fakeEditor();
    const consumed = markdownField.mdFieldInternals.handleClipboardThoughtsPaste(
      pasteEvent(fake.text),
      editor,
    );

    assert.equal(consumed, false);
    assert.deepEqual(inserted, []);
    assert.equal(clipboard.getClipboard(), null);
  });
});

describe('looksLikeEtnWikiLinks heuristics', () => {
  it('accepts single links and comma-separated lists', async () => {
    Object.assign(modulesCache, await load());
    const { clipboard } = modulesCache;
    assert.ok(clipboard.looksLikeEtnWikiLinks(`[[#${T1}]]`));
    assert.ok(clipboard.looksLikeEtnWikiLinks(`[[#${T1}]], [[n:${NET_B}#${T2}]]`));
    assert.ok(clipboard.looksLikeEtnWikiLinks(`  [[#${T1}]] , [[#${T2}]]  `));
  });

  it('rejects plain text, partial links and name links', async () => {
    Object.assign(modulesCache, await load());
    const { clipboard } = modulesCache;
    assert.ok(!clipboard.looksLikeEtnWikiLinks('Обычный текст'));
    assert.ok(!clipboard.looksLikeEtnWikiLinks(`[[${T1}]]`), 'no # — legacy name link');
    assert.ok(!clipboard.looksLikeEtnWikiLinks(`[[#abc]]`), 'not a UUID');
    assert.ok(!clipboard.looksLikeEtnWikiLinks(''));
    assert.ok(!clipboard.looksLikeEtnWikiLinks(`[[#${T1}]], примечание`));
  });
});
