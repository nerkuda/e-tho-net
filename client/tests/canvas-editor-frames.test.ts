/**
 * Визуальные рамки карты: гало открытой в редакторе мысли и пунктир текущего
 * (ADR e6d48e09, задача e80da89f п.2).
 *
 * Проверяем оба дефекта живой приёмки волны 5 на РЕАЛЬНОМ `mountCanvas`:
 *  (а) клик по свободному месту (editorTarget=null → редактор следует за
 *      фокусом) обязан показать сплошную рамку на ФОКУСНОЙ мысли;
 *  (б) Enter на фокусной мысли обязан погасить пунктир (текущая = открытая).
 *
 * Без фикса openedId вычислялся только из `editorTarget`: при `null` гало не
 * появлялось, а пунктир фокуса не гаснул. Входит в обычный прогон тестов.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import type { FocusResponse, Thought } from '@etn/shared';

import { store } from '../src/renderer/state.js';
import { ShimElement } from './dom-shim.js';

type CanvasModule = typeof import('../src/renderer/canvas/canvas.js');
type KbdNavModule = typeof import('../src/renderer/canvas/kbd-nav.js');

let canvas: CanvasModule;
let kbdNav: KbdNavModule;

const NETWORK_ID = '00000000-0000-4000-8000-000000000001';
const FOCUS_ID = '00000000-0000-4000-8000-000000000100';
const PARENT_ID = '00000000-0000-4000-8000-000000000200';

let currentHost: ShimElement | null = null;

function thought(id: string, title: string): Thought {
  return {
    id,
    title,
    type_id: null,
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function focusResponse(): FocusResponse {
  return {
    focused: thought(FOCUS_ID, 'Фокус'),
    parents: [
      {
        id: PARENT_ID,
        title: 'Родитель',
        type_id: null,
        icon: null,
        active: true,
        link_id: 'l1',
        link_type_id: null,
        link_active: true,
        link_marked_for_deletion: false,
        has_incoming: false,
        has_outgoing: false,
        manual_position: null,
      },
    ],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

function installEtn(): void {
  const api = {
    ui: { getState: async () => null, setState: async () => undefined },
    thoughts: { focus: async () => focusResponse(), get: async () => ({ meta: { views: [] } }), resolve: async () => [] },
    thoughtTypeViews: { list: async () => ({ data: [], meta: { effective: [] } }) },
    comments: { list: async () => [] },
    attachments: { list: async () => [] },
    propertyRegistry: { list: async () => [] },
    structures: { edges: async () => [] },
  };
  (globalThis as any).etn = api;
  const w = (globalThis as any).window as { etn?: unknown } | undefined;
  if (w !== undefined) w.etn = api;
}

function installGlobals(): void {
  Object.defineProperty(ShimElement.prototype, 'offsetHeight', { get: () => 20, configurable: true });
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
    activeElement: null,
  };
  const raf = (cb: (t: number) => void): ReturnType<typeof setTimeout> => setTimeout(() => cb(Date.now()), 0);
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

async function settle(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function sizeDom(el: ShimElement): void {
  const sized = el as unknown as { clientWidth: number; clientHeight: number; scrollHeight: number };
  sized.clientWidth = 800;
  sized.clientHeight = 600;
  sized.scrollHeight = 2000;
  for (const child of el.children) sizeDom(child);
}

/** Id облачков с классом гало. */
function haloIds(): string[] {
  if (currentHost === null) return [];
  return currentHost
    .querySelectorAll('.halo')
    .map((el) => el.dataset['id'] ?? '')
    .filter((id) => id !== '');
}

function cursorIds(): string[] {
  if (currentHost === null) return [];
  return currentHost
    .querySelectorAll('.kbd-cursor')
    .map((el) => el.dataset['id'] ?? '')
    .filter((id) => id !== '');
}

