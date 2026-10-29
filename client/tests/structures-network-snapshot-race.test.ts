/**
 * «Структуры»: снимок экрана принадлежит ПАРЕ «сеть + вкладка» (ошибка
 * 58c55bb9).
 *
 * Дефект: `ensureStructuresInitialised` применял `tab.structures_state` по
 * `activeTabId` без сверки `tab.network_id`, а отложенный повтор разбора
 * снимка не помнил пару. В окне `openNetwork` (сеть уже новая, `activeTabId`
 * ещё старый) отбор одной сети уходил запросом в другую и получал 422 «Тип …
 * удалён из сети»; гонка подтверждена логами (успешный query и 422 разошлись
 * на 1 мс).
 *
 * Контракт под тестом:
 *   1. снимок вкладки ЧУЖОЙ сети не применяется, панель начинается с
 *      дефолтного отбора (пустой запрос сети);
 *   2. снимок СВОЕЙ вкладки применяется как раньше (поведение не сломано);
 *   3. гонка `ensure`: пара сменилась, пока шло чтение реестра, — устаревший
 *      снимок не применяется и в запрос новой сети не уходит;
 *   4. отложенный повтор снимка помнит пару: смена сети прерывает повтор,
 *      даже если разбор уже читал реестр;
 *   5. смена ВКЛАДКИ в той же сети прерывает повтор так же.
 *
 * Экран монтируется ЦЕЛИКОМ на DOM-шиме (`./dom-shim.js`): проверяется
 * настоящее поведение подписки store, а не вызов внутренней функции. Мутации,
 * краснящие кейсы:
 *   - убрать сверку `tab.network_id` (`readTabScreenState`) — кейс 1;
 *   - убрать сверку пары в `loadFilterSnapshot`/`ensure` — кейс 3;
 *   - убрать пару из отложенного снимка — кейсы 4 и 5.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import type { TabDto } from '../src/main/ipc/contract.js';
import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET_A = '00000000-0000-4000-8000-0000000000a1';
const NET_B = '00000000-0000-4000-8000-0000000000b2';
const FOREIGN_TYPE = '00000000-0000-4000-8000-00000000ff01';
/** Свойство сети: условие по нему восстанавливается только из реестра. */
const PROPERTY_ID = '00000000-0000-4000-8000-0000000000c3';

/** Поведение чтения реестра свойств (1-based номер вызова). */
let registryImpl: (call: number) => Promise<NetworkProperty[]> = async () => [];

/** Запросы страницы: сеть + тело отбора (журнал кейса). */
const queryFilters: Array<{ networkId: string; filter: any }> = [];

/** Захват ответов страницы (кейс 6): все вызовы висят до releaseQueries(). */
let holdQueries = false;
let heldQueries: Array<(result: unknown) => void> = [];

/** Снимок СВОЕЙ вкладки сети B: условие по типу B (не чужое). */
const OWN_TYPE_B = '00000000-0000-4000-8000-00000000bb02';

function ownSnapshot(): string {
  return JSON.stringify({ typeIds: [OWN_TYPE_B], sort: 'alpha', order: 'asc' });
}

/** Снимок с отбором по «чужому» типу (есть только в сети A). */
function foreignSnapshot(): string {
  // Прежняя ПЛОСКАЯ форма панели: условие по свойству конвертер восстанавливает
  // только из реестра, поэтому повторный разбор с реестром ДАЁТ ДРУГОЕ
  // состояние и перезапрашивает страницу (иначе повтор — no-op).
  return JSON.stringify({
    typeIds: [FOREIGN_TYPE],
    properties: [{ propertyId: PROPERTY_ID, op: 'eq', values: ['2.0'] }],
    sort: 'alpha',
    order: 'asc',
  });
}

/** Строка реестра свойств для восстановления условия по свойству. */
function propertyRow(): NetworkProperty {
  return {
    id: PROPERTY_ID,
    name: 'Версия',
    value_type: 'text',
    config: null,
    description: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as NetworkProperty;
}

/** Есть ли в теле запроса/состоянии упоминание id типа. */
function mentionsForeignType(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(FOREIGN_TYPE);
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
  tabs: { updateState: async () => undefined, list: async () => [] },
  propertyRegistry: {
    list: async (): Promise<NetworkProperty[]> => {
      registryCalls += 1;
      return registryImpl(registryCalls);
    },
  },
  structures: {
    query: async (networkId: string, filter: any) => {
      queryFilters.push({ networkId, filter });
      if (holdQueries) {
        return await new Promise<unknown>((resolve) => heldQueries.push(resolve));
      }
      return { items: [], total: 0, directions: {}, next_cursor: null };
    },
  },
  // Остальное — минимальный шим транзитивных вызовов монтирования.
  savedFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
  thoughts: { resolve: async () => [], findDuplicates: async () => [] },
  history: { list: async () => [] },
});

