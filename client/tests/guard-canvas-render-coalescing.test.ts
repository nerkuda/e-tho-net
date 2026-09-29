/**
 * Сторож коалессирования `render()` холста (задача d20d8038).
 *
 * Правило: любое число СИНХРОННЫХ триггеров рендера за один тик — уведомления
 * стора (подписка `mountCanvas`), смена режима полосы отборов
 * (`onStripModeChange`), монтирование — схлопывается в ОДИН фактический
 * `render()` с финальным состоянием. Механизм — флаг «запланирован» +
 * микротаска (`canvas.ts: scheduleRender`); микротаска выполняется до отрисовки
 * кадра, поэтому хореография смены фокуса по-прежнему укладывает первый
 * нарисованный кадр со старым содержимым (`guard-focus-animation`).
 *
 * Зачем: защита в глубину после ошибки 37b713de — каждая полная отрисовка
 * тянет `renderStrip` + `thoughts.get` + `list` + `views/run`, и пачка
 * уведомлений (или утёкший подписчик) не должна запускать их серию.
 *
 * Сторож монтирует РЕАЛЬНЫЙ `mountCanvas` в DOM-шим и считает фактические
 * входы в рендер через тестовые швы `canvasInternals.renderCount` (после гварда
 * хозяина) и `canvasInternals.renderEnterCount` (до гварда — отличает no-op по
 * `host === null` от потерянного микротаска). Дискриминирующая сила сторожа
 * доказана отдельным подтестом: при синхронном планировщике (имитация регрессии)
 * ассерт «отложен на микротаск» краснеет.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';

import type { FocusResponse, Thought } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');

let canvas: CanvasModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const FOCUS_ID = '00000000-0000-4000-8000-000000000100';

/** Последний смонтированный хост — `document.querySelector('.canvas-host')`. */
let currentHost: ShimElement | null = null;

