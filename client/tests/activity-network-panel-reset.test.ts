/**
 * «События»: панель показывает ФАКТИЧЕСКОЕ состояние отбора после смены пары
 * «сеть + вкладка» (ошибка 58c55bb9, круг 2 — блокер 2).
 *
 * Дефект: `ensureActivityInitialised` сбрасывал модель (`filter`,
 * `serverIssues`) на новой паре, но `filterEditor?.refresh()` /
 * `activityFrame?.apply()` вызывались только в ветке со СНИМКОМ. При пустом
 * снимке (новая сеть/вкладка) запрос уходил с пустым AST, а панель продолжала
 * показывать условие прежней сети («Сущность = Проба стенда») — экран врал.
 *
 * Кейс: снимок A с условием по сущности → панель A показывает подпись; переход
 * на пару B без снимка → панель B пуста, запрос B — без условий A.
 *
 * Мутация, которая обязана краснить: вернуть `filterEditor?.refresh()` /
 * `activityFrame?.apply()` в ветку `if (raw !== null && raw !== '')` — панель
 * сохраняет чужую подпись.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET_A = '00000000-0000-4000-8000-0000000000a1';
const NET_B = '00000000-0000-4000-8000-0000000000b2';
const ENTITY_ID = '00000000-0000-4000-8000-0000000000d4';
const ENTITY_TITLE = 'Проба стенда';

interface ListCall {
  networkId: string;
  body: any;
}

let listCalls: ListCall[] = [];

function installShims(bridge: Dict): void {
  // Лента «Событий» рисует данные фасадом `lib/ui/table` поверх `<vaadin-grid>`:
  // шиму нужны методы вендорского элемента, которых у `ShimElement` нет
  // (образец — tests/network-stats-dialog.test.ts).
  const gridElement = (): ShimElement => {
    const el = new ShimElement('vaadin-grid') as ShimElement & {
      clearCache?: () => void;
      generateCellPartNames?: () => void;
      scrollToIndex?: (index: number) => void;
      getEventContext?: () => null;
    };
    el.clearCache = () => undefined;
    el.generateCellPartNames = () => undefined;
    el.scrollToIndex = () => undefined;
    el.getEventContext = () => null;
    return el;
  };
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => (tag === 'vaadin-grid' ? gridElement() : new ShimElement(tag)),
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
  propertyRegistry: { list: async () => [] },
  savedFilters: {
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => undefined,
  },
  chronicleFilters: { list: async () => [] },
  activity: {
    list: async (networkId: string, body: any) => {
      listCalls.push({ networkId, body });
      return { rows: [], total: 0 };
    },
  },
  tabs: { updateState: async () => undefined, list: async () => [] },
  layers: { list: async () => [] },
  ui: { getState: async () => null, setState: async () => undefined },
  admin: { listUsers: async () => [] },
  thoughts: { resolve: async () => [] },
});

const stateMod = await import('../src/renderer/state.js');
const activityMod = await import('../src/renderer/screens/activity/activity.js');

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Снимок A: лента «События» по конкретной сущности (wire-AST + подпись). */
function entitySnapshot(): string {
  return JSON.stringify({
    filter: {
      version: 1,
      filter: {
        entity: { kind: 'entity_id' },
        operator: 'eq',
        value: ENTITY_ID,
        labels: { value: ENTITY_TITLE },
      },
    },
    offset: 0,
    savedFilterId: null,
  });
}

/** Есть ли в теле запроса условие по сущности A. */
function mentionsForeignEntity(body: any): boolean {
  return JSON.stringify(body ?? null).includes(ENTITY_ID);
}

let teardown: (() => void) | null = null;

afterEach(() => {
  if (teardown !== null) {
    teardown();
    teardown = null;
  }
  listCalls = [];
});

describe('«События»: панель после смены пары «сеть + вкладка» (58c55bb9)', () => {
  it('пустой снимок B перерисовывает панель: чужое условие A не остаётся', async () => {
    stateMod.store.update({
      networkId: NET_A,
      network: { first_day_of_week: 7 } as any,
      activeView: 'activity',
      screen: 'workspace',
      tabs: [{ tab_id: 'tab-A', network_id: NET_A, activity_state: entitySnapshot() }] as any,
      activeTabId: 'tab-A',
    } as any);

    const host = new ShimElement('div');
    teardown = activityMod.mountActivity(host as unknown as HTMLElement);
    await activityMod.ensureActivityInitialised();
    await flush();

    // Положительный контроль: снимок A действительно применён и виден в панели.
    assert.ok(
      host.flatText().includes(ENTITY_TITLE),
      'панель A показывает условие по сущности из своего снимка',
    );
    assert.ok(
      listCalls.some((call) => call.networkId === NET_A && mentionsForeignEntity(call.body)),
      'запрос A ушёл с условием по сущности',
    );

    // Переход на B: снимка нет, модель сбрасывается — панель обязана
    // перерисоваться пустой (окно openNetwork).
    stateMod.store.update({
      networkId: NET_B,
      tabs: [
        { tab_id: 'tab-A', network_id: NET_A, activity_state: entitySnapshot() },
        { tab_id: 'tab-B', network_id: NET_B, activity_state: null },
      ] as any,
      activeTabId: 'tab-B',
      activeView: 'activity',
    } as any);
    await flush();
    await flush();

    assert.ok(
      !host.flatText().includes(ENTITY_TITLE),
      'панель B не показывает подпись условия прежней сети',
    );
    assert.ok(
      !host.flatText().includes(ENTITY_ID),
      'панель B не показывает даже id прежнего условия',
    );
    const inB = listCalls.filter((call) => call.networkId === NET_B);
    assert.ok(inB.length > 0, 'лента B запрошена');
    assert.ok(
      inB.every((call) => !mentionsForeignEntity(call.body)),
      'запрос B пуст — чужое условие в него не попало',
    );
  });
});