let registryCalls = 0;

const stateMod = await import('../src/renderer/state.js');
const panelMod = await import('../src/renderer/screens/structures/filter-panel.js');
const structuresMod = await import('../src/renderer/screens/structures/structures.js');
const catalogueMod = await import('../src/renderer/lib/property-catalogue.js');
const tabStateMod = await import('../src/renderer/screens/tabs/tab-state.js');

/** Дождаться асинхронных чтений реестра/запроса и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Живые стенды: упавший кейс не обязан успеть размонтировать экран. */
let mounted: (() => void) | null = null;
/** Корень смонтированного экрана: кейс 6 проверяет отсутствие чужих строк. */
let mountedHost: ShimElement | null = null;

afterEach(() => {
  if (mounted !== null) {
    mounted();
    mounted = null;
  }
  panelMod.unmountFilterPanel();
  catalogueMod.resetPropertyCatalogue();
  held = [];
  holdQueries = false;
  heldQueries = [];
  mountedHost = null;
});

/** Захват чтений реестра: все вызовы висят до releaseReads(). */
let held: Array<(rows: NetworkProperty[]) => void> = [];

/** Отпустить все захваченные чтения реестра; следующие — отвечают сразу. */
async function releaseReads(rows: NetworkProperty[]): Promise<void> {
  const pending = held;
  held = [];
  registryImpl = async () => rows;
  for (const resolve of pending) resolve(rows);
  await flush();
}

/** Отпустить все захваченные ответы страницы (кейс 6). */
async function releaseQueries(result: unknown): Promise<void> {
  holdQueries = false;
  const pending = heldQueries;
  heldQueries = [];
  for (const resolve of pending) resolve(result);
  await flush();
}

/** Дождаться, пока копилка захваченных чтений наполнится. */
async function waitHeldAtLeast(count: number): Promise<void> {
  for (let i = 0; i < 60 && held.length < count; i += 1) await flush();
}

/** Состояние панели без чужого типа. */
function panelIsDefault(): boolean {
  return !mentionsForeignType(panelMod.getFilterState().tree);
}

/** Смонтировать экран на заданной паре «сеть + вкладка». */
function mountOn(state: {
  networkId: string;
  tabs: unknown[];
  activeTabId: string | null;
  rtStatusByNetwork?: Record<string, string>;
}): void {
  stateMod.store.update({
    network: null,
    activeView: 'structures',
    screen: 'workspace',
    rtStatusByNetwork: { [state.networkId]: 'connected' },
    ...state,
  } as any);
  const hostEl = new ShimElement('div');
  mountedHost = hostEl;
  mounted = structuresMod.mountStructures(hostEl as unknown as HTMLElement);
}

/** Запросы, ушедшие в сеть после отметки (индекса в журнале). */
function queriesTo(networkId: string, from = 0): Array<{ networkId: string; filter: any }> {
  return queryFilters.slice(from).filter((q) => q.networkId === networkId);
}

