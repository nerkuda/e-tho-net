/**
 * Тесты цели `publication` панели редактора (0.11.1, задача a3cfc018; ADR
 * eb687eea, элемент интерфейса c3e44cab). Проверяют, что третий вариант
 * `EditorTarget` принимается общим состоянием, а панель редактора НЕ строит
 * для него контекст мысли/связи — карточку рисует отдельный модуль
 * `editor/publication-card.ts` (сторож `guard-publications-ui` следит, что
 * импортирует его только `editor/editor.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { store, type EditorTarget } from '../src/renderer/state.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  win.etn = { ui: { setState: async () => undefined, getState: async () => null } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

async function editorModule(): Promise<typeof import('../src/renderer/editor/editor.js')> {
  return import('../src/renderer/editor/editor.js');
}

describe('цель publication панели редактора (ADR eb687eea)', () => {
  it('EditorTarget принимает третий вариант, а контекст панели для него пуст', async () => {
    shimDom();
    const { currentEditorContext } = await editorModule();
    const target: EditorTarget = { kind: 'publication', id: 'pub-1' };
    store.update({ editorTarget: target, focus: null });
    assert.equal(
      currentEditorContext(),
      null,
      'публикацию рисует publication-card.ts, обычный контекст не строится',
    );
  });

  it('мысль и связь остаются обычным контекстом панели', async () => {
    shimDom();
    const { currentEditorContext } = await editorModule();
    store.update({
      editorTarget: { kind: 'thought', id: 't-1', thought: { id: 't-1' } as never },
      focus: null,
    });
    assert.equal(currentEditorContext()?.ownerType, 'thought');
    store.update({
      editorTarget: { kind: 'link', id: 'l-1', link: { id: 'l-1' } as never },
      focus: null,
    });
    assert.equal(currentEditorContext()?.ownerType, 'link');
  });
});
