/**
 * Regression test for task 90b2256e «Инкрементальная смена сущности в
 * редакторе»: opening ANOTHER thought of the same kind must reuse the editor
 * skeleton (tab bar, its buttons, pane host) and rebuild only the header and
 * the tab CONTENT; the loading→loaded transition must build the skeleton
 * exactly once; a focused header field must get its focus back.
 *
 * Runs the REAL `mountEditor` under Node with a DOM shim (mirrors
 * `renderer-type-change-panes.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function shimDom(): void {
  // `instanceof HTMLElement` guards the focus logic — make the shim element the
  // HTMLElement so a focused field is actually recognised (product code).
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = class {
    detail: unknown;
    constructor(_type: string, init?: { detail?: unknown }) {
      this.detail = init?.detail;
    }
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  const docElementStyle = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: docElementStyle },
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

/** Minimal but complete `window.etn` mock (async chains must not reject). */
function installEtn(): void {
  const win = (globalThis as any).window as Record<string, unknown>;
  win.etn = {
    ui: { getState: async () => 'main', setState: async () => undefined },
    comments: { list: async () => [], create: async () => undefined },
    attachments: { list: async () => [] },
    thoughts: { get: async () => ({}) },
    properties: { get: async () => [] },
    types: { listTypeProperties: async () => [] },
  };
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
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
    ...overrides,
  };
}

function makeType(id: string, overrides: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id,
    name: id,
    parent_id: null,
    is_root: false,
    comment_template_md: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

function makeFocus(focused: Thought): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Waits for the editor's own async chains (render, tab pane builds). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('инкрементальная смена сущности в редакторе (90b2256e)', () => {
  it('смена мысли того же вида сохраняет каркас и обновляет шапку', async () => {
    shimDom();
    installEtn();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    const scrollBox = host.children[1]!;
    const tabBar = scrollBox.querySelector('.editor-tabs')!;
    const firstTab = tabBar.querySelectorAll('.editor-tab')[0]!;
    assert.equal(scrollBox.querySelector('.editor-title-input')!.value, 'A');
    const skeletons = editorInternals.skeletonBuildCount();

    // Open ANOTHER thought of the same kind.
    store.update({
      focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })),
    } as any);
    await flush();

    assert.equal(host.children[1], scrollBox, 'scrollBox переиспользован');
    assert.equal(scrollBox.querySelector('.editor-tabs'), tabBar, 'полоса вкладок — тот же узел');
    assert.equal(
      tabBar.querySelectorAll('.editor-tab')[0],
      firstTab,
      'кнопки вкладок — те же узлы (каркас не пересобран)',
    );
    assert.equal(
      scrollBox.querySelector('.editor-title-input')!.value,
      'B',
      'шапка обновлена на новую мысль',
    );
    assert.equal(
      editorInternals.skeletonBuildCount(),
      skeletons,
      'смена сущности не собирает каркас повторно',
    );
  });

  it('loading→loaded строит каркас ровно один раз', async () => {
    shimDom();
    installEtn();
    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: null,
      structuresActiveThought: null,
      editorTarget: { kind: 'thought', id: 't9' },
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    const before = editorInternals.skeletonBuildCount();
    mountEditor(host as any);
    await flush();

    assert.equal(
      editorInternals.skeletonBuildCount(),
      before + 1,
      'загрузочный каркас собран один раз',
    );
    const scrollBox = host.children[1]!;
    const tabBar = scrollBox.querySelector('.editor-tabs')!;
    assert.ok(scrollBox.querySelector('.editor-icon-loading') !== null, 'в шапке прелоадер');

    // The entity arrives.
    const loaded = makeThought({ id: 't9', title: 'T9', type_id: 'ta' });
    store.update({
      editorTarget: { kind: 'thought', id: 't9', thought: loaded },
      structuresActiveThought: loaded,
    } as any);
    await flush();

    assert.equal(
      editorInternals.skeletonBuildCount(),
      before + 1,
      'приход сущности НЕ пересобирает каркас',
    );
    assert.equal(scrollBox.querySelector('.editor-tabs'), tabBar, 'полоса вкладок сохранена');
    assert.equal(
      scrollBox.querySelector('.editor-icon-loading'),
      null,
      'прелоадер заменён реальной шапкой',
    );
    assert.equal(scrollBox.querySelector('.editor-title-input')!.value, 'T9');
  });

  it('фокус поля заголовка возвращается после смены мысли', async () => {
    shimDom();
    installEtn();
    const { mountEditor } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ id: 't1', title: 'A', type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    const host = new ShimElement('div');
    mountEditor(host as any);
    await flush();

    const scrollBox = host.children[1]!;
    const titleA = scrollBox.querySelector('.editor-title-input')!;
    (globalThis as any).document.activeElement = titleA;

    store.update({
      focus: makeFocus(makeThought({ id: 't2', title: 'B', type_id: 'ta' })),
    } as any);
    await flush();

    const titleB = scrollBox.querySelector('.editor-title-input')!;
    assert.notEqual(titleB, titleA, 'шапка пересобрана на новое поле');
    assert.equal(titleB.focused, true, 'фокус перенесён на поле заголовка новой мысли');
  });
});
