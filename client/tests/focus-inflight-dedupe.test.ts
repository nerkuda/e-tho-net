/**
 * Красный/зелёный гейт ошибки dc723634 — «Фриз рендерера ~15 с при двойном
 * клике по облачку (гонка параллельных setFocus)».
 *
 * Симптом (журнал клиента): сервер отвечает за 4 мс, а метка `ui.focus.applied`
 * несёт `ms:15808`; перед каждым фризом — два `ui.cloud.click` через 1–2 мс и
 * два запроса `thoughts/focus` ОДНОЙ мысли. Две параллельные цепочки установки
 * фокуса тянут сеть, историю и перерисовку карты одновременно.
 *
 * Гейт проверяет четыре инварианта фикса:
 *   1. второй `setFocus` той же мысли, пока первая установка в полёте, НЕ
 *      заводит вторую цепочку: один запрос фокуса, один поворот истории, одна
 *      метка `ui.focus.applied`; метка `ui.focus.noop` (reason
 *      `focus_in_flight`) объясняет журналу, что клик не потерян;
 *   2. номер операции `beginFocusOp` берёт только первый запуск — иначе
 *      дедуплицированный клик отменил бы собственную же цепочку и фокус не
 *      применился бы (проверяется тем же кейсом: применение обязано быть);
 *   3. отмена устаревших ответов не сломана: выбор ДРУГОЙ мысли дедупликации не
 *      подлежит, а поздний ответ прежней мысли по-прежнему не публикуется;
 *   4. сегментные замеры называют виновника: нога дольше порога пишется меткой
 *      `ui.slow_segment`, а `ui.focus.applied` несёт длительности всех ног.
 *
 * Гейт прогоняет РЕАЛЬНЫЕ `app.ts`/`layer-resync.ts` на подставном мосте
 * `window.etn` с отложенными ответами `thoughts.focus` (тот же приём, что у
 * `focus-currency.test.ts`).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { FocusNeighbor, FocusResponse, Thought, ThoughtRef } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { SLOW_SEGMENT_MS } from '../src/renderer/lib/slow-segment.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET_A = '00000000-0000-4000-8000-00000000000a';
const TAB_A = 'tab-a';
const HOME = '00000000-0000-4000-8000-000000000001';
const FOCUS_A = '00000000-0000-4000-8000-0000000000a01';
const FOCUS_B = '00000000-0000-4000-8000-0000000000b01';
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

/** Минимальный DOM-шим (тот же набор, что у `focus-currency`). */
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
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
    ...extra,
  };
}

/** Легковесная карточка мысли — ответ `thoughts.resolve`. */
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

