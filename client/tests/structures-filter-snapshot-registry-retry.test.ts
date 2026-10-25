/**
 * «Структуры»: разбор снимка отбора учитывает отказ чтения реестра свойств
 * (ошибка cdeb62f1; класс «чтение без учёта отказа», закрытый в 76282fbc и
 * d3a30c3e).
 *
 * Две точки класса — обе в объёме ошибки:
 *   1. `preloadFilterRegistry()` (filter-panel.ts) глотал результат чтения:
 *      вызывающий не мог узнать об отказе и разбирал снимок с пустым реестром.
 *      Кейс 1: отказ виден вызывающему, подпись каталога сброшена — следующий
 *      тик store повторяет чтение (мутация «проглотить `ok`» краснит его);
 *   2. `structures.ts` при отказе разбирал снимок с пустым реестром и не
 *      переразбирал его после перечитывания: условия по свойствам терялись до
 *      смены сети/вкладки. Кейс 2: следующий тик store перечитывает реестр,
 *      ПЕРЕРАЗБИРАЕТ отложенный снимок и перезапрашивает страницу — условия по
 *      свойствам появляются в дереве и уходят в запрос (мутация «не проверять
 *      результат preload» краснит его).
 *
 * Экран «Структур» монтируется ЦЕЛИКОМ на DOM-шиме (`./dom-shim.js`): тик
 * store проверяется через настоящую подписку экрана, а не через вызов
 * внутренней функции. Мост `window.etn` — управляемая заглушка; реестр свойств
 * отвечает по номеру вызова, поэтому отказ назначается конкретной точке чтения
 * (монтаж панели → разбор снимка → повтор).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

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

/** Фильтры запросов отбора — журнал для проверки применённого снимка. */
const queryFilters: any[] = [];

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
  structures: {
    query: async (_networkId: string, filter: any) => {
      queryFilters.push(filter);
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

const stateMod = await import('../src/renderer/state.js');
const panelMod = await import('../src/renderer/screens/structures/filter-panel.js');
const structuresMod = await import('../src/renderer/screens/structures/structures.js');
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

/** Листья дерева модели условий в порядке обхода. */
function leaves(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node.children)) {
    for (const child of node.children) leaves(child, out);
    return out;
  }
  out.push(node);
  return out;
}

/** Листья AST (плоский `children` без `kind: 'leaf'`) в порядке обхода. */
function astLeaves(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node.children)) {
    for (const child of node.children) astLeaves(child, out);
    return out;
  }
  out.push(node);
  return out;
}

/** Условия по свойствам в дереве панели. */
function propertyLeaves(): any[] {
  return leaves(panelMod.getFilterState().tree).filter(
    (leaf) => leaf.entity?.kind === 'property',
  );
}

/** Живые стенды: упавший кейс не обязан успеть размонтировать экран. */
let mountedStructures: (() => void) | null = null;

afterEach(() => {
  if (mountedStructures !== null) {
    mountedStructures();
    mountedStructures = null;
  }
  panelMod.unmountFilterPanel();
  catalogueMod.resetPropertyCatalogue();
});

