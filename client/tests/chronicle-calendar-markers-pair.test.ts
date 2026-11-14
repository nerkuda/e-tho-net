/**
 * «Дневник»: маркеры календаря принадлежат паре «сеть + вкладка» и отбору её
 * запуска (ошибка 58c55bb9, круг 2 — блокер 1; 0.16.1 — маркеры дня по
 * требованию ab9d627b вместо упразднённого counts-запроса записей).
 *
 * Дефект (историческая форма): запрос счётчиков брал сеть из стора в момент
 * вызова, а отбор — из модульного состояния экрана. После `await reload()` /
 * `reloadKeepingDepth()` (окно `openNetwork`: сеть уже новая, скрытый экран ещё
 * не переинициализирован) запрос уходил в новую сеть с отбором прежней:
 * `POST /networks/<B>/chronicle/query` → 422 «Тип … удалён из сети», а ошибка
 * глоталась — `.ft-issue` не появлялся, счётчики B считались чужим отбором.
 *
 * Маркеры (0.16.1) считаются АГРЕГАТНЫМ чтением
 * `GET /chronicle/calendar-markers` по снимку «пара + месяц + сегодня»: отбора
 * в запросе нет, но гонка прежней пары осталась — поздний ответ мог бы
 * нарисовать маркеры чужой сети в клетках календаря новой.
 *
 * Кейс 1 (красный гейт): применение отбора в A, удержанный ответ маркеров,
 * затем публикация B с видом «карта» (скрытый «Дневник» ещё живёт состоянием A)
 * и поздний ответ A — маркеры чужой сети в календарь не попадают, новых
 * запросов прежний запуск не делает; текущая пара B считает маркеры своими.
 * Кейс 2: отказ маркеров ТЕКУЩЕЙ пары не ломает ленту и не подменяет штатную
 * диагностику отбора (сбой чтения маркеров глотается молча, как у «Связей
 * дня»); клетки остаются без маркеров.
 * Кейс 3 (красный гейт): экран отстыкован (host снят), затем сеть в store
 * сменилась — отложенный вход («Применить» на прежней панели) не должен
 * отправить отбор/маркеры A в B.
 *
 * Мутации, которые обязаны краснить: (1) убрать сверку пары в
 * `refreshCalendarMarkers` — кейс 1; (2) вернуть проброс ошибки маркеров в
 * диагностику/исключение — кейс 2; (3) убрать сторож `chronicleFilterIsCurrent`
 * в `reload`/снимке маркеров/`persistState` — кейс 3.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  CHRONICLE_PAGE_SIZE,
  EtnError,
  type CalendarMarkersResult,
  type NetworkProperty,
} from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET_A = '00000000-0000-4000-8000-0000000000a1';
const NET_B = '00000000-0000-4000-8000-0000000000b2';
const FOREIGN_TYPE = '00000000-0000-4000-8000-0000000000c3';

/** Запрос ленты: сеть и тело запроса — журнал применённого отбора. */
interface QueryCall {
  networkId: string;
  body: any;
}

/** Запрос маркеров календаря: сеть и снимок месяца/«сегодня». */
interface MarkersCall {
  networkId: string;
  query: { from: string; to: string; today: string };
}

let calls: QueryCall[] = [];
let markerCalls: MarkersCall[] = [];
/** Удерживать ли следующие запросы ленты (для гонки с поздним ответом). */
let holdQueries = false;
/** Удерживать ли следующие запросы маркеров. */
let holdMarkers = false;
let held: Array<() => void> = [];
/** Отказ для запросов маркеров текущей пары. */
let failMarkers: Error | null = null;
/** Записи пер-вкладочного состояния: чей снимок лёг в строку вкладки. */
let tabStateUpdates: Array<{ tabId: string; patch: Dict }> = [];

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

/** Маркеры «как от сервера»: задача в первый день запрошенного месяца. */
function markersResult(query: { from: string }): CalendarMarkersResult {
  return {
    record_spans: [],
    task_days: [query.from],
    overdue_days: [],
    fact_days: [],
    reminder_instants: [],
  };
}

