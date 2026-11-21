/**
 * «Дневник»: смена периода без дёрганья ленты (0.16.1, пачка 9, задача
 * ef6d1aab).
 *
 * Пользователь: при выборе даты в календаре лента «очищается», затем в ней
 * появляются мелкие строки и только потом — новое содержимое. Причины по коду:
 *   1. `reload` показывал «Загрузка…» даже когда уже отрисованные строки были
 *      на экране (статус мелькал поверх прежней ленты);
 *   2. «связи дня» доезжали ВТОРЫМ асинхронным проходом после `renderFeed` —
 *      блоки дня (и дни, живущие только связями) появлялись отдельной
 *      отрисовкой.
 *
 * Ожидание после правки: пока новый период не собран (записи + связи дня),
 * лента показывает прежнее содержимое; затем происходит ОДНА отрисовка, в
 * которой уже есть и записи, и связи дня. Статус загрузки — только когда
 * показывать нечего. Сброс прокрутки и хвост «осталось N» сохранены.
 *
 * Экран монтируется целиком на DOM-шиме (как `day-links-refresh.test.ts`),
 * отрисовки считаются по пересборке хвоста ленты: `renderFeed` каждый раз
 * заново монтирует «пусто»/«осталось N» (вне keyed-блока).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { type DayLinksResult } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET = '00000000-0000-4000-8000-0000000000e2';
const THOUGHT_ID = 't-fact';

/** Тела запросов ленты (журнал применённого периода). */
const queries: any[] = [];
/** Периоды, за которые читались «связи дня». */
const dayLinkRanges: Array<{ from: string; to: string }> = [];
/** Текущий день фейковой ленты (меняется тестом перед сменой периода). */
let feedDay = '';
/** День датового факта «связей дня». */
let linksDay = '';
/** Держатель ответа `dayLinks` (проверка «до отрисовки дождались связей»). */
let linksHold: { promise: Promise<void>; release: () => void } | null = null;

