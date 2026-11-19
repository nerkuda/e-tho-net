/**
 * Автоперечитывание панели «Задачи» на событие комментария (0.16.1, уточнение
 * 2026-11-19, пункт 4).
 *
 * **Что было.** Панель редактора мысли показывала новую задачу только после
 * смены мысли: сохранение комментария публиковало `comment.updated`, но панель
 * ждала ручного маркера «Обновить».
 *
 * **Что стало.** Опция `autoRefreshOnCommentChange` (включена зоной «Задачи»
 * редактора) перечитывает панель по событию комментария с дебаунсом: несколько
 * событий одной записи дают ОДИН запрос. Панель «Дневника» опцию не включает —
 * у неё прежний маркер «Обновить».
 *
 * Тест монтирует настоящий `mountTaskList` с подставным мостом `window.etn`,
 * гонит событие через реальный маршрутизатор (`routeRealtimeEvent`) и считает
 * сетевые вызовы панели.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** Дождаться промисов загрузки панели. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Подождать дебаунс автоперечитывания (150 мс) с запасом. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Минимальный DOM и мост `window.etn` с подставным `tasks.list`. */
function shim(): { listCalls: () => number } {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body,
    activeElement: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => true,
    querySelector: (): null => null,
    querySelectorAll: (): [] => [],
    contains: (node: unknown) => body.contains(node as ShimElement | null),
  };
  (ShimElement.prototype as any).ownerDocument = (globalThis as any).document;

  let calls = 0;
  const stub = {
    tasks: {
      list: async () => {
        calls += 1;
        return { items: [], nested: [], max_revision: 0 };
      },
    },
    thoughts: { get: async () => ({ id: 't1', title: 't1' }) },
    publications: { get: async () => ({ id: 'p1', title: 'p1' }) },
    ui: { getState: async () => null, setState: async () => undefined },
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, any>;
  win.etn = stub;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  win.cancelAnimationFrame = (id: any) => clearTimeout(id);
  win.dispatchEvent = (): boolean => true;
  win.addEventListener = (): void => undefined;
  win.removeEventListener = (): void => undefined;
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  win.localStorage = {
    getItem: () => null,
    setItem: (): void => undefined,
    removeItem: (): void => undefined,
  };
  (globalThis as any).etn = stub;
  return { listCalls: () => calls };
}

const { store } = await import('../src/renderer/state.js');
const { mountTaskList } = await import('../src/renderer/lib/ui/task-list.js');
const { resetEventRouter, routeRealtimeEvent } =
  await import('../src/renderer/lib/live/event-router.js');

/** Смонтировать панель редактора мысли (headless) и вернуть хэндл. */
async function mount(autoRefresh: boolean): Promise<{ handle: any; destroy: () => void }> {
  store.update({ networkId: 'n1', network: { first_day_of_week: 1 } } as any);
  const host = new ShimElement('div');
  const handle = mountTaskList(host as unknown as HTMLElement, {
    source: { kind: 'thought', ownerId: 't1' },
    view: {
      headless: true,
      autoRefreshOnCommentChange: autoRefresh,
      renderText: (node, row) => {
        node.textContent = row.text;
      },
    },
    actions: {},
  });
  await flush();
  return { handle, destroy: () => handle.destroy() };
}

/** Событие чужой правки записи в сети — через реальный маршрутизатор. */
function commentUpdated(seq: number): void {
  routeRealtimeEvent({
    type: 'comment.updated',
    network_id: 'n1',
    seq,
    data: { id: 'c1', version: 2, kind: 'chronological', owner_type: 'thought', owner_id: 't1' },
  } as any);
}

beforeEach(() => {
  resetEventRouter();
});

describe('панель задач: автоперечитывание на событие комментария (пункт 4)', () => {
  it('с включённой опцией событие комментария перечитывает панель', async () => {
    const api = shim();
    const { destroy } = await mount(true);
    const initial = api.listCalls();
    assert.ok(initial >= 1, 'стартовая загрузка прошла');
    commentUpdated(1);
    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'событие дало ровно один перезапрос');
    destroy();
  });

  it('без опции событие панель не перечитывает (Дневник остаётся на ручном «Обновить»)', async () => {
    const api = shim();
    const { destroy } = await mount(false);
    const initial = api.listCalls();
    commentUpdated(1);
    await wait(250);
    assert.equal(api.listCalls(), initial, 'перезапроса нет');
    destroy();
  });

  it('пачка событий одной записи склеивается в ОДИН перезапрос', async () => {
    const api = shim();
    const { destroy } = await mount(true);
    const initial = api.listCalls();
    commentUpdated(1);
    commentUpdated(2);
    commentUpdated(3);
    await wait(250);
    assert.equal(api.listCalls(), initial + 1, 'дебаунс склеил пачку');
    destroy();
  });
});
