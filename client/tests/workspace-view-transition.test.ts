/**
 * Ошибка f1febdfc «Потеря клика по закладке вида в окне открытия второй вкладки
 * сети»: пока `openNetwork` собирает новую сеть/вкладку, в DOM живёт ПРЕЖНЕЕ
 * рабочее пространство, и клик по закладке вида приходится на уходящее
 * поколение. До фикса он терялся: вид уже активен → ранний выход
 * `setActiveView`; затем `openNetwork` публиковал вид новой вкладки (карту).
 *
 * Контракт: в окне перехода (`screens/workspace-transition.ts`) клик не
 * применяется к уходящему workspace, а запоминается последним намерением и
 * применяется к НОВОМУ поколению сразу после его сборки; вне окна поведение
 * прежнее. Модули грузятся ДИНАМИЧЕСКИ после DOM-шима (приём
 * `focus-on-map.test.ts`), чтобы граф импортов экранов не увидел `window`
 * раньше времени.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

interface EtnCalls {
  /** Every `tabs.updateState` patch, in order (view_mode writes). */
  tabWrites: Array<{ tabId: string; patch: Record<string, unknown> }>;
}

/** Wires the `window.etn` stub `setActiveView` reaches through `lib/etn`. */
function stubEtn(): EtnCalls {
  const calls: EtnCalls = { tabWrites: [] };
  const win = (globalThis as any).window;
  win.etn = {
    tabs: {
      updateState: async (tabId: string, patch: Record<string, unknown>) => {
        calls.tabWrites.push({ tabId, patch });
      },
    },
    ui: { setState: async () => undefined },
    logEvent: () => undefined,
  };
  return calls;
}

describe('закладка вида в окне смены поколения workspace (f1febdfc)', () => {
  it('клик в уходящем workspace применяется к НОВОЙ вкладке', async () => {
    shimDom();
    const calls = stubEtn();
    const { setActiveView } = await import('../src/renderer/screens/active-view.js');
    const { store } = await import('../src/renderer/state.js');
    const transition = await import('../src/renderer/screens/workspace-transition.js');

    store.update({
      networkId: 'n1',
      profileId: null,
      activeTabId: 'tab-old',
      activeView: 'chronicle',
      screen: 'workspace',
    } as any);

    // Пикер открыл окно до своего await и кликнул вторую вкладку той же сети.
    const token = transition.beginWorkspaceTransition();
    // Клик по УЖЕ активной закладке в уходящем workspace — до фикса терялся.
    setActiveView('chronicle');
    assert.equal(store.state.activeView, 'chronicle', 'в окне вид не переключается');
    assert.deepEqual(calls.tabWrites, [], 'в окне клик не пишется в уходящую вкладку');

    // openNetwork публикует новую вкладку и её вид (карту).
    store.update({ activeTabId: 'tab-new', activeView: 'map' } as any);
    transition.applyPendingWorkspaceView();
    assert.equal(store.state.activeView, 'chronicle', 'намерение применено к новому поколению');
    assert.deepEqual(
      calls.tabWrites,
      [{ tabId: 'tab-new', patch: { view_mode: 'chronicle' } }],
      'вид сохранён в НОВОЙ вкладке, а не в уходящей',
    );

    transition.endWorkspaceTransition(token);
    assert.equal(calls.tabWrites.length, 1, 'закрытие окна повторно не применяет намерение');
  });

  it('вложенные окна пикера и openNetwork: последнее намерение — после закрытия внешнего', async () => {
    shimDom();
    const calls = stubEtn();
    const { setActiveView } = await import('../src/renderer/screens/active-view.js');
    const { store } = await import('../src/renderer/state.js');
    const transition = await import('../src/renderer/screens/workspace-transition.js');

    store.update({
      networkId: 'n1',
      profileId: null,
      activeTabId: 'tab-old',
      activeView: 'map',
      screen: 'workspace',
    } as any);

    const outer = transition.beginWorkspaceTransition(); // picker.pickNetwork
    const inner = transition.beginWorkspaceTransition(); // openNetwork
    setActiveView('chronicle');
    store.update({ activeTabId: 'tab-new', activeView: 'map' } as any);
    transition.applyPendingWorkspaceView();
    assert.equal(store.state.activeView, 'chronicle');
    // openNetwork завершился, но окно пикера ещё открыто.
    transition.endWorkspaceTransition(inner);
    setActiveView('structures');
    assert.equal(
      store.state.activeView,
      'chronicle',
      'клик при открытом внешнем окне снова только запоминается',
    );
    transition.endWorkspaceTransition(outer);
    assert.equal(store.state.activeView, 'structures', 'намерение применено на закрытии окна');
    assert.deepEqual(
      calls.tabWrites.at(-1),
      { tabId: 'tab-new', patch: { view_mode: 'structures' } },
      'последний клик сохранён в актуальной вкладке',
    );
  });

  it('вне окна поведение прежнее: тот же вид — no-op, другой — сразу и в свою вкладку', async () => {
    shimDom();
    const calls = stubEtn();
    const { setActiveView } = await import('../src/renderer/screens/active-view.js');
    const { store } = await import('../src/renderer/state.js');

    store.update({
      networkId: 'n2',
      profileId: null,
      activeTabId: 'tab-2',
      activeView: 'chronicle',
      screen: 'workspace',
    } as any);

    setActiveView('chronicle');
    assert.deepEqual(calls.tabWrites, [], 'клик по активной закладке вне окна — как раньше, no-op');

    setActiveView('structures');
    assert.equal(store.state.activeView, 'structures');
    assert.deepEqual(
      calls.tabWrites,
      [{ tabId: 'tab-2', patch: { view_mode: 'structures' } }],
      'вне окна вид применяется сразу и в свою вкладку',
    );
  });
});
