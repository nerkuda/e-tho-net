/**
 * Красный/зелёный гейт ошибки b213cf60 — «Панель выделенных крутит
 * render → resolveRows → render, если thoughts.resolve не вернул ref».
 *
 * Корень: `render()` в конце звал `resolveRows`, а `resolveRows` после ответа
 * БЕЗУСЛОВНО звал `render()` снова. Отсутствие ref — нормальный ответ контракта
 * (REST `POST /thoughts/resolve` возвращает только найденные), поэтому для
 * удалённой/невидимой в слое мысли цикл не сходился: последовательные
 * IPC+HTTP-запросы, пока id не уберут вручную. Тот же цикл давал любой отказ
 * запроса (ветка `catch` тоже заканчивалась `render()`).
 *
 * Гейт поведенческий: монтируется РЕАЛЬНАЯ панель на подставном мосте
 * `window.etn` с отложенными ответами `thoughts.resolve` (образец окружения —
 * `focus-currency.test.ts`). Проверяются:
 *   1. resolve → []: ровно один запрос, повторного render нет, строка
 *      «недоступна» и id в интерфейсе не показывается;
 *   2. resolve rejected: ровно один запрос, unhandled rejection нет,
 *      «недоступна» НЕ ставится (отказ не подтверждает отсутствие);
 *   3. смешанный набор [X, Y] → [X]: X назван, Y «недоступна», второй запрос
 *      не уходит;
 *   4. `invalidateRef(X)` — внешняя инвалидация: ровно один новый запрос,
 *      имя восстанавливается (guard не делает данные вечно устаревшими);
 *   5. смена поколения (`invalidateAllRefs`) в полёте: поздний ответ прежнего
 *      контекста не публикуется и не рендерит, `finally` старого запроса не
 *      открывает дубль нового;
 *   6. инвалидация ДРУГОГО id в полёте (`invalidateSelectionThought(Y)`):
 *      поздний ответ прежнего поколения отбрасывается, но id X, оставшийся в
 *      выделении, получает ровно один компенсирующий запрос и имя;
 *   7. после отказа resolve снятие и повторное добавление id дают новую
 *      попытку (снятие с выделения очищает `attempted`).
 *
 * Мутации, обязанные краснить этот файл:
 *   • убрать `attempted` из фильтра `missing` — п. 1/2/3 по счётчику запросов;
 *   • убрать пометку `unavailable` — п. 1/3 по видимому состоянию;
 *   • вернуть безусловный `render()` после ответа — п. 5 по счётчику render;
 *   • убрать компенсирующий повтор в ветке позднего ответа — п. 6;
 *   • не очищать `attempted` при снятии с выделения — п. 7.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ThoughtRef } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = '00000000-0000-4000-8000-00000000000a';
const X = '00000000-0000-4000-8000-0000000000a01';
const Y = '00000000-0000-4000-8000-0000000000b01';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Минимальный DOM-шим — тот же набор, что у focus-currency.test.ts. */
function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body: new ShimElement('body'),
    documentElement: new ShimElement('html'),
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
  win.setTimeout = (handler: (...args: any[]) => void, ms?: number, ...rest: any[]) => {
    // Длинные таймеры (TTL тоста) в юните не крутим.
    if ((ms ?? 0) > 1000) return 0;
    return (globalThis as any).setTimeout(handler, ms, ...rest);
  };
  win.clearTimeout = (id: any) => (globalThis as any).clearTimeout(id);
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.innerWidth = 1600;
  win.innerHeight = 900;
  win.requestAnimationFrame = (cb: (t: number) => void) =>
    (globalThis as any).setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id: any) => (globalThis as any).clearTimeout(id);
  (globalThis as any).requestAnimationFrame = win.requestAnimationFrame;
  (globalThis as any).cancelAnimationFrame = win.cancelAnimationFrame;
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  (globalThis as any).getComputedStyle = win.getComputedStyle;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function thoughtRef(id: string, title: string): ThoughtRef {
  return {
    id,
    title,
    type_id: TYPE_ID,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    marked_for_deletion: false,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
  };
}

/** Вызовы `thoughts.resolve` в порядке обращения (id-наборы). */
let resolveCalls: string[][] = [];
/** Отложенные ответы resolve: гейт на каждый вызов. */
let gates: Array<Deferred<ThoughtRef[]>> = [];

/** Мост `window.etn`: resolve отвечает только когда тест разрешит гейт. */
function stubEtn(): void {
  const win = (globalThis as any).window as Record<string, unknown>;
  win.etn = {
    thoughts: {
      resolve: (_networkId: string, ids: string[]) => {
        resolveCalls.push([...ids]);
        const gate = deferred<ThoughtRef[]>();
        gates.push(gate);
        return gate.promise;
      },
      get: async (id: string) => ({ id }),
      neighbors: async () => [],
    },
    comments: { list: async () => [] },
    attachments: { list: async () => [] },
    links: { listByThought: async () => [] },
  };
}

