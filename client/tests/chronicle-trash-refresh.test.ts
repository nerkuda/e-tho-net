/**
 * «Дневник»: события корзины и удаления перечитывают ленту, «связи дня» и
 * маркеры календаря (0.16.1, пачка 11, задача 173e8368).
 *
 * **Что было.** Удаление мысли/связи, помещение в корзину и возврат из неё не
 * меняют ревизию комментариев — лента и календарь держали старые строки до
 * ручного «Применить»/переоткрытия вида.
 *
 * **Что стало.** Экран подписан на routed-события смены видимости корзины
 * (`lib/live/trash-events.ts`) и перечитывает себя тем же путём, что
 * инвалидация слоя: `scheduleChronicleFeedRefresh()` → сохранение глубины
 * ленты, «связи дня» и маркеры календаря. Новых типов событий не заведено.
 *
 * Тест монтирует экран целиком на DOM-шиме и считает сетевые чтения.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET = '00000000-0000-4000-8000-0000000000e1';

/** Счётчики сетевых чтений экрана. */
const calls = { query: 0, dayLinks: 0, markers: 0 };

/** Пустой ответ маркеров месяца. */
function emptyMarkers(): Dict {
  return {
    record_spans: [],
    task_days: [],
    task_day_counts: {},
    overdue_days: [],
    overdue_day_counts: {},
    fact_days: [],
    fact_day_counts: {},
    reminder_instants: [],
  };
}

function installShims(bridge: Dict): void {
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    documentElement: { style: {}, classList: new ShimElement('html').classList },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  } satisfies Dict;
  const win = ((globalThis as Dict).window ?? ((globalThis as Dict).window = {})) as Dict;
  win.innerWidth = 1400;
  win.innerHeight = 900;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.setInterval = setInterval;
  win.clearInterval = clearInterval;
  win.requestAnimationFrame = (fn: () => void) => {
    fn();
    return 1;
  };
  win.cancelAnimationFrame = () => undefined;
  win.etn = bridge;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  (globalThis as Dict).ResizeObserver = class {
    observe(): void {
      /* раскладки в шиме нет */
    }
    unobserve(): void {
      /* раскладки в шиме нет */
    }
    disconnect(): void {
      /* раскладки в шиме нет */
    }
  };
  (globalThis as Dict).requestAnimationFrame = win.requestAnimationFrame;
  (globalThis as Dict).localStorage = win.localStorage;
}

installShims({
  ui: { getState: async () => null, setState: async () => undefined },
  tabs: {
    updateState: async () => undefined,
    list: async () => [],
  },
  propertyRegistry: { list: async () => [] },
  chronicle: {
    query: async () => {
      calls.query += 1;
      return { rows: [], total: 0, warnings: null };
    },
    dayLinks: async () => {
      calls.dayLinks += 1;
      return { facts: [], links: [] };
    },
    calendarMarkers: async () => {
      calls.markers += 1;
      return emptyMarkers();
    },
  },
  chronicleFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
  // HOME экрана (`findRootThought`) и минимальный шим транзитивных вызовов.
  structures: {
    query: async () => ({
      items: [{ id: 'home-root' }],
      total: 1,
      directions: {},
      next_cursor: null,
    }),
  },
  thoughts: { get: async () => ({ id: 'home-root' }), resolve: async () => [] },
  savedFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
});

const stateMod = await import('../src/renderer/state.js');
const panelMod = await import('../src/renderer/screens/chronicle/filter-panel.js');
const chronicleMod = await import('../src/renderer/screens/chronicle/chronicle.js');
const catalogueMod = await import('../src/renderer/lib/property-catalogue.js');
const routerMod = await import('../src/renderer/lib/live/event-router.js');

/** Дождаться асинхронных чтений экрана и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Подождать окно дебаунса перечитывания ленты (250 мс) с запасом. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let mountedScreen: (() => void) | null = null;

/** Смонтировать экран «Дневника» (период — сегодня). */
async function mountDiary(tabId: string): Promise<void> {
  stateMod.store.update({
    networkId: NET,
    network: null,
    activeView: 'chronicle',
    screen: 'workspace',
    tabs: [{ tab_id: tabId, network_id: NET, chronicle_state: null }] as any,
    activeTabId: tabId,
    rtStatusByNetwork: { [NET]: 'connected' },
  } as any);
  const host = new ShimElement('div');
  mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
  await chronicleMod.ensureChronicleInitialised();
  await flush();
}

/** Событие смены видимости корзины через реальный маршрутизатор. */
function trashEvent(seq: number, type: string, data: Dict): void {
  routerMod.routeRealtimeEvent({ type, network_id: NET, seq, data } as any);
}

beforeEach(() => {
  calls.query = 0;
  calls.dayLinks = 0;
  calls.markers = 0;
  routerMod.resetEventRouter();
});

afterEach(() => {
  if (mountedScreen !== null) {
    mountedScreen();
    mountedScreen = null;
  }
  panelMod.unmountChronicleFilterPanel();
  catalogueMod.resetPropertyCatalogue();
});

describe('«Дневник»: перечитывание по событиям корзины (пачка 11)', () => {
  it('удаление мысли перечитывает ленту, «связи дня» и маркеры календаря', async () => {
    await mountDiary('tab-trash-1');
    const base = { ...calls };
    assert.ok(base.query >= 1, 'лента прочитана на старте');
    assert.ok(base.dayLinks >= 1, 'связи дня прочитаны на старте');
    assert.ok(base.markers >= 1, 'маркеры прочитаны на старте');

    trashEvent(1, 'thought.deleted', { id: 't1' });
    await wait(400);
    await flush();

    assert.equal(calls.query, base.query + 1, 'лента перечитана один раз');
    assert.equal(calls.dayLinks, base.dayLinks + 1, 'связи дня перечитаны');
    assert.equal(calls.markers, base.markers + 1, 'маркеры календаря перечитаны');
  });

  it('каскад событий корзины склеивается в один перезапрос', async () => {
    await mountDiary('tab-trash-2');
    const base = { ...calls };

    trashEvent(1, 'thought.deleted', { id: 't1' });
    trashEvent(2, 'link.deleted', { id: 'l1' });
    trashEvent(3, 'thought.updated', {
      id: 't2',
      version: 2,
      changes: { marked_for_deletion: true },
    });
    await wait(400);
    await flush();

    assert.equal(calls.query, base.query + 1, 'дебаунс склеил каскад');
    assert.equal(calls.dayLinks, base.dayLinks + 1);
    assert.equal(calls.markers, base.markers + 1);
  });

  it('правка мысли без marked_for_deletion ленту по корзине не перечитывает', async () => {
    await mountDiary('tab-trash-3');
    const base = { ...calls };

    trashEvent(1, 'thought.updated', { id: 't1', version: 2, changes: { title: 'Новое' } });
    await wait(400);
    await flush();

    assert.equal(calls.query, base.query, 'смена названия — не событие корзины');
    assert.equal(calls.dayLinks, base.dayLinks);
    assert.equal(calls.markers, base.markers);
  });
});