describe('«Структуры»: реестр свойств при разборе снимка (cdeb62f1)', () => {
  it('1. отказ preloadFilterRegistry: следующий тик store перечитывает реестр', async () => {
    stateMod.store.update({
      networkId: NET,
      network: null,
      activeView: 'map',
      tabs: [],
      activeTabId: null,
      rtStatusByNetwork: { [NET]: 'connected' },
    } as any);
    registryCalls = 0;
    registryImpl = async () => [];

    // Панель смонтирована — тик store доходит до её собственной подписки.
    const host = new ShimElement('div');
    panelMod.mountFilterPanel(host as unknown as HTMLElement, {
      onApply: () => undefined,
      onStatePersist: () => undefined,
      onCommands: () => undefined,
    });
    await flush();
    assert.equal(registryCalls, 1, 'монтирование читает реестр один раз');

    // Отказ вызывающему виден (точка 1: прежде результат глотался).
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

  it('2. разбор снимка при отказе: тик store перечитывает реестр и возвращает условия по свойствам', async () => {
    // Снимок ПРЕЖНЕЙ плоской панели с условием по свойству: без реестра
    // конвертер его выбрасывает (buildConditionsWire).
    const snapshot = JSON.stringify({
      properties: [{ propertyId: PROPERTY_ID, op: 'eq', values: ['2.0'] }],
      sort: 'alpha',
      order: 'asc',
    });
    registryCalls = 0;
    queryFilters.length = 0;
    // Сеть недоступна на старте: и начальное чтение панели (#1), и разбор
    // снимка (#2) получают отказ — реестр на момент разбора пуст. Дальше тик
    // store: панель (#3) и переразбор снимка (#4) читают успешно.
    registryImpl = async (call) =>
      call <= 2 ? Promise.reject(new Error('сеть недоступна')) : [PROPERTY_ROW];

    stateMod.store.update({
      networkId: NET,
      network: null,
      activeView: 'structures',
      screen: 'workspace',
      tabs: [
        { tab_id: 'tab-A', network_id: NET, structures_state: snapshot },
      ] as any,
      activeTabId: 'tab-A',
      // Связь оборвана на старте — как в сценарии ошибки: чтения реестра
      // отказывают, дерево условий остаётся без свойств.
      rtStatusByNetwork: { [NET]: 'offline' },
    } as any);

    const host = new ShimElement('div');
    mountedStructures = structuresMod.mountStructures(host as unknown as HTMLElement);
    await flush();

    assert.equal(registryCalls, 2, 'разбор снимка прочитал реестр (и получил отказ)');
    assert.equal(
      propertyLeaves().length,
      0,
      'без реестра условие по свойству не разобрано — воспроизведение дефекта',
    );
    assert.equal(queryFilters.length, 1, 'страница запрошена по снимку');
    assert.ok(
      !astLeaves(queryFilters[0]?.ast?.filter).some(
        (leaf) => leaf.entity?.kind === 'property',
      ),
      'в применённом отборе условия по свойству нет — условие потеряно',
    );

    // Восстановление связи — штатный тик store: переход в `connected` обязан
    // повторить чтение реестра и переразобрать отложенный снимок, иначе дерево
    // условий остаётся без свойств до смены сети/вкладки.
    stateMod.store.update({ rtStatusByNetwork: { [NET]: 'connected' } });
    await flush();

    assert.equal(registryCalls, 4, 'повтор прочитал реестр (панель и переразбор)');
    const restored = propertyLeaves();
    assert.equal(restored.length, 1, 'условие по свойству вернулось в дерево');
    assert.equal(restored[0]?.entity.property_id, PROPERTY_ID);
    assert.equal(queryFilters.length, 2, 'отбор применён заново — страница перезапрошена');
    assert.ok(
      astLeaves(queryFilters[1]?.ast?.filter).some(
        (leaf) => leaf.entity?.kind === 'property',
      ),
      'применённый отбор снова несёт условие по свойству',
    );
  });

  /**
   * Ошибка f76a3ef9: остаточное окно перетирания правки пользователя. Подпись
   * состояния сверялась только ДО `await preloadFilterRegistry()`; правка,
   * сделанная пока идёт IPC-чтение, перетиралась разобранным снимком.
   *
   * Мутационная проба: убрать повторную сверку подписи после await — кейс
   * краснеет (состояние станет снимком, уйдёт лишний перезапрос страницы).
   */
  it('3. правка во время повтора чтения реестра приоритетна — снимок её не перетирает (f76a3ef9)', async () => {
    const snapshot = JSON.stringify({
      properties: [{ propertyId: PROPERTY_ID, op: 'eq', values: ['2.0'] }],
      sort: 'alpha',
      order: 'asc',
    });
    registryCalls = 0;
    queryFilters.length = 0;
    let releaseRetry: ((rows: NetworkProperty[]) => void) | null = null;
    // Монтаж: чтения панели и разбора снимка получают отказ (фаза «start»); на
    // восстановлении связи первое чтение (панель) успешно, а чтение повтора
    // разбора «висит» — окно для правки пользователя. Фаза вместо номера вызова:
    // номера зависят от хвостов предыдущих кейсов.
    let phase: 'start' | 'recovery' = 'start';
    let recoveryReads = 0;
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
      activeView: 'structures',
      screen: 'workspace',
      // Своя вкладка: `networkIdSeen` экрана переживает unmount, и повторный
      // монтаж той же вкладки не переинициализировал бы снимок.
      tabs: [
        { tab_id: 'tab-B', network_id: NET, structures_state: snapshot },
      ] as any,
      activeTabId: 'tab-B',
      rtStatusByNetwork: { [NET]: 'offline' },
    } as any);

    const host = new ShimElement('div');
    mountedStructures = structuresMod.mountStructures(host as unknown as HTMLElement);
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
    const queriesAfterEdit = queryFilters.length;

    releaseRetry!([PROPERTY_ROW]);
    await flush();

    const after = leaves(panelMod.getFilterState().tree);
    assert.equal(after.length, 1, 'в дереве ровно правка пользователя');
    assert.equal(
      (after[0]?.value as { value?: unknown } | undefined)?.value,
      'правка пользователя',
      'правка, сделанная во время чтения, уцелела',
    );
    assert.equal(propertyLeaves().length, 0, 'снимок не перетёр правку');
    assert.equal(queryFilters.length, queriesAfterEdit, 'по снимку не перезапрашивали');

    // Ожидание снято: следующий тик store не разбирает снимок заново.
    stateMod.store.update({});
    await flush();
    assert.equal(queryFilters.length, queriesAfterEdit, 'повтор больше не запускается');
    assert.equal(
      (leaves(panelMod.getFilterState().tree)[0]?.value as { value?: unknown } | undefined)?.value,
      'правка пользователя',
      'правка остаётся после следующих тиков',
    );
  });
});