type SelectionModule = typeof import('../src/renderer/selection/selection.js');
type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');
type StoreModule = typeof import('../src/renderer/state.js').store;

let selection: SelectionModule;
let canvas: CanvasModule;
let store: StoreModule;
let host: ShimElement;
let teardown: () => void;

beforeEach(async () => {
  resolveCalls = [];
  gates = [];
  shimDom();
  stubEtn();
  const state = await import('../src/renderer/state.js');
  store = state.store;
  store.resetNetwork();
  store.update({ screen: 'workspace', networkId: NET } as any);
  selection = await import('../src/renderer/selection/selection.js');
  canvas = await import('../src/renderer/canvas/canvas.js');
  host = new ShimElement('div');
  teardown = selection.mountSelection(host as unknown as HTMLElement);
});

afterEach(() => {
  teardown();
  store.update({ selection: [] });
});

/** Дать отработать континуациям промисов и микрозадаче scheduleRender. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

/** Текст строки панели по индексу (строка — облачко `chip` + кнопка ✕). */
function rowText(index: number): string {
  return host.querySelectorAll('.selection-item')[index]?.flatText() ?? '';
}

/** Прогоняет сценарий и возвращает все unhandled rejection за его время. */
async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return reasons;
}

function renderCount(): number {
  // На дофиксовой сборке шва ещё нет — счётчик читается как 0, чтобы гейт
  // краснел ПОВЕДЕНИЕМ (лишний запрос/старая метка), а не падением на шве.
  const internals = (selection as { selectionInternals?: { renderCount?: () => number } })
    .selectionInternals;
  return typeof internals?.renderCount === 'function' ? internals.renderCount() : 0;
}