installShims({
  ui: { getState: async () => null, setState: async () => undefined },
  tabs: {
    updateState: async (tabId: string, patch: Dict) => {
      tabStateUpdates.push({ tabId, patch });
    },
    list: async () => [],
  },
  propertyRegistry: {
    list: async (): Promise<NetworkProperty[]> => [],
  },
  chronicle: {
    query: async (networkId: string, body: any) => {
      calls.push({ networkId, body });
      if (holdQueries) {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      return { rows: [], total: 0, warnings: null };
    },
    calendarMarkers: async (networkId: string, query: MarkersCall['query']) => {
      markerCalls.push({ networkId, query });
      if (holdMarkers) {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      if (failMarkers !== null) throw failMarkers;
      return markersResult(query);
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
const catalogueMod = await import('../src/renderer/lib/property-catalogue.js');

/** Дождаться асинхронных чтений и продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Дождаться, пока копилка удержанных запросов наполнится. */
async function waitHeldAtLeast(count: number): Promise<void> {
  for (let i = 0; i < 80 && held.length < count; i += 1) await flush();
}

/** Отпустить удержанные запросы; следующие — отвечают сразу. */
async function releaseHeld(): Promise<void> {
  holdQueries = false;
  holdMarkers = false;
  const pending = held;
  held = [];
  for (const resolve of pending) resolve();
  await flush();
}

/** Снимок A: условие по типу, которого в B нет. */
function foreignSnapshot(): string {
  return JSON.stringify({
    filter: { order: 'asc', date_mode: 'presets', targets: { type_ids: [FOREIGN_TYPE] } },
    month: null,
    savedFilterId: null,
  });
}

/** Есть ли чужой тип в теле запроса (обход любых полей). */
function mentionsForeignType(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => mentionsForeignType(item));
  const rec = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(rec)) {
    if (key === FOREIGN_TYPE) return true;
    if (child === FOREIGN_TYPE) return true;
    if (Array.isArray(child) && child.includes(FOREIGN_TYPE)) return true;
    if (mentionsForeignType(child)) return true;
  }
  return false;
}

function queriesTo(networkId: string): QueryCall[] {
  return calls.filter((call) => call.networkId === networkId);
}

function markersTo(networkId: string): MarkersCall[] {
  return markerCalls.filter((call) => call.networkId === networkId);
}

/** Кнопка «Применить» в панели отбора (общий футер редактора — `ff-apply`). */
function applyButton(host: ShimElement): ShimElement | null {
  return host.findAll((node) => node.classList.contains('ff-apply'))[0] ?? null;
}

/** Есть ли в DOM штатная диагностика отбора (строка редактора/подсказка футера). */
function hasPanelIssues(host: ShimElement): boolean {
  return (
    host.findAll((node) => node.classList.contains('ft-issue')).length > 0 ||
    host.findAll((node) => node.classList.contains('ff-preview__tip-issue')).length > 0
  );
}

/** Сколько маркеров дня ВИДИМО (присутствуют, не `is-off`) во всём календаре. */
function visibleMarkers(host: ShimElement): number {
  return host.findAll(
    (node) => node.classList.contains('cal-marker') && !node.classList.contains('is-off'),
  ).length;
}

let teardown: (() => void) | null = null;

afterEach(() => {
  if (teardown !== null) {
    teardown();
    teardown = null;
  }
  panelMod.unmountChronicleFilterPanel();
  catalogueMod.resetPropertyCatalogue();
  holdQueries = false;
  holdMarkers = false;
  held = [];
  failMarkers = null;
});

beforeEach(() => {
  calls = [];
  markerCalls = [];
  holdQueries = false;
  holdMarkers = false;
  held = [];
  failMarkers = null;
  tabStateUpdates = [];
});

/** Смонтировать экран на паре A (снимок с чужим типом) и дождаться старта. */
async function mountOnA(): Promise<ShimElement> {
  stateMod.store.update({
    networkId: NET_A,
    network: null,
    activeView: 'chronicle',
    screen: 'workspace',
    tabs: [{ tab_id: 'tab-A', network_id: NET_A, chronicle_state: foreignSnapshot() }] as any,
    activeTabId: 'tab-A',
    rtStatusByNetwork: { [NET_A]: 'connected' },
  } as any);
  const host = new ShimElement('div');
  teardown = chronicleMod.mountChronicle(host as unknown as HTMLElement);
  await chronicleMod.ensureChronicleInitialised();
  await flush();
  return host;
}

describe('«Дневник»: маркеры календаря в паре «сеть + вкладка» (58c55bb9)', () => {
  it('1. поздний ответ маркеров прежней пары не рисует маркеры новой сети', async () => {
    const host = await mountOnA();
    assert.ok(
      queriesTo(NET_A).some((call) => mentionsForeignType(call.body)),
      'старт: отбор A по своему типу действительно применён',
    );

    // Применение отбора в A: ответ маркеров удержан, и на этом «медленном»
    // ответе происходит публикация B с видом «карта» (скрытый «Дневник» ещё
    // не переинициализирован — окно openNetwork).
    const apply = applyButton(host);
    assert.ok(apply !== null, 'кнопка «Применить» построена');
    holdMarkers = true;
    apply.click();
    await waitHeldAtLeast(1);
    const firstMarkers = markerCalls[0];
    assert.ok(firstMarkers !== undefined, 'маркеры A запрошены применением отбора');
    assert.equal(firstMarkers!.networkId, NET_A, 'снимок принадлежит паре A');

    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-A', network_id: NET_A, chronicle_state: foreignSnapshot() },
        { tab_id: 'tab-B', network_id: NET_B },
      ] as any,
      activeTabId: 'tab-B',
      activeView: 'map',
    } as any);
    const mark = calls.length;
    const markersMark = markerCalls.length;
    await releaseHeld();

    assert.equal(calls.length, mark, 'после смены пары прежний запуск не делает запросов');
    assert.equal(markerCalls.length, markersMark, 'и не запрашивает маркеры новой сети');
    assert.equal(
      visibleMarkers(host),
      0,
      'поздний ответ A не нарисовал маркеры чужой сети в клетках календаря',
    );

    // Положительный контроль: в актуальной паре B применение отбора снова
    // считает маркеры — СВОИМ снимком, а не молчит навсегда.
    stateMod.store.update({ activeView: 'chronicle' } as any);
    await chronicleMod.ensureChronicleInitialised();
    await flush();
    apply.click();
    await flush();
    await flush();
    const inB = markersTo(NET_B);
    assert.ok(inB.length > 0, 'текущая пара B запрашивает маркеры календаря');
    assert.equal(
      inB[inB.length - 1]!.query.today.length,
      10,
      '«сегодня» передаётся клиентом (граница просрочки)',
    );
    assert.equal(inB[inB.length - 1]!.query.from.slice(8, 10), '01', 'окно — с 1-го числа');
    assert.ok(visibleMarkers(host) > 0, 'маркеры текущей пары нарисованы');
    assert.ok(
      queriesTo(NET_B).every((call) => !mentionsForeignType(call.body)),
      'в B не осталось условий прежней сети',
    );
  });

  it('2. отказ маркеров текущей пары молчит и не подменяет диагностику отбора', async () => {
    const host = await mountOnA();
    // Отказ ТОЛЬКО маркерам; лента продолжает отвечать.
    failMarkers = new EtnError('VALIDATION_ERROR', 'Тип удалён из сети', {
      diagnostics: [
        {
          severity: 'error',
          code: 'type_deleted',
          path: '',
          message: 'Тип «Чужой» удалён из сети — отбор нельзя применить.',
        },
      ],
    });
    const apply = applyButton(host);
    assert.ok(apply !== null, 'кнопка «Применить» построена');
    apply.click();
    await flush();
    await flush();

    assert.ok(markersTo(NET_A).length > 0, 'маркеры были запрошены');
    assert.ok(
      queriesTo(NET_A).some((call) => call.body?.limit === CHRONICLE_PAGE_SIZE),
      'лента текущей пары запрошена (сбой маркеров её не обрывает)',
    );
    assert.equal(
      hasPanelIssues(host),
      false,
      'сбой маркеров не подменяет штатную диагностику отбора (глотается молча)',
    );
    assert.equal(visibleMarkers(host), 0, 'клетки остаются без маркеров до перезапроса');
  });

  it('3. отложенный вход отстыкованного экрана не шлёт отбор прежней пары в новую сеть', async () => {
    const host = await mountOnA();
    assert.ok(
      queriesTo(NET_A).some((call) => mentionsForeignType(call.body)),
      'старт: отбор A применён и ушёл в A',
    );
    const apply = applyButton(host);
    assert.ok(apply !== null, 'кнопка «Применить» построена');

    // Отстыковка экрана (перемонтирование при переключении вида/сети): store-
    // подписчик снимается, host обнуляется, но модульный отбор и DOM прежней
    // панели живы — окно openNetwork.
    assert.ok(teardown !== null, 'экран смонтирован');
    teardown?.();
    teardown = null;

    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-A', network_id: NET_A, chronicle_state: foreignSnapshot() },
        { tab_id: 'tab-B', network_id: NET_B },
      ] as any,
      activeTabId: 'tab-B',
      activeView: 'chronicle',
    } as any);
    const mark = calls.length;
    const markersMark = markerCalls.length;
    const stateMark = tabStateUpdates.length;

    // Отложенный вход в цепочку экрана уже после смены пары: нажатие на
    // «Применить» прежней (отстыкованной) панели.
    apply.click();
    await flush();
    await flush();

    assert.equal(calls.length, mark, 'ни лента не ушла в B с отбором прежней пары');
    assert.equal(markerCalls.length, markersMark, 'ни маркеры A не запрошены для B');
    assert.ok(
      !queriesTo(NET_B).some((call) => mentionsForeignType(call.body)),
      'в B нет ни одного запроса с чужим типом',
    );
    assert.equal(
      tabStateUpdates.length,
      stateMark,
      'снимок прежней пары не лёг в строку вкладки новой сети',
    );
  });
});
