/**
 * Смена мыслесети на карте мыслей (спека «Проявление карты при смене
 * мыслесети», задача 70a99f09).
 *
 * Целевое поведение:
 *  1. при переходе на другую сеть содержимое карты очищается ОДНОМОМЕНТНО —
 *     без фокус-хореографии и перелётов;
 *  2. первый расклад новой сети (фокус + зоны) проявляется ОДНИМ общим fade-in:
 *     каждое облачко получает одну opacity-анимацию с нулевой задержкой,
 *     transform-анимаций (перелётов) нет;
 *  3. внутрисетовая смена фокуса по-прежнему играет двухфазную хореографию
 *     (создаётся слой `.focus-anim-layer`).
 *
 * Проверка ведётся на РЕАЛЬНОМ `mountCanvas` в DOM-ши́ме: настоящий рендер
 * собирает карту, а подменённый `Element.animate` собирает созданные анимации.
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';

import type { FocusNeighbor, FocusResponse, Thought } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');

let canvas: CanvasModule;

const NETWORK_A = '00000000-0000-4000-8000-00000000000a';
const NETWORK_B = '00000000-0000-4000-8000-00000000000b';
const TYPE_ID = '00000000-0000-4000-8000-000000000010';
const FOCUS_A = '00000000-0000-4000-8000-000000000101';
const CHILD_A = '00000000-0000-4000-8000-000000000102';
const FOCUS_B = '00000000-0000-4000-8000-000000000201';
const CHILD_B = '00000000-0000-4000-8000-000000000202';

/** Значения токенов, которые «возвращает» getComputedStyle. */
const ANIM_TOKENS: Record<string, string> = {
  '--anim-focus-flight': '400ms',
  '--anim-focus-settle': '260ms',
  '--anim-focus-fade': '300ms',
  '--anim-focus-ease': 'cubic-bezier(0.2, 0.7, 0.3, 1)',
  '--anim-network-reveal': '300ms',
};

let currentHost: ShimElement | null = null;
let created: FakeAnimation[] = [];

interface FakeAnimation {
  keyframes: any[];
  options: any;
  cancelled: boolean;
  cancel(): void;
}

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
    created_at: '2026-10-04T00:00:00.000Z',
    updated_at: '2026-10-04T00:00:00.000Z',
    created_by: '00000000-0000-4000-8000-000000000000',
    updated_by: '00000000-0000-4000-8000-000000000000',
  };
}

function neighbor(id: string, title: string): FocusNeighbor {
  return {
    id,
    title,
    type_id: TYPE_ID,
    icon: null,
    active: true,
    link_id: `link-${id}`,
    link_type_id: null,
    link_active: true,
    link_marked_for_deletion: false,
    has_incoming: false,
    has_outgoing: false,
    manual_position: 0,
  };
}

/** Фокус-ответ сети: фокус + один потомок (чтобы карта имела минимум два облачка). */
function focusResponse(focusId: string, childId: string, prefix: string): FocusResponse {
  return {
    focused: thought(focusId, `${prefix} Фокус`),
    parents: [],
    children: [neighbor(childId, `${prefix} Потомок`)],
    siblings: [],
    edges: [],
    sorts: {
      parents: { sort: 'manual', order: 'asc' },
      children: { sort: 'manual', order: 'asc' },
      siblings: { sort: 'alpha', order: 'asc' },
    },
  };
}

