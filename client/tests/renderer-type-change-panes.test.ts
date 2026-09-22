/**
 * Regression test for ETN error 786bcd69 «Смена типа мысли не обновляет
 * облачка и набор свойств» — половина редактора: после смены типа вкладка
 * «Свойства» обязана перечитаться (набор свойств нового типа), а не остаться
 * с таблицей прежнего типа.
 *
 * Причина: `buildTabPane` кэширует вкладки на время показа сущности, а
 * инвалидация при смене типа (bug 6b757336) сбрасывала только «Комментарий»
 * (`main`). Свойства переехали в отдельную вкладку `properties` (задача
 * 8ab775d9) уже после того исправления, поэтому прежний набор свойств
 * оставался на экране до смены сущности/перезапуска.
 *
 * Runs the REAL `mountEditor`/`saveThought` under Node with a DOM shim
 * (mirrors `renderer-editor-mount.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function shimDom(): void {
  (globalThis as any).HTMLElement = class {};
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

describe('смена типа мысли — вкладка «Свойства» перечитывает набор (786bcd69)', () => {
  it('после смены типа вкладка «Свойства» строится заново под новый тип', async () => {
    shimDom();
    /** Какие типы запрашивал редактор за определениями свойств. */
    const typePropertyQueries: string[] = [];
    let updateCalls = 0;
    (globalThis as any).window.etn = {
      ui: {
        setState: async () => undefined,
        // The user sits on the «Свойства» tab — the pane is shown, so the
        // type change must rebuild it immediately, without a tab switch.
        getState: async () => 'properties',
      },
      types: {
        listTypeProperties: async (_n: string, _owner: string, typeId: string) => {
          typePropertyQueries.push(typeId);
          return [];
        },
      },
      properties: { get: async () => [] },
      comments: { list: async () => [], create: async () => undefined },
      thoughts: {
        get: async () => makeThought({ type_id: 'ta' }),
        focus: async () => null,
        update: async () => {
          updateCalls++;
          return makeThought({ type_id: 'tb', version: 2 });
        },
      },
    };

    const { mountEditor, editorInternals } = await import('../src/renderer/editor/editor.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({
      networkId: 'n1',
      focus: makeFocus(makeThought({ type_id: 'ta' })),
      thoughtTypes: [makeType('root', { is_root: true }), makeType('ta'), makeType('tb')],
      editorTarget: null,
      collapsedGroups: {},
    } as any);

    mountEditor(new ShimElement('div') as any);
    await flush();

    const propertiesBuildsBefore = editorInternals.paneBuildCount('properties');
    const otherTabBuildsBefore = {
      main: editorInternals.paneBuildCount('main'),
      attachments: editorInternals.paneBuildCount('attachments'),
      chrono: editorInternals.paneBuildCount('chrono'),
      graph: editorInternals.paneBuildCount('graph'),
      metadata: editorInternals.paneBuildCount('metadata'),
    };
    const queriesBefore = typePropertyQueries.length;

    // Precondition: the shown «Свойства» pane was built against the OLD type.
    assert.equal(propertiesBuildsBefore, 1, 'вкладка «Свойства» показана и построена при монтировании');
    assert.deepEqual(typePropertyQueries, ['ta'], 'набор свойств строился по прежнему типу');

    const ok = await editorInternals.saveThought({ type_id: 'tb' });
    await flush();

    assert.equal(ok, true, 'сохранение типа должно пройти успешно');
    assert.equal(updateCalls, 1);
    assert.equal(
      editorInternals.paneBuildCount('properties'),
      propertiesBuildsBefore + 1,
      'вкладка «Свойства» обязана перечитаться при смене типа',
    );
    assert.deepEqual(
      typePropertyQueries.slice(queriesBefore),
      ['tb'],
      'набор свойств обязан запрашиваться по НОВОМУ типу',
    );
    // Type-independent tabs keep their cache (and their CodeMirror instances).
    assert.equal(editorInternals.paneBuildCount('main'), otherTabBuildsBefore.main);
    assert.equal(editorInternals.paneBuildCount('attachments'), otherTabBuildsBefore.attachments);
    assert.equal(editorInternals.paneBuildCount('chrono'), otherTabBuildsBefore.chrono);
    assert.equal(editorInternals.paneBuildCount('graph'), otherTabBuildsBefore.graph);
    assert.equal(editorInternals.paneBuildCount('metadata'), otherTabBuildsBefore.metadata);
  });
});
