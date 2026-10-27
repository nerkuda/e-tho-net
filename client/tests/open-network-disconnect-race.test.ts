/**
 * Red/green gate for defect 50fe8807 — renderer half.
 *
 * `openNetwork` (client/src/renderer/app.ts) guards every publication with
 * `isCurrentOpenNetwork(seq)`, but `disconnect()` and `backToNetworks()` never
 * moved the epoch. Two proven windows:
 *
 *   (а) disconnect while the type catalogue is loading — `tabs.list` then
 *       returns `[]`, `tabs.open` throws into the swallowing `try/catch`, the
 *       staleness check passes and `store.update` publishes the network AFTER
 *       the user is already on onboarding;
 *   (б) disconnect while `syncLayersForTab` awaits — the `catch` swallows the
 *       failure, the check passes and `showScreen('workspace')` mounts the
 *       workspace on top of onboarding.
 *
 * The gate drives the REAL `app.ts` with the same minimal DOM shim as
 * `realtime-fallback-maxwait.test.ts` and deferred `window.etn` calls: each
 * scenario settles the awaited request AFTER the user has left the network.
 *
 * Mutations that must turn the targeted cases red:
 *   - drop `openNetworkSeq += 1` from `disconnect()` → case 1 publishes the
 *     network; case 3 reaches `showScreen('workspace')`;
 *   - drop it from `backToNetworks()` → cases 2 and 3 roll back to the old
 *     screen;
 *   - move the bump below `await etn.server.disconnect()` → case 1/3 publish
 *     during the awaited bridge call.
 *
 * Non-targeted behaviour (`openNetwork` still opens normally when nothing
 * interrupts it) is covered by the suite's own "regression" case at the end.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET_A = '00000000-0000-4000-8000-00000000000a';

/** Deferred promise with an observable settle handle. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal `document`/`window` shim, installed before the first app.ts import. */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
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
    getSelection: () => null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = (handler: (...args: any[]) => void, ms?: number, ...rest: any[]) =>
    (globalThis as any).setTimeout(handler, ms, ...rest);
  win.clearTimeout = (id: any) => (globalThis as any).clearTimeout(id);
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1600;
  win.innerHeight = 900;
}

/** `Network` stub — only `id`/`display_name` are read by `openNetwork`. */
function network(id: string): Record<string, unknown> {
  return { id, display_name: `Сеть ${id}` };
}

/** A tab row as `tabs.open`/`tabs.list` return it (`TabDto`). */
function tab(networkId: string): Record<string, unknown> {
  return {
    tab_id: 'tab-1',
    slot_idx: 0,
    network_id: networkId,
    view_mode: 'map',
    focus_id: null,
    layer_id: null,
  };
}

/** Deferred network open of NET_A: the test settles it after disconnecting. */
let openGate: ReturnType<typeof deferred<any>> | null = null;
/** Deferred type-catalogue read (`thought-types`) for window (а). */
let typesGate: ReturnType<typeof deferred<any>> | null = null;
/** Deferred `layers.list` read for window (б). */
let layersGate: ReturnType<typeof deferred<any>> | null = null;
let tabsOpenCalls = 0;
let layersListCalls = 0;
let typesListCalls = 0;
/** Мост после `server.disconnect`: вкладки закрытой сессии недоступны. */
let disconnected = false;

/**
 * Full `window.etn` stub for the `openNetwork` pipeline. Every awaited call is
 * either an immediate value or a gate the test resolves at the chosen moment.
 */
function stubEtn(options: { deferTypes?: boolean; deferLayers?: boolean }): void {
  const win = (globalThis as any).window;
  win.etn = {
    server: {
      connect: async () => ({ id: 'user-1' }),
      disconnect: async () => {
        disconnected = true;
      },
      listProfiles: async () => [],
      getStatus: async () => 'idle',
    },
    networks: {
      open: async () => openGate!.promise,
      getPreferences: async () => [],
      list: async () => [],
      listMembers: async () => [],
    },
    ui: {
      getState: async () => null,
      setState: async () => undefined,
    },
    pins: { list: async () => [] },
    types: {
      listLinkTypes: async () => [],
      listThoughtTypes: async () => {
        typesListCalls += 1;
        if (options.deferTypes === true) return typesGate!.promise;
        return [];
      },
    },
    tabs: {
      list: async () => {
        // Профиль отключён — у главного процесса вкладок этой сессии нет.
        if (disconnected) return [];
        return tabsOpenCalls > 0 ? [tab(NET_A)] : [];
      },
      open: async (networkId: string) => {
        // Окно (а): `tabs.open` бросает «Not connected» в глотающий catch
        // `openNetwork` — именно оно маскировало публикацию до фикса.
        if (disconnected) throw new Error('Not connected: call etn.server.connect first');
        tabsOpenCalls += 1;
        return tab(networkId);
      },
    },
    layers: {
      list: async () => {
        layersListCalls += 1;
        if (options.deferLayers === true) return layersGate!.promise;
        return [];
      },
      select: async () => ({ id: 'base', title: 'Основа' }),
      diff: async () => ({ overridden: { thought_ids: [], link_ids: [] } }),
    },
    locks: { list: async () => [] },
    admin: {
      listUsers: async () => {
        throw new Error('not an admin');
      },
    },
    realtime: { getStatuses: async () => [] },
    thoughts: { focus: async () => ({}) },
    settings: { list: async () => [] },
  };
}

