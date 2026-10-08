/**
 * Тесты выделения блока трансклюзии Shift+кликом и удаления блока (0.12.1,
 * ТП `fcde7c55`, задача `c11b82ee`, решение пользователя 2026-10-08).
 *
 * Проверяют:
 * 1. `transclusionBlockRemoval` — диапазон удаления ссылки по началу блока;
 * 2. Shift+клик по блоку выделяет его ЦЕЛИКОМ (атомарный диапазон), в блок НЕ
 *    входит; обычный клик — вход кареткой, как раньше;
 * 3. Delete на выделении удаляет ссылку одной транзакцией;
 * 4. поповер чипа несёт команду «Удалить блок» (удаление ссылки одной
 *    транзакцией через `transclusionBlockRemoval`, без подтверждения).
 *
 * Headless: реальный CM в DOM-шиме не поднимается, вложенные инстансы —
 * дублёр (`NestedViewFactory`), сеть — заглушка `globalThis.etn`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { parseTransclusions } from '@etn/markdown';

import { ShimElement } from './dom-shim.js';
import { mdEditorExtensions } from '../src/renderer/editor/md-editor.js';
import {
  NestedEditorStore,
  blockEditorStoreFacet,
  type NestedViewFactory,
} from '../src/renderer/editor/transclusion-nested.js';
import {
  TRANSCLUSION_BLOCK_CLASS,
  blockEditorKey,
  transclusionBlockRemoval,
  transclusionExtensions,
  transclusionMouseDown,
  transclusionState,
} from '../src/renderer/editor/transclusion.js';
import { __resetForTests } from '../src/renderer/lib/lock-cache.js';

const ID_A = '8e0d670e-de61-4da7-b13e-9232cd1c6ca5';
const NET = 'c4f9a3b2-1111-2222-3333-444455556666';
const BLOCK_RAW = `![[#${ID_A}]]`;

/** Дублёр вложенного инстанса: EditorState + фокус. */
class FakeNestedView {
  state: EditorState;
  focused = false;
  constructor(doc: string, extensions: Extension[]) {
    this.state = EditorState.create({ doc, extensions });
  }
  dispatch(spec: unknown): void {
    this.state = this.state.update(spec as never).state;
  }
  focus(): void {
    this.focused = true;
  }
}

function fakeFactory(registry: Map<string, FakeNestedView>): NestedViewFactory {
  return (params) => {
    const v = new FakeNestedView(params.initialText, params.extensions);
    registry.set(params.key, v);
    return { view: v as unknown as EditorView, dom: new ShimElement('div') as unknown as HTMLElement };
  };
}

interface FakeView {
  state: EditorState;
  dispatch(spec: unknown): void;
  focus(): void;
  readonly dom: ShimElement;
}

function makeView(initial: EditorState): FakeView {
  const dom = new ShimElement('div');
  const view: FakeView = {
    state: initial,
    dom,
    dispatch(spec: unknown): void {
      view.state = view.state.update(spec as never).state;
    },
    focus(): void {},
  };
  return view;
}

function withStore(doc: string, store: NestedEditorStore): EditorState {
  return EditorState.create({
    doc,
    extensions: [...transclusionExtensions, blockEditorStoreFacet.of(store)],
  });
}

/** Клик по блоку: элемент с dataset и closest. */
function blockElement(ref: { start: number; end: number }): ShimElement {
  const el = new ShimElement('div');
  el.className = TRANSCLUSION_BLOCK_CLASS;
  el.dataset['mdFrom'] = String(ref.start);
  el.dataset['mdTo'] = String(ref.end);
  el.dataset['transclusionSource'] = ID_A;
  (el as unknown as { closest: (s: string) => ShimElement | null }).closest = (s) =>
    s.includes(TRANSCLUSION_BLOCK_CLASS) ? el : null;
  return el;
}

function stubEtn(body: string): void {
  (globalThis as unknown as { etn: unknown }).etn = {
    thoughts: {
      resolve: async (_n: string, ids: string[]) => ids.map((id) => ({ id, title: 'Источник' })),
    },
    comments: {
      list: async () => [{ id: 'perm', kind: 'permanent', body_md: body, body_html: '', version: 1 }],
    },
  };
}

