/**
 * «Дневник»: чтение реестра свойств и разбор снимка отбора учитывают отказ
 * (ошибка ad063c2f; механика эталона 77f18626/6400d261 — класс «чтение
 * реестра/справочника без учёта отказа»).
 *
 * Две половины симптома карточки — обе в объёме ошибки:
 *   1. панель отбора «Дневника» глотала отказ начального чтения реестра:
 *      подпись каталога не сбрасывалась, своего повтора у панели не было —
 *      пустой реестр жил до перемонтирования. Кейс 1: отказ виден вызывающему,
 *      подпись пуста — следующий тик store перечитывает реестр (мутация
 *      «проглотить `ok` в preloadFilterRegistry» краснит его);
 *   2. экран разбирал сохранённый снимок с пустым реестром и не переразбирал
 *      его после перечитывания: условия по свойствам под-выборки целей
 *      выпадали из дерева и из запроса. Кейс 2: следующий тик store (переход в
 *      `connected`) перечитывает реестр, ПЕРЕРАЗБИРАЕТ снимок и перезапрашивает
 *      ленту — условие по свойству возвращается (мутация «не проверять
 *      результат preload» краснит его).
 *
 * Экран монтируется ЦЕЛИКОМ на DOM-шиме (`./dom-shim.js`) — как в
 * `structures-filter-snapshot-registry-retry.test.ts`: тик store проверяется
 * через настоящую подписку экрана. Реестр отвечает по номеру вызова, поэтому
 * отказ назначается конкретной точке чтения (монтаж панели → разбор снимка →
 * повтор).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

const NET = '00000000-0000-4000-8000-0000000000aa';
const PROPERTY_ID = '00000000-0000-4000-8000-0000000000bb';

/** Строка реестра: текстовое свойство «Версия» (условие по нему теряется без реестра). */
const PROPERTY_ROW: NetworkProperty = {
  id: PROPERTY_ID,
  name: 'Версия',
  value_type: 'text',
  config: null,
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/** Сколько раз экран/панель прочитали реестр свойств (включая отказные). */
let registryCalls = 0;
/** Поведение чтения реестра по номеру вызова (1-based): можно разрешить отказ. */
let registryImpl: (call: number) => Promise<NetworkProperty[]> = async () => [];

/** Тела запросов ленты/счётчиков календаря — журнал применённого отбора. */
const queries: any[] = [];

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
  // Единственный вход, который проверяют эти кейсы: чтение реестра свойств.
  propertyRegistry: {
    list: async (): Promise<NetworkProperty[]> => {
      registryCalls += 1;
      return registryImpl(registryCalls);
    },
  },
  chronicle: {
    query: async (_networkId: string, filter: any) => {
      queries.push(filter);
      return { rows: [], total: 0, warnings: null };
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
// Живой справочник свойств — модульный кэш (ошибка 6d25c224): кейсы «холодного
// старта» сбрасывают его, иначе успешное чтение предыдущего кейса переживает
// монтаж и снимок разбирается с готовым реестром.
const catalogueMod = await import('../src/renderer/lib/property-catalogue.js');

/** Дождаться асинхронных чтений реестра/запроса и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/**
 * Все узлы-условия по свойству в произвольном дереве/теле: обход по ЛЮБЫМ
 * полям (у под-выборки цели условие лежит в `value.node`/`value.query`, а не в
 * `children` верхнего уровня).
 */
function propertyNodes(value: unknown, out: any[] = []): any[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) propertyNodes(item, out);
    return out;
  }
  const rec = value as Record<string, unknown>;
  const entity = rec['entity'];
  if (
    entity !== null &&
    typeof entity === 'object' &&
    (entity as Record<string, unknown>)['kind'] === 'property'
  ) {
    out.push(rec);
  }
  for (const [key, child] of Object.entries(rec)) {
    if (key === 'entity') continue;
    propertyNodes(child, out);
  }
  return out;
}

/** Служебные листья места применения (`service: true`) в произвольном дереве. */
function serviceNodes(value: unknown, out: any[] = []): any[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) serviceNodes(item, out);
    return out;
  }
  const rec = value as Record<string, unknown>;
  if (rec['service'] === true) out.push(rec);
  for (const child of Object.values(rec)) serviceNodes(child, out);
  return out;
}