function installFakeApi(): unknown {
  return {
    ui: { getState: async () => null, setState: async () => undefined },
    thoughts: {
      get: async (id: string) => ({ ...thought(id, 'фокус'), meta: { views: [] } }),
      resolve: async (_n: string, ids: string[]) => ids.map((id) => thought(id, `Мысль ${id}`)),
      neighborsPage: async () => ({ total: 0, items: [] }),
      focus: async (n: string, id: string) => focusResponse(id, `${id}-child`, n === NETWORK_B ? 'B' : 'A'),
    },
    thoughtTypeViews: {
      list: async () => ({ data: [], meta: { effective: [] } }),
      run: async () => ({
        data: [],
        meta: { total: 0, limit: 50, offset: 0, directions: {}, view: { id: 'v', name: 'v', type_id: TYPE_ID }, unresolved: [] },
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
  // Зоны холста виртуализированы: чтобы облачка реально собирались, у зон
  // должны быть ненулевые clientWidth/clientHeight.
  Object.defineProperty(ShimElement.prototype, 'clientWidth', { get: () => 1000, configurable: true });
  Object.defineProperty(ShimElement.prototype, 'clientHeight', { get: () => 1000, configurable: true });
  // Высота облачка для пересчёта строк сетки; без неё `Math.max(estimate, undefined)`
  // даёт NaN, и `renderZoneContent` зацикливается на «высота изменилась».
  Object.defineProperty(ShimElement.prototype, 'offsetHeight', { get: () => 34, configurable: true });
  (ShimElement.prototype as any).animate = function animate(
    this: ShimElement,
    keyframes: any[],
    options: any,
  ): FakeAnimation {
    const rec: FakeAnimation = {
      keyframes,
      options,
      cancelled: false,
      cancel(): void {
        rec.cancelled = true;
      },
    };
    created.push(rec);
    return rec;
  };

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
  const raf = (cb: (t: number) => void): ReturnType<typeof setTimeout> => setTimeout(() => cb(Date.now()), 0);
  const computedStyle = (elx: { style?: { getPropertyValue?: (n: string) => string } }) => ({
    getPropertyValue: (name: string): string =>
      name in ANIM_TOKENS ? ANIM_TOKENS[name]! : (elx?.style?.getPropertyValue?.(name) ?? ''),
  });
  (globalThis as any).requestAnimationFrame = raf;
  (globalThis as any).getComputedStyle = computedStyle;
  (globalThis as any).window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle: computedStyle,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
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

async function settle(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHost(): ShimElement {
  const host = new ShimElement('section', 'canvas-host');
  currentHost = host;
  return host;
}

function cloudsIn(host: ShimElement): ShimElement[] {
  return host.querySelectorAll('.cloud');
}

function opacityReveals(): FakeAnimation[] {
  return created.filter((a) => a.keyframes[0]?.opacity === '0' && a.keyframes[1]?.opacity === '1');
}

function transformAnims(): FakeAnimation[] {
  return created.filter((a) => a.keyframes.some((k: any) => k.transform !== undefined));
}

function hasFocusLayer(host: ShimElement): boolean {
  return host.querySelectorAll('.focus-anim-layer').length > 0;
}

before(async () => {
  installGlobals();
  installEtn();
  canvas = await import('../src/renderer/canvas/canvas.js');
});

beforeEach(() => {
  installEtn();
  created = [];
  store.update({
    networkId: NETWORK_A,
    focus: null,
    canvasZoom: 1,
    cloudWidth: 180,
    cloudGap: 16,
    layerOverrides: { thought_ids: [], link_ids: [] },
  });
});

describe('canvas: смена мыслесети — мгновенная очистка и одно общее проявление (задача 70a99f09)', () => {
  it('смена сети: очистка без хореографии, одно общее проявление расклада, внутрисетевой фокус анимируется', async () => {
    const host = makeHost();
    const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
    await settle();

    // Расклад сети A.
    store.update({ focus: focusResponse(FOCUS_A, CHILD_A, 'A') });
    await settle();
    created = [];
    assert.ok(cloudsIn(host).length >= 2, 'расклад сети A собран (фокус + потомок)');

    // --- Смена мыслесети: сначала фокус сбрасывается (как делает openNetwork). ---
    store.update({ networkId: NETWORK_B, focus: null });
    await settle();
    assert.equal(cloudsIn(host).length, 0, 'содержимое прежней сети очищено одномоментно');
    assert.equal(hasFocusLayer(host), false, 'анимационных слоёв не осталось');

    // --- Первый расклад сети B: одно общее проявление, без перелётов. ---
    created = [];
    store.update({ focus: focusResponse(FOCUS_B, CHILD_B, 'B') });
    await settle();

    assert.equal(hasFocusLayer(host), false, 'фокус-хореография при смене сети не играется');
    assert.equal(transformAnims().length, 0, 'нет transform-анимаций (перелётов и клонов)');
    const reveals = opacityReveals();
    assert.equal(reveals.length, cloudsIn(host).length, 'у каждого облачка расклада — своё проявление');
    assert.ok(reveals.length >= 2, 'проявился весь расклад, а не только фокус');
    for (const a of reveals) {
      assert.equal(a.options.delay, 0, 'все облачка проявляются одновременно');
      assert.equal(a.options.duration, 300, 'длительность — токен --anim-network-reveal');
      assert.equal(a.options.fill, 'both', 'финальный кадр удерживается');
    }

    // --- Внутрисетевая смена фокуса: двухфазная хореография сохранена. ---
    created = [];
    store.update({ focus: focusResponse(FOCUS_A, CHILD_A, 'A2') });
    await settle();
    assert.equal(hasFocusLayer(host), true, 'внутри сети смена фокуса играет фокус-хореографию');

    dispose();
  });
});
