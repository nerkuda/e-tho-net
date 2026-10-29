/**
 * Регресс-тест ошибки 6d78ccab «Отбор по родителю выполняется слишком долго»:
 * нижняя зона карты в режиме отбора во время прогона показывает загрузку, а не
 * ложное «Подчинённых мыслей нет. Двойной клик для добавления».
 *
 * Сценарий пользователя: фокус — мысль с отбором по умолчанию («Родитель =
 * $thought» на крупном поддереве). Отбор исполняется секундами; прежняя
 * реализация всё это время держала в нижней зоне пустое состояние детей, и
 * пользователь не понимал, пуст отбор или программа зависла.
 *
 * Тест монтирует РЕАЛЬНЫЙ `mountCanvas` в DOM-шим и управляет ответом прогона:
 *   * пока ответ не пришёл — `.zone-empty` содержит `loadingState`
 *     («Загрузка…») и НЕ содержит «Подчинённых мыслей нет»;
 *   * пустой ответ — «Ничего не найдено»;
 *   * отказ — `errorState` с текстом отказа;
 *   * непустой ответ — облачка результата, пустое состояние скрыто.
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
const ROW_ID = '00000000-0000-4000-8000-000000000200';

let currentHost: ShimElement | null = null;

/** Строки результата отбора; тест задаёт их до ответа. */
let viewRows: Array<Record<string, unknown>> = [];
/** Управляемая задержка ответа: пока не разрешён — прогон «в полёте». */
let viewGate: Promise<void> | null = null;
/** Управляемый отказ прогона. */
let viewError: Error | null = null;

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
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