/** Условия по свойствам в дереве панели «Дневника». */
function propertyLeaves(): any[] {
  return propertyNodes(panelMod.getFilterState().tree);
}

/** Условия по свойствам в теле запроса ленты. */
function queryPropertyLeaves(query: any): any[] {
  return propertyNodes(query?.ast?.filter ?? null);
}

/** Живые стенды: упавший кейс не обязан успеть размонтировать экран. */
let mountedScreen: (() => void) | null = null;

afterEach(() => {
  if (mountedScreen !== null) {
    mountedScreen();
    mountedScreen = null;
  }
  panelMod.unmountChronicleFilterPanel();
  catalogueMod.resetPropertyCatalogue();
});

beforeEach(() => {
  registryCalls = 0;
  registryImpl = async () => [];
  queries.length = 0;
});

describe('«Дневник»: чтение реестра свойств (ad063c2f)', () => {
  it('1. отказ preloadFilterRegistry: следующий тик store перечитывает реестр', async () => {
    stateMod.store.update({
      networkId: NET,
      network: null,
      activeView: 'map',
      tabs: [],
      activeTabId: null,
      rtStatusByNetwork: { [NET]: 'connected' },
    } as any);

    // Панель смонтирована — тик store доходит до её собственной подписки.
    const host = new ShimElement('div');
    panelMod.mountChronicleFilterPanel(host as unknown as HTMLElement, {
      apply: () => undefined,
    });
    await flush();
    assert.equal(registryCalls, 1, 'монтирование читает реестр один раз');

    // Отказ вызывающему виден (прежде результат глотался).
    registryImpl = async () => {
      throw new Error('сеть недоступна');
    };
    assert.equal(
      await panelMod.preloadFilterRegistry(),
      false,
      'отказ чтения реестра не глотается — вызывающий узнаёт о нём',
    );
    assert.equal(registryCalls, 2, 'предзагрузка снимка прочитала реестр');

    // Тик store: подпись каталога сброшена отказом, чтение повторяется.
    registryImpl = async () => [];
    stateMod.store.update({});
    await flush();
    assert.equal(
      registryCalls,
      3,
      'отказ не признан отработанным — следующий тик store перечитал реестр',
    );
  });

  it('2. разбор снимка при отказе: тик store перечитывает реестр и возвращает условия свойств', async () => {
    // Снимок ПРЕЖНЕЙ плоской панели: условие по свойству внутри под-выборки
    // целей записи (`targets`). Без реестра конвертер его выбрасывает.
    const snapshot = JSON.stringify({
      filter: {
        targets: { properties: [{ property_id: PROPERTY_ID, op: 'eq', value: '2.0' }] },
        order: 'asc',
      },
      month: null,
      savedFilterId: null,
    });
    // Сеть недоступна на старте: начальное чтение панели (#1) и разбор снимка
    // (#2) получают отказ — реестр на момент разбора пуст. Дальше тик store:
    // панель (#3) и переразбор снимка (#4) читают успешно.
    registryImpl = async (call) =>
      call <= 2 ? Promise.reject(new Error('сеть недоступна')) : [PROPERTY_ROW];

    stateMod.store.update({
      networkId: NET,
      network: null,
      activeView: 'chronicle',
      screen: 'workspace',
      tabs: [
        { tab_id: 'tab-A', network_id: NET, chronicle_state: snapshot },
      ] as any,
      activeTabId: 'tab-A',
      // Связь оборвана на старте — как в сценарии ошибки.
      rtStatusByNetwork: { [NET]: 'offline' },
    } as any);

    const host = new ShimElement('div');
    mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
    await chronicleMod.ensureChronicleInitialised();
    await flush();

    assert.ok(registryCalls >= 2, 'разбор снимка прочитал реестр (и получил отказ)');
    assert.equal(
      propertyLeaves().length,
      0,
      'без реестра условие по свойству не разобрано — воспроизведение дефекта',
    );
    assert.ok(
      queries.every((query) => queryPropertyLeaves(query).length === 0),
      'в применённом отборе условия по свойству нет — условие потеряно',
    );

    // Восстановление связи — штатный тик store: переход в `connected` обязан
    // повторить чтение реестра и переразобрать отложенный снимок, иначе дерево
    // условий остаётся без свойств до смены сети/вкладки.
    stateMod.store.update({ rtStatusByNetwork: { [NET]: 'connected' } });
    await flush();

    assert.ok(
      registryCalls >= 4,
      `повтор прочитал реестр (панель и переразбор), вызовов: ${registryCalls}`,
    );
    const restored = propertyLeaves();
    assert.equal(restored.length, 1, 'условие по свойству вернулось в дерево');
    assert.equal(restored[0]?.entity.property_id, PROPERTY_ID);
    assert.ok(
      queries.some((query) => queryPropertyLeaves(query).length === 1),
      'лента запрошена заново с восстановленным условием по свойству',
    );
  });

  /**
   * Ошибка b177ae40: остаточное окно перетирания правки пользователя в
   * «Дневнике» (та же гонка, что f76a3ef9 в «Структурах»). Подпись состояния
   * сверялась только ДО `await preloadFilterRegistry()`; правка, сделанная пока
   * идёт IPC-чтение, перетиралась переразобранным снимком.
   *
   * Мутационная проба: убрать повторную сверку подписи после await — кейс
   * краснеет (состояние станет снимком, уйдёт лишний перезапрос ленты).
   */
  it('3. правка во время повтора чтения реестра приоритетна — снимок её не перетирает (b177ae40)', async () => {
    const snapshot = JSON.stringify({
      filter: {
        targets: { properties: [{ property_id: PROPERTY_ID, op: 'eq', value: '2.0' }] },
        order: 'asc',
      },
      month: null,
      savedFilterId: null,
    });
    let phase: 'start' | 'recovery' = 'start';
    let recoveryReads = 0;
    let releaseRetry: ((rows: NetworkProperty[]) => void) | null = null;
    // Монтаж: чтения панели и разбора снимка получают отказ (фаза «start»); на
    // восстановлении связи первое чтение (панель) успешно, а чтение повтора
    // разбора «висит» — окно для правки пользователя. Фаза вместо номера вызова:
    // номера зависят от хвостов предыдущих кейсов.
    registryImpl = async () => {
      if (phase === 'start') throw new Error('сеть недоступна');
      recoveryReads += 1;
      if (recoveryReads === 1) return [PROPERTY_ROW];
      return await new Promise<NetworkProperty[]>((resolve) => {
        releaseRetry = resolve;
      });
    };

    stateMod.store.update({
      networkId: NET,
      network: null,
      activeView: 'chronicle',
      screen: 'workspace',
      // Своя вкладка: `networkIdSeen` экрана переживает unmount, и повторный
      // монтаж той же вкладки не переинициализировал бы снимок.
      tabs: [
        { tab_id: 'tab-B', network_id: NET, chronicle_state: snapshot },
      ] as any,
      activeTabId: 'tab-B',
      rtStatusByNetwork: { [NET]: 'offline' },
    } as any);

    const host = new ShimElement('div');
    mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
    await chronicleMod.ensureChronicleInitialised();
    await flush();
    assert.equal(propertyLeaves().length, 0, 'снимок разобран без реестра — воспроизведение');

    // Восстановление связи запускает повтор разбора снимка.
    phase = 'recovery';
    stateMod.store.update({ rtStatusByNetwork: { [NET]: 'connected' } });
    for (let i = 0; i < 60 && releaseRetry === null; i += 1) await flush();
    assert.ok(releaseRetry !== null, 'повтор разбора ждёт чтения реестра');

    // Пользователь правит отбор, ПОКА повтор читает реестр.
    panelMod.setFilterState({
      ...panelMod.getFilterState(),
      tree: {
        kind: 'group',
        op: 'and',
        children: [
          {
            kind: 'leaf',
            entity: { kind: 'keywords', scope: ['title', 'synonyms'] },
            operator: 'matches',
            value: { kind: 'scalar', value: 'правка пользователя' },
          },
        ],
      },
    } as any);
    const queriesAfterEdit = queries.length;

    releaseRetry!([PROPERTY_ROW]);
    await flush();

    assert.equal(
      JSON.stringify(panelMod.getFilterState().tree).includes('правка пользователя'),
      true,
      'правка, сделанная во время чтения, уцелела',
    );
    assert.equal(propertyLeaves().length, 0, 'снимок не перетёр правку');
    assert.equal(queries.length, queriesAfterEdit, 'по снимку ленту не перезапрашивали');

    // Ожидание снято: следующий тик store не разбирает снимок заново.
    stateMod.store.update({});
    await flush();
    assert.equal(queries.length, queriesAfterEdit, 'повтор больше не запускается');
    assert.equal(
      JSON.stringify(panelMod.getFilterState().tree).includes('правка пользователя'),
      true,
      'правка остаётся после следующих тиков',
    );
  });

  /**
   * L4-снимок ТЕКУЩЕЙ формы панели — `{ ast, order }` — при успешном чтении
   * реестра. Прежде `parseChronicleState` гнал его через плоский конвертер
   * (`parseChronicleCriteria` видит AST только на верхнем уровне), дерево
   * терялось целиком, и следующий persist записывал пустой отбор (блокер
   * верификатора, дефект с 0.13.1). Мутация «вернуть плоский разбор снимка»
   * краснит кейс: условие по свойству пропадает из дерева и из запроса.
   *
   * Заодно проверяется служебный лист `service: true` во вложенном ast: он
   * снимается тем же читателем, что в общем чтении определения (roundtrip
   * a65d27d9/ff11075a не меняется).
   */
  it('4. L4: AST-снимок {ast, order} восстанавливается и не перезаписывается пустым (ad063c2f)', async () => {
    const snapshot = JSON.stringify({
      filter: {
        order: 'desc',
        ast: {
          version: 1,
          filter: {
            op: 'and',
            children: [
              {
                entity: { kind: 'targets' },
                operator: 'in',
                value: {
                  query: {
                    op: 'and',
                    children: [
                      {
                        entity: { kind: 'property', property: PROPERTY_ID },
                        operator: 'eq',
                        value: '2.0',
                      },
                    ],
                  },
                  operator: 'in',
                },
              },
              // Служебный дефолт места применения — не условие пользователя.
              { entity: { kind: 'trashed' }, operator: 'eq', value: false, service: true },
            ],
          },
        },
      },
      month: null,
      savedFilterId: null,
    });
    // Реестр читается успешно: потеря не связана с отказом (блокер L4).
    registryImpl = async () => [PROPERTY_ROW];

    stateMod.store.update({
      networkId: NET,
      network: null,
      activeView: 'chronicle',
      screen: 'workspace',
      // Своя вкладка: `networkIdSeen` переживает unmount, повторный монтаж той
      // же вкладки не переинициализировал бы снимок.
      tabs: [
        { tab_id: 'tab-C', network_id: NET, chronicle_state: snapshot },
      ] as any,
      activeTabId: 'tab-C',
      rtStatusByNetwork: { [NET]: 'connected' },
    } as any);

    const host = new ShimElement('div');
    mountedScreen = chronicleMod.mountChronicle(host as unknown as HTMLElement);
    await chronicleMod.ensureChronicleInitialised();
    await flush();

    const restored = propertyLeaves();
    assert.equal(restored.length, 1, 'условие по свойству из AST-снимка восстановлено в дереве');
    // AST-читатель сохраняет wire-поле `property`, плоский конвертер — `property_id`.
    assert.equal(
      restored[0]?.entity.property_id ?? restored[0]?.entity.property,
      PROPERTY_ID,
    );
    assert.equal(panelMod.getFilterState().order, 'desc', 'направление ленты сохранено');
    assert.equal(
      serviceNodes(panelMod.getFilterState().tree).length,
      0,
      'служебный лист service:true снят при чтении',
    );
    assert.ok(
      queries.some((query) => queryPropertyLeaves(query).length === 1),
      'лента запрошена с условием по свойству из AST-снимка',
    );

    // Следующий тик store не переразбирает снимок заново и не сбрасывает дерево:
    // состояние, которое persistState запишет в L4, остаётся непустым.
    stateMod.store.update({});
    await flush();
    assert.equal(propertyLeaves().length, 1, 'дерево не перетёрто пустым отбором');
    assert.equal(
      serviceNodes(panelMod.getFilterState().tree).length,
      0,
      'служебный лист не вернулся на тике store',
    );
  });
});
