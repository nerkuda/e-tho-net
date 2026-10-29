/**
 * Red/green gate for defect 1656ef58 — «установка фокуса без стража
 * актуальности» (клиентский слой).
 *
 * `setFocus` ждёт сеть (`thoughts.focus`), затем ещё раз ждёт историю
 * (`noteThoughtWillOpen`). Если пользователь за это время выбрал другую мысль,
 * сменил вкладку/сеть, а прежний ответ пришёл позже, он ПЕРЕЗАПИСЫВАЛ более
 * новый фокус: карта показывала старую мысль в центре и её детей, а история
 * получала поворот в чужую вкладку. Тот же класс — фоновый
 * `refreshFocusOrNull` и `resetFocusToHome`, которые безусловно публиковали
 * свой ответ.
 *
 * Гейт гоняет РЕАЛЬНЫЕ `app.ts`/`layer-resync.ts` на подставном мосте
 * `window.etn` с отложенными ответами `thoughts.focus` (образец швов —
 * `open-network-disconnect-race.test.ts`, `layer-switch-editor.test.ts`).
 *
 * Целевые кейсы (обязаны краснеть при мутации `isFocusOpCurrent → true`):
 *   1. `setFocus(A)` затем `setFocus(B)`, ответ B раньше A — в сторе B,
 *      подписка окрестности на B, поворота истории для A нет;
 *   2. `refreshFocusOrNull` (для A) в полёте, затем `setFocus(B)`, ответ B
 *      раньше фонового A — фон не перезаписывает B;
 *   3. `openNetwork(B)` во время `setFocus(A)` — поздний ответ A не попадает
 *      ни в стор новой сети, ни в историю её вкладки.
 *
 * Дополнительно: `resetFocusToHome` не публикует HOME, если пользователь
 * успел начать свой фокус; обычная установка фокуса без вмешательства
 * работает как раньше (регресс).
 *
 * Круг 2 (снятие `beginFocusOp` в `disconnect`/`backToNetworks` обязано
 * краснить эти кейсы):
 *   4. `disconnect()` во время `setFocus(A)`, затем возврат в ту же пару
 *      «сеть + вкладка» — поздний A не публикуется и историю не двигает;
 *   5. `backToNetworks()` — то же для выхода в список сетей;
 *   6. отказ `thoughts.focus` из строки панели выделенных и из async-пути
 *      «В фокус» (`focusThoughtOnMap`): тост показан, состояние не меняется,
 *      unhandled rejection нет (молчаливый отказ выглядел как зависание).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { FocusNeighbor, FocusResponse, Thought, ThoughtRef } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { SINGLE_CLICK_DELAY_MS } from '../src/renderer/lib/thought-cloud.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET_A = '00000000-0000-4000-8000-00000000000a';
const NET_B = '00000000-0000-4000-8000-00000000000b';
const TAB_A = 'tab-a';
const TAB_B = 'tab-b';
const HOME = '00000000-0000-4000-8000-000000000001';
const FOCUS_A = '00000000-0000-4000-8000-0000000000a01';
const FOCUS_B = '00000000-0000-4000-8000-0000000000b01';
const ROOT_ID = '00000000-0000-4000-8000-000000000002';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Минимальный DOM-шим (тот же набор, что у open-network-disconnect-race). */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: new ShimElement('html'),
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
  win.setTimeout = (handler: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
    // Длинные таймеры (TTL тоста — 4 с) в юните не крутим: они держат event
    // loop после теста, а проверяется факт тоста, не его автоскрытие.
    if ((ms ?? 0) > 1000) return 0;
    return (globalThis as any).setTimeout(handler, ms, ...rest);
  };
  win.clearTimeout = (id: any) => (globalThis as any).clearTimeout(id);
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1600;
  win.innerHeight = 900;
  win.requestAnimationFrame = (cb: (t: number) => void) =>
    (globalThis as any).setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id: any) => (globalThis as any).clearTimeout(id);
  (globalThis as any).requestAnimationFrame = win.requestAnimationFrame;
  (globalThis as any).cancelAnimationFrame = win.cancelAnimationFrame;
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  (globalThis as any).getComputedStyle = win.getComputedStyle;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function thought(id: string, title: string, extra: Partial<Thought> = {}): Thought {
  return {
    id,
    title,
    type_id: TYPE_ID,
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
    created_at: '2026-10-26T00:00:00.000Z',
    updated_at: '2026-10-26T00:00:00.000Z',
    ...extra,
  };
}

