/**
 * «Дневник»: смена датового свойства мысли обновляет «связи дня» (0.16.1,
 * план тестирования `7e12f589`, раздел «Протестировать свойства типа „дата“»:
 * «при изменении даты меняется список мыслей с датами»).
 *
 * «Связи дня» — отдельное индексное чтение (`etn.chronicle.dayLinks`) поверх
 * датовой проекции, а не часть ленты записей. Первое событие свойства
 * (`property-value.set`) гасит ключ `focus:@<id>`; лента записей на него не
 * перезапрашивается (её содержимое не изменилось), но блоки связей обязаны
 * перечитаться — иначе день показывает устаревший факт до ручного «Обновить».
 *
 * Экран монтируется целиком на DOM-шиме (как `chronicle-day-links-feed.test.ts`),
 * событие проходит через штатный роутер слоя данных (`routeRealtimeEvent`), а не
 * подсовывается экрану напрямую.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CHRONICLE_PAGE_SIZE, type DayLinksResult } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET = '00000000-0000-4000-8000-0000000000e1';
/** Мысль-носитель датового свойства (факт дня). */
const THOUGHT_ID = 't-stol';

/** Тела запросов ленты (журнал: экран действительно спросил период). */
const queries: any[] = [];
/** Дни, за которые экран просил «связи дня». */
const dayLinkRanges: Array<{ from: string; to: string }> = [];

/** Сегодняшний локальный день — его отдаёт чтение связей и ждёт лента. */
let today = '';
/**
 * Подпись свойства в факте дня. Меняется между чтениями: так тест видит, что
 * блок перечитан, а не переиспользован из первого снапшота.
 */
let propertyName = 'дата приобретения';

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

/** «Связи дня»: один датовый факт за сегодня, date-ссылок нет. */
function dayLinks(): DayLinksResult {
  return {
    facts: [
      {
        day: today,
        thought_id: THOUGHT_ID,
        title: 'Стол кухонный',
        property_id: 'p-bought',
        property_name: propertyName,
        value: today,
      },
    ],
    links: [],
  };
}

installShims({
  ui: { getState: async () => null, setState: async () => undefined },
  tabs: {
    updateState: async () => undefined,
    list: async () => [],
  },
  propertyRegistry: { list: async () => [] },
  chronicle: {
    // Записей за период НЕТ — день в ленте существует только по связям.
    query: async (_networkId: string, filter: any) => {
      queries.push(filter);
      return { rows: [], total: 0, warnings: null };
    },
    dayLinks: async (_networkId: string, range: { from: string; to: string }) => {
      dayLinkRanges.push(range);
      return dayLinks();
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
const diaryMod = await import('../src/renderer/screens/chronicle/diary.js');
const catalogueMod = await import('../src/renderer/lib/property-catalogue.js');
const routerMod = await import('../src/renderer/lib/live/event-router.js');

/** Дождаться асинхронных чтений ленты и «связей дня» с их продолжениями. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Подождать окно дебаунса перечитывания блока и его продолжения. */
async function settleDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 320));
  await flush();
}

let mountedScreen: (() => void) | null = null;
let host: ShimElement;

/** Смонтировать экран с состоянием вкладки «снимка нет» (период — сегодня). */
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
  host = new ShimElement('div');
  mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
  await chronicleMod.ensureChronicleInitialised();
  await flush();
}

/** Подписи свойств в блоке «связи дня» сегодняшней секции. */
function factCaptions(): string[] {
  const section = host.querySelector(`.diary-day[data-day="${today}"]`);
  if (section === null) return [];
  return section.querySelectorAll('.diary-day-link-caption').map((node) => node.flatText().trim());
}

/** Событие смены датового свойства мысли — штатное realtime-событие сети. */
function propertySetEvent(seq: number): any {
  return {
    type: 'property-value.set',
    seq,
    ts: '2026-11-20T09:00:00.000Z',
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    data: {
      owner_type: 'thought',
      owner_id: THOUGHT_ID,
      property_id: 'p-bought',
      value: today,
    },
    layer_id: '00000000-0000-0000-0000-000000000000',
  };
}

beforeEach(() => {
  queries.length = 0;
  dayLinkRanges.length = 0;
  propertyName = 'дата приобретения';
  today = diaryMod.todayLocal();
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

describe('«Дневник»: связи дня перечитываются при смене датового свойства (7e12f589)', () => {
  it('property-value.set обновляет блок связей через штатное перечитывание ленты', async () => {
    await mountDiary('tab-dl-refresh-1');
    // Экран досчитывает собственные отложенные перезапросы монтирования —
    // базовые числа снимаем только по наступившему покою.
    await settleDebounce();
    await settleDebounce();

    assert.ok(
      queries.some((query) => query?.limit === CHRONICLE_PAGE_SIZE),
      'лента запрошена при монтировании',
    );
    const dayLinksBefore = dayLinkRanges.length;
    assert.ok(dayLinksBefore >= 1, 'связи дня прочитаны за период ленты');
    assert.deepEqual(factCaptions(), ['дата приобретения'], 'в блоке — факт первого чтения');
    const feedQueries = queries.length;

    // Свойство переименовано/пересчитано: следующее чтение отдаёт другую подпись.
    propertyName = 'дата продажи';
    const routed = routerMod.routeRealtimeEvent(propertySetEvent(1));
    assert.equal(routed.routed, true, 'событие свойства прошло штатный роутер');
    // Мотивация теста: свойство мысли гасит префикс `chronicle-feed` (роутер,
    // `NEIGHBOURHOOD_KEYS`), поэтому лента перезапрашивается, а «связи дня»
    // перечитываются штатным путём её перезапроса — отдельной проводки нет.
    assert.ok(
      routed.invalidated.some((key) => key.startsWith('chronicle-feed')),
      'слой гасит ленту «Дневника» на событие свойства',
    );
    await settleDebounce();

    assert.deepEqual(
      factCaptions(),
      ['дата продажи'],
      'блок «связи дня» перечитан: факт дня обновлён без ручного «Обновить»',
    );
    assert.equal(dayLinkRanges.length, dayLinksBefore + 1, 'чтение связей дня выполнено повторно');
    assert.deepEqual(
      dayLinkRanges[dayLinkRanges.length - 1],
      { from: today, to: today },
      'период чтения не изменился',
    );
    assert.equal(
      queries.length,
      feedQueries + 1,
      'пачка из одного события дала ровно один перезапрос ленты (окно дебаунса)',
    );
  });

  it('пачка событий свойства даёт ОДНО перечитывание связей дня', async () => {
    await mountDiary('tab-dl-refresh-2');
    await settleDebounce();
    await settleDebounce();
    const before = dayLinkRanges.length;
    const feedQueries = queries.length;

    routeRealtimeEventSafe(2);
    routeRealtimeEventSafe(3);
    routeRealtimeEventSafe(4);
    await settleDebounce();

    assert.equal(dayLinkRanges.length, before + 1, 'дебаунс собрал пачку в одно чтение');
    assert.equal(queries.length, feedQueries + 1, 'пачка дала один перезапрос ленты');
  });

  /** Событие с уникальным seq (роутер отбрасывает опоздавшие). */
  function routeRealtimeEventSafe(seq: number): void {
    routerMod.routeRealtimeEvent(propertySetEvent(seq));
  }
});
