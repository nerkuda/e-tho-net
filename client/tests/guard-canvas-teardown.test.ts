/**
 * Сторож teardown-контракта холста (ошибка 37b713de).
 *
 * Правило: `mountCanvas` возвращает teardown-хендл, который снимает КАЖДУЮ
 * глобальную подписку/наблюдателя холста (слушатель смены режима полосы
 * отборов, подписки стора холста/ lock-бейджей/оверлея связей/сплиттеров,
 * `ResizeObserver`). Без этого каждое перемонтирование рабочего пространства
 * (открытие сети, активация вкладки, переход по wiki-ссылке) добавляло живого
 * подписчика: один клик по кнопке отбора запускал `render()` по всем прошлым
 * монтированиям → N параллельных POST `views/run`, переключение отбора
 * растягивалось на секунды.
 *
 * Сторож монтирует РЕАЛЬНЫЙ `mountCanvas` в DOM-шим и проверяет наблюдаемые
 * следствия:
 *   1. после каждого teardown число слушателей режима возвращается к базовому
 *      — они не накапливаются между монтированиями;
 *   2. после нескольких циклов mount/unmount клик по кнопке отбора порождает
 *      РОВНО один POST `views/run` (мок etn-фасада считает вызовы).
 *
 * На коде до фикса (mountCanvas без teardown) обе проверки краснеют — см.
 * отчёт по ошибке 37b713de.
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
type StripModule = typeof import('../src/renderer/canvas/focus-filter-strip.js');

let canvas: CanvasModule;
let strip: StripModule;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const FOCUS_ID = '00000000-0000-4000-8000-000000000100';

/** Имена отборов, по которым `run` был вызван (мок etn-фасада). */
let runCalls: string[] = [];

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
  runCalls = [];
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
      run: async (_nid: string, _fid: string, name: string) => {
        runCalls.push(name);
        return {
          data: [],
          meta: {
            total: 0,
            limit: 50,
            offset: 0,
            directions: {},
            view: { id: name, name, type_id: TYPE_ID },
            unresolved: [],
          },
        };
      },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  installGlobals();
  installEtn();
  canvas = await import('../src/renderer/canvas/canvas.js');
  strip = await import('../src/renderer/canvas/focus-filter-strip.js');
});

beforeEach(() => {
  installEtn();
  store.update({ networkId: NETWORK_ID, focus: null });
});

describe('guard: teardown холста (ошибка 37b713de)', () => {
  it('mountCanvas возвращает teardown, который снимает слушателя режима — без накопления', () => {
    const baseline = strip.debugModeListenerCount();
    for (let cycle = 0; cycle < 3; cycle++) {
      const host = makeHost();
      const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
      assert.equal(
        typeof dispose,
        'function',
        'mountCanvas обязан возвращать teardown-хендл (иначе подписки утекают)',
      );
      assert.equal(
        strip.debugModeListenerCount(),
        baseline + 1,
        `на монтировании №${cycle + 1} должен быть ровно один слушатель режима`,
      );
      dispose();
      assert.equal(
        strip.debugModeListenerCount(),
        baseline,
        `teardown монтирования №${cycle + 1} обязан снять слушателя режима`,
      );
    }
  });

  it('после нескольких монтирований один клик по отбору = ровно один views/run', async () => {
    store.update({
      networkId: NETWORK_ID,
      focus: null,
      canvasLinkFilter: { type_ids: [], include_structural: true },
    });
    // Три цикла «открыл сеть → ушёл» (как переоткрытие вкладки/сети).
    for (let cycle = 0; cycle < 3; cycle++) {
      const host = makeHost();
      const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
      dispose();
    }

    // Оставляем одно живое рабочее пространство.
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    await settle();

    // Ставим фокус: полоса построится с двумя отборами (активен отбор по умолчанию v1).
    store.update({ focus: focusResponse() });
    await settle();

    // Считаем только запросы, порождённые кликом.
    runCalls = [];
    const btn = findViewButton(host, 'v2');
    assert.ok(btn !== undefined, 'кнопка второго отбора должна быть в полосе');
    btn!.click();
    await settle();

    assert.equal(
      runCalls.length,
      1,
      `одно переключение отбора = один POST views/run; получено ${runCalls.length} (утечка слушателей?)`,
    );

    dispose();
    assert.equal(strip.debugModeListenerCount(), 0, 'teardown снимает слушателя режима');
  });
});
