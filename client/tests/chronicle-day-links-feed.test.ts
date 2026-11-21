/**
 * «Дневник»: день без своих записей, но со «связями дня», — отдельная секция
 * ленты (замечание финальной приёмки 399c25d5; требование 1fb1047d).
 *
 * Требование: «День/неделя показывают записи и „Связи дня“». Раньше секции
 * строились только по записям, и день, у которого записей нет, а связи есть,
 * не показывался вовсе. Здесь экран монтируется ЦЕЛИКОМ на DOM-шиме (как
 * `chronicle-default-period.test.ts`): лента пуста, а чтение «связей дня»
 * отдаёт факт за сегодня — значит, в ленте обязана появиться секция дня с
 * видимым блоком связей.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CHRONICLE_PAGE_SIZE, type DayLinksResult } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET = '00000000-0000-4000-8000-0000000000e1';

/** Тела запросов ленты (журнал: экран действительно спросил период). */
const queries: any[] = [];
/** Дни, за которые экран просил «связи дня». */
const dayLinkRanges: Array<{ from: string; to: string }> = [];

/** Сегодняшний локальный день — его отдаёт чтение связей и ждёт лента. */
let today = '';

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
        thought_id: 't-stol',
        title: 'Стол кухонный',
        property_id: 'p-bought',
        property_name: 'дата приобретения',
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
    // Записей за период НЕТ — день в ленте может появиться только по связям.
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

/** Дождаться асинхронных чтений ленты и «связей дня» с их продолжениями. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
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

beforeEach(() => {
  queries.length = 0;
  dayLinkRanges.length = 0;
  today = diaryMod.todayLocal();
});

afterEach(() => {
  if (mountedScreen !== null) {
    mountedScreen();
    mountedScreen = null;
  }
  panelMod.unmountChronicleFilterPanel();
  catalogueMod.resetPropertyCatalogue();
});

describe('«Дневник»: день только со «связями дня» (замечание 399c25d5)', () => {
  it('лента просит период, а день без записей появляется секцией с блоком связей', async () => {
    await mountDiary('tab-dl-1');

    assert.ok(
      queries.some((query) => query?.limit === CHRONICLE_PAGE_SIZE),
      'лента запрошена',
    );
    assert.deepEqual(dayLinkRanges, [{ from: today, to: today }], 'связи дня — за период ленты');

    const sections = host.querySelectorAll('.diary-day');
    assert.equal(sections.length, 1, 'секция дня построена, хотя записей нет');
    const section = sections[0]!;
    assert.equal(section.dataset['day'], today, 'секция — за сегодняшний день');
    assert.equal(
      section.querySelector('.diary-day-head')?.textContent,
      diaryMod.formatDayLabel(today),
      'заголовок дня на месте',
    );
    assert.equal(section.querySelectorAll('.diary-record').length, 0, 'записей в дне нет');

    const block = section.querySelector('.diary-day-links');
    assert.ok(block !== null, 'блок «Связи дня» есть в секции');
    assert.equal(block!.hidden, false, 'блок связей показан');
    assert.equal(
      block!.querySelector('.diary-day-link-fact')?.textContent?.includes('Стол кухонный'),
      true,
      'факт дня показан в блоке связей',
    );
  });
});
