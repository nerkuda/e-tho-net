/**
 * Панель закреплённых: восстановление чипов после сбоя соединения
 * (ошибка 76282fbc, правило аналогов).
 *
 * Дефект (тот же класс, что полоса истории): подпись рендера закреплённых
 * фиксировалась ДО серверного чтения метаданных (`thoughts.resolve`) и не
 * включала статус соединения. Обрыв в момент чтения оставлял на панели сырые
 * id: следующий `render()` по store-тику выходил по совпадению подписи, и
 * заголовки не восстанавливались до перезапуска клиента.
 *
 * Тест гоняет сам модуль (не regex по исходнику): шим DOM + фальшивый мост
 * `window.etn`, реальный store и реальный слой запросов (срез `pins`). Кейсы:
 *  1. обрыв при кэш-холодном id → reconnect → заголовки восстановились
 *     (статус соединения входит в подпись — без него на дофиксовом коде
 *     панель навсегда остаётся с сырым id);
 *  2. отказ резолва при неизменном статусе не залипает: следующий тик store
 *     повторяет чтение (ветка сброса подписи — без сброса кейс краснеет).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

type Dict = Record<string, unknown>;

interface Harness {
  host: ShimElement;
  store: typeof import('../src/renderer/state.js').store;
  /** Положить новый порядок закреплённых в срез `pins` (кэш слоя). */
  setPins: (ids: string[]) => void;
  /** Сколько раз панель просила метаданные у сервера. */
  resolveCalls: () => number;
  unmount: () => void;
  /** Дать отработать асинхронному render (чтение → resolve → отрисовка). */
  flush: () => Promise<void>;
  /** Текст чипов панели (пусто — ни одного). */
  chips: () => string[];
}

/**
 * Шимы `document`/`window`/`ResizeObserver`. Ставятся ДО первого импорта
 * модулей экрана: `lib/etn.ts` читает `window.etn` при каждом обращении,
 * а элементы строит `lib/dom.ts` через `document.createElement`.
 */
function installShims(bridge: Dict): void {
  (globalThis as Dict).HTMLElement = ShimElement;
  (globalThis as Dict).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  } satisfies Dict;
  const win = ((globalThis as Dict).window ?? ((globalThis as Dict).window = {})) as Dict;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.etn = bridge;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
  // Наблюдатель ширины в шиме не нужен: раскладки нет, чипы не переносятся.
  (globalThis as Dict).ResizeObserver = class {
    observe(): void {
      /* шим */
    }
    unobserve(): void {
      /* шим */
    }
    disconnect(): void {
      /* шим */
    }
  };
}

/**
 * Стенд предыдущего теста снимается первым делом при следующем монтаже: упавший
 * тест не обязан успеть вызвать `unmount`, а `host` и кэш подписи в модуле
 * панели — единые на файл.
 */
let activeUnmount: (() => void) | null = null;

/**
 * Собрать стенд: реальные store / срез `pins` / модуль панели, «сеть открыта».
 * Срез закреплённых засевается готовым списком — это кэш слоя, переживающий
 * обрыв (сам `pins.list` в этот момент недоступен).
 */
async function mountBar(options: {
  pins: string[];
  resolve: (ids: string[]) => Promise<Dict[]>;
  status?: 'connecting' | 'connected' | 'offline';
}): Promise<Harness> {
  activeUnmount?.();
  activeUnmount = null;
  let resolveCalls = 0;
  const bridge: Dict = {
    pins: {
      list: () => Promise.resolve(options.pins.map((id) => ({ thought_id: id, position: 0 }))),
    },
    thoughts: {
      resolve: (_networkId: string, ids: string[]) => {
        resolveCalls += 1;
        return options.resolve(ids);
      },
    },
  };
  installShims(bridge);
  const { store } = await import('../src/renderer/state.js');
  const { setQueryData, queryKeys } = await import('../src/renderer/lib/live/index.js');
  const { mountPinnedBar } = await import('../src/renderer/screens/pinned-bar.js');
  store.update({
    profileId: 'profile-1',
    networkId: 'network-1',
    activeTabId: 'tab-A',
    activeView: 'map',
    screen: 'workspace',
    editorTarget: null,
    focus: null,
    showInactive: false,
    showTrash: true,
    rtStatusByNetwork: { 'network-1': options.status ?? 'connecting' },
  });
  // Срез `pins` — кэш слоя: панель читает порядок отсюда, метаданные — с сервера.
  setQueryData(queryKeys.pins(), options.pins);
  const host = new ShimElement('div', 'pinned-bar') as unknown as HTMLElement;
  const unmount = mountPinnedBar(host);
  activeUnmount = unmount;
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const chips = (): string[] =>
    (host as unknown as ShimElement).findAll('pinned-chip').map((chip) => chip.flatText());
  return {
    host: host as unknown as ShimElement,
    store,
    setPins: (ids: string[]) => setQueryData(queryKeys.pins(), ids),
    resolveCalls: () => resolveCalls,
    unmount,
    flush,
    chips,
  };
}

