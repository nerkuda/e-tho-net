/**
 * «Дневник»: счётчики календаря принадлежат паре «сеть + вкладка» и отбору её
 * запуска (ошибка 58c55bb9, круг 2 — блокер 1).
 *
 * Дефект: `refreshCalendarCounts()` брал сеть из стора в момент вызова, а
 * отбор — из модульного состояния экрана. После `await reload()` /
 * `reloadKeepingDepth()` (окно `openNetwork`: сеть уже новая, скрытый экран ещё
 * не переинициализирован) запрос уходил в новую сеть с отбором прежней:
 * `POST /networks/<B>/chronicle/query` → 422 «Тип … удалён из сети», а ошибка
 * глоталась — `.ft-issue` не появлялся, счётчики B считались чужим отбором.
 *
 * Кейс 1 (красный гейт): применение отбора в A, затем публикация B с видом
 * «карта» (скрытый «Дневник» ещё живёт состоянием A) и поздний ответ A — ни
 * одного запроса в B с чужим типом; текущая пара B считает своим отбором.
 * Кейс 2: отказ запроса ТЕКУЩЕЙ пары виден штатной диагностикой отбора.
 * Кейс 3 (красный гейт): экран отстыкован (host снят), затем сеть в store
 * сменилась — отложенный вход («Применить» на прежней панели) не должен
 * отправить отбор A в B; это другой путь гонки, найденный GUI-стендом: запрос
 * шёл при СОВПАДЕНИИ пары store, но с отбором прежней пары.
 *
 * Мутации, которые обязаны краснить: (1) убрать сверку пары в
 * `refreshCalendarCounts` — кейс 1; (2) вернуть `catch { return; }` (проглатывать
 * ошибку) — кейс 2; (3) убрать сторож `chronicleFilterIsCurrent` в
 * `reload`/снимке счётчиков/`persistState` — кейс 3.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EtnError, type NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET_A = '00000000-0000-4000-8000-0000000000a1';
const NET_B = '00000000-0000-4000-8000-0000000000b2';
const FOREIGN_TYPE = '00000000-0000-4000-8000-0000000000c3';

/** Запрос ленты/счётчиков: сеть и тело запроса — журнал применённого отбора. */
interface QueryCall {
  networkId: string;
  body: any;
}

let calls: QueryCall[] = [];
/** Удерживать ли следующие запросы (для гонки с поздним ответом). */
let holdQueries = false;
let held: Array<() => void> = [];
/** Отказ для запросов счётчиков (limit = CHRONICLE_QUERY_MAX_LIMIT). */
let failCounts: Error | null = null;
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
      if (failCounts !== null && body?.limit === 100) throw failCounts;
      return { rows: [], total: 0, warnings: null };
    },
  },
  chronicleFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
  structures: {
    query: async () => ({ items: [{ id: 'home-root' }], total: 1, directions: {}, next_cursor: null }),
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

let teardown: (() => void) | null = null;

afterEach(() => {
  if (teardown !== null) {
    teardown();
    teardown = null;
  }
  panelMod.unmountChronicleFilterPanel();
  catalogueMod.resetPropertyCatalogue();
  holdQueries = false;
  held = [];
  failCounts = null;
});

beforeEach(() => {
  calls = [];
  holdQueries = false;
  held = [];
  failCounts = null;
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

describe('«Дневник»: счётчики календаря в паре «сеть + вкладка» (58c55bb9)', () => {
  it('1. поздний ответ прежней пары не считает календарь новой сети чужим отбором', async () => {
    const host = await mountOnA();
    assert.ok(
      queriesTo(NET_A).some((call) => mentionsForeignType(call.body)),
      'старт: отбор A по своему типу действительно применён',
    );

    // Применение отбора в A: запрос ленты удержан, и на этом «медленном»
    // ответе происходит публикация B с видом «карта» (скрытый «Дневник» ещё
    // не переинициализирован — окно openNetwork).
    const apply = applyButton(host);
    assert.ok(apply !== null, 'кнопка «Применить» построена');
    holdQueries = true;
    apply.click();
    await waitHeldAtLeast(1);

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
    await releaseHeld();

    assert.ok(
      !queriesTo(NET_B)
        .slice(0)
        .some((call) => mentionsForeignType(call.body)),
      'поздний ответ A не отправил чужой отбор в B (ни лента, ни счётчики)',
    );
    assert.equal(
      calls.length,
      mark,
      'после смены пары прежний запуск вообще не делает запросов',
    );

    // Положительный контроль: в актуальной паре B применение отбора снова
    // считает календарь — СВОИМ (пустым) отбором, а не молчит навсегда.
    stateMod.store.update({ activeView: 'chronicle' } as any);
    await chronicleMod.ensureChronicleInitialised();
    await flush();
    const inB = queriesTo(NET_B);
    assert.ok(inB.length > 0, 'текущая пара B запрашивает ленту/счётчики');
    assert.ok(
      apply !== null,
      'кнопка «Применить» пережила смену пары',
    );
    apply.click();
    await flush();
    await flush();
    const inBAfterApply = queriesTo(NET_B);
    assert.ok(
      inBAfterApply.some((call) => call.body?.limit === 100),
      'счётчики календаря B запрошены при применении отбора',
    );
    assert.ok(
      inBAfterApply.every((call) => !mentionsForeignType(call.body)),
      'в B не осталось условий прежней сети',
    );
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
    const stateMark = tabStateUpdates.length;

    // Отложенный вход в цепочку экрана уже после смены пары: нажатие на
    // «Применить» прежней (отстыкованной) панели.
    apply.click();
    await flush();
    await flush();

    assert.equal(
      calls.length,
      mark,
      'ни лента, ни счётчики не ушли в B с отбором прежней пары',
    );
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

  it('2. отказ счётчиков текущей пары показывается штатной диагностикой отбора', async () => {
    const host = await mountOnA();
    // Отказ ТОЛЬКО счётчикам (limit = 100); лента продолжает отвечать.
    failCounts = new EtnError('VALIDATION_ERROR', 'Тип удалён из сети', {
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

    assert.ok(
      calls.some((call) => call.body?.limit === 100),
      'счётчики были запрошены',
    );
    assert.ok(
      hasPanelIssues(host),
      'отказ счётчиков виден диагностикой отбора, а не проглочен',
    );
  });
});
