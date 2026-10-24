/**
 * Полоса истории: восстановление после сбоя соединения при запуске
 * (ошибка 76282fbc).
 *
 * Дефект: подпись входов полосы не покрывала все реальные входы чтения —
 * активную вкладку (`history.list` ведётся по «профиль × сеть × вкладка») и
 * состояние соединения, — и записывалась ДО запроса. Отказ/пустое чтение при
 * кратковременном сбое связи залипало: повторный `render()` по store-подписке
 * выходил по совпадению подписи, и полоса оставалась пустой до перезапуска
 * клиента.
 *
 * Тест гоняет сам модуль (не regex по исходнику): шим DOM + фальшивый мост
 * `window.etn`, реальный store. Сценарии:
 *  1. отказ чтения → следующее событие store (переход статуса в `connected`)
 *     перечитывает историю — полоса заполняется без перезапуска;
 *  2. смена статуса соединения перечитывает полосу и до-разрешает заголовки
 *     (офлайн облачка рисовались сырыми id — ошибка 90a92c82);
 *  3. смена активной вкладки при том же фокусе перечитывает историю этой
 *     вкладки (вкладка — вход чтения, а не только сеть);
 *  4. без изменения входов лишнего чтения нет (подпись по-прежнему кэширует);
 *  5. отказ при НЕИЗМЕННОМ статусе не залипает: подпись, снятая до чтения,
 *     сбрасывается на отказе, и следующий тик store повторяет чтение (мутация
 *     «убрать сброс» делает кейс красным).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';


type Dict = Record<string, unknown>;

/** Запись фальшивого моста: что и сколько раз просили. */
interface BridgeLog {
  historyList: (string | null)[];
}

