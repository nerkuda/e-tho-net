/**
 * Red/green gate for defect 53d21e82 — «Клик по хиту-связи и открытие
 * редактора молча глотают сетевой отказ фокуса».
 *
 * Контракт:
 *  - `openLinkHit` различает stale-хит (404: связь или мысль-источник
 *    удалены после поиска — тишина, редактор не открывается) и
 *    сетевой/серверный отказ (тост из словаря, редактор не открывается);
 *    успех — фокус установлен и связь открыта;
 *  - `openChronoHit` по связи подчиняется тем же правилам — это тот же класс
 *    (инструкция «Исправить ошибку», правило «класс, а не случай»);
 *  - «В фокус» из меню «Действия ▾» редактора гасит rejection
 *    `focusThoughtOnMap` (сбой ленивого импорта `active-view.js`) тостом и
 *    записью в журнал: unhandled rejection не возникает.
 *
 * Сеть/фокус/редактор подменяются тестовым портом `setSearchHitPort`
 * (образец — `comment-thought-insert.ts`); тост проверяется по реальному
 * стеку `notice` в общем DOM-шиме. Гейт обязан краснеть, если вернуть
 * `catch {}` в `reportHitFailure` или убрать `.catch` в
 * `focusOnMapFromMenu`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Link } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = '00000000-0000-4000-8000-00000000000a';
const THOUGHT_ID = '00000000-0000-4000-8000-0000000000a01';

type SearchModule = typeof import('../src/renderer/search/search.js');

/** Ошибка «не найдено» в форме конверта IPC/сервера: stale-хит. */
function notFound(): Error & { code: string } {
  const error = new Error('not found') as Error & { code: string };
  error.code = 'NOT_FOUND';
  return error;
}

/** Минимальная связь для порта: реальный редактор здесь не вызывается. */
function link(id: string): Link {
  return { id, source_id: THOUGHT_ID, target_id: THOUGHT_ID } as unknown as Link;
}

/**
 * DOM-шим, достаточный для `notice` и импорта редактора (CodeMirror
 * import-time probing); набор — как у соседних editor-* тестов.
 */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    getSelection: () => null,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.etn = {
    ui: { setState: async () => undefined, getState: async () => null },
  };
  win.setTimeout = (handler: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
    // TTL тоста (4 с) в юните не крутим: проверяется факт тоста, а не его
    // автоскрытие; длинный таймер держал бы event loop после теста.
    if ((ms ?? 0) > 1000) return 0;
    return (globalThis as any).setTimeout(handler, ms, ...rest);
  };
  win.clearTimeout = (id: any) => (globalThis as any).clearTimeout(id);
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  (globalThis as any).getComputedStyle = win.getComputedStyle;
}

/** Тост-ошибка в стеке уведомлений (или null). */
function errorToast(): ShimElement | null {
  const body = (globalThis as any).document.body as ShimElement;
  const stack = body.querySelector('.notice-stack');
  return stack?.querySelector('.notice.error') ?? null;
}

/** Дать отработать континуациям промисов. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

/** Все unhandled rejection за время сценария. */
async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return reasons;
}

