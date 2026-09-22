/**
 * Команда «В фокус» всегда приводит к результату (ошибка 562356a9
 * «Команда «В фокус» не открывает экран «Карта мыслей» с другого экрана»,
 * версия 0.8.2).
 *
 * Контракт (спецификация «Контекстное меню мысли», 08-ui-spec.md §17): команда
 * «В фокус» — «поставить мысль в фокус и показать карту мыслей». Оба входа меню
 * мысли — подменю «Действия ▾» шапки редактора и контекстное меню облачка
 * (мини-облачко таблицы свойств, пилюля локального графа) — идут ОДНИМ общим
 * помощником `focusThoughtOnMap` (`screens/active-view.ts`): смена фокуса без
 * переключения вида на другом экране («Структуры», «Хроника», «События»)
 * незаметна, а на самой карте переключения быть не должно (вид тот же).
 *
 * Здесь: поведенческие проверки общего помощника (переключение вида + фокус;
 * на карте — без переключения) и композиции команды в меню; структурная
 * проверка, что оба входа делегируют общему помощнику, а не повторяют пару
 * `setActiveView('map') + setFocus(...)` копиями.
 *
 * Общий помощник исполняется «по-настоящему» под Node с минимальным DOM-ши́мом
 * (приём `copy-hotkey.test.ts`); модуль грузится ДИНАМИЧЕСКИ после шима, чтобы
 * граф импортов экранов не увидел `window` раньше времени.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { FocusResponse } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

/** Minimal `document`/`window` shims — must run BEFORE the first dynamic import. */
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

