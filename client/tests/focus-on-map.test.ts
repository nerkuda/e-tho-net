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
  thoughtCloud: resolve(import.meta.dirname, '..', 'src', 'renderer', 'lib', 'thought-cloud.ts'),
  linksTab: resolve(import.meta.dirname, '..', 'src', 'renderer', 'editor', 'links-tab.ts'),
  structures: resolve(
    import.meta.dirname,
    '..',
    'src',
    'renderer',
    'screens',
    'structures',
    'structures.ts',
  ),
  pinnedBar: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'pinned-bar.ts'),
  historyBar: resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'history-bar.ts'),
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
    // Фокус — через единый UI-вход `focusFromUi`: отказ `thoughts.focus`
    // показывается тостом, а не теряется (ошибка 1656ef58).
    assert.ok(
      helper.includes('await focusFromUi('),
      'помощник обязан поставить мысль в фокус через focusFromUi',
    );

    // Вход 1 — подменю «Действия ▾» шапки редактора. Обработчик идёт через
    // общий помощник, а rejection ленивого импорта гасит `focusOnMapFromMenu`
    // (ошибка 53d21e82): прямой `void focusThoughtOnMap(...)` оставлял бы
    // unhandled rejection при сбое загрузки чанка.
    const actions = functionBody(readText(SRC.editor), 'async function openThoughtActionsMenu(');
    assert.ok(
      actions.includes('focusOnMapFromMenu(focusThoughtOnMap, thought.id)'),
      '«Действия ▾» → «В фокус» обязан идти общим помощником через гасящий rejection обработчик',
    );
    assert.ok(
      !actions.includes('void focusThoughtOnMap('),
      '«Действия ▾» не должен звать focusThoughtOnMap напрямую без catch',
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

describe('двойной клик по облачку вне карты — открыть, в фокус и на карту (задача ef085714)', () => {
  it('фабрика даёт профилям вне карты единый жест, профиль карты его не получает', () => {
    const cloud = readText(SRC.thoughtCloud);
    const helper = functionBody(cloud, 'export function doubleClickFocusOnMap(');
    assert.ok(
      /import\('\.\.\/editor\/editor\.js'\)/.test(helper),
      'двойной клик открывает мысль в редакторе',
    );
    assert.ok(
      /import\('\.\.\/screens\/active-view\.js'\)/.test(helper),
      'двойной клик идёт общим помощником focusThoughtOnMap, а не копией',
    );
    assert.ok(helper.includes('openThoughtInEditor(id)'), 'мысль открывается в редакторе');
    assert.ok(helper.includes('focusThoughtOnMap(id)'), 'фокус и активация карты — общий путь');

    // Условие дефолта: только профили вне карты, только когда своя семантика
    // двойного клика не задана, и только для навигационных облачков.
    assert.ok(
      cloud.includes('(options.navigation ?? true) &&'),
      'чипы значений формы (navigation: false) исключены из правила',
    );
    assert.ok(cloud.includes("profile !== 'canvas' &&"), 'карта (canvas) сохраняет свой жест');
    assert.ok(
      cloud.includes('options.actions.onDoubleClick === undefined'),
      'своя семантика области побеждает дефолт',
    );
    assert.ok(
      cloud.includes('onDoubleClick: doubleClickFocusOnMap'),
      'дефолт двойного клика — единый помощник фабрики',
    );
  });

  it('жест исполняется по-настоящему: мысль открыта, фокус и карта — общим путём', async () => {
    shimDom();
    const calls = stubEtn();
    const { doubleClickFocusOnMap } = await import('../src/renderer/lib/thought-cloud.js');
    const { store } = await import('../src/renderer/state.js');

    store.update({
      networkId: 'n1',
      activeTabId: 'tab-1',
      activeView: 'structures',
      profileId: null,
      focus: null,
    } as any);

    doubleClickFocusOnMap('t-gesture');
    for (let i = 0; i < 50 && store.state.activeView !== 'map'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(store.state.activeView, 'map', 'двойной клик обязан активировать «Карту мыслей»');
    assert.equal(store.state.focus?.focused.id, 't-gesture', 'мысль обязана встать в фокус');
    assert.deepEqual(calls.focusCalls, ['t-gesture'], 'фокус спрошен ровно один раз');

    store.update({ activeView: 'map', focus: null, activeTabId: null, networkId: null } as any);
  });

  it('фабричный жест достаётся профилям вне карты, но не карте и чипам формы', async () => {
    shimDom();
    stubEtn();
    const { createThoughtCloud } = await import('../src/renderer/lib/thought-cloud.js');
    const { store } = await import('../src/renderer/state.js');
    const dbl = {
      type: 'dblclick',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    } as any;
    const waitMap = async (): Promise<void> => {
      for (let i = 0; i < 50 && store.state.activeView !== 'map'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    store.update({
      networkId: 'n1',
      activeTabId: 'tab-1',
      activeView: 'structures',
      focus: null,
    } as any);
    const tree = createThoughtCloud(
      { id: 't-tree', title: 'Дерево' },
      { profile: 'tree', actions: { onClick: () => undefined } },
    );
    tree.dispatchEvent(dbl);
    await waitMap();
    assert.equal(store.state.activeView, 'map', 'облачко вне карты переводит на «Карту мыслей»');
    assert.equal(store.state.focus?.focused.id, 't-tree', 'облачко вне карты ставит мысль в фокус');

    // Профиль карты и чипы значений формы дефолта не получают.
    store.update({ activeView: 'structures', focus: null } as any);
    const canvas = createThoughtCloud(
      { id: 't-canvas', title: 'Карта' },
      { profile: 'canvas', actions: { onClick: () => undefined } },
    );
    canvas.dispatchEvent(dbl);
    const form = createThoughtCloud(
      { id: 't-form', title: 'Значение' },
      { profile: 'chip', navigation: false, actions: { onClick: () => undefined } },
    );
    form.dispatchEvent(dbl);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(store.state.activeView, 'structures', 'карта и чип формы вид не переключают');
    assert.equal(store.state.focus, null, 'фокус не тронут');

    store.update({ activeView: 'map', focus: null, activeTabId: null, networkId: null } as any);
  });

  it('потребители не собирают «двойной клик → фокус» вручную', () => {
    const consumers = [SRC.linksTab, SRC.miniGraph, SRC.pinnedBar, SRC.historyBar, SRC.structures];
    for (const path of consumers) {
      const src = readText(path);
      assert.ok(
        !/onDoubleClick:\s*(?:\([^)]*\)|\w+)\s*=>\s*(?:void\s+)?focusFromUi\(/.test(src),
        `${path}: двойной клик обязан идти фабричным жестом, а не focusFromUi (без активации карты)`,
      );
    }

    // «Найти на карте мыслей» в «Структурах» — общий помощник, не пара копий.
    const structures = readText(SRC.structures);
    assert.ok(
      structures.includes('focusThoughtOnMap(targetId)'),
      'структуры: команда «найти на карте» идёт общим focusThoughtOnMap',
    );
    assert.ok(
      !/setActiveView\('map'\);\s*focusFromUi\(/.test(structures),
      'структуры: пары setActiveView + focusFromUi быть не должно',
    );

    // Одиночный клик чипов закреплённых и истории фокус НЕ переводит.
    for (const [path, fnName] of [
      [SRC.pinnedBar, 'openPinnedEntry'],
      [SRC.historyBar, 'openEntry'],
    ] as const) {
      const body = functionBody(readText(path), `function ${fnName}(`);
      assert.ok(!body.includes('focusFromUi('), `${path}: одиночный клик фокус не переводит`);
      assert.ok(
        body.includes('openThoughtInEditor('),
        `${path}: одиночный клик открывает редактор`,
      );
    }
  });
});