/** Легковесная карточка мысли — ответ `thoughts.resolve` для строк выделения. */
function thoughtRef(id: string, title: string): ThoughtRef {
  const t = thought(id, title);
  return {
    id: t.id,
    title: t.title,
    type_id: t.type_id,
    icon: t.icon,
    icon_kind: t.icon_kind,
    icon_attachment_id: t.icon_attachment_id,
    active: t.active,
    marked_for_deletion: t.marked_for_deletion,
    fg_color: t.fg_color,
    bg_color: t.bg_color,
    font_bold: t.font_bold,
    font_italic: t.font_italic,
    font_underline: t.font_underline,
    font_strike: t.font_strike,
  };
}

function focusResponse(
  id: string,
  title: string,
  children: FocusNeighbor[] = [],
): FocusResponse {
  return {
    focused: thought(id, title),
    parents: [],
    children,
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'alpha', order: 'asc' },
      children: { sort: 'alpha', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  };
}

/** Записанные повороты истории (`etn.history.rotate`). */
let rotates: Array<{ oldId: string; newId: string; tabId: string | null }> = [];
/** Отложенные ответы `thoughts.focus` по id мысли. */
let focusGates: Map<string, Deferred<FocusResponse>> = new Map();
/** Все вызовы `thoughts.focus` в порядке обращения — для диагностики. */
let focusCalls: string[] = [];

/** Отложенный (по умолчанию) ответ фокуса для id; резолв — `resolveFocus`. */
function focusDeferred(id: string): Deferred<FocusResponse> {
  let gate = focusGates.get(id);
  if (gate === undefined) {
    gate = deferred<FocusResponse>();
    focusGates.set(id, gate);
  }
  return gate;
}

function resolveFocus(id: string, response: FocusResponse): void {
  focusDeferred(id).resolve(response);
}

/** Отказ `thoughts.focus` для id — проверка обратной связи (тост). */
function failFocus(id: string, error: Error): void {
  focusDeferred(id).reject(error);
}

/**
 * Возврат в ту же пару «сеть + вкладка» после выхода (disconnect /
 * backToNetworks): строки вкладок живут на сервере, поэтому после
 * переподключения `tab_id` тот же. Нужен, чтобы страж пары не маскировал
 * проверку поколения операций: поздний ответ обязан гасить именно `seq`.
 */
function restoreSameScreenPair(): void {
  store.update({
    screen: 'workspace',
    networkId: NET_A,
    activeTabId: TAB_A,
    tabs: [
      {
        tab_id: TAB_A,
        slot_idx: 0,
        network_id: NET_A,
        view_mode: 'map',
        focus_id: null,
        layer_id: null,
      },
    ],
  } as any);
}

/** Тост-ошибка в стеке уведомлений (или null). */
function errorToast(): ShimElement | null {
  const body = (globalThis as any).document.body as ShimElement;
  const stack = body.querySelector('.notice-stack');
  return stack?.querySelector('.notice.error') ?? null;
}

/**
 * Прогоняет сценарий и возвращает все unhandled rejection за его время:
 * `focusFromUi` обязан гасить отказ фокуса сам, иначе симптом «зависания»
 * остаётся (ошибка 1656ef58).
 */
async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return reasons;
}

