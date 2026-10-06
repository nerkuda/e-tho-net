/**
 * Сторож реактивного обновления значка захвата на холсте (ошибка cdffbf6c).
 *
 * Правило: при захвате/освобождении объекта смена `store.state.lockCacheTick`
 * обязана БЕЗ полной пересборки облачка перерисовать значок `.cloud-lock-badge`
 * на карте мыслей — он появляется при захвате и исчезает при освобождении.
 *
 * Причина дефекта: подписчик `wireLockBadgeRefresh` искал хост глобальным
 * селектором `document.querySelector('.canvas-host')`, а реальный элемент карты
 * создаётся как `div('canvas view-host')` (`screens/workspace.ts`) — класса
 * `canvas-host` в DOM нет. Подписчик молча выходил, и значок обновлялся лишь
 * при полной пересборке облачка (вставка картинки, смена фокуса).
 *
 * Хост в тесте эмулирует РЕАЛЬНЫЙ класс (`canvas view-host`), а
 * `document.querySelector` возвращает `null` для `.canvas-host` — как в живом
 * DOM. Поэтому сторож краснеет на коде до фикса (подписчик не находит хост) и
 * зелёный на исправленном (использует модульный `host`).
 *
 * Захваты подкладываются напрямую в `store.state.lockCache` + бамп
 * `lockCacheTick` — так же, как это делает `lib/lock-cache.ts → syncToStore`.
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';

import type { FocusResponse, LockRow, Thought } from '@etn/shared';

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
const ME_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ID = '00000000-0000-4000-8000-0000000000bb';

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

function lockRow(userId: string): LockRow {
  return {
    id: '00000000-0000-4000-8000-0000000000cc',
    entity_type: 'thought',
    entity_id: FOCUS_ID,
    user_id: userId,
    client_id: '00000000-0000-4000-8000-0000000000dd',
    acquired_at_ms: 1791168825439,
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
      get: async () => ({ meta: { views: [] } }),
      resolve: async () => [],
      neighborsPage: async () => ({ total: 0, items: [] }),
    },
    thoughtTypeViews: {
      list: async () => ({ data: [], meta: { effective: [] } }),
      run: async () => ({
        data: [],
        meta: {
          total: 0,
          limit: 50,
          offset: 0,
          directions: {},
          view: { id: 'v', name: 'v', type_id: TYPE_ID },
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
    // В живом DOM класса `canvas-host` НЕТ (реальный хост — `canvas view-host`).
    // Возвращаем `null`, чтобы сторож не маскировал дефект подменой селектора.
    querySelector: () => null,
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

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Реальный хост рабочего пространства — `div('canvas view-host')`. */
function makeHost(): ShimElement {
  return new ShimElement('div', 'canvas view-host');
}

function renderCount(): number {
  return canvas.canvasInternals.renderCount();
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
  store.update({
    networkId: NETWORK_ID,
    focus: null,
    lockCache: {},
    lockCacheTick: 0,
    me: { id: ME_ID, username: 'me', display_name: null, is_admin: false },
  });
});

describe('guard: реактивный значок захвата на холсте (ошибка cdffbf6c)', () => {
  it('смена lockCacheTick добавляет и снимает .cloud-lock-badge без полной пересборки', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    store.update({ focus: focusResponse() });
    await settle();

    const cloud = host.querySelector('.cloud[data-id="' + FOCUS_ID + '"]');
    assert.ok(cloud !== null, 'фокусное облачко должно отрисоваться в холсте');
    assert.equal(
      cloud!.querySelector('.cloud-lock-badge'),
      null,
      'до захвата значка на облачке быть не должно',
    );

    const rendersBefore = renderCount();

    // Захват: ровно то, что делает `lib/lock-cache.ts → syncToStore`.
    store.update({
      lockCache: { [`thought:${FOCUS_ID}`]: lockRow(OTHER_ID) },
      lockCacheTick: 1,
    });
    await settle();

    assert.notEqual(
      cloud!.querySelector('.cloud-lock-badge'),
      null,
      'после захвата значок обязан появиться реактивно (без пересборки облачка)',
    );
    assert.equal(
      renderCount(),
      rendersBefore,
      'появление значка не должно требовать полной пересборки холста (рендер не растёт)',
    );

    // Освобождение.
    store.update({ lockCache: {}, lockCacheTick: 2 });
    await settle();

    assert.equal(
      cloud!.querySelector('.cloud-lock-badge'),
      null,
      'после освобождения значок обязан исчезнуть реактивно',
    );

    dispose();
  });

  it('свой захват помечает значок как own (мягкая подсветка)', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    store.update({ focus: focusResponse() });
    await settle();

    store.update({
      lockCache: { [`thought:${FOCUS_ID}`]: lockRow(ME_ID) },
      lockCacheTick: 1,
    });
    await settle();

    const badge = host.querySelector('.cloud-lock-badge');
    assert.ok(badge !== null, 'значок своего захвата обязан появиться');
    assert.ok(badge!.classList.contains('own'), 'значок своего захвата несёт класс own');

    dispose();
  });
});