interface Harness {
  host: ShimElement;
  store: typeof import('../src/renderer/state.js').store;
  log: BridgeLog;
  unmount: () => void;
  /** Дать отработать асинхронному render (чтение → resolve → отрисовка). */
  flush: () => Promise<void>;
  /** Текст облачков полосы (пусто — ни одного). */
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
  // Наблюдатель ширины в шиме не нужен: подпись включает clientWidth напрямую.
  (globalThis as Dict).ResizeObserver = class {
    observe(): void {
      /* шим: раскладки нет */
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
 * Собранный стенд предыдущего теста — снимается первым делом при следующем
 * монтаже: упавший тест не обязан успеть вызвать свой `unmount`, а `host` и
 * кэш подписи в модуле полосы — единые на файл.
 */
let activeUnmount: (() => void) | null = null;

/**
 * Собрать стенд: импортировать настоящие store и модуль полосы, смонтировать
 * её в шим-хост, выставить «сеть открыта, вкладка A».
 */
async function mountBar(options: {
  list: (tabId: string | null) => Promise<{ thoughtId: string; visitedAt: string }[]>;
  resolve?: (ids: string[]) => Promise<Dict[]>;
  status?: 'connecting' | 'connected' | 'offline';
}): Promise<Harness> {
  activeUnmount?.();
  activeUnmount = null;
  const log: BridgeLog = { historyList: [] };
  const bridge: Dict = {
    history: {
      list: (_profileId: string, _networkId: string, tabId: string | null) => {
        log.historyList.push(tabId ?? null);
        return options.list(tabId ?? null);
      },
    },
    thoughts: {
      resolve: (_networkId: string, ids: string[]) =>
        options.resolve === undefined
          ? Promise.resolve(ids.map((id) => ({ id, title: `t-${id}`, active: true })))
          : options.resolve(ids),
    },
  };
  installShims(bridge);
  const { store } = await import('../src/renderer/state.js');
  const { mountHistoryBar } = await import('../src/renderer/screens/history-bar.js');
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
  const host = new ShimElement('div', 'history-bar') as unknown as HTMLElement;
  const unmount = mountHistoryBar(host);
  activeUnmount = unmount;
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const chips = (): string[] =>
    (host as unknown as ShimElement)
      .findAll('history-cloud')
      .map((chip) => chip.flatText());
  return { host: host as unknown as ShimElement, store, log, unmount, flush, chips };
}

describe('полоса истории: повтор после сбоя соединения (76282fbc)', () => {
  it('отказ чтения не залипает: переход статуса в connected перечитывает историю', async () => {
    let calls = 0;
    const harness = await mountBar({
      // Первое чтение — «сбой связи при запуске», дальше история доступна.
      list: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Нет соединения с сервером.');
        const result = [
          { thoughtId: 'alpha', visitedAt: '' },
          { thoughtId: 'beta', visitedAt: '' },
        ];
        return result;
      },
      status: 'offline',
    });
    await harness.flush();
    assert.equal(harness.log.historyList.length, 1, 'стартовое чтение упало');
    assert.deepEqual(harness.chips(), [], 'после отказа полоса пуста');
    assert.equal(
      (harness.host as unknown as ShimElement).textContent,
      '',
      'на отказе не выдумываем «нет предыдущих мыслей»',
    );

    // Связь вернулась — это тот самый тик store, на котором полоса обязана
    // перечитать историю (иначе пустая полоса живёт до перезапуска клиента).
    harness.store.update({
      rtStatusByNetwork: { 'network-1': 'connected' },
      rtStatus: 'connected',
    });
    await harness.flush();
    assert.equal(harness.log.historyList.length, 2, 'после восстановления связи — повтор чтения');
    assert.deepEqual(
      harness.chips().sort(),
      ['t-alpha', 't-beta'],
      'облачка истории отрисованы без перезапуска',
    );
    harness.unmount();
  });

  it('смена статуса соединения до-разрешает заголовки, а не держит сырые id', async () => {
    let online = false;
    const harness = await mountBar({
      // Свежие id вне кэша слоя: офлайн их заголовки взять неоткуда.
      list: async () => [
        { thoughtId: 'offline-alpha', visitedAt: '' },
        { thoughtId: 'offline-beta', visitedAt: '' },
      ],
      // Офлайн резолв падает — облачка рисуются сырыми id (90a92c82).
      resolve: async (ids) => {
        if (!online) throw new Error('Нет соединения с сервером.');
        return ids.map((id) => ({ id, title: `t-${id}`, active: true }));
      },
      status: 'offline',
    });
    await harness.flush();
    assert.deepEqual(harness.chips().sort(), ['offline-alpha', 'offline-beta'], 'офлайн — сырые id из кэша');

    online = true;
    harness.store.update({
      rtStatusByNetwork: { 'network-1': 'connected' },
      rtStatus: 'connected',
    });
    await harness.flush();
    assert.deepEqual(
      harness.chips().sort(),
      ['t-offline-alpha', 't-offline-beta'],
      'после восстановления связи заголовки перечитаны сервером',
    );
    harness.unmount();
  });

  it('смена активной вкладки при том же фокусе читает историю новой вкладки', async () => {
    const byTab: Record<string, { thoughtId: string; visitedAt: string }[]> = {
      'tab-A': [{ thoughtId: 'alpha', visitedAt: '' }],
      'tab-B': [{ thoughtId: 'gamma', visitedAt: '' }],
    };
    const harness = await mountBar({
      list: async (tabId) => byTab[tabId ?? ''] ?? [],
      status: 'connected',
    });
    await harness.flush();
    assert.deepEqual(harness.chips(), ['t-alpha'], 'вкладка A показывает свою историю');

    // Фокус/вид/ширина не меняются — меняется только активная вкладка.
    harness.store.update({ activeTabId: 'tab-B' });
    await harness.flush();
    assert.equal(harness.log.historyList.at(-1), 'tab-B', 'чтение ушло по новой вкладке');
    assert.deepEqual(harness.chips(), ['t-gamma'], 'полоса показывает историю вкладки B');
    harness.unmount();
  });

  it('без изменения входов лишнего чтения нет (кэш подписи сохранён)', async () => {
    const harness = await mountBar({
      list: async () => [{ thoughtId: 'alpha', visitedAt: '' }],
      status: 'connected',
    });
    await harness.flush();
    assert.equal(harness.log.historyList.length, 1);
    harness.store.update({ lastEvent: 'что-то пришло по realtime' });
    await harness.flush();
    assert.equal(harness.log.historyList.length, 1, 'тот же вход — без повторного чтения');
    harness.unmount();
  });

  it('отказ при неизменном статусе сбрасывает подпись: следующий тик store читает снова', async () => {
    let calls = 0;
    const harness = await mountBar({
      // Статус всё время `connected`: восстановление связи как повод не годится,
      // повтор обязана дать именно ветка сброса подписи на отказе.
      list: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Локальная БД занята.');
        return [{ thoughtId: 'alpha', visitedAt: '' }];
      },
      status: 'connected',
    });
    await harness.flush();
    assert.equal(harness.log.historyList.length, 1, 'стартовое чтение упало');
    assert.deepEqual(harness.chips(), [], 'после отказа полоса пуста');

    // Посторонний тик store: входы чтения и статус не изменились. Подпись
    // обязана быть сброшена на отказе — иначе повторного чтения не будет.
    harness.store.update({ lastEvent: 'что-то пришло по realtime' });
    await harness.flush();
    assert.equal(harness.log.historyList.length, 2, 'отказ не зафиксировал подпись — чтение повторено');
    assert.deepEqual(harness.chips(), ['t-alpha'], 'полоса заполнилась без смены статуса');
    harness.unmount();
  });
});