/** Полный мост `window.etn` для путей фокуса и открытия сети. */
function stubEtn(): void {
  const win = (globalThis as any).window as Record<string, unknown>;
  win.etn = {
    server: {
      connect: async () => ({ id: 'user-1' }),
      disconnect: async () => undefined,
      listProfiles: async () => [],
      getStatus: async () => 'idle',
    },
    networks: {
      open: async (networkId: string) => ({ id: networkId, display_name: `Сеть ${networkId}` }),
      getPreferences: async () => [],
      list: async () => [
        { id: NET_A, display_name: 'Сеть A' },
        { id: NET_B, display_name: 'Сеть B' },
      ],
      listMembers: async () => [],
    },
    ui: {
      getState: async () => null,
      setState: async () => undefined,
    },
    pins: { list: async () => [] },
    history: {
      list: async () => [],
      rotate: async (oldId: string, newId: string, tabId: string | null) => {
        rotates.push({ oldId, newId, tabId });
      },
      remove: async () => undefined,
    },
    types: {
      listLinkTypes: async () => [],
      listThoughtTypes: async () => [],
    },
    tabs: {
      list: async () => [
        {
          tab_id: TAB_B,
          slot_idx: 0,
          network_id: NET_B,
          view_mode: 'map',
          focus_id: FOCUS_B,
          layer_id: null,
        },
      ],
      open: async () => ({
        tab_id: TAB_B,
        slot_idx: 0,
        network_id: NET_B,
        view_mode: 'map',
        focus_id: null,
        layer_id: null,
      }),
      updateState: async () => undefined,
    },
    layers: {
      list: async () => [
        { id: 'base', title: 'Основа', is_base: true, current: true, is_service: false },
      ],
      select: async () => ({ id: 'base', title: 'Основа' }),
      diff: async () => ({ overridden: { thought_ids: [], link_ids: [] } }),
    },
    locks: { list: async () => [] },
    realtime: {
      getStatuses: async () => [],
      onSelfMutated: () => () => undefined,
      onEvent: () => () => undefined,
    },
    settings: { list: async () => [] },
    structures: {
      query: async () => ({ items: [thought(ROOT_ID, 'HOME', { is_root: true })], total: 1 }),
      queryIds: async () => ({ items: [] }),
      hierarchy: async () => ({ items: [] }),
      edges: async () => [],
    },
    thoughts: {
      focus: (networkId: string, id: string) => {
        void networkId;
        focusCalls.push(id);
        return focusDeferred(id).promise;
      },
      get: async (_networkId: string, id: string) => thought(id, `T:${id}`),
      // Панель выделенных на каждый рендер без известного ref заново зовёт
      // `resolve`; пустой ответ оставил бы её в бесконечной цепочке микрозадач
      // (`render → resolveRows → render`), и таймеры не получили бы хода.
      resolve: async (_networkId: string, ids: string[]) =>
        ids.map((id) => thoughtRef(id, `T:${id}`)),
      neighbors: async () => [],
      setFocusOrder: async () => undefined,
      setFocusPreferences: async () => undefined,
    },
    comments: { list: async () => [] },
    attachments: { list: async () => [] },
    links: { listByThought: async () => [] },
  };
}

/** Дать отработать континуациям промисов. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

/**
 * Id, на который ПОДПИСАНА активная окрестность фокуса: инвалидация
 * `focus:@*` перезапрашивает ключ подписки, и её fetcher зовёт
 * `thoughts.focus` с этим id. Наблюдаем через публичное поведение (реестр
 * запросов), поэтому тест одинаково работает и на дофиксовой сборке, где
 * отдельного шва `activeFocusId` ещё нет.
 */
async function activeFocusId(): Promise<string | null> {
  focusCalls = [];
  const registry = await import('../src/renderer/lib/live/query-registry.js');
  const { queryKeys } = await import('../src/renderer/lib/live/query-keys.js');
  registry.invalidateQueries(queryKeys.focusAll(), registry.LOCAL_CAUSE);
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
  return focusCalls.at(-1) ?? null;
}