async function mount(): Promise<() => void> {
  const host = new ShimElement('section', 'canvas-host');
  currentHost = host;
  const dispose = canvas.mountCanvas(host as unknown as HTMLElement);
  sizeDom(host);
  store.update({ networkId: NETWORK_ID, focus: focusResponse(), editorTarget: null, activeView: 'map' });
  await settle();
  return dispose;
}

before(async () => {
  installGlobals();
  installEtn();
  canvas = await import('../src/renderer/canvas/canvas.js');
  kbdNav = await import('../src/renderer/canvas/kbd-nav.js');
});

beforeEach(async () => {
  installEtn();
  store.update({ networkId: NETWORK_ID, focus: null, editorTarget: null, selectedLinkId: null, canvasZoom: 1, cloudWidth: 180 });
});

describe('карта: гало открытой в редакторе мысли — единое определение (e80da89f п.2а)', () => {
  it('editorTarget=null (клик по свободному месту) — гало на ФОКУСНОЙ мысли', async () => {
    const dispose = await mount();
    assert.deepEqual(haloIds(), [FOCUS_ID], 'редактор следует за фокусом — гало на фокусе');
    // Клик по облачку родителя: редактор показывает его — гало переезжает.
    store.update({ editorTarget: { kind: 'thought', id: PARENT_ID } });
    assert.deepEqual(haloIds(), [PARENT_ID], 'гало на мысли, открытой кликом по облачку');
    // Клик по свободному месту: editorTarget=null → снова фокус.
    store.update({ editorTarget: null, selectedLinkId: null });
    assert.deepEqual(haloIds(), [FOCUS_ID], 'клик по свободному месту возвращает гало на фокус');
    // Открытая СВЯЗЬ — «текущей мысли» нет, гало гаснет.
    store.update({ editorTarget: { kind: 'link', id: 'l1', link: {} as never } });
    assert.deepEqual(haloIds(), [], 'открытая связь — гало ни на одной мысли');
    dispose();
  });
});

describe('карта: Enter на фокусной мысли гасит пунктир (e80da89f п.2б)', () => {
  it('пунктир не рисуется, когда текущая = открытая (фокус), и после Enter', async () => {
    const dispose = await mount();
    // Текущая = фокусная: редактор следует за фокусом → пунктира быть не должно.
    kbdNav.setCursor(FOCUS_ID);
    assert.deepEqual(cursorIds(), [], 'пунктир фокуса подавлен (открытая = фокусная)');
    // Enter на фокусной: openThoughtInEditor выходит рано (editorTarget=null),
    // но рамки пересчитываются — пунктира по-прежнему нет.
    currentHost?.emit('keydown', { key: 'Enter', target: currentHost, preventDefault: (): void => undefined });
    assert.deepEqual(cursorIds(), [], 'после Enter на фокусе пунктира нет');
    // Книжка/родитель как текущая: пунктир есть (открытая = фокус, текущая ≠).
    kbdNav.setCursor(PARENT_ID);
    assert.deepEqual(cursorIds(), [PARENT_ID], 'текущая ≠ открытая — пунктир виден');
    // Enter на родителе открывает его → пунктир гаснет (остаётся только гало).
    currentHost?.emit('keydown', { key: 'Enter', target: currentHost, preventDefault: (): void => undefined });
    assert.deepEqual(cursorIds(), [], 'открытая = текущая — пунктир гаснет');
    assert.deepEqual(haloIds(), [PARENT_ID], 'гало на открытой мысли');
    dispose();
  });
});

/** Пустой элемент внутри зоны — цель клика «по пустому месту» карты. */
function blankZoneTarget(): ShimElement {
  const zone = currentHost?.querySelector('.zone') ?? null;
  assert.ok(zone !== null, 'карта построила зону');
  const blank = new ShimElement('div', 'zone-empty');
  zone.append(blank);
  return blank;
}

/** Клик по указанному элементу через реальный обработчик пустого места (host). */
function clickEmpty(target: ShimElement): void {
  currentHost?.emit('click', {
    target,
    preventDefault: (): void => undefined,
    stopPropagation: (): void => undefined,
  });
}