function installShims(bridge: Dict): void {
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    body: new ShimElement('body'),
    documentElement: {
      style: { setProperty: () => undefined, removeProperty: () => undefined },
      classList: new ShimElement('html').classList,
    },
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

/** Строка ленты за день (поля, которые читает рендер). */
function rowFor(day: string): any {
  const local = new Date(`${day}T10:00:00`);
  const from = local.toISOString();
  return {
    id: `r-${day}`,
    title: `Запись ${day}`,
    valid_from: from,
    valid_to: from,
    use_time: false,
    version: 1,
    created_at: from,
    updated_at: from,
    created_by: 'u',
    updated_by: 'u',
    snippet: `Запись ${day}`,
    body_html: `<p>Тело ${day}</p>`,
    targets: [],
  };
}

/** Один датовый факт за день (связи дня). */
function dayLinksFor(day: string): DayLinksResult {
  return {
    facts: [
      {
        day,
        thought_id: THOUGHT_ID,
        title: 'Стол кухонный',
        property_id: 'p-bought',
        property_name: 'дата приобретения',
        value: day,
      },
    ],
    links: [],
  };
}

installShims({
  ui: { getState: async () => null, setState: async () => undefined },
  tabs: { updateState: async () => undefined, list: async () => [] },
  propertyRegistry: { list: async () => [] },
  chronicle: {
    query: async (_networkId: string, filter: any) => {
      queries.push(filter);
      // Одна строка на первой странице, `total` больше — хвост «осталось N»
      // существует, а вторая страница пуста (без дублей ключей).
      const rows = filter?.offset === 0 ? [rowFor(feedDay)] : [];
      return { rows, total: 2, warnings: null };
    },
    dayLinks: async (_networkId: string, range: { from: string; to: string }) => {
      dayLinkRanges.push(range);
      const hold = linksHold;
      if (hold !== null) {
        linksHold = null;
        await hold.promise;
      }
      return dayLinksFor(linksDay);
    },
  },
  chronicleFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
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

/** Дождаться асинхронных чтений ленты/связей дня и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let mountedScreen: (() => void) | null = null;
let host: ShimElement;

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

/** Ячейка календаря по дате. */
function dayCell(day: string): ShimElement {
  const cell = host
    .querySelectorAll('.cal-day')
    .find((node) => ((node as unknown as { title?: string }).title ?? '') === day);
  assert.notEqual(cell, undefined, `в календаре есть ячейка ${day}`);
  return cell!;
}

/** День выбранной клетки, отличный от сегодняшнего (в текущем месяце). */
function otherDayOfMonth(today: string): string {
  const month = today.slice(0, 7);
  const candidate = `${month}-10`;
  return candidate === today ? `${month}-11` : candidate;
}

/** Секции дней ленты: `data-day` в порядке DOM. */
function renderedDays(): string[] {
  return host.querySelectorAll('.diary-day').map((section) => section.dataset['day'] ?? '');
}

interface FeedSpy {
  /** Сколько раз пересобран хвост ленты — столько было `renderFeed`. */
  renders: () => number;
  /** Смены видимости статуса (`false` — статус показан). */
  statusShows: () => boolean[];
}

/** Навесить журналы на ленту и статус: отрисовки считаются по хвосту. */
function spyFeed(): FeedSpy {
  const list = host.querySelector('.chron-feed')!;
  const status = host.querySelector('.chron-feed-status')!;
  let renders = 0;
  const shows: boolean[] = [];
  const appendChild = list.appendChild.bind(list);
  list.appendChild = (node: ShimElement) => {
    if (
      node.classList?.contains('chron-feed-more') ||
      node.classList?.contains('chron-feed-empty')
    ) {
      renders += 1;
    }
    return appendChild(node);
  };
  let hidden = status.hidden;
  Object.defineProperty(status, 'hidden', {
    configurable: true,
    get: () => hidden,
    set: (value: boolean) => {
      hidden = value;
      shows.push(value);
    },
  });
  return { renders: () => renders, statusShows: () => shows };
}

beforeEach(() => {
  queries.length = 0;
  dayLinkRanges.length = 0;
  linksHold = null;
  feedDay = diaryMod.todayLocal();
  linksDay = feedDay;
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

describe('«Дневник»: смена периода — одна отрисовка, без мелькания (ef6d1aab)', () => {
  it('пока связи дня не пришли, лента держит прежнее; затем одна отрисовка с записями и связями', async () => {
    await mountDiary('tab-ps-1');
    await flush();
    const today = diaryMod.todayLocal();
    const target = otherDayOfMonth(today);
    assert.deepEqual(renderedDays(), [today], 'исходная лента — сегодняшний день');
    assert.equal(dayCell(today).classList.contains('is-selected'), true, 'сегодня выделено');

    const spy = spyFeed();
    const wrap = host.querySelector('.chron-feed-wrap')!;
    wrap.scrollTop = 120;
    // Новая пара: запись и факт дня — за выбранную дату; связи дня держим.
    feedDay = target;
    linksDay = target;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    linksHold = { promise: gate, release };
    const queryBefore = queries.length;
    const rendersBefore = spy.renders();

    dayCell(target).click();
    await flush();

    // Ответ ленты пришёл, связи дня ещё нет: НИ одной отрисовки не было —
    // на экране прежнее содержимое, статус загрузки не показывался.
    assert.ok(queries.length > queryBefore, 'лента запрошена за новый период');
    assert.deepEqual(
      renderedDays(),
      [today],
      'прежняя лента не очищается до сборки нового периода',
    );
    assert.equal(spy.renders(), rendersBefore, 'отрисовки нет, пока связи дня не пришли');
    assert.ok(
      !spy.statusShows().includes(false),
      'статус «Загрузка…» не мелькал при непустой ленте',
    );
    assert.deepEqual(
      dayLinkRanges.at(-1),
      { from: target, to: target },
      'связи дня читаются за НОВЫЙ период ещё до отрисовки',
    );
    assert.equal(wrap.scrollTop, 120, 'прокрутка не сброшена до отрисовки');

    release();
    await flush();

    // Одна отрисовка: хвост пересобран ровно один раз, в ленте — только новый
    // день, и в нём сразу и запись, и «связи дня».
    assert.equal(spy.renders(), rendersBefore + 1, 'ровно одна отрисовка ленты на период');
    assert.deepEqual(renderedDays(), [target], 'в ленте только день нового периода');
    const section = host.querySelector(`.diary-day[data-day="${target}"]`)!;
    assert.deepEqual(
      section.querySelectorAll('.diary-record').map((card) => card.dataset['rowKey']),
      [`r-${target}`],
      'запись нового периода отрисована',
    );
    assert.deepEqual(
      section.querySelectorAll('.diary-day-link-caption').map((node) => node.flatText().trim()),
      ['дата приобретения'],
      'связи дня появились вместе с лентой, а не вторым проходом',
    );
    assert.ok(
      !spy.statusShows().includes(false),
      'статус так и не показывался (было что показывать всё время)',
    );
    assert.equal(wrap.scrollTop, 0, 'смена периода показывает ленту с начала');
    const tail = host.querySelector('.chron-feed-more');
    assert.notEqual(tail, null, 'хвост «осталось N» на месте');
    assert.match(tail!.flatText(), /из 2|2/, 'счётчик дозагрузки показывает серверный total');
  });
});