function focusResponse(): FocusResponse {
  return {
    focused: thought(FOCUS_ID, 'Входящие задачи'),
    parents: [],
    children: [],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

function effectiveRow(id: string, name: string, isDefault: boolean): Record<string, unknown> {
  return {
    id,
    name,
    name_key: id,
    description: null,
    definition: JSON.stringify({ criteria: [] }),
    position: 0,
    is_default: isDefault,
    version: 1,
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    scope: 'type',
    defined_on: TYPE_ID,
    inherited: false,
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
      focus: async () => focusResponse(),
      get: async () => ({ meta: { views: [] } }),
      resolve: async () => [],
      neighborsPage: async () => ({ total: 0, items: [] }),
    },
    thoughtTypeViews: {
      list: async () => ({
        data: [effectiveRow('v1', 'Родитель = $thought', true)],
        meta: { effective: [effectiveRow('v1', 'Родитель = $thought', true)] },
      }),
      // Прогон отбора: ответ управляется тестом (задержка/отказ/строки).
      run: async () => {
        if (viewGate !== null) await viewGate;
        if (viewError !== null) throw viewError;
        return {
          data: viewRows.map((row) => ({ ...row })),
          meta: {
            total: viewRows.length,
            limit: 100,
            offset: 0,
            directions: {},
            view: { id: 'v1', name: 'Родитель = $thought', scope: 'type', defined_on: TYPE_ID },
            unresolved: [],
          },
        };
      },
    },
    thoughtCustomViews: {
      list: async () => ({
        data: [],
        meta: { effective: [effectiveRow('v1', 'Родитель = $thought', true)] },
      }),
    },
    comments: { list: async () => [] },
    attachments: { list: async () => [] },
    propertyRegistry: { list: async () => [] },
    structures: { edges: async () => [] },
    cancelRequest: () => undefined,
  };
}

function installEtn(): void {
  const api = installFakeApi();
  (globalThis as any).etn = api;
  const w = (globalThis as any).window as { etn?: unknown } | undefined;
  if (w !== undefined) w.etn = api;
}

function installGlobals(): void {
  // DOM-шим не задаёт `offsetHeight` — без него виртуализация нижней зоны
  // получает NaN (см. renderer-canvas-view-realtime.test.ts).
  Object.defineProperty(ShimElement.prototype, 'offsetHeight', {
    get: () => 20,
    configurable: true,
  });
  (globalThis as any).CSS = { escape: (value: string) => value };
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
    matchMedia: () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    requestAnimationFrame: raf,
    setTimeout: (cb: (...a: unknown[]) => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    etn: (globalThis as any).etn,
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

async function settle(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHost(): ShimElement {
  const host = new ShimElement('section', 'canvas-host');
  currentHost = host;
  return host;
}

/** Шим не знает геометрии: проставляем числа, иначе виртуализация падает. */
function sizeDom(el: ShimElement): void {
  const sized = el as unknown as {
    clientWidth: number;
    clientHeight: number;
    scrollHeight: number;
  };
  sized.clientWidth = 800;
  sized.clientHeight = 600;
  sized.scrollHeight = 2000;
  for (const child of el.children) sizeDom(child);
}

/** Монтирует холст и ставит фокус с отбором по умолчанию. */
async function mountWithView(): Promise<{ host: ShimElement; dispose: () => void }> {
  const host = makeHost();
  const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
  sizeDom(host);
  store.update({ networkId: NETWORK_ID, focus: focusResponse() });
  await settle();
  return { host, dispose };
}

/** Текст пустого состояния нижней зоны. */
function childrenEmpty(host: ShimElement): ShimElement {
  const zone = host.querySelector('.zone-children');
  assert.ok(zone !== null, 'нижняя зона смонтирована');
  const empty = zone!.querySelector('.zone-empty');
  assert.ok(empty !== null, 'у нижней зоны есть пустое состояние');
  return empty!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
  installGlobals();
  installEtn();
  canvas = await import('../src/renderer/canvas/canvas.js');
});

beforeEach(async () => {
  installEtn();
  viewRows = [];
  viewGate = null;
  viewError = null;
  store.update({ networkId: NETWORK_ID, focus: null, canvasZoom: 1, cloudWidth: 180 });
  // Сброс удержанного полосой фокуса между тестами: `dispose()` не зовёт
  // `renderStrip(null)`, и следующий фокус с тем же id считался бы прежним.
  const strip = await import('../src/renderer/canvas/focus-filter-strip.js');
  await strip.renderStrip(null);
});

describe('нижняя зона карты при прогоне отбора (ошибка 6d78ccab)', () => {
  it('во время прогона показывает загрузку, а не «Подчинённых мыслей нет»', async () => {
    let release: () => void = () => undefined;
    viewGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, dispose } = await mountWithView();

    const empty = childrenEmpty(host);
    assert.equal(empty.classList.contains('hidden'), false, 'пустое состояние видно');
    assert.ok(
      empty.querySelector('.ui-state-loading') !== null,
      'во время прогона нижняя зона показывает loadingState из lib/ui',
    );
    assert.match(empty.textContent, /Загрузка/, 'текст загрузки виден');
    assert.ok(
      !empty.textContent.includes('Подчинённых мыслей нет'),
      'ложное «Подчинённых мыслей нет» при активном прогоне не появляется',
    );

    // Пустой ответ: загрузка сменяется честным «Ничего не найдено».
    viewRows = [];
    release();
    await settle();
    assert.equal(empty.querySelector('.ui-state-loading'), null, 'загрузка снята');
    assert.equal(empty.textContent.trim(), 'Ничего не найдено', 'пустой результат объяснён');
    dispose();
  });

  it('отказ прогона показывает errorState, а не пустое состояние детей', async () => {
    viewError = new Error('boom');
    const { host, dispose } = await mountWithView();
    await settle();

    const empty = childrenEmpty(host);
    assert.ok(
      empty.querySelector('.ui-state-error') !== null,
      'отказ прогона — errorState из lib/ui',
    );
    assert.match(empty.textContent, /Не удалось исполнить отбор/, 'текст отказа виден');
    assert.ok(
      !empty.textContent.includes('Подчинённых мыслей нет'),
      'ложное пустое состояние детей при отказе не появляется',
    );
    dispose();
  });

  it('после ответа показывает облачка результата, пустое состояние скрыто', async () => {
    let release: () => void = () => undefined;
    viewGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host, dispose } = await mountWithView();
    assert.ok(childrenEmpty(host).querySelector('.ui-state-loading') !== null);

    viewRows = [{ id: ROW_ID, title: 'Задача из отбора', type_id: TYPE_ID, active: true, marked_for_deletion: false }];
    release();
    await settle();

    const zone = host.querySelector('.zone-children')!;
    const clouds = zone.querySelectorAll('.cloud');
    assert.equal(clouds.length, 1, 'строка результата нарисована облачком');
    assert.ok(
      (clouds[0]!.textContent ?? '').includes('Задача из отбора'),
      'облачко несёт заголовок строки отбора',
    );
    const empty = childrenEmpty(host);
    assert.ok(empty.classList.contains('hidden'), 'пустое состояние скрыто');
    assert.equal(empty.querySelector('.ui-state-loading'), null, 'загрузки больше нет');
    dispose();
  });
});