describe('карта: клик по пустому месту выбирает фокусную мысль (3af98e31 п.1)', () => {
  it('клик по пустому → текущая = фокусная, одна сплошная рамка, пунктира нет', async () => {
    const dispose = await mount();
    const blank = blankZoneTarget();
    // Расходим позиции: курсор уведён на родителя — виден пунктир, гало на фокусе.
    kbdNav.setCursor(PARENT_ID);
    assert.deepEqual(cursorIds(), [PARENT_ID], 'пунктир на родителе до клика');

    clickEmpty(blank);

    assert.equal(kbdNav.getCanvasCursor(), FOCUS_ID, 'курсор навигации встал на фокусную мысль');
    assert.deepEqual(cursorIds(), [], 'текущая = открытая (фокус) — пунктир погашен');
    assert.deepEqual(haloIds(), [FOCUS_ID], 'одна сплошная рамка на фокусной мысли');
    dispose();
  });

  it('клик по пустому с мыслью, открытой не в фокусе, возвращает на фокус', async () => {
    const dispose = await mount();
    const blank = blankZoneTarget();
    // Открыт родитель: гало на нём, курсор тоже на нём (клик по облачку).
    store.update({ editorTarget: { kind: 'thought', id: PARENT_ID } });
    kbdNav.setCursor(PARENT_ID);
    assert.deepEqual(haloIds(), [PARENT_ID], 'гало на открытом родителе');
    assert.deepEqual(cursorIds(), [], 'текущая = открытая — пунктира нет');

    clickEmpty(blank);

    assert.equal(store.state.editorTarget, null, 'редактор возвращён к фокусу');
    assert.equal(kbdNav.getCanvasCursor(), FOCUS_ID, 'курсор на фокусной мысли');
    assert.deepEqual(haloIds(), [FOCUS_ID], 'гало вернулось на фокус');
    assert.deepEqual(cursorIds(), [], 'рамка одна сплошная');
    dispose();
  });

  it('клик по пустой полосе фокуса (target = хост, pointer-events:none) выбирает фокус', async () => {
    const dispose = await mount();
    // `.canvas-focus-row` имеет pointer-events:none — клик по её пустой части
    // приходит на ХОСТ `.canvas` (target === host), а не на потомка. Это был
    // блокер верификации: обработчик не узнавал хост и не возвращал редактор.
    store.update({ editorTarget: { kind: 'thought', id: PARENT_ID } });
    kbdNav.setCursor(PARENT_ID);
    assert.deepEqual(haloIds(), [PARENT_ID], 'гало на открытом родителе');

    currentHost?.emit('click', {
      target: currentHost,
      preventDefault: (): void => undefined,
      stopPropagation: (): void => undefined,
    });

    assert.equal(store.state.editorTarget, null, 'полоса фокуса: редактор вернулся к фокусу');
    assert.equal(kbdNav.getCanvasCursor(), FOCUS_ID, 'курсор на фокусной мысли');
    assert.deepEqual(haloIds(), [FOCUS_ID], 'гало на фокусе — одна рамка');
    assert.deepEqual(cursorIds(), [], 'пунктира нет');
    dispose();
  });

  it('клик по оснастке холста (ползунок зон) курсор и редактор не трогает', async () => {
    const dispose = await mount();
    const splitter = currentHost?.querySelector('.zone-splitter') ?? null;
    assert.ok(splitter !== null, 'карта построила ползунок зон');
    store.update({ editorTarget: { kind: 'thought', id: PARENT_ID } });
    kbdNav.setCursor(PARENT_ID);
    clickEmpty(splitter);
    assert.equal(kbdNav.getCanvasCursor(), PARENT_ID, 'ползунок зон — не выбор мысли');
    assert.deepEqual(cursorIds(), [], 'текущая = открытая родитель — пунктира нет');
    assert.deepEqual(haloIds(), [PARENT_ID], 'редактор на родителе не тронут');
    dispose();
  });
});