/** Run pending microtasks (promise continuations of `openNetwork`). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Wait until `check()` is true, draining microtasks in between. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await flushMicrotasks();
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Common preparation: shim, fresh gates, app.ts/store imports, screen root. */
async function prepare(
  options: { deferTypes?: boolean; deferLayers?: boolean } = {},
): Promise<{
  app: typeof import('../src/renderer/app.js');
  store: typeof import('../src/renderer/state.js').store;
}> {
  shimDom();
  openGate = deferred<any>();
  typesGate = deferred<any>();
  layersGate = deferred<any>();
  tabsOpenCalls = 0;
  layersListCalls = 0;
  typesListCalls = 0;
  disconnected = false;
  stubEtn(options);

  const { appInternals: _internals } = await import('../src/renderer/app.js');
  const { store } = await import('../src/renderer/state.js');
  const { initScreens } = await import('../src/renderer/screens/screens.js');
  void _internals;
  initScreens(new ShimElement('div') as unknown as HTMLElement);
  store.resetNetwork();
  store.update({ screen: 'networks', me: null, profileId: 'profile-a' } as any);
  return { app: await import('../src/renderer/app.js'), store };
}

describe('renderer openNetwork ↔ disconnect race (50fe8807)', () => {
  it('разрыв во время networks.open: сеть не публикуется, tabs.open не зовётся', async () => {
    const { app, store } = await prepare();
    const openPromise = app.openNetwork(NET_A);
    await flushMicrotasks();

    await app.disconnect();
    assert.equal(store.state.screen, 'onboarding', 'пользователь уже на онбординге');

    openGate!.resolve(network(NET_A));
    await openPromise;

    assert.equal(store.state.networkId, null, 'поздний ответ не опубликовал сеть');
    assert.equal(store.state.screen, 'onboarding', 'экран остался онбордингом');
    assert.equal(tabsOpenCalls, 0, 'вкладка закрытой сессии не создаётся');
  });

  it('разрыв во время запроса типов: поздний ответ не публикует сеть', async () => {
    const { app, store } = await prepare({ deferTypes: true });
    const openPromise = app.openNetwork(NET_A);
    await flushMicrotasks();
    openGate!.resolve(network(NET_A));
    await waitFor(() => typesListCalls > 0, 'listThoughtTypes в полёте');

    await app.disconnect();
    assert.equal(store.state.screen, 'onboarding', 'пользователь уже на онбординге');

    // Окно (а) из карточки: после разрыва `tabs.list` отдаёт пустой список,
    // `tabs.open` бросает «Not connected» в глотающий catch, и проверка
    // актуальности — единственный барьер публикации.
    typesGate!.resolve([]);
    await openPromise;

    assert.equal(store.state.networkId, null, 'поздний ответ не опубликовал сеть');
    assert.equal(store.state.screen, 'onboarding', 'экран остался онбордингом');
    assert.equal(tabsOpenCalls, 0, 'вкладка закрытой сессии не создаётся');
  });

  it('backToNetworks во время запроса, затем поздний ответ: экран остаётся списком сетей', async () => {
    const { app, store } = await prepare();
    const openPromise = app.openNetwork(NET_A);
    await flushMicrotasks();

    app.backToNetworks();
    assert.equal(store.state.screen, 'networks', 'пользователь уже в списке сетей');

    openGate!.resolve(network(NET_A));
    await openPromise;

    assert.equal(store.state.networkId, null, 'поздний ответ не опубликовал сеть');
    assert.equal(store.state.screen, 'networks', 'экран остался списком сетей');
  });

  it('разрыв в окне syncLayersForTab: рабочая область не возвращается поверх онбординга', async () => {
    const { app, store } = await prepare({ deferLayers: true });
    const openPromise = app.openNetwork(NET_A);
    await flushMicrotasks();
    openGate!.resolve(network(NET_A));
    await waitFor(() => layersListCalls > 0, 'layers.list в полёте');

    await app.disconnect();
    assert.equal(store.state.screen, 'onboarding', 'пользователь уже на онбординге');

    // Слой закрытой сессии не перечитывается: syncLayersForTab упирается в
    // stale-проверку, затем app.ts обязан вернуться ДО showScreen('workspace').
    layersGate!.resolve([]);
    await openPromise;

    assert.equal(store.state.networkId, null, 'сеть не опубликована');
    assert.equal(store.state.screen, 'onboarding', 'showScreen("workspace") не вызван');
  });

  it('регресс: без вмешательства сеть публикуется (58c55bb9 не сломан)', async () => {
    const { app, store } = await prepare();
    const openPromise = app.openNetwork(NET_A);
    await flushMicrotasks();
    openGate!.resolve(network(NET_A));
    // Монтаж рабочей области на DOM-шиме не поднимается (canvas/редактор) —
    // это не предмет теста; контракт здесь — публикация сети до показа экрана.
    await openPromise.catch(() => undefined);

    assert.equal(store.state.networkId, NET_A, 'сеть опубликована законно');
    assert.equal(tabsOpenCalls, 1, 'вкладка создана');
  });
});