describe('панель закреплённых: повтор после сбоя соединения (76282fbc)', () => {
  it('обрыв при кэш-холодных id не залипает: reconnect восстанавливает заголовки', async () => {
    let online = true;
    const harness = await mountBar({
      pins: ['pin-alpha'],
      resolve: async (ids) => {
        if (!online) throw new Error('Нет соединения с сервером.');
        return ids.map((id) => ({ id, title: `t-${id}`, active: true }));
      },
      status: 'connected',
    });
    await harness.flush();
    assert.deepEqual(harness.chips(), ['t-pin-alpha'], 'на связи заголовок резолвится');

    // Обрыв: в срез приходит новый закреплённый id, метаданных о нём в кэше нет
    // (кэш-холодный) — чип рисуется сырым id.
    online = false;
    harness.setPins(['pin-alpha', 'pin-cold']);
    await harness.flush();
    assert.deepEqual(
      harness.chips().sort(),
      ['pin-cold', 't-pin-alpha'],
      'офлайн новый чип — сырой id, старый берётся из кэша',
    );

    // Store тик обрыва, затем восстановление связи (как в жизни: статус сети
    // становится connected). Без статуса в подписи дофиксовый код не
    // перерисует панель — сырой id останется навсегда.
    harness.store.update({
      rtStatusByNetwork: { 'network-1': 'offline' },
      rtStatus: 'offline',
    });
    await harness.flush();
    assert.deepEqual(
      harness.chips().sort(),
      ['pin-cold', 't-pin-alpha'],
      'пока связи нет — сырой id остаётся',
    );

    online = true;
    harness.store.update({
      rtStatusByNetwork: { 'network-1': 'connected' },
      rtStatus: 'connected',
    });
    await harness.flush();
    assert.deepEqual(
      harness.chips().sort(),
      ['t-pin-alpha', 't-pin-cold'],
      'после восстановления связи заголовки перечитаны без перезапуска клиента',
    );
    harness.unmount();
  });

  it('отказ резолва при неизменном статусе повторяется на следующем тике store', async () => {
    let fail = true;
    const harness = await mountBar({
      pins: ['pin-beta'],
      resolve: async (ids) => {
        if (fail) throw new Error('Нет соединения с сервером.');
        return ids.map((id) => ({ id, title: `t-${id}`, active: true }));
      },
      status: 'connected',
    });
    await harness.flush();
    assert.deepEqual(harness.chips(), ['pin-beta'], 'на отказе чип — сырой id');
    const failedCalls = harness.resolveCalls();
    assert.ok(failedCalls >= 1, 'резолв действительно пробовали');

    // Посторонний тик store: входы и статус не менялись. Подпись обязана быть
    // сброшена на отказе, иначе повторного чтения не будет (мутация «убрать
    // сброс» делает кейс красным).
    fail = false;
    harness.store.update({ lastEvent: 'что-то пришло по realtime' });
    await harness.flush();
    assert.ok(harness.resolveCalls() > failedCalls, 'отказ не зафиксировал подпись — чтение повторено');
    assert.deepEqual(harness.chips(), ['t-pin-beta'], 'заголовок восстановился без смены статуса');
    harness.unmount();
  });
});
