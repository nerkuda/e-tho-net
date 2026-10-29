/**
 * Панель отбора «Структур»: отказ чтения реестра свойств не считается
 * отработанным, а подпись каталога принадлежит смонтированной панели
 * (ошибка 76282fbc, остаток замечания верификатора; задача d3a30c3e).
 *
 * Контракт закрепляется двумя регресс-тестами:
 *   1. отказ НАЧАЛЬНОГО чтения при монтировании оставляет подпись пустой —
 *      следующий тик store повторяет чтение (мутация «писать подпись и при
 *      отказе» — `catalogueSignature = initialSignature;` — краснит тест);
 *   2. подпись не переживает unmount: повторное монтирование начинает с чистой
 *      подписи, поэтому тик store не подавляется подписью прошлого монтажа,
 *      даже пока начальное чтение нового монтажа ещё не завершилось (мутация
 *      «убрать сброс в `unmountFilterPanel`» краснит тест).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`); реестр подменяется
 * управляемой заглушкой `window.etn.propertyRegistry.list`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/** Сколько раз панель прочитала реестр (все чтения, включая отказные). */
let listCalls = 0;
/** Поведение чтения по номеру вызова (1-based): разрешено бросать. */
let listImpl: (call: number) => Promise<NetworkProperty[]> = async () => [];

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win['localStorage'] = { getItem: () => null, setItem: () => undefined };
  // Каркас панели наблюдает за размером контейнера; в тесте достаточно no-op.
  (globalThis as any).ResizeObserver = class {
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
  win['etn'] = {
    // Единственный вход, который проверяет этот тест: чтение реестра свойств.
    propertyRegistry: {
      list: async (): Promise<NetworkProperty[]> => {
        listCalls += 1;
        return listImpl(listCalls);
      },
    },
    // Остальное — минимальный шим транзитивных вызовов сборки панели.
    savedFilters: {
      list: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      remove: async () => undefined,
    },
    thoughts: { resolve: async () => [] },
    tabs: { updateState: async () => undefined },
    ui: { getState: async () => null, setState: async () => undefined },
  };
}

installShim();

const stateMod = await import('../src/renderer/state.js');
const panelMod = await import('../src/renderer/screens/structures/filter-panel.js');

/** Дождаться асинхронных чтений реестра и их продолжений. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Смонтировать панель в отсоединённый хост шима. */
function mount(): ShimElement {
  const host = new ShimElement('div');
  panelMod.mountFilterPanel(host as unknown as HTMLElement, {
    onApply: () => undefined,
    onStatePersist: () => undefined,
    onCommands: () => undefined,
  });
  return host;
}

describe('панель «Структур»: чтение реестра свойств (76282fbc, d3a30c3e)', () => {
  beforeEach(() => {
    // Сеть задана — иначе чтение реестра не выполняется вовсе. Состав подписи
    // (типы/видимость/rt-статус) между монтированиями не меняется.
    stateMod.store.update({ networkId: 'net-1', network: null });
    listCalls = 0;
    listImpl = async () => [];
  });

  it('отказ начального чтения: следующий тик store читает реестр снова', async () => {
    listImpl = async (call) => {
      if (call === 1) throw new Error('сеть недоступна');
      return [];
    };
    mount();
    await flush();
    assert.equal(listCalls, 1, 'монтирование читает реестр один раз');

    // Тик store без изменения подписи: пустой патч всё равно рассылается
    // подписчикам. Если отказное чтение записало подпись, тик его не повторит.
    stateMod.store.update({});
    await flush();

    assert.equal(listCalls, 2, 'отказ не признан отработанным — тик повторил чтение');
    panelMod.unmountFilterPanel();
  });

  it('подпись не переживает unmount: повторный монтаж читает заново', async () => {
    mount();
    await flush();
    assert.equal(listCalls, 1, 'первое монтирование прочитало реестр');
    panelMod.unmountFilterPanel();

    // Начальное чтение ПОВТОРНОГО монтажа «зависло»: подпись прошлого
    // монтажа не должна подавлять чтение по тику store.
    let release: (rows: NetworkProperty[]) => void = () => undefined;
    const pending = new Promise<NetworkProperty[]>((resolve) => {
      release = resolve;
    });
    listImpl = async (call) => (call === 2 ? pending : []);
    mount();
    assert.equal(listCalls, 2, 'повторный монтаж начал чтение реестра');

    stateMod.store.update({});
    assert.equal(listCalls, 3, 'тик store читает, не дожидаясь зависшего начального чтения');

    release([]);
    await flush();
    panelMod.unmountFilterPanel();
  });
});