describe('панель выделенных: resolve не зацикливает render (b213cf60)', () => {
  it('resolve → []: ровно один запрос, строка «недоступна», повторного render нет', async () => {
    selection.toggleSelection([X]);
    assert.equal(resolveCalls.length, 1, 'первый запрос ушёл');
    assert.deepEqual(resolveCalls[0], [X]);

    const before = renderCount();
    gates[0]!.resolve([]);
    await flush();

    assert.equal(resolveCalls.length, 1, 'пустой ответ не порождает повторный запрос');
    assert.equal(renderCount(), before, 'ответ resolve не вызывает render()');
    assert.match(rowText(0), /недоступна/u);
    assert.equal(rowText(0).includes(X), false, 'id в интерфейсе не показывается');

    // Внешний render без инвалидации X (изменился состав выделения): X уже
    // спрошен в этом поколении — переспрашивается только новый id.
    selection.toggleSelection([Y]);
    await flush();
    assert.equal(resolveCalls.length, 2);
    assert.deepEqual(resolveCalls[1], [Y], 'X не переспрашивается на постороннем render');
    assert.match(rowText(0), /недоступна/u);

    // Ещё несколько тиков: цикл не «догоняет» задним числом.
    await flush();
    assert.equal(resolveCalls.length, 2);
    // Шов счётчика обязан существовать: без него проверка «ответ не рендерит»
    // была бы молчаливым no-op (0 === 0).
    assert.equal(
      typeof (selection as { selectionInternals?: { renderCount?: unknown } })
        .selectionInternals?.renderCount,
      'function',
      'шов счётчика render обязателен',
    );
  });

  it('resolve rejected: ровно один запрос, без unhandled rejection и без «недоступна»', async () => {
    const reasons = await collectUnhandled(async () => {
      selection.toggleSelection([X]);
      assert.equal(resolveCalls.length, 1);
      gates[0]!.reject(new Error('Сеть недоступна'));
    });

    assert.deepEqual(reasons, [], 'unhandled rejection нет');
    assert.equal(resolveCalls.length, 1, 'отказ не порождает повторный запрос');
    assert.equal(rowText(0).includes('недоступна'), false, 'отказ не подтверждает отсутствие');
    assert.equal(rowText(0).includes(X), false, 'id не подставляется');

    // Одна попытка на поколение: посторонний render (новый id в выделении)
    // не переспрашивает X после отказа.
    selection.toggleSelection([Y]);
    await flush();
    assert.equal(resolveCalls.length, 2);
    assert.deepEqual(resolveCalls[1], [Y], 'X после отказа не переспрашивается');

    await flush();
    assert.equal(resolveCalls.length, 2);
  });

  it('смешанный набор [X, Y] → [X]: X назван, Y «недоступна», второго запроса нет', async () => {
    selection.toggleSelection([X, Y]);
    assert.equal(resolveCalls.length, 1);
    assert.deepEqual(resolveCalls[0], [X, Y], 'набор запрошен одной пачкой');

    gates[0]!.resolve([thoughtRef(X, 'Мысль X')]);
    await flush();

    assert.equal(resolveCalls.length, 1);
    assert.match(rowText(0), /Мысль X/u);
    assert.match(rowText(1), /недоступна/u);
  });

  it('invalidateRef(X) — ровно один новый запрос, имя восстанавливается', async () => {
    selection.toggleSelection([X]);
    gates[0]!.resolve([]);
    await flush();
    assert.match(rowText(0), /недоступна/u);

    canvas.invalidateRef(X);
    await flush();
    assert.equal(resolveCalls.length, 2, 'внешняя инвалидация даёт ровно одну новую попытку');

    gates[1]!.resolve([thoughtRef(X, 'Имя после инвалидации')]);
    await flush();
    assert.match(rowText(0), /Имя после инвалидации/u);
    assert.equal(resolveCalls.length, 2, 'успешный ответ больше не переспрашивается');
  });

  it('смена поколения в полёте: поздний ответ не публикуется, finally не открывает дубль', async () => {
    selection.toggleSelection([X]);
    assert.equal(resolveCalls.length, 1);

    // Смена слоя/сети: кэш и подтверждённые отсутствия сброшены, поколение
    // сдвинуто — актуальный контекст запрашивает имя заново.
    canvas.invalidateAllRefs();
    await flush();
    assert.equal(resolveCalls.length, 2, 'новое поколение делает свой запрос');

    // Поздний ответ прежнего поколения: не публикуется и не рендерит.
    const before = renderCount();
    gates[0]!.resolve([thoughtRef(X, 'Старое имя')]);
    await flush();
    assert.equal(resolveCalls.length, 2, 'finally старого запроса не открыл дубль');
    assert.equal(rowText(0).includes('Старое имя'), false, 'поздний ответ не опубликован');
    assert.equal(renderCount(), before, 'поздний ответ не вызывает render()');

    gates[1]!.resolve([thoughtRef(X, 'Новое имя')]);
    await flush();
    assert.match(rowText(0), /Новое имя/u);
    assert.equal(resolveCalls.length, 2);
  });

  it('инвалидация другого id в полёте: отброшенный X получает повтор и имя', async () => {
    selection.toggleSelection([X, Y]);
    assert.equal(resolveCalls.length, 1);
    assert.deepEqual(resolveCalls[0], [X, Y], 'набор запрошен одной пачкой');

    // Инвалидация Y поднимает поколение; рендер заново запрашивает только Y,
    // X остаётся «уже спрошенным» в старом поколении.
    selection.invalidateSelectionThought(Y);
    await flush();
    assert.equal(resolveCalls.length, 2);
    assert.deepEqual(resolveCalls[1], [Y], 'новое поколение запрашивает только Y');

    // Поздний ответ старого поколения [X, Y] отбрасывается. X остался в
    // выделении — для него обязателен ровно один компенсирующий запрос, иначе
    // строка навсегда остаётся пустой (замечание верификатора).
    gates[0]!.resolve([thoughtRef(X, 'Старое имя X'), thoughtRef(Y, 'Старое имя Y')]);
    await flush();
    assert.equal(resolveCalls.length, 3, 'отброшенный id получает ровно один повтор');
    assert.deepEqual(resolveCalls[2], [X], 'повтор только для отброшенного X');

    gates[2]!.resolve([thoughtRef(X, 'Имя X')]);
    await flush();
    assert.match(rowText(0), /Имя X/u);
    assert.equal(rowText(0).includes(X), false, 'id в интерфейсе не показывается');
    assert.equal(resolveCalls.length, 3, 'повтор не порождает новых запросов');

    gates[1]!.resolve([thoughtRef(Y, 'Имя Y')]);
    await flush();
    assert.match(rowText(1), /Имя Y/u);
    assert.equal(resolveCalls.length, 3);
  });

  it('после отказа снятие и повторное добавление id дают новую попытку', async () => {
    const reasons = await collectUnhandled(async () => {
      selection.toggleSelection([X]);
      assert.equal(resolveCalls.length, 1);
      gates[0]!.reject(new Error('Сеть недоступна'));
    });
    assert.deepEqual(reasons, [], 'unhandled rejection нет');
    assert.equal(resolveCalls.length, 1);
    assert.equal(rowText(0).includes(X), false);

    // Снятие и возврат — новое намерение пользователя: попытка не должна
    // наследовать «уже спрашивали» от прежнего поколения.
    selection.toggleSelection([X]);
    await flush();
    selection.toggleSelection([X]);
    await flush();
    assert.equal(resolveCalls.length, 2, 'повторное добавление — новая попытка');
    assert.deepEqual(resolveCalls[1], [X]);

    gates[1]!.resolve([thoughtRef(X, 'Имя после возврата')]);
    await flush();
    assert.match(rowText(0), /Имя после возврата/u);
    assert.equal(resolveCalls.length, 2);
  });
});