describe('хит-связь в результатах поиска (ошибка 53d21e82)', () => {
  let search: SearchModule;

  beforeEach(async () => {
    shimDom();
    const { store } = await import('../src/renderer/state.js');
    // Поиск существует только в открытой сети: `requireNetworkId` читает стор.
    store.update({ networkId: NET, activeTabId: null } as any);
    search = await import('../src/renderer/search/search.js');
  });

  afterEach(() => {
    search.setSearchHitPort(null);
  });

  it('сетевой отказ загрузки связи: тост, редактор не открыт', async () => {
    let opened = 0;
    search.setSearchHitPort({
      getLink: async () => {
        throw new Error('сервер недоступен');
      },
      setFocus: async () => undefined,
      openLinkInEditor: () => {
        opened += 1;
      },
    });

    await search.searchInternals.openLinkHit('link-1');

    assert.equal(opened, 0, 'редактор не открыт при отказе загрузки');
    const toast = errorToast();
    assert.ok(toast !== null, 'тост об отказе показан');
    assert.match(toast.flatText(), /Не удалось открыть связь/u);
    assert.match(toast.flatText(), /сервер недоступен/u);
  });

  it('stale: связь не найдена — тишина, редактор не открыт', async () => {
    let opened = 0;
    search.setSearchHitPort({
      getLink: async () => {
        throw notFound();
      },
      setFocus: async () => undefined,
      openLinkInEditor: () => {
        opened += 1;
      },
    });

    await search.searchInternals.openLinkHit('link-gone');

    assert.equal(opened, 0, 'редактор не открыт для устаревшего хита');
    assert.equal(errorToast(), null, 'stale-хит не шумит тостом');
  });

  it('сетевой отказ установки фокуса: тост, редактор не открыт', async () => {
    let opened = 0;
    search.setSearchHitPort({
      getLink: async (_networkId, linkId) => link(linkId),
      setFocus: async () => {
        throw new Error('сеть недоступна');
      },
      openLinkInEditor: () => {
        opened += 1;
      },
    });

    await search.searchInternals.openLinkHit('link-2');

    assert.equal(opened, 0, 'редактор не открыт, пока фокус не установлен');
    const toast = errorToast();
    assert.ok(toast !== null, 'отказ фокуса не проглочен');
    assert.match(toast.flatText(), /Не удалось открыть связь/u);
    assert.match(toast.flatText(), /сеть недоступна/u);
  });

  it('stale: мысль-источник не найдена при фокусе — тишина, редактор не открыт', async () => {
    let opened = 0;
    search.setSearchHitPort({
      getLink: async (_networkId, linkId) => link(linkId),
      setFocus: async () => {
        throw notFound();
      },
      openLinkInEditor: () => {
        opened += 1;
      },
    });

    await search.searchInternals.openLinkHit('link-3');

    assert.equal(opened, 0, 'редактор не открыт');
    assert.equal(errorToast(), null, 'stale-хит не шумит тостом');
  });

  it('успех: фокус установлен, связь открыта в редакторе', async () => {
    const focused: string[] = [];
    const opened: string[] = [];
    search.setSearchHitPort({
      getLink: async (_networkId, linkId) => link(linkId),
      setFocus: async (thoughtId) => {
        focused.push(thoughtId);
      },
      openLinkInEditor: (value) => {
        opened.push(value.id);
      },
    });

    await search.searchInternals.openLinkHit('link-4');

    assert.deepEqual(focused, [THOUGHT_ID], 'фокус поставлен на источник связи');
    assert.deepEqual(opened, ['link-4'], 'связь открыта после успешного фокуса');
    assert.equal(errorToast(), null, 'успешный путь не шумит');
  });

  it('хроно-хит по связи: сетевой отказ — тост (тот же класс)', async () => {
    let opened = 0;
    search.setSearchHitPort({
      getLink: async () => {
        throw new Error('сервер недоступен');
      },
      setFocus: async () => undefined,
      openLinkInEditor: () => {
        opened += 1;
      },
    });

    await search.searchInternals.openChronoHit('link', 'link-5');

    assert.equal(opened, 0, 'редактор не открыт');
    const toast = errorToast();
    assert.ok(toast !== null, 'отказ открытия из хронологии не проглочен');
    assert.match(toast.flatText(), /Не удалось открыть связь/u);
  });
});

describe('«В фокус» из меню редактора (ошибка 53d21e82)', () => {
  beforeEach(() => {
    shimDom();
  });

  it('rejection focusThoughtOnMap: нет unhandled, тост и запись в журнал', async () => {
    const { store } = await import('../src/renderer/state.js');
    // `canSave()` проверяет подключение сети: без этого помощник ушёл бы в
    // offline-подсказку и до обработки rejection дело бы не дошло.
    store.update({
      networkId: NET,
      activeTabId: null,
      rtStatusByNetwork: { [NET]: 'connected' },
    } as any);
    const { editorInternals } = await import('../src/renderer/editor/editor.js');

    let called = 0;
    const logged: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(args[0]);
    };
    try {
      const reasons = await collectUnhandled(async () => {
        editorInternals.focusOnMapFromMenu(async () => {
          called += 1;
          throw new Error('сбой загрузки экрана');
        }, THOUGHT_ID);
      });

      assert.equal(called, 1, 'действие «В фокус» выполнено');
      assert.deepEqual(reasons, [], 'unhandled rejection нет');
      assert.equal(logged.length, 1, 'отказ записан в журнал');
      const toast = errorToast();
      assert.ok(toast !== null, 'тост об отказе показан');
      assert.match(toast.flatText(), /Не удалось открыть карту мыслей/u);
      assert.match(toast.flatText(), /сбой загрузки экрана/u);
    } finally {
      console.error = originalError;
    }
  });
});