/** Клавиатурное событие для `runScopeHandlers`. */
function keyEvent(init: { key: string; code: string }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code,
    keyCode: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault(): void {},
  } as unknown as KeyboardEvent;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Чистый диапазон удаления
// ---------------------------------------------------------------------------

test('transclusionBlockRemoval: диапазон ссылки по началу блока', () => {
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  assert.deepEqual(transclusionBlockRemoval(doc, ref.start), { from: ref.start, to: ref.end });
  assert.equal(transclusionBlockRemoval(doc, 0), null, 'вне ссылки — null');
});

// ---------------------------------------------------------------------------
// Shift+клик и Delete
// ---------------------------------------------------------------------------

test('Shift+клик выделяет блок целиком и НЕ входит в него', async () => {
  __resetForTests();
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET, me: null });
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ShimElement;
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  const handled = transclusionMouseDown(
    { button: 0, shiftKey: true, target: blockElement(ref) } as unknown as MouseEvent,
    view as unknown as EditorView,
  );
  assert.equal(handled, true, 'Shift+клик по блоку обработан');
  const sel = view.state.selection.main;
  assert.equal(sel.from, ref.start);
  assert.equal(sel.to, ref.end, 'выделен ровно диапазон ссылки (блок целиком)');
  await tick();
  assert.equal(
    view.state.field(transclusionState)!.activeKey,
    null,
    'в блок НЕ вошли — Shift+клик только выделяет',
  );
  assert.equal(store.has(blockEditorKey(ID_A, null)), false, 'вложенный редактор не смонтирован');
});

test('обычный клик по блоку по-прежнему входит кареткой', async () => {
  __resetForTests();
  stubEtn('ТЕЛО');
  const { store: appStore } = await import('../src/renderer/state.js');
  appStore.update({ networkId: NET, me: null });
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ShimElement;
  const registry = new Map<string, FakeNestedView>();
  const store = new NestedEditorStore(fakeFactory(registry));
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  const view = makeView(withStore(doc, store));

  transclusionMouseDown(
    { button: 0, shiftKey: false, target: blockElement(ref) } as unknown as MouseEvent,
    view as unknown as EditorView,
  );
  await tick();
  await tick();
  assert.equal(
    view.state.field(transclusionState)!.activeKey,
    blockEditorKey(ID_A, null),
    'обычный клик активировал блок',
  );
  assert.ok(store.has(blockEditorKey(ID_A, null)), 'вложенный редактор смонтирован');
});

test('Delete на выделенном блоке удаляет ссылку одной транзакцией', () => {
  __resetForTests();
  const doc = `до ${BLOCK_RAW} после`;
  const ref = parseTransclusions(doc)[0]!;
  // Полный стек редактора поля (defaultKeymap с Delete) — как в реальном поле.
  let state = EditorState.create({ doc, extensions: mdEditorExtensions() });
  state = state.update({ selection: { anchor: ref.start, head: ref.end } }).state;
  const view = makeView(state);
  runScopeHandlers(view as unknown as EditorView, keyEvent({ key: 'Delete', code: 'Delete' }), 'editor');
  assert.equal(view.state.doc.toString(), 'до  после', 'ссылка удалена');
  assert.equal(view.state.selection.main.head, ref.start, 'каретка на месте блока');
});

// ---------------------------------------------------------------------------
// Сторож поповера: команда «Удалить блок»
// ---------------------------------------------------------------------------

test('поповер чипа несёт «Удалить блок» одной транзакцией (c11b82ee)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/renderer/editor/transclusion.ts'), 'utf8');
  assert.ok(/transclusionBlockRemoval\(/.test(src), 'удаление строится по transclusionBlockRemoval');
  assert.ok(/comment\.transclusion\.menu\.delete/.test(src), 'команда «Удалить блок» в поповере');
  assert.ok(/userEvent: 'delete'/.test(src), 'удаление — одна транзакция (userEvent delete)');
  // Диалога подтверждения быть не должно.
  assert.ok(
    !/transclusionBlockRemoval[\s\S]{0,400}?confirm/i.test(src),
    'удаление блока без диалога подтверждения',
  );
});