describe('«Структуры»: снимок экрана принадлежит паре «сеть + вкладка» (58c55bb9)', () => {
  it('1. снимок вкладки чужой сети не применяется, панель начинается с дефолта', async () => {
    // Промежуточное состояние openNetwork: сеть уже новая (B), activeTabId ещё
    // принадлежит вкладке сети A с её снимком (окно гонки из логов).
    queryFilters.length = 0;
    registryImpl = async () => [];
    registryCalls = 0;
    mountOn({
      networkId: NET_B,
      tabs: [{ tab_id: 'tab-foreign-1', network_id: NET_A, structures_state: foreignSnapshot() }],
      activeTabId: 'tab-foreign-1',
    });
    await flush();

    assert.equal(queryFilters.length, 1, 'страница запрошена один раз — по сети B');
    assert.equal(queryFilters[0]?.networkId, NET_B);
    assert.ok(
      !mentionsForeignType(queryFilters[0]?.filter),
      'отбор чужой сети не ушёл запросом: 422 не воспроизводится',
    );
    assert.ok(panelIsDefault(), 'панель сброшена к дефолтному отбору, а не к снимку сети A');
  });

  it('2. снимок своей вкладки применяется — сохранение отбора внутри сети не сломано', async () => {
    queryFilters.length = 0;
    registryImpl = async () => [];
    registryCalls = 0;
    mountOn({
      networkId: NET_B,
      tabs: [{ tab_id: 'tab-own-2', network_id: NET_B, structures_state: foreignSnapshot() }],
      activeTabId: 'tab-own-2',
    });
    await flush();

    assert.equal(queryFilters.length, 1);
    assert.equal(queryFilters[0]?.networkId, NET_B);
    assert.ok(
      mentionsForeignType(queryFilters[0]?.filter),
      'снимок СВОЕЙ вкладки по-прежнему применён (регресс сохранения отбора)',
    );
  });

  it('3. гонка ensure: пара сменилась во время чтения реестра — чужой снимок не уходит в новую сеть', async () => {
    queryFilters.length = 0;
    registryCalls = 0;
    registryImpl = async () => await new Promise<NetworkProperty[]>((resolve) => held.push(resolve));

    mountOn({
      networkId: NET_A,
      tabs: [{ tab_id: 'tab-race-3', network_id: NET_A, structures_state: foreignSnapshot() }],
      activeTabId: 'tab-race-3',
    });
    await waitHeldAtLeast(2);
    assert.ok(held.length >= 2, 'панель и разбор снимка ждут чтения реестра');

    // Пока разбор снимка в полёте, openNetwork публикует новую пару
    // «сеть B + вкладка B»; у вкладки B снимка нет — реестр ей не нужен.
    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-race-3', network_id: NET_A, structures_state: foreignSnapshot() },
        { tab_id: 'tab-race-3b', network_id: NET_B },
      ],
      activeTabId: 'tab-race-3b',
    } as any);
    await flush();
    const queriesBeforeRelease = queryFilters.length;
    assert.ok(
      queriesTo(NET_B).length >= 1,
      'новая пара успела инициализироваться (пустой отбор сети B)',
    );

    // Отпускаем чтение реестра устаревшего разбора.
    await releaseReads([propertyRow()]);

    assert.ok(
      !queriesTo(NET_B).some((q) => mentionsForeignType(q.filter)),
      'устаревший снимок сети A не ушёл запросом в сеть B',
    );
    assert.ok(panelIsDefault(), 'панель сети B не перетёрта снимком сети A');
    assert.ok(
      queryFilters.length >= queriesBeforeRelease,
      'журнал не обрезан (проверка осмысленна)',
    );
  });

  it('4. отложенный повтор прерывается при смене СЕТИ', async () => {
    queryFilters.length = 0;
    registryCalls = 0;
    // Старт: панель и разбор снимка получают отказ → снимок ждёт переразбора.
    let phase: 'start' | 'retry' = 'start';
    registryImpl = async () => {
      if (phase === 'start') throw new Error('сеть недоступна');
      return await new Promise<NetworkProperty[]>((resolve) => held.push(resolve));
    };
    mountOn({
      networkId: NET_A,
      tabs: [{ tab_id: 'tab-net-4', network_id: NET_A, structures_state: foreignSnapshot() }],
      activeTabId: 'tab-net-4',
      rtStatusByNetwork: { [NET_A]: 'offline' },
    });
    await flush();
    assert.ok(queriesTo(NET_A).length >= 1, 'снимок применён в своей сети (без реестра)');

    // Восстановление связи запускает отложенный повтор разбора.
    phase = 'retry';
    stateMod.store.update({ rtStatusByNetwork: { [NET_A]: 'connected' } });
    await waitHeldAtLeast(1);
    assert.ok(held.length >= 1, 'повтор ждёт чтения реестра');

    // Пользователь ушёл с экрана и переключился на сеть B — повтор в полёте.
    // Вид сменён ДО сети: штатный ensure нового вида не срабатывает, ожидание
    // снимка живёт до ответа реестра (именно этот путь и был дефектом).
    stateMod.store.update({ activeView: 'map' } as any);
    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-net-4', network_id: NET_A, structures_state: foreignSnapshot() },
        { tab_id: 'tab-net-4b', network_id: NET_B },
      ],
      activeTabId: 'tab-net-4b',
    } as any);
    const mark = queryFilters.length;

    await releaseReads([propertyRow()]);
    assert.ok(
      !queriesTo(NET_B, mark).some((q) => mentionsForeignType(q.filter)),
      'повтор снимка сети A не ушёл запросом в сеть B',
    );
  });

  it('5. отложенный повтор прерывается при смене ВКЛАДКИ в той же сети', async () => {
    queryFilters.length = 0;
    registryCalls = 0;
    let phase: 'start' | 'retry' = 'start';
    registryImpl = async () => {
      if (phase === 'start') throw new Error('сеть недоступна');
      return await new Promise<NetworkProperty[]>((resolve) => held.push(resolve));
    };
    mountOn({
      networkId: NET_A,
      tabs: [{ tab_id: 'tab-tab-5', network_id: NET_A, structures_state: foreignSnapshot() }],
      activeTabId: 'tab-tab-5',
      rtStatusByNetwork: { [NET_A]: 'offline' },
    });
    await flush();

    phase = 'retry';
    stateMod.store.update({ rtStatusByNetwork: { [NET_A]: 'connected' } });
    await waitHeldAtLeast(1);
    assert.ok(held.length >= 1, 'повтор ждёт чтения реестра');

    // Та же сеть, ДРУГАЯ вкладка без снимка; экран на время смены скрыт.
    stateMod.store.update({ activeView: 'map' } as any);
    stateMod.store.update({
      tabs: [
        { tab_id: 'tab-tab-5', network_id: NET_A, structures_state: foreignSnapshot() },
        { tab_id: 'tab-tab-5b', network_id: NET_A },
      ],
      activeTabId: 'tab-tab-5b',
    } as any);
    const mark = queryFilters.length;


    await releaseReads([propertyRow()]);

    assert.ok(
      !queryFilters.slice(mark).some((q) => mentionsForeignType(q.filter)),
      'повтор снимка прежней вкладки не применён к новой вкладке',
    );
  });

  it('6. устаревший ответ запроса прежней пары не пишется в кэш новой', async () => {
    queryFilters.length = 0;
    registryCalls = 0;
    registryImpl = async () => [];
    // Запрос сети A висит: ответ придёт уже после смены пары.
    holdQueries = true;
    mountOn({
      networkId: NET_A,
      tabs: [{ tab_id: 'tab-q-6', network_id: NET_A }],
      activeTabId: 'tab-q-6',
    });
    await flush();
    assert.ok(heldQueries.length >= 1, 'запрос сети A висит в полёте');

    // Инициализация сети B ждёт реестр (у вкладки B свой снимок), поэтому её
    // запрос ещё не начат и seq прежнего ответа не сдвинут: отсечь устаревший
    // ответ может только сверка пары.
    holdQueries = false;
    registryImpl = async () => await new Promise<NetworkProperty[]>((resolve) => held.push(resolve));
    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-q-6', network_id: NET_A },
        { tab_id: 'tab-q-6b', network_id: NET_B, structures_state: ownSnapshot() },
      ],
      activeTabId: 'tab-q-6b',
    } as any);
    await waitHeldAtLeast(1);
    assert.ok(held.length >= 1, 'инициализация сети B ждёт реестр');

    await releaseQueries({
      items: [{ id: 'stale-thought', title: 'ЧУЖАЯ-МЫСЛЬ-A' }],
      total: 1,
      directions: {},
      next_cursor: null,
    });
    assert.ok(
      !(mountedHost?.flatText() ?? '').includes('ЧУЖАЯ-МЫСЛЬ-A'),
      'строки сети A не отрисованы под сетью B',
    );

    await releaseReads([]);
    assert.ok(queriesTo(NET_B).length >= 1, 'новая пара запросила свою страницу');
    assert.ok(
      !queriesTo(NET_B).some((q) => mentionsForeignType(q.filter)),
      'в сеть B не ушёл отбор сети A',
    );
  });
});

describe('findOpenTargetTab: вкладка чужой сети не переиспользуется (58c55bb9)', () => {
  function tabDto(tabId: string, networkId: string, slotIdx: number): TabDto {
    return {
      tab_id: tabId,
      slot_idx: slotIdx,
      network_id: networkId,
      focus_id: null,
      view_mode: null,
      structures_state: null,
      chronicle_state: null,
      activity_state: null,
      layer_id: null,
      last_active_at: '2026-10-26T00:00:00.000Z',
    };
  }
  const tabs = [tabDto('t-a', NET_A, 0), tabDto('t-b', NET_B, 1)];

  it('своя вкладка выбирается', () => {
    assert.equal(tabStateMod.findOpenTargetTab(tabs, 't-a', NET_A)?.tab_id, 't-a');
  });

  it('вкладка другой сети не выбирается — openNetwork открывает свою', () => {
    assert.equal(tabStateMod.findOpenTargetTab(tabs, 't-b', NET_A), null);
  });

  it('без подсказки вкладки — null (открывается новая)', () => {
    assert.equal(tabStateMod.findOpenTargetTab(tabs, undefined, NET_A), null);
  });
});