/** Дождаться условия, «прокручивая» микротаски (и таймеры нулевой длины). */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await flushMicrotasks();
    if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timeout waiting for ${label}`);
}

type AppModule = typeof import('../src/renderer/app.js');
type StoreModule = typeof import('../src/renderer/state.js').store;
type ResyncModule = typeof import('../src/renderer/lib/layer-resync.js');

let app: AppModule;
let store: StoreModule;
let resync: ResyncModule;

/** Подготовка модулей и чистого состояния перед каждым кейсом. */
async function prepare(): Promise<void> {
  rotates = [];
  focusGates = new Map();
  focusCalls = [];
  shimDom();
  stubEtn();
  resync = await import('../src/renderer/lib/layer-resync.js');
  const screens = await import('../src/renderer/screens/screens.js');
  const state = await import('../src/renderer/state.js');
  const history = await import('../src/renderer/history.js');
  app = await import('../src/renderer/app.js');
  store = state.store;
  screens.initScreens(new ShimElement('div') as unknown as HTMLElement);
  resync.deactivateFocusQuery();
  const registry = await import('../src/renderer/lib/live/query-registry.js');
  registry.resetQueryRegistry();
  history.resetHistoryTrackingForTests();
  store.resetNetwork();
  store.update({
    screen: 'workspace',
    networkId: NET_A,
    activeTabId: TAB_A,
    profileId: 'profile-a',
    tabs: [],
    focus: focusResponse(HOME, 'HOME'),
  } as any);
}

beforeEach(async () => {
  await prepare();
});

afterEach(async () => {
  resync.deactivateFocusQuery();
  app.backToNetworks();
  // Дать отработать отложенному рендеру/анимации холста и демонтажу — иначе
  // их продолжения попадут в следующий тест (Node ругается asynchronous activity).
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('фокус 1656ef58: поздний ответ прежней установки не перезаписывает новый', () => {
  it('setFocus(A) затем setFocus(B): ответ B раньше A — в сторе B, подписка/история на B', async () => {
    const promiseA = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    const promiseB = app.setFocus(FOCUS_B);
    await flushMicrotasks();
    assert.deepEqual(focusCalls.slice(0, 2), [FOCUS_A, FOCUS_B], 'оба запроса ушли');

    // Пользователь последний раз выбрал B — его ответ приходит первым.
    resolveFocus(FOCUS_B, focusResponse(FOCUS_B, 'Мысль B'));
    await promiseB;
    assert.equal(store.state.focus?.focused.id, FOCUS_B, 'B опубликован');
    assert.equal(await activeFocusId(), FOCUS_B, 'окрестность подписана на B');

    // Теперь приходит запоздавший ответ A.
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await promiseA;

    assert.equal(store.state.focus?.focused.id, FOCUS_B, 'поздний A не перезаписал B');
    assert.equal(
      await activeFocusId(),
      FOCUS_B,
      'окрестность осталась на B (A не переподписал)',
    );
    assert.deepEqual(
      rotates,
      [{ oldId: HOME, newId: FOCUS_B, tabId: TAB_A }],
      'история повёрнута только для B; для A поворота нет',
    );
  });

  it('refreshFocusOrNull (для A) в полёте, затем setFocus(B): фон не перезаписывает выбор', async () => {
    // Текущий фокус — A: фон перечитывает именно его.
    store.update({ focus: focusResponse(FOCUS_A, 'Мысль A (старая)') } as any);
    const refreshPromise = resync.refreshFocusOrNull(NET_A);
    await flushMicrotasks();
    // ...пользователь за это время выбрал B (ответ B ещё в полёте).
    const setPromise = app.setFocus(FOCUS_B);
    await flushMicrotasks();

    // Фон отвечает первым: его результат НЕ применяется — выбор пользователя
    // новее, даже если стор ещё показывает прежний фокус A.
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'A обновлён фоном'));
    const refreshed = await refreshPromise;

    assert.notEqual(refreshed, null, 'фон вернул прочитанный ответ');
    assert.equal(store.state.focus?.focused.id, FOCUS_A, 'стор ещё на прежнем фокусе');
    assert.equal(
      store.state.focus?.focused.title,
      'Мысль A (старая)',
      'фоновый ответ не применён: пользователь уже начал установку фокуса',
    );
    assert.notEqual(
      await activeFocusId(),
      FOCUS_A,
      'фон не переподписал окрестность на A',
    );

    // Ответ выбранной мысли приходит следом и публикуется нормально.
    resolveFocus(FOCUS_B, focusResponse(FOCUS_B, 'Мысль B'));
    await setPromise;
    assert.equal(store.state.focus?.focused.id, FOCUS_B, 'B опубликован');
    assert.equal(await activeFocusId(), FOCUS_B, 'подписка на B');
  });

  it('openNetwork(B) во время setFocus(A): поздний A не попадает в стор и историю сети B', async () => {
    const setPromise = app.setFocus(FOCUS_A);
    await flushMicrotasks();

    // Пользователь ушёл в другую сеть: openNetwork снимает прежний контекст и
    // грузит фокус B (id из снимка вкладки).
    const openPromise = app.openNetwork(NET_B);
    resolveFocus(FOCUS_B, focusResponse(FOCUS_B, 'Мысль B'));
    await openPromise;
    await waitFor(() => store.state.focus?.focused.id === FOCUS_B, 'фокус сети B опубликован');
    assert.equal(store.state.networkId, NET_B, 'открыта сеть B');
    assert.equal(await activeFocusId(), FOCUS_B, 'окрестность B подписана');

    // Запоздавший ответ установки фокуса в прежней сети.
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await setPromise;

    assert.equal(store.state.networkId, NET_B, 'сеть осталась B');
    assert.equal(store.state.focus?.focused.id, FOCUS_B, 'поздний A не попал в стор сети B');
    assert.equal(
      await activeFocusId(),
      FOCUS_B,
      'окрестность B не переподписана на A',
    );
    assert.equal(
      rotates.some((r) => r.newId === FOCUS_A),
      false,
      'история чужой вкладки не получила поворот для A',
    );
  });

  it('resetFocusToHome не публикует HOME, если пользователь уже начал свой фокус', async () => {
    // Сброс на HOME ждёт ответ фокуса HOME...
    const resetPromise = resync.resetFocusToHome(NET_A);
    await flushMicrotasks();
    // ...но пользователь успел выбрать B (его ответ приходит первым).
    const setPromise = app.setFocus(FOCUS_B);
    resolveFocus(FOCUS_B, focusResponse(FOCUS_B, 'Мысль B'));
    await setPromise;

    resolveFocus(ROOT_ID, focusResponse(ROOT_ID, 'HOME'));
    const reset = await resetPromise;

    assert.equal(reset, null, 'HOME не применён — операция устарела');
    assert.equal(store.state.focus?.focused.id, FOCUS_B, 'в сторе выбор пользователя');
    assert.equal(await activeFocusId(), FOCUS_B, 'подписка осталась на B');
  });

  it('регресс: обычная установка фокуса без вмешательства публикует мысль и историю', async () => {
    const promise = app.setFocus(FOCUS_A);
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await promise;

    assert.equal(store.state.focus?.focused.id, FOCUS_A);
    assert.equal(await activeFocusId(), FOCUS_A);
    assert.deepEqual(rotates, [{ oldId: HOME, newId: FOCUS_A, tabId: TAB_A }]);
  });

  it('disconnect() во время setFocus(A): поздний A не публикуется и после возврата в ту же пару', async () => {
    const promise = app.setFocus(FOCUS_A);
    await flushMicrotasks();

    await app.disconnect();
    // Переподключение восстанавливает ту же строку вкладки (tab_id с сервера) —
    // пара снова совпадает со снимком, поэтому поздний ответ обязан гасить seq.
    restoreSameScreenPair();

    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await promise;

    assert.equal(store.state.focus, null, 'поздний A не опубликован');
    assert.deepEqual(rotates, [], 'история не получила поворот для A');
    assert.equal(await activeFocusId(), null, 'окрестность не подписана на A');
  });

  it('backToNetworks() во время setFocus(A): поздний A не публикуется после возврата', async () => {
    const promise = app.setFocus(FOCUS_A);
    await flushMicrotasks();

    app.backToNetworks();
    restoreSameScreenPair();

    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await promise;

    assert.equal(store.state.focus, null, 'поздний A не опубликован');
    assert.deepEqual(rotates, [], 'история не получила поворот для A');
    assert.equal(await activeFocusId(), null, 'окрестность не подписана на A');
  });

  it('отказ thoughts.focus из строки панели выделенных: тост, фокус не меняется, rejection погашен', async () => {
    const selection = await import('../src/renderer/selection/selection.js');
    const host = new ShimElement('div');
    const teardown = selection.mountSelection(host as unknown as HTMLElement);
    try {
      const reasons = await collectUnhandled(async () => {
        selection.toggleSelection([FOCUS_A]);
        await flushMicrotasks();
        const row = host.querySelector('.selection-item');
        assert.ok(row !== null, 'строка выделения построена');
        row.emit('click');
        // Одиночный клик облачка отложен на 220 мс — окно двойного клика;
        // дожидаемся его реальным таймером, иначе гейт отказа ещё не создан.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, SINGLE_CLICK_DELAY_MS + 40),
        );
        assert.ok(focusCalls.includes(FOCUS_A), 'клик по строке запросил фокус');
        failFocus(FOCUS_A, new Error('Сеть недоступна'));
      });

      assert.deepEqual(reasons, [], 'unhandled rejection нет');
      const toast = errorToast();
      assert.ok(toast !== null, 'тост об отказе показан');
      assert.match(toast.flatText(), /Сеть недоступна/u);
      assert.equal(store.state.focus?.focused.id, HOME, 'фокус не изменился');
      assert.deepEqual(rotates, [], 'история не тронута');
    } finally {
      teardown();
    }
  });

  it('отказ thoughts.focus в focusThoughtOnMap: тост, экран «Карта», фокус не меняется', async () => {
    const active = await import('../src/renderer/screens/active-view.js');
    store.update({ activeView: 'structures' } as any);

    const reasons = await collectUnhandled(async () => {
      const promise = active.focusThoughtOnMap(FOCUS_A);
      failFocus(FOCUS_A, new Error('focus offline'));
      // Промис не отклоняется — иначе вызов из void-обработчика дал бы
      // unhandled rejection и «молчащий» интерфейс.
      await promise;
    });

    assert.deepEqual(reasons, [], 'unhandled rejection нет');
    const toast = errorToast();
    assert.ok(toast !== null, 'тост об отказе показан');
    assert.match(toast.flatText(), /focus offline/u);
    assert.equal(store.state.activeView, 'map', 'экран переключён на карту');
    assert.equal(store.state.focus?.focused.id, HOME, 'фокус не изменился');
    assert.deepEqual(rotates, [], 'история не тронута');
  });
});