interface ThoughtStub {
  id: string;
  title: string;
  type_id: null;
  icon: null;
  icon_kind: 'emoji';
  icon_attachment_id: null;
  active: boolean;
  is_protected: boolean;
  is_root: boolean;
  marked_for_deletion: boolean;
  marked_for_deletion_at: null;
  marked_for_deletion_by: null;
  fg_color: null;
  bg_color: null;
  font_bold: null;
  font_italic: null;
  font_underline: null;
  font_strike: null;
  synonyms: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

function thought(id: string): ThoughtStub {
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

function focusResponse(id: string): FocusResponse {
  const sort = { sort: 'alpha', order: 'asc' } as const;
  return {
    focused: thought(id) as any,
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: { parents: sort, children: sort, siblings: sort },
  } as FocusResponse;
}

interface EtnCalls {
  /** Every `tabs.updateState` patch, in order (view_mode / focus_id writes). */
  tabWrites: Array<{ tabId: string; patch: Record<string, unknown> }>;
  /** Every `thoughts.focus` id, in order. */
  focusCalls: string[];
}

/** Wires the `window.etn` stub the shared helper reaches through `lib/etn`. */
function stubEtn(): EtnCalls {
  const calls: EtnCalls = { tabWrites: [], focusCalls: [] };
  const win = (globalThis as any).window;
  win.etn = {
    thoughts: {
      focus: async (_networkId: string, id: string) => {
        calls.focusCalls.push(id);
        return focusResponse(id);
      },
    },
    tabs: {
      updateState: async (tabId: string, patch: Record<string, unknown>) => {
        calls.tabWrites.push({ tabId, patch });
      },
    },
    ui: { setState: async () => undefined },
    history: { rotate: async () => undefined },
    logEvent: () => undefined,
  };
  return calls;
}

function viewModeWrites(calls: EtnCalls): Array<{ tabId: string; patch: Record<string, unknown> }> {
  return calls.tabWrites.filter((w) => 'view_mode' in w.patch);
}

/** Body of a module-level function, sliced down to its closing brace. */
function functionBody(src: string, signature: string, end = '\n}\n'): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected ${signature} to be defined`);
  const stop = src.indexOf(end, start);
  assert.ok(stop > start, `expected ${signature} body to be closed with ${JSON.stringify(end)}`);
  return src.slice(start, stop);
}

const SRC = {
  activeView: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'active-view.ts'),
  editor: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'editor.ts'),
  miniGraph: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'mini-graph.ts'),
  valueEditor: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'value-editor.ts'),
};

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('focusThoughtOnMap — «В фокус» с любого экрана (ошибка 562356a9)', () => {
  it('с чужого экрана переключает вид на карту и ставит мысль в фокус', async () => {
    shimDom();
    const calls = stubEtn();
    const { focusThoughtOnMap } = await import('../src/renderer/screens/active-view.js');
    const { store } = await import('../src/renderer/state.js');

    for (const view of ['structures', 'chronicle', 'activity'] as const) {
      calls.tabWrites.length = 0;
      calls.focusCalls.length = 0;
      store.update({ networkId: 'n1', activeTabId: 'tab-1', activeView: view, profileId: null } as any);

      await focusThoughtOnMap('t-' + view);

      assert.equal(store.state.activeView, 'map', `«В фокус» из «${view}» обязан открыть карту`);
      assert.deepEqual(
        viewModeWrites(calls).map((w) => w.patch['view_mode']),
        ['map'],
        `«${view}»: вид карты должен быть сохранён в табе`,
      );
      assert.equal(
        store.state.focus?.focused.id,
        't-' + view,
        `«${view}»: мысль должна встать в фокус`,
      );
      assert.deepEqual(calls.focusCalls, ['t-' + view], `«${view}»: фокус спрошен ровно один раз`);
    }

    store.update({ activeView: 'map', focus: null, activeTabId: null, networkId: null } as any);
  });

  it('на самой карте — только фокус, без переключения вида', async () => {
    shimDom();
    const calls = stubEtn();
    const { focusThoughtOnMap } = await import('../src/renderer/screens/active-view.js');
    const { store } = await import('../src/renderer/state.js');

    store.update({ networkId: 'n1', activeTabId: 'tab-1', activeView: 'map', profileId: null, focus: null } as any);

    await focusThoughtOnMap('t-map');

    assert.equal(store.state.activeView, 'map');
    assert.equal(
      viewModeWrites(calls).length,
      0,
      'на карте setActiveView — no-op: лишних переключений и перерисовок быть не должно',
    );
    assert.equal(store.state.focus?.focused.id, 't-map');

    store.update({ activeView: 'map', focus: null, activeTabId: null, networkId: null } as any);
  });

  it('команда «В фокус» в контекстном меню мысли зовёт обработчик контекста', async () => {
    shimDom();
    const { buildThoughtMenuItems } = await import('../src/renderer/canvas/context-menu.js');
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: 'n1', focus: null, selection: [] } as any);

    let called = 0;
    const items = buildThoughtMenuItems(
      'n1',
      { id: 't1', title: 'Мысль', dir: 'siblings' } as any,
      { focusHandler: () => { called += 1; } },
    );
    const row = items.find((i) => i.label === 'В фокус');
    assert.ok(row !== undefined, 'при заданном focusHandler команда «В фокус» есть в меню');
    row.onClick?.();
    assert.equal(called, 1, 'клик по «В фокус» обязан звать обработчик контекста');

    const without = buildThoughtMenuItems('n1', { id: 't1', title: 'Мысль', dir: 'siblings' } as any);
    assert.equal(
      without.find((i) => i.label === 'В фокус'),
      undefined,
      'без обработчика контекста команды «В фокус» в меню нет',
    );
  });

  it('оба входа делегируют общему focusThoughtOnMap, а не повторяют пару копией', () => {
    const activeView = readText(SRC.activeView);
    const helper = functionBody(activeView, 'export async function focusThoughtOnMap(');
    assert.ok(helper.includes("setActiveView('map')"), 'помощник обязан показать карту');
    assert.ok(helper.includes('await setFocus('), 'помощник обязан поставить мысль в фокус');

    // Вход 1 — подменю «Действия ▾» шапки редактора.
    const actions = functionBody(readText(SRC.editor), 'async function openThoughtActionsMenu(');
    assert.ok(
      actions.includes('focusThoughtOnMap(thought.id)'),
      '«Действия ▾» → «В фокус» обязан идти общим помощником',
    );
    assert.ok(
      !actions.includes('void setFocus('),
      '«Действия ▾» не должен звать setFocus напрямую — иначе карта не откроется',
    );

    // Вход 2 — контекстное меню облачка редактора: мини-облачко таблицы свойств
    // (value-editor) и пилюля локального графа (mini-graph).
    for (const path of [SRC.valueEditor, SRC.miniGraph]) {
      const body = functionBody(readText(path), 'function focusLinkRef(');
      assert.ok(
        body.includes('focusThoughtOnMap('),
        `${path}: «В фокус» обязан идти общим помощником`,
      );
    }
  });
});