function thought(id: string, title: string): Thought {
  return {
    id,
    title,
    type_id: TYPE_ID,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

function focusResponse(): FocusResponse {
  return {
    focused: thought(FOCUS_ID, 'Версия 0.10.2'),
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'manual', order: 'asc' },
      children: { sort: 'manual', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  };
}

/** Строка `meta.views` (то, что отдаёт `thoughts.get` для полосы отборов). */
function metaViewRow(id: string, name: string, isDefault: boolean): Record<string, unknown> {
  return {
    id,
    name,
    name_key: id,
    description: null,
    defined_on: TYPE_ID,
    inherited: false,
    is_default: isDefault,
  };
}

/** Полная запись отбора (`thoughtTypeViews.list` → `data`). */
function fullView(id: string, name: string, isDefault: boolean): Record<string, unknown> {
  return {
    id,
    thought_type_id: TYPE_ID,
    name,
    name_key: id,
    description: null,
    definition: JSON.stringify({ criteria: [] }),
    position: 0,
    is_default: isDefault,
    version: 1,
    created_at: '2026-09-29T00:00:00.000Z',
    updated_at: '2026-09-29T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
  };
}

// ---------------------------------------------------------------------------
// Fake `etn` + DOM/global harness
// ---------------------------------------------------------------------------

function installFakeApi(): unknown {
  return {
    ui: {
      getState: async () => null,
      setState: async () => undefined,
    },
    thoughts: {
      get: async () => ({
        meta: {
          views: [metaViewRow('v1', 'Отбор 1', true), metaViewRow('v2', 'Отбор 2', false)],
        },
      }),
      resolve: async () => [],
      neighborsPage: async () => ({ total: 0, items: [] }),
    },
    thoughtTypeViews: {
      list: async () => ({
        data: [fullView('v1', 'Отбор 1', true), fullView('v2', 'Отбор 2', false)],
        meta: { effective: [] },
      }),
      run: async () => ({
        data: [],
        meta: {
          total: 0,
          limit: 50,
          offset: 0,
          directions: {},
          view: { id: 'v2', name: 'v2', type_id: TYPE_ID },
          unresolved: [],
        },
      }),
    },
    comments: { list: async () => [] },
    attachments: { list: async () => [] },
    propertyRegistry: { list: async () => [] },
    structures: { edges: async () => [] },
  };
}

/** Ставит fake-`etn` и в `globalThis`, и в `window` (живой Proxy `lib/etn.ts`
 *  читает `window.etn`, когда `window` определён). */
function installEtn(): void {
  const api = installFakeApi();
  (globalThis as any).etn = api;
  const w = (globalThis as any).window as { etn?: unknown } | undefined;
  if (w !== undefined) w.etn = api;
}

function installGlobals(): void {
  const documentElement = new ShimElement('html');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement,
    body: new ShimElement('body'),
    querySelector: (sel: string) => (sel === '.canvas-host' ? currentHost : null),
    querySelectorAll: () => [] as ShimElement[],
    elementFromPoint: () => null,
  };
  const raf = (cb: (t: number) => void): ReturnType<typeof setTimeout> =>
    setTimeout(() => cb(Date.now()), 0);
  (globalThis as any).requestAnimationFrame = raf;
  (globalThis as any).getComputedStyle = (elx: { style: unknown }) => elx.style;
  (globalThis as any).window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle: (elx: { style: unknown }) => elx.style,
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    requestAnimationFrame: raf,
    setTimeout: (cb: (...a: unknown[]) => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Ждёт, пока осядут асинхронные цепочки `render()` (микро- и макрозадачи). */
async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHost(): ShimElement {
  const host = new ShimElement('section', 'canvas-host');
  currentHost = host;
  return host;
}

function findViewButton(host: ShimElement, viewId: string): ShimElement | undefined {
  return host
    .querySelectorAll('.canvas-filter-strip-btn')
    .find((b) => b.dataset['viewId'] === viewId);
}

function renderCount(): number {
  return canvas.canvasInternals.renderCount();
}

/** Входы в `render()` до гварда хозяина — отличает no-op по `host === null`
 *  от потерянного микротаска. */
function renderEnterCount(): number {
  return canvas.canvasInternals.renderEnterCount();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  installGlobals();
  installEtn();
  canvas = await import('../src/renderer/canvas/canvas.js');
});

beforeEach(() => {
  installEtn();
  // Сброс возможных прошлых монтирований и состояния холста.
  store.update({ networkId: NETWORK_ID, focus: null, canvasZoom: 1, cloudWidth: 180 });
});

describe('guard: коалессирование render() холста (задача d20d8038)', () => {
  it('пачка синхронных уведомлений стора → ровно один render, отложенный на микротаск', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    await settle();

    const base = renderCount();
    // Три синхронных обновления, каждое меняет подпись рендера (canvasRenderKey).
    store.update({ cloudWidth: 120 });
    store.update({ cloudWidth: 140 });
    store.update({ cloudWidth: 160 });

    // Микротаск ещё не выполнялся — фактического рендера не было.
    assert.equal(
      renderCount(),
      base,
      'рендер обязан быть отложен на микротаск, а не выполнен синхронно',
    );

    await settle();
    assert.equal(
      renderCount(),
      base + 1,
      `пачка из 3 синхронных триггеров должна дать один render; получено ${renderCount() - base}`,
    );
    dispose();
  });

  it('одиночный триггер → один render без лишних проходов', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    await settle();

    const base = renderCount();
    store.update({ cloudWidth: 200 });
    await settle();

    assert.equal(renderCount(), base + 1, 'одиночное уведомление = ровно один render');
    dispose();
  });

  it('смена режима полосы отборов и уведомление стора за один тик → один render', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    store.update({ networkId: NETWORK_ID, focus: focusResponse() });
    await settle();

    const btn = findViewButton(host, 'v2');
    assert.ok(btn !== undefined, 'кнопка второго отбора должна быть в полосе');

    const base = renderCount();
    // Два РАЗНЫХ источника триггера в одном тике: клик по отбору
    // (onStripModeChange) и уведомление стора (подписка mountCanvas).
    btn!.click();
    store.update({ cloudWidth: 210 });

    assert.equal(renderCount(), base, 'оба триггера должны схлопнуться до микротаска');
    await settle();

    assert.equal(
      renderCount(),
      base + 1,
      `разнородная пачка триггеров = один render; получено ${renderCount() - base}`,
    );
    dispose();
  });

  it('отложенный рендер после teardown: микротаск не потерян, render вошёл и стал no-op', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    await settle();

    const baseRendered = renderCount();
    const baseEntered = renderEnterCount();
    store.update({ cloudWidth: 220 });
    // Демонтаж до выполнения микротаска: render() обязан стать no-op.
    dispose();
    await settle();

    // Счётчик ДО гварда доказывает, что отложенный микротаск дошёл и вызвал
    // render(): «потеря микротаска» дала бы НЕприращённый вход.
    assert.equal(
      renderEnterCount(),
      baseEntered + 1,
      'микротаск не потерян: отложенный render() вошёл в функцию после teardown',
    );
    // Счётчик ПОСЛЕ гварда и отсутствие DOM-эффекта отделяют «вошёл, но no-op
    // по host === null» от настоящей отрисовки в мёртвый хост.
    assert.equal(
      renderCount(),
      baseRendered,
      'вошедший render() обязан стать no-op по host === null — DOM не трогается',
    );
  });

  it('дискриминирующая сила: синхронный рендер (имитация регрессии) делает ассерт «отложен» красным', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    await settle();

    const base = renderCount();
    const realQueueMicrotask = globalThis.queueMicrotask;
    try {
      // Имитация регрессии коалессирования: планировщик выполняет микротаск
      // СИНХРОННО, то есть render() зовётся прямо из триггера — так вела себя
      // до фикса каждая пачка уведомлений стора.
      globalThis.queueMicrotask = ((cb: () => void) => {
        cb();
      }) as typeof queueMicrotask;

      store.update({ cloudWidth: 120 });
      store.update({ cloudWidth: 140 });
      store.update({ cloudWidth: 160 });

      // Тот самый ассерт сторожа из первого теста («рендер обязан быть отложен
      // на микротаск», renderCount() === base) — под синхронным рендером он
      // обязан быть КРАСНЫМ: пачка из 3 триггеров дала 3 немедленных render().
      assert.throws(
        () => assert.equal(renderCount(), base),
        'ассерт «отложен на микротаск» краснеет на синхронном рендере — значит, он ловит регрессию коалессирования по существу',
      );
      assert.ok(
        renderCount() > base,
        `имитация регрессии должна увеличить счётчик в том же тике; получено ${renderCount() - base}`,
      );
    } finally {
      globalThis.queueMicrotask = realQueueMicrotask;
    }
    await settle();
    dispose();
  });

  it('быстрый remount в том же тике: отложенный рендер рисует новый хост, рендер не теряется', async () => {
    const host1 = makeHost();
    const dispose1 = canvas.mountCanvas(host1 as unknown as HTMLElement);
    await settle();

    const base = renderCount();
    // Триггер ставит рендер в очередь; teardown и mount идут ДО микротаска.
    store.update({ cloudWidth: 230 });
    dispose1();
    const host2 = makeHost();
    const dispose2 = canvas.mountCanvas(host2 as unknown as HTMLElement);
    await settle();

    assert.equal(
      renderCount(),
      base + 1,
      'отложенный рендер не потерян: ровно один render после teardown + mount в одном тике',
    );
    assert.ok(
      host2.querySelector('.canvas-top') !== null,
      'отложенный рендер нарисовал НОВЫЙ хост, а не мёртвый старый',
    );
    dispose2();
  });
});