function focusResponse(id: string, title: string, children: FocusNeighbor[] = []): FocusResponse {
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

/** Записанные метки журнала (`window.etn.logEvent`). */
let events: Array<{ name: string; data?: Record<string, unknown> }> = [];
/** Записанные повороты истории (`etn.history.rotate`). */
let rotates: Array<{ oldId: string; newId: string; tabId: string | null }> = [];
/** Отложенные ответы `thoughts.focus` по id мысли. */
let focusGates: Map<string, Deferred<FocusResponse>> = new Map();
/** Все вызовы `thoughts.focus` в порядке обращения — счётчик цепочек. */
let focusCalls: string[] = [];

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

/** Полный мост `window.etn` для путей фокуса (образец — `focus-currency`). */
function stubEtn(): void {
  const win = (globalThis as any).window as Record<string, unknown>;
  win.etn = {
    logEvent: (name: string, data?: Record<string, unknown>) => {
      events.push({ name, data });
    },
    server: {
      connect: async () => ({ id: 'user-1' }),
      disconnect: async () => undefined,
      listProfiles: async () => [],
      connectPrefill: async () => null,
      getStatus: async () => 'idle',
    },
    networks: {
      open: async (networkId: string) => ({ id: networkId, display_name: `Сеть ${networkId}` }),
      getPreferences: async () => [],
      list: async () => [{ id: NET_A, display_name: 'Сеть A' }],
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
      list: async () => [],
      open: async () => ({
        tab_id: TAB_A,
        slot_idx: 0,
        network_id: NET_A,
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
      query: async () => ({ items: [thought(HOME, 'HOME', { is_root: true })], total: 1 }),
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
      resolve: async (_networkId: string, ids: string[]) =>
        ids.map((id) => thoughtRef(id, `T:${id}`)),
      neighbors: async () => [],
      neighborsPage: async () => ({ items: [], total: 0 }),
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

/** Метки журнала с этим именем. */
function eventsNamed(name: string): Array<{ name: string; data?: Record<string, unknown> }> {
  return events.filter((event) => event.name === name);
}

/** Подмена «часов» замеров: длительность сегмента задаётся сдвигом счётчика. */
const realPerformance = globalThis.performance;

function stubClock(now: () => number): void {
  Object.defineProperty(globalThis, 'performance', {
    value: { now },
    configurable: true,
    writable: true,
  });
}

function restoreClock(): void {
  Object.defineProperty(globalThis, 'performance', {
    value: realPerformance,
    configurable: true,
    writable: true,
  });
}

type AppModule = typeof import('../src/renderer/app.js');
type ResyncModule = typeof import('../src/renderer/lib/layer-resync.js');
type StoreModule = typeof import('../src/renderer/state.js').store;

let app: AppModule;
let store: StoreModule;
let resync: ResyncModule;

async function prepare(): Promise<void> {
  events = [];
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
  restoreClock();
  resync.deactivateFocusQuery();
  app.backToNetworks();
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('двойной клик по облачку (dc723634): одна цепочка установки фокуса', () => {
  it('второй setFocus той же мысли в полёте не заводит вторую цепочку', async () => {
    const first = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    // Двойной клик: второй вызов той же мысли, пока первый ответ в полёте.
    const second = app.setFocus(FOCUS_A);
    await flushMicrotasks();

    assert.deepEqual(focusCalls, [FOCUS_A], 'запрос фокуса один — вторая цепочка не заведена');

    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await Promise.all([first, second]);

    assert.equal(store.state.focus?.focused.id, FOCUS_A, 'фокус применён');
    assert.deepEqual(
      rotates,
      [{ oldId: HOME, newId: FOCUS_A, tabId: TAB_A }],
      'поворот истории один',
    );
    assert.equal(eventsNamed('ui.focus.applied').length, 1, 'метка применения одна');
    assert.equal(eventsNamed('ui.slow_segment').length, 0, 'быстрый путь медленных меток не пишет');

    // Дедуплицированный клик не потерян для журнала и помечен причиной.
    const noops = eventsNamed('ui.focus.noop');
    assert.equal(noops.length, 1, 'второй клик отмечен как no-op');
    assert.equal(noops[0]?.data?.['reason'], 'focus_in_flight', 'причина — установка в полёте');
  });

  it('дедуплицированный клик не отменяет идущую цепочку (номер операции у первого)', async () => {
    const first = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    const second = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await Promise.all([first, second]);

    // Если бы второй вызов брал свой `beginFocusOp`, первый стал бы «устаревшим»
    // и не дошёл до публикации: фокус остался бы HOME, а метки применения не было.
    assert.equal(
      eventsNamed('ui.focus.applied').length,
      1,
      'цепочка дошла до применения — поколение не сдвинуто вторым кликом',
    );
    assert.equal(store.state.focus?.focused.id, FOCUS_A, 'фокус в сторе — выбранная мысль');
  });

  it('после завершения цепочки повторный фокус той же мысли снова идёт в сеть', async () => {
    const first = app.setFocus(FOCUS_A);
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await first;

    const again = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    assert.deepEqual(
      focusCalls,
      [FOCUS_A, FOCUS_A],
      'стража «в полёте» снят по завершении — новый выбор мысли читается заново',
    );
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await again;
    assert.equal(store.state.focus?.focused.id, FOCUS_A);
  });

  it('другая мысль не дедуплицируется, а поздний ответ прежней не публикуется', async () => {
    const a = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    const b = app.setFocus(FOCUS_B);
    await flushMicrotasks();
    assert.deepEqual(focusCalls, [FOCUS_A, FOCUS_B], 'разные мысли — две цепочки');

    resolveFocus(FOCUS_B, focusResponse(FOCUS_B, 'Мысль B'));
    await b;
    assert.equal(store.state.focus?.focused.id, FOCUS_B, 'B опубликован');

    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await a;
    assert.equal(store.state.focus?.focused.id, FOCUS_B, 'поздний ответ A не перезаписал B');
    assert.equal(
      rotates.some((rotate) => rotate.newId === FOCUS_A),
      false,
      'история не получила поворот для устаревшего A',
    );
  });

  it('повторный клик по мысли, чья цепочка уже устарела, — новый запуск', async () => {
    const a = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    const b = app.setFocus(FOCUS_B);
    await flushMicrotasks();
    // Пользователь вернулся к A: в полёте уже B, поэтому A запускается заново
    // (дедупликация знает только ПОСЛЕДНЮЮ цепочку — иначе клик терялся бы).
    const aAgain = app.setFocus(FOCUS_A);
    await flushMicrotasks();
    assert.deepEqual(focusCalls, [FOCUS_A, FOCUS_B, FOCUS_A], 'третий запуск ушёл в сеть');

    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await Promise.all([a, aAgain]);
    assert.equal(store.state.focus?.focused.id, FOCUS_A, 'новейший A опубликован');

    resolveFocus(FOCUS_B, focusResponse(FOCUS_B, 'Мысль B'));
    await b;
    assert.equal(store.state.focus?.focused.id, FOCUS_A, 'устаревший B не перезаписал A');
  });

  it('медленный сегмент назван в журнале, а метка применения несёт все ноги', async () => {
    // Часы замеров: ожидание записи истории «длится» дольше порога.
    let clock = 1000;
    stubClock(() => clock);
    const win = (globalThis as any).window as Record<string, any>;
    const rotate = win.etn.history.rotate as (
      o: string,
      n: string,
      t: string | null,
    ) => Promise<void>;
    win.etn.history.rotate = async (oldId: string, newId: string, tabId: string | null) => {
      await rotate(oldId, newId, tabId);
      clock += SLOW_SEGMENT_MS + 200;
    };

    const focus = app.setFocus(FOCUS_A);
    resolveFocus(FOCUS_A, focusResponse(FOCUS_A, 'Мысль A'));
    await focus;

    const slow = eventsNamed('ui.slow_segment');
    assert.equal(slow.length, 1, 'медленный сегмент — одна метка');
    assert.equal(slow[0]?.data?.['name'], 'focus.history', 'виновник назван: запись истории');
    assert.equal(slow[0]?.data?.['ms'], SLOW_SEGMENT_MS + 200, 'длительность сегмента в метке');

    const applied = eventsNamed('ui.focus.applied');
    assert.equal(applied.length, 1, 'метка применения одна');
    const seg = applied[0]?.data?.['seg'] as Record<string, number> | undefined;
    assert.ok(seg !== undefined, 'метка применения несёт длительности ног');
    assert.equal(seg['history'], SLOW_SEGMENT_MS + 200, 'нога истории измерена');
    assert.equal(seg['request'], 0, 'ожидание ответа фокуса не приписано истории');
  });
});
